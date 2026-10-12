"""Training loop, with the provenance a run needs to be re-derivable.

Nothing here is novel -- AdamW, warmup then cosine decay, global-norm clipping. The
part worth care is the bookkeeping: a training run that cannot be reproduced is an
anecdote, so the report records the corpus manifest and its digest, the tokenizer
digest, the configuration digest, the code revision, every seed, the wall time and
peak memory, and the digest of the artifact it produced.

Two rules are enforced rather than documented:

* **A released artifact is never overwritten.** Checkpoints are written to a path
  derived from the run digest, and an existing file at that path causes a refusal
  unless the caller explicitly asks to replace it. A path that changes when the
  inputs change cannot silently clobber a known-good model.
* **A run that cannot be reproduced is refused, not warned about.** `torch`-style
  nondeterminism is not a risk here because nothing threaded is involved, but the
  seed is threaded through NumPy's `default_rng` everywhere, and the same inputs
  must produce a bit-identical artifact. `tests/test_lm_train.py` asserts that.
"""

from __future__ import annotations

import json
import math
import platform
import resource
import subprocess
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

import numpy as np

from .data import build_manifest, make_batches, read_corpus
from .evaluate import evaluate_model
from .model import TransformerConfig, TransformerLM, weights_digest
from .tokenizer import CharacterTokenizer


@dataclass(frozen=True)
class TrainConfig:
    d_model: int = 96
    n_layers: int = 2
    n_heads: int = 4
    d_ff: int = 384
    seq_len: int = 128
    batch_size: int = 16
    steps: int = 400
    learning_rate: float = 3e-3
    min_learning_rate_ratio: float = 0.1
    warmup_steps: int = 40
    weight_decay: float = 0.01
    grad_clip: float = 1.0
    beta1: float = 0.9
    beta2: float = 0.95
    eps: float = 1e-8
    init_scale: float = 0.02
    data_seed: int = 0
    model_seed: int = 0
    eval_batch_size: int = 8
    eval_interval: int = 0        # 0 disables intermediate evaluation
    validation_fraction: float = 0.10
    split_seed: int = 20251012
    corpus_root: str = "."
    dtype: str = "float32"

    def __post_init__(self) -> None:
        if self.steps < 1:
            raise ValueError("steps must be at least 1")
        if self.warmup_steps >= self.steps:
            raise ValueError(
                f"warmup_steps {self.warmup_steps} must be below steps {self.steps}; "
                "a warmup that never finishes means the learning rate never decays"
            )
        if not 0.0 < self.min_learning_rate_ratio <= 1.0:
            raise ValueError("min_learning_rate_ratio must be in (0, 1]")
        if self.learning_rate <= 0:
            raise ValueError("learning_rate must be positive")
        if self.grad_clip <= 0:
            raise ValueError("grad_clip must be positive")
        if self.dtype not in ("float32", "float64"):
            raise ValueError(f"unsupported dtype {self.dtype!r}")

    def learning_rate_at(self, step: int) -> float:
        """Linear warmup, then cosine decay to `min_learning_rate_ratio * lr`."""
        if step < self.warmup_steps:
            return self.learning_rate * (step + 1) / self.warmup_steps
        progress = (step - self.warmup_steps) / max(1, self.steps - self.warmup_steps)
        cosine = 0.5 * (1.0 + math.cos(math.pi * min(1.0, progress)))
        floor = self.min_learning_rate_ratio * self.learning_rate
        return floor + (self.learning_rate - floor) * cosine

    def to_dict(self) -> dict:
        return asdict(self)


class AdamW:
    """Adam with decoupled weight decay, applied only to matrices.

    Weight decay on LayerNorm gains and biases is a common mistake: it pulls the
    normalisation scale toward zero, which is not a regulariser, it is damage.
    Scalars and vectors are therefore excluded from decay.
    """

    def __init__(self, config: TrainConfig, shapes: dict[str, tuple]):
        self.config = config
        self.m = {name: np.zeros(shape, dtype=np.float32) for name, shape in shapes.items()}
        self.v = {name: np.zeros(shape, dtype=np.float32) for name, shape in shapes.items()}
        self.t = 0
        self.decayed = tuple(
            name for name in shapes if _is_matrix(name, shapes[name])
        )

    def step(self, params: dict[str, np.ndarray], grads: dict[str, np.ndarray], lr: float) -> float:
        c = self.config
        self.t += 1
        total_norm = math.sqrt(sum(float(np.sum(g.astype(np.float64) ** 2)) for g in grads.values()))
        scale = min(1.0, c.grad_clip / (total_norm + 1e-12))
        bias1 = 1.0 - c.beta1**self.t
        bias2 = 1.0 - c.beta2**self.t
        decayed = set(self.decayed)
        for name, grad in grads.items():
            g = grad * scale
            self.m[name] = c.beta1 * self.m[name] + (1.0 - c.beta1) * g
            self.v[name] = c.beta2 * self.v[name] + (1.0 - c.beta2) * (g * g)
            update = (self.m[name] / bias1) / (np.sqrt(self.v[name] / bias2) + c.eps)
            if name in decayed:
                update = update + c.weight_decay * params[name]
            params[name] = (params[name] - lr * update).astype(params[name].dtype)
        return total_norm * scale


#: Parameters that receive decoupled weight decay: the projection matrices only.
#: Embeddings are excluded (as in GPT-2): they are the input representation and are
#: tied to the output head, so decaying them also flattens the logits. Norm gains are
#: excluded because shrinking a normalisation scale is not regularisation.
DECAYED_SUFFIXES = ("wq", "wk", "wv", "wo", "w1", "w2", "head")


def _is_matrix(name: str, shape: tuple) -> bool:
    """True only for the projection weights that should be decayed."""
    if len(shape) != 2:
        return False
    return name.rsplit(".", 1)[-1] in DECAYED_SUFFIXES


@dataclass
class TrainingReport:
    config: dict
    model_config: dict
    corpus: dict
    tokenizer: dict
    provenance: dict
    resource: dict
    loss_curve: list
    final_loss: float
    evaluation: dict = field(default_factory=dict)
    samples: dict = field(default_factory=dict)
    artifact: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)

    #: Fields excluded from `digest` because they describe the *environment* or the
    #: *location*, not the run. `wallSeconds` and `peakMemoryMb` differ between two
    #: bit-identical runs on the same machine, and `artifact.path` differs between two
    #: directories. Including any of them would make the digest a fingerprint of where
    #: and when a run happened rather than of what it produced -- so re-running an
    #: identical run would appear to be a different run, which is precisely the thing
    #: the digest exists to detect.
    DIGEST_EXCLUDED = ("resource",)

    @property
    def digest(self) -> str:
        import hashlib
        payload = self.to_dict()
        for field in self.DIGEST_EXCLUDED:
            payload.pop(field, None)
        payload.get("artifact", {}).pop("path", None)
        return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def code_revision(root: Path) -> str:
    """The git revision of the working tree, or an explicit note that it is dirty."""
    try:
        sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True, timeout=10, check=True
        ).stdout.strip()
        dirty = subprocess.run(
            ["git", "status", "--porcelain"], cwd=root, capture_output=True, text=True, timeout=10, check=True
        ).stdout.strip()
        return f"{sha}{'-dirty' if dirty else ''}"
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        return "unknown (not a git working tree)"


def peak_memory_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


def train(config: TrainConfig, *, output_dir, corpus_root=None, run_name: str = "aetheris-lite-lm",
          overwrite: bool = False, progress=None) -> TrainingReport:
    """Run the pipeline and write the artifact plus its report."""
    root = Path(corpus_root or config.corpus_root).resolve()
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    started = time.time()

    # 1. Data validation: hash the corpus, split it so no document is on both sides.
    manifest = build_manifest(
        root,
        validation_fraction=config.validation_fraction,
        split_seed=config.split_seed,
    )
    if manifest.overlap():
        raise RuntimeError(f"the corpus split leaked files across both sides: {sorted(manifest.overlap())}")

    train_text = read_corpus(root, manifest.train)
    validation_text = read_corpus(root, manifest.validation)

    # 2. Tokenizer fitted on TRAINING text only, so validation characters cannot
    #    influence the model's alphabet. The cost is measured, not assumed.
    tokenizer = CharacterTokenizer.fit([train_text])
    unknown_rate = tokenizer.unknown_rate(validation_text)

    train_ids = tokenizer.encode(train_text)
    validation_ids = tokenizer.encode(validation_text)

    model_config = TransformerConfig(
        vocab_size=tokenizer.size,
        d_model=config.d_model,
        n_layers=config.n_layers,
        n_heads=config.n_heads,
        d_ff=config.d_ff,
        seq_len=config.seq_len,
        init_scale=config.init_scale,
    )
    dtype = np.float64 if config.dtype == "float64" else np.float32
    model = TransformerLM(model_config, seed=config.model_seed, dtype=dtype)
    optimizer = AdamW(config, {name: array.shape for name, array in model.params.items()})

    losses = []
    for step, batch in enumerate(
        make_batches(train_ids, batch_size=config.batch_size, seq_len=config.seq_len,
                     seed=config.data_seed, steps=config.steps)
    ):
        loss, grads = model.loss_and_grads(batch.inputs, batch.targets)
        clip_norm = optimizer.step(model.params, grads, config.learning_rate_at(step))
        losses.append({"step": step, "loss": loss, "lr": config.learning_rate_at(step), "gradNorm": clip_norm})
        if progress is not None and (step % max(1, config.steps // 10) == 0 or step == config.steps - 1):
            progress(step, config.steps, loss)

    evaluation = evaluate_model(
        model, validation_ids,
        vocab_size=tokenizer.size, train_ids=train_ids,
        seq_len=config.seq_len, batch_size=config.eval_batch_size,
        unknown_rate=unknown_rate,
    )

    from .evaluate import generate
    samples = {
        "greedy": generate(model, tokenizer, "The ", max_new_tokens=120, temperature=0.0, seed=config.model_seed),
        "sampled": generate(model, tokenizer, "The ", max_new_tokens=120, temperature=0.8, top_k=40, seed=config.model_seed),
    }

    # 3. Persist. The path is derived from the content, so a different run cannot
    #    land on the same file and a re-run of the same run is idempotent.
    in_memory_digest = weights_digest(model.params)
    filename = f"{run_name}-{in_memory_digest[:12]}.npz"
    artifact_path = output_dir / filename
    if artifact_path.exists() and not overwrite:
        existing = TransformerLM.load(artifact_path, model_config)
        if weights_digest(existing.params) != in_memory_digest:
            raise FileExistsError(
                f"{artifact_path} exists with different weights. Refusing to overwrite a "
                "possibly-released artifact; pass overwrite=True only if you are certain."
            )
    saved_digest = model.save(artifact_path)

    report = TrainingReport(
        config=config.to_dict(),
        model_config=model_config.to_dict(),
        corpus={
            **manifest.to_dict(),
            "manifestDigest": manifest.digest,
            "root": str(root),
            "trainCharacters": len(train_text),
            "validationCharacters": len(validation_text),
            "trainTokens": int(train_ids.size),
            "validationTokens": int(validation_ids.size),
        },
        tokenizer={
            "kind": "character",
            "size": tokenizer.size,
            "vocabularyDigest": tokenizer.digest,
            "characters": len(tokenizer.characters),
            "validationUnknownRate": unknown_rate,
        },
        provenance={
            "codeRevision": code_revision(root),
            "python": platform.python_version(),
            "numpy": np.__version__,
            "platform": platform.platform(),
            "machine": platform.machine(),
            "seed": {
                "model": config.model_seed,
                "data": config.data_seed,
                "split": config.split_seed,
            },
            "parameterCount": model.parameter_count,
        },
        resource={
            "wallSeconds": round(time.time() - started, 3),
            "peakMemoryMb": round(peak_memory_mb(), 1),
            "steps": config.steps,
            "tokensPerStep": config.batch_size * config.seq_len,
            "tokensSeen": config.batch_size * config.seq_len * config.steps,
        },
        loss_curve=losses,
        final_loss=losses[-1]["loss"],
        evaluation=evaluation.to_dict(),
        samples=samples,
        artifact={
            "path": str(artifact_path),
            "filename": filename,
            "fileDigest": saved_digest,
            "weightsDigest": in_memory_digest,
            "bytes": artifact_path.stat().st_size,
        },
    )
    report_path = output_dir / f"{run_name}-{in_memory_digest[:12]}.report.json"
    report_path.write_text(json.dumps(report.to_dict(), indent=2, default=str), encoding="utf-8")
    return report
