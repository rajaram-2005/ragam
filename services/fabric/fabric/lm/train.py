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

import hashlib
import json
import math
import platform
import resource
import subprocess
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

import numpy as np

from .data import DEFAULT_EXTENSIONS, build_manifest, make_batches, read_corpus
from .evaluate import evaluate_model
from .model import TransformerConfig, TransformerLM, weights_digest
from .bpe import ByteBPETokenizer
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
    #: Sources held out whole, by their first path component under the corpus root. With these
    #: set, the validation text comes from repositories the model was never trained on -- the
    #: stronger claim, and the one a released card should quote. Empty means the by-document
    #: split, which no single source decides.
    validation_sources: tuple[str, ...] = ()
    #: Which text files count as corpus. The default is the repository's own mix
    #: (data.DEFAULT_EXTENSIONS); an assembled corpus of public sources may hold other
    #: languages, and renaming a .ts file to .md to get it read would be a lie about the
    #: corpus. An empty tuple means "use the module default".
    extensions: tuple[str, ...] = ()
    #: Which tokenizer to fit on the training split. `character` is the default and is what the
    #: released artifacts were trained with; `byte-bpe` learns subword merges. The two produce
    #: different vocabularies, so this is part of the config digest rather than a run flag.
    tokenizer_kind: str = "character"
    #: Vocabulary size asked of the byte-BPE trainer. Unused by the character tokenizer, whose
    #: size is the alphabet it finds in the training text and cannot be chosen.
    vocab_size: int = 8192
    #: How much text the byte-BPE trainer samples. Merges converge long before the last byte:
    #: pairs worth a token are frequent by definition. Recorded, because it is a choice.
    tokenizer_sample_chars: int = 4_000_000

    def __post_init__(self) -> None:
        if self.tokenizer_kind not in ("character", "byte-bpe"):
            raise ValueError(f"unknown tokenizer_kind {self.tokenizer_kind!r}; expected 'character' or 'byte-bpe'")
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
    #: What checkpointing did, or None when the run did not checkpoint. A run that never wrote
    #: one and a run that wrote fourteen and finished look the same in the weights and not the
    #: same in the record, so the record says which it was.
    checkpoints: dict | None = None

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


def config_digest(config: TrainConfig) -> str:
    """A digest of everything that decides what the model is.

    Used to refuse a resume across configurations: weights from a d256 run loaded into a d320
    one are a shape error at best, and at worst -- same shapes, different layer count, different
    data -- a model that keeps training and produces a reported loss for a configuration it was
    never trained under.
    """
    return hashlib.sha256(
        json.dumps(config.to_dict(), sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def _checkpoint_path(output_dir, run_name: str, digest: str):
    return output_dir / f"{run_name}-{digest[:12]}.ckpt.npz"


def write_checkpoint(path, *, step, losses, total_wall, training_wall, config_digest_value, model,
                     optimizer) -> str:
    """Write the whole training state, so an interrupted run is not a lost run.

    Weights alone are not enough to continue: Adam's two moment estimates carry the state that
    makes step 9,000 behave differently from step 1, and loading weights without them restarts
    the optimiser -- a different model wearing the same numbers. The loss curve travels too, so
    a resumed run's report covers every step it actually took.
    """
    arrays = {f"w::{name}": np.asarray(array) for name, array in model.params.items()}
    arrays.update({f"m::{name}": value for name, value in optimizer.m.items()})
    arrays.update({f"v::{name}": value for name, value in optimizer.v.items()})
    meta = {
        "format": "aetheris-checkpoint/v1",
        "step": step,
        "optimizerSteps": optimizer.t,
        "losses": losses,
        # Two clocks, because a resumed run has two honest answers to "how long did this take":
        # the wall time of every process that worked on it, and the time actually spent stepping.
        "totalWallSeconds": total_wall,
        "trainingSeconds": training_wall,
        "configDigest": config_digest_value,
    }
    arrays["meta"] = np.frombuffer(json.dumps(meta).encode("utf-8"), dtype=np.uint8)
    # Written beside the real name and moved into place, so a crash in the middle of a checkpoint
    # cannot destroy the last good one -- the window it could be destroyed in is the exact window
    # a checkpoint exists for.
    staging = path.with_name(path.name + ".partial")
    # A file object, not a path: numpy appends `.npz` to a name that does not end in it, so
    # `savez_compressed("x.npz.partial")` writes `x.npz.partial.npz` and the move below then
    # fails with the checkpoint already written to a name nobody looks at.
    with open(staging, "wb") as handle:
        np.savez_compressed(handle, **arrays)
    staging.replace(path)
    return _file_digest(path)


def read_checkpoint(path) -> tuple[dict, dict]:
    """Read a checkpoint back as (meta, arrays-of-weights)."""
    with np.load(path, allow_pickle=False) as payload:
        meta = json.loads(bytes(payload["meta"].tolist()).decode("utf-8"))
        weights = {
            key[len("w::"):]: payload[key].copy() for key in payload.files if key.startswith("w::")
        }
    if meta.get("format") != "aetheris-checkpoint/v1":
        raise ValueError(f"{path} is not an aetheris training checkpoint")
    return meta, weights


def _file_digest(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_corpus_snapshot(path) -> tuple[str, str, dict]:
    """Read a run's corpus snapshot back as (train_text, validation_text, manifest).

    Snapshots exist because the corpus is this repository's own text: it changes
    whenever the repository does, which makes a released model irreproducible by
    re-running its command. This is the other half -- being able to feed the exact
    text of a past run back in, so a distillation or ablation experiment can be run
    against a teacher's own data even after the repository has moved on.
    """
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if payload.get("format") == "aetheris-corpus-manifest/v1":
        # Written for a corpus too large to copy. The text is identified -- every file's sha256
        # is here, and the sources are pinned -- but it is not carried, so this function, which
        # hands back text, cannot serve it. Saying so is the point: returning an empty string
        # would look like a corpus of zero bytes.
        raise ValueError(
            f"{path} records the corpus by digest, not by copy: it names every training and "
            f"validation file with its sha256 and carries no text. Re-assemble the corpus from "
            f"its sources and check it against that manifest, or use a run that wrote a full "
            f"snapshot (train.py --snapshot-text full)."
        )
    if payload.get("format") != "aetheris-corpus-snapshot/v1":
        raise ValueError(f"{path} is not an aetheris corpus snapshot")
    manifest = dict(payload["manifest"])
    manifest["digest"] = payload["manifestDigest"]
    return payload["train"], payload["validation"], manifest


def train(config: TrainConfig, *, output_dir, corpus_root=None, run_name: str = "aetheris-lite-lm",
          overwrite: bool = False, expect_manifest_digest: str | None = None,
          progress=None, log=None, snapshot_text: bool = True,
          checkpoint_every: int = 0, resume_from=None,
          keep_checkpoint: bool = False) -> TrainingReport:
    """Run the pipeline and write the artifact, its report and a corpus snapshot.

    `progress(step, total, loss)` is called once per training step. `log(message)` receives
    free-form lines -- currently the vocabulary fit, which happens before step 1 -- and is
    separate because a tokenizer that merges for a minute with a silent log looks like a hang.

    `snapshot_text=True` writes the corpus into the run's record, which is what makes a run
    replayable with no network and is the right default for this repository's own text. With
    `snapshot_text=False` the record keeps the manifest -- every file, its size and its sha256 --
    and no text, which is the only sane option for an assembled corpus of hundreds of megabytes:
    a 168 MB copy in the run directory is not a record anyone keeps, and pretending to keep it
    would put a field in the report naming a file that was thrown away.

    `checkpoint_every > 0` writes the full training state every N steps, and `resume_from`
    continues from such a file. Both exist because a long run on one machine is a run whose
    interruption is a matter of when: without them an eighteen-hour run that dies at hour
    seventeen has produced nothing, not even evidence of how far it got.

    `expect_manifest_digest` turns silent drift into a refusal. The model is trained on
    this repository's own text, so any added file changes the corpus and therefore the
    trained weights. Without this check, "reproduce the release" would re-run happily
    and produce a *different* model while reporting success.
    """
    root = Path(corpus_root or config.corpus_root).resolve()
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    started = time.time()

    # The revision is read here, beside the corpus, and not when the report is written at
    # the end. The corpus is this working tree's own text, so the pair (revision, corpus
    # digest) is the entire reproducibility claim -- and a revision read thirty-five
    # minutes later describes a tree the model may never have seen. Reading both at the
    # same moment is what makes "check out this revision and get this corpus" checkable
    # instead of merely stated.
    revision = code_revision(root)

    # 1. Data validation: hash the corpus, split it so no document is on both sides.
    manifest = build_manifest(
        root,
        extensions=config.extensions or DEFAULT_EXTENSIONS,
        validation_fraction=config.validation_fraction,
        split_seed=config.split_seed,
        validation_sources=config.validation_sources,
    )
    if manifest.overlap():
        raise RuntimeError(f"the corpus split leaked files across both sides: {sorted(manifest.overlap())}")

    if expect_manifest_digest and manifest.digest != expect_manifest_digest:
        raise RuntimeError(
            f"corpus drift: the manifest is {manifest.digest} but {expect_manifest_digest} was expected. "
            f"This corpus has {len(manifest.train)} train / {len(manifest.validation)} validation files. "
            "The model trains on this repository's own text, so it changes whenever the repository does. "
            "Train from the run's *.corpus.txt snapshot instead, or pass the digest of the corpus you mean."
        )

    train_text = read_corpus(root, manifest.train)
    validation_text = read_corpus(root, manifest.validation)

    # 2. Tokenizer fitted on TRAINING text only, so validation text cannot influence the
    #    model's vocabulary. The cost is measured, not assumed: for the character tokenizer
    #    that measurement is an unknown-token rate, and for byte-level BPE it is zero by
    #    construction because every byte is in the base alphabet.
    if config.tokenizer_kind == "byte-bpe":
        # `log` is free-form narration, not the per-step training callback: fitting a vocabulary
        # happens once, before there is a step counter to report against.
        tokenizer = ByteBPETokenizer.fit(
            [train_text],
            vocab_size=config.vocab_size,
            sample_chars=config.tokenizer_sample_chars,
            progress=log,
        )
    else:
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

    resumed = None
    losses = []
    prior_wall = 0.0          # wall time of the processes before this one, in seconds
    training_accum = 0.0      # stepping time accumulated before this process
    if resume_from is not None:
        meta, weights = read_checkpoint(resume_from)
        if meta["configDigest"] != config_digest(config):
            raise RuntimeError(
                f"the checkpoint at {resume_from} was written for a different configuration "
                f"({meta['configDigest'][:12]} against {config_digest(config)[:12]}). Resuming it "
                f"would train the model this command describes with the state of another one."
            )
        missing = set(model.params) ^ set(weights)
        if missing:
            raise RuntimeError(f"the checkpoint does not match the model's parameters: {sorted(missing)}")
        for name, array in weights.items():
            if array.shape != model.params[name].shape:
                raise RuntimeError(f"checkpoint parameter {name} has shape {array.shape}, model has {model.params[name].shape}")
            model.params[name] = array.astype(model.params[name].dtype)
        with np.load(resume_from, allow_pickle=False) as payload:
            optimizer.m = {key[len("m::"):]: payload[key].copy() for key in payload.files if key.startswith("m::")}
            optimizer.v = {key[len("v::"):]: payload[key].copy() for key in payload.files if key.startswith("v::")}
        optimizer.t = int(meta["optimizerSteps"])
        losses = list(meta["losses"])
        prior_wall = float(meta["totalWallSeconds"])
        training_accum = float(meta["trainingSeconds"])
        resumed = {"checkpoint": Path(resume_from).name, "step": int(meta["step"])}
        if log is not None:
            log(f"  resumed from {Path(resume_from).name} at step {meta['step']:,}; "
                f"{config.steps - meta['step']:,} steps remain")
        if meta["step"] >= config.steps:
            raise RuntimeError(
                f"the checkpoint is at step {meta['step']} and this run stops at {config.steps}; "
                f"there is nothing to continue"
            )

    checkpoint_path = (
        _checkpoint_path(output_dir, run_name, config_digest(config)) if checkpoint_every > 0 else None
    )
    checkpoint_dir = output_dir
    checkpoint_meta = {"every": checkpoint_every, "writtenSteps": [], "retained": False} if checkpoint_path else None
    segment_started = time.time()

    stream = make_batches(train_ids, batch_size=config.batch_size, seq_len=config.seq_len,
                          seed=config.data_seed, steps=config.steps)
    start_step = resumed["step"] if resumed else 0
    # The data stream is a seeded sequence of windows, so step k is reproducible by consuming the
    # k batches before it rather than by guessing where in the corpus the run had reached.
    for step, batch in enumerate(stream):
        if step < start_step:
            continue
        loss, grads = model.loss_and_grads(batch.inputs, batch.targets)
        clip_norm = optimizer.step(model.params, grads, config.learning_rate_at(step))
        losses.append({"step": step, "loss": loss, "lr": config.learning_rate_at(step), "gradNorm": clip_norm})
        if progress is not None and (step % max(1, config.steps // 10) == 0 or step == config.steps - 1):
            progress(step, config.steps, loss)
        if checkpoint_path is not None and ((step + 1) % checkpoint_every == 0 or step == config.steps - 1):
            write_checkpoint(
                checkpoint_path, step=step + 1, losses=losses,
                total_wall=prior_wall + (time.time() - started),
                training_wall=training_accum + (time.time() - segment_started),
                config_digest_value=config_digest(config), model=model, optimizer=optimizer,
            )
            checkpoint_meta["writtenSteps"].append(step + 1)

    evaluation = evaluate_model(
        model, validation_ids,
        vocab_size=tokenizer.size, train_ids=train_ids,
        seq_len=config.seq_len, batch_size=config.eval_batch_size,
        unknown_rate=unknown_rate,
        # The validation text is in hand, so the character count comes from the text itself
        # rather than from a per-token figure with `/ ln 2` quietly standing in for it.
        characters_evaluated=len(validation_text),
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

    # The corpus itself is written next to the weights. This closes a real hole found
    # by trying to retrain the released model: it is trained on THIS REPOSITORY's own
    # text, so every commit or added file changes the corpus, and "run the same command
    # to reproduce it" quietly stopped being true while still appearing to work. The
    # manifest digest alone does not help -- it proves the corpus changed, not what it
    # was. Storing the exact text makes a release reproducible indefinitely, and costs
    # about a megabyte in a directory that is already gitignored.
    if snapshot_text:
        snapshot_path = output_dir / f"{run_name}-{in_memory_digest[:12]}.corpus.json"
        snapshot_payload = {
            "format": "aetheris-corpus-snapshot/v1",
            "manifest": manifest.to_dict(),
            # The digest is computed from the manifest rather than stored in it, so it
            # has to be written down here or the snapshot could not identify itself.
            "manifestDigest": manifest.digest,
            "train": train_text,
            "validation": validation_text,
        }
    else:
        snapshot_path = output_dir / f"{run_name}-{in_memory_digest[:12]}.manifest.json"
        snapshot_payload = {
            "format": "aetheris-corpus-manifest/v1",
            "manifest": manifest.to_dict(),
            "manifestDigest": manifest.digest,
            "note": (
                "The corpus is identified here, not copied: every file is listed with its size and "
                "its sha256, and each source is pinned to the commit it was fetched at. That is "
                "enough to re-assemble the text and prove it is the same text. It is not enough to "
                "train from this file alone, which is why the report says which of the two records "
                "this run wrote."
            ),
        }
    snapshot_path.write_text(json.dumps(snapshot_payload), encoding="utf-8")
    snapshot_digest = _file_digest(snapshot_path)

    # The vocabulary is written next to the weights. For the character tokenizer this file is
    # a convenience -- the alphabet is derivable from the corpus snapshot -- but for a learned
    # one it is load-bearing: the merge list is what turns ids back into text, and weights
    # without it are a matrix of numbers with no meaning. Both kinds are written, so the loader
    # has one shape to handle rather than two.
    tokenizer_path = output_dir / f"{run_name}-{in_memory_digest[:12]}.tokenizer.json"
    tokenizer_path.write_text(
        json.dumps({"format": "aetheris-tokenizer/v1", **tokenizer.to_dict()}, sort_keys=True),
        encoding="utf-8",
    )
    tokenizer_digest = _file_digest(tokenizer_path)

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
            "kind": tokenizer.kind,
            "size": tokenizer.size,
            "vocabularyDigest": tokenizer.digest,
            "validationUnknownRate": unknown_rate,
            # Which fields describe the vocabulary depends on the kind, and the report says
            # which rather than filling both with zeros.
            **({"characters": len(tokenizer.characters)} if tokenizer.kind == "character" else {
                "merges": len(tokenizer.merges),
                "sampleChars": config.tokenizer_sample_chars,
            }),
            "tokenizerFile": tokenizer_path.name,
            "tokenizerFileDigest": tokenizer_digest,
        },
        provenance={
            "codeRevision": revision,
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
            # Null for a run that trained in one sitting. Named with its step otherwise, so a
            # card can say "trained in one process" or "resumed once at step 6,000" and be
            # repeating the record rather than remembering.
            "resumedFrom": resumed,
        },
        checkpoints=(
            {**checkpoint_meta, "path": checkpoint_path.name, "configDigest": config_digest(config)}
            if checkpoint_meta is not None else None
        ),
        resource={
            # `wallSeconds` is what the release gate measures and it means what it says: every
            # second of every process that worked on this artifact. `trainingSeconds` is the part
            # spent stepping, and the difference is the pipeline -- hashing the corpus,
            # tokenising it, evaluating, sampling. A resumed run reports the sum of its segments
            # rather than the age of the last one.
            "wallSeconds": round(prior_wall + (time.time() - started), 3),
            "trainingSeconds": round(training_accum + (time.time() - segment_started), 3),
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
            # The exact text this run trained on, so the model can be rebuilt even
            # after the repository has moved on.
            "corpusSnapshot": snapshot_path.name,
            "corpusSnapshotDigest": snapshot_digest,
            "corpusSnapshotFormat": snapshot_payload["format"],
        },
    )
    if checkpoint_path is not None and checkpoint_path.exists() and not keep_checkpoint:
        # The checkpoint has done its job once the artifact and the report exist: it is the same
        # weights plus optimizer state, and leaving it beside the release invites the mistake of
        # loading it as the release. The report says it is gone rather than naming it.
        #
        # `keep_checkpoint=True` is for a run that intends to continue later -- continuing needs
        # the Adam moments, which the artifact does not carry -- and for the test that has to
        # stand in for a process that was killed, since a kill leaves this file and nothing else.
        checkpoint_path.unlink()
        checkpoint_meta["retained"] = False
    elif checkpoint_path is not None:
        checkpoint_meta["retained"] = True

    report_path = output_dir / f"{run_name}-{in_memory_digest[:12]}.report.json"
    report_path.write_text(json.dumps(report.to_dict(), indent=2, default=str), encoding="utf-8")
    return report
