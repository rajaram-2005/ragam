"""Evaluation with real baselines.

A language-model perplexity on its own is an uninterpretable number. 3.0 could be
excellent or embarrassing depending on the corpus, and a small model trained from
scratch on 1.4 MB of source code has no hope of reaching the numbers a large
pretrained model reports. So every evaluation here is reported next to three
baselines computed on the *same* held-out tokens from the *same* training statistics:

* **uniform** -- `ln(V)`. The floor. A model that does not beat this has learned
  nothing at all about which token comes next.
* **unigram** -- token frequencies from the training split, add-`k` smoothed.
  Captures "which characters are common", nothing about order.
* **bigram** -- `P(next | prev)` from the training split, add-`k` smoothed. Captures
  adjacency. This is the baseline that matters: on a small corpus, order-1 statistics
  are strong, and a transformer that loses to a bigram table has not paid for itself.

The verdict is therefore `beats_bigram`, and it is computed rather than asserted. If
the model loses, that is the result and it is reported as one.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np


@dataclass(frozen=True)
class Baseline:
    name: str
    nll_nats_per_token: float
    description: str

    @property
    def perplexity(self) -> float:
        return float(math.exp(self.nll_nats_per_token))

    @property
    def bits_per_token(self) -> float:
        """Bits each predicted token costs. Was called "per character" while the only tokenizer
        was the character one and the two coincided; with a subword vocabulary they do not, and a
        baseline carries no character count to convert with."""
        return self.nll_nats_per_token / math.log(2.0)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "nllNatsPerToken": self.nll_nats_per_token,
            "perplexity": self.perplexity,
            "bitsPerToken": self.bits_per_token,
        }


def _cross_entropy(probabilities: np.ndarray) -> float:
    return float(-np.mean(np.log(np.maximum(probabilities, 1e-12))))


def uniform_baseline(vocab_size: int) -> Baseline:
    if vocab_size < 2:
        raise ValueError("vocab_size must be at least 2")
    return Baseline(
        name="uniform",
        nll_nats_per_token=math.log(vocab_size),
        description=f"every token equally likely, ln({vocab_size})",
    )


def unigram_baseline(train_ids: np.ndarray, eval_ids: np.ndarray, *, vocab_size: int, smoothing: float = 0.1) -> Baseline:
    """Token frequencies from training, applied position-independently."""
    if smoothing < 0:
        raise ValueError("smoothing must not be negative")
    counts = np.bincount(train_ids.astype(np.int64), minlength=vocab_size).astype(np.float64)
    probs = (counts + smoothing) / (counts.sum() + smoothing * vocab_size)
    return Baseline(
        name="unigram",
        nll_nats_per_token=_cross_entropy(probs[eval_ids.astype(np.int64)]),
        description=f"training-set token frequencies, add-{smoothing} smoothing, no context",
    )


def bigram_baseline(train_ids: np.ndarray, eval_ids: np.ndarray, *, vocab_size: int, smoothing: float = 0.1) -> Baseline:
    """P(next | prev) estimated from training adjacencies."""
    if len(train_ids) < 2:
        raise ValueError("the training stream is too short to estimate a bigram table")
    if smoothing < 0:
        raise ValueError("smoothing must not be negative")
    prev, nxt = train_ids[:-1].astype(np.int64), train_ids[1:].astype(np.int64)
    counts = np.zeros((vocab_size, vocab_size), dtype=np.float64)
    np.add.at(counts, (prev, nxt), 1.0)
    row_totals = counts.sum(axis=1, keepdims=True)
    counts += smoothing
    counts /= row_totals + smoothing * vocab_size

    prev_eval, next_eval = eval_ids[:-1].astype(np.int64), eval_ids[1:].astype(np.int64)
    return Baseline(
        name="bigram",
        nll_nats_per_token=_cross_entropy(counts[prev_eval, next_eval]),
        description=f"P(next|prev) from training adjacencies, add-{smoothing} smoothing",
    )


@dataclass
class EvaluationResult:
    nll_nats_per_token: float
    tokens_evaluated: int
    baselines: list[Baseline] = field(default_factory=list)
    unknown_rate: float = 0.0
    #: Characters the evaluated tokens stand for. Optional because a caller that only has ids
    #: cannot supply it -- and because without it there is no honest bits-per-character figure,
    #: only bits per token.
    characters_evaluated: int | None = None
    extra: dict = field(default_factory=dict)

    @property
    def perplexity(self) -> float:
        return float(math.exp(self.nll_nats_per_token))

    @property
    def bits_per_token(self) -> float:
        return self.nll_nats_per_token / math.log(2.0)

    @property
    def bits_per_character(self) -> float | None:
        """Total cost divided by characters, or None when the character count is unknown.

        This is *not* `nll / ln 2` generalised: with tokens shorter or longer than a character
        that quotient changes meaning, and averaging per-token costs per character is only the
        same number when the two counts agree.
        """
        if not self.characters_evaluated:
            return None
        return (self.nll_nats_per_token * self.tokens_evaluated / math.log(2.0)) / self.characters_evaluated

    @property
    def best_baseline(self) -> Baseline | None:
        return min(self.baselines, key=lambda b: b.nll_nats_per_token) if self.baselines else None

    @property
    def beats_all_baselines(self) -> bool:
        best = self.best_baseline
        return best is None or self.nll_nats_per_token < best.nll_nats_per_token

    def to_dict(self) -> dict:
        best = self.best_baseline
        return {
            "nllNatsPerToken": self.nll_nats_per_token,
            "perplexity": self.perplexity,
            "bitsPerToken": self.bits_per_token,
            "bitsPerCharacter": self.bits_per_character,
            "tokensEvaluated": self.tokens_evaluated,
            "charactersEvaluated": self.characters_evaluated,
            "unknownRate": self.unknown_rate,
            "baselines": [b.to_dict() for b in self.baselines],
            "bestBaseline": best.name if best else None,
            "perplexityVsBestBaseline": (
                self.perplexity / best.perplexity if best and best.perplexity > 0 else None
            ),
            "beatsAllBaselines": self.beats_all_baselines,
            **self.extra,
        }


def evaluate_model(
    model,
    eval_ids: np.ndarray,
    *,
    vocab_size: int,
    train_ids: np.ndarray | None = None,
    seq_len: int,
    batch_size: int = 8,
    unknown_rate: float = 0.0,
    characters_evaluated: int | None = None,
    with_baselines: bool = True,
) -> EvaluationResult:
    """Mean negative log-likelihood over the held-out stream, plus baselines.

    The loss is a *token-weighted mean over whole windows*, not the mean of per-batch
    means. With a token stream that is not a multiple of the window size the two
    differ, and the difference would make the reported number depend on `batch_size`
    -- a metric that moves when an unrelated setting moves is not a metric.
    """
    if len(eval_ids) <= seq_len + 1:
        raise ValueError(f"the held-out stream ({len(eval_ids)} tokens) is shorter than seq_len={seq_len}")
    starts = list(range(0, len(eval_ids) - seq_len - 1, seq_len))
    total_nll = 0.0
    total_tokens = 0
    # Windows are evaluated in batches. The accumulation is over *tokens*, so the
    # result is identical whether the windows are processed one at a time or in
    # groups -- batching is a speed change, not a measurement change.
    for offset in range(0, len(starts), batch_size):
        group = starts[offset : offset + batch_size]
        inputs = np.stack([eval_ids[start : start + seq_len] for start in group]).astype(np.int32)
        targets = np.stack([eval_ids[start + 1 : start + seq_len + 1] for start in group]).astype(np.int32)
        logits = model.forward(inputs)
        flat = logits.reshape(-1, vocab_size)
        flat = flat - flat.max(axis=-1, keepdims=True)
        shifted = np.exp(flat)
        probs = shifted / shifted.sum(axis=-1, keepdims=True)
        chosen = probs[np.arange(targets.size), targets.reshape(-1).astype(np.int64)]
        total_nll += float(-np.log(np.maximum(chosen, 1e-12)).sum())
        total_tokens += targets.size

    result = EvaluationResult(
        nll_nats_per_token=total_nll / total_tokens,
        tokens_evaluated=total_tokens,
        unknown_rate=unknown_rate,
        characters_evaluated=characters_evaluated,
    )
    if with_baselines:
        if train_ids is None:
            raise ValueError("baselines need the training token stream to be estimated from")
        result.baselines = [
            uniform_baseline(vocab_size),
            unigram_baseline(train_ids, eval_ids, vocab_size=vocab_size),
            bigram_baseline(train_ids, eval_ids, vocab_size=vocab_size),
        ]
    return result


def generate(model, tokenizer, prompt: str, *, max_new_tokens: int = 200, temperature: float = 0.8,
             top_k: int = 40, seed: int = 0) -> str:
    """Sample a continuation. Greedy at temperature 0.

    Deterministic given the seed, so a sample in a report can be reproduced exactly.
    """
    if max_new_tokens < 1:
        raise ValueError("max_new_tokens must be at least 1")
    if temperature < 0:
        raise ValueError("temperature must not be negative")
    rng = np.random.default_rng(seed)
    ids = list(tokenizer.encode(prompt)[-model.config.seq_len :])
    if not ids:
        raise ValueError("the prompt encodes to no tokens")
    out = []
    for _ in range(max_new_tokens):
        window = np.asarray(ids[-model.config.seq_len :], dtype=np.int32)[None, :]
        logits = model.forward(window)[0, -1]
        if temperature == 0:
            nxt = int(np.argmax(logits))
        else:
            logits = logits / temperature
            if top_k and top_k < logits.size:
                cutoff = np.sort(logits)[-top_k]
                logits = np.where(logits < cutoff, -np.inf, logits)
            shifted = np.exp(logits - logits.max())
            probs = shifted / shifted.sum()
            nxt = int(rng.choice(logits.size, p=probs))
        ids.append(nxt)
        out.append(nxt)
    return tokenizer.decode(out)
