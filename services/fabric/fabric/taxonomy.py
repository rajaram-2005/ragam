"""Taxonomies adopted from the Sparsiz research repository.

Provenance
----------
The enumerations in this module are taken from ``sparsiz`` (Unlicense / public
domain), specifically:

* ``training/failure-memory/failure_memory.py`` — ``FailureCategory`` (13
  members) and ``RootCause`` (9 members)
* ``training/evaluation/evaluation.py`` — ``BenchmarkCategory`` (17 members,
  upstream lists 18 including ``HISTORICAL_FAILURES``)

They are reproduced deliberately, unchanged in meaning, because they are the one
part of the upstream training stack that is real: a classification vocabulary is
a design decision, not a simulation. Everything upstream *computed* from these
labels was randomised (``evaluation.py:52`` scores a benchmark with
``random.uniform(0.5, 0.8)`` under the comment "Mock evaluation — in production
would run actual benchmarks"), so the scoring is replaced here rather than
imported. See ``docs/01-audit.md`` §2.

Two additions are made and marked as such: ``FailureCategory.RETRIEVAL_GROUNDING``
and ``RootCause.POLICY``. Aetheris Omni's own failure modes include ungrounded
citations and policy refusals, which have no upstream label; inventing a silent
overlap with ``RETRIEVAL`` or ``DATA`` would make the ledger ambiguous.
"""

from __future__ import annotations

from enum import Enum

__all__ = [
    "FailureCategory",
    "RootCause",
    "BenchmarkCategory",
    "DataQualityTier",
    "ExperimentVerdict",
    "StageStatus",
    "failure_categories",
    "root_causes",
    "benchmark_categories",
]


class FailureCategory(Enum):
    """What kind of thing went wrong. Upstream: 13 members, unchanged."""

    HALLUCINATION = "hallucination"
    REASONING = "reasoning"
    MATHEMATICS = "mathematics"
    CODING = "coding"
    RETRIEVAL = "retrieval"
    TOOL_USAGE = "tool_usage"
    VISION = "vision"
    AUDIO = "audio"
    LONG_CONTEXT = "long_context"
    PHYSICS = "physics"
    PLANNING = "planning"
    SAFETY = "safety"
    AGENT_COORDINATION = "agent_coordination"

    # --- Aetheris additions (not upstream) --------------------------------
    #: A citation was produced that does not support the claim, or evidence was
    #: claimed where none was retrieved. Distinct from RETRIEVAL, which covers
    #: the search itself failing to find the right chunk.
    RETRIEVAL_GROUNDING = "retrieval_grounding"


class RootCause(Enum):
    """Why it went wrong. Upstream: 9 members, unchanged."""

    DATA = "DATA"
    MODEL = "MODEL"
    REASONING = "REASONING"
    RETRIEVAL = "RETRIEVAL"
    TOOL = "TOOL"
    TRAINING = "TRAINING"
    ARCHITECTURE = "ARCHITECTURE"
    CONTEXT = "CONTEXT"
    HARDWARE = "HARDWARE"

    # --- Aetheris addition (not upstream) ---------------------------------
    #: The runtime policy or egress guard refused the operation. This is a
    #: correct outcome, not a defect, but it must still be classifiable so that
    #: a policy refusal is never mis-filed as a MODEL failure and "fixed" by
    #: retraining.
    POLICY = "POLICY"


class BenchmarkCategory(Enum):
    """What a benchmark measures. Upstream vocabulary, unchanged."""

    LANGUAGE = "language"
    REASONING = "reasoning"
    MATHEMATICS = "mathematics"
    CODING = "coding"
    VISION = "vision"
    AUDIO = "audio"
    MULTIMODAL = "multimodal"
    LONG_CONTEXT = "long_context"
    AGENTS = "agents"
    TOOL_USE = "tool_use"
    PHYSICS = "physics"
    EEE = "eee"
    SAFETY = "safety"
    ROBUSTNESS = "robustness"
    LATENCY = "latency"
    ENERGY = "energy"
    MEMORY = "memory"
    HISTORICAL_FAILURES = "historical_failures"

    # --- Aetheris addition (not upstream) ---------------------------------
    #: Retrieval quality over the private company corpus: Recall@k, MRR and
    #: citation support. This is the category the Aetheris Lite retriever is
    #: actually evaluated in on this host.
    RETRIEVAL = "retrieval"


class DataQualityTier(Enum):
    """Upstream tiers from ``dataforge.py``; thresholds kept identical.

    BAD < 0.3 <= MEDIUM < 0.6 <= HIGH < 0.85 <= ELITE
    """

    BAD = "bad"
    MEDIUM = "medium"
    HIGH = "high"
    ELITE = "elite"

    @classmethod
    def for_score(cls, score: float) -> "DataQualityTier":
        """Map a Q(x) score onto a tier using the upstream thresholds."""
        if score < 0.3:
            return cls.BAD
        if score < 0.6:
            return cls.MEDIUM
        if score < 0.85:
            return cls.HIGH
        return cls.ELITE


class ExperimentVerdict(Enum):
    """Outcome of the Sparsiz improvement cycle's final step."""

    #: The variant beat the unchanged baseline on the target metric and did not
    #: regress any guarded metric.
    ACCEPT = "accept"
    #: The variant failed to beat the baseline, or regressed a guarded metric.
    REJECT = "reject"
    #: The run did not produce a comparable result (crash, timeout, missing
    #: baseline). Recorded rather than discarded, so the attempt is visible.
    INCONCLUSIVE = "inconclusive"


class StageStatus(Enum):
    """Honest status of one pipeline stage.

    The distinction that matters is between a stage that ran and a stage that
    could not run here. ``BLOCKED_NEEDS_WEIGHTS`` and ``BLOCKED_NEEDS_HARDWARE``
    are not failures and are not successes; they say exactly what is missing.
    """

    COMPLETED = "completed"
    SKIPPED = "skipped"
    FAILED = "failed"
    BLOCKED_NEEDS_WEIGHTS = "blocked_needs_weights"
    BLOCKED_NEEDS_HARDWARE = "blocked_needs_hardware"
    BLOCKED_NEEDS_CREDENTIALS = "blocked_needs_credentials"

    @property
    def blocked(self) -> bool:
        return self.name.startswith("BLOCKED")

    @property
    def ran(self) -> bool:
        return self is StageStatus.COMPLETED


def failure_categories() -> list[str]:
    return [member.value for member in FailureCategory]


def root_causes() -> list[str]:
    return [member.value for member in RootCause]


def benchmark_categories() -> list[str]:
    return [member.value for member in BenchmarkCategory]
