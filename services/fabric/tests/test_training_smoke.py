"""The smoke ledger: each stage reports its own status, and nothing unrun is shown as passed.

The backend here is a fake. It has no torch and no network. It lets the orchestration,
the stage order, the gates and the ledger be tested on any machine. Whether the real
backend works on a GPU is a separate question, which only a real run answers.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from fabric.training import smoke
from fabric.training.jobspec import validate_job

REPO = Path(__file__).resolve().parent.parent
TEMPLATE = REPO / "remote" / "jobs" / "klyvaron-chat-lora-experiment.json"


class FakeTrainer:
    """Implements the runner's Trainer protocol. ``w`` counts steps; the metrics follow it."""

    def __init__(self, *, regression_worsens=False, nan_at=None, fail_at=None):
        self.w = 0
        self.regression_worsens = regression_worsens
        self.nan_at = nan_at
        self.fail_at = fail_at

    def evaluate(self, split):
        progress = min(self.w, 40) / 40
        if split == "validation":
            return {"loss": 2.0 - progress, "accuracy": 0.2 + 0.4 * progress, "examples": 300}
        if split == "synthetic-regression":
            return {"loss": 1.0 + (0.5 * progress if self.regression_worsens else 0.0), "examples": 40}
        raise KeyError(split)

    def train_step(self, step):
        if self.fail_at == step:
            raise RuntimeError(f"simulated crash at step {step}")
        self.w += 1
        return float("nan") if self.nan_at == step else 1.0

    def state_files(self):
        return {"state.json": json.dumps({"w": self.w}).encode()}

    def load_state_files(self, files):
        self.w = json.loads(files["state.json"])["w"]

    def export_artifact(self, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "adapter.json").write_text(json.dumps({"w": self.w}), encoding="utf-8")
        return ["adapter.json"]


class FakeBackend:
    def __init__(self, *, gpu="Fake GPU", verify_problems=(), reload_text="tuned answer",
                 reload_error=None, base_text="base answer", trainer_kwargs=None):
        self.gpu = gpu
        self.verify_problems = list(verify_problems)
        self.reload_text = reload_text
        self.reload_error = reload_error
        self.base_text = base_text
        self.trainer_kwargs = trainer_kwargs or {}
        self.trainers_built = 0

    def environment(self):
        return {"gpu": self.gpu, "problems": [], "torch": "fake"}

    def verify_model(self, job):
        return {"revision_matches": not self.verify_problems, "problems": list(self.verify_problems)}

    def trainer(self, job, dataset_dir):
        self.trainers_built += 1
        return FakeTrainer(**self.trainer_kwargs)

    def infer(self, prompt, adapter_dir=None):
        assert adapter_dir is None
        return self.base_text

    def reload(self, adapter_dir, prompt):
        if self.reload_error:
            raise RuntimeError(self.reload_error)
        assert (Path(adapter_dir) / "adapter.json").is_file(), "reload was asked for a missing artifact"
        return {"text": self.reload_text, "finite": True, "problems": []}


def local_job(tmp_path) -> dict:
    """The committed template, with checkpoints and logs on local disk under tmp_path, so a
    test can run the real orchestration without touching a notebook path."""
    job = copy.deepcopy(json.loads(TEMPLATE.read_text(encoding="utf-8")))
    job["checkpoint"].update(storageKind="local_disk", path=str(tmp_path / "ckpt"))
    job["logs"].update(storageKind="local_disk", path=str(tmp_path / "logs"))
    assert validate_job(job) == []
    return job


def run(tmp_path, backend, job=None, **kwargs):
    out = tmp_path / "out"
    ledger = smoke.run_smoke(job if job is not None else local_job(tmp_path), backend,
                             out_dir=out, platform=kwargs.pop("platform", "kaggle"), **kwargs)
    return ledger, out


def status(ledger, name):
    return ledger.stages[name]["status"]


def test_the_stage_names_are_the_documented_set():
    assert smoke.STAGES == ("environment", "model_verification", "dataset", "training", "reload",
                            "inference", "quality", "persistence")


def test_a_clean_run_with_a_gpu_passes_every_core_stage(tmp_path):
    ledger, out = run(tmp_path, FakeBackend())
    assert ledger.verdict == "PASSED", ledger.to_dict()
    for name in smoke.CORE_STAGES:
        assert status(ledger, name) == "PASSED", name
    assert status(ledger, "persistence") == "NOT RUN"
    written = json.loads((out / "status.json").read_text(encoding="utf-8"))
    assert written["verdict"] == "PASSED"
    assert written["persistence"]["verified"] is False


def test_without_a_gpu_only_the_checks_that_need_no_gpu_run(tmp_path):
    backend = FakeBackend(gpu=None)
    ledger, _ = run(tmp_path, backend)
    assert status(ledger, "environment") == "PASSED"
    assert status(ledger, "model_verification") == "PASSED"
    assert status(ledger, "dataset") == "PASSED"
    for name in ("training", "reload", "inference", "quality", "persistence"):
        assert status(ledger, name) == "NOT RUN", name
    assert backend.trainers_built == 0
    assert ledger.verdict == "INCOMPLETE"
    assert any("No GPU" in note for note in ledger.notes)


def test_a_failed_licence_or_revision_check_stops_before_any_training(tmp_path):
    backend = FakeBackend(verify_problems=["the LICENSE file at the pinned revision is not Apache"])
    ledger, _ = run(tmp_path, backend)
    assert status(ledger, "model_verification") == "FAILED"
    assert status(ledger, "dataset") == "PASSED"          # cheap and independent, so it still runs
    assert status(ledger, "training") == "NOT RUN"
    assert backend.trainers_built == 0
    assert ledger.verdict == "FAILED"


def test_data_that_does_not_match_its_pins_stops_training(tmp_path):
    job = local_job(tmp_path)
    job["dataset"]["train"]["sha256"] = "0" * 64
    backend = FakeBackend()
    ledger, _ = run(tmp_path, backend, job=job)
    assert status(ledger, "dataset") == "FAILED"
    assert any("train" in p for p in ledger.stages["dataset"]["detail"]["problems"])
    assert status(ledger, "training") == "NOT RUN"
    assert backend.trainers_built == 0


def test_a_training_crash_is_a_recorded_failure_not_a_pass(tmp_path):
    ledger, _ = run(tmp_path, FakeBackend(trainer_kwargs={"fail_at": 3}))
    assert status(ledger, "training") == "FAILED"
    assert "simulated crash" in json.dumps(ledger.stages["training"]["detail"])
    assert ledger.verdict == "FAILED"


def test_a_non_finite_loss_fails_training_and_is_not_checkpointed(tmp_path):
    job = local_job(tmp_path)
    ledger, _ = run(tmp_path, FakeBackend(trainer_kwargs={"nan_at": 5}), job=job)
    assert status(ledger, "training") == "FAILED"
    checkpoints = tmp_path / "ckpt"
    assert not checkpoints.exists() or not any(checkpoints.glob("step-*")), "a non-finite step was checkpointed"
    assert "FloatingPointError" in ledger.stages["training"]["detail"]["error"]


def test_an_adapter_that_gives_the_base_answer_fails_inference(tmp_path):
    ledger, _ = run(tmp_path, FakeBackend(reload_text="base answer", base_text="base answer"))
    assert status(ledger, "reload") == "PASSED"
    assert status(ledger, "inference") == "FAILED"
    assert "identical" in ledger.stages["inference"]["detail"]["note"]
    assert ledger.verdict == "FAILED"


def test_a_reload_failure_leaves_inference_not_run_and_fails_the_run(tmp_path):
    ledger, _ = run(tmp_path, FakeBackend(reload_error="adapter file is corrupt"))
    assert status(ledger, "reload") == "FAILED"
    assert status(ledger, "inference") == "NOT RUN"
    assert "adapter file is corrupt" in json.dumps(ledger.stages["reload"]["detail"])
    assert ledger.verdict == "FAILED"


def test_a_candidate_the_gate_refuses_is_not_accepted_but_is_still_tested(tmp_path):
    ledger, _ = run(tmp_path, FakeBackend(trainer_kwargs={"regression_worsens": True}))
    assert status(ledger, "quality") == "FAILED"
    assert any("worsened" in reason for reason in ledger.stages["quality"]["detail"]["decision"]["reasons"])
    assert status(ledger, "reload") == "PASSED"           # the mechanics still ran
    assert ledger.verdict == "NOT ACCEPTED"


def test_persistence_is_not_claimed_without_a_read_back(tmp_path):
    ledger, _ = run(tmp_path, FakeBackend())
    assert status(ledger, "persistence") == "NOT RUN"
    assert ledger.to_dict()["persistence"]["verified"] is False
    assert "NOT VERIFIED" in ledger.to_dict()["persistence"]["statement"]


def test_persistence_passes_only_when_the_adapter_is_read_back(tmp_path):
    adapter = tmp_path / "out" / "run" / "artifact"
    ledger, _ = run(tmp_path, FakeBackend(), persistence_adapter=adapter)
    assert status(ledger, "persistence") == "PASSED"
    assert ledger.to_dict()["persistence"]["verified"] is True


def test_a_persistence_read_back_that_fails_is_a_failure(tmp_path):
    backend = FakeBackend()
    original = backend.reload
    calls = []

    def flaky(adapter_dir, prompt):
        calls.append(adapter_dir)
        if len(calls) == 2:
            raise OSError("input directory is missing")
        return original(adapter_dir, prompt)

    backend.reload = flaky
    ledger, _ = run(tmp_path, backend, persistence_adapter=tmp_path / "missing")
    assert status(ledger, "persistence") == "FAILED"
    assert ledger.verdict == "FAILED"


def test_a_job_that_breaks_a_rule_is_refused_and_nothing_runs(tmp_path):
    job = local_job(tmp_path)
    job["base"]["revision"] = "REPLACE_WITH_COMMIT_SHA"
    backend = FakeBackend()
    ledger, out = run(tmp_path, backend, job=job)
    assert ledger.verdict == "REFUSED"
    assert ledger.refused
    assert all(status(ledger, name) == "NOT RUN" for name in smoke.STAGES)
    assert backend.trainers_built == 0
    assert (out / "status.json").is_file()


def test_the_context_is_written_so_a_run_can_be_traced(tmp_path):
    ledger, out = run(tmp_path, FakeBackend(), context={"repoCommit": "abc123", "jobFile": "x.json"})
    written = json.loads((out / "status.json").read_text(encoding="utf-8"))
    assert written["context"] == {"repoCommit": "abc123", "jobFile": "x.json"}


def test_only_the_three_documented_statuses_appear(tmp_path):
    ledger, _ = run(tmp_path, FakeBackend(reload_error="x"))
    seen = {ledger.stages[name]["status"] for name in smoke.STAGES}
    assert seen <= {"PASSED", "FAILED", "NOT RUN"}


def test_colab_moves_storage_to_the_session_disk_and_marks_it_ephemeral(tmp_path):
    job = local_job(tmp_path)
    ledger = smoke.Ledger(platform="colab")
    moved = smoke.apply_platform(job, "colab", ledger)
    assert moved["checkpoint"]["storageKind"] == "colab_session"
    assert moved["checkpoint"]["path"].startswith("/content/")
    assert moved["checkpoint"]["ephemeralAcknowledged"] is True
    assert validate_job(moved) == []
    assert any("lost" in note for note in ledger.notes)


def test_kaggle_keeps_the_job_paths_as_written(tmp_path):
    job = local_job(tmp_path)
    ledger = smoke.Ledger(platform="kaggle")
    assert smoke.apply_platform(job, "kaggle", ledger) == job


def test_an_unknown_platform_is_refused():
    with pytest.raises(ValueError):
        smoke.apply_platform({}, "some-other-cloud", smoke.Ledger(platform="x"))


def test_the_dataset_is_generated_from_the_rules_and_written_for_the_trainer(tmp_path):
    ledger, out = run(tmp_path, FakeBackend())
    manifest = json.loads((out / "dataset" / "manifest.json").read_text(encoding="utf-8"))
    assert ledger.stages["dataset"]["detail"]["digest"] == manifest["digest"]
    assert (out / "dataset" / "train.jsonl").is_file()
