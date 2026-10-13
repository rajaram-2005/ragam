"""Unvalidated weights must not be able to replace a stable release.

That single sentence is the reason this module exists, so most of these tests are
about refusals: what the manager will not do, and whether it says why.
"""

from __future__ import annotations

import json

import pytest

from fabric.modelcards import (
    EvaluationProvenance,
    ModelCard,
    ModelReleaseError,
    ModelReleaseManager,
    ModelStatus,
    Requirement,
)
from fabric.taxonomy import BenchmarkCategory, StageStatus

NAME = "aetheris-lite-retriever"
REQUIREMENTS = (
    Requirement("mrr", minimum=0.5, category=BenchmarkCategory.RETRIEVAL),
    Requirement("latencyMs", maximum=10.0, category=BenchmarkCategory.LATENCY),
)


def provenance(**kwargs) -> EvaluationProvenance:
    defaults = {
        "subject": f"{NAME}@0.1.0",
        "comparator": "bm25 k1=1.5 b=0.75",
        "hardware": {"cpu": 2, "ramGb": 3.9, "gpu": 0},
        "decoding": {"topK": 10},
        "dataset_digest": "digest-a",
        "corpus_size": 96,
        "queries": 24,
        "seed": 7,
        "code_revision": "abc1234",
        "status": StageStatus.COMPLETED,
    }
    defaults.update(kwargs)
    return EvaluationProvenance(**defaults)


@pytest.fixture()
def manager() -> ModelReleaseManager:
    return ModelReleaseManager()


def register(manager: ModelReleaseManager, version: str = "0.1.0", **kwargs) -> ModelCard:
    defaults = {
        "name": NAME,
        "version": version,
        "family": "dual-encoder",
        "licence": "MIT",
        "weights_digest": hashlib_digest(version),
        "requirements": REQUIREMENTS,
        "dataset_digest": "digest-a",
        "parameter_count": 18784,
    }
    defaults.update(kwargs)
    return manager.register(**defaults)


def hashlib_digest(seed: str) -> str:
    import hashlib

    return hashlib.sha256(seed.encode()).hexdigest()


def validated(manager: ModelReleaseManager, version: str = "0.1.0", metrics=None) -> ModelCard:
    card = register(manager, version)
    manager.validate(card.identifier, metrics or {"mrr": 0.85, "latencyMs": 3.4}, provenance=provenance())
    return card


# --- the card --------------------------------------------------------------


def test_a_card_requires_the_fields_that_make_it_identifiable():
    with pytest.raises(ValueError, match="requires a name"):
        ModelCard(name="", version="1", family="f", licence="MIT", weights_digest="d")
    with pytest.raises(ValueError, match="requires a version"):
        ModelCard(name="n", version=" ", family="f", licence="MIT", weights_digest="d")
    with pytest.raises(ValueError, match="requires a licence"):
        ModelCard(name="n", version="1", family="f", licence="", weights_digest="d")
    with pytest.raises(ValueError, match="requires a weights digest"):
        ModelCard(name="n", version="1", family="f", licence="MIT", weights_digest="")


def test_a_requirement_needs_a_bound():
    with pytest.raises(ValueError, match="needs a minimum, a maximum, or both"):
        Requirement("mrr")
    with pytest.raises(ValueError, match="minimum above maximum"):
        Requirement("mrr", minimum=0.9, maximum=0.1)


def test_a_requirement_reports_what_it_checked():
    spec = Requirement("mrr", minimum=0.5)
    assert spec.check(0.8)[0] is True
    ok, reason = spec.check(0.3)
    assert ok is False and "below the required minimum" in reason
    ok, reason = spec.check(None)
    assert ok is False and "was not measured" in reason

    ceiling = Requirement("latencyMs", maximum=10.0)
    assert ceiling.check(3.0)[0] is True
    assert ceiling.check(20.0)[0] is False


def test_a_registered_card_is_a_candidate_not_a_release(manager):
    card = register(manager)
    assert card.status == ModelStatus.CANDIDATE
    assert manager.current() is None
    assert card.identifier == f"{NAME}@0.1.0"


def test_a_version_cannot_be_registered_twice(manager):
    register(manager)
    with pytest.raises(ModelReleaseError, match="already registered"):
        register(manager)


def test_an_unknown_model_is_reported_with_what_exists(manager):
    register(manager)
    with pytest.raises(KeyError, match="unknown model"):
        manager.card(f"{NAME}@9.9.9")


# --- the release gate ------------------------------------------------------


def test_an_unvalidated_candidate_cannot_be_released(manager):
    card = register(manager)
    with pytest.raises(ModelReleaseError, match="not validated"):
        manager.release(card.identifier)
    assert manager.current() is None
    assert card.status == ModelStatus.CANDIDATE


def test_a_rejected_candidate_cannot_be_released(manager):
    card = register(manager)
    manager.validate(card.identifier, {"mrr": 0.2, "latencyMs": 1.0}, provenance=provenance())
    assert card.status == ModelStatus.REJECTED
    with pytest.raises(ModelReleaseError, match="not validated"):
        manager.release(card.identifier)


def test_a_retired_model_cannot_be_released(manager):
    card = validated(manager)
    manager.release(card.identifier)
    manager.retire(card.identifier, reason="withdrawn after a safety review")
    with pytest.raises(ModelReleaseError, match="not validated"):
        manager.release(card.identifier)


def test_validation_without_provenance_cannot_be_released(manager):
    card = register(manager)
    manager.validate(card.identifier, {"mrr": 0.9, "latencyMs": 1.0})
    assert card.status == ModelStatus.VALIDATED
    with pytest.raises(ModelReleaseError, match="no evaluation provenance"):
        manager.release(card.identifier)


def test_a_blocked_evaluation_is_not_evidence(manager):
    card = register(manager)
    manager.validate(
        card.identifier,
        {"mrr": 0.9, "latencyMs": 1.0},
        provenance=provenance(status=StageStatus.BLOCKED_NEEDS_HARDWARE),
    )
    assert card.status == ModelStatus.VALIDATED
    with pytest.raises(ModelReleaseError, match="blocked_needs_hardware"):
        manager.release(card.identifier)


def test_validation_without_requirements_is_refused(manager):
    card = register(manager, version="0.9.0", requirements=())
    with pytest.raises(ModelReleaseError, match="declares no requirements"):
        manager.validate(card.identifier, {"mrr": 0.99})


def test_validation_reports_every_failure(manager):
    card = register(manager)
    manager.validate(card.identifier, {"mrr": 0.2, "latencyMs": 40.0}, provenance=provenance())
    assert card.status == ModelStatus.REJECTED
    assert len(card.validation["hardFailures"]) == 2
    assert any("mrr" in reason for reason in card.validation["hardFailures"])
    assert any("latencyMs" in reason for reason in card.validation["hardFailures"])


def test_a_missing_metric_fails_validation(manager):
    card = register(manager)
    manager.validate(card.identifier, {"mrr": 0.9}, provenance=provenance())
    assert card.status == ModelStatus.REJECTED
    assert any("latencyMs" in reason and "not measured" in reason for reason in card.validation["hardFailures"])


def test_a_soft_requirement_becomes_a_limitation_not_a_block(manager):
    card = register(
        manager,
        requirements=REQUIREMENTS + (Requirement("recall@1", minimum=0.9, hard=False),),
    )
    manager.validate(card.identifier, {"mrr": 0.85, "latencyMs": 3.4, "recall@1": 0.6}, provenance=provenance())
    assert card.status == ModelStatus.VALIDATED, "a soft requirement must not block release"
    assert card.validation["softFailures"]
    assert any("recall@1" in note for note in card.limitations)


def test_the_live_release_cannot_be_revalidated_in_place(manager):
    card = validated(manager)
    manager.release(card.identifier)
    with pytest.raises(ModelReleaseError, match="live release"):
        manager.validate(card.identifier, {"mrr": 0.99, "latencyMs": 0.1}, provenance=provenance())


# --- promotion and supersession -------------------------------------------


def test_releasing_supersedes_the_previous_release_but_keeps_it(manager):
    first = validated(manager, "0.1.0")
    manager.release(first.identifier)
    second = validated(manager, "0.2.0", metrics={"mrr": 0.9, "latencyMs": 3.0})
    manager.release(second.identifier)

    assert manager.current().identifier == second.identifier
    assert first.status == ModelStatus.SUPERSEDED, "the old release must be retained, not deleted"
    assert first.weights_digest, "its weights digest survives so it can be restored"
    assert [card.identifier for card in manager.rollback_targets()] == [first.identifier]
    assert second.parent_version == "0.1.0"


def test_releasing_the_same_version_twice_is_a_no_op(manager):
    card = validated(manager)
    manager.release(card.identifier)
    again = manager.release(card.identifier)
    assert again.identifier == card.identifier
    assert manager.release_history().count(card.identifier) == 1


# --- rollback --------------------------------------------------------------


def test_rollback_returns_to_a_superseded_release(manager):
    first = validated(manager, "0.1.0")
    manager.release(first.identifier)
    second = validated(manager, "0.2.0", metrics={"mrr": 0.9, "latencyMs": 3.0})
    manager.release(second.identifier)

    manager.rollback(first.identifier, reason="0.2.0 regressed on held-out topics")
    assert manager.current().identifier == first.identifier
    assert second.status == ModelStatus.RETIRED
    assert manager.rollback_targets() == []


def test_rollback_needs_a_reason(manager):
    first = validated(manager, "0.1.0")
    manager.release(first.identifier)
    second = validated(manager, "0.2.0", metrics={"mrr": 0.9, "latencyMs": 3.0})
    manager.release(second.identifier)
    with pytest.raises(ModelReleaseError, match="needs a reason"):
        manager.rollback(first.identifier, reason="   ")


def test_rollback_to_something_never_released_is_refused(manager):
    validated(manager, "0.1.0")
    candidate = register(manager, "0.2.0")
    with pytest.raises(ModelReleaseError, match="only a superseded release"):
        manager.rollback(candidate.identifier, reason="prefer the older one")


def test_rollback_to_a_retired_version_is_refused(manager):
    first = validated(manager, "0.1.0")
    manager.release(first.identifier)
    second = validated(manager, "0.2.0", metrics={"mrr": 0.9, "latencyMs": 3.0})
    manager.release(second.identifier)
    manager.retire(first.identifier, reason="found to be trained on contaminated data")
    with pytest.raises(ModelReleaseError, match="only a superseded release"):
        manager.rollback(first.identifier, reason="want it back")


def test_rolling_back_to_the_live_release_is_a_no_op(manager):
    card = validated(manager)
    manager.release(card.identifier)
    assert manager.rollback(card.identifier, reason="no change needed").identifier == card.identifier


# --- the audit trail -------------------------------------------------------


def test_every_state_change_is_recorded(manager):
    first = validated(manager, "0.1.0")
    manager.release(first.identifier)
    second = validated(manager, "0.2.0", metrics={"mrr": 0.9, "latencyMs": 3.0})
    manager.release(second.identifier)
    manager.rollback(first.identifier, reason="regression")

    events = [event["event"] for event in manager.events()]
    for expected in ("registered", "validated", "released", "superseded", "retired", "rolled_back_to"):
        assert expected in events, f"missing '{expected}' in {events}"

    history = [entry["event"] for entry in first.history]
    assert history == ["registered", "validated", "released", "superseded", "rolled_back_to"]


def test_the_summary_describes_the_registry(manager):
    validated(manager, "0.1.0")
    register(manager, "0.2.0")
    summary = manager.summary()
    assert summary["models"] == 2
    assert summary["byStatus"][ModelStatus.VALIDATED] == 1
    assert summary["byStatus"][ModelStatus.CANDIDATE] == 1
    assert summary["current"] is None


def test_the_registry_round_trips_through_disk(tmp_path, manager):
    first = validated(manager, "0.1.0")
    manager.release(first.identifier)
    second = validated(manager, "0.2.0", metrics={"mrr": 0.9, "latencyMs": 3.0})
    manager.release(second.identifier)
    manager.rollback(first.identifier, reason="regression")

    path = manager.save(tmp_path / "nested" / "registry.json")
    payload = json.loads(path.read_text())
    assert payload["format"] == "aetheris-model-registry/1"

    restored = ModelReleaseManager.load(path)
    assert restored.current().identifier == first.identifier
    assert restored.card(second.identifier).status == ModelStatus.RETIRED
    assert restored.card(first.identifier).provenance.hardware == {"cpu": 2, "ramGb": 3.9, "gpu": 0}
    assert restored.card(first.identifier).provenance.status is StageStatus.COMPLETED
    assert len(restored.card(first.identifier).requirements) == 2
    assert restored.release_history() == manager.release_history()


def test_loading_an_unknown_format_is_refused(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text(json.dumps({"format": "other/2"}))
    with pytest.raises(ValueError, match="unsupported model registry format"):
        ModelReleaseManager.load(path)


def test_the_card_digest_is_stable_and_content_sensitive(manager):
    card = validated(manager)
    before = card.digest()
    assert before == card.digest(), "the digest must be stable for unchanged content"

    card.metrics["mrr"] = 0.99
    assert card.digest() != before, "a changed metric must change the digest"

    other = validated(manager, "0.3.0")
    assert other.digest() != card.digest(), "different versions must not collide"


def test_provenance_is_not_silently_dropped_by_serialisation(manager):
    # Regression: these records used to inherit a dict mixin, which made an
    # attribute-only dataclass falsy, so `if card.provenance` was always False and
    # the provenance serialised to null. A card that cannot say what hardware and
    # data produced its metrics is not evidence.
    card = validated(manager)
    assert bool(card.provenance) is True
    assert card.to_dict()["provenance"] is not None
    assert card.to_dict()["provenance"]["hardware"] == {"cpu": 2, "ramGb": 3.9, "gpu": 0}

    payload = json.loads(json.dumps(card.to_dict()))
    assert payload["provenance"]["subject"] == f"{NAME}@0.1.0"
    assert payload["provenance"]["status"] == "completed"
    assert payload["requirements"][0]["metric"] == "mrr"


def test_requirements_survive_serialisation(manager):
    card = validated(manager)
    payload = json.loads(json.dumps(card.to_dict()))
    assert bool(payload["requirements"])
    restored = Requirement(
        metric=payload["requirements"][0]["metric"],
        minimum=payload["requirements"][0]["minimum"],
    )
    assert restored.check(0.9)[0] is True
