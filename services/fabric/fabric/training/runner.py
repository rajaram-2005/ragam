"""Run a job: validate, measure the baseline, train with checkpoints, judge, record.

The loop is framework-agnostic. A trainer supplies five methods (see ``Trainer``),
and this module supplies everything that must not vary between a laptop fixture and
a rented GPU: the order of operations, the checkpoint cadence, the baseline
measurement, the acceptance decision, the artifact hashing and the run record.

Status words are chosen so that none of them can be read as more than it is:

* ``refused``     the job failed validation or belongs to another run. Nothing trained.
* ``interrupted`` the run stopped before finishing. It can be resumed.
* ``failed``      an exception, recorded with its type, message and trace tail.
* ``completed``   the trained artifact exists on disk, its checksum was re-computed
                  from the file, and the evaluation ran. This does **not** mean the
                  model is good. ``results.decision.eligible`` says that, and only a
                  candidate that is eligible may be considered for release.
"""

from __future__ import annotations

import hashlib
import json
import math
import traceback
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Mapping, Protocol

from fabric.run import RunRecord, file_digest
from fabric.training.checkpoint import CheckpointStore, ResumeMismatch
from fabric.training.jobspec import MIN_VALIDATION_EXAMPLES, canonical, config_digest, job_digest, validate_job

RECORD_KIND = "remote-lora-training"
ARTIFACT_DIR = "artifact"
RECORD_FILE = "run-record.json"
LOSS_FILE = "losses.json"


class Trainer(Protocol):
    """What a framework must provide to be run by ``run_job``.

    ``train_step`` must derive its batch from ``step`` alone, not from a random
    generator that carries state between calls. That is what makes a resumed run
    follow the same path as an uninterrupted one.
    """

    def evaluate(self, split: str) -> dict:
        """Return at least ``{"loss": float, "examples": int}`` for ``split``."""

    def train_step(self, step: int) -> float:
        """Run one optimisation step and return its training loss."""

    def state_files(self) -> dict:
        """Everything needed to continue: weights and optimizer state, as bytes."""

    def load_state_files(self, files: Mapping) -> None:
        """Restore what ``state_files`` returned."""

    def export_artifact(self, directory: Path) -> list:
        """Write the trained artifact into ``directory``; return the file names written."""


class Interrupted(RuntimeError):
    """Raised on request (``stop_after``) to simulate a session that ended."""


@dataclass(frozen=True)
class Decision:
    loss_gain: float | None
    improved: bool
    regressions_ok: bool
    eligible: bool
    reasons: tuple

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["reasons"] = list(self.reasons)
        return payload


def decide(job: Mapping, baseline: Mapping, final: Mapping,
           regression_before: Mapping, regression_after: Mapping) -> Decision:
    """Apply the job's acceptance criteria. Pure, so it can be tested directly.

    The baseline is the untrained base measured on the same validation split before
    any step ran. A gain is only counted against that measurement, never against a
    number recalled from elsewhere.
    """
    validation = job["validation"]
    reasons: list[str] = []

    base_loss = baseline.get("loss")
    final_loss = final.get("loss")
    finite = all(isinstance(x, (int, float)) and math.isfinite(x) for x in (base_loss, final_loss))
    gain: float | None = None
    improved = False
    if not finite:
        reasons.append("a validation loss is not a finite number")
    else:
        gain = base_loss - final_loss
        improved = gain >= validation["minImprovement"]
        if not improved:
            reasons.append(
                f"validation loss fell by {gain:.4f} nats; the job requires {validation['minImprovement']}"
            )
    base_accuracy = baseline.get("accuracy")
    final_accuracy = final.get("accuracy")
    if isinstance(base_accuracy, (int, float)) and isinstance(final_accuracy, (int, float)):
        accuracy_gain = final_accuracy - base_accuracy
        if accuracy_gain < validation["minAccuracyGain"]:
            improved = False
            reasons.append(
                f"validation accuracy changed by {accuracy_gain:+.4f}; the job requires at least "
                f"{validation['minAccuracyGain']:+.4f}. A loss gain alone is not accepted"
            )
    else:
        improved = False
        reasons.append("validation accuracy is missing")
    examples = final.get("examples", 0)
    if not isinstance(examples, int) or examples < MIN_VALIDATION_EXAMPLES:
        improved = False
        reasons.append(f"validation has {examples} examples; at least {MIN_VALIDATION_EXAMPLES} are required")

    tolerance = validation["regressionTolerance"]
    regressions_ok = True
    for name in validation["regressionSets"]:
        before = regression_before.get(name, {}).get("loss")
        after = regression_after.get(name, {}).get("loss")
        if not (isinstance(before, (int, float)) and isinstance(after, (int, float))
                and math.isfinite(before) and math.isfinite(after)):
            regressions_ok = False
            reasons.append(f"regression set {name!r} has no finite measurement")
            continue
        if after - before > tolerance:
            regressions_ok = False
            reasons.append(
                f"regression set {name!r} worsened by {after - before:.4f} nats; tolerance is {tolerance}"
            )

    eligible = improved and regressions_ok
    return Decision(
        loss_gain=None if gain is None else round(gain, 6),
        improved=improved,
        regressions_ok=regressions_ok,
        eligible=eligible,
        reasons=tuple(reasons),
    )


def artifact_summary(directory: Path, names) -> dict:
    """Hash each named file from disk, and a digest over the whole set."""
    files = {}
    for name in sorted(names):
        if "/" in name or "\\" in name or name in (".", ".."):
            raise RuntimeError(f"trainer reported an illegal artifact name {name!r}")
        path = Path(directory) / name
        if not path.is_file():
            raise RuntimeError(f"trainer reported {name!r} but it is not on disk")
        files[name] = {"sha256": file_digest(path), "bytes": path.stat().st_size}
    if not files:
        raise RuntimeError("trainer exported no artifact files")
    digest = hashlib.sha256(canonical(files)).hexdigest()
    return {"files": files, "digest": digest}


def _limitations(job: Mapping) -> list:
    base = job["base"]
    notes = [
        "The result is a candidate at most. A run never changes the stable release by itself.",
    ]
    if base["kind"] == "third_party_finetune":
        notes.append(
            f"Fine-tuned third-party base {base['id']}@{base['revision'][:12]} "
            f"({base['licence']}). This is not an independently pretrained Klyvaron model."
        )
    else:
        notes.append("Fixture run on synthetic data. Not a Klyvaron model and not a release candidate.")
    return notes


def run_job(
    job: Mapping,
    trainer: Trainer,
    *,
    checkpoints: CheckpointStore,
    out_dir: str | Path,
    stop_after: int | None = None,
    run_id: str | None = None,
) -> RunRecord:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    record = RunRecord.start(RECORD_KIND, run_id=run_id)

    problems = validate_job(job)
    if problems:
        record.add_stage("validation", "refused", detail={"problems": problems})
        record.finish("refused", error="; ".join(problems))
        record.save(out / RECORD_FILE)
        return record

    cdig = config_digest(job)
    record.add_stage("validation", "passed")
    record.config = {
        "jobDigest": job_digest(job),
        "configDigest": cdig,
        "training": dict(job["training"]),
        "resources": dict(job["resources"]),
        "checkpoint": {"everySteps": job["checkpoint"]["everySteps"],
                       "keepLast": job["checkpoint"]["keepLast"],
                       "storageKind": job["checkpoint"]["storageKind"]},
    }
    record.dataset = {"id": job["dataset"]["id"], "version": job["dataset"]["version"],
                      "provenance": job["dataset"]["provenance"], "licence": job["dataset"]["licence"],
                      "train": dict(job["dataset"]["train"]), "validation": dict(job["dataset"]["validation"]),
                      "regression": [dict(item) for item in job["dataset"].get("regression", [])]}
    record.base_checkpoint = f"{job['base']['id']}@{job['base']['revision']}"
    record.seeds = {"training": job["training"]["seed"]}

    sets = list(job["validation"]["regressionSets"])
    steps = job["training"]["steps"]
    every = job["checkpoint"]["everySteps"]
    keep = job["checkpoint"]["keepLast"]

    try:
        resume = checkpoints.load_latest(cdig)
        if resume is not None:
            trainer.load_state_files(resume.files)
            start = resume.step
            baseline = resume.meta["baseline"]
            regression_before = resume.meta["regressionBefore"]
            losses = list(resume.meta["losses"])
            record.add_stage("resume", "resumed", detail={
                "fromStep": start,
                "checkpoint": resume.path.name,
                "skippedNewer": list(resume.skipped),
            })
        else:
            baseline = trainer.evaluate("validation")
            regression_before = {name: trainer.evaluate(name) for name in sets}
            start = 0
            losses = []
            record.add_stage("baseline", "measured", detail={"validation": baseline,
                                                              "regression": regression_before})

        for step in range(start, steps):
            loss = float(trainer.train_step(step))
            if not math.isfinite(loss):
                raise FloatingPointError(f"training loss became {loss} at step {step}")
            losses.append({"step": step, "loss": loss})
            done = step + 1
            if stop_after is not None and done >= stop_after:
                raise Interrupted(f"stopped before checkpointing step {done} (stop_after={stop_after})")
            if done % every == 0 or done == steps:
                checkpoints.save(done, trainer.state_files(), config_digest=cdig, meta={
                    "baseline": baseline,
                    "regressionBefore": regression_before,
                    "losses": losses,
                })
                checkpoints.prune(keep)
                record.add_stage("checkpoint", "saved", detail={"step": done})

        final = trainer.evaluate("validation")
        regression_after = {name: trainer.evaluate(name) for name in sets}

        artifact_dir = out / ARTIFACT_DIR
        names = trainer.export_artifact(artifact_dir)
        artifact = artifact_summary(artifact_dir, names)
        if artifact_summary(artifact_dir, names)["digest"] != artifact["digest"]:
            raise RuntimeError("artifact changed between hashing and re-hashing")

        decision = decide(job, baseline, final, regression_before, regression_after)
        (out / LOSS_FILE).write_text(json.dumps(losses, indent=2), encoding="utf-8")

        record.results = {
            "baseline": baseline,
            "final": final,
            "regressionBaseline": regression_before,
            "regressionFinal": regression_after,
            "decision": decision.to_dict(),
            "stepsTrained": steps,
            "lossFirst": losses[0] if losses else None,
            "lossLast": losses[-1] if losses else None,
            "lossesFile": LOSS_FILE,
        }
        record.artifacts = {"adapter": {"directory": ARTIFACT_DIR, **artifact}}
        record.add_stage("evaluation", "checked", detail={"eligible": decision.eligible,
                                                           "reasons": list(decision.reasons)})
        record.finish("completed", limitations=_limitations(job))
    except Interrupted as stop:
        record.add_stage("training", "interrupted", detail={"message": str(stop)})
        record.finish("interrupted", error=str(stop), limitations=_limitations(job))
    except ResumeMismatch as mismatch:
        record.add_stage("resume", "refused", detail={"message": str(mismatch)})
        record.finish("refused", error=str(mismatch), limitations=_limitations(job))
    except Exception as error:  # noqa: BLE001 - every failure is recorded, then the run fails loudly
        trace = traceback.format_exc()[-1500:]
        record.add_stage("training", "failed", detail={"type": type(error).__name__,
                                                        "message": str(error)[:500],
                                                        "trace": trace})
        record.finish("failed", error=f"{type(error).__name__}: {error}", limitations=_limitations(job))

    record.save(out / RECORD_FILE)
    return record
