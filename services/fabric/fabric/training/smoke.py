"""The LoRA smoke run: one real pass through every stage, reported stage by stage.

The point of this module is honesty about what ran. Each stage has its own status:

* ``PASSED``   the stage ran and its check succeeded.
* ``FAILED``   the stage ran and its check failed, or it raised. The error is kept.
* ``NOT RUN``  the stage was not executed. Its prerequisite was missing (for example no
               usable compute device), or an earlier stage failed. Nothing here is treated
               as a pass.

The overall verdict is ``PASSED`` only when every core stage passed. ``persistence``
is separate: it passes only when the adapter was read back from an attached output of
an earlier committed run. Until then it stays ``NOT RUN``, and nothing may say the
output persisted.

The module has no torch import. The framework work lives behind a ``backend`` object
(see ``hf_peft.HFPeftBackend``), so the orchestration and the ledger are tested here
with a fake backend.
"""

from __future__ import annotations

import copy
import json
import math
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from fabric.training import synthetic
from fabric.training.checkpoint import CheckpointStore, import_latest
from fabric.training.jobspec import config_digest, validate_job
from fabric.training.runner import ARTIFACT_DIR, run_job

PASSED = "PASSED"
FAILED = "FAILED"
NOT_RUN = "NOT RUN"

STAGES = ("environment", "model_verification", "dataset", "training", "reload",
          "inference", "quality", "persistence")
CORE_STAGES = ("environment", "model_verification", "dataset", "training", "reload", "inference", "quality")

#: Fixed prompt for the inference check. It is a question the training split teaches,
#: so a changed answer shows the adapter is actually applied.
FIXED_PROMPT = "What is 17 plus 25?"

PLATFORMS = ("kaggle", "colab", "local")

COLAB_DIR = "/content/aetheris-smoke"


@dataclass
class Ledger:
    platform: str
    stages: dict = field(default_factory=dict)
    notes: list = field(default_factory=list)
    refused: list = field(default_factory=list)
    context: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        for name in STAGES:
            self.stages[name] = {"status": NOT_RUN, "detail": {}}

    def set(self, name: str, status: str, /, **detail: Any) -> None:
        if name not in self.stages or status not in (PASSED, FAILED, NOT_RUN):
            raise ValueError(f"bad ledger entry {name!r} {status!r}")
        self.stages[name] = {"status": status, "detail": detail}

    def note(self, text: str) -> None:
        self.notes.append(text)

    @property
    def verdict(self) -> str:
        """REFUSED: the job broke a rule. FAILED: a technical stage failed. NOT ACCEPTED: every
        stage ran, but the acceptance gate refused the adapter. PASSED: every core stage passed.
        INCOMPLETE: some stage was not run, for example because there is no usable device."""
        if self.refused:
            return "REFUSED"
        technical = [name for name in STAGES if name != "quality"]
        if any(self.stages[name]["status"] == FAILED for name in technical):
            return "FAILED"
        if self.stages["quality"]["status"] == FAILED:
            return "NOT ACCEPTED"
        if all(self.stages[name]["status"] == PASSED for name in CORE_STAGES):
            return "PASSED"
        return "INCOMPLETE"

    def to_dict(self) -> dict:
        return {
            "verdict": self.verdict,
            "platform": self.platform,
            "stages": self.stages,
            "notes": list(self.notes),
            "refused": list(self.refused),
            "context": dict(self.context),
            "persistence": {
                "verified": self.stages["persistence"]["status"] == PASSED,
                "statement": "Read back from a separately supplied adapter directory."
                if self.stages["persistence"]["status"] == PASSED and self.platform == "local"
                else "Read back from an attached output of an earlier committed run."
                if self.stages["persistence"]["status"] == PASSED
                else "NOT VERIFIED. Pass an earlier adapter with --persistence-adapter to verify a local read-back."
                if self.platform == "local"
                else "NOT VERIFIED. Kaggle /kaggle/working is kept only as the output of a committed "
                     "version; a later run must read it back through /kaggle/input to verify it.",
            },
            "claims": {
                "quality": "No quality claim. A PASSED quality stage means the job's gate was met on "
                           "synthetic validation data only.",
            },
        }


def apply_platform(job: Mapping, platform: str, ledger: Ledger) -> dict:
    """Return the job with storage moved to where ``platform`` can actually keep files.

    Kaggle keeps ``/kaggle/working`` as notebook output, so the job's own paths are used
    as written. Colab has only its session disk unless Drive is mounted, so checkpoints
    and logs move to it and are marked ephemeral. The local runner supplies ``local_disk``
    paths rooted in its work directory, so no rewrite is needed here. Every change is
    recorded in the ledger.
    """
    if platform not in PLATFORMS:
        raise ValueError(f"platform must be one of {PLATFORMS}")
    out = copy.deepcopy(dict(job))
    if platform == "colab":
        for section, name in (("checkpoint", "checkpoints"), ("logs", "logs")):
            out[section]["storageKind"] = "colab_session"
            out[section]["path"] = f"{COLAB_DIR}/{name}"
            out[section]["ephemeralAcknowledged"] = True
        out["checkpoint"].pop("resumeFrom", None)
        ledger.note("Colab: checkpoints and logs are on the session disk and are lost when the runtime ends.")
    return out


def _dataset_pin_problems(job: Mapping, manifest: Mapping) -> list[str]:
    problems = []
    files = manifest.get("files", {})
    for split, section in (("train", job["dataset"]["train"]), ("validation", job["dataset"]["validation"])):
        got = files.get(split, {})
        if got.get("sha256") != section.get("sha256") or got.get("examples") != section.get("examples"):
            problems.append(f"dataset {split}: generated sha256/examples do not match the job pins")
    for item in job["dataset"].get("regression", []):
        split = next((s for s, f in synthetic.FILES.items() if f == item.get("file")), None)
        got = files.get(split, {}) if split else {}
        if got.get("sha256") != item.get("sha256") or got.get("examples") != item.get("examples"):
            problems.append(f"dataset regression {item.get('name')!r}: generated sha256/examples do not "
                            "match the job pins")
    return problems


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def run_smoke(job: Mapping, backend: Any, *, out_dir: str | Path, platform: str,
              persistence_adapter: str | Path | None = None, context: Mapping | None = None) -> Ledger:
    """Run every stage in order and write ``status.json`` under ``out_dir``.

    A failing stage does not hide the others: stages that do not depend on it still run,
    and stages that do are ``NOT RUN``. An exception inside a stage is recorded as
    ``FAILED`` with its type, message and trace.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    ledger = Ledger(platform=platform, context=dict(context or {}))
    try:
        job = apply_platform(job, platform, ledger)
        problems = validate_job(job)
        if problems:
            ledger.refused = problems
            return ledger

        # ---- environment ------------------------------------------------------
        gpu = None
        device = None
        try:
            env = backend.environment()
            env_problems = list(env.get("problems", []))
            gpu = env.get("gpu")
            # Older/fake backends only reported ``gpu``. Keep accepting that shape while
            # letting the real backend name a CPU explicitly for the local runner.
            device = env.get("device") or ("cuda" if gpu else None)
            ledger.set("environment", FAILED if env_problems else PASSED, **env)
        except Exception as error:  # noqa: BLE001 - recorded, not hidden
            ledger.set("environment", FAILED, error=_error(error))
            env_problems = ["environment check raised"]
        compute_available = bool(gpu) or (platform == "local" and device == "cpu")
        if not compute_available:
            ledger.note("No usable compute device is available here: training, reload, inference, quality "
                        "and persistence are NOT RUN. Model verification and dataset generation still run.")

        # ---- model verification (hub and licence; no GPU needed) ---------------
        try:
            verified = backend.verify_model(job)
            mv_problems = list(verified.get("problems", []))
            ledger.set("model_verification", FAILED if mv_problems else PASSED, **verified)
        except Exception as error:  # noqa: BLE001
            ledger.set("model_verification", FAILED, error=_error(error))

        # ---- dataset ----------------------------------------------------------
        dataset_dir = out / "dataset"
        try:
            manifest = synthetic.write_dataset(dataset_dir)
            pin_problems = _dataset_pin_problems(job, manifest)
            ledger.set("dataset", FAILED if pin_problems else PASSED,
                       digest=manifest["digest"], problems=pin_problems,
                       files={k: v["sha256"] for k, v in manifest["files"].items()})
        except Exception as error:  # noqa: BLE001
            ledger.set("dataset", FAILED, error=_error(error))

        # Nothing that spends compute runs on an unverified base or on data that does not match its pins.
        if not compute_available or ledger.stages["environment"]["status"] != PASSED \
                or ledger.stages["model_verification"]["status"] != PASSED \
                or ledger.stages["dataset"]["status"] != PASSED:
            return ledger

        # ---- training: baseline, LoRA steps, checkpoints, artifact, judgement --
        try:
            base_text = backend.infer(FIXED_PROMPT, adapter_dir=None)
            ledger.stages["inference"]["detail"]["base_output"] = base_text
        except Exception as error:  # noqa: BLE001
            ledger.set("inference", FAILED, error=_error(error))
            base_text = None

        checkpoint_root = Path(job["checkpoint"]["path"])
        store = CheckpointStore(checkpoint_root)
        cdig = config_digest(job)
        trainer = None
        try:
            imported = None
            for source in job["checkpoint"].get("resumeFrom", []):
                imported = import_latest(CheckpointStore(source), store, cdig) or imported
            trainer = backend.trainer(job, dataset_dir)
            record = run_job(job, trainer, checkpoints=store, out_dir=out / "run")
        except Exception as error:  # noqa: BLE001
            ledger.set("training", FAILED, error=_error(error))
            return ledger
        finally:
            # The CPU route is deliberately viable on an 8 GB Codespace. Do not retain
            # the training model while reload constructs a fresh base model to prove the
            # adapter works. Framework backends may expose ``close``; fixture backends do
            # not need to.
            close = getattr(trainer, "close", None)
            if close is not None:
                close()

        if record.status != "completed":
            ledger.set("training", FAILED, status=record.status, error=record.error)
            return ledger
        results = record.results
        artifact = record.artifacts["adapter"]
        ledger.set("training", PASSED, steps=results["stepsTrained"], first_loss=results["lossFirst"],
                   last_loss=results["lossLast"], artifact_digest=artifact["digest"],
                   artifact_files=artifact.get("files", []),
                   checkpoint_root=str(checkpoint_root), imported_from=str(imported.path) if imported else None)

        decision = results["decision"]
        ledger.set("quality", PASSED if decision["eligible"] else FAILED,
                   baseline=results["baseline"], final=results["final"],
                   regression_before=results["regressionBaseline"], regression_after=results["regressionFinal"],
                   decision=decision)

        adapter_dir = out / "run" / ARTIFACT_DIR
        try:
            reloaded = backend.reload(adapter_dir, FIXED_PROMPT)
            reload_problems = list(reloaded.get("problems", []))
            if not reloaded.get("finite", False):
                reload_problems.append("reloaded model produced non-finite logits")
            ledger.set("reload", FAILED if reload_problems else PASSED, problems=reload_problems,
                       **{k: v for k, v in reloaded.items() if k != "problems"})
            tuned = reloaded.get("text")
        except Exception as error:  # noqa: BLE001
            ledger.set("reload", FAILED, error=_error(error))
            tuned = None

        if ledger.stages["reload"]["status"] == PASSED and base_text is not None:
            changed = tuned != base_text
            ledger.set("inference", PASSED if changed else FAILED, base_output=base_text, tuned_output=tuned,
                       note="Output differs from the untrained base on the fixed prompt. This shows the "
                            "adapter is applied. It is not a quality measure."
                       if changed else "Output identical to the untrained base; the adapter may not be applied.")
        elif ledger.stages["inference"]["status"] != FAILED:
            ledger.set("inference", NOT_RUN, base_output=base_text)

        if persistence_adapter is not None and ledger.stages["reload"]["status"] == PASSED:
            try:
                again = backend.reload(Path(persistence_adapter), FIXED_PROMPT)
                again_problems = list(again.get("problems", []))
                if not again.get("finite", False):
                    again_problems.append("reloaded model produced non-finite logits")
                ledger.set("persistence", FAILED if again_problems else PASSED,
                           adapter_dir=str(persistence_adapter), problems=again_problems,
                           output=again.get("text"))
            except Exception as error:  # noqa: BLE001
                ledger.set("persistence", FAILED, error=_error(error))
        return ledger
    finally:
        _write_status(out, ledger)


def _error(error: BaseException) -> dict:
    return {"type": type(error).__name__, "message": str(error)[:500],
            "trace": traceback.format_exc()[-1500:]}


def _write_status(out: Path, ledger: Ledger) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / "status.json").write_text(json.dumps(ledger.to_dict(), indent=2, sort_keys=True, default=str) + "\n",
                                     encoding="utf-8")
