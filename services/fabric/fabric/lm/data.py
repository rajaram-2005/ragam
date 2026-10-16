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

# Directories that are never corpus. Every entry is either a dependency tree, a build
# output, or this project's own managed state -- none of it is source, and none of it is
# in Git, so a corpus that included any of it could not be reproduced from a revision.
#
# `artifacts` was the one that got through, and it was found by checking a run's corpus
# against `git check-ignore` rather than by reading this tuple: a previous run's
# *.report.json and its 2.7 MB corpus snapshot were being read back in as training text.
# That made the corpus unreproducible from any commit (the files are gitignored), put one
# model's entire training text into the next model's corpus twice over, and inflated every
# corpus figure the report states. A model trained on its own previous run's report is
# still a language model; it is just no longer the model the card describes.
#: Directories that are never corpus text. Two kinds are in here: **build output and checkouts**
#: (`node_modules`, `dist`, `build`) which are copies of text that has a source elsewhere, and
#: **environment or tooling directories** (`.pylibs`, `.cache`, `.mypy_cache`) which hold vendored
#: third-party code. The second kind matters more than it looks: a virtualenv dropped inside the
#: repository is thousands of `.py` files from libraries this project did not license and does not
#: cite, and a walk that reads them would produce a corpus whose record is wrong. `artifacts` is
#: here because a run writes its own corpus into it: a training run must never see a previous run.
DEFAULT_EXCLUDE_DIRS = (
    ".git", "node_modules", "dist", "__pycache__", ".aetheris-data", "build",
    ".pytest_cache", "coverage", ".venv", "venv", "artifacts",
    ".pylibs", "site-packages", ".cache", ".ruff_cache", ".mypy_cache", ".tox", ".nox",
    ".next", ".vite", ".svelte-kit", ".turbo", ".parcel-cache", ".arena", "out", "target",
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
    #: Sources held out whole. A source is the first path component under the corpus root, so a
    #: corpus assembled from several repositories can be evaluated on repositories it never read.
    #: Empty means the ordinary by-document split, which no source decides on its own.
    validation_sources: tuple[str, ...] = ()

    @property
    def train_bytes(self) -> int:
        return sum(f.bytes for f in self.train)

    @property
    def validation_bytes(self) -> int:
        return sum(f.bytes for f in self.validation)

    def source(self, record: CorpusFile) -> str:
        return record.path.split("/", 1)[0]

    def source_summary(self) -> dict:
        """Per-source bytes and the side each source landed on, for the run record."""
        summary: dict[str, dict] = {}
        for split, records in (("train", self.train), ("validation", self.validation)):
            for record in records:
                entry = summary.setdefault(self.source(record), {"bytes": 0, "files": 0, "splits": []})
                entry["bytes"] += record.bytes
                entry["files"] += 1
                if split not in entry["splits"]:
                    entry["splits"].append(split)
        return dict(sorted(summary.items()))

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
            "sources": self.source_summary(),
            "heldOutSources": list(self.validation_sources),
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
    validation_sources: tuple[str, ...] = (),
) -> DatasetManifest:
    """Hash every file and partition them into disjoint train / validation sets.

    Two ways to choose the validation side, and they make different claims:

    * by default, a seeded fraction of *documents* -- no document is split, but a source
      (a repository, say) can appear on both sides;
    * with `validation_sources`, whole sources -- the evaluation text then comes from
      repositories the model was never trained on, which is the stronger claim, and the
      only reason the weaker one is the default is that it needs no judgement about which
      source is representative.
    """
    if not 0.0 < validation_fraction < 1.0:
        raise ValueError(f"validation_fraction must be in (0, 1), got {validation_fraction}")
    root = Path(root)
    relatives = discover(root, extensions=extensions, exclude_dirs=exclude_dirs)
    if len(relatives) < 2:
        raise ValueError(f"need at least 2 corpus files to make a split, found {len(relatives)}")

    held_out = tuple(dict.fromkeys(validation_sources))
    if held_out:
        present = {relative.parts[0] for relative in relatives}
        unknown = sorted(set(held_out) - present)
        if unknown:
            raise ValueError(
                f"held-out sources {unknown} are not under the corpus root; a hold-out that "
                f"matches nothing would silently evaluate on training text. Present: {sorted(present)}"
            )
        keep = [relative for relative in relatives if relative.parts[0] not in set(held_out)]
        drop = [relative for relative in relatives if relative.parts[0] in set(held_out)]
        if not keep or not drop:
            raise ValueError("a held-out source set must leave both sides non-empty")
        test_relatives = set(drop)
    else:
        test_relatives = None

    records = []
    for relative in relatives:
        raw = (root / relative).read_bytes()
        records.append(
            CorpusFile(path=relative.as_posix(), bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
        )

    if test_relatives is not None:
        train = tuple(r for relative, r in zip(relatives, records) if relative not in test_relatives)
        validation = tuple(r for relative, r in zip(relatives, records) if relative in test_relatives)
    else:
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
        validation_sources=held_out,
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
