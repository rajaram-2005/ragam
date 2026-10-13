"""L4: does a strategy chosen on one task family transfer to a different one?

The meta-learning ladder steps from L3 (a validated procedure, reused) to L4: a
*strategy* learned while solving one kind of task has to be tested on a different kind
of task, and the answer recorded either way -- **including when it does not
generalise**. A lesson that is never tested for generality is a lesson that will be
applied where it does not hold.

Scope, stated plainly
---------------------
The only tasks in this repository that can be measured end to end are retrieval tasks
over the generated engineering corpus (``fabric/dataset.py``). So "task family" here
means a group of topics: the corpus has 24 topics with largely disjoint vocabularies,
and a query about contactors and isolation resistance really is a different task from
a query about CAN bus arbitration and coolant flow. The strategy is the fusion policy
that combines the lexical and dense rankers -- the only place in this system where
several defensible strategies exist and none is obviously right.

This module does no I/O and trains nothing. It takes measurements (produced by
``scripts/l4_transfer.py``) and applies a protocol fixed *before* the numbers exist,
because a threshold chosen after seeing the result is not a test.

The protocol
------------
1. **Development.** Every candidate strategy is measured on the development family
   only. A strategy becomes a *lesson* if it beats the a-priori baseline -- equal-trust
   fusion, the ``0.5/0.5`` chosen a priori in ``hybrid.py`` -- by ``MIN_GAIN`` on the
   primary metric, with the paired difference in the same direction in **every** seed.
   The every-seed rule is not caution for its own sake: the improvement cycle recorded
   in ``docs/07-improvement-cycle.md`` saw a mean gain reverse in three runs out of
   three, and a mean-only reading of that data would have shipped it.

2. **Transfer.** The lesson is applied unchanged to target families that no step of
   the selection has seen, and compared with the same baseline there. Paired: the same
   seed means the same corpus and the same trained encoder for every strategy, so a
   difference is attributable to the strategy and not to a lucky model.

3. **Verdict.** ``transferred`` (mean gain clears the threshold with no seed against
   it), ``did_not_transfer`` (mean gain is zero or negative -- the lesson does not hold
   there), ``inconclusive`` (positive but under the threshold, or seeds disagree), or
   ``no_lesson`` (nothing beat the baseline on the development family, so there was
   nothing to transfer). The report also carries the full ranking of every strategy on
   every family, because "the best strategy depends on the family" is the finding that
   matters more than any single verdict.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Callable, Collection, Mapping, Sequence

from .hybrid import fuse_rankings
from .text import content_tokens, stem

# --- pre-registered constants -------------------------------------------------
#: The primary metric. Chosen before the experiment: mean reciprocal rank is what
#: "the answer came back near the top" means, and it is the metric the retriever's
#: release gate already uses.
PRIMARY_METRIC = "mrr"
#: Reported alongside, never used to pick a winner.
SECONDARY_METRIC = "recall@5"
#: Absolute gain on the primary metric that counts as a real difference. The
#: retrieval measurements in docs/06 have a seed spread an order of magnitude larger
#: than this, so this is a floor for "worth calling a lesson", not a significance test.
MIN_GAIN = 0.01
#: Fewer seeds than this and the every-seed rule is not informative.
MIN_SEEDS = 3
#: The a-priori baseline: equal trust in lexical and dense evidence, chosen in
#: hybrid.py without tuning. Every lesson has to beat *this*, not just the other
#: candidates, or "learned" would mean "beat the worst option".
BASELINE_STRATEGY = "equal-trust"


@dataclass(frozen=True)
class Strategy:
    """A fusion policy: how much to trust the lexical ranker for a given query.

    ``weights`` returns ``(w_lexical, w_dense)``. It receives the query and the
    corpus vocabulary, which is all a policy may look at: the judgements are not
    available at ranking time, and a policy that used them would be cheating on the
    only question being asked.
    """

    name: str
    description: str
    lesson: str
    weights: Callable[[str, Collection[str]], tuple[float, float]]

    def weight_for(self, query: str, vocabulary: Collection[str]) -> tuple[float, float]:
        lexical, dense = self.weights(query, vocabulary)
        if lexical < 0 or dense < 0 or (lexical + dense) <= 0:
            raise ValueError(f"strategy '{self.name}' produced unusable weights {(lexical, dense)}")
        return float(lexical), float(dense)

    def rank(
        self,
        query: str,
        *,
        lexical: Sequence[str],
        dense: Sequence[str],
        vocabulary: Collection[str],
        top_k: int = 10,
    ) -> list[str]:
        """Fuse two rankings under this policy. Same inputs, same output, always."""
        return fuse_rankings([list(lexical), list(dense)], self.weight_for(query, vocabulary), top_k=top_k)


def lexical_coverage(query: str, vocabulary: Collection[str]) -> float:
    """Fraction of the query's content terms the lexical index can match at all.

    Only stemmed content terms count: a stopword carries no discriminative evidence,
    and the index stems before it looks anything up. An empty query has no terms to
    cover and returns 0.0 rather than raising, because a ranker that returns nothing
    for an empty query is behaving correctly.
    """
    terms = {stem(token) for token in content_tokens(query)}
    if not terms:
        return 0.0
    return sum(1 for term in terms if term in vocabulary) / len(terms)


def _clamped_lexical(query: str, vocabulary: Collection[str]) -> float:
    # The floor and ceiling keep an adaptive policy from collapsing into one of the
    # two rankers, which are already candidates in their own right. A policy that
    # degenerates to "use only BM25" is not testing adaptation; it is testing BM25.
    return min(0.9, max(0.1, lexical_coverage(query, vocabulary)))


STRATEGIES: tuple[Strategy, ...] = (
    Strategy(
        name="lexical-only",
        description="BM25 alone. No fusion.",
        lesson="The baseline the corpus was built around.",
        weights=lambda query, vocabulary: (1.0, 0.0),
    ),
    Strategy(
        name="dense-only",
        description="Trained dual encoder alone. No fusion.",
        lesson="The failure that started this: dense alone loses recall on wording it has not seen.",
        weights=lambda query, vocabulary: (0.0, 1.0),
    ),
    Strategy(
        name="equal-trust",
        description="0.5/0.5 rank fusion, weights chosen a priori.",
        lesson="The recorded correction: keep the lexical ranker's recall, take the dense ranker's ordering.",
        weights=lambda query, vocabulary: (0.5, 0.5),
    ),
    Strategy(
        name="coverage-weighted",
        description="Trust lexical evidence in proportion to how much of the query it can match.",
        lesson="Read the same failure forwards: lexical evidence is worth more when the index knows the words.",
        weights=lambda query, vocabulary: (
            _clamped_lexical(query, vocabulary),
            1.0 - _clamped_lexical(query, vocabulary),
        ),
    ),
    Strategy(
        name="coverage-inverse",
        description="Trust lexicon inversely to its coverage: lean on the encoder for unknown wording.",
        lesson=(
            "Read the same failure backwards: exactly the alternative reading, "
            "included so the direction is tested rather than assumed."
        ),
        weights=lambda query, vocabulary: (
            1.0 - _clamped_lexical(query, vocabulary),
            _clamped_lexical(query, vocabulary),
        ),
    ),
)

STRATEGY_BY_NAME: dict[str, Strategy] = {strategy.name: strategy for strategy in STRATEGIES}


def split_families(topics: Sequence[str], *, held_out_modulus: int = 2) -> dict[str, list[str]]:
    """Partition topics into a development half and a held-out half, interleaved.

    Interleaved rather than "first half, second half": the topic list is authored in
    groups (the first topics are contactor, isolation, thermal, balancing...), so a
    contiguous split would put related subjects on one side and call the result two
    families. Taking every second topic after sorting makes the split a property of
    the list's order rather than of its subject grouping, which is the weaker
    assumption.
    """
    if held_out_modulus < 2:
        raise ValueError("held_out_modulus must be at least 2")
    ordered = sorted(topics)
    if len(ordered) < 2 * held_out_modulus:
        raise ValueError(f"need at least {2 * held_out_modulus} topics to split, got {len(ordered)}")
    development = [topic for index, topic in enumerate(ordered) if index % held_out_modulus != 0]
    heldout = [topic for index, topic in enumerate(ordered) if index % held_out_modulus == 0]
    return {"development": development, "held-out": heldout}


# --- the protocol -------------------------------------------------------------


def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _paired(
    measurements: Mapping, family: str, seed: int, name: str, metric: str = PRIMARY_METRIC
) -> float | None:
    """One metric for one (family, seed, strategy). ``None`` if absent."""
    record = measurements.get((family, seed, name))
    if record is None:
        return None
    value = record.get(metric)
    return None if value is None else float(value)


def _versus_baseline(
    measurements: Mapping, family: str, seeds: Sequence[int], metric: str = PRIMARY_METRIC
) -> list[dict]:
    """Every strategy's paired difference against the baseline, on one family.

    A ranking on its own invites reading a 0.0003 gap as a result. The paired deltas
    and the count of seeds on each side are what say whether the gap is a finding or
    a coin flip, so they travel with the ranking rather than being derived later by
    whoever wants the answer to come out a particular way.
    """
    baseline = [_paired(measurements, family, seed, BASELINE_STRATEGY, metric) for seed in seeds]
    rows = []
    for strategy in STRATEGIES:
        if strategy.name == BASELINE_STRATEGY:
            continue
        values = [_paired(measurements, family, seed, strategy.name, metric) for seed in seeds]
        deltas = [value - base for value, base in zip(values, baseline) if value is not None and base is not None]
        if not deltas:
            rows.append({"strategy": strategy.name, "meanDelta": None, "deltas": [], "positiveSeeds": 0,
                         "negativeSeeds": 0, "tiedSeeds": 0, "missing": True})
            continue
        positive = sum(1 for delta in deltas if delta > 0)
        negative = sum(1 for delta in deltas if delta < 0)
        rows.append({
            "strategy": strategy.name,
            "meanDelta": round(_mean(deltas), 6),
            "minDelta": round(min(deltas), 6),
            "maxDelta": round(max(deltas), 6),
            "deltas": [round(delta, 6) for delta in deltas],
            "positiveSeeds": positive,
            "negativeSeeds": negative,
            "tiedSeeds": len(deltas) - positive - negative,
            "missing": False,
        })
    rows.sort(key=lambda row: (-(row["meanDelta"] if row["meanDelta"] is not None else -1), row["strategy"]))
    return rows


def _rank_strategies(measurements: Mapping, family: str, seeds: Sequence[int]) -> list[dict]:
    rows = []
    for strategy in STRATEGIES:
        values = [_paired(measurements, family, seed, strategy.name) for seed in seeds]
        present = [value for value in values if value is not None]
        if not present:
            continue
        rows.append({
            "strategy": strategy.name,
            "mean": round(_mean(present), 6),
            "seeds": len(present),
            "missing": [seed for seed, value in zip(seeds, values) if value is None],
        })
    rows.sort(key=lambda row: (-row["mean"], row["strategy"]))
    for position, row in enumerate(rows, start=1):
        row["rank"] = position
    return rows


@dataclass
class TransferReport:
    """Everything the protocol concluded, including the parts that failed."""

    protocol: dict
    families: dict
    development: dict
    targets: list[dict]
    verdicts: dict
    notes: list[str] = field(default_factory=list)

    @property
    def transferred(self) -> bool:
        return any(verdict == "transferred" for verdict in self.verdicts.values())

    def to_dict(self) -> dict:
        return {
            "protocol": self.protocol,
            "families": self.families,
            "development": self.development,
            "targets": self.targets,
            "verdicts": self.verdicts,
            "notes": list(self.notes),
        }

    def to_json(self, *, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent, sort_keys=False)

    def summary(self) -> str:
        lines = [f"development family {self.development['family']} "
                 f"({self.development['seeds']} seeds) -> {self.development['verdict']}"]
        if self.development.get("lesson"):
            lines.append(f"  lesson: {self.development['lesson']}")
        for target in self.targets:
            lines.append(
                f"  {target['family']}: {target['verdict']} "
                f"(mean delta {target['meanDelta']:+.6f}, "
                f"{target['positiveSeeds']} up / {target['negativeSeeds']} down / {target['tiedSeeds']} tied)"
            )
        for note in self.notes:
            lines.append(f"  note: {note}")
        return "\n".join(lines)


def run_transfer(
    measurements: Mapping,
    *,
    development_family: str,
    target_families: Sequence[str],
    seeds: Sequence[int],
    families: Mapping[str, dict] | None = None,
) -> TransferReport:
    """Apply the protocol to a table of measurements.

    ``measurements`` maps ``(family, seed, strategy_name)`` to a metrics mapping.
    Every strategy must be measured on every family for every seed; a missing cell is
    reported in the ranking rather than silently skipped, because a strategy that was
    never run is not a strategy that lost.
    """
    seeds = tuple(int(seed) for seed in seeds)
    if len(seeds) < MIN_SEEDS:
        raise ValueError(f"the protocol needs at least {MIN_SEEDS} seeds, got {len(seeds)}")
    if BASELINE_STRATEGY not in STRATEGY_BY_NAME:
        raise ValueError(f"the baseline strategy '{BASELINE_STRATEGY}' is not among the candidates")

    # --- 1. development: selection may look at nothing else -------------------
    development_ranking = _rank_strategies(measurements, development_family, seeds)
    if not development_ranking:
        raise ValueError(f"no measurements for the development family '{development_family}'")

    baseline_values = [_paired(measurements, development_family, seed, BASELINE_STRATEGY) for seed in seeds]
    if any(value is None for value in baseline_values):
        raise ValueError("the baseline strategy is missing from the development family; nothing can be paired")

    per_strategy = {}
    for strategy in STRATEGIES:
        values = [_paired(measurements, development_family, seed, strategy.name) for seed in seeds]
        deltas = [None if value is None else value - baseline for value, baseline in zip(values, baseline_values)]
        present = [delta for delta in deltas if delta is not None]
        secondary = [
            _paired(measurements, development_family, seed, strategy.name, SECONDARY_METRIC) for seed in seeds
        ]
        secondary_baseline = [
            _paired(measurements, development_family, seed, BASELINE_STRATEGY, SECONDARY_METRIC) for seed in seeds
        ]
        secondary_deltas = [
            value - base
            for value, base in zip(secondary, secondary_baseline)
            if value is not None and base is not None
        ]
        per_strategy[strategy.name] = {
            "mean": round(_mean([value for value in values if value is not None]), 6),
            "meanDelta": round(_mean(present), 6) if present else None,
            "deltas": [None if delta is None else round(delta, 6) for delta in deltas],
            "secondaryMeanDelta": round(_mean(secondary_deltas), 6) if secondary_deltas else None,
            "secondaryDeltas": [round(delta, 6) for delta in secondary_deltas],
            "missing": [seed for seed, value in zip(seeds, values) if value is None],
        }

    # A lesson must beat the baseline in every seed, not on average: the recorded
    # failure mode in this repository is a mean gain that reverses in every run.
    lessons = [
        name for name, row in per_strategy.items()
        if name != BASELINE_STRATEGY
        and row["meanDelta"] is not None
        and row["meanDelta"] >= MIN_GAIN
        and not row["missing"]
        and all(delta is not None and delta > 0 for delta in row["deltas"])
    ]
    lessons.sort(key=lambda name: (-per_strategy[name]["meanDelta"], name))
    lesson = lessons[0] if lessons else None

    # The best strategy on the development family, whether or not it cleared the
    # lesson bar. Tracking it to the target families is informative even when no
    # lesson qualified: "the best strategy depends on the family" is a finding, and
    # withholding it because nothing cleared a threshold would hide evidence rather
    # than report it. The two are labelled differently and never confused.
    development_winner = development_ranking[0]["strategy"]

    development = {
        "family": development_family,
        "seeds": len(seeds),
        "seedValues": list(seeds),
        "baseline": BASELINE_STRATEGY,
        "ranking": development_ranking,
        "winner": development_winner,
        "perStrategy": per_strategy,
        "versusBaseline": _versus_baseline(measurements, development_family, seeds),
        # The registered secondary metric, carried in full. No verdict is derived from
        # it: one decision rule stated in advance, not two chances to declare a win.
        "versusBaselineSecondary": _versus_baseline(measurements, development_family, seeds, SECONDARY_METRIC),
        "secondaryMetric": SECONDARY_METRIC,
        "lesson": lesson,
        "verdict": "lesson" if lesson else "no_lesson",
        "rule": f"mean delta >= {MIN_GAIN} on {PRIMARY_METRIC} and the same direction in every seed",
    }

    notes = []
    if lesson is None and development_winner == BASELINE_STRATEGY:
        notes.append(
            f"the best strategy on the development family is the baseline '{BASELINE_STRATEGY}' itself, "
            "so the paired deltas below are zero by construction. The evidence in this run is the "
            "per-strategy comparison against that baseline on each family, not the subject line."
        )
    if lesson is None:
        notes.append(
            f"no candidate beat the a-priori baseline '{BASELINE_STRATEGY}' under the registered rule, "
            "so there was no lesson to transfer. The target families below are still measured and "
            "reported as observations, without a transfer claim."
        )

    # --- 2. transfer: the candidate goes to families selection never saw ------
    # With a lesson, the subject is the lesson and the verdicts are claims. Without
    # one, the subject is the development winner and the verdicts are observations.
    subject = lesson if lesson else development_winner
    targets = []
    verdicts = {development_family: "lesson" if lesson else "no_lesson"}
    for family in target_families:
        lesson_values = [_paired(measurements, family, seed, subject) for seed in seeds]
        family_baseline = [_paired(measurements, family, seed, BASELINE_STRATEGY) for seed in seeds]
        pairs = [
            (value, base)
            for value, base in zip(lesson_values, family_baseline)
            if value is not None and base is not None
        ]
        if len(pairs) < MIN_SEEDS:
            record = {
                "family": family,
                "subject": subject,
                "verdict": "not_run",
                "positiveSeeds": 0, "negativeSeeds": 0, "tiedSeeds": 0,
                "meanDelta": 0.0, "deltas": [],
                "note": f"only {len(pairs)} paired seeds; needs {MIN_SEEDS}",
            }
            targets.append(record)
            verdicts[family] = "not_run"
            notes.append(f"{family} could not be judged: {record['note']}")
            continue

        deltas = [value - base for value, base in pairs]
        mean_delta = _mean(deltas)
        secondary_pairs = [
            (value, base)
            for value, base in zip(
                [_paired(measurements, family, seed, subject, SECONDARY_METRIC) for seed in seeds],
                [_paired(measurements, family, seed, BASELINE_STRATEGY, SECONDARY_METRIC) for seed in seeds],
            )
            if value is not None and base is not None
        ]
        secondary_deltas = [value - base for value, base in secondary_pairs]
        positive = sum(1 for delta in deltas if delta > 0)
        negative = sum(1 for delta in deltas if delta < 0)
        tied = len(deltas) - positive - negative
        if not lesson:
            # No claim: nothing cleared the development bar, so these numbers say
            # what the development winner did elsewhere, not that a lesson held.
            verdict = "observed"
        elif mean_delta <= 0:
            verdict = "did_not_transfer"
        elif mean_delta >= MIN_GAIN and negative == 0 and positive >= MIN_SEEDS:
            verdict = "transferred"
        else:
            verdict = "inconclusive"

        ranking = _rank_strategies(measurements, family, seeds)
        winner = ranking[0]["strategy"] if ranking else None
        record = {
            "family": family,
            "subject": subject,
            "subjectIsLesson": bool(lesson),
            "baseline": round(_mean([base for _, base in pairs]), 6),
            "lessonMean": round(_mean([value for value, _ in pairs]), 6),
            "meanDelta": round(mean_delta, 6),
            "deltas": [round(delta, 6) for delta in deltas],
            "secondaryMetric": SECONDARY_METRIC,
            "secondaryMeanDelta": round(_mean(secondary_deltas), 6) if secondary_deltas else None,
            "secondaryDeltas": [round(delta, 6) for delta in secondary_deltas],
            "positiveSeeds": positive,
            "negativeSeeds": negative,
            "tiedSeeds": tied,
            "verdict": verdict,
            "ranking": ranking,
            "versusBaseline": _versus_baseline(measurements, family, seeds),
            "versusBaselineSecondary": _versus_baseline(measurements, family, seeds, SECONDARY_METRIC),
            "winner": winner,
            "winnerAgreesWithDevelopment": winner == development_ranking[0]["strategy"],
        }
        targets.append(record)
        verdicts[family] = verdict
        if verdict == "did_not_transfer":
            notes.append(
                f"'{subject}' did not generalise to {family}: the mean paired difference is "
                f"{mean_delta:+.6f} ({negative} seed(s) down, {positive} up). Recorded as a "
                "non-generalisation rather than dropped; the development-family gain stands."
            )
        elif verdict == "inconclusive":
            notes.append(
                f"'{subject}' on {family} is inconclusive: mean paired difference {mean_delta:+.6f} "
                f"against a threshold of {MIN_GAIN} with {negative} seed(s) against it."
            )
        elif verdict == "observed" and not record["winnerAgreesWithDevelopment"]:
            notes.append(
                f"the development winner '{subject}' is not the winner on {family} "
                f"('{record['winner']}' is). No transfer claim is made here: nothing cleared the "
                "development bar, so this says the best strategy is family-dependent, nothing more."
            )

    return TransferReport(
        protocol=_protocol_block(seeds),
        families=_family_block(families),
        development=development,
        targets=targets,
        verdicts=verdicts,
        notes=notes,
    )


def _protocol_block(seeds: Sequence[int]) -> dict:
    return {
        "primaryMetric": PRIMARY_METRIC,
        "secondaryMetric": SECONDARY_METRIC,
        "minGain": MIN_GAIN,
        "minSeeds": MIN_SEEDS,
        "baseline": BASELINE_STRATEGY,
        "candidates": [strategy.name for strategy in STRATEGIES],
        "seeds": list(seeds),
        "lessonRule": f"mean delta >= {MIN_GAIN} and every seed the same direction",
        "transferRule": f"transferred needs mean delta >= {MIN_GAIN}, no seed against, and >= {MIN_SEEDS} seeds up",
    }


def _family_block(families: Mapping[str, dict] | None) -> dict:
    return {key: dict(value) for key, value in (families or {}).items()}
