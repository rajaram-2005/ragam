"""Corpus loading, a hashed dataset manifest, and a disjoint split.

The split is by **file**, not by position within a concatenated blob. Holding out
the last 10% of one long string works for prose and fails here: the corpus is source
code, so a byte offset can land mid-function and the validation text would be
near-duplicates of training text. Whole documents go to one side or the other, so
no file contributes to both, and the split is recorded as a list of paths rather
than as an offset -- an offset is not reproducible once a file is added or removed.

This mirrors the correction already made in `dataset.py`, where base selection ran on
the evaluation split. The same class of mistake -- a validation number that is not
actually held out -- is what this module exists to avoid.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

#: Text-like extensions. Deliberately excludes lockfiles and minified bundles:
#: they are machine-generated, huge, and would dominate the token budget while
#: teaching the model nothing transferable.
DEFAULT_EXTENSIONS = (".md", ".mjs", ".js", ".jsx", ".py", ".json", ".css", ".html", ".sh", ".yml")

DEFAULT_EXCLUDE_DIRS = (
    ".git", "node_modules", "dist", "__pycache__", ".aetheris-data", "build",
    ".pytest_cache", "coverage", ".venv", "venv",
)


@dataclass(frozen=True)
class CorpusFile:
    path: str          # repository-relative, POSIX separators
    bytes: int
    sha256: str

    def to_dict(self) -> dict:
        return {"path": self.path, "bytes": self.bytes, "sha256": self.sha256}


@dataclass(frozen=True)
class DatasetManifest:
    """What this model was trained on, in enough detail to re-derive it exactly."""

    train: tuple[CorpusFile, ...]
    validation: tuple[CorpusFile, ...]
    extensions: tuple[str, ...]
    exclude_dirs: tuple[str, ...]
    split_seed: int
    validation_fraction: float

    @property
    def train_bytes(self) -> int:
        return sum(f.bytes for f in self.train)

    @property
    def validation_bytes(self) -> int:
        return sum(f.bytes for f in self.validation)

    def overlap(self) -> set[str]:
        """Files appearing on both sides. Must always be empty."""
        return {f.path for f in self.train} & {f.path for f in self.validation}

    def to_dict(self) -> dict:
        return {
            "train": [f.to_dict() for f in self.train],
            "validation": [f.to_dict() for f in self.validation],
            "extensions": list(self.extensions),
            "excludeDirs": list(self.exclude_dirs),
            "splitSeed": self.split_seed,
            "validationFraction": self.validation_fraction,
            "trainBytes": self.train_bytes,
            "validationBytes": self.validation_bytes,
            "trainFiles": len(self.train),
            "validationFiles": len(self.validation),
        }

    @property
    def digest(self) -> str:
        payload = json.dumps(self.to_dict(), sort_keys=True)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def is_excluded(relative: Path, exclude_dirs) -> bool:
    """True if any path component is an excluded directory.

    Checked per component, not with a substring test: a substring test would drop
    `docs/distributed.md` for containing 'dist'.
    """
    return any(part in exclude_dirs for part in relative.parts)


def discover(root, *, extensions=DEFAULT_EXTENSIONS, exclude_dirs=DEFAULT_EXCLUDE_DIRS):
    """Deterministically list candidate corpus files under `root`.

    Sorted, so a run does not depend on filesystem iteration order.
    """
    root = Path(root)
    excluded = set(exclude_dirs)
    wanted = set(extensions)
    found = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if is_excluded(relative, excluded):
            continue
        if path.suffix not in wanted:
            continue
        # Generated artifacts and lockfiles: large, machine-written, no signal.
        if path.name.endswith(".min.js") or "lock" in path.name:
            continue
        found.append(relative)
    return found


def build_manifest(
    root,
    *,
    extensions=DEFAULT_EXTENSIONS,
    exclude_dirs=DEFAULT_EXCLUDE_DIRS,
    validation_fraction: float = 0.10,
    split_seed: int = 20251012,
) -> DatasetManifest:
    """Hash every file and partition them into disjoint train / validation sets."""
    if not 0.0 < validation_fraction < 1.0:
        raise ValueError(f"validation_fraction must be in (0, 1), got {validation_fraction}")
    root = Path(root)
    relatives = discover(root, extensions=extensions, exclude_dirs=exclude_dirs)
    if len(relatives) < 2:
        raise ValueError(f"need at least 2 corpus files to make a split, found {len(relatives)}")

    records = []
    for relative in relatives:
        raw = (root / relative).read_bytes()
        records.append(
            CorpusFile(path=relative.as_posix(), bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
        )

    # Shuffle by index with a seeded generator over the *sorted* list, so the split
    # depends on the seed and the file set only -- not on directory order.
    order = np.random.default_rng(split_seed).permutation(len(records))
    n_validation = max(1, int(round(len(records) * validation_fraction)))
    if n_validation >= len(records):
        raise ValueError("the validation fraction would consume the whole corpus")
    validation_idx = set(order[:n_validation].tolist())

    train = tuple(r for i, r in enumerate(records) if i not in validation_idx)
    validation = tuple(r for i, r in enumerate(records) if i in validation_idx)
    return DatasetManifest(
        train=train,
        validation=validation,
        extensions=tuple(extensions),
        exclude_dirs=tuple(exclude_dirs),
        split_seed=split_seed,
        validation_fraction=validation_fraction,
    )


def read_corpus(root, files) -> str:
    """Concatenate files with an explicit separator.

    The separator is not cosmetic. Without one, the tail of one file and the head of
    the next form sequences the model would memorise and wrongly treat as real, and
    a file boundary would be indistinguishable from ordinary text. An explicit marker
    makes boundaries learnable rather than accidental.
    """
    root = Path(root)
    parts = []
    for f in files:
        text = (root / f.path).read_text(encoding="utf-8", errors="replace")
        parts.append(f"\n<|file: {f.path}|>\n{text}")
    return "".join(parts)


@dataclass(frozen=True)
class Batch:
    inputs: np.ndarray   # (B, T) int32
    targets: np.ndarray  # (B, T) int32 -- inputs shifted left by one


def make_batches(ids: np.ndarray, *, batch_size: int, seq_len: int, seed: int, steps: int):
    """Yield deterministic next-token batches.

    Starts are drawn per step from a seeded generator, so the batch sequence is a
    function of (corpus, seed, steps) and two runs see identical data in identical
    order. Without that, a loss curve is not comparable between runs.
    """
    if len(ids) < seq_len + 2:
        raise ValueError(f"corpus of {len(ids)} tokens is too short for seq_len={seq_len}")
    rng = np.random.default_rng(seed)
    high = len(ids) - seq_len - 1
    for _ in range(steps):
        starts = rng.integers(0, high, size=batch_size)
        inputs = np.stack([ids[s : s + seq_len] for s in starts])
        targets = np.stack([ids[s + 1 : s + seq_len + 1] for s in starts])
        yield Batch(inputs=inputs.astype(np.int32), targets=targets.astype(np.int32))
