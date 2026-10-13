"""Tests for the Sparsiz improvement cycle driver.

These pin the *decision* the cycle reaches, not merely that it ran. The negative
control is the first test: the dense retriever alone must be rejected on the high
overlap condition with the same reason the historical run was rejected. If that
assertion ever passes without the rejection, the ledger has stopped enforcing its
recall tolerance.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "sparsiz_cycle.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("sparsiz_cycle", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def high_condition():
    module = _load_module()
    report = {"conditions": []}
    module.run("high", report)
    return report["conditions"][0]


class TestRootCauseEvidence:
    def test_reports_out_of_vocabulary_coverage_for_both_splits(self, high_condition):
        evidence = high_condition["rootCauseEvidence"]
        assert evidence["evaluationQueries"] == 24
        assert evidence["trainQueries"] == 48

    def test_training_queries_have_no_out_of_vocabulary_tokens(self, high_condition):
        # This asymmetry is the defect: the vocabulary fits the training set exactly
        # and not the inputs the system is evaluated on.
        assert high_condition["rootCauseEvidence"]["trainQueriesWithOutOfVocabularyTokens"] == 0

    def test_evaluation_queries_do_have_out_of_vocabulary_tokens(self, high_condition):
        assert high_condition["rootCauseEvidence"]["evaluationQueriesWithOutOfVocabularyTokens"] > 0


class TestFailureCapture:
    def test_a_failure_is_captured_and_promoted(self, high_condition):
        assert len(high_condition["failuresCaptured"]) == 2
        assert len(high_condition["regressionCases"]) == 2

    def test_regression_cases_name_a_checker_that_exists(self, high_condition):
        module = _load_module()
        for case in high_condition["regressionCases"]:
            assert case["checker"] in module.CHECKERS

    def test_regression_cases_separate_baseline_from_variant(self, high_condition):
        # A case that failed on both retrievers would not isolate the defect, and a
        # case that passed on both would not be a regression case at all.
        for case in high_condition["regressionCases"]:
            assert case["passesOnLexical"] is True
            assert case["failsOnDense"] is True

    def test_captured_failures_reach_the_promoted_stage(self, high_condition):
        # Capturing alone is not enough: a failure that was never triaged and
        # validated cannot become a permanent regression check.
        summary = high_condition["failureMemory"]
        assert summary["failures"] == 2
        assert summary["byStage"].get("promoted") == 2

    def test_every_captured_failure_became_a_regression_case(self, high_condition):
        summary = high_condition["failureMemory"]
        assert summary["regressionCases"] == summary["failures"]

    def test_captured_failures_carry_a_root_cause(self, high_condition):
        assert high_condition["failureMemory"]["byRootCause"], "triaged failures must be classified"


class TestLedgerVerdicts:
    def _experiment(self, section, change_fragment):
        for experiment in section["experiments"]:
            if change_fragment in experiment["change"]:
                return experiment
        raise AssertionError(f"no experiment matching {change_fragment!r}")

    def test_dense_retriever_alone_is_rejected(self, high_condition):
        experiment = self._experiment(high_condition, "no fusion")
        assert experiment["verdict"] == "reject"
        assert experiment["accepted"] is False

    def test_rejection_reason_is_the_recall_regression(self, high_condition):
        experiment = self._experiment(high_condition, "no fusion")
        assert any("recall@5 regressed" in reason for reason in experiment["reasons"])

    def test_hybrid_fusion_is_accepted(self, high_condition):
        experiment = self._experiment(high_condition, "0.5/0.5")
        assert experiment["verdict"] == "accept"
        assert experiment["accepted"] is True

    def test_hybrid_beats_the_baseline_on_the_target_metric(self, high_condition):
        experiment = self._experiment(high_condition, "0.5/0.5")
        assert experiment["variantMetrics"]["mrr"] > experiment["baselineMetrics"]["mrr"]

    def test_hybrid_keeps_recall_close_to_the_baseline(self, high_condition):
        # The baseline is perfect on this condition, so the fusion is judged on how
        # little recall it gives up to gain ordering.
        experiment = self._experiment(high_condition, "0.5/0.5")
        assert experiment["variantMetrics"]["recall@5"] >= 0.95

    def test_hybrid_improves_ordering_over_both_components(self, high_condition):
        baseline = self._experiment(high_condition, "no fusion")
        hybrid = self._experiment(high_condition, "0.5/0.5")
        assert hybrid["variantMetrics"]["mrr"] > baseline["variantMetrics"]["mrr"]

    def test_every_experiment_recorded_a_control_fingerprint(self, high_condition):
        # A verdict that cannot show its comparison was controlled is not evidence.
        assert high_condition["ledger"]["experiments"] == len(high_condition["experiments"])
