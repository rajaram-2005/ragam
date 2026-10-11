"""The improvement cycle must refuse to flatter a variant.

The ledger's job is to say no. These tests therefore concentrate on the ways a
change could look like a win and must not be accepted: a target-metric gain that
regresses a guarded metric, a gain inside measurement noise, a measurement taken
under different conditions, and a metric where smaller is better.
"""

from __future__ import annotations

import pytest

from fabric.experiments import (
    HISTORICAL_FAILURE_SPEC,
    RETRIEVAL_METRICS,
    Baseline,
    ControlMismatchError,
    ExperimentLedger,
    Hypothesis,
    MetricDirection,
    MetricSpec,
)
from fabric.taxonomy import BenchmarkCategory, ExperimentVerdict, RootCause

BASE = {"mrr": 0.40, "recall@1": 0.30, "recall@5": 0.60, "ndcg@10": 0.50, "latencyMs": 2.0}
CONTROL = {"dataset_digest": "digest-a", "corpus_size": 96, "hardware": {"cpu": 2, "gpu": 0}}


@pytest.fixture()
def ledger() -> ExperimentLedger:
    book = ExperimentLedger()
    book.record_baseline("bm25", BASE, **CONTROL, notes="unmodified BM25 over the fixture corpus")
    return book


def hypothesis(**kwargs) -> Hypothesis:
    defaults = {
        "statement": "a trained dual encoder improves ranking on paraphrase queries",
        "root_cause": RootCause.RETRIEVAL,
        "target_metric": "mrr",
        "min_improvement": 0.05,
        "change": "replace BM25 scoring with dense cosine similarity",
    }
    defaults.update(kwargs)
    return Hypothesis(**defaults)


# --- baselines -------------------------------------------------------------


def test_a_baseline_is_frozen_with_its_control_conditions(ledger):
    baseline = ledger.baseline("bm25")
    assert isinstance(baseline, Baseline)
    assert baseline.metrics == BASE
    assert baseline.dataset_digest == "digest-a"
    assert baseline.control_fingerprint() == ledger.baseline("bm25").control_fingerprint()


def test_a_baseline_missing_a_judged_metric_is_refused():
    book = ExperimentLedger()
    with pytest.raises(ValueError, match="missing values for"):
        book.record_baseline("broken", {"mrr": 0.4})


def test_a_baseline_cannot_be_overwritten(ledger):
    # Otherwise a drifting reference would invalidate every past verdict.
    with pytest.raises(ValueError, match="already exists"):
        ledger.record_baseline("bm25", BASE, **CONTROL)


def test_metrics_reported_but_not_judged_are_recorded(ledger):
    ledger.record_baseline("extra", {**BASE, "memoryMb": 120.0}, **CONTROL)
    assert ledger.baseline("extra").extra_metrics == ["memoryMb"]


def test_an_unknown_baseline_is_reported_with_what_exists(ledger):
    with pytest.raises(KeyError, match="unknown baseline 'nope'"):
        ledger.baseline("nope")


# --- metric direction ------------------------------------------------------


def test_a_lower_is_better_metric_rewards_a_decrease():
    spec = MetricSpec("latencyMs", MetricDirection.LOWER_IS_BETTER)
    assert spec.improved(10.0, 8.0)
    assert not spec.improved(8.0, 10.0)
    assert spec.delta(10.0, 8.0) == 2.0, "delta is always signed so positive means better"
    assert spec.regressed(10.0, 20.0)
    assert not spec.regressed(10.0, 10.2)


def test_a_higher_is_better_metric_rewards_an_increase():
    spec = MetricSpec("mrr")
    assert spec.improved(0.4, 0.5)
    assert not spec.improved(0.5, 0.4)
    assert spec.delta(0.4, 0.5) == pytest.approx(0.1)
    assert spec.regressed(0.4, 0.3)


def test_min_improvement_is_direction_aware():
    spec = MetricSpec("latencyMs", MetricDirection.LOWER_IS_BETTER)
    assert spec.improved(10.0, 9.0, min_delta=0.5)
    assert not spec.improved(10.0, 9.8, min_delta=0.5)


def test_invalid_metric_specs_are_rejected():
    with pytest.raises(ValueError):
        MetricSpec("x", "sideways")
    with pytest.raises(ValueError):
        MetricSpec("x", tolerance=-0.1)


def test_relative_delta_is_none_for_a_zero_baseline():
    assert MetricSpec("mrr").relative_delta(0.0, 0.5) is None


# --- the verdict -----------------------------------------------------------


def test_a_clean_improvement_is_accepted(ledger):
    record = ledger.run_experiment(
        hypothesis(),
        "bm25",
        lambda: {**BASE, "mrr": 0.85, "recall@1": 0.75, "recall@5": 0.9, "ndcg@10": 0.85},
        **CONTROL,
    )
    assert record.verdict is ExperimentVerdict.ACCEPT
    assert record.accepted is True
    assert any("improved" in reason for reason in record.reasons)
    assert record.deltas["mrr"]["relativeDelta"] == pytest.approx((0.85 - 0.40) / 0.40)


def test_a_target_gain_that_regresses_a_guarded_metric_is_rejected(ledger):
    # This is the exact shape of the real result: MRR up 155%, latency up too.
    record = ledger.run_experiment(
        hypothesis(),
        "bm25",
        lambda: {**BASE, "mrr": 0.855, "recall@1": 0.79, "recall@5": 0.95, "ndcg@10": 0.9, "latencyMs": 3.4},
        **CONTROL,
    )
    assert record.verdict is ExperimentVerdict.REJECT
    assert any("latencyMs regressed" in reason for reason in record.reasons)
    # The target improvement is still reported; it is simply not sufficient.
    assert any("target 'mrr' improved" in reason for reason in record.reasons)


def test_a_gain_inside_the_noise_floor_is_rejected(ledger):
    record = ledger.run_experiment(
        hypothesis(min_improvement=0.05),
        "bm25",
        lambda: {**BASE, "mrr": 0.42},
        **CONTROL,
    )
    assert record.verdict is ExperimentVerdict.REJECT
    assert any("did not improve by" in reason for reason in record.reasons)


def test_a_flat_result_is_rejected(ledger):
    record = ledger.run_experiment(hypothesis(min_improvement=0.0), "bm25", lambda: dict(BASE), **CONTROL)
    assert record.verdict is ExperimentVerdict.REJECT


def test_a_regression_on_a_previously_fixed_failure_is_never_acceptable():
    book = ExperimentLedger(default_specs=RETRIEVAL_METRICS + (HISTORICAL_FAILURE_SPEC,))
    book.record_baseline("bm25", {**BASE, "historicalFailures": 0.9}, **CONTROL)
    record = book.run_experiment(
        hypothesis(target_metric="historicalFailures", min_improvement=0.0),
        "bm25",
        lambda: {**BASE, "mrr": 0.99, "historicalFailures": 0.85},
        **CONTROL,
    )
    assert record.verdict is ExperimentVerdict.REJECT
    assert any("previously fixed failure broke again" in reason for reason in record.reasons)


def test_a_target_metric_outside_the_comparison_is_inconclusive(ledger):
    record = ledger.run_experiment(hypothesis(target_metric="bleu"), "bm25", lambda: dict(BASE), **CONTROL)
    assert record.verdict is ExperimentVerdict.INCONCLUSIVE
    assert any("not part of this comparison" in reason for reason in record.reasons)


def test_a_variant_that_reports_too_little_is_inconclusive(ledger):
    record = ledger.run_experiment(hypothesis(), "bm25", lambda: {"mrr": 0.9}, **CONTROL)
    assert record.verdict is ExperimentVerdict.INCONCLUSIVE
    assert any("did not report" in reason for reason in record.reasons)


def test_a_measurement_that_raises_is_recorded_not_swallowed(ledger):
    def explode():
        raise RuntimeError("cuda out of memory")

    record = ledger.run_experiment(hypothesis(), "bm25", explode, **CONTROL)
    assert record.verdict is ExperimentVerdict.INCONCLUSIVE
    assert any("measurement failed" in reason for reason in record.reasons)
    assert any("cuda out of memory" in reason for reason in record.reasons)
    assert len(ledger.experiments) == 1, "a failed attempt still belongs in the ledger"


# --- control checking ------------------------------------------------------


def test_a_different_dataset_refuses_the_comparison(ledger):
    with pytest.raises(ControlMismatchError, match="different conditions"):
        ledger.run_experiment(hypothesis(), "bm25", lambda: dict(BASE), dataset_digest="digest-B", corpus_size=96, hardware=CONTROL["hardware"])


def test_a_different_corpus_size_refuses_the_comparison(ledger):
    with pytest.raises(ControlMismatchError):
        ledger.run_experiment(hypothesis(), "bm25", lambda: dict(BASE), dataset_digest="digest-a", corpus_size=500, hardware=CONTROL["hardware"])


def test_different_hardware_refuses_the_comparison(ledger):
    with pytest.raises(ControlMismatchError):
        ledger.run_experiment(hypothesis(), "bm25", lambda: dict(BASE), dataset_digest="digest-a", corpus_size=96, hardware={"cpu": 64, "gpu": 8})


def test_control_can_be_relaxed_explicitly_and_says_so(ledger):
    # Sometimes a cross-hardware comparison is the point; it must be a decision.
    record = ledger.run_experiment(
        hypothesis(),
        "bm25",
        lambda: {**BASE, "mrr": 0.9},
        dataset_digest="digest-a",
        corpus_size=96,
        hardware={"cpu": 64, "gpu": 8},
        strict_control=False,
    )
    assert record.control_fingerprint != ledger.baseline("bm25").control_fingerprint()
    assert record.verdict is ExperimentVerdict.ACCEPT


def test_omitting_control_fields_inherits_the_baseline(ledger):
    record = ledger.run_experiment(hypothesis(), "bm25", lambda: {**BASE, "mrr": 0.9})
    assert record.control_fingerprint == ledger.baseline("bm25").control_fingerprint()


# --- ledger behaviour ------------------------------------------------------


def test_rejected_experiments_stay_in_the_ledger(ledger):
    ledger.run_experiment(hypothesis(), "bm25", lambda: dict(BASE), **CONTROL)
    ledger.run_experiment(hypothesis(), "bm25", lambda: {**BASE, "mrr": 0.9}, **CONTROL)
    assert len(ledger.experiments) == 2
    assert len(ledger.rejected()) == 1
    assert len(ledger.accepted()) == 1
    assert ledger.summary()["acceptRate"] == 0.5


def test_experiment_ids_are_sequential_and_unique(ledger):
    first = ledger.run_experiment(hypothesis(), "bm25", lambda: {**BASE, "mrr": 0.9}, **CONTROL)
    second = ledger.run_experiment(hypothesis(), "bm25", lambda: {**BASE, "mrr": 0.9}, **CONTROL)
    assert first.experiment_id != second.experiment_id
    assert first.experiment_id == "exp-0001" and second.experiment_id == "exp-0002"


def test_experiments_can_be_filtered_by_baseline(ledger):
    ledger.record_baseline("dense", {**BASE, "mrr": 0.8}, **CONTROL)
    ledger.run_experiment(hypothesis(), "bm25", lambda: {**BASE, "mrr": 0.9}, **CONTROL)
    ledger.run_experiment(hypothesis(), "dense", lambda: {**BASE, "mrr": 0.9}, **CONTROL)
    assert len(ledger.for_baseline("bm25")) == 1
    assert len(ledger.for_baseline("dense")) == 1


def test_compare_reports_every_judged_metric(ledger):
    comparison = ledger.compare({**BASE, "mrr": 0.9, "latencyMs": 9.0}, "bm25")
    assert comparison["baseline"] == "bm25"
    names = {row["metric"] for row in comparison["rows"]}
    assert names == {spec.name for spec in RETRIEVAL_METRICS}
    latency = next(row for row in comparison["rows"] if row["metric"] == "latencyMs")
    assert latency["direction"] == MetricDirection.LOWER_IS_BETTER
    assert latency["delta"] == pytest.approx(-7.0), "a slower variant has a negative (worse) delta"
    assert latency["regressed"] is True


def test_resource_usage_and_config_are_recorded(ledger):
    record = ledger.run_experiment(
        hypothesis(),
        "bm25",
        lambda: {**BASE, "mrr": 0.9},
        config={"epochs": 25, "seed": 7},
        resource_usage={"peakRssMb": 310, "cpuSeconds": 4.2},
        **CONTROL,
    )
    assert record.config["epochs"] == 25
    assert record.resource_usage["peakRssMb"] == 310
    assert record.duration_seconds >= 0


def test_the_ledger_round_trips_through_disk(tmp_path, ledger):
    ledger.run_experiment(hypothesis(), "bm25", lambda: {**BASE, "mrr": 0.9}, **CONTROL)
    path = ledger.save(tmp_path / "nested" / "ledger.json")
    assert path.exists()

    import json

    payload = json.loads(path.read_text())
    assert payload["format"] == "aetheris-experiment-ledger/1"
    assert payload["baselines"]["bm25"]["metrics"]["mrr"] == 0.40
    assert len(payload["experiments"]) == 1
    assert payload["experiments"][0]["verdict"] == "accept"
    assert payload["summary"]["experiments"] == 1


def test_the_ledger_digest_is_stable_and_content_sensitive(ledger):
    first = ledger.digest()
    assert first == ledger.digest()
    ledger.run_experiment(hypothesis(), "bm25", lambda: {**BASE, "mrr": 0.9}, **CONTROL)
    assert ledger.digest() != first


def test_an_explicit_threshold_is_inclusive():
    spec = MetricSpec("mrr")
    # 0.45 - 0.40 is 0.049999999999999996 in binary floating point. Landing a
    # rounding error below a human-chosen threshold must still count as meeting it.
    assert 0.45 - 0.40 < 0.05, "this test only means something if the float artefact is real"
    assert spec.improved(0.40, 0.45, min_delta=0.05), "meeting the threshold exactly is enough"
    assert spec.improved(0.40, 0.46, min_delta=0.05)
    assert not spec.improved(0.40, 0.449, min_delta=0.05), "a genuine shortfall must still fail"
    assert not spec.improved(0.40, 0.41, min_delta=0.05)
    with pytest.raises(ValueError):
        spec.improved(0.4, 0.5, min_delta=-1.0)


def test_a_tiny_but_real_improvement_passes_when_no_threshold_is_set():
    spec = MetricSpec("mrr")
    assert spec.improved(0.400, 0.4001)
    assert not spec.improved(0.400, 0.400)
    assert not spec.improved(0.400, 0.3999)
