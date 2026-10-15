"""From a completed run to a candidate, and the rule for replacing the stable release.

A candidate is a *proposal*. It records what the base was, what data and config
produced the adapter, what it was measured against, and the checksum of every file.
It does not change any stable pointer. Replacing the stable release is a separate
decision, and this module refuses it unless a human has named an approver and
stated that the acceptance suite passed. The code cannot run that suite itself.

The base is always recorded as what it is. A LoRA adapter on a third-party base is
a fine-tune of that base, with its licence and attribution. It is never described
as an independently pretrained Klyvaron model, and the manifest says so in a field.
"""

from __future__ import annotations

from typing import Mapping

from fabric.run import RunRecord

CANDIDATE_FORMAT = "aetheris-candidate/1"


class CandidateRefused(RuntimeError):
    def __init__(self, problems: list):
        self.problems = list(problems)
        super().__init__("; ".join(self.problems))


def candidate_manifest(job: Mapping, record: RunRecord) -> dict:
    problems: list = []
    if record.status != "completed":
        problems.append(f"run status is {record.status!r}; only a completed run can become a candidate")
    decision = record.results.get("decision") or {}
    if not decision.get("eligible"):
        reasons = decision.get("reasons") or ["the run has no decision"]
        problems.append("the run did not meet its acceptance criteria: " + "; ".join(reasons))
    if job["base"]["kind"] != "third_party_finetune":
        problems.append("a fixture run is never a release candidate")
    adapter = record.artifacts.get("adapter")
    if not adapter or not adapter.get("files"):
        problems.append("no adapter artifact is recorded")
    if problems:
        raise CandidateRefused(problems)

    base = job["base"]
    dataset = job["dataset"]
    return {
        "format": CANDIDATE_FORMAT,
        "state": "candidate",
        "name": job["output"]["name"],
        "version": job["output"]["version"],
        "base": {
            "id": base["id"],
            "revision": base["revision"],
            "kind": base["kind"],
            "licence": base["licence"],
            "licenceCheckedUrl": base["licenceCheckedUrl"],
            "licenceCheckedBy": base["licenceCheckedBy"],
            "attributionNotice": base["attributionNotice"],
            "independentlyPretrained": False,
        },
        "dataset": {
            "id": dataset["id"],
            "version": dataset["version"],
            "provenance": dataset["provenance"],
            "licence": dataset["licence"],
            "train": {"sha256": dataset["train"]["sha256"], "examples": dataset["train"]["examples"]},
            "validation": {"sha256": dataset["validation"]["sha256"], "examples": dataset["validation"]["examples"]},
            "regression": [{"name": item["name"], "sha256": item["sha256"]} for item in dataset.get("regression", [])],
        },
        "training": dict(job["training"]),
        "configDigest": record.config["configDigest"],
        "evaluation": {
            "baseline": record.results["baseline"],
            "final": record.results["final"],
            "regressionBaseline": record.results["regressionBaseline"],
            "regressionFinal": record.results["regressionFinal"],
            "decision": decision,
        },
        "adapter": {
            "directory": adapter["directory"],
            "digest": adapter["digest"],
            "files": adapter["files"],
        },
        "runRecordDigest": record.digest(),
        "acceptance": "not run. A candidate must pass the acceptance suite and a human review "
                      "before it may replace the stable release.",
    }


def stable_replacement_problems(candidate: Mapping, *, current_stable_version: str,
                                acceptance_passed: bool, approved_by: str | None) -> list:
    """Reasons a candidate may not replace the stable release. Empty means none found.

    ``acceptance_passed`` and ``approved_by`` are supplied by the person doing the
    release. This function cannot verify them and does not pretend to.
    """
    problems = []
    if candidate.get("format") != CANDIDATE_FORMAT:
        problems.append("not a candidate manifest")
        return problems
    if candidate.get("state") != "candidate":
        problems.append("only a manifest in the candidate state may be considered")
    if not candidate.get("evaluation", {}).get("decision", {}).get("eligible"):
        problems.append("the candidate's decision is not eligible")
    if candidate.get("base", {}).get("independentlyPretrained") is not False and \
            candidate.get("base", {}).get("kind") == "third_party_finetune":
        problems.append("a third-party fine-tune must be recorded as not independently pretrained")
    if candidate.get("version") == current_stable_version:
        problems.append("the candidate has the same version as the stable release")
    if not acceptance_passed:
        problems.append("the acceptance suite has not passed")
    if not approved_by or not str(approved_by).strip():
        problems.append("no approver is named")
    return problems
