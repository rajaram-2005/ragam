"""The remote training job contract.

A job is a JSON document that says, before any GPU is rented, exactly what will be
trained, from what, on what data, where its checkpoints go, how it is judged and
how it resumes. ``validate_job`` returns every problem it finds, not only the
first, so a reviewer sees the whole gap at once.

Validation is deliberately strict and fails closed:

* A placeholder left in the file (any string starting with ``REPLACE``) is a
  problem. The example job in ``remote/jobs/`` therefore refuses to run until a
  person fills in the base revision, the reviewer and the dataset hashes.
* A base model must be pinned to a commit hash, never to a branch such as ``main``.
* A multi-session job must checkpoint, because a session can end at any time.

Nothing here knows how to train. The contract is the same whether the trainer is
the NumPy fixture in ``fabric.training.lora_fixture`` or the PEFT notebook.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any, Mapping

from fabric.training import policy

SCHEMA = "aetheris-training-job/1"

TIERS = ("experiment", "pro", "max")
METHODS = ("lora",)  # qlora is named in docs but not implemented by this pipeline yet
ACCELERATORS = ("gpu", "cpu")
BASE_KINDS = ("third_party_finetune", "fixture")

#: A validation set smaller than this cannot distinguish a real gain from noise on
#: a small number of examples, so a job that supplies one is refused.
MIN_VALIDATION_EXAMPLES = 200

_JOB_ID = re.compile(r"^[a-z0-9][a-z0-9-]{2,62}$")
_SHA40 = re.compile(r"^[0-9a-f]{40}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_VERSION = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$")


class JobSpecError(ValueError):
    """Raised when a job is loaded but fails validation."""

    def __init__(self, problems: list[str]):
        self.problems = list(problems)
        super().__init__("; ".join(self.problems))


def is_placeholder(value: object) -> bool:
    """True for any string still carrying a ``REPLACE_`` marker, wherever it sits."""
    return isinstance(value, str) and "REPLACE_" in value


def _section(job: Mapping, name: str, problems: list[str]) -> dict:
    value = job.get(name)
    if not isinstance(value, dict):
        problems.append(f"{name}: section is missing or not an object")
        return {}
    return value


def _number(value: object, where: str, problems: list[str], *, low=None, high=None,
            integer=False, exclusive_low=False) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        problems.append(f"{where}: must be a number")
        return
    if integer and not isinstance(value, int):
        problems.append(f"{where}: must be an integer")
        return
    if not math.isfinite(value):
        problems.append(f"{where}: must be finite")
        return
    if low is not None and (value <= low if exclusive_low else value < low):
        problems.append(f"{where}: {value} is below {low}")
    if high is not None and value > high:
        problems.append(f"{where}: {value} is above {high}")


def _text(value: object, where: str, problems: list[str]) -> None:
    if not isinstance(value, str) or not value.strip():
        problems.append(f"{where}: must be a non-empty string")
    elif is_placeholder(value):
        problems.append(f"{where}: placeholder {value.strip()[:40]!r} was never replaced")


def validate_job(job: object) -> list[str]:
    """Return every problem with ``job``. An empty list means it may be run."""
    if not isinstance(job, dict):
        return ["job: must be a JSON object"]
    problems: list[str] = []

    if job.get("schema") != SCHEMA:
        problems.append(f"schema: must be {SCHEMA!r}, found {job.get('schema')!r}")

    job_id = job.get("jobId")
    if not isinstance(job_id, str) or not _JOB_ID.match(job_id):
        problems.append("jobId: use 3-63 lowercase letters, digits and hyphens")
    if job.get("tier") not in TIERS:
        problems.append(f"tier: must be one of {list(TIERS)}")
    _text(job.get("purpose"), "purpose", problems)

    # --- base model ------------------------------------------------------
    base = _section(job, "base", problems)
    _text(base.get("id"), "base.id", problems)
    kind = base.get("kind")
    if kind not in BASE_KINDS:
        problems.append(f"base.kind: must be one of {list(BASE_KINDS)}")
    revision = base.get("revision")
    if kind == "fixture":
        if revision != "fixture":
            problems.append("base.revision: a fixture base must say 'fixture'")
    else:
        if is_placeholder(revision):
            problems.append("base.revision: placeholder was never replaced; pin a commit hash")
        elif not isinstance(revision, str) or not _SHA40.match(revision):
            problems.append("base.revision: must be a 40-character commit hash, not a branch or tag")
    problems += policy.licence_problems(base.get("licence"), "base.licence")
    if kind == "third_party_finetune":
        _text(base.get("licenceCheckedUrl"), "base.licenceCheckedUrl", problems)
        _text(base.get("licenceCheckedBy"), "base.licenceCheckedBy", problems)
        _text(base.get("attributionNotice"), "base.attributionNotice", problems)

    # --- dataset ---------------------------------------------------------
    dataset = _section(job, "dataset", problems)
    _text(dataset.get("id"), "dataset.id", problems)
    _text(dataset.get("version"), "dataset.version", problems)
    provenance = dataset.get("provenance")
    if provenance not in policy.PROVENANCE_ALLOWED:
        problems.append(f"dataset.provenance: must be one of {sorted(policy.PROVENANCE_ALLOWED)}")
    problems += policy.licence_problems(dataset.get("licence"), "dataset.licence")
    _text(dataset.get("contentsDescription"), "dataset.contentsDescription", problems)
    if dataset.get("containsPersonalData") is not False:
        problems.append("dataset.containsPersonalData: must be false; personal data is not sent to remote services")
    if provenance in policy.PROVENANCE_NEEDS_AUTHORIZATION:
        problems += policy.authorization_problems(dataset, "dataset")
    if provenance == "consented_experience":
        _text(dataset.get("consentBasis"), "dataset.consentBasis", problems)
        if dataset.get("privacyReviewPassed") is not True:
            problems.append("dataset.privacyReviewPassed: experience data needs a passed privacy review")
        if dataset.get("qualityReviewPassed") is not True:
            problems.append("dataset.qualityReviewPassed: experience data needs a passed quality review")

    examples_needed = {"train": 1, "validation": MIN_VALIDATION_EXAMPLES}
    for split, minimum in examples_needed.items():
        part = dataset.get(split)
        where = f"dataset.{split}"
        if not isinstance(part, dict):
            problems.append(f"{where}: section is missing")
            continue
        _text(part.get("file"), f"{where}.file", problems)
        sha = part.get("sha256")
        if is_placeholder(sha):
            problems.append(f"{where}.sha256: placeholder was never replaced")
        elif not isinstance(sha, str) or not _SHA256.match(sha):
            problems.append(f"{where}.sha256: must be a 64-character SHA-256")
        _number(part.get("examples"), f"{where}.examples", problems, integer=True)
        if isinstance(part.get("examples"), int) and part["examples"] < minimum:
            problems.append(f"{where}.examples: {part['examples']} is below the minimum of {minimum}")

    regression = dataset.get("regression", [])
    regression_names: set[str] = set()
    if not isinstance(regression, list):
        problems.append("dataset.regression: must be a list")
        regression = []
    for index, item in enumerate(regression):
        where = f"dataset.regression[{index}]"
        if not isinstance(item, dict):
            problems.append(f"{where}: must be an object")
            continue
        _text(item.get("name"), f"{where}.name", problems)
        _text(item.get("file"), f"{where}.file", problems)
        if not isinstance(item.get("sha256"), str) or not _SHA256.match(item.get("sha256", "")):
            problems.append(f"{where}.sha256: must be a 64-character SHA-256")
        regression_names.add(item.get("name"))

    # --- training --------------------------------------------------------
    training = _section(job, "training", problems)
    if training.get("method") not in METHODS:
        problems.append(f"training.method: must be one of {list(METHODS)}; qlora is not implemented yet")
    _number(training.get("rank"), "training.rank", problems, low=1, high=256, integer=True)
    _number(training.get("alpha"), "training.alpha", problems, low=0, exclusive_low=True)
    _number(training.get("dropout"), "training.dropout", problems, low=0, high=0.5)
    modules = training.get("targetModules")
    if not isinstance(modules, list) or not modules or not all(isinstance(m, str) and m for m in modules):
        problems.append("training.targetModules: must be a non-empty list of module names")
    _number(training.get("learningRate"), "training.learningRate", problems, low=0, high=1, exclusive_low=True)
    _number(training.get("steps"), "training.steps", problems, low=1, high=1_000_000, integer=True)
    _number(training.get("batchSize"), "training.batchSize", problems, low=1, high=4096, integer=True)
    _number(training.get("seqLen"), "training.seqLen", problems, low=1, high=32768, integer=True)
    _number(training.get("seed"), "training.seed", problems, low=0, high=2**32 - 1, integer=True)

    # --- resources and checkpoints --------------------------------------
    resources = _section(job, "resources", problems)
    accelerator = resources.get("accelerator")
    if accelerator not in ACCELERATORS:
        problems.append(f"resources.accelerator: must be one of {list(ACCELERATORS)}")
    if accelerator == "gpu":
        _number(resources.get("minGpuMemoryGb"), "resources.minGpuMemoryGb", problems, low=0, exclusive_low=True)
    _number(resources.get("expectedHours"), "resources.expectedHours", problems, low=0, exclusive_low=True)
    _number(resources.get("maxSessionHours"), "resources.maxSessionHours", problems, low=0, exclusive_low=True)
    _number(resources.get("storageGb"), "resources.storageGb", problems, low=0, exclusive_low=True)

    checkpoint = _section(job, "checkpoint", problems)
    _number(checkpoint.get("everySteps"), "checkpoint.everySteps", problems, low=1, integer=True)
    _number(checkpoint.get("keepLast"), "checkpoint.keepLast", problems, low=1, integer=True)
    if isinstance(checkpoint.get("everySteps"), int) and isinstance(training.get("steps"), int):
        if checkpoint["everySteps"] > training["steps"]:
            problems.append("checkpoint.everySteps: larger than training.steps, so no checkpoint is ever written")
    problems += policy.storage_problems(checkpoint.get("storageKind"), checkpoint.get("path"), "checkpoint")

    # A session can end at any time and the free allowance is not promised, so a job
    # that needs more than one session must be able to resume.
    if isinstance(resources.get("expectedHours"), (int, float)) and isinstance(
        resources.get("maxSessionHours"), (int, float)
    ) and resources["maxSessionHours"] > 0:
        sessions = math.ceil(resources["expectedHours"] / resources["maxSessionHours"])
        if sessions > 1 and not isinstance(checkpoint.get("everySteps"), int):
            problems.append(f"checkpoint: a job needing {sessions} sessions must checkpoint to resume")

    # --- validation ------------------------------------------------------
    validation = _section(job, "validation", problems)
    _text(validation.get("baselineName"), "validation.baselineName", problems)
    _number(validation.get("minImprovement"), "validation.minImprovement", problems, low=0, exclusive_low=True)
    # Required alongside the loss criterion: a loss can fall by calibration alone, by
    # making an overconfident model less confident, without any more answers being right.
    _number(validation.get("minAccuracyGain"), "validation.minAccuracyGain", problems, low=0, high=1)
    _number(validation.get("regressionTolerance"), "validation.regressionTolerance", problems, low=0)
    sets = validation.get("regressionSets", [])
    if not isinstance(sets, list):
        problems.append("validation.regressionSets: must be a list")
        sets = []
    for name in sets:
        if name not in regression_names:
            problems.append(f"validation.regressionSets: {name!r} is not declared in dataset.regression")

    # --- output, logs, resume -------------------------------------------
    output = _section(job, "output", problems)
    _text(output.get("name"), "output.name", problems)
    if not isinstance(output.get("version"), str) or not _VERSION.match(output["version"]):
        problems.append("output.version: must be semantic, for example 0.1.0 or 0.1.0-exp.1")

    logs = _section(job, "logs", problems)
    problems += policy.storage_problems(logs.get("storageKind"), logs.get("path"), "logs")

    resume = _section(job, "resume", problems)
    _text(resume.get("instructions"), "resume.instructions", problems)

    return problems


def load_job(path: str | Path) -> dict:
    """Read a job file and refuse it unless it validates."""
    job = json.loads(Path(path).read_text(encoding="utf-8"))
    problems = validate_job(job)
    if problems:
        raise JobSpecError(problems)
    return job


def canonical(payload: Any) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def job_digest(job: Mapping) -> str:
    """Digest of the whole contract, including where checkpoints go."""
    return hashlib.sha256(canonical(job)).hexdigest()


def config_digest(job: Mapping) -> str:
    """Digest of what determines the trained weights.

    Storage locations, thresholds and notes are left out on purpose: moving a
    checkpoint to another bucket must not invalidate it, while changing the learning
    rate, the data or the base revision must. Resume refuses any checkpoint whose
    config digest differs, because such a checkpoint belongs to a different run.
    """
    base = job["base"]
    dataset = job["dataset"]
    relevant = {
        "schema": job["schema"],
        "base": {"id": base["id"], "revision": base["revision"], "kind": base["kind"]},
        "dataset": {
            "id": dataset["id"],
            "version": dataset["version"],
            "train": dataset["train"]["sha256"],
            "validation": dataset["validation"]["sha256"],
            "regression": sorted(
                (item["name"], item["sha256"]) for item in dataset.get("regression", [])
            ),
        },
        "training": job["training"],
    }
    return hashlib.sha256(canonical(relevant)).hexdigest()
