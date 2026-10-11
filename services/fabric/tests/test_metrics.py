"""Retrieval metrics must be exactly right — they are the accept/reject evidence."""

from __future__ import annotations

import math

import pytest

from fabric.metrics import (
    evaluate_ranker,
    hit_rate_at_k,
    mrr,
    ndcg_at_k,
    precision_at_k,
    recall_at_k,
    reciprocal_rank,
)
from fabric.taxonomy import BenchmarkCategory


def test_precision_and_recall_at_k():
    ranked = ["a", "b", "c", "d"]
    relevant = {"a", "c", "z"}
    assert precision_at_k(ranked, relevant, 2) == 0.5      # a yes, b no
    assert precision_at_k(ranked, relevant, 4) == pytest.approx(2 / 4)
    assert recall_at_k(ranked, relevant, 2) == pytest.approx(1 / 3)   # only 'a' of {a,c,z}
    assert recall_at_k(ranked, relevant, 4) == pytest.approx(2 / 3)   # a and c
    assert recall_at_k(ranked, relevant, 10) == pytest.approx(2 / 3)  # z never retrieved


def test_metrics_are_none_when_nothing_is_relevant():
    # An unanswerable query must be excluded from the mean, not scored as a miss.
    for function in (precision_at_k, recall_at_k, hit_rate_at_k):
        assert function(["a", "b"], set(), 5) is None
    assert reciprocal_rank(["a", "b"], set()) is None
    assert ndcg_at_k(["a", "b"], set(), 5) is None


def test_reciprocal_rank_and_mrr():
    assert reciprocal_rank(["x", "a", "b"], {"a"}) == 0.5
    assert reciprocal_rank(["a", "x"], {"a"}) == 1.0
    assert reciprocal_rank(["x", "y"], {"a"}) == 0.0
    assert mrr([1.0, 0.5, 0.0]) == 0.5
    assert mrr([None, 1.0, None]) == 1.0, "undefined queries must not dilute the mean"
    assert mrr([]) == 0.0


def test_hit_rate():
    assert hit_rate_at_k(["x", "a"], {"a"}, 1) == 0.0
    assert hit_rate_at_k(["x", "a"], {"a"}, 2) == 1.0


def test_ndcg_handles_binary_relevance():
    assert ndcg_at_k(["a", "b", "c"], {"a"}, 3) == 1.0
    # The relevant document at rank 2 is discounted by log2(3).
    assert ndcg_at_k(["b", "a", "c"], {"a"}, 3) == pytest.approx(1 / math.log2(3))
    assert ndcg_at_k(["b", "c", "d"], {"a"}, 3) == 0.0


def test_ndcg_handles_graded_relevance():
    gains = {"a": 3.0, "b": 2.0, "c": 1.0}
    # Perfect ordering scores 1.0.
    assert ndcg_at_k(["a", "b", "c"], gains, 3) == pytest.approx(1.0)
    # Reversed ordering is strictly worse but not zero.
    reversed_score = ndcg_at_k(["c", "b", "a"], gains, 3)
    assert 0.0 < reversed_score < 1.0


def test_ndcg_uses_the_ideal_ranking_over_the_whole_judgement():
    # More relevant documents than k: a full top-k of relevant hits is NOT a
    # perfect score, because the ideal ranking would have used the higher gains.
    gains = {"a": 1.0, "b": 1.0, "c": 5.0}
    assert ndcg_at_k(["a", "b"], gains, 2) < 1.0


def test_ndcg_is_normalised_to_one():
    for ranked in (["a"], ["b", "a"], ["z", "y", "a"]):
        score = ndcg_at_k(ranked, {"a"}, 10)
        assert 0.0 <= score <= 1.0


def test_invalid_k_is_rejected():
    for function in (precision_at_k, recall_at_k, ndcg_at_k):
        with pytest.raises(ValueError):
            function(["a"], {"a"}, 0)


def test_evaluate_ranker_aggregates_and_reports_provenance():
    queries = [
        {"id": "q1", "text": "contactor threshold", "relevant": ["d1", "d2"]},
        {"id": "q2", "text": "isolation resistance", "relevant": ["d3"]},
        {"id": "q3", "text": "unanswerable", "relevant": []},
    ]
    ranking = {"contactor threshold": ["d1", "d9", "d2"], "isolation resistance": ["d9", "d3"], "unanswerable": ["d9"]}

    report = evaluate_ranker(queries, lambda text: ranking[text], k_values=(1, 3), corpus_size=10)

    assert report.queries == 3
    assert report.scored == 2, "the unanswerable query is excluded"
    assert report.skipped == 1
    assert report.category == BenchmarkCategory.RETRIEVAL.value
    assert report.corpusSize == 10

    # q1: rank 1 hit -> RR 1.0 ; q2: rank 2 hit -> RR 0.5
    assert report.metrics["mrr"] == pytest.approx(0.75)
    assert report.metrics["recall@3"] == pytest.approx(1.0)   # both queries fully recovered by k=3
    assert report.metrics["recall@1"] == pytest.approx(0.25)  # q1 1/2, q2 0/1
    assert report.headline["mrr"] == pytest.approx(0.75)
    assert len(report.perQuery) == 3
    assert report.perQuery[2]["skipped"]


def test_evaluate_ranker_refuses_to_run_without_queries():
    with pytest.raises(ValueError):
        evaluate_ranker([], lambda text: [])
    with pytest.raises(ValueError):
        evaluate_ranker([{"id": "q", "text": "t", "relevant": ["a"]}], lambda text: [], k_values=(0,))


def test_evaluate_ranker_is_deterministic():
    queries = [{"id": f"q{i}", "text": f"term {i}", "relevant": [f"d{i}"]} for i in range(5)]
    first = evaluate_ranker(queries, lambda text: [text.split()[-1].replace("term", "d")])
    second = evaluate_ranker(queries, lambda text: [text.split()[-1].replace("term", "d")])
    assert first.metrics == second.metrics


def test_a_stronger_ranker_scores_higher_on_the_same_judgements():
    queries = [{"id": "q1", "text": "x", "relevant": ["a", "b"]}]
    good = evaluate_ranker(queries, lambda text: ["a", "b", "c"])
    poor = evaluate_ranker(queries, lambda text: ["c", "d", "a"])
    assert good.metrics["mrr"] > poor.metrics["mrr"]
    assert good.metrics["recall@3"] > poor.metrics["recall@3"]
