"""Tests for the L4 transfer protocol.

The protocol exists to answer "did the lesson generalise?" with a verdict that can say
*no*. So the tests that matter most are the ones where the answer is no: a strategy
that wins on the development family and loses on a target must be recorded as a
non-generalisation, a mean gain that reverses in one seed must not become a lesson,
and a gap inside seed noise must never be reported as a transfer. A test suite that
only exercised the happy path would let a protocol that always says "transferred"
pass.

The measurements are synthetic here on purpose: the protocol is a decision procedure,
and a decision procedure should be tested on cases chosen for their shape. The real
measurements come from ``scripts/l4_transfer.py`` and are recorded in
``docs/experiments/l4-transfer.json``; one integration test at the bottom proves the
two halves connect.
"""

from __future__ import annotations

import json
import pathlib

import pytest

from fabric.transfer import (
    BASELINE_STRATEGY,
    MIN_GAIN,
    MIN_SEEDS,
    PRIMARY_METRIC,
    STRATEGIES,
    SECONDARY_METRIC,
    STRATEGY_BY_NAME,
    lexical_coverage,
    run_transfer,
    split_families,
)

SEEDS = (1, 2, 3, 4)
BASELINE = BASELINE_STRATEGY
DEV = "development-low"
TARGETS = ("held-out-low", "development-high")


def measurements(*, dev_delta=0.0, target_deltas=None, seeds=SEEDS, strategies=None):
    """Build a measurement table where one strategy is offset from the baseline.

    ``dev_delta`` shifts the named strategy on the development family; ``target_deltas``
    is a mapping family -> per-seed delta list, so a test can say "wins on two seeds,
    loses on the other two" and get exactly that.
    """
    strategies = strategies or ("coverage-weighted",)
    subject = strategies[0]
    table = {}
    for seed in seeds:
        for family in (DEV, *TARGETS):
            base = 0.50 + 0.01 * seed
            table[(family, seed, BASELINE)] = {PRIMARY_METRIC: base, "recall@5": base}
            if family == DEV:
                table[(family, seed, subject)] = {PRIMARY_METRIC: base + dev_delta, "recall@5": base + dev_delta}
            else:
                deltas = (target_deltas or {}).get(family, [0.0] * len(seeds))
                offset = deltas[seeds.index(seed)] if seed in seeds else 0.0
                table[(family, seed, subject)] = {PRIMARY_METRIC: base + offset, "recall@5": base + offset}
            # Every other candidate is held at the baseline, so the subject is the only
            # movement in the experiment and a failure has one cause.
            for name in ("lexical-only", "dense-only", "equal-trust", "coverage-inverse"):
                if name == subject or name == BASELINE:
                    continue
                table.setdefault((family, seed, name), {PRIMARY_METRIC: base, "recall@5": base})
    return table, subject


def go(table, *, seeds=SEEDS):
    return run_transfer(table, development_family=DEV, target_families=TARGETS, seeds=seeds)


# --- coverage and weights ------------------------------------------------------


class TestCoverage:
    def test_counts_only_terms_the_index_can_match(self):
        vocabulary = {"lockfile", "install", "stale"}
        assert lexical_coverage("lockfile install", vocabulary) == 1.0
        assert lexical_coverage("lockfile quantum", vocabulary) == 0.5

    def test_stopwords_do_not_count_as_coverage(self):
        # 'the' and 'of' are stripped before the index ever sees the query, so a query
        # made of them has nothing covered -- 1.0 would flatter every lexical strategy.
        assert lexical_coverage("the of and", {"the", "of", "and"}) == 0.0

    def test_an_empty_query_has_no_coverage_and_does_not_raise(self):
        assert lexical_coverage("", {"a"}) == 0.0

    def test_coverage_is_stemmed_like_the_index(self):
        assert lexical_coverage("installs", {"install"}) == 1.0


class TestStrategies:
    def test_every_strategy_yields_usable_weights_for_every_input(self):
        for strategy in STRATEGIES:
            for query in ("", "lockfile", "the of and", "quantum chromodynamics"):
                for vocabulary in (set(), {"lockfile"}):
                    lexical, dense = strategy.weight_for(query, vocabulary)
                    assert lexical >= 0 and dense >= 0
                    assert lexical + dense > 0, f"{strategy.name} produced a fusion with nothing to rank"

    def test_the_adaptive_strategies_cannot_collapse_into_a_component(self):
        # If an adaptive policy reached 0 or 1 it would just be one of the two rankers,
        # and the experiment would report a fusion result that was never fused.
        for name in ("coverage-weighted", "coverage-inverse"):
            strategy = STRATEGY_BY_NAME[name]
            for query in ("", "lockfile install stale", "the of and"):
                lexical, dense = strategy.weight_for(query, set())
                assert 0.1 <= lexical <= 0.9 and 0.1 <= dense <= 0.9, name

    def test_the_two_coverage_readings_are_opposite_in_both_directions(self):
        # Both directions, because one of them is the hypothesis and the other is its
        # mirror image. A test that only checked the comfortable direction would pass on
        # an implementation where both strategies were the same policy.
        vocabulary = {"lockfile", "install", "stale"}
        well_covered = "lockfile install stale json"   # 3 of 4 -> 0.75
        poorly_covered = "lockfile quantum chromodynamics entropy"  # 1 of 4 -> 0.25
        forward_high = STRATEGY_BY_NAME["coverage-weighted"].weight_for(well_covered, vocabulary)
        reverse_high = STRATEGY_BY_NAME["coverage-inverse"].weight_for(well_covered, vocabulary)
        forward_low = STRATEGY_BY_NAME["coverage-weighted"].weight_for(poorly_covered, vocabulary)
        reverse_low = STRATEGY_BY_NAME["coverage-inverse"].weight_for(poorly_covered, vocabulary)
        assert forward_high[0] == pytest.approx(0.75)
        assert reverse_high[0] == pytest.approx(0.25)
        assert forward_low[0] == pytest.approx(0.25)
        assert reverse_low[0] == pytest.approx(0.75)
        for pair in (forward_high, reverse_high, forward_low, reverse_low):
            assert abs((pair[0] + pair[1]) - 1.0) < 1e-12

    def test_ranking_is_deterministic_and_uses_both_rankings(self):
        strategy = STRATEGY_BY_NAME["equal-trust"]
        first = strategy.rank("q", lexical=["a", "b"], dense=["b", "c"], vocabulary=set())
        second = strategy.rank("q", lexical=["a", "b"], dense=["b", "c"], vocabulary=set())
        assert first == second
        assert first[0] == "b", "a document both rankers list must win an equal-trust fusion"


class TestFamilies:
    def test_the_split_is_disjoint_and_covers_every_topic(self):
        topics = [f"topic-{index}" for index in range(24)]
        groups = split_families(topics)
        assert set(groups) == {"development", "held-out"}
        assert sorted(groups["development"] + groups["held-out"]) == sorted(topics)
        assert not set(groups["development"]) & set(groups["held-out"])

    def test_the_split_interleaves_rather_than_taking_halves(self):
        groups = split_families([f"t{index:02d}" for index in range(6)])
        assert groups["development"] == ["t01", "t03", "t05"]
        assert groups["held-out"] == ["t00", "t02", "t04"]

    def test_a_tiny_topic_list_is_refused(self):
        with pytest.raises(ValueError):
            split_families(["only-one"])


# --- the verdicts -------------------------------------------------------------


class TestVerdicts:
    def test_a_lesson_that_holds_on_a_target_is_reported_as_transferred(self):
        table, subject = measurements(
            dev_delta=0.03, target_deltas={family: [0.02] * len(SEEDS) for family in TARGETS}
        )
        report = go(table)
        assert report.development["lesson"] == subject
        assert report.verdicts[DEV] == "lesson"
        assert set(report.verdicts[family] for family in TARGETS) == {"transferred"}
        assert report.transferred

    def test_a_lesson_that_fails_on_a_target_is_recorded_as_a_non_generalisation(self):
        # This is the case the whole protocol exists for. It must produce a verdict of
        # did_not_transfer, keep the development result, and say so in a note.
        table, subject = measurements(dev_delta=0.05, target_deltas={"held-out-low": [-0.04] * len(SEEDS)})
        report = go(table)
        assert report.development["lesson"] == subject
        target = next(record for record in report.targets if record["family"] == "held-out-low")
        assert target["verdict"] == "did_not_transfer"
        assert report.development["perStrategy"][subject]["meanDelta"] > 0, "the development gain still stands"
        assert any("did not generalise" in note for note in report.notes)

    def test_a_mean_gain_that_reverses_in_one_seed_is_not_a_lesson(self):
        # The recorded failure mode in this repository: a mean gain that reverses across
        # seeds. Four seeds up by 0.08 minus one down by 0.10 leaves the mean positive
        # (+0.044), so a rule that only looked at the mean would call this a lesson; the
        # every-seed requirement is what stops it.
        seeds = (1, 2, 3, 4, 5)
        table = {}
        for index, seed in enumerate(seeds):
            for family in (DEV, *TARGETS):
                base = 0.50
                table[(family, seed, BASELINE)] = {PRIMARY_METRIC: base, "recall@5": base}
                offset = -0.10 if (family == DEV and index == 0) else (0.08 if family == DEV else 0.0)
                table[(family, seed, "coverage-weighted")] = {PRIMARY_METRIC: base + offset, "recall@5": base}
                table[(family, seed, "coverage-inverse")] = {PRIMARY_METRIC: base, "recall@5": base}
                table[(family, seed, "lexical-only")] = {PRIMARY_METRIC: base, "recall@5": base}
                table[(family, seed, "dense-only")] = {PRIMARY_METRIC: base, "recall@5": base}
        report = run_transfer(table, development_family=DEV, target_families=TARGETS, seeds=seeds)
        per_strategy = report.development["perStrategy"]["coverage-weighted"]
        assert per_strategy["meanDelta"] > 0, "the synthetic mean must be positive or the test proves nothing"
        assert report.development["verdict"] == "no_lesson"
        assert report.development["lesson"] is None

    def test_a_gap_below_the_threshold_is_inconclusive_not_a_transfer(self):
        small = MIN_GAIN / 4
        table, _ = measurements(dev_delta=0.03, target_deltas={"held-out-low": [small] * len(SEEDS)})
        report = go(table)
        target = next(record for record in report.targets if record["family"] == "held-out-low")
        assert target["verdict"] == "inconclusive"
        assert not report.transferred

    def test_a_gap_that_clears_the_threshold_but_has_a_seed_against_it_is_inconclusive(self):
        deltas = [0.5, 0.5, -0.01, 0.5]
        table, _ = measurements(dev_delta=0.03, target_deltas={"held-out-low": deltas})
        report = go(table)
        target = next(record for record in report.targets if record["family"] == "held-out-low")
        assert target["negativeSeeds"] == 1
        assert target["verdict"] == "inconclusive"

    def test_no_candidate_beating_the_baseline_is_a_result_not_a_crash(self):
        table, _ = measurements(dev_delta=-0.02)
        report = go(table)
        assert report.development["verdict"] == "no_lesson"
        assert report.development["lesson"] is None
        assert report.verdicts[DEV] == "no_lesson"
        assert any("no lesson" in note for note in report.notes)

    def test_observations_are_never_labelled_as_transfers(self):
        # Without a lesson there is no claim to make, so every target is an observation
        # even when the numbers look like a win.
        table, _ = measurements(dev_delta=-0.02, target_deltas={family: [0.4] * len(SEEDS) for family in TARGETS})
        report = go(table)
        assert set(report.verdicts.values()) == {"no_lesson", "observed"}
        for target in report.targets:
            assert target["subjectIsLesson"] is False
            assert target["verdict"] == "observed"
            assert target["ranking"], "the ranking is the evidence and must survive a null result"


# --- protocol guarantees ------------------------------------------------------


class TestProtocolGuarantees:
    def test_selection_cannot_see_the_target_families(self):
        # Change only the target cells and the development block must not move: that is
        # what makes the target families held out. If this ever fails, the experiment is
        # selecting on the data it reports as unseen.
        table, _ = measurements(dev_delta=0.03, target_deltas={family: [0.02] * len(SEEDS) for family in TARGETS})
        before = go(table).development
        perturbed = dict(table)
        for (family, seed, name), value in table.items():
            if family != DEV:
                perturbed[(family, seed, name)] = {**value, PRIMARY_METRIC: value[PRIMARY_METRIC] + 0.9}
        after = go(perturbed).development
        assert json.dumps(before, sort_keys=True) == json.dumps(after, sort_keys=True)

        # ...and the other half, so this test cannot pass vacuously: the development
        # block must move when the development cells move. A protocol that ignored its
        # input would satisfy the check above and prove nothing.
        moved = {(family, seed, name): value for (family, seed, name), value in table.items()
                 if family != DEV}
        for (family, seed, name), value in table.items():
            if family == DEV:
                moved[(family, seed, name)] = {**value, PRIMARY_METRIC: value[PRIMARY_METRIC] + 0.07}
        assert json.dumps(go(moved).development, sort_keys=True) != json.dumps(before, sort_keys=True)

    def test_a_missing_strategy_cannot_become_the_lesson(self):
        table, subject = measurements(dev_delta=0.5)
        table = {key: value for key, value in table.items() if not (key[0] == DEV and key[2] == subject)}
        report = go(table)
        row = report.development["perStrategy"].get(subject)
        assert row is None or row["meanDelta"] is None
        assert report.development["lesson"] != subject

    def test_too_few_seeds_is_refused(self):
        table, _ = measurements(dev_delta=0.03, seeds=(1, 2))
        with pytest.raises(ValueError):
            run_transfer(table, development_family=DEV, target_families=TARGETS, seeds=(1, 2))
        assert MIN_SEEDS == 3

    def test_the_same_measurements_give_the_same_report(self):
        table, _ = measurements(dev_delta=0.03, target_deltas={family: [0.02] * len(SEEDS) for family in TARGETS})
        assert go(table).to_json() == go(table).to_json()

    def test_the_report_states_the_protocol_it_used(self):
        table, _ = measurements(dev_delta=0.03, target_deltas={family: [0.02] * len(SEEDS) for family in TARGETS})
        protocol = go(table).protocol
        assert protocol["primaryMetric"] == PRIMARY_METRIC
        assert protocol["minGain"] == MIN_GAIN
        assert protocol["baseline"] == BASELINE
        assert protocol["candidates"] == [strategy.name for strategy in STRATEGIES]

    def test_the_runner_connects_the_real_pipeline_to_the_protocol(self, tmp_path):
        # The protocol passing its own synthetic tests proves the decision procedure,
        # not that the runner feeds it anything usable. This runs the actual CLI over
        # real corpora (3 seeds, 8 epochs -- a smoke configuration, not the recorded
        # experiment) and checks the artifact the docs quote.
        import subprocess
        import sys as _sys

        root = pathlib.Path(__file__).resolve().parents[1]
        out = tmp_path / "l4.json"
        result = subprocess.run(
            [_sys.executable, str(root / "scripts" / "l4_transfer.py"), "--quick", "--json", str(out)],
            cwd=root, capture_output=True, text=True, timeout=600,
        )
        assert result.returncode == 0, result.stderr[-2000:]
        payload = json.loads(out.read_text(encoding="utf-8"))
        assert payload["experiment"] == "l4-transfer"
        assert payload["hardware"]["machine"]
        report = payload["report"]
        assert report["development"]["family"] == "development-low"
        assert report["development"]["seeds"] == 3
        assert len(report["development"]["ranking"]) == len(STRATEGIES)
        assert report["development"]["versusBaseline"]
        # Every strategy was measured on every family -- a missing cell would mean the
        # protocol silently compared different things.
        cells = {(row["family"], row["seed"], row["strategy"]) for row in payload["rawMetrics"]}
        families = {family for family, _, _ in cells}
        assert len(families) == 4
        assert {seed for _, seed, _ in cells} == {11, 22, 33}
        for family in families:
            assert {name for fam, _, name in cells if fam == family} == {s.name for s in STRATEGIES}
        assert "verdict" in report["development"]

    def test_the_registered_secondary_metric_is_carried_in_every_block(self):
        # The protocol registers recall@5 alongside mr. Carrying it is what makes the
        # registration real; a protocol that measures a second metric and reports none
        # of it has quietly narrowed itself after the fact.
        table, _ = measurements(dev_delta=0.03, target_deltas={family: [0.02] * len(SEEDS) for family in TARGETS})
        report = go(table)
        assert report.development["secondaryMetric"] == SECONDARY_METRIC
        assert report.development["versusBaselineSecondary"]
        for target in report.targets:
            assert len(target["secondaryDeltas"]) == len(SEEDS)
            assert target["versusBaselineSecondary"]
            for row in target["versusBaselineSecondary"]:
                assert row["strategy"] != BASELINE_STRATEGY
                assert len(row["deltas"]) == len(SEEDS)

    def test_the_secondary_metric_cannot_change_a_verdict(self):
        # One decision rule, stated before the run. If recall@5 could swing a verdict,
        # a strategy that lost on the primary could be reported as transferring on the
        # secondary, which is exactly the second chance the protocol refuses to take.
        table, subject = measurements(
            dev_delta=0.03, target_deltas={family: [0.02] * len(SEEDS) for family in TARGETS}
        )
        before = go(table)
        # Only the subject's secondary value moves, and only on the development family:
        # every primary cell is bit-identical, so any verdict change would be the
        # secondary metric pulling a lever it is not supposed to have.
        swung = {
            (family, seed, name): (
                {**value, "recall@5": min(1.0, value["recall@5"] + 0.4)}
                if (family == DEV and name == subject)
                else value
            )
            for (family, seed, name), value in table.items()
        }
        after = go(swung)
        assert after.verdicts == before.verdicts
        assert json.dumps(after.development["versusBaseline"], sort_keys=True) == json.dumps(
            before.development["versusBaseline"], sort_keys=True
        )
        assert json.dumps(before.development["versusBaselineSecondary"], sort_keys=True) != json.dumps(
            after.development["versusBaselineSecondary"], sort_keys=True
        ), "the perturbed metric must actually move, or this test proves nothing"

    def test_every_ranked_strategy_carries_its_paired_deltas(self):
        table, _ = measurements(dev_delta=0.02, target_deltas={family: [0.02] * len(SEEDS) for family in TARGETS})
        report = go(table)
        rows = report.development["versusBaseline"]
        assert {row["strategy"] for row in rows} == {s.name for s in STRATEGIES if s.name != BASELINE}
        for row in rows:
            assert len(row["deltas"]) == len(SEEDS)
            assert row["positiveSeeds"] + row["negativeSeeds"] + row["tiedSeeds"] == len(SEEDS)
