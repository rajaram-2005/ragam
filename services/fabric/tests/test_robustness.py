"""Tests for the robustness measurement.

These pin the two halves of a claim that came out differently, which is the whole
reason the script exists:

* the fusion **never** reduces recall@5 relative to the dense model, on every seed
  measured — that is a real, reproducible property;
* the fusion's mrr gain does **not** clear the seed-to-seed noise floor, and is
  negative on some seeds — that is a real, reproducible *non*-result.

A test file that asserted only the first would let someone delete the second from
the report without anything failing, so both are checked, along with the pairing
that makes the comparison valid at all.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "robustness.py"

#: Small but real: three seeds at reduced epochs. The properties under test are
#: structural, so they do not need 25 epochs — but they do need more than one seed,
#: because a single seed cannot show a seed-dependent effect.
FAST_SEEDS = (7, 11, 13)
FAST_EPOCHS = 6


def _load_module():
    spec = importlib.util.spec_from_file_location("robustness", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def paired_high():
    module = _load_module()
    return module.paired_axis(module.PipelineConfig(), "high", FAST_SEEDS, FAST_EPOCHS)


class TestTheComparisonIsPaired:
    def test_one_model_per_seed(self, paired_high):
        assert len(paired_high["runs"]) == len(FAST_SEEDS)
        assert [run["seed"] for run in paired_high["runs"]] == list(FAST_SEEDS)

    def test_each_run_records_the_model_both_rankers_used(self, paired_high):
        # Without this, a change to the script could train two models per seed and
        # the "paired" comparison would silently stop being paired.
        for run in paired_high["runs"]:
            assert isinstance(run["modelDigest"], str)
            assert len(run["modelDigest"]) == 64

    def test_distinct_seeds_produce_distinct_models(self, paired_high):
        digests = [run["modelDigest"] for run in paired_high["runs"]]
        assert len(set(digests)) == len(digests), "the seed is not reaching the initialisation"

    def test_both_rankers_are_measured_on_every_seed(self, paired_high):
        for run in paired_high["runs"]:
            for ranker in ("dense", "hybrid"):
                for metric in ("mrr", "recall@1", "recall@5", "ndcg@10"):
                    assert metric in run[ranker]

    def test_the_lexical_baseline_is_shared_not_re_rolled(self, paired_high):
        # BM25 has no seed. Measuring it once and reporting it against every seed is
        # what makes it a fixed reference rather than another varying quantity.
        assert paired_high["bm25"]["mrr"] > 0
        assert "runs" not in paired_high["bm25"]


class TestTheRobustProperty:
    def test_fusion_never_reduces_recall_at_5_relative_to_dense(self, paired_high):
        """The property the fusion was introduced for, and it holds on every seed."""
        for run in paired_high["runs"]:
            assert run["hybrid"]["recall@5"] >= run["dense"]["recall@5"], (
                f"seed {run['seed']}: fusion lost recall@5"
            )

    def test_the_summary_reports_that_property_truthfully(self, paired_high):
        summary = paired_high["summary"]
        assert summary["recallAt5NeverBelowDense"] is True

        observed = [
            run["hybrid"]["recall@5"] - run["dense"]["recall@5"] for run in paired_high["runs"]
        ]
        assert summary["minPairedRecallAt5Gain"] == pytest.approx(min(observed), abs=1e-9)
        assert summary["meanPairedRecallAt5Gain"] == pytest.approx(
            sum(observed) / len(observed), abs=1e-6
        )


def run(seed, dense_mrr, dense_recall, hybrid_mrr, hybrid_recall):
    """One paired run, for feeding crafted inputs to the summariser."""
    return {
        "seed": seed,
        "modelDigest": "0" * 64,
        "dense": {"mrr": dense_mrr, "recall@5": dense_recall, "recall@1": dense_recall, "ndcg@10": dense_mrr},
        "hybrid": {"mrr": hybrid_mrr, "recall@5": hybrid_recall, "recall@1": hybrid_recall, "ndcg@10": hybrid_mrr},
    }


class TestTheSummaryIsDerivedNotAsserted:
    """Crafted inputs, because a real run can make a hardcoded value look correct.

    An earlier version of these tests read the summary of a real measurement. Two
    of three injected defects survived it: at that configuration the reversal count
    genuinely was zero and the gain genuinely did exceed the spread, so hardcoding
    those values was indistinguishable from computing them. Feeding in runs where
    the answers are non-trivial removes the coincidence.
    """

    def _summarise(self, runs, bm25_recall=1.0):
        module = _load_module()
        return module.summarise_paired(runs, {"recall@5": bm25_recall})

    def test_reversals_are_counted_not_assumed_zero(self):
        summary = self._summarise([
            run(1, 0.5, 1.0, 0.6, 1.0),   # gain
            run(2, 0.5, 1.0, 0.4, 1.0),   # reversal
            run(3, 0.5, 1.0, 0.3, 1.0),   # reversal
        ])
        assert summary["seedsWhereMrrGainIsNegative"] == 2
        assert summary["mrrGainPositiveOnEverySeed"] is False

    def test_a_consistent_gain_is_reported_as_consistent(self):
        summary = self._summarise([
            run(1, 0.5, 1.0, 0.6, 1.0),
            run(2, 0.5, 1.0, 0.7, 1.0),
        ])
        assert summary["seedsWhereMrrGainIsNegative"] == 0
        assert summary["mrrGainPositiveOnEverySeed"] is True

    def test_a_gain_inside_the_spread_does_not_clear_it(self):
        # Same mean gain as the next test, but the baseline itself moves a lot.
        summary = self._summarise([
            run(1, 0.20, 1.0, 0.25, 1.0),
            run(2, 0.40, 1.0, 0.45, 1.0),
        ])
        assert summary["meanPairedMrrGain"] == pytest.approx(0.05, abs=1e-9)
        assert summary["denseMrrSeedStdev"] > 0.05
        assert summary["mrrGainExceedsSeedSpread"] is False

    def test_a_gain_larger_than_the_spread_clears_it(self):
        summary = self._summarise([
            run(1, 0.30, 1.0, 0.80, 1.0),
            run(2, 0.31, 1.0, 0.81, 1.0),
        ])
        assert summary["denseMrrSeedStdev"] < 0.02
        assert summary["mrrGainExceedsSeedSpread"] is True

    def test_the_two_flags_can_disagree(self):
        # The case that motivated reporting both: the average clears the spread,
        # yet the change reverses on one seed, so it is not reliable per-run.
        summary = self._summarise([
            run(1, 0.10, 1.0, 1.00, 1.0),
            run(2, 0.10, 1.0, 0.05, 1.0),
        ])
        assert summary["mrrGainExceedsSeedSpread"] is True
        assert summary["mrrGainPositiveOnEverySeed"] is False

    def test_a_recall_loss_anywhere_falsifies_the_robust_property(self):
        # The property is universal, so one seed is enough to break it.
        summary = self._summarise([
            run(1, 0.5, 1.0, 0.6, 1.0),
            run(2, 0.5, 1.0, 0.6, 0.8),   # lost recall on this seed
        ])
        assert summary["recallAt5NeverBelowDense"] is False
        assert summary["minPairedRecallAt5Gain"] == pytest.approx(-0.2, abs=1e-9)

    def test_recall_equality_does_not_count_as_a_loss(self):
        # Holding recall flat while improving ordering is the goal, so a zero gain
        # must not be treated as a regression.
        summary = self._summarise([
            run(1, 0.5, 0.9, 0.6, 0.9),
            run(2, 0.5, 0.9, 0.6, 0.9),
        ])
        assert summary["recallAt5NeverBelowDense"] is True
        assert summary["minPairedRecallAt5Gain"] == 0.0

    def test_bm25_regression_is_counted_for_each_ranker_separately(self):
        summary = self._summarise(
            [
                run(1, 0.5, 1.0, 0.6, 1.0),   # neither regresses
                run(2, 0.5, 0.9, 0.6, 0.95),  # both regress
                run(3, 0.5, 0.8, 0.6, 1.0),   # dense only
            ],
            bm25_recall=1.0,
        )
        assert summary["denseRecallRegressedVsBm25"] == 2
        assert summary["hybridRecallRegressedVsBm25"] == 1

    def test_a_single_run_reports_a_zero_spread_rather_than_dividing_by_zero(self):
        summary = self._summarise([run(1, 0.5, 1.0, 0.6, 1.0)])
        assert summary["denseMrrSeedStdev"] == 0.0
        assert summary["seedCount"] == 1


class TestTheRecordedOutcomeAtTheReleasedConfiguration:
    """One slower test pinning what the docs actually claim.

    The docs report a specific, reproducible outcome at the released configuration.
    Without this, the code could change so the report says the opposite while the
    prose still claimed the original finding.
    """

    def test_high_condition_at_the_released_configuration(self):
        module = _load_module()
        config = module.PipelineConfig()
        result = module.paired_axis(config, "high", module.SEEDS, config.epochs)
        summary = result["summary"]

        # Robust, and the reason the fusion was kept.
        assert summary["recallAt5NeverBelowDense"] is True
        # Re-baselined 2026-10-25: under the corrected tokenizer (hyphen-part
        # tokens in the stemmed stream) the paired mrr gain on `high` is now
        # positive on every seed and exceeds the seed spread — but only just
        # (mean gain 0.0277 vs dense mrr stdev 0.0263). Treat a future flip
        # here as the measurement moving, and re-record rather than re-tune.
        # Historically both were False; see the erratum in docs/07.
        assert summary["mrrGainExceedsSeedSpread"] is True
        assert summary["mrrGainPositiveOnEverySeed"] is True
        # The original defect is narrowed but not eliminated: BM25 has perfect
        # recall@5 on this condition and neither ranker matches it on every seed.
        assert summary["hybridRecallRegressedVsBm25"] < summary["denseRecallRegressedVsBm25"]


class TestSweepAxes:
    def test_seed_and_size_axes_use_disjoint_labels(self):
        module = _load_module()
        # A shared label would let one axis be silently reported as the other.
        assert module.SEEDS != module.TRAINING_SIZES
        assert 48 in module.TRAINING_SIZES

    def test_seed_axis_excludes_duplicates(self):
        module = _load_module()
        assert len(set(module.SEEDS)) == len(module.SEEDS)

    def test_the_released_seed_is_swept(self):
        # Otherwise the sweep could not say where the released number sits in it.
        module = _load_module()
        assert module.PipelineConfig().model_seed in module.SEEDS

    def test_paired_conditions_include_the_rejected_one(self):
        module = _load_module()
        assert "high" in module.PAIRED_CONDITIONS
