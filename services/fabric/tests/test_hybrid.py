"""Tests for hybrid rank fusion.

Every property here is checked against a known-good or known-bad input. A fusion
test that only asserts "returns a list" would pass on a function that returned
its input unchanged, so the ordering claims are asserted numerically.
"""

from __future__ import annotations

import pytest

from fabric.hybrid import DEFAULT_WEIGHTS, HybridRanker, fuse_rankings, rank_scores


class TestRankScores:
    def test_top_document_scores_the_full_weight(self):
        assert rank_scores(["a", "b"], 1.0)["a"] == 1.0

    def test_scores_decrease_strictly(self):
        scores = rank_scores(["a", "b", "c", "d"], 1.0)
        assert scores["a"] > scores["b"] > scores["c"] > scores["d"]

    def test_last_document_still_scores_above_zero(self):
        # If the tail scored zero, a document listed by only one ranker could tie
        # with a document listed by neither, and the fusion would be a no-op.
        assert rank_scores(["a", "b", "c"], 1.0)["c"] > 0.0

    def test_weight_scales_linearly(self):
        assert rank_scores(["a", "b"], 0.5) == {k: v * 0.5 for k, v in rank_scores(["a", "b"], 1.0).items()}

    def test_empty_ranking_contributes_nothing(self):
        assert rank_scores([], 1.0) == {}

    def test_first_position_advantage_shrinks_with_length(self):
        # Position 0 always scores the full weight, so the *gap* to position 1 is
        # what a long list compresses.
        short = rank_scores(["a", "b"], 1.0)
        long = rank_scores(["a", "b", "c", "d", "e", "f", "g", "h"], 1.0)
        assert short["a"] - short["b"] > long["a"] - long["b"]


class TestFuseRankings:
    def test_agreement_wins_over_single_list_leadership(self):
        # "shared" is 2nd and 2nd; "lex" tops only the lexical list. Agreement
        # must outweigh a single first place, otherwise fusion is pointless.
        fused = fuse_rankings([["lex", "shared"], ["shared", "dense"]])
        assert fused[0] == "shared"

    def test_equal_inputs_fuse_to_the_same_order(self):
        assert fuse_rankings([["a", "b", "c"]], [1.0]) == ["a", "b", "c"]

    def test_document_from_one_ranker_only_is_kept(self):
        fused = fuse_rankings([["a"], ["b"]])
        assert set(fused) == {"a", "b"}

    def test_union_is_complete(self):
        fused = fuse_rankings([["a", "b"], ["c", "d"]])
        assert set(fused) == {"a", "b", "c", "d"}

    def test_top_k_truncates(self):
        fused = fuse_rankings([["a", "b", "c", "d"]], [1.0], top_k=2)
        assert fused == ["a", "b"]

    def test_top_k_longer_than_union_is_not_an_error(self):
        assert len(fuse_rankings([["a"]], [1.0], top_k=10)) == 1

    def test_zero_weight_disables_a_ranker(self):
        # Weighting the lexical half to zero must reproduce the dense ranking.
        dense = ["z", "y", "x"]
        fused = fuse_rankings([["a", "b", "c"], dense], [0.0, 1.0])
        assert fused[:3] == dense

    def test_ties_break_deterministically(self):
        # Identical lists at identical weights produce identical scores; the order
        # must be stable across calls or a ledger entry could not be reproduced.
        first = fuse_rankings([["a", "b"], ["a", "b"]])
        second = fuse_rankings([["a", "b"], ["a", "b"]])
        assert first == second

    def test_empty_rankings_yield_empty_result(self):
        assert fuse_rankings([[], []], [0.5, 0.5]) == []

    def test_no_rankings_does_not_raise(self):
        assert fuse_rankings([], []) == []


class TestFuseRankingsRejectsBadInput:
    def test_weight_length_mismatch_is_refused(self):
        with pytest.raises(ValueError, match="weights"):
            fuse_rankings([["a"], ["b"]], [1.0])

    def test_negative_weight_is_refused(self):
        with pytest.raises(ValueError, match="negative"):
            fuse_rankings([["a"], ["b"]], [1.0, -0.5])

    def test_all_zero_weights_are_refused(self):
        # Ranking by nothing would still return an order; refusing is the honest
        # behaviour, because that order would carry no information.
        with pytest.raises(ValueError, match="more than zero"):
            fuse_rankings([["a"], ["b"]], [0.0, 0.0])

    def test_a_lone_zero_weight_ranker_is_refused(self):
        # With every weight at zero there is no evidence to rank on, so the fusion
        # refuses rather than returning an arbitrary order.
        with pytest.raises(ValueError, match="more than zero"):
            fuse_rankings([["a"]], [0.0])

    def test_zero_weight_among_nonzero_weights_is_allowed(self):
        # Disabling one ranker is legitimate; only an all-zero weight set is not.
        assert fuse_rankings([["a", "b"], ["b"]], [0.0, 1.0]) == ["b", "a"]


class TestHybridRanker:
    def _ranker(self, **kwargs):
        return HybridRanker(
            lexical=lambda _t: ["l1", "l2", "l3"],
            dense=lambda _t: ["d1", "d2", "l1"],
            **kwargs,
        )

    def test_is_callable_as_a_ranking_function(self):
        assert isinstance(self._ranker()("q"), list)

    def test_default_weights_are_equal_trust(self):
        assert self._ranker().weights == DEFAULT_WEIGHTS == (0.5, 0.5)

    def test_result_matches_direct_fusion(self):
        ranker = self._ranker()
        direct = fuse_rankings([["l1", "l2", "l3"], ["d1", "d2", "l1"]], (0.5, 0.5), top_k=10)
        assert ranker("q") == direct

    def test_document_in_both_halves_outranks_one_half_alone(self):
        # "l1" appears in both lists; "d1" only leads the dense list.
        fused = self._ranker()("q")
        assert fused.index("l1") < fused.index("d1")

    def test_top_k_defaults_to_ten(self):
        ranker = HybridRanker(
            lexical=lambda _t: [f"l{i}" for i in range(50)],
            dense=lambda _t: [f"d{i}" for i in range(50)],
        )
        assert len(ranker("q")) == 10

    def test_components_reports_each_half_unchanged(self):
        # Diagnosis depends on seeing what each retriever actually returned, so the
        # accessor must not fuse.
        halves = self._ranker().components("q")
        assert halves == {"lexical": ["l1", "l2", "l3"], "dense": ["d1", "d2", "l1"]}

    def test_provenance_is_recordable(self):
        ranker = self._ranker(provenance={"weights": [0.5, 0.5]})
        assert ranker.provenance["weights"] == [0.5, 0.5]

    def test_label_defaults_are_distinct_from_components(self):
        assert self._ranker().label == "hybrid(lexical+dense)"
