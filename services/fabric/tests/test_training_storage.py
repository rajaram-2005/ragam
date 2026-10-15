"""Where checkpoints may live, what counts as persistent, and how synthetic data is labelled.

Kaggle's /kaggle/working is kept as the output of a committed notebook version. These
tests pin the rules that follow from that, so a later edit cannot quietly let a
notebook path pass as a persistent one, or let an input path be written to.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from fabric.training import policy
from fabric.training.jobspec import validate_job

REPO = Path(__file__).resolve().parent.parent
TEMPLATE = REPO / "remote" / "jobs" / "klyvaron-chat-lora-experiment.json"


def template() -> dict:
    return copy.deepcopy(json.loads(TEMPLATE.read_text(encoding="utf-8")))


@pytest.mark.parametrize("path", [
    "/kaggle/working/aetheris-smoke/checkpoints",
    "/kaggle/working/a/b",
])
def test_kaggle_output_is_allowed_inside_the_working_directory(path):
    assert policy.storage_problems("kaggle_output", path, "checkpoint") == []


@pytest.mark.parametrize("path", [
    "/kaggle/working",
    "/kaggle/working/../input/x",
    "/kaggle/input/some-output/x",
    "/kaggle/temp/x",
    "/home/user/x",
])
def test_kaggle_output_refuses_paths_outside_the_working_directory(path):
    assert policy.storage_problems("kaggle_output", path, "checkpoint"), path


def test_kaggle_working_is_not_accepted_under_any_other_storage_kind():
    for kind in ("local_disk", "google_drive", "colab_session"):
        assert policy.storage_problems(kind, "/kaggle/working/x", "checkpoint"), kind


def test_colab_session_paths_need_an_explicit_ephemeral_acknowledgement():
    assert policy.storage_problems("colab_session", "/content/aetheris/ckpt", "checkpoint") == []
    assert policy.ephemeral_problems({"storageKind": "colab_session"}, "checkpoint")
    assert policy.ephemeral_problems({"storageKind": "colab_session", "ephemeralAcknowledged": True},
                                     "checkpoint") == []
    assert policy.ephemeral_problems({"storageKind": "kaggle_output"}, "checkpoint") == []


def test_the_colab_session_disk_is_never_accepted_as_a_persistent_kind():
    assert "colab_session" not in policy.PERSISTENT_KINDS
    assert "colab_session" in policy.EPHEMERAL_KINDS
    assert "kaggle_output" in policy.PERSISTENT_KINDS


def test_drive_paths_must_be_stored_as_google_drive():
    assert policy.storage_problems("google_drive", "/content/drive/MyDrive/x", "checkpoint") == []
    assert policy.storage_problems("kaggle_output", "/content/drive/MyDrive/x", "checkpoint")


def test_object_store_uris_survive_normalisation():
    assert policy.storage_problems("object_store", "s3://bucket/klyvaron/ckpt", "checkpoint") == []
    assert policy.storage_problems("object_store", "s3://bucket", "checkpoint")  # no prefix


def test_resume_sources_are_read_only_attached_outputs():
    assert policy.resume_source_problems(["/kaggle/input/earlier/aetheris-smoke/checkpoints"], "r") == []
    assert policy.resume_source_problems(["/kaggle/working/aetheris-smoke/checkpoints"], "r")
    assert policy.resume_source_problems("/kaggle/input/x", "r")          # not a list
    assert policy.resume_source_problems(["/kaggle/input/../working/x"], "r")


def test_a_job_refuses_a_resume_source_outside_kaggle_input():
    job = template()
    job["checkpoint"]["resumeFrom"] = ["/kaggle/working/aetheris-smoke/checkpoints"]
    assert any("resumeFrom" in p for p in validate_job(job))


def test_a_colab_job_without_acknowledgement_is_refused():
    job = template()
    job["checkpoint"].update(storageKind="colab_session", path="/content/aetheris-smoke/checkpoints")
    job["logs"].update(storageKind="colab_session", path="/content/aetheris-smoke/logs")
    problems = validate_job(job)
    assert any("ephemeralAcknowledged" in p for p in problems), problems
    job["checkpoint"]["ephemeralAcknowledged"] = True
    job["logs"]["ephemeralAcknowledged"] = True
    assert validate_job(job) == []


def test_a_synthetic_dataset_must_be_generated_locally_and_say_so():
    job = template()
    assert job["dataset"]["synthetic"] is True
    assert validate_job(job) == []

    job["dataset"]["provenance"] = "owner_authored"
    assert any("generated_locally" in p for p in validate_job(job))

    job = template()
    job["dataset"]["contentsDescription"] = "Rows about Klyvaron."
    assert any("must say SYNTHETIC" in p for p in validate_job(job))

    job = template()
    job["dataset"]["synthetic"] = "yes"
    assert any("dataset.synthetic" in p for p in validate_job(job))


def test_a_licensed_dataset_is_never_labelled_synthetic_to_skip_authorization():
    job = template()
    job["dataset"].update(provenance="licensed", synthetic=True)
    problems = validate_job(job)
    assert any("generated_locally" in p for p in problems)
    assert any("authorization" in p for p in problems)
