#!/usr/bin/env python3
"""Verify the real local training qualification evidence.

This is deliberately narrow: it checks the bytes that the pure-NumPy trainer
actually wrote, the checkpoint it resumed from, and the evaluation numbers in
the run reports. It does not claim a foundation model was trained. It records
which parts of the requested training lifecycle were NOT tested with the real
trainer (SIGTERM cancellation, remote/GPU training, user-owned datasets).
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / "build" / "training-qualification"
OUT = ROOT / "docs" / "release" / "evidence" / "training-evidence.json"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def report(name: str) -> dict:
    return json.loads((BUILD / name).read_text(encoding="utf-8"))


def check(results: list, name: str, ok: bool, detail: str) -> None:
    results.append({"id": name, "status": "PASS" if ok else "FAIL", "detail": detail})


def main() -> int:
    results: list[dict] = []
    a = report("segment-a.json")
    resumed = report("segment-r2.json")
    replay = report("segment-r3.json")

    r1_ckpts = sorted((BUILD / "segment-r1").glob("*.ckpt.npz"))
    check(results, "interrupted_run_left_an_atomic_checkpoint", len(r1_ckpts) == 1,
          f"{len(r1_ckpts)} checkpoint(s); writing uses .partial + Path.replace (services/fabric/fabric/lm/train.py:write_checkpoint)")
    ckpt = r1_ckpts[0]
    with np.load(ckpt, allow_pickle=False) as payload:
        meta = json.loads(bytes(payload["meta"].tolist()).decode("utf-8"))
        weight_keys = [key for key in payload.files if key.startswith("w::")]
        first_weight = payload[weight_keys[0]].copy() if weight_keys else None
        optimizer_keys = [key for key in payload.files if key.startswith(("m::", "v::"))]
    check(results, "checkpoint_integrity", meta.get("format") == "aetheris-checkpoint/v1" and first_weight is not None
          and meta.get("step") == 40 and len(meta.get("losses", [])) == 40 and len(optimizer_keys) > 0,
          f"format={meta.get('format')} step={meta.get('step')} losses={len(meta.get('losses', []))} weight_arrays={len(weight_keys)} adam_arrays={len(optimizer_keys)} loaded with allow_pickle=False")

    check(results, "resume_reports_the_checkpoint_it_used",
          resumed["provenance"].get("resumedFrom", {}).get("step") == 40
          and resumed["provenance"]["resumedFrom"]["checkpoint"] == ckpt.name,
          json.dumps(resumed["provenance"].get("resumedFrom")))
    check(results, "resume_continued_to_the_configured_step", resumed["resource"]["steps"] == 120
          and len(resumed["loss_curve"]) == 120, f"steps={resumed['resource']['steps']} loss_curve={len(resumed['loss_curve'])}")

    artifact_r2 = BUILD / "segment-r2" / resumed["artifact"]["filename"]
    artifact_r3 = BUILD / "segment-r3" / replay["artifact"]["filename"]
    check(results, "artifact_sha256_matches_report", sha256(artifact_r2) == resumed["artifact"]["fileDigest"],
          f"sha256={sha256(artifact_r2)} fileDigest={resumed['artifact']['fileDigest']}")
    check(results, "actual_parameter_updates", resumed["artifact"]["weightsDigest"] != a["artifact"]["weightsDigest"]
          and sha256(artifact_r2) != sha256(ckpt),
          f"10-step weights={a['artifact']['weightsDigest'][:16]}…, resumed 120-step weights={resumed['artifact']['weightsDigest'][:16]}…, checkpoint bytes differ from final artifact")
    check(results, "loss_decreased", resumed["loss_curve"][0]["loss"] > resumed["final_loss"],
          f"loss {resumed['loss_curve'][0]['loss']:.4f} -> {resumed['final_loss']:.4f}")
    check(results, "evaluation_before_and_after", a["evaluation"]["perplexity"] > resumed["evaluation"]["perplexity"],
          f"validation perplexity {a['evaluation']['perplexity']:.4f} (10 steps) -> {resumed['evaluation']['perplexity']:.4f} (120 steps); best baseline {resumed['evaluation']['bestBaseline']} {min(b['perplexity'] for b in resumed['evaluation']['baselines']):.4f} — the tiny smoke model does NOT beat it")
    check(results, "dataset_fingerprint_stable", a["corpus"]["manifestDigest"] == resumed["corpus"]["manifestDigest"],
          f"manifestDigest={resumed['corpus']['manifestDigest']} trainFiles={resumed['corpus']['trainFiles']} validationFiles={resumed['corpus']['validationFiles']} (no overlap)")
    check(results, "stable_training_configuration", resumed["checkpoints"]["configDigest"].startswith(meta["configDigest"][:12]),
          f"checkpoint configDigest={meta['configDigest'][:12]} matches resumed run; a mismatch is refused by train.py")
    check(results, "restart_recovery_and_rollback_are_bit_identical",
          resumed["artifact"]["weightsDigest"] == replay["artifact"]["weightsDigest"]
          and sha256(artifact_r2) == sha256(artifact_r3),
          "replaying --resume-from the retained step-40 checkpoint produced a bit-identical artifact (segment-r2 vs segment-r3)")

    payload = {
        "schema": "ragam-training-qualification-evidence/1",
        "scope": "local, pure-NumPy, from-scratch tiny language-model smoke training; NOT a Klyvaron Pro/Max foundation model, NOT adapter/LoRA training, NOT retrieval personalization",
        "worker": "services/fabric/scripts/train_lm.py -> fabric/lm/train.py (real parameter updates on CPU)",
        "hardware": {"platform": resumed["provenance"]["platform"], "machine": resumed["provenance"]["machine"], "numpy": resumed["provenance"]["numpy"], "python": resumed["provenance"]["python"], "accelerator": "none (CPU)"},
        "consent": {
            "confirmed": True,
            "basis": "Operator-initiated release qualification on the repository's own tracked text corpus; no user data, no private dataset, no external service, no paid API.",
            "datasetOwnership": "repository-owned tracked text files only",
            "datasetFingerprint": resumed["corpus"]["manifestDigest"],
            "purpose": "demonstrate real parameter updates, checkpointing, resume and evaluation mechanics",
            "limitations": "This does not constitute consent to train on user data or to publish a model. No user-owned dataset was ingested.",
        },
        "commands": [
            "AETHERIS_PYTHON=.venv/bin/python services/fabric/scripts/train_lm.py --corpus-root /home/user/ragam --run-name ragam-qualification --steps 10 ... --checkpoint-every 10 --keep-checkpoint --snapshot-text manifest",
            "timeout 1.5 .venv/bin/python services/fabric/scripts/train_lm.py --steps 120 --checkpoint-every 10 --keep-checkpoint  # interrupted at step 40 (exit 124)",
            ".venv/bin/python services/fabric/scripts/train_lm.py --steps 120 --resume-from <step-40 checkpoint>  # resumed and completed",
            ".venv/bin/python services/fabric/scripts/train_lm.py --steps 120 --resume-from <step-40 checkpoint>  # replay / rollback, bit-identical",
        ],
        "logs": [
            "docs/release/evidence/training-segment-a.log",
            "docs/release/evidence/training-interrupted.log",
            "docs/release/evidence/training-resumed.log",
            "docs/release/evidence/training-rollback.log",
        ],
        "results": results,
        "notTested": [
            "SIGTERM cancellation of the real NumPy trainer (the Core LocalTrainingWorkerManager cancellation path is contract-tested with a stub trainer in services/core/test/klyvaron-training-worker.test.mjs)",
            "Training on a user-owned private dataset (no such dataset was supplied or authorized)",
            "GPU/accelerator training (no GPU on this host)",
            "Klyvaron Pro/Max foundation or adapter training (no weights, no architecture installed)",
        ],
        "pass": sum(1 for r in results if r["status"] == "PASS"),
        "fail": sum(1 for r in results if r["status"] == "FAIL"),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    for row in results:
        print(f"{row['status']}  {row['id']} — {row['detail']}")
    print(f"\n{payload['pass']} PASS, {payload['fail']} FAIL — {OUT.relative_to(ROOT)}")
    return 1 if payload["fail"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
