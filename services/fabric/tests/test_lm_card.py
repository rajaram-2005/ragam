"""The release gate for Aetheris Lite.

The card machinery already existed and is tested in `test_modelcards.py`. What is
tested here is the *policy*: that the requirements are the ones claimed, that the
numbers driving them are derived from the report rather than read from a constant,
and that a model which fails is recorded as rejected rather than shipped.

The rejection path matters more than the acceptance path. A gate that has never been
observed to refuse something is a gate nobody has evidence for.
"""

from __future__ import annotations

import copy
import json

import pytest

from fabric.lm.card import (
    LM_NAME,
    best_baseline_name,
    build_provenance,
    candidate_from_report,
    limitations_from_report,
    model_limitations,
    metrics_from_report,
    register_from_report,
    requirements_for_language_model,
)
from fabric.modelcards import ModelReleaseError, ModelReleaseManager, ModelStatus


def make_report(*, perplexity=8.0, baseline=16.0, first_loss=4.9, final_loss=2.0,
                unknown=0.0005, parameters=248_160, wall=417.0, steps=800):
    """A minimal report shaped like `train()` produces. Values are parameters so
    failing cases can be constructed without training a model that is genuinely bad."""
    return {
        "config": {"steps": steps, "d_model": 96, "n_layers": 3},
        "model_config": {"vocab_size": 143, "seq_len": 128, "d_model": 96, "n_layers": 3},
        "corpus": {
            "manifestDigest": "a" * 64, "trainBytes": 1_381_436, "trainFiles": 102,
            "validationFiles": 11, "validationBytes": 156_895, "trainTokens": 1_429_116,
            "validationTokens": 165_120,
        },
        "tokenizer": {"size": 143, "vocabularyDigest": "b" * 64, "validationUnknownRate": unknown},
        "provenance": {
            "codeRevision": "deadbeef", "python": "3.11.2", "numpy": "2.4.6",
            "platform": "linux", "machine": "x86_64", "parameterCount": parameters,
            "seed": {"model": 0, "data": 0, "split": 20251012},
        },
        "resource": {"wallSeconds": wall, "peakMemoryMb": 400.0, "steps": steps,
                     "tokensPerStep": 2048, "tokensSeen": 2048 * steps},
        "loss_curve": [{"step": 0, "loss": first_loss, "lr": 1e-4, "gradNorm": 1.0},
                       {"step": steps - 1, "loss": final_loss, "lr": 1e-4, "gradNorm": 1.0}],
        "final_loss": final_loss,
        "evaluation": {
            "nllNatsPerToken": 2.18, "perplexity": perplexity, "bitsPerCharacter": 3.14,
            "tokensEvaluated": 165_120, "unknownRate": unknown,
            "baselines": [
                {"name": "uniform", "perplexity": 143.0, "nllNatsPerToken": 4.96,
                 "bitsPerCharacter": 7.16, "description": "d"},
                {"name": "unigram", "perplexity": 35.2, "nllNatsPerToken": 3.56,
                 "bitsPerCharacter": 5.14, "description": "d"},
                {"name": "bigram", "perplexity": baseline, "nllNatsPerToken": 2.77,
                 "bitsPerCharacter": 4.0, "description": "d"},
            ],
            "bestBaseline": "bigram", "beatsAllBaselines": perplexity < baseline,
            "perplexityVsBestBaseline": perplexity / baseline,
        },
        "samples": {"greedy": "x", "sampled": "y"},
        "artifact": {"path": "/tmp/x.npz", "filename": "x.npz", "fileDigest": "c" * 64,
                     "weightsDigest": "d" * 64, "bytes": 1_000_000},
    }


# ---------------------------------------------------------------------------
# Requirements
# ---------------------------------------------------------------------------


def test_the_declared_requirements_are_the_ones_described():
    by_metric = {r.metric: r for r in requirements_for_language_model()}
    assert by_metric["perplexityVsBigram"].maximum == 1.0
    assert by_metric["perplexityVsBigram"].hard is True
    assert by_metric["validationUnknownRate"].maximum == 0.02
    assert by_metric["validationUnknownRate"].hard is True
    assert by_metric["lossImprovement"].minimum == 1.0
    assert by_metric["lossImprovement"].hard is True
    # Size and cost are limitations, not gates.
    assert by_metric["parameterCount"].hard is False
    assert by_metric["wallSeconds"].hard is False


def test_beating_the_bigram_is_the_gate_not_the_perplexity_itself():
    """Perplexity alone cannot be a gate: 8.0 is good on one corpus and bad on
    another. The comparison is what carries the meaning."""
    optimistic = make_report(perplexity=20.0, baseline=15.9)
    metrics = metrics_from_report(optimistic)
    assert metrics["perplexityVsBigram"] > 1.0

    config = {r.metric: r for r in requirements_for_language_model()}
    ok, reason = config["perplexityVsBigram"].check(metrics["perplexityVsBigram"])
    assert not ok and "exceeds the allowed maximum" in reason


# ---------------------------------------------------------------------------
# Metrics derived from the report
# ---------------------------------------------------------------------------


def test_metrics_are_computed_from_the_report_not_read_from_a_constant():
    a = metrics_from_report(make_report(perplexity=8.0, baseline=16.0))
    b = metrics_from_report(make_report(perplexity=4.0, baseline=16.0))
    assert a["perplexityVsBigram"] == pytest.approx(0.5)
    assert b["perplexityVsBigram"] == pytest.approx(0.25)
    assert a["lossImprovement"] == pytest.approx(4.9 - 2.0)


def test_the_ratio_tracks_the_reported_best_baseline():
    report = make_report()
    report["evaluation"]["bestBaseline"] = "unigram"
    assert best_baseline_name(report) == "unigram"
    assert metrics_from_report(report)["bestBaselinePerplexity"] == pytest.approx(35.2)


def test_metrics_are_numeric_so_the_manager_can_coerce_them():
    """`ModelReleaseManager.validate` calls float() on every entry. A string in the
    metrics dict would be a type error at release time, so it is excluded by design."""
    metrics = metrics_from_report(make_report())
    assert all(isinstance(v, float) for v in metrics.values()), metrics
    assert best_baseline_name(make_report()) == "bigram"


def test_a_report_with_no_baselines_cannot_be_gated():
    """Without a comparison there is nothing to gate on, and the honest response is
    to refuse rather than to invent a threshold."""
    report = make_report()
    report["evaluation"]["baselines"] = []
    report["evaluation"]["bestBaseline"] = None
    with pytest.raises(ValueError, match="no baselines"):
        metrics_from_report(report)


# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------


def test_a_model_that_beats_the_bigram_is_released():
    manager = ModelReleaseManager()
    card, released = candidate_from_report(make_report(), manager, version="0.1.0")
    assert released is True
    assert card.status == ModelStatus.RELEASED
    assert manager.current() is not None
    assert manager.current().identifier == f"{LM_NAME}@0.1.0"


def test_a_model_that_loses_to_the_bigram_is_rejected_and_not_released():
    """The gate must be observed to refuse something, or there is no evidence it is
    a gate rather than a formality."""
    manager = ModelReleaseManager()
    losing = make_report(perplexity=20.0, baseline=15.9)
    card, released = candidate_from_report(losing, manager, version="0.1.0")
    assert released is False
    assert card.status == ModelStatus.REJECTED
    assert manager.current() is None, "a rejected candidate must not become the live release"
    failures = json.dumps(card.validation)
    assert "perplexityVsBigram" in failures
    assert "exceeds the allowed maximum" in failures


def test_a_model_that_did_not_learn_is_rejected():
    manager = ModelReleaseManager()
    card, released = candidate_from_report(
        make_report(first_loss=2.0, final_loss=3.5), manager, version="0.1.0"
    )
    assert released is False
    assert card.status == ModelStatus.REJECTED
    assert "lossImprovement" in json.dumps(card.validation)


def test_a_tokenizer_that_cannot_represent_the_validation_text_is_rejected():
    """Perplexity partly measuring <unk> does not describe language modelling."""
    manager = ModelReleaseManager()
    card, released = candidate_from_report(
        make_report(unknown=0.15), manager, version="0.1.0"
    )
    assert released is False
    assert card.status == ModelStatus.REJECTED
    assert "validationUnknownRate" in json.dumps(card.validation)


def test_an_oversized_model_is_recorded_as_a_limitation_but_still_releases():
    """A soft requirement must not block, or it is not soft."""
    manager = ModelReleaseManager()
    card, released = candidate_from_report(
        make_report(parameters=9_000_000), manager, version="0.1.0"
    )
    assert released is True
    assert card.status == ModelStatus.RELEASED
    assert "parameterCount" in json.dumps(card.validation.get("softFailures", []))


def test_the_same_version_cannot_be_registered_twice():
    """A version is immutable; improving the model means a new version."""
    manager = ModelReleaseManager()
    register_from_report(make_report(), manager, version="0.1.0")
    with pytest.raises(ModelReleaseError, match="already registered"):
        register_from_report(make_report(), manager, version="0.1.0")


def test_a_later_version_supersedes_the_earlier_one_and_rollback_returns_to_it():
    manager = ModelReleaseManager()
    candidate_from_report(make_report(), manager, version="0.1.0")
    candidate_from_report(make_report(perplexity=6.0), manager, version="0.2.0")
    assert manager.current().identifier == f"{LM_NAME}@0.2.0"
    assert manager.card(f"{LM_NAME}@0.1.0").status == ModelStatus.SUPERSEDED

    rolled = manager.rollback(f"{LM_NAME}@0.1.0", reason="0.2.0 regressed on inspection")
    assert rolled.identifier == f"{LM_NAME}@0.1.0"
    assert manager.current().identifier == f"{LM_NAME}@0.1.0"


def test_an_unvalidated_candidate_cannot_be_released_directly():
    """Registration alone must never be enough to ship."""
    manager = ModelReleaseManager()
    card = register_from_report(make_report(), manager, version="0.1.0")
    assert card.status == ModelStatus.CANDIDATE
    with pytest.raises(ModelReleaseError, match="not validated"):
        manager.release(card.identifier)


def test_a_rejected_version_cannot_be_released_even_later():
    manager = ModelReleaseManager()
    losing = make_report(perplexity=20.0, baseline=15.9)
    card, _ = candidate_from_report(losing, manager, version="0.1.0")
    with pytest.raises(ModelReleaseError):
        manager.release(card.identifier)


# ---------------------------------------------------------------------------
# Provenance and limitations
# ---------------------------------------------------------------------------


def test_provenance_records_the_conditions_the_metrics_came_from():
    provenance = build_provenance(make_report())
    payload = provenance.to_dict()
    assert payload["datasetDigest"] == "a" * 64
    assert payload["codeRevision"] == "deadbeef"
    assert payload["seed"] == 0
    assert payload["hardware"]["accelerator"] == "none (CPU only)"
    assert payload["context"]["seqLen"] == 128
    assert payload["quantization"] is None
    assert payload["status"] == "completed"


def test_the_card_itself_lists_limitations_not_only_the_provenance():
    """A card with an empty `limitations` field reads as "there are none", and the
    card is where a reader looks. The model-level list must be on the card, and the
    evaluation-level list on the provenance -- as the retriever card does it."""
    manager = ModelReleaseManager()
    card, _ = candidate_from_report(make_report(), manager, version="0.1.0")
    assert len(card.limitations) >= 4, card.limitations
    joined = " ".join(card.limitations).lower()
    assert "not derived from any pretrained base model" in joined
    assert "/api/chat" in joined
    # The wording moved once already, from "deliberately not wired into /api/chat" to the
    # refusal that actually happens. A limitation describing a behaviour the app does not
    # have would be quoted as the reason the real behaviour is safe, so the direction is
    # pinned: the route exists and refuses.
    assert "refused" in joined and "not_instruction_tuned" in joined, joined
    assert "not wired" not in joined
    assert card.provenance.limitations, "the provenance must still carry its own list"
    assert not set(card.limitations) & set(card.provenance.limitations), "the two lists overlap"


def test_the_model_limitations_are_derived_from_the_report():
    """They must move with the artifact, not be a fixed paragraph."""
    small = " ".join(model_limitations(make_report(parameters=17_056)))
    large = " ".join(model_limitations(make_report(parameters=359_136)))
    assert "17,056" in small
    assert "359,136" in large
    assert small != large


def test_the_card_carries_the_limits_of_the_experiment():
    """A card that lists no limitations for a 359K-parameter from-scratch model
    would be misleading by omission."""
    limitations = limitations_from_report(make_report())
    joined = " ".join(limitations).lower()
    assert len(limitations) >= 4
    assert "no world knowledge" in joined
    assert "no comparison against any pretrained model" in joined
    assert "proves the pipeline, not the model" in joined


def test_an_unknown_rate_above_zero_is_disclosed_as_a_limitation():
    disclosed = " ".join(limitations_from_report(make_report(unknown=0.004)))
    hidden = " ".join(limitations_from_report(make_report(unknown=0.0)))
    assert "<unk>" in disclosed
    assert "<unk>" not in hidden


def test_registration_records_the_artifact_hashes_and_no_base_checkpoint():
    manager = ModelReleaseManager()
    card = register_from_report(make_report(), manager, version="0.1.0")
    assert card.base_checkpoint is None, "trained from scratch, so there is no base"
    assert card.weights_digest == "d" * 64
    assert card.artifacts["vocabularyDigest"] == "b" * 64
    assert card.artifacts["strongestBaseline"] == "bigram"
    assert card.artifacts["corpusManifest"] == "a" * 64
    assert card.config_digest and len(card.config_digest) == 64


def test_the_card_round_trips_to_json():
    manager = ModelReleaseManager()
    card, _ = candidate_from_report(make_report(), manager, version="0.1.0")
    payload = json.loads(json.dumps(card.to_dict(), default=str))
    assert payload["identifier"] == f"{LM_NAME}@0.1.0"
    assert payload["metrics"]["perplexityVsBigram"] == pytest.approx(0.5)
