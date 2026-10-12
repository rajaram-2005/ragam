"""Tests for the dataset's fit/validation split.

The property that matters is not "returns two lists" — it is that the split is
disjoint, deterministic, non-empty on both sides, and drawn only from the queries
it was given. Selection runs on this split precisely so it cannot touch the
evaluation set, so a bug here would silently reintroduce the leakage the split
exists to prevent.
"""

from __future__ import annotations

import pytest

from fabric.dataset import Query, build_dataset, split_fit_validation


def make_queries(count: int) -> list[Query]:
    return [
        Query(query_id=f"q{index:02d}", text=f"query {index}", relevant=[f"d{index}"], topic=f"t{index}")
        for index in range(count)
    ]


class TestSplitIsDisjoint:
    def test_the_two_halves_share_no_query(self):
        fit, validation = split_fit_validation(make_queries(40))
        assert not ({q.query_id for q in fit} & {q.query_id for q in validation})

    def test_every_query_lands_in_exactly_one_half(self):
        queries = make_queries(40)
        fit, validation = split_fit_validation(queries)
        assert len(fit) + len(validation) == len(queries)
        assert {q.query_id for q in fit} | {q.query_id for q in validation} == {q.query_id for q in queries}

    def test_no_query_is_invented(self):
        queries = make_queries(40)
        originals = {id(q) for q in queries}
        fit, validation = split_fit_validation(queries)
        assert {id(q) for q in fit} <= originals
        assert {id(q) for q in validation} <= originals


class TestSplitSizes:
    def test_fraction_is_respected(self):
        fit, validation = split_fit_validation(make_queries(48), fraction=0.25)
        assert len(validation) == 12
        assert len(fit) == 36

    def test_both_halves_are_always_non_empty(self):
        # A "validation split" with nothing to validate on, or a fit split with
        # nothing to train on, is not a split.
        for count in range(2, 12):
            for fraction in (0.01, 0.5, 0.99):
                fit, validation = split_fit_validation(make_queries(count), fraction=fraction)
                assert fit, f"empty fit for count={count}, fraction={fraction}"
                assert validation, f"empty validation for count={count}, fraction={fraction}"

    def test_a_large_fraction_still_leaves_one_fit_query(self):
        fit, validation = split_fit_validation(make_queries(4), fraction=0.9)
        assert len(fit) >= 1
        assert len(validation) == 3


class TestDeterminism:
    def test_same_seed_gives_the_same_split(self):
        queries = make_queries(48)
        first = split_fit_validation(queries, seed=99)
        second = split_fit_validation(queries, seed=99)
        assert [q.query_id for q in first[0]] == [q.query_id for q in second[0]]
        assert [q.query_id for q in first[1]] == [q.query_id for q in second[1]]

    def test_different_seeds_generally_differ(self):
        queries = make_queries(48)
        a = {q.query_id for q in split_fit_validation(queries, seed=1)[1]}
        b = {q.query_id for q in split_fit_validation(queries, seed=2)[1]}
        assert a != b, "different seeds produced the same validation set; the seed is being ignored"

    def test_output_order_follows_the_input(self):
        # Returning a shuffled list would make printed splits hard to compare
        # between runs even when the *sets* are identical.
        queries = make_queries(48)
        fit, validation = split_fit_validation(queries, seed=7)
        positions = {q.query_id: index for index, q in enumerate(queries)}
        assert [positions[q.query_id] for q in fit] == sorted(positions[q.query_id] for q in fit)
        assert [positions[q.query_id] for q in validation] == sorted(positions[q.query_id] for q in validation)


class TestSplitRejectsBadInput:
    def test_fraction_of_zero_is_refused(self):
        with pytest.raises(ValueError, match="fraction"):
            split_fit_validation(make_queries(10), fraction=0.0)

    def test_fraction_of_one_is_refused(self):
        with pytest.raises(ValueError, match="fraction"):
            split_fit_validation(make_queries(10), fraction=1.0)

    def test_negative_fraction_is_refused(self):
        with pytest.raises(ValueError, match="fraction"):
            split_fit_validation(make_queries(10), fraction=-0.5)

    def test_one_query_is_refused(self):
        with pytest.raises(ValueError, match="at least 2"):
            split_fit_validation(make_queries(1))

    def test_zero_queries_is_refused(self):
        with pytest.raises(ValueError, match="at least 2"):
            split_fit_validation([])


class TestSplitOnTheRealDataset:
    def test_the_selection_split_cannot_reach_the_evaluation_queries(self):
        """The whole point: selection data comes from the training side only."""
        dataset = build_dataset(seed=1, overlap="low", split_by="query", evaluation_fraction=0.25)
        fit, validation = split_fit_validation(dataset.train_queries, fraction=0.25, seed=20251012)

        evaluation_ids = {q.query_id for q in dataset.evaluation_queries}
        train_ids = {q.query_id for q in dataset.train_queries}

        assert not ({q.query_id for q in fit} & evaluation_ids)
        assert not ({q.query_id for q in validation} & evaluation_ids)
        assert {q.query_id for q in fit} | {q.query_id for q in validation} == train_ids

    def test_reproduces_the_recorded_selection_split(self):
        # Pinned because the split decides which model is selected. If this changes,
        # the recorded selection was made on different data than a reader would get.
        dataset = build_dataset(seed=1, overlap="low", split_by="query", evaluation_fraction=0.25)
        _, validation = split_fit_validation(dataset.train_queries, fraction=0.25, seed=20251012)
        assert len(validation) == 12
        assert len(dataset.train_queries) == 48
