"""Tests for user-computer-first local worker engine (`fabric.lm.adapter` & `worker_exec.py`)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from fabric.lm.adapter import (
    ADAPTER_FORMAT,
    AdamWOptimizer,
    LoRAAdapter,
    TrainingCancelledError,
    TrainingLimitExceededError,
    run_worker_training_job,
)
from fabric.lm.bpe import ByteBPETokenizer
from fabric.lm.export import build_manifest, write_json
from fabric.lm.model import TransformerConfig, TransformerLM

WORKER_EXEC = Path(__file__).resolve().parents[1] / "scripts" / "worker_exec.py"


def _make_base_checkpoint(tmp_path: Path, *, instruction_tuned: bool = True) -> Path:
    corpus = (
        "RAGAM verifies Klyvaron weights by SHA-256 before inference.\n"
        "Local workers pair explicitly and enforce resource limits.\n"
    ) * 20
    tok = ByteBPETokenizer.fit(corpus, vocab_size=300)
    cfg = TransformerConfig(
        vocab_size=tok.size,
        d_model=32,
        n_layers=2,
        n_heads=4,
        d_ff=64,
        seq_len=64,
        tie_embeddings=True,
        age_buckets=4,
        state_classes=4,
        verdict_head=True,
        state_head=True,
    )
    model = TransformerLM(cfg, seed=17, dtype=np.float32)
    out = tmp_path / "test-tiny-lm"
    out.mkdir(parents=True, exist_ok=True)
    wpath = out / "test-tiny-lm-0.1.0.npz"
    model.save(wpath)
    manifest = build_manifest(
        config=cfg,
        tokenizer=tok,
        weights_file=wpath.name,
        weights_bytes=wpath.read_bytes(),
        weights_names=list(model.params.keys()),
        artifact_id="test-tiny-lm",
        version="0.1.0",
        tier="lite",
        instruction_tuned=instruction_tuned,
        limitations=["Small dedicated test checkpoint; never presented as Klyvaron Pro or Max."],
    )
    write_json(out / "test-tiny-lm.klyvaron.json", manifest)
    (out / ".ready").write_text(manifest["weights"]["sha256"] + "\n", encoding="utf-8")
    return out


def test_lora_adapter_matches_finite_differences_in_float64():
    cfg = TransformerConfig(vocab_size=24, d_model=16, n_layers=2, n_heads=2, d_ff=32, seq_len=16)
    model = TransformerLM(cfg, seed=5, dtype=np.float64)
    base = {k: v.astype(np.float32) for k, v in model.params.items()}
    adapter = LoRAAdapter(base, cfg, rank=3, alpha=6.0, seed=11)
    # Give B non-zero values too so BOTH dA and dB receive non-zero analytical gradients!
    rng = np.random.default_rng(19)
    for k in list(adapter.params):
        adapter.params[k] = (rng.standard_normal(adapter.params[k].shape) * 0.05).astype(np.float32)

    xs = np.array([[1, 4, 7, 2, 9, 3]], dtype=np.int64)
    ys = np.array([[4, 7, 2, 9, 3, 5]], dtype=np.int64)
    mask = np.array([[0.0, 0.0, 1.0, 1.0, 1.0, 1.0]], dtype=np.float32)

    _, grads = adapter.loss_and_grads(model, xs, ys, loss_mask=mask)
    eps = 1e-3
    for name in sorted(adapter.params):
        idx = (0, 0)
        orig = float(adapter.params[name][idx])
        adapter.params[name][idx] = np.float32(orig + eps)
        lp = adapter.loss(model, xs, ys, loss_mask=mask)
        adapter.params[name][idx] = np.float32(orig - eps)
        lm = adapter.loss(model, xs, ys, loss_mask=mask)
        adapter.params[name][idx] = np.float32(orig)
        numeric = (lp - lm) / (2.0 * eps)
        assert abs(float(grads[name][idx]) - numeric) < 2e-3, f"gradient mismatch on {name}"


def test_adapter_job_updates_weights_reduces_loss_validates_and_rejects_tampering(tmp_path):
    base_dir = _make_base_checkpoint(tmp_path)
    out_dir = tmp_path / "adapter-out"
    ckpt_path = tmp_path / "work" / "step.ckpt.npz"

    spec = {
        "mode": "lightweight_adapter",
        "baseModelDir": str(base_dir),
        "artifactId": "test-tiny-adapter",
        "version": "0.1.0",
        "workDir": str(tmp_path / "work"),
        "checkpointPath": str(ckpt_path),
        "outputArtifactDir": str(out_dir),
        "intendedBehavior": "Answer RAGAM verification policy concisely.",
        "inputTargetFormat": {"input": "user prompt", "target": "assistant completion"},
        "dataProvenance": {
            "authorizationId": "auth-1",
            "origin": "user_explicit_input",
            "licence": "user-authorized",
            "datasetSha256": "abc123",
            "privateChatAutoIngested": False,
        },
        "trainingLoss": {"primary": "masked_cross_entropy", "learningRate": 1e-2, "rank": 4, "alpha": 8.0},
        "validationMethod": {"kind": "separate_validation_split"},
        "stoppingCriteria": {"maxSteps": 4, "maxDurationMs": 120_000},
        "regressionTests": [
            {"name": "logits_finite", "kind": "finite_logits"},
            {"name": "loss_drops", "kind": "target_loss_improved"},
            {"name": "generates_tokens", "kind": "non_empty_generation"},
        ],
        "trainExamples": [
            {"input": "How are weights checked?", "target": "Weights are verified by SHA-256."},
            {"input": "Does chat auto-train?", "target": "No, explicit consent is required."},
        ],
        "validationExamples": [
            {"input": "Where does training run?", "target": "On the paired local worker."},
        ],
    }

    events = []
    result = run_worker_training_job(spec, emit_progress=events.append)
    assert result["status"] == "completed"
    assert result["artifactFormat"] == ADAPTER_FORMAT
    assert result["metrics"]["stepsCompleted"] == 4
    assert result["metrics"]["finalTrainLoss"] < result["metrics"]["initialTrainLoss"]
    assert result["metrics"]["allRegressionsPassed"] is True
    assert any(ev["phase"] == "training" for ev in events)

    # Validate via worker_exec.py CLI and ensure corruption fails closed.
    vspec = tmp_path / "validate.json"
    vspec.write_text(
        json.dumps({"artifactDir": str(out_dir), "baseModelDir": str(base_dir)}),
        encoding="utf-8",
    )
    proc = subprocess.run([sys.executable, str(WORKER_EXEC), "validate", str(vspec)], capture_output=True, text=True, check=True)
    line = json.loads(proc.stdout.strip().splitlines()[-1])
    assert line["ok"] is True and line["valid"] is True

    npz_file = out_dir / "test-tiny-adapter-0.1.0.npz"
    raw = bytearray(npz_file.read_bytes())
    raw[-4] ^= 0xFF
    npz_file.write_bytes(bytes(raw))
    bad = subprocess.run([sys.executable, str(WORKER_EXEC), "validate", str(vspec)], capture_output=True, text=True)
    assert bad.returncode != 0


def test_interactive_adapter_enforces_wall_clock_ceiling_and_cancellation(tmp_path):
    base_dir = _make_base_checkpoint(tmp_path)
    base_spec = {
        "mode": "lightweight_adapter",
        "baseModelDir": str(base_dir),
        "artifactId": "timeout-adapter",
        "version": "0.1.0",
        "workDir": str(tmp_path / "work-t"),
        "checkpointPath": str(tmp_path / "work-t" / "ckpt.npz"),
        "outputArtifactDir": str(tmp_path / "out-t"),
        "intendedBehavior": "Test wall clock enforcement",
        "inputTargetFormat": {"input": "text", "target": "text"},
        "dataProvenance": {"authorizationId": "a2", "origin": "user_explicit_input", "privateChatAutoIngested": False},
        "trainingLoss": {"primary": "masked_cross_entropy", "learningRate": 1e-2, "rank": 4, "alpha": 8.0},
        "validationMethod": {"kind": "target_holdout"},
        "stoppingCriteria": {"maxSteps": 6, "maxDurationMs": 80},
        "stepDelayMs": 45,
        "regressionTests": [{"name": "logits_finite", "kind": "finite_logits"}],
        "trainExamples": [{"input": "Test prompt", "target": "Test answer"}],
    }
    with pytest.raises(TrainingLimitExceededError):
        run_worker_training_job(base_spec)
    assert not (Path(base_spec["outputArtifactDir"]) / ".ready").exists()

    base_spec["stoppingCriteria"] = {"maxSteps": 6, "maxDurationMs": 120_000}
    calls = {"n": 0}

    def cancel_after_one():
        calls["n"] += 1
        return calls["n"] >= 3

    with pytest.raises(TrainingCancelledError):
        run_worker_training_job(base_spec, should_cancel=cancel_after_one)
