"""Candidates, the stable-release rule, and experience admission.

Release and admission have one job each: to stop a result that is not yet earned
from being treated as earned. The wiring tests below use a real run record with a
job whose base is a third-party fine-tune. The record's measurements are the fixture's,
so they test the wiring, not any model quality.
"""

from __future__ import annotations

import ast
import copy
from pathlib import Path

import pytest

from fabric.training import experience
from fabric.training.jobspec import validate_job
from fabric.training.lora_fixture import fixture_job, run_fixture
from fabric.training.release import CandidateRefused, candidate_manifest, stable_replacement_problems

from test_training_jobspec import DIGEST_A, SHA_A, valid_job


@pytest.fixture(scope="module")
def fixture_runs(tmp_path_factory):
    root = tmp_path_factory.mktemp("release")
    return {
        "improves": run_fixture("improves", root / "improves"),
        "no_signal": run_fixture("no_signal", root / "no_signal"),
    }


def _third_party_job() -> dict:
    job = valid_job()
    job["output"]["version"] = "0.1.0-exp.1"
    assert validate_job(job) == []
    return job


def _eligible_record(record):
    """The same record, with a decision that says eligible. Used only for wiring tests."""
    clone = copy.deepcopy(record)
    clone.results["decision"] = {**clone.results["decision"], "eligible": True, "reasons": []}
    return clone


def test_a_run_that_is_not_eligible_cannot_become_a_candidate(fixture_runs):
    with pytest.raises(CandidateRefused, match="acceptance criteria"):
        candidate_manifest(_third_party_job(), fixture_runs["no_signal"])


def test_a_fixture_run_is_never_a_candidate_even_when_eligible(fixture_runs):
    job = fixture_job("improves", dataset_digest="f" * 64, checkpoint_root=Path("/tmp/x"), log_dir=Path("/tmp/x"))
    with pytest.raises(CandidateRefused, match="fixture run"):
        candidate_manifest(job, _eligible_record(fixture_runs["improves"]))


def test_a_candidate_records_the_base_the_data_the_config_and_the_checksums(fixture_runs):
    manifest = candidate_manifest(_third_party_job(), _eligible_record(fixture_runs["improves"]))
    assert manifest["state"] == "candidate"
    assert manifest["base"]["id"] == "example/base-model"
    assert manifest["base"]["revision"] == DIGEST_A
    assert manifest["base"]["kind"] == "third_party_finetune"
    assert manifest["base"]["independentlyPretrained"] is False
    assert manifest["dataset"]["train"]["sha256"] == SHA_A
    assert manifest["training"]["learningRate"] == 0.0002
    assert manifest["configDigest"]
    assert manifest["adapter"]["digest"] == _eligible_record(fixture_runs["improves"]).artifacts["adapter"]["digest"]
    assert manifest["runRecordDigest"]
    assert "not run" in manifest["acceptance"]


def _candidate():
    return candidate_manifest(_third_party_job(), _eligible_record(run_fixture_cached()))


_CACHE = {}


def run_fixture_cached():
    if "record" not in _CACHE:
        import tempfile

        _CACHE["record"] = run_fixture("improves", Path(tempfile.mkdtemp()) / "run")
    return _CACHE["record"]


def test_replacing_the_stable_release_needs_acceptance_an_approver_and_a_new_version():
    candidate = _candidate()
    assert stable_replacement_problems(candidate, current_stable_version="0.0.9",
                                       acceptance_passed=True, approved_by="a maintainer") == []

    missing = stable_replacement_problems(candidate, current_stable_version="0.0.9",
                                          acceptance_passed=False, approved_by=None)
    assert any("acceptance suite" in p for p in missing)
    assert any("approver" in p for p in missing)

    same = stable_replacement_problems(candidate, current_stable_version=candidate["version"],
                                       acceptance_passed=True, approved_by="a maintainer")
    assert any("same version" in p for p in same)


def test_a_candidate_that_was_not_eligible_cannot_replace_the_stable_release():
    candidate = _candidate()
    candidate["evaluation"]["decision"]["eligible"] = False
    problems = stable_replacement_problems(candidate, current_stable_version="0.0.9",
                                           acceptance_passed=True, approved_by="a maintainer")
    assert any("not eligible" in p for p in problems)


def test_a_third_party_fine_tune_cannot_be_recorded_as_independent():
    candidate = _candidate()
    candidate["base"]["independentlyPretrained"] = True
    problems = stable_replacement_problems(candidate, current_stable_version="0.0.9",
                                           acceptance_passed=True, approved_by="a maintainer")
    assert any("not independently pretrained" in p for p in problems)


# --- experience-driven examples ----------------------------------------------------------

def _example(**changes):
    base = experience.Example(
        example_id="conv-001-turn-3",
        prompt="How do I reverse a list in Python?",
        response="Use reversed() or slicing with [::-1].",
        source="conversation-hash-abc",
        consent=True,
        consent_basis="opt-in: 'use my conversations to improve Klyvaron'",
        reviewer="a reviewer",
        quality_score=0.92,
    )
    return experience.Example(**{**base.__dict__, **changes})


def test_a_consented_reviewed_good_example_is_admitted_to_the_queue_only():
    admission = experience.admit(_example())
    assert admission.admitted is True
    assert admission.reasons == ()


@pytest.mark.parametrize("changes, phrase", [
    ({"consent": False}, "consent"),
    ({"consent_basis": "  "}, "consent"),
    ({"reviewer": ""}, "reviewer"),
    ({"quality_score": 0.5}, "below the threshold"),
    ({"quality_score": 1.5}, "between 0 and 1"),
    ({"prompt": ""}, "non-empty"),
    ({"response": "Here: password = hunter2hunter2hunter2"}, "secret-like"),
    ({"prompt": "Use Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789"}, "secret-like"),
])
def test_an_example_that_fails_any_check_is_refused_with_the_reason(changes, phrase):
    admission = experience.admit(_example(**changes))
    assert admission.admitted is False
    assert any(phrase in reason for reason in admission.reasons), admission.reasons


def test_a_secret_is_rejected_not_repaired_into_the_training_text():
    admission = experience.admit(_example(response="password = hunter2hunter2hunter2"))
    assert admission.admitted is False
    assert "generic_assignment_secret" in admission.redaction_findings


def test_the_admission_module_cannot_reach_the_trainer():
    """Admission must not be wired straight into training. Checked on the imports, not on
    the text, so a docstring that mentions the runner does not count as a dependency."""
    tree = ast.parse(Path(experience.__file__).read_text(encoding="utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            imported.add(node.module or "")
            imported.update(f"{node.module}.{alias.name}" for alias in node.names)
        elif isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
    for forbidden in ("fabric.training.runner", "fabric.training.lora_fixture", "fabric.training.release"):
        assert not any(name.startswith(forbidden) for name in imported), forbidden
