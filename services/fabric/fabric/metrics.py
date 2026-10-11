"""Retrieval evaluation metrics.

These replace the upstream scoring in ``sparsiz/training/evaluation/evaluation.py``,
which drew a benchmark score from ``random.uniform(0.5, 0.8)`` under the comment
"Mock evaluation — in production would run actual benchmarks". The *vocabulary*
(``BenchmarkCategory``) is adopted; the arithmetic is not. Everything here is
computed from an actual ranking of an actual corpus.

Conventions
-----------
* Document ids are opaque strings.
* ``relevant`` is a set of ids that answer the query (binary relevance), or a
  mapping id -> gain for graded relevance.
* A metric with no relevant documents for a query is *excluded* from the mean,
  not scored as zero. Averaging in undefined queries would let a benchmark be
  improved by adding unanswerable ones.
* Ties must already be broken deterministically by the ranker (see
  ``fabric.bm25``); these functions do not re-sort.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Mapping, Sequence

from .records import RecordMixin
from .taxonomy import BenchmarkCategory

__all__ = [
    "QueryResult",
    "EvaluationReport",
    "precision_at_k",
    "recall_at_k",
    "reciprocal_rank",
    "mrr",
    "ndcg_at_k",
    "hit_rate_at_k",
    "evaluate_ranker",
]


def _relevant_ids(relevant: Iterable[str] | Mapping[str, float]) -> set[str]:
    if isinstance(relevant, Mapping):
        return {doc_id for doc_id, gain in relevant.items() if gain > 0}
    return set(relevant)


def _gain(relevant: Iterable[str] | Mapping[str, float], doc_id: str) -> float:
    if isinstance(relevant, Mapping):
        return float(relevant.get(doc_id, 0.0))
    return 1.0 if doc_id in relevant else 0.0


def precision_at_k(ranked: Sequence[str], relevant: Iterable[str] | Mapping[str, float], k: int) -> float | None:
    """Fraction of the top-k that is relevant. ``None`` when the query has no answer."""
    ids = _relevant_ids(relevant)
    if not ids:
        return None
    if k <= 0:
        raise ValueError("k must be positive")
    window = list(ranked)[:k]
    if not window:
        return 0.0
    return sum(1 for doc_id in window if doc_id in ids) / len(window)


def recall_at_k(ranked: Sequence[str], relevant: Iterable[str] | Mapping[str, float], k: int) -> float | None:
    """Fraction of the relevant set recovered in the top-k."""
    ids = _relevant_ids(relevant)
    if not ids:
        return None
    if k <= 0:
        raise ValueError("k must be positive")
    window = set(list(ranked)[:k])
    return len(window & ids) / len(ids)


def reciprocal_rank(ranked: Sequence[str], relevant: Iterable[str] | Mapping[str, float]) -> float | None:
    """1 / rank of the first relevant document, or 0 if none was returned."""
    ids = _relevant_ids(relevant)
    if not ids:
        return None
    for position, doc_id in enumerate(ranked, start=1):
        if doc_id in ids:
            return 1.0 / position
    return 0.0


def hit_rate_at_k(ranked: Sequence[str], relevant: Iterable[str] | Mapping[str, float], k: int) -> float | None:
    """1 if any relevant document appears in the top-k, else 0."""
    ids = _relevant_ids(relevant)
    if not ids:
        return None
    return 1.0 if ids.intersection(list(ranked)[:k]) else 0.0


def ndcg_at_k(ranked: Sequence[str], relevant: Iterable[str] | Mapping[str, float], k: int) -> float | None:
    """Normalised discounted cumulative gain over the top-k.

    Handles graded relevance (``relevant`` as id -> gain) and binary relevance
    (a plain collection) with the same formula. The ideal ranking is computed
    from the full relevance judgement, so a corpus with more relevant documents
    than k is scored correctly rather than being allowed a perfect 1.0.
    """
    ids = _relevant_ids(relevant)
    if not ids:
        return None
    if k <= 0:
        raise ValueError("k must be positive")

    def dcg(gains: Sequence[float]) -> float:
        return sum(gain / math.log2(position + 1) for position, gain in enumerate(gains, start=1) if gain > 0)

    actual = dcg([_gain(relevant, doc_id) for doc_id in list(ranked)[:k]])
    ideal_gains = sorted((_gain(relevant, doc_id) for doc_id in ids), reverse=True)[:k]
    ideal = dcg(ideal_gains)
    if ideal <= 0:
        return 0.0
    return actual / ideal


def mrr(results: Iterable[float | None]) -> float:
    """Mean reciprocal rank over queries that have at least one relevant document."""
    values = [value for value in results if value is not None]
    return sum(values) / len(values) if values else 0.0


class QueryResult(RecordMixin):
    """Per-query metrics. A dict so it serialises straight into a run record."""


class EvaluationReport(RecordMixin):
    """Aggregated metrics plus the provenance needed to reproduce them."""

    def summary(self) -> str:
        parts = ", ".join(
            f"{name}={value:.4f}" for name, value in sorted(self["metrics"].items()) if isinstance(value, float)
        )
        return f"{self['category']}: {self['queries']} queries, {parts}"


def evaluate_ranker(
    queries: Sequence[Mapping],
    rank: Callable[[str], Sequence[str]],
    *,
    k_values: Sequence[int] = (1, 3, 5, 10),
    category: BenchmarkCategory = BenchmarkCategory.RETRIEVAL,
    corpus_size: int | None = None,
    index_stats: Mapping | None = None,
) -> EvaluationReport:
    """Evaluate a ranking function over a set of judged queries.

    ``queries`` is a sequence of ``{"id", "text", "relevant"}``. ``relevant`` may
    be a list of ids or a mapping id -> gain.

    The report records what was measured *and* what it was measured against, so a
    number in the experiment ledger can always be traced back to a corpus and a
    set of judgements rather than standing alone.
    """
    if not queries:
        raise ValueError("cannot evaluate a ranker against zero queries")
    for k in k_values:
        if k <= 0:
            raise ValueError("k must be positive")

    per_query: list[QueryResult] = []
    rr: list[float | None] = []
    aggregated: dict[str, list[float]] = {f"recall@{k}": [] for k in k_values}
    aggregated.update({f"precision@{k}": [] for k in k_values})
    aggregated.update({f"ndcg@{k}": [] for k in k_values})
    aggregated.update({f"hit@{k}": [] for k in k_values})
    skipped = 0

    for query in queries:
        text = query.get("text") or query.get("query") or ""
        relevant = query.get("relevant") or []
        ranked = list(rank(text))

        record = QueryResult(id=query.get("id"), text=text, ranked=ranked[: max(k_values)])
        value = reciprocal_rank(ranked, relevant)
        rr.append(value)
        record["reciprocalRank"] = value
        if value is None:
            # No relevance judgement: excluded from every mean, and counted so the
            # exclusion is visible rather than silent.
            skipped += 1
            record["skipped"] = "no relevant documents judged for this query"
            per_query.append(record)
            continue

        for k in k_values:
            for name, function in (
                (f"recall@{k}", recall_at_k),
                (f"precision@{k}", precision_at_k),
                (f"ndcg@{k}", ndcg_at_k),
                (f"hit@{k}", hit_rate_at_k),
            ):
                measured = function(ranked, relevant, k)
                record[name] = measured
                if measured is not None:
                    aggregated[name].append(measured)
        per_query.append(record)

    metrics = {name: (sum(values) / len(values) if values else 0.0) for name, values in aggregated.items()}
    metrics["mrr"] = mrr(rr)
    metrics["queriesScored"] = float(len(queries) - skipped)
    metrics["queriesSkipped"] = float(skipped)

    return EvaluationReport(
        category=category.value,
        queries=len(queries),
        scored=len(queries) - skipped,
        skipped=skipped,
        kValues=list(k_values),
        metrics=metrics,
        # Headline numbers, so a comparison cannot cherry-pick an obscure metric.
        headline={
            "mrr": metrics["mrr"],
            "recall@5": metrics.get("recall@5", 0.0),
            "ndcg@10": metrics.get("ndcg@10", 0.0),
        },
        corpusSize=corpus_size,
        indexStats=dict(index_stats) if index_stats else None,
        perQuery=per_query,
    )
