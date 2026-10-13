"""Hybrid retrieval: fuse a lexical ranker with a dense one.

Why this exists
---------------
Measured on the benchmark in ``docs/07-improvement-cycle.md``, neither retriever
is best on every condition:

* the lexical (BM25) ranker has perfect ``recall@5`` on the ``high`` overlap
  condition, because the query reuses the document's own wording, but it ranks
  the judged answer poorly (mrr 0.7667);
* the dense retriever ranks better (mrr 0.8893) but **drops** ``recall@5`` to
  0.9167 there, because two held-out queries carry a topic term the vocabulary
  never saw, and an out-of-vocabulary token maps to an embedding that receives no
  gradient during training.

Fusing the two keeps the lexical ranker's recall and the dense ranker's ordering.
Neither half is modified, so both keep their measured behaviour on their own; the
combination is what is new.

How the fusion works
--------------------
Each ranker contributes a rank-based score: the document at position ``i`` of a
list of length ``n`` contributes ``weight * (1 - i / n)``. Weights are the only
knob, and they are interpretable as trust: ``0.5 / 0.5`` is equal trust in lexical
and dense evidence, chosen *a priori* rather than tuned.

Rank-based rather than score-based fusion is deliberate. BM25 scores are unbounded
and corpus-dependent; cosine similarities are bounded in ``[-1, 1]``. Summing them
directly would let whichever ranker happens to produce larger raw numbers dominate,
and the balance would drift with corpus size. Ranks are comparable by construction.

Ties are broken by document id so the output is deterministic: the same two
rankings always fuse to the same order, which is what lets an experiment ledger
entry be reproduced later.

This module is stdlib-only and does no I/O. It contains no retrieval logic of its
own — it only combines rankings it is given.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Sequence

__all__ = ["DEFAULT_WEIGHTS", "HybridRanker", "fuse_rankings", "rank_scores"]

#: Equal trust in lexical and dense evidence. Not tuned: see the module docstring.
DEFAULT_WEIGHTS: tuple[float, float] = (0.5, 0.5)


def rank_scores(ranking: Sequence[str], weight: float) -> dict[str, float]:
    """Rank-based scores for one ranking: ``weight * (1 - i / n)``.

    The document at position ``i`` of ``n`` scores ``weight * (1 - i/n)``, so the
    top document scores ``weight`` and the last scores ``weight / n``. Every listed
    document scores above zero, which means a document present in only one ranking
    still outranks a document never listed at all.

    An empty ranking contributes nothing rather than raising: a ranker that
    abstains should not veto the fusion.
    """
    if not ranking:
        return {}
    total = len(ranking)
    return {doc_id: weight * (1.0 - index / total) for index, doc_id in enumerate(ranking)}


def fuse_rankings(
    rankings: Sequence[Sequence[str]],
    weights: Sequence[float] | None = None,
    *,
    top_k: int | None = None,
) -> list[str]:
    """Fuse ranked lists into one, most relevant first.

    ``rankings`` and ``weights`` are positional pairs. ``top_k`` truncates the
    result; ``None`` returns every document any ranker listed.

    A document listed by several rankers sums their contributions, which is the
    whole point: agreement between an independent lexical and dense signal is
    stronger evidence than either alone.

    Raises ``ValueError`` if the weights are the wrong length, negative, or sum to
    zero — a fusion with no positive weight cannot rank anything, and silently
    returning an arbitrary order would be worse than refusing.
    """
    if weights is None:
        weights = [1.0] * len(rankings)
    if len(weights) != len(rankings):
        raise ValueError(f"got {len(rankings)} rankings but {len(weights)} weights")
    if any(weight < 0 for weight in weights):
        raise ValueError("weights must not be negative")
    if rankings and sum(weights) <= 0:
        raise ValueError("weights must sum to more than zero")

    combined: dict[str, float] = {}
    for ranking, weight in zip(rankings, weights):
        for doc_id, score in rank_scores(ranking, weight).items():
            combined[doc_id] = combined.get(doc_id, 0.0) + score

    ordered = sorted(combined.items(), key=lambda item: (-item[1], item[0]))
    fused = [doc_id for doc_id, _ in ordered]
    return fused[:top_k] if top_k is not None else fused


@dataclass
class HybridRanker:
    """A named lexical + dense pair, callable as a single ranking function.

    Wrapping the pair keeps the composition in one place: the experiment ledger
    compares ``HybridRanker`` against the two components it was built from, so the
    only difference between them is the fusion step.
    """

    lexical: Callable[[str], list[str]]
    dense: Callable[[str], list[str]]
    weights: tuple[float, float] = DEFAULT_WEIGHTS
    top_k: int | None = 10
    label: str = "hybrid(lexical+dense)"
    #: Recorded in the run record so a verdict can be traced to the exact settings.
    provenance: dict = field(default_factory=dict)

    def __call__(self, text: str) -> list[str]:
        return self.rank(text)

    def rank(self, text: str) -> list[str]:
        return fuse_rankings(
            [self.lexical(text), self.dense(text)],
            self.weights,
            top_k=self.top_k,
        )

    def components(self, text: str) -> dict[str, list[str]]:
        """What each half returned for one query — used when diagnosing a failure."""
        return {"lexical": list(self.lexical(text)), "dense": list(self.dense(text))}
