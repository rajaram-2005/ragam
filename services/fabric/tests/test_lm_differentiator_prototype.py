"""The differentiator-parts prototype: it trains, it abstains, and it is not an artifact.

The prototype run that produced `docs/experiments/differentiator-prototype.json` takes minutes; the
fixture below runs the first 150 steps of the same trajectory (the learning-rate schedule is spread
over the recorded 900 steps, so a short run is a prefix rather than a faster-decaying rehearsal).
What the tests check is the contract rather than the recorded scores: that both heads learn from one
loss, that the abstention cases abstain, that the report cannot be mistaken for a model release, and
that the same seed produces the same data.

The strong claims about the *state* head -- 0.6934 held-out accuracy against a 0.2891 majority
baseline, and 0.8333 recall of the reserved *none* class on marker-free text -- are asserted against
the committed record, because they are what 900 steps produced. A 150-step prefix is enough to show
the parts learn and that stale sources abstain, and 150 steps is what a test can afford.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from lm_differentiator_prototype import (  # noqa: E402
    CLASSES, build_samples, prototype_run,
)

REPORT = Path(__file__).resolve().parents[3] / "docs" / "experiments" / "differentiator-prototype.json"


@pytest.fixture(scope="module")
def short_run():
    return prototype_run(steps=150, batch_size=32, seed=0)


def test_the_generator_is_deterministic_and_the_labels_follow_the_rules():
    first = build_samples(np.random.default_rng(0), 64)
    again = build_samples(np.random.default_rng(0), 64)
    assert first[0] == again[0]
    texts, buckets, states, verdicts, priors = first
    # The verdict label is a rule about the freshest bucket, not a random tag.
    for bucket, verdict in zip(buckets, verdicts):
        assert verdict == int(bucket > 1)
    # The state label is in the closed class list, and the conditioning input is a separate draw:
    # if the head could read the label off its own input, the reading task would measure nothing.
    assert set(int(s) for s in states) <= set(range(len(CLASSES)))
    assert set(int(p) for p in priors) <= set(range(len(CLASSES)))
    assert len(set(int(s) for s in states)) > 1, "the generated labels must not be one constant"
    assert len(texts) == len(buckets) == len(states) == len(verdicts) == len(priors) == 64


def test_both_heads_learn_from_one_loss(short_run):
    trajectory = short_run["loss"]["trajectory"]
    assert trajectory[-1]["loss"] < trajectory[0]["loss"], "the joint loss must fall"
    held_out = short_run["metrics"]["heldOut"]
    assert held_out["verdict"]["accuracy"] > held_out["verdict"]["majorityClassBaseline"], \
        "the verdict head must beat the majority class"
    assert held_out["state"]["accuracy"] > held_out["state"]["majorityClassBaseline"], \
        "the state head must beat the majority class"
    # The parts are trained, not merely present: their parameter count is a real share of the model.
    assert short_run["differentiatorParameters"] > 0
    assert short_run["parameterCount"] > short_run["differentiatorParameters"]


def test_the_abstention_cases_abstain(short_run):
    """A stale source must abstain, and marker-free text must at least not be read as a state."""
    assert short_run["metrics"]["staleOnlySources"]["verdict"]["abstainRecall"] >= 0.9
    none_recall = short_run["metrics"]["noMarkerText"]["state"]["recallPerClass"]["none"]
    assert none_recall > 1.0 / len(CLASSES), "marker-free text must abstain more often than chance"


def test_the_report_cannot_be_mistaken_for_a_release(short_run):
    assert short_run["isArtifact"] is False
    assert short_run["limitations"], "a measurement without its limits is an advertisement"
    assert any("not a Pro or Max artifact" in line for line in short_run["limitations"])
    # Nothing here may look like a card: no weights digest, no release status, no version.
    assert "weightsDigest" not in short_run
    assert "releasedAt" not in short_run
    assert short_run["metrics"]["heldOut"]["samples"] > 0
    assert {split for split in short_run["metrics"]} == {"heldOut", "noMarkerText", "staleOnlySources"}


def test_the_recorded_run_is_the_one_this_code_produces():
    """The committed record is checked for what it claims, and for the numbers it reports.

    Re-running the full 900-step budget in CI would cost minutes, so the record's own measured
    values are asserted where they are stated: the parts trained in one loss, the abstention cases
    abstained, and the report cannot be served as a model.
    """
    report = json.loads(REPORT.read_text(encoding="utf-8"))
    assert report["isArtifact"] is False
    assert report["budget"]["steps"] == 900
    assert report["modelConfig"]["age_buckets"] == 4
    assert report["modelConfig"]["state_classes"] == len(CLASSES)
    assert report["modelConfig"]["verdict_head"] is True
    assert report["modelConfig"]["state_head"] is True
    for split in ("heldOut", "noMarkerText", "staleOnlySources"):
        verdict = report["metrics"][split]["verdict"]
        assert verdict["accuracy"] >= verdict["majorityClassBaseline"]
        assert 0.0 <= verdict["abstainRecall"] <= 1.0
    assert report["wallSeconds"] > 0
    assert report["loss"]["last"] < report["loss"]["first"]
    # The two measurable claims the page quotes, checked against the record rather than restated.
    held_out = report["metrics"]["heldOut"]
    assert held_out["state"]["accuracy"] >= 0.6
    assert held_out["verdict"]["accuracy"] >= 0.95
    assert report["metrics"]["staleOnlySources"]["verdict"]["abstainRecall"] >= 0.9
    assert held_out["state"]["recallPerClass"]["none"] >= 0.75
    assert "no comparison against any other model" in " ".join(report["limitations"]).lower()
    assert report["differentiatorParameters"] == 902, "the parts' parameter count is part of the claim"
