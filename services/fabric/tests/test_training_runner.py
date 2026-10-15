"""The runner and the acceptance gate, run against the NumPy fixture.

The properties that matter most, and that these tests check:

* A resumed run ends at the same adapter, bit for bit, as an uninterrupted run.
* A resume from a corrupted newest checkpoint still ends at the same adapter.
* A loss that falls by calibration alone is not accepted.
* A run that worsens a regression set is not a candidate.
* ``completed`` means the artifact exists and was re-hashed from disk. It does not mean "good".
* The artifact on disk is the thing that was evaluated.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from fabric.run import RunRecord
from fabric.training.checkpoint import CheckpointStore
from fabric.training.jobspec import validate_job
from fabric.training.lora_fixture import (
    CLASSES,
    DIM,
    FixtureLoRA,
    _unpack,
    fixture_job,
    lora_gradients,
    make_splits,
    run_fixture,
)
from fabric.training.runner import artifact_summary, decide, run_job

REGRESSION = "source-retention"  # the fixture's regression set


# --- the gradient, checked against finite differences ---------------------------------

def test_hand_derived_lora_gradients_match_finite_differences():
    rng = np.random.default_rng(3)
    W0 = rng.normal(size=(5, 3))
    A = rng.normal(size=(5, 2))
    B = rng.normal(size=(2, 3))
    X = rng.normal(size=(7, 5))
    y = rng.integers(0, 3, 7)
    scale = 2.0
    _, dA, dB = lora_gradients(W0, A, B, scale, X, y)

    eps = 1e-6
    for param, grad in ((A, dA), (B, dB)):
        numeric = np.zeros_like(param)
        for index in np.ndindex(param.shape):
            original = param[index]
            param[index] = original + eps
            up, *_ = lora_gradients(W0, A, B, scale, X, y)
            param[index] = original - eps
            down, *_ = lora_gradients(W0, A, B, scale, X, y)
            param[index] = original
            numeric[index] = (up - down) / (2 * eps)
        assert np.allclose(grad, numeric, atol=1e-6), np.max(np.abs(grad - numeric))


# --- the decision, on crafted numbers so every branch is reached -----------------------

def _job(**validation):
    job = fixture_job("improves", dataset_digest="f" * 64, checkpoint_root=Path("/tmp/unused"),
                      log_dir=Path("/tmp/unused"))
    job["validation"].update(validation)
    return job


def test_a_gain_with_no_regression_is_eligible():
    decision = decide(_job(), {"loss": 2.0, "accuracy": 0.5}, {"loss": 1.0, "accuracy": 0.8, "examples": 300},
                      {REGRESSION: {"loss": 0.2}}, {REGRESSION: {"loss": 0.21}})
    assert decision.improved and decision.regressions_ok and decision.eligible
    assert decision.reasons == ()


def test_a_loss_gain_bought_with_lost_accuracy_is_not_accepted():
    decision = decide(_job(), {"loss": 4.9, "accuracy": 0.26}, {"loss": 2.4, "accuracy": 0.24, "examples": 300},
                      {REGRESSION: {"loss": 0.2}}, {REGRESSION: {"loss": 0.2}})
    assert not decision.improved and not decision.eligible
    assert any("accuracy changed" in reason for reason in decision.reasons)


def test_a_small_loss_gain_is_below_the_required_margin():
    decision = decide(_job(minImprovement=0.5), {"loss": 2.0, "accuracy": 0.5},
                      {"loss": 1.9, "accuracy": 0.6, "examples": 300},
                      {REGRESSION: {"loss": 0.2}}, {REGRESSION: {"loss": 0.2}})
    assert not decision.improved
    assert any("fell by" in reason for reason in decision.reasons)


def test_a_worsened_regression_set_blocks_eligibility_even_with_a_gain():
    decision = decide(_job(), {"loss": 2.0, "accuracy": 0.5}, {"loss": 1.0, "accuracy": 0.9, "examples": 300},
                      {REGRESSION: {"loss": 0.2}}, {REGRESSION: {"loss": 0.9}})
    assert decision.improved and not decision.regressions_ok and not decision.eligible
    assert any("worsened" in reason for reason in decision.reasons)


def test_a_missing_regression_measurement_is_not_treated_as_passing():
    decision = decide(_job(), {"loss": 2.0, "accuracy": 0.5}, {"loss": 1.0, "accuracy": 0.9, "examples": 300},
                      {REGRESSION: {"loss": 0.2}}, {})
    assert not decision.regressions_ok


def test_too_few_validation_examples_block_the_gain():
    decision = decide(_job(), {"loss": 2.0, "accuracy": 0.5}, {"loss": 1.0, "accuracy": 0.9, "examples": 40},
                      {REGRESSION: {"loss": 0.2}}, {REGRESSION: {"loss": 0.2}})
    assert not decision.improved and not decision.eligible


def test_a_non_finite_loss_is_never_a_gain():
    decision = decide(_job(), {"loss": 2.0, "accuracy": 0.5},
                      {"loss": float("nan"), "accuracy": 0.9, "examples": 300}, {}, {})
    assert not decision.improved and decision.loss_gain is None


# --- the fixture, end to end ------------------------------------------------------------

def test_the_fixture_job_is_itself_a_valid_contract(tmp_path):
    job = fixture_job("improves", dataset_digest="f" * 64, checkpoint_root=tmp_path, log_dir=tmp_path)
    assert validate_job(job) == []


def test_a_learnable_shift_completes_and_improves_but_forgetting_blocks_it(tmp_path):
    record = run_fixture("improves", tmp_path / "run")
    assert record.status == "completed"
    decision = record.results["decision"]
    assert decision["improved"] is True
    assert decision["regressions_ok"] is False          # the source task is forgotten
    assert decision["eligible"] is False
    assert any(REGRESSION in reason for reason in decision["reasons"])


def test_random_labels_complete_but_are_not_accepted(tmp_path):
    record = run_fixture("no_signal", tmp_path / "run")
    assert record.status == "completed"
    decision = record.results["decision"]
    assert decision["improved"] is False
    assert decision["eligible"] is False
    assert any("accuracy changed" in reason for reason in decision["reasons"])


def test_the_baseline_is_the_untrained_base_on_the_same_split(tmp_path):
    record = run_fixture("improves", tmp_path / "run")
    assert record.results["baseline"]["loss"] == pytest.approx(FixtureLoRA("improves").evaluate("validation")["loss"])


def test_completed_means_the_artifact_is_on_disk_and_its_digest_recomputes(tmp_path):
    out = tmp_path / "run"
    record = run_fixture("improves", out)
    adapter = record.artifacts["adapter"]
    assert adapter["directory"] == "artifact"
    assert set(adapter["files"]) == {"lora_A.npy", "lora_B.npy", "adapter_config.json"}
    recomputed = artifact_summary(out / adapter["directory"], list(adapter["files"]))
    assert recomputed["digest"] == adapter["digest"]
    assert recomputed["files"] == adapter["files"]


def test_the_artifact_on_disk_reproduces_the_evaluation_it_was_judged_on(tmp_path):
    out = tmp_path / "run"
    record = run_fixture("improves", out)
    A = np.load(out / "artifact" / "lora_A.npy")
    B = np.load(out / "artifact" / "lora_B.npy")
    scale = json.loads((out / "artifact" / "adapter_config.json").read_text())["scale"]
    W0 = FixtureLoRA("improves").W0
    X, y = make_splits("improves")["validation"]
    logits = X @ W0 + scale * (X @ A) @ B
    shifted = logits - logits.max(axis=1, keepdims=True)
    log_p = shifted - np.log(np.exp(shifted).sum(axis=1, keepdims=True))
    loss = -float(np.mean(log_p[np.arange(len(y)), y]))
    assert loss == pytest.approx(record.results["final"]["loss"], abs=1e-12)
    assert A.shape == (DIM, 2) and B.shape == (2, CLASSES)


def test_two_fresh_runs_produce_the_same_adapter(tmp_path):
    first = run_fixture("improves", tmp_path / "a")
    second = run_fixture("improves", tmp_path / "b")
    assert first.artifacts["adapter"]["digest"] == second.artifacts["adapter"]["digest"]


def test_the_run_record_round_trips_and_carries_its_provenance(tmp_path):
    out = tmp_path / "run"
    record = run_fixture("improves", out)
    loaded = RunRecord.load(out / "run-record.json")
    assert loaded.status == "completed"
    assert loaded.config["configDigest"] == record.config["configDigest"]
    assert loaded.dataset["id"] == "fixture/synthetic-target-shift"
    assert loaded.base_checkpoint == "fixture/synthetic-source-linear@fixture"
    assert any("Fixture run" in note for note in loaded.limitations)
    assert loaded.results["decision"]["eligible"] is False


def test_checkpoints_are_kept_at_the_cadence_and_pruned(tmp_path):
    record = run_fixture("improves", tmp_path / "run")
    assert record.status == "completed"
    assert CheckpointStore(tmp_path / "run" / "checkpoints").steps() == [200, 250, 300]  # every 50, keep 3
    saved = [s["detail"]["step"] for s in record.stages if s["name"] == "checkpoint"]
    assert saved == [50, 100, 150, 200, 250, 300]


# --- resume: the central claim ----------------------------------------------------------

def test_an_interrupted_and_resumed_run_ends_at_the_same_adapter_as_an_uninterrupted_one(tmp_path):
    full = run_fixture("improves", tmp_path / "full")

    cut = run_fixture("improves", tmp_path / "cut", stop_after=170)
    assert cut.status == "interrupted"
    assert "stop_after=170" in cut.error
    assert CheckpointStore(tmp_path / "cut" / "checkpoints").steps() == [50, 100, 150]

    resumed = run_fixture("improves", tmp_path / "cut")
    assert resumed.status == "completed"
    assert [s for s in resumed.stages if s["name"] == "resume"][0]["detail"]["fromStep"] == 150
    assert resumed.artifacts["adapter"]["digest"] == full.artifacts["adapter"]["digest"]
    assert resumed.results["final"] == full.results["final"]
    assert resumed.results["baseline"] == full.results["baseline"]


def test_resume_survives_a_corrupted_newest_checkpoint(tmp_path):
    full = run_fixture("improves", tmp_path / "full")
    run_fixture("improves", tmp_path / "cut", stop_after=260)  # checkpoints 50..250 exist
    torn = tmp_path / "cut" / "checkpoints" / "step-00000250" / "lora-state.bin"
    torn.write_bytes(b"torn write")

    resumed = run_fixture("improves", tmp_path / "cut")
    detail = [s for s in resumed.stages if s["name"] == "resume"][0]["detail"]
    assert detail["fromStep"] == 200
    assert any("step 250" in note and "checksum" in note for note in detail["skippedNewer"])
    assert resumed.artifacts["adapter"]["digest"] == full.artifacts["adapter"]["digest"]


def test_a_changed_learning_rate_cannot_resume_an_old_checkpoint(tmp_path):
    run_fixture("improves", tmp_path / "run", stop_after=120)
    trainer = FixtureLoRA("improves", learning_rate=0.01)
    job = fixture_job("improves", dataset_digest=trainer.dataset_digest,
                      checkpoint_root=tmp_path / "run" / "checkpoints", log_dir=tmp_path / "run")
    job["training"]["learningRate"] = 0.01
    record = run_job(job, trainer, checkpoints=CheckpointStore(tmp_path / "run" / "checkpoints"),
                     out_dir=tmp_path / "run")
    assert record.status == "refused"
    assert "different configuration" in record.error


# --- refusals and failures are recorded, not swallowed ----------------------------------

def test_an_invalid_job_is_refused_before_anything_trains(tmp_path):
    job = fixture_job("improves", dataset_digest="f" * 64, checkpoint_root=tmp_path / "c", log_dir=tmp_path)
    job["base"]["revision"] = "main"
    record = run_job(job, FixtureLoRA("improves"), checkpoints=CheckpointStore(tmp_path / "c"),
                     out_dir=tmp_path / "out")
    assert record.status == "refused"
    assert "base.revision" in record.error
    assert not (tmp_path / "c").exists()
    assert (tmp_path / "out" / "run-record.json").exists()


class _Crashing(FixtureLoRA):
    def train_step(self, step):
        if step == 5:
            raise MemoryError("simulated out-of-memory on the rented GPU")
        return super().train_step(step)


def test_a_crash_is_recorded_with_its_type_message_and_trace(tmp_path):
    job = fixture_job("improves", dataset_digest="f" * 64, checkpoint_root=tmp_path / "c", log_dir=tmp_path)
    record = run_job(job, _Crashing("improves"), checkpoints=CheckpointStore(tmp_path / "c"),
                     out_dir=tmp_path / "out")
    assert record.status == "failed"
    assert record.error.startswith("MemoryError")
    failure = [s for s in record.stages if s["name"] == "training"][0]
    assert failure["status"] == "failed"
    assert failure["detail"]["type"] == "MemoryError"
    assert "out-of-memory" in failure["detail"]["message"]
    assert "MemoryError" in failure["detail"]["trace"]
    assert "adapter" not in record.artifacts  # no artifact is claimed for a failed run


class _NaN(FixtureLoRA):
    def train_step(self, step):
        return float("nan") if step == 3 else super().train_step(step)


def test_a_non_finite_loss_fails_the_run_and_is_never_checkpointed(tmp_path):
    job = fixture_job("improves", dataset_digest="f" * 64, checkpoint_root=tmp_path / "c", log_dir=tmp_path)
    record = run_job(job, _NaN("improves"), checkpoints=CheckpointStore(tmp_path / "c"), out_dir=tmp_path / "out")
    assert record.status == "failed"
    assert "FloatingPointError" in record.error
    assert not (tmp_path / "c").exists()


def test_the_state_archive_is_deterministic_and_round_trips():
    trainer = FixtureLoRA("improves")
    trainer.train_step(0)
    files = trainer.state_files()
    again = FixtureLoRA("improves")
    again.load_state_files(files)
    assert np.array_equal(again.A, trainer.A) and np.array_equal(again.B, trainer.B)
    assert again.t == trainer.t == 1
    assert _unpack(files["lora-state.bin"])["B"].shape == (2, CLASSES)
    assert files == again.state_files()
