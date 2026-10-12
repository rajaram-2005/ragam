"""Character-level tokenizer.

Characters rather than bytes: the corpus is source code and prose where the alphabet
is small, so sequences stay short enough for a small model to learn anything from.

There is no learned tokenizer to reproduce -- the vocabulary is the sorted set of
characters in the *training* split, made explicit and hashed. Two runs on the same
corpus produce byte-identical vocabularies, which is the property that makes the
whole pipeline reproducible.

The vocabulary is fitted on training text only. Fitting it on the whole corpus would
let validation characters influence the model's input alphabet, which is a leak even
if a small one. The cost is that validation text may contain characters the model has
never seen; those map to `<unk>` and the rate is *measured and reported* rather than
assumed to be zero. That choice is deliberate: this corpus is code and mostly ASCII,
so the honest expectation is a near-zero rate, and a near-zero rate claimed without
measurement is just an unverified belief.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

import numpy as np

UNK_CHAR = "\ufffd"  # REPLACEMENT CHARACTER: a real character, so it cannot collide
UNK_ID = 0


@dataclass(frozen=True)
class CharacterTokenizer:
    """Maps characters to contiguous ids. Id 0 is always `<unk>`."""

    characters: tuple[str, ...]
    _index: dict[str, int] = field(default_factory=dict, repr=False, compare=False)

    def __post_init__(self) -> None:
        if not self.characters:
            raise ValueError("a tokenizer needs at least one character")
        if len(set(self.characters)) != len(self.characters):
            raise ValueError("the character list contains duplicates")
        if UNK_CHAR in self.characters:
            raise ValueError(
                f"{UNK_CHAR!r} is reserved for the unknown token; it must not appear in the vocabulary"
            )
        index = {ch: i + 1 for i, ch in enumerate(self.characters)}
        object.__setattr__(self, "_index", index)

    # -- construction ------------------------------------------------------

    @classmethod
    def fit(cls, texts, *, min_count: int = 1) -> "CharacterTokenizer":
        """Fit on an iterable of training strings, deterministically."""
        counts: dict[str, int] = {}
        for text in texts:
            for ch in text:
                counts[ch] = counts.get(ch, 0) + 1
        if not counts:
            raise ValueError("cannot fit a tokenizer on empty text")
        kept = sorted(ch for ch, n in counts.items() if n >= min_count and ch != UNK_CHAR)
        if not kept:
            raise ValueError(f"min_count={min_count} removed every character")
        return cls(characters=tuple(kept))

    # -- the vocabulary is data, so it must round-trip ----------------------

    def to_dict(self) -> dict:
        return {"kind": "character", "unkChar": UNK_CHAR, "characters": list(self.characters)}

    @classmethod
    def from_dict(cls, payload: dict) -> "CharacterTokenizer":
        if payload.get("kind") != "character":
            raise ValueError(f"not a character tokenizer payload: {payload.get('kind')!r}")
        return cls(characters=tuple(payload["characters"]))

    # -- conversions -------------------------------------------------------

    @property
    def size(self) -> int:
        """Vocabulary size including `<unk>`."""
        return len(self.characters) + 1

    def encode(self, text: str) -> np.ndarray:
        index = self._index
        return np.fromiter(
            (index.get(ch, UNK_ID) for ch in text), dtype=np.int32, count=len(text)
        )

    def decode(self, ids) -> str:
        chars = self.characters
        out = []
        for raw in np.asarray(ids).reshape(-1):
            i = int(raw)
            if i == UNK_ID:
                out.append(UNK_CHAR)
            elif 0 <= i <= len(chars):
                out.append(chars[i - 1])
            else:
                raise ValueError(f"id {i} is outside the vocabulary (size {self.size})")
        return "".join(out)

    def unknown_rate(self, text: str) -> float:
        """Fraction of characters in `text` that the vocabulary cannot represent."""
        if not text:
            return 0.0
        index = self._index
        missing = sum(1 for ch in text if ch not in index)
        return missing / len(text)

    # -- identity ----------------------------------------------------------

    @property
    def digest(self) -> str:
        """Stable hash of the vocabulary, so a run cannot silently change alphabet."""
        payload = json.dumps(self.to_dict(), sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def __len__(self) -> int:
        return self.size
