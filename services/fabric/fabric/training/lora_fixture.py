"""A NumPy LoRA adapter on a frozen linear classifier: a test vehicle, not a model.

This exists so the remote-training pipeline (contract, checkpoints, resume,
baseline, acceptance decision, artifact hashing, run record) can be exercised end to
end on a laptop with no GPU and no network. The task is synthetic, the base is a
linear softmax classifier trained on a source distribution in this file, and the
adapter is a standard LoRA update ``W = W0 + (alpha/r) * A @ B`` with ``A`` random and
``B`` zero at initialisation.

Two conditions, both fixed before any run was looked at:

* ``improves``   the target labels contain a rank-2 shift that the adapter can learn.
                 A correct pipeline should accept this run.
* ``no_signal``  the target labels are uniform noise. A correct pipeline should
                 measure no gain and refuse to call the adapter a candidate.

Nothing here says anything about Klyvaron quality. The point is that the gate
behaves correctly in both directions, and that a resumed run is bit-identical to an
uninterrupted one.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
from pathlib import Path

import numpy as np

from fabric.run import RunRecord
from fabric.training.checkpoint import CheckpointStore
from fabric.training.runner import run_job

DIM = 16
CLASSES = 4
TRUE_SHIFT_RANK = 2
SOURCE_TRAIN = 800
TARGET_TRAIN = 800
EVAL_EXAMPLES = 300
LABEL_NOISE = 0.3
SHIFT_SCALE = 1.0
CONDITIONS = ("improves", "no_signal")
BASE_ID = "fixture/synthetic-source-linear"
DATASET_ID = "fixture/synthetic-target-shift"


def _log_softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=1, keepdims=True)
    return shifted - np.log(np.exp(shifted).sum(axis=1, keepdims=True))


def lora_gradients(W0, A, B, scale, X, y):
    """Loss and gradients of mean cross-entropy with respect to the LoRA factors.

    Derived by hand: with ``Z = X W0 + s (X A) B`` and ``G = (softmax(Z) - onehot) / N``,
    ``dB = s (X A)^T G`` and ``dA = s X^T (G B^T)``. The test suite checks these against
    finite differences, so a sign or transpose error cannot pass silently.
    """
    n = len(y)
    logits = X @ W0 + scale * (X @ A) @ B
    log_p = _log_softmax(logits)
    loss = -float(np.mean(log_p[np.arange(n), y]))
    G = np.exp(log_p)
    G[np.arange(n), y] -= 1.0
    G /= n
    dB = scale * (X @ A).T @ G
    dA = scale * X.T @ (G @ B.T)
    return loss, dA, dB


def _pretrain_base(X: np.ndarray, y: np.ndarray, steps: int = 300, lr: float = 0.5) -> np.ndarray:
    """Full-batch softmax regression on the source distribution. Deterministic."""
    W = np.zeros((DIM, CLASSES))
    for _ in range(steps):
        log_p = _log_softmax(X @ W)
        G = np.exp(log_p)
        G[np.arange(len(y)), y] -= 1.0
        W -= lr * (X.T @ (G / len(y)))
    return W


def make_splits(condition: str, seed: int = 0) -> dict:
    if condition not in CONDITIONS:
        raise ValueError(f"unknown condition {condition!r}; choose from {CONDITIONS}")
    rng = np.random.default_rng(seed)
    S = rng.normal(0.0, 1.0, (DIM, CLASSES))
    U = rng.normal(0.0, 1.0, (DIM, TRUE_SHIFT_RANK))
    V = rng.normal(0.0, 1.0, (CLASSES, TRUE_SHIFT_RANK))
    T = S + SHIFT_SCALE * (U @ V.T)

    def draw(n: int, M: np.ndarray | None):
        X = rng.normal(0.0, 1.0, (n, DIM))
        if M is None:
            y = rng.integers(0, CLASSES, n)
        else:
            y = np.argmax(X @ M + LABEL_NOISE * rng.normal(0.0, 1.0, (n, CLASSES)), axis=1)
        return X, y

    source_X, source_y = draw(SOURCE_TRAIN, S)
    source_eval_X, source_eval_y = draw(EVAL_EXAMPLES, S)
    target_map = None if condition == "no_signal" else T
    train_X, train_y = draw(TARGET_TRAIN, target_map)
    val_X, val_y = draw(EVAL_EXAMPLES, target_map)

    digest = hashlib.sha256()
    for array in (train_X, train_y, val_X, val_y, source_eval_X, source_eval_y):
        digest.update(np.ascontiguousarray(array).tobytes())
    return {
        "train": (train_X, train_y),
        "validation": (val_X, val_y),
        "source-retention": (source_eval_X, source_eval_y),
        "source_train": (source_X, source_y),
        "digest": digest.hexdigest(),
    }


def _pack(arrays: dict) -> bytes:
    """Deterministic serialisation: no timestamps, unlike ``np.savez``'s zip headers."""
    names = sorted(arrays)
    out = io.BytesIO()
    header = json.dumps(names).encode("utf-8")
    out.write(len(header).to_bytes(8, "big"))
    out.write(header)
    for name in names:
        buffer = io.BytesIO()
        np.save(buffer, np.asarray(arrays[name]), allow_pickle=False)
        data = buffer.getvalue()
        out.write(len(data).to_bytes(8, "big"))
        out.write(data)
    return out.getvalue()


def _unpack(payload: bytes) -> dict:
    stream = io.BytesIO(payload)
    size = int.from_bytes(stream.read(8), "big")
    names = json.loads(stream.read(size).decode("utf-8"))
    arrays = {}
    for name in names:
        size = int.from_bytes(stream.read(8), "big")
        arrays[name] = np.load(io.BytesIO(stream.read(size)), allow_pickle=False)
    return arrays


class FixtureLoRA:
    """The ``Trainer`` for the fixture. Implements the five methods of ``runner.Trainer``."""

    def __init__(self, condition: str, *, seed: int = 0, rank: int = 2, alpha: float = 4.0,
                 learning_rate: float = 0.05, batch_size: int = 64, model_seed: int = 0):
        self.condition = condition
        self.splits = make_splits(condition, seed)
        self.dataset_digest = self.splits["digest"]
        source_X, source_y = self.splits["source_train"]
        self.W0 = _pretrain_base(source_X, source_y)  # frozen from here on
        self.rank = rank
        self.scale = alpha / rank
        self.learning_rate = learning_rate
        self.batch_size = batch_size
        self.data_seed = seed
        rng = np.random.default_rng(model_seed)
        self.A = rng.normal(0.0, 1.0 / np.sqrt(DIM), (DIM, rank))
        self.B = np.zeros((rank, CLASSES))
        self.moments = {name: (np.zeros_like(p), np.zeros_like(p)) for name, p in self._params().items()}
        self.t = 0

    def _params(self) -> dict:
        return {"A": self.A, "B": self.B}

    def _logits(self, X: np.ndarray) -> np.ndarray:
        return X @ self.W0 + self.scale * (X @ self.A) @ self.B

    def evaluate(self, split: str) -> dict:
        X, y = self.splits[split]
        log_p = _log_softmax(self._logits(X))
        loss = -float(np.mean(log_p[np.arange(len(y)), y]))
        accuracy = float(np.mean(np.argmax(log_p, axis=1) == y))
        return {"loss": loss, "accuracy": accuracy, "examples": int(len(y))}

    def train_step(self, step: int) -> float:
        X, y = self.splits["train"]
        # The batch depends on (seed, step) and nothing else, so a resumed run draws the
        # same batch the uninterrupted run would have drawn at that step.
        idx = np.random.default_rng([self.data_seed, step]).choice(len(y), size=self.batch_size, replace=False)
        loss, dA, dB = lora_gradients(self.W0, self.A, self.B, self.scale, X[idx], y[idx])
        self.t += 1
        for name, grad in (("A", dA), ("B", dB)):
            param = getattr(self, name)
            m, v = self.moments[name]
            m[...] = 0.9 * m + 0.1 * grad
            v[...] = 0.999 * v + 0.001 * grad * grad
            m_hat = m / (1.0 - 0.9**self.t)
            v_hat = v / (1.0 - 0.999**self.t)
            param -= self.learning_rate * m_hat / (np.sqrt(v_hat) + 1e-8)
        return loss

    def state_files(self) -> dict:
        arrays = {"A": self.A, "B": self.B, "t": np.array(self.t)}
        for name, (m, v) in self.moments.items():
            arrays[f"m{name}"] = m
            arrays[f"v{name}"] = v
        return {"lora-state.bin": _pack(arrays)}

    def load_state_files(self, files) -> None:
        arrays = _unpack(files["lora-state.bin"])
        self.A = np.array(arrays["A"], dtype=np.float64)
        self.B = np.array(arrays["B"], dtype=np.float64)
        self.t = int(arrays["t"])
        self.moments = {
            "A": (np.array(arrays["mA"], dtype=np.float64), np.array(arrays["vA"], dtype=np.float64)),
            "B": (np.array(arrays["mB"], dtype=np.float64), np.array(arrays["vB"], dtype=np.float64)),
        }

    def export_artifact(self, directory: Path) -> list:
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        np.save(directory / "lora_A.npy", self.A)
        np.save(directory / "lora_B.npy", self.B)
        config = {
            "format": "aetheris-fixture-adapter/1",
            "rank": self.rank,
            "scale": self.scale,
            "inputDim": DIM,
            "outputDim": CLASSES,
            "frozenBase": BASE_ID,
            "note": "Synthetic fixture. Not a Klyvaron model; not a release candidate.",
        }
        (directory / "adapter_config.json").write_text(
            json.dumps(config, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        return ["lora_A.npy", "lora_B.npy", "adapter_config.json"]


def fixture_job(condition: str, *, dataset_digest: str, checkpoint_root: Path, log_dir: Path) -> dict:
    """A valid job for the fixture. Built here, so the fixture obeys the same contract."""
    return {
        "schema": "aetheris-training-job/1",
        "jobId": f"fixture-lora-{condition.replace('_', '-')}",
        "tier": "experiment",
        "purpose": "Exercise the remote-training pipeline on a synthetic task. Not a Klyvaron model.",
        "base": {
            "id": BASE_ID,
            "kind": "fixture",
            "revision": "fixture",
            "licence": "MIT",
        },
        "dataset": {
            "id": DATASET_ID,
            "version": "1",
            "provenance": "generated_locally",
            "licence": "MIT",
            "contentsDescription": "Gaussian features; labels from a linear map with noise, or uniform for no_signal.",
            "containsPersonalData": False,
            "train": {"file": "in-memory", "sha256": dataset_digest, "examples": TARGET_TRAIN},
            "validation": {"file": "in-memory", "sha256": dataset_digest, "examples": EVAL_EXAMPLES},
            "regression": [
                {"name": "source-retention", "file": "in-memory", "sha256": dataset_digest,
                 "examples": EVAL_EXAMPLES}
            ],
        },
        "training": {
            "method": "lora",
            "rank": 2,
            "alpha": 4,
            "dropout": 0.0,
            "targetModules": ["head"],
            "learningRate": 0.05,
            "steps": 300,
            "batchSize": 64,
            "seqLen": 1,
            "seed": 0,
        },
        "resources": {
            "accelerator": "cpu",
            "expectedHours": 0.01,
            "maxSessionHours": 1,
            "storageGb": 0.01,
        },
        "checkpoint": {
            "everySteps": 50,
            "keepLast": 3,
            "storageKind": "local_disk",
            "path": str(checkpoint_root),
        },
        "validation": {
            "baselineName": "frozen-base",
            "minImprovement": 0.05,
            "minAccuracyGain": 0.0,
            "regressionSets": ["source-retention"],
            "regressionTolerance": 0.05,
        },
        "output": {"name": "fixture-lora", "version": "0.0.1-fixture.1"},
        "logs": {"storageKind": "local_disk", "path": str(log_dir)},
        "resume": {
            "instructions": "Run the same command again with the same --checkpoints directory. "
                            "The newest verified checkpoint is loaded and training continues from its step."
        },
    }


def run_fixture(condition: str, out_dir: str | Path, *, checkpoint_root: str | Path | None = None,
                stop_after: int | None = None) -> RunRecord:
    out = Path(out_dir)
    trainer = FixtureLoRA(condition)
    job = fixture_job(
        condition,
        dataset_digest=trainer.dataset_digest,
        checkpoint_root=Path(checkpoint_root) if checkpoint_root else out / "checkpoints",
        log_dir=out,
    )
    return run_job(
        job,
        trainer,
        checkpoints=CheckpointStore(Path(checkpoint_root) if checkpoint_root else out / "checkpoints"),
        out_dir=out,
        stop_after=stop_after,
        run_id=f"fixture-{condition}",
    )


def main(argv: list | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the synthetic LoRA fixture through the pipeline.")
    parser.add_argument("--condition", choices=CONDITIONS, required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--checkpoints", default=None)
    parser.add_argument("--stop-after", type=int, default=None,
                        help="simulate a session ending before this step is checkpointed")
    args = parser.parse_args(argv)
    record = run_fixture(args.condition, args.out, checkpoint_root=args.checkpoints, stop_after=args.stop_after)
    summary = {
        "status": record.status,
        "error": record.error,
        "decision": record.results.get("decision"),
        "baseline": record.results.get("baseline"),
        "final": record.results.get("final"),
        "adapterDigest": (record.artifacts.get("adapter") or {}).get("digest"),
        "runRecord": str(Path(args.out) / "run-record.json"),
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
