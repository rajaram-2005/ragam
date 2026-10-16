"""Byte-level BPE: a learned subword vocabulary, trained on the training split only.

The character tokenizer this sits beside (`tokenizer.py`) has one property that made it the
right choice for the first two artifacts and one that stops it being right for a larger one.
The good property is that its vocabulary is *derivable*: it is the set of characters in the
training text, so a corpus snapshot reproduces it exactly and there is no learned artifact to
lose. The bad property is that one character is one token, so a 256-token context buys 256
characters of context, and every parameter that could go into grammar goes into spelling.

This is the standard fix: **byte-level byte-pair encoding**, as used by GPT-2 and most models
since. The base vocabulary is the 256 byte values, and `merges` are learned pairs that combine
two symbols into a new one. Two consequences are worth stating at the top:

* **There are no unknown tokens.** Every byte of every input is representable, so
  `unknown_rate` is 0 by construction rather than by measurement. That is a different claim
  from the character tokenizer's measured near-zero rate, and the two must not be confused: a
  character tokenizer *can* fail to represent text, and reports how often; this one cannot.
* **The vocabulary is not derivable, so it must be stored.** Merges are a learned artifact:
  the released weights are meaningful only next to the exact merge list, so `to_dict()`/`from_dict()`
  serialise it and the run writes it beside the weights. Ids 0-255 are single bytes;
  id `256 + i` is the token created by `merges[i]`.

Training reads a *sample* of the training split rather than all of it, and says so. The merge
list converges long before the last byte: pairs that matter are frequent by definition, and a
tokenizer trained on 4 MB of a 220 MB corpus is the same tokenizer to within a few rare merges.
The alternative -- a full pass per merge over hundreds of megabytes, in pure Python -- would
cost more than the model's own training, which is a cost this project refuses to hide.

`fit()` is deterministic: the same sample produces the same merges, and the digest is a
property of the merge list alone, so two runs can be compared by one hash.
"""

from __future__ import annotations

import hashlib
import json
import re
from array import array
from collections import Counter
from dataclasses import dataclass
from heapq import heappop, heappush

import numpy as np

#: The pre-tokenisation pattern, from GPT-2. Splitting before merging is what keeps a merge from
#: crossing a word boundary: without it the tokenizer learns `" e"` and also `"e t"`, and the
#: vocabulary fills with fragments of phrases instead of words.
SPLIT_PATTERN = re.compile(r"""'s|'t|'re|'ve|'m|'ll|'d| ?\w+| ?[^\s\w]+|\s+(?!\S)|\s+""")

#: The base alphabet: every byte value, so nothing is unrepresentable.
BASE_VOCAB_SIZE = 256

#: How many entries the encode cache keeps before it is cleared. The cache turns repeated words
#: into dict lookups instead of merge loops, and would otherwise grow to millions of entries --
#: one per distinct word in a 220 MB corpus -- inside a process that also holds the corpus.
CACHE_LIMIT = 500_000


def sample_evenly(text: str, sample_chars: int, *, slices: int = 8) -> str:
    """Take `sample_chars` from `text` in evenly spaced slices.

    A prefix would be cheaper and worse: the corpus is a concatenation of files in sorted order,
    so a prefix is one source's text, and a tokenizer fitted on one source's idiom is a tokenizer
    that mishandles the others. Slices spread the sample across the whole corpus, and the sample
    is a deterministic function of the text and the size asked for.
    """
    if sample_chars <= 0:
        raise ValueError("sample_chars must be positive")
    if len(text) <= sample_chars:
        return text
    slices = max(1, min(slices, len(text) // max(1, sample_chars // slices or 1)))
    share = max(1, sample_chars // slices)
    step = len(text) // slices
    return "".join(text[i * step : i * step + share] for i in range(slices))


@dataclass(frozen=True)
class ByteBPETokenizer:
    """Byte-level BPE: ids 0-255 are bytes, ids 256+ are learned merges in order."""

    merges: tuple[tuple[int, int], ...]

    def __post_init__(self) -> None:
        rank = {}
        for i, pair in enumerate(self.merges):
            a, b = pair
            if not (0 <= a < BASE_VOCAB_SIZE + i and 0 <= b < BASE_VOCAB_SIZE + i):
                raise ValueError(f"merge {i} refers to an id that does not exist yet: {pair}")
            if pair in rank:
                raise ValueError(f"merge {pair} appears twice")
            rank[pair] = i
        object.__setattr__(self, "_rank", rank)
        # The bytes each token stands for, built in merge order: a merge's expansion is the
        # concatenation of its parts' expansions, and building them in order is what makes
        # `decode` a concatenation rather than a search.
        expansions: list[bytes] = [bytes([i]) for i in range(BASE_VOCAB_SIZE)]
        for a, b in self.merges:
            expansions.append(expansions[a] + expansions[b])
        object.__setattr__(self, "_expansions", tuple(expansions))

    # -- construction -------------------------------------------------------

    @classmethod
    def fit(
        cls,
        texts,
        *,
        vocab_size: int = 8192,
        sample_chars: int = 4_000_000,
        min_pair_count: int = 2,
        progress=None,
    ) -> "ByteBPETokenizer":
        """Learn merges from an iterable of training strings.

        `min_pair_count` stops the merge loop before it spends vocabulary on pairs that occurred
        once: a token for a single occurrence in the sample is a token that generalises to
        nothing. A run that stops early reports the vocabulary it actually has, which is why
        `size` is read from the tokenizer rather than assumed from the argument.
        """
        text = "".join(texts)
        if not text:
            raise ValueError("cannot fit a tokenizer on empty text")
        if vocab_size <= BASE_VOCAB_SIZE:
            raise ValueError(f"vocab_size must exceed {BASE_VOCAB_SIZE}, got {vocab_size}")
        budget = vocab_size - BASE_VOCAB_SIZE

        sample = sample_evenly(text, sample_chars)
        words = Counter(SPLIT_PATTERN.findall(sample))
        del text, sample
        if not words:
            raise ValueError("the sample produced no words to merge")
        if progress is not None:
            progress(f"  tokenizer: {len(words):,} distinct words in the sample")

        # `symbols[i]` is word i's current sequence of ids, `freq[i]` how often it occurred.
        # Keeping the words as lists of ids (not strings) is what makes the merges cheap.
        keys = list(words)
        freq = [words[k] for k in keys]
        del words
        symbols = [list(k.encode("utf-8")) for k in keys]
        del keys

        counts: dict[tuple[int, int], int] = {}
        holders: dict[tuple[int, int], set[int]] = {}
        for i, seq in enumerate(symbols):
            n = freq[i]
            for j in range(len(seq) - 1):
                pair = (seq[j], seq[j + 1])
                counts[pair] = counts.get(pair, 0) + n
                holders.setdefault(pair, set()).add(i)

        heap = [(-count, pair) for pair, count in counts.items()]
        heap.sort()
        merges: list[tuple[int, int]] = []

        while heap and len(merges) < budget:
            neg, pair = heappop(heap)
            if counts.get(pair) != -neg:
                continue  # a stale entry: the pair's count moved after it was pushed
            if -neg < min_pair_count:
                break
            new_id = BASE_VOCAB_SIZE + len(merges)
            merges.append(pair)
            a, b = pair
            for i in list(holders.get(pair, ())):
                seq = symbols[i]
                n = freq[i]
                # Remove this word's contribution under its old shape...
                for j in range(len(seq) - 1):
                    old = (seq[j], seq[j + 1])
                    counts[old] -= n
                    holders[old].discard(i)
                # ...merge every occurrence of the pair in it...
                merged: list[int] = []
                j = 0
                while j < len(seq):
                    if j < len(seq) - 1 and seq[j] == a and seq[j + 1] == b:
                        merged.append(new_id)
                        j += 2
                    else:
                        merged.append(seq[j])
                        j += 1
                # ...and add it back under the new one.
                for j in range(len(merged) - 1):
                    new_pair = (merged[j], merged[j + 1])
                    counts[new_pair] = counts.get(new_pair, 0) + n
                    holders.setdefault(new_pair, set()).add(i)
                    heappush(heap, (-counts[new_pair], new_pair))
                symbols[i] = merged
            holders.pop(pair, None)
            counts.pop(pair, None)
            if progress is not None and len(merges) % 1024 == 0:
                progress(f"  tokenizer: {len(merges)} merges, {len(counts):,} live pairs")

        return cls(merges=tuple(merges))

    # -- the vocabulary is data, so it must round-trip ----------------------

    def to_dict(self) -> dict:
        return {
            "kind": "byte-bpe",
            "baseVocabSize": BASE_VOCAB_SIZE,
            "merges": [[a, b] for a, b in self.merges],
        }

    @classmethod
    def from_dict(cls, payload: dict) -> "ByteBPETokenizer":
        if payload.get("kind") != "byte-bpe":
            raise ValueError(f"not a byte-BPE payload: {payload.get('kind')!r}")
        if payload.get("baseVocabSize", BASE_VOCAB_SIZE) != BASE_VOCAB_SIZE:
            raise ValueError("this tokenizer only knows the 256-byte base alphabet")
        return cls(merges=tuple((int(a), int(b)) for a, b in payload["merges"]))

    # -- conversions -------------------------------------------------------

    @property
    def size(self) -> int:
        return BASE_VOCAB_SIZE + len(self.merges)

    @property
    def kind(self) -> str:
        return "byte-bpe"

    def token_bytes(self, token_id: int) -> bytes:
        if not 0 <= token_id < self.size:
            raise ValueError(f"id {token_id} is outside the vocabulary (size {self.size})")
        return self._expansions[token_id]

    def _encode_word(self, data: bytes) -> list[int]:
        symbols = list(data)
        rank = self._rank
        while len(symbols) > 1:
            best_rank = -1
            best_at = -1
            for i in range(len(symbols) - 1):
                r = rank.get((symbols[i], symbols[i + 1]))
                if r is not None and (best_rank < 0 or r < best_rank):
                    best_rank = r
                    best_at = i
            if best_at < 0:
                break
            symbols[best_at : best_at + 2] = [BASE_VOCAB_SIZE + best_rank]
        return symbols

    def encode(self, text: str) -> np.ndarray:
        cache: dict[str, list[int]] = {}
        out = array("i")
        for match in SPLIT_PATTERN.finditer(text):
            word = match.group()
            ids = cache.get(word)
            if ids is None:
                if len(cache) >= CACHE_LIMIT:
                    cache.clear()
                ids = cache[word] = self._encode_word(word.encode("utf-8"))
            out.extend(ids)
        return np.frombuffer(out, dtype=np.int32).copy()

    def decode(self, ids) -> str:
        expansions = self._expansions
        chunks = []
        for raw in np.asarray(ids).reshape(-1):
            i = int(raw)
            if not 0 <= i < self.size:
                raise ValueError(f"id {i} is outside the vocabulary (size {self.size})")
            chunks.append(expansions[i])
        # errors="replace" rather than strict: a token *sequence* can be invalid UTF-8 even though
        # every token is valid bytes -- a byte-level model may emit half a multi-byte character --
        # and a caller inspecting a broken sequence wants the rest of it, not an exception.
        return b"".join(chunks).decode("utf-8", errors="replace")

    def unknown_rate(self, text: str) -> float:
        """Always 0.0: every byte value is in the vocabulary, so nothing is unrepresentable.

        Stated as a construction rather than a measurement. The character tokenizer's rate is a
        measurement because its vocabulary can genuinely lack a character.
        """
        del text
        return 0.0

    # -- identity ----------------------------------------------------------

    @property
    def digest(self) -> str:
        payload = json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def __len__(self) -> int:
        return self.size
