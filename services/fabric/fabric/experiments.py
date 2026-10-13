"""The Sparsiz improvement cycle and its experiment ledger.

    Task -> Baseline -> Failure Capture -> Root-Cause Analysis -> Hypothesis
         -> Controlled Experiment -> Evaluation -> Accept or Reject

Provenance
----------
The cycle and the no-regression rule come from ``sparsiz/training/evaluation/evaluation.py``
and ``sparsiz/training/failure-memory/failure_memory.py``. The upstream rule is
adopted unchanged in spirit: a variant passes a metric when it scores at least
``baseline * (1 - tolerance)`` with a 5% tolerance, and **zero** tolerance on
``HISTORICAL_FAILURES`` — a model may not improve on average by re-breaking
something it previously got right.

Two things upstream did not have, and a real ledger cannot do without:

**Metric direction.** ``latency`` and ``energy`` improve when they get smaller.
Upstream compared every score with ``>=``, so a slower model would have been
recorded as an improvement. Each metric declares its direction here.

**Control checking.** An experiment is only meaningful if exactly one thing
changed. ``run_experiment`` refuses to compare a variant measured on a different
dataset, corpus or hardware profile from the baseline, and records what it
refused. Without that, the ledger would happily accept a "win" that came from
evaluating on easier data.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Mapping, Sequence

from .taxonomy import BenchmarkCategory, ExperimentVerdict, RootCause

__all__ = [
    "MetricDirection",
    "MetricSpec",
    "Baseline",
    "Hypothesis",
    "ExperimentRecord",
    "ExperimentLedger",
    "ControlMismatchError",
]

#: Upstream tolerance: a metric may fall by up to 5% and still pass.
DEFAULT_TOLERANCE = 0.05
#: Slack for float comparisons against a threshold. Far below any meaningful
#: metric difference, far above binary rounding error.
_FLOAT_SLACK = 1e-12
#: Upstream rule for previously-fixed failures: no regression at all.
ZERO_TOLERANCE = 0.0


class MetricDirection:
    HIGHER_IS_BETTER = "higher_is_better"
    LOWER_IS_BETTER = "lower_is_better"


class ControlMismatchError(RuntimeError):
    """Raised when a variant was not measured under the baseline's conditions."""


@dataclass(frozen=True)
class MetricSpec:
    """One metric: its direction and how far it may slip before it is a regression."""

    name: str
    direction: str = MetricDirection.HIGHER_IS_BETTER
    tolerance: float = DEFAULT_TOLERANCE
    #: A guarded metric must not regress, but improving it is not the point of the
    #: experiment. The target metric is what the hypothesis claims to move.
    guarded: bool = True
    category: BenchmarkCategory | None = None
    #: Movements smaller than this are measurement noise, not a regression.
    #:
    #: A relative tolerance is meaningless for a metric whose absolute scale is
    #: negligible. Comparing a sparse posting walk (0.02 ms/query) with a dense
    #: matrix product (0.05 ms/query) over a 96-document corpus produces a 150%
    #: "regression" that is really two sub-millisecond timings differing by less
    #: than a scheduler quantum. Without a noise floor, any change of algorithm
    #: class is rejected on latency alone and the ledger stops being useful. The
    #: real service-level control on latency is the absolute ceiling declared on
    #: the model card.
    noise_floor: float = 0.0

    def __post_init__(self) -> None:
        if self.direction not in (MetricDirection.HIGHER_IS_BETTER, MetricDirection.LOWER_IS_BETTER):
            raise ValueError(f"unknown metric direction: {self.direction!r}")
        if self.tolerance < 0:
            raise ValueError("tolerance cannot be negative")
        if self.noise_floor < 0:
            raise ValueError("noise_floor cannot be negative")

    def within_noise(self, baseline: float, variant: float) -> bool:
        """True when the difference is too small to be a measurement of anything."""
        return self.noise_floor > 0 and abs(variant - baseline) <= self.noise_floor

    def improved(self, baseline: float, variant: float, *, min_delta: float = 0.0) -> bool:
        """Did the variant move this metric in the right direction by enough?

        With no threshold set, the movement must be strictly positive: a variant
        that changes nothing has not supported a hypothesis that it would improve
        something, and recording it as accepted would let a no-op change into the
        ledger as a win. With an explicit threshold, meeting it exactly is enough.
        """
        if min_delta < 0:
            raise ValueError("min_delta cannot be negative")
        if self.within_noise(baseline, variant):
            return False
        movement = self.delta(baseline, variant)
        if min_delta <= 0:
            return movement > _FLOAT_SLACK
        # Binary floats cannot represent most decimal thresholds exactly: in Python
        # 0.45 - 0.40 == 0.049999999999999996. A threshold is a human-chosen number,
        # so landing a rounding error below it must still count as meeting it.
        return movement >= min_delta - _FLOAT_SLACK * max(1.0, abs(min_delta))

    def regressed(self, baseline: float, variant: float) -> bool:
        """Did the variant fall outside the allowed tolerance?"""
        if self.within_noise(baseline, variant):
            return False
        if self.direction is MetricDirection.HIGHER_IS_BETTER:
            return variant < baseline * (1 - self.tolerance) if baseline > 0 else variant < baseline - self.tolerance
        # Lower is better: the variant may rise by up to `tolerance` (relative).
        if baseline <= 0:
            return variant > baseline + self.tolerance
        return variant > baseline * (1 + self.tolerance)

    def delta(self, baseline: float, variant: float) -> float:
        """Signed improvement: positive always means better, whatever the direction."""
        if self.direction is MetricDirection.HIGHER_IS_BETTER:
            return variant - baseline
        return baseline - variant

    def relative_delta(self, baseline: float, variant: float) -> float | None:
        if baseline == 0:
            return None
        return self.delta(baseline, variant) / abs(baseline)


#: The metrics a retrieval experiment is judged on. MRR and Recall are the target;
#: latency is guarded, because a retriever that is right but too slow to serve is
#: not an improvement.
RETRIEVAL_METRICS: tuple[MetricSpec, ...] = (
    MetricSpec("mrr", MetricDirection.HIGHER_IS_BETTER, tolerance=ZERO_TOLERANCE, category=BenchmarkCategory.RETRIEVAL),
    MetricSpec("recall@1", MetricDirection.HIGHER_IS_BETTER, tolerance=ZERO_TOLERANCE, category=BenchmarkCategory.RETRIEVAL),
    MetricSpec("recall@5", MetricDirection.HIGHER_IS_BETTER, tolerance=DEFAULT_TOLERANCE, category=BenchmarkCategory.RETRIEVAL),
    MetricSpec("ndcg@10", MetricDirection.HIGHER_IS_BETTER, tolerance=DEFAULT_TOLERANCE, category=BenchmarkCategory.RETRIEVAL),
    # 1 ms per query: below this, timings on a shared two-core host are noise.
    MetricSpec("latencyMs", MetricDirection.LOWER_IS_BETTER, tolerance=DEFAULT_TOLERANCE,
               category=BenchmarkCategory.LATENCY, noise_floor=1.0),
)

HISTORICAL_FAILURE_SPEC = MetricSpec(
    "historicalFailures",
    MetricDirection.HIGHER_IS_BETTER,
    tolerance=ZERO_TOLERANCE,
    category=BenchmarkCategory.HISTORICAL_FAILURES,
)


@dataclass
class Baseline:
    """A frozen measurement that variants are compared against.

    Immutable in practice: the ledger stores it and never mutates it, and the
    control fields are part of its identity. Re-measuring a baseline is a new
    baseline, not an edit — otherwise a drifting reference would make every past
    verdict unverifiable.
    """

    name: str
    metrics: dict
    specs: tuple[MetricSpec, ...]
    dataset_digest: str | None = None
    corpus_size: int | None = None
    hardware: dict = field(default_factory=dict)
    config: dict = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    notes: str = ""
    #: Metrics that were reported but are not judged. Recorded so nothing is
    #: silently dropped, and so a later spec can be added without re-measuring.
    extra_metrics: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "metrics": dict(self.metrics),
            "specs": [
                {"name": s.name, "direction": s.direction, "tolerance": s.tolerance, "guarded": s.guarded,
                 "category": s.category.value if s.category else None, "noiseFloor": s.noise_floor}
                for s in self.specs
            ],
            "datasetDigest": self.dataset_digest,
            "corpusSize": self.corpus_size,
            "hardware": dict(self.hardware),
            "config": dict(self.config),
            "createdAt": self.created_at,
            "notes": self.notes,
            "extraMetrics": list(self.extra_metrics),
        }

    def control_fingerprint(self) -> str:
        """What must match for a comparison to be controlled."""
        payload = {
            "datasetDigest": self.dataset_digest,
            "corpusSize": self.corpus_size,
            "hardware": self.hardware,
        }
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()[:16]


@dataclass
class Hypothesis:
    """A falsifiable claim about one change."""

    statement: str
    root_cause: RootCause
    target_metric: str
    #: How much the target must move for the hypothesis to be considered
    #: supported. A change within measurement noise is not an improvement.
    min_improvement: float = 0.0
    change: str = ""
    extra_specs: tuple[MetricSpec, ...] = ()

    def to_dict(self) -> dict:
        return {
            "statement": self.statement,
            "rootCause": self.root_cause.value,
            "targetMetric": self.target_metric,
            "minImprovement": self.min_improvement,
            "change": self.change,
        }


@dataclass
class ExperimentRecord:
    """One completed experiment, with everything needed to reproduce the verdict."""

    experiment_id: str
    hypothesis: Hypothesis
    baseline_name: str
    baseline_metrics: dict
    variant_metrics: dict
    verdict: ExperimentVerdict
    reasons: list[str]
    deltas: dict
    control_fingerprint: str
    created_at: float
    duration_seconds: float
    config: dict = field(default_factory=dict)
    dataset_digest: str | None = None
    resource_usage: dict = field(default_factory=dict)

    @property
    def accepted(self) -> bool:
        return self.verdict is ExperimentVerdict.ACCEPT

    def to_dict(self) -> dict:
        return {
            "id": self.experiment_id,
            "hypothesis": self.hypothesis.to_dict(),
            "baseline": self.baseline_name,
            "baselineMetrics": dict(self.baseline_metrics),
            "variantMetrics": dict(self.variant_metrics),
            "verdict": self.verdict.value,
            "reasons": list(self.reasons),
            "deltas": dict(self.deltas),
            "controlFingerprint": self.control_fingerprint,
            "datasetDigest": self.dataset_digest,
            "config": dict(self.config),
            "resourceUsage": dict(self.resource_usage),
            "createdAt": self.created_at,
            "durationSeconds": self.duration_seconds,
        }


class ExperimentLedger:
    """Records baselines and experiments, and decides accept/reject.

    The ledger is append-only. A rejected experiment stays in it: knowing what did
    not work, and why, is the point of keeping a ledger rather than a leaderboard.
    """

    def __init__(self, *, default_specs: Sequence[MetricSpec] = RETRIEVAL_METRICS) -> None:
        self.default_specs = tuple(default_specs)
        self.baselines: dict[str, Baseline] = {}
        self.experiments: list[ExperimentRecord] = []
        self._counter = 0

    # --- baselines --------------------------------------------------------

    def record_baseline(
        self,
        name: str,
        metrics: Mapping[str, float],
        *,
        specs: Sequence[MetricSpec] | None = None,
        dataset_digest: str | None = None,
        corpus_size: int | None = None,
        hardware: Mapping | None = None,
        config: Mapping | None = None,
        notes: str = "",
    ) -> Baseline:
        """Freeze a measurement as the reference for later variants."""
        chosen = tuple(specs) if specs is not None else self.default_specs
        if not chosen:
            raise ValueError("a baseline needs at least one metric spec")
        unknown = [spec.name for spec in chosen if spec.name not in metrics]
        if unknown:
            raise ValueError(f"baseline '{name}' is missing values for: {', '.join(unknown)}")
        extra = sorted(set(metrics) - {spec.name for spec in chosen})
        if name in self.baselines:
            raise ValueError(
                f"baseline '{name}' already exists; record a new name rather than overwriting it, "
                "so past verdicts stay verifiable"
            )
        baseline = Baseline(
            name=name,
            metrics={key: float(value) for key, value in metrics.items()},
            specs=chosen,
            dataset_digest=dataset_digest,
            corpus_size=corpus_size,
            hardware=dict(hardware or {}),
            config=dict(config or {}),
            notes=notes,
            extra_metrics=extra,
        )
        self.baselines[name] = baseline
        return baseline

    def baseline(self, name: str) -> Baseline:
        try:
            return self.baselines[name]
        except KeyError:
            raise KeyError(f"unknown baseline '{name}'; recorded: {sorted(self.baselines)}") from None

    # --- experiments ------------------------------------------------------

    def run_experiment(
        self,
        hypothesis: Hypothesis,
        baseline_name: str,
        measure: Callable[[], Mapping[str, float]],
        *,
        dataset_digest: str | None = None,
        corpus_size: int | None = None,
        hardware: Mapping | None = None,
        config: Mapping | None = None,
        resource_usage: Mapping | None = None,
        strict_control: bool = True,
    ) -> ExperimentRecord:
        """Run a controlled experiment and record the verdict.

        ``measure`` is called once and must return the variant's metrics, measured
        on the same data as the baseline. If the control fields disagree with the
        baseline's, the comparison is refused rather than recorded as a win.
        """
        baseline = self.baseline(baseline_name)

        variant_control = Baseline(
            name="variant",
            metrics={},
            specs=baseline.specs,
            dataset_digest=dataset_digest if dataset_digest is not None else baseline.dataset_digest,
            corpus_size=corpus_size if corpus_size is not None else baseline.corpus_size,
            hardware=dict(hardware or baseline.hardware),
        ).control_fingerprint()

        if strict_control and variant_control != baseline.control_fingerprint():
            raise ControlMismatchError(
                f"variant was measured under different conditions than baseline '{baseline_name}' "
                f"({variant_control} != {baseline.control_fingerprint()}); "
                "an uncontrolled comparison cannot support an accept/reject verdict"
            )

        specs = list(baseline.specs) + list(hypothesis.extra_specs)
        started = time.perf_counter()
        try:
            measured = dict(measure())
        except Exception as error:  # noqa: BLE001 - recorded, never swallowed
            record = self._record(
                hypothesis, baseline, {}, ExperimentVerdict.INCONCLUSIVE,
                [f"measurement failed: {type(error).__name__}: {error}"], {},
                variant_control, dataset_digest, config, resource_usage, time.perf_counter() - started,
            )
            self.experiments.append(record)
            return record
        duration = time.perf_counter() - started

        missing = [spec.name for spec in specs if spec.name not in measured]
        if missing:
            record = self._record(
                hypothesis, baseline, measured, ExperimentVerdict.INCONCLUSIVE,
                [f"the variant did not report: {', '.join(missing)}"], {},
                variant_control, dataset_digest, config, resource_usage, duration,
            )
            self.experiments.append(record)
            return record

        verdict, reasons, deltas = self.judge(hypothesis, baseline, measured, specs)
        record = self._record(
            hypothesis, baseline, measured, verdict, reasons, deltas,
            variant_control, dataset_digest, config, resource_usage, duration,
        )
        self.experiments.append(record)
        return record

    def judge(
        self,
        hypothesis: Hypothesis,
        baseline: Baseline,
        variant_metrics: Mapping[str, float],
        specs: Sequence[MetricSpec] | None = None,
    ) -> tuple[ExperimentVerdict, list[str], dict]:
        """Apply the accept/reject rule and explain it."""
        chosen = list(specs) if specs is not None else list(baseline.specs)
        reasons: list[str] = []
        deltas: dict[str, dict] = {}

        target_spec = next((spec for spec in chosen if spec.name == hypothesis.target_metric), None)
        if target_spec is None:
            return (
                ExperimentVerdict.INCONCLUSIVE,
                [f"target metric '{hypothesis.target_metric}' is not part of this comparison"],
                {},
            )

        for spec in chosen:
            base_value = baseline.metrics.get(spec.name)
            variant_value = variant_metrics.get(spec.name)
            if base_value is None or variant_value is None:
                continue
            entry = {
                "baseline": base_value,
                "variant": variant_value,
                "delta": round(spec.delta(base_value, variant_value), 6),
                "relativeDelta": spec.relative_delta(base_value, variant_value),
                "direction": spec.direction,
                "tolerance": spec.tolerance,
                "regressed": spec.regressed(base_value, variant_value),
            }
            deltas[spec.name] = entry

        # 1. No guarded metric may regress. This is checked before the target,
        #    so a big win on MRR cannot mask a latency blowout.
        for spec in chosen:
            entry = deltas.get(spec.name)
            if not entry or not spec.guarded:
                continue
            if entry["regressed"]:
                note = (
                    f"{spec.name} regressed: {entry['baseline']:.4f} -> {entry['variant']:.4f} "
                    f"(tolerance {spec.tolerance:.0%})"
                )
                if spec.category is BenchmarkCategory.HISTORICAL_FAILURES:
                    note += " — a previously fixed failure broke again; this is never acceptable"
                reasons.append(note)

        # 2. The target metric must move by at least the claimed minimum.
        target_entry = deltas.get(hypothesis.target_metric)
        supported = False
        if target_entry:
            base_value = target_entry["baseline"]
            variant_value = target_entry["variant"]
            supported = target_spec.improved(base_value, variant_value, min_delta=hypothesis.min_improvement)
            if supported:
                relative = target_entry["relativeDelta"]
                shown = f" ({relative:+.1%})" if relative is not None else ""
                reasons.append(
                    f"target '{hypothesis.target_metric}' improved "
                    f"{base_value:.4f} -> {variant_value:.4f}{shown}, "
                    f"meeting the required +{hypothesis.min_improvement:.4f}"
                )
            else:
                reasons.append(
                    f"target '{hypothesis.target_metric}' did not improve by "
                    f"{hypothesis.min_improvement:.4f}: {base_value:.4f} -> {variant_value:.4f}"
                )

        regressions = [name for name, entry in deltas.items() if entry["regressed"]]
        if regressions:
            return ExperimentVerdict.REJECT, reasons, deltas
        if not supported:
            return ExperimentVerdict.REJECT, reasons, deltas
        return ExperimentVerdict.ACCEPT, reasons, deltas

    def _record(self, hypothesis, baseline, measured, verdict, reasons, deltas,
                control, dataset_digest, config, resource_usage, duration) -> ExperimentRecord:
        self._counter += 1
        return ExperimentRecord(
            experiment_id=f"exp-{self._counter:04d}",
            hypothesis=hypothesis,
            baseline_name=baseline.name,
            baseline_metrics=dict(baseline.metrics),
            variant_metrics={key: float(value) for key, value in measured.items()},
            verdict=verdict,
            reasons=reasons,
            deltas=deltas,
            control_fingerprint=control,
            created_at=time.time(),
            duration_seconds=round(duration, 4),
            config=dict(config or {}),
            dataset_digest=dataset_digest if dataset_digest is not None else baseline.dataset_digest,
            resource_usage=dict(resource_usage or {}),
        )

    # --- inspection -------------------------------------------------------

    def accepted(self) -> list[ExperimentRecord]:
        return [record for record in self.experiments if record.verdict is ExperimentVerdict.ACCEPT]

    def rejected(self) -> list[ExperimentRecord]:
        return [record for record in self.experiments if record.verdict is ExperimentVerdict.REJECT]

    def for_baseline(self, name: str) -> list[ExperimentRecord]:
        return [record for record in self.experiments if record.baseline_name == name]

    def summary(self) -> dict:
        counts = {verdict.value: 0 for verdict in ExperimentVerdict}
        for record in self.experiments:
            counts[record.verdict.value] += 1
        return {
            "baselines": sorted(self.baselines),
            "experiments": len(self.experiments),
            "verdicts": counts,
            "acceptRate": round(counts["accept"] / len(self.experiments), 4) if self.experiments else 0.0,
        }

    def compare(self, variant_metrics: Mapping[str, float], baseline_name: str) -> dict:
        """Side-by-side comparison against an unchanged baseline."""
        baseline = self.baseline(baseline_name)
        rows = []
        for spec in baseline.specs:
            base_value = baseline.metrics.get(spec.name)
            variant_value = variant_metrics.get(spec.name)
            if base_value is None or variant_value is None:
                continue
            rows.append({
                "metric": spec.name,
                "direction": spec.direction,
                "baseline": base_value,
                "variant": variant_value,
                "delta": round(spec.delta(base_value, variant_value), 6),
                "relativeDelta": spec.relative_delta(base_value, variant_value),
                "regressed": spec.regressed(base_value, variant_value),
            })
        return {"baseline": baseline_name, "rows": rows}

    # --- persistence ------------------------------------------------------

    def to_dict(self) -> dict:
        return {
            "format": "aetheris-experiment-ledger/1",
            "baselines": {name: baseline.to_dict() for name, baseline in self.baselines.items()},
            "experiments": [record.to_dict() for record in self.experiments],
            "summary": self.summary(),
        }

    def save(self, path) -> Path:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(self.to_dict(), indent=2, sort_keys=True), encoding="utf-8")
        return target

    def digest(self) -> str:
        encoded = json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()
