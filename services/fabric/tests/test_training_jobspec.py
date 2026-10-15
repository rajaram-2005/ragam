"""The remote-training job contract: what it refuses, and what it cannot refuse by mistake.

Every refusal below is a rule the project relies on. The example job in remote/jobs/
is a template, and the last test shows that its refusal is caused by its placeholders
alone: fill them with valid values and it is accepted. Without that test, the template
could be refused for a reason nobody intended.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from fabric.training.jobspec import config_digest, load_job, validate_job

REPO = Path(__file__).resolve().parent.parent
TEMPLATE = REPO / "remote" / "jobs" / "klyvaron-chat-lora-experiment.json"
DIGEST_A = "a" * 40
SHA_A = "b" * 64


def valid_job() -> dict:
    """A job that passes. The hashes are test values, not real files."""
    return {
        "schema": "aetheris-training-job/1",
        "jobId": "test-job-001",
        "tier": "experiment",
        "purpose": "A test job.",
        "base": {
            "id": "example/base-model",
            "kind": "third_party_finetune",
            "revision": DIGEST_A,
            "licence": "Apache-2.0",
            "licenceCheckedUrl": f"https://example.org/example/base-model/blob/{DIGEST_A}/LICENSE",
            "licenceCheckedBy": "a reviewer",
            "attributionNotice": "example/base-model, Apache-2.0",
        },
        "dataset": {
            "id": "test-data",
            "version": "1.0.0",
            "provenance": "owner_authored",
            "licence": "MIT",
            "contentsDescription": "Test rows.",
            "containsPersonalData": False,
            "train": {"file": "train.jsonl", "sha256": SHA_A, "examples": 1000},
            "validation": {"file": "validation.jsonl", "sha256": SHA_A, "examples": 300},
            "regression": [{"name": "general", "file": "general.jsonl", "sha256": SHA_A, "examples": 300}],
        },
        "training": {
            "method": "lora", "rank": 8, "alpha": 16, "dropout": 0.05,
            "targetModules": ["q_proj"], "learningRate": 0.0002, "steps": 1000,
            "batchSize": 8, "seqLen": 512, "seed": 1,
        },
        "resources": {"accelerator": "gpu", "minGpuMemoryGb": 12, "expectedHours": 2.0,
                      "maxSessionHours": 9.0, "storageGb": 3},
        "checkpoint": {"everySteps": 100, "keepLast": 3, "storageKind": "google_drive",
                       "path": "/content/drive/MyDrive/test/checkpoints/test-job-001"},
        "validation": {"baselineName": "untrained-base", "minImprovement": 0.02,
                       "minAccuracyGain": 0.0, "regressionSets": ["general"],
                       "regressionTolerance": 0.05},
        "output": {"name": "test-adapter", "version": "0.1.0-exp.1"},
        "logs": {"storageKind": "google_drive", "path": "/content/drive/MyDrive/test/logs"},
        "resume": {"instructions": "Re-run with the same checkpoint path."},
    }


def problems_for(mutate) -> list:
    job = valid_job()
    mutate(job)
    return validate_job(job)


def test_the_valid_job_passes():
    assert validate_job(valid_job()) == []


def _strings(node):
    if isinstance(node, dict):
        for value in node.values():
            yield from _strings(value)
    elif isinstance(node, list):
        for value in node:
            yield from _strings(value)
    elif isinstance(node, str):
        yield node


def test_the_committed_template_is_complete_and_validates():
    """The template carries real pins (base commit, dataset hashes) and no placeholder."""
    template = json.loads(TEMPLATE.read_text(encoding="utf-8"))
    assert not any("REPLACE_" in s for s in _strings(template))
    assert validate_job(template) == []
    assert load_job(TEMPLATE)["base"]["revision"] == "7ae557604adf67be50417f59c2c2f167def9a775"


def test_a_placeholder_left_in_the_template_is_refused():
    """If this fails, the placeholder rule has stopped refusing unfilled values."""
    template = json.loads(TEMPLATE.read_text(encoding="utf-8"))
    template["base"]["revision"] = "REPLACE_WITH_COMMIT_SHA"
    problems = validate_job(template)
    assert any("placeholder" in p for p in problems), problems


@pytest.mark.parametrize("revision", ["main", "v1.0", "a" * 39, "A" * 40, "REPLACE_WITH_COMMIT_SHA"])
def test_base_must_be_pinned_to_a_commit_hash(revision):
    problems = problems_for(lambda j: j["base"].update(revision=revision))
    assert any(p.startswith("base.revision") for p in problems), problems


@pytest.mark.parametrize("licence", ["CC-BY-NC-4.0", "unknown", "", None, "Proprietary"])
def test_non_allowlisted_licences_are_refused(licence):
    problems = problems_for(lambda j: j["base"].update(licence=licence))
    assert any("base.licence" in p for p in problems), problems


def test_a_placeholder_anywhere_in_a_string_is_refused():
    problems = problems_for(lambda j: j["base"].update(
        licenceCheckedUrl="https://example.org/blob/REPLACE_WITH_COMMIT_SHA/LICENSE"))
    assert any("base.licenceCheckedUrl" in p and "never replaced" in p for p in problems), problems


def test_a_third_party_base_needs_a_licence_check_and_attribution():
    problems = problems_for(lambda j: j["base"].pop("licenceCheckedBy"))
    assert any("base.licenceCheckedBy" in p for p in problems)


def test_licensed_data_needs_a_named_authorization_to_leave_the_machine():
    def mutate(j):
        j["dataset"]["provenance"] = "licensed"
    problems = problems_for(mutate)
    assert any("authorization" in p for p in problems), problems

    def authorised(j):
        j["dataset"]["provenance"] = "licensed"
        j["dataset"]["authorization"] = {"authorizedBy": "the data owner", "reason": "fine-tuning experiment"}
    assert validate_job(_with(authorised)) == []


def test_an_authorization_with_no_name_is_refused():
    def mutate(j):
        j["dataset"]["provenance"] = "licensed"
        j["dataset"]["authorization"] = {"authorizedBy": "  ", "reason": ""}
    problems = problems_for(mutate)
    assert any("authorizedBy" in p for p in problems) and any("reason" in p for p in problems)


def test_experience_data_needs_consent_and_both_reviews():
    def mutate(j):
        j["dataset"]["provenance"] = "consented_experience"
        j["dataset"]["authorization"] = {"authorizedBy": "the user", "reason": "opted in"}
    problems = problems_for(mutate)
    assert any("consentBasis" in p for p in problems)
    assert any("privacyReviewPassed" in p for p in problems)
    assert any("qualityReviewPassed" in p for p in problems)


def test_personal_data_is_never_accepted_for_a_remote_job():
    problems = problems_for(lambda j: j["dataset"].update(containsPersonalData=True))
    assert any("containsPersonalData" in p for p in problems)


@pytest.mark.parametrize("path", [
    "/kaggle/working/ckpt",
    "/kaggle/temp/ckpt",
    "/kaggle/input/some-output/ckpt",
    "/content/checkpoints",
    "/content/drive-copy/ckpt",
    "/kaggle/working/../input/x",
])
def test_notebook_paths_are_refused_for_a_kind_that_does_not_match_them(path):
    problems = problems_for(lambda j: j["checkpoint"].update(path=path, storageKind="local_disk"))
    assert any("notebook path" in p or "session disk" in p for p in problems), (path, problems)


def test_a_notebook_temporary_storage_kind_is_refused():
    problems = problems_for(lambda j: j["checkpoint"].update(storageKind="notebook_temp"))
    assert any("is not allowed" in p for p in problems)


def test_google_drive_paths_must_be_on_drive():
    problems = problems_for(lambda j: j["checkpoint"].update(path="/home/user/ckpt"))
    assert any("must begin" in p for p in problems)


def test_object_store_paths_must_be_bucket_uris():
    problems = problems_for(lambda j: j["checkpoint"].update(storageKind="object_store", path="my folder"))
    assert any("bucket URI" in p for p in problems)
    ok = problems_for(lambda j: j["checkpoint"].update(storageKind="object_store",
                                                        path="s3://bucket/klyvaron/ckpt"))
    assert not any("checkpoint" in p for p in ok)


def test_checkpoints_must_fall_within_the_run():
    problems = problems_for(lambda j: j["checkpoint"].update(everySteps=5000))
    assert any("no checkpoint is ever written" in p for p in problems)


def test_a_job_needing_several_sessions_must_checkpoint_to_resume():
    def mutate(j):
        j["resources"]["expectedHours"] = 20
        j["resources"]["maxSessionHours"] = 9
        del j["checkpoint"]["everySteps"]
    problems = problems_for(mutate)
    assert any("must checkpoint to resume" in p for p in problems), problems


def test_a_regression_set_must_be_declared_before_it_is_used():
    problems = problems_for(lambda j: j["validation"].update(regressionSets=["undeclared"]))
    assert any("undeclared" in p for p in problems)


def test_a_validation_set_below_the_minimum_is_refused():
    problems = problems_for(lambda j: j["dataset"]["validation"].update(examples=50))
    assert any("below the minimum" in p for p in problems)


def test_qlora_is_named_but_not_accepted_yet():
    problems = problems_for(lambda j: j["training"].update(method="qlora"))
    assert any("qlora is not implemented" in p for p in problems)


@pytest.mark.parametrize("job_id", ["A", "has spaces", "-leading", "x" * 64])
def test_job_ids_are_restricted(job_id):
    problems = problems_for(lambda j: j.update(jobId=job_id))
    assert any(p.startswith("jobId") for p in problems)


def test_the_schema_version_is_checked():
    problems = problems_for(lambda j: j.update(schema="aetheris-training-job/2"))
    assert any(p.startswith("schema") for p in problems)


def test_a_non_semantic_output_version_is_refused():
    problems = problems_for(lambda j: j["output"].update(version="latest"))
    assert any("output.version" in p for p in problems)


def test_config_digest_moves_with_what_trains_and_not_with_where_it_is_kept():
    base = valid_job()
    digest = config_digest(base)

    moved = copy.deepcopy(base)
    moved["checkpoint"]["path"] = "/content/drive/MyDrive/elsewhere"
    moved["validation"]["minImprovement"] = 0.5
    moved["logs"]["path"] = "/content/drive/MyDrive/other-logs"
    assert config_digest(moved) == digest

    for change in (
        lambda j: j["training"].update(learningRate=0.001),
        lambda j: j["base"].update(revision="c" * 40),
        lambda j: j["dataset"]["train"].update(sha256="d" * 64),
        lambda j: j["training"].update(seed=2),
    ):
        changed = copy.deepcopy(base)
        change(changed)
        assert config_digest(changed) != digest


def _with(mutate) -> dict:
    job = valid_job()
    mutate(job)
    return job
