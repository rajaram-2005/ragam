"""Versioned model cards, promotion and rollback.

The two invariants this module exists to enforce:

1. **An unvalidated checkpoint cannot become the release.** ``release()`` refuses
   unless the card has passed validation against explicit, recorded requirements.
   Registering weights is not the same as shipping them.
2. **A release never destroys its predecessor.** Superseded versions are retained
   with their weights digest, so ``rollback()`` can always return to a known-good
   model. "Never overwrite a known-good model with an unvalidated checkpoint" only
   means something if the known-good one is still there.

A card also has to be able to answer *"on what evidence?"*. So it records the base
checkpoint, the dataset manifest digest, the code revision, the seeds, the hardware,
the prompts and the decoding settings — not just a score. A metric without those is
an advertisement, not a result.

Licence is a required field. Every weight released through here has to name the
licence it is distributed under, because the project brief makes redistributing a
model under an incompatible licence a blocking problem rather than a detail.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Mapping, Sequence

from .taxonomy import BenchmarkCategory, StageStatus

__all__ = [
    "ModelStatus",
    "EvaluationProvenance",
    "Requirement",
    "ModelCard",
    "ModelReleaseError",
    "ModelReleaseManager",
]


class ModelStatus:
    #: Registered, not yet evaluated against requirements.
    CANDIDATE = "candidate"
    #: Meets every declared requirement. Eligible for release, not yet released.
    VALIDATED = "validated"
    #: The version the system currently serves.
    RELEASED = "released"
    #: Was released, then superseded by a later release. Still rollback-eligible.
    SUPERSEDED = "superseded"
    #: Withdrawn. Kept for the audit trail, never rollback-eligible.
    RETIRED = "retired"
    #: Validation was attempted and failed.
    REJECTED = "rejected"


class ModelReleaseError(RuntimeError):
    """Raised when a promotion, release or rollback would break an invariant."""


@dataclass
class Requirement:
    """A threshold a candidate must meet to be validated."""

    metric: str
    minimum: float | None = None
    maximum: float | None = None
    category: BenchmarkCategory | None = None
    #: A hard requirement blocks release. A soft one is recorded as a limitation.
    hard: bool = True

    def __post_init__(self) -> None:
        if self.minimum is None and self.maximum is None:
            raise ValueError(f"requirement on '{self.metric}' needs a minimum, a maximum, or both")
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise ValueError(f"requirement on '{self.metric}' has minimum above maximum")

    def check(self, value: float | None) -> tuple[bool, str]:
        if value is None:
            return False, f"'{self.metric}' was not measured"
        if self.minimum is not None and value < self.minimum - 1e-12:
            return False, f"'{self.metric}' {value:.4f} is below the required minimum {self.minimum:.4f}"
        if self.maximum is not None and value > self.maximum + 1e-12:
            return False, f"'{self.metric}' {value:.4f} exceeds the allowed maximum {self.maximum:.4f}"
        return True, f"'{self.metric}' {value:.4f} meets the requirement"

    def to_dict(self) -> dict:
        return {
            "metric": self.metric,
            "minimum": self.minimum,
            "maximum": self.maximum,
            "category": self.category.value if self.category else None,
            "hard": self.hard,
        }


@dataclass
class EvaluationProvenance:
    """The conditions a metric was produced under.

    Without this a benchmark number cannot be compared to anything, because there
    is no way to tell whether two results were produced under comparable
    conditions. The project brief requires exact model version, licence,
    quantization, context configuration, hardware, prompts and decoding settings;
    this is where they live.
    """

    #: Exact identifier of what was evaluated, e.g. "ollama:qwen2.5:1.5b-instruct-q4_k_m".
    subject: str = ""
    #: What it was compared against, if anything.
    comparator: str = ""
    hardware: dict = field(default_factory=dict)
    #: Decoding / inference settings, not just the model.
    decoding: dict = field(default_factory=dict)
    context: dict = field(default_factory=dict)
    quantization: str | None = None
    #: The prompts actually used. Recorded, not summarised.
    prompts: list = field(default_factory=list)
    dataset_digest: str | None = None
    corpus_size: int | None = None
    queries: int | None = None
    #: Code revision the evaluation ran at.
    code_revision: str | None = None
    seed: int | None = None
    #: Anything that limits how far the result can be generalised.
    limitations: list = field(default_factory=list)
    #: Whether the evaluation actually ran here.
    status: StageStatus = StageStatus.COMPLETED
    measured_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "subject": self.subject,
            "comparator": self.comparator,
            "hardware": dict(self.hardware),
            "decoding": dict(self.decoding),
            "context": dict(self.context),
            "quantization": self.quantization,
            "prompts": list(self.prompts),
            "datasetDigest": self.dataset_digest,
            "corpusSize": self.corpus_size,
            "queries": self.queries,
            "codeRevision": self.code_revision,
            "seed": self.seed,
            "limitations": list(self.limitations),
            "status": self.status.value,
            "measuredAt": self.measured_at,
        }


@dataclass
class ModelCard:
    """One version of one model."""

    name: str
    version: str
    family: str
    licence: str
    weights_digest: str
    base_checkpoint: str | None = None
    config_digest: str | None = None
    dataset_digest: str | None = None
    parameter_count: int | None = None
    status: str = ModelStatus.CANDIDATE
    metrics: dict = field(default_factory=dict)
    provenance: EvaluationProvenance | None = None
    limitations: list = field(default_factory=list)
    requirements: tuple = ()
    validation: dict = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    released_at: float | None = None
    superseded_at: float | None = None
    retired_at: float | None = None
    parent_version: str | None = None
    artifacts: dict = field(default_factory=dict)
    history: list = field(default_factory=list)

    def __post_init__(self) -> None:
        for label, value in (("name", self.name), ("version", self.version), ("licence", self.licence)):
            if not value or not str(value).strip():
                raise ValueError(f"a model card requires a {label}")
        if not self.weights_digest or not str(self.weights_digest).strip():
            # A card with no digest cannot be told apart from any other weights,
            # which makes rollback and the release gate meaningless.
            raise ValueError("a model card requires a weights digest")

    @property
    def identifier(self) -> str:
        return f"{self.name}@{self.version}"

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "version": self.version,
            "identifier": self.identifier,
            "family": self.family,
            "licence": self.licence,
            "weightsDigest": self.weights_digest,
            "baseCheckpoint": self.base_checkpoint,
            "configDigest": self.config_digest,
            "datasetDigest": self.dataset_digest,
            "parameterCount": self.parameter_count,
            "status": self.status,
            "metrics": dict(self.metrics),
            "provenance": self.provenance.to_dict() if self.provenance else None,
            "limitations": list(self.limitations),
            "requirements": [requirement.to_dict() for requirement in self.requirements],
            "validation": dict(self.validation),
            "artifacts": dict(self.artifacts),
            "parentVersion": self.parent_version,
            "createdAt": self.created_at,
            "releasedAt": self.released_at,
            "supersededAt": self.superseded_at,
            "retiredAt": self.retired_at,
            "history": list(self.history),
        }

    def digest(self) -> str:
        encoded = json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()


class ModelReleaseManager:
    """Holds every card and enforces the promotion rules."""

    def __init__(self) -> None:
        self.cards: dict[str, ModelCard] = {}
        self._released: list[str] = []
        self._events: list[dict] = []

    def __len__(self) -> int:
        return len(self.cards)

    # --- registration -----------------------------------------------------

    def register(
        self,
        *,
        name: str,
        version: str,
        family: str,
        licence: str,
        weights_digest: str,
        requirements: Sequence[Requirement] = (),
        **kwargs,
    ) -> ModelCard:
        """Register a candidate. It is NOT released, and cannot be served yet."""
        identifier = f"{name}@{version}"
        if identifier in self.cards:
            raise ModelReleaseError(
                f"{identifier} is already registered; a version is immutable once recorded, "
                "register a new version instead of overwriting it"
            )
        card = ModelCard(
            name=name,
            version=version,
            family=family,
            licence=licence,
            weights_digest=weights_digest,
            requirements=tuple(requirements),
            **kwargs,
        )
        card.history.append({"at": card.created_at, "event": "registered", "status": card.status})
        self.cards[identifier] = card
        self._log("registered", identifier)
        return card

    def card(self, identifier: str) -> ModelCard:
        try:
            return self.cards[identifier]
        except KeyError:
            raise KeyError(f"unknown model '{identifier}'; registered: {sorted(self.cards)}") from None

    def list(self, *, name: str | None = None, status: str | None = None) -> list[ModelCard]:
        return [
            card
            for card in self.cards.values()
            if (name is None or card.name == name) and (status is None or card.status == status)
        ]

    # --- validation -------------------------------------------------------

    def validate(
        self,
        identifier: str,
        metrics: Mapping[str, float],
        *,
        provenance: EvaluationProvenance | None = None,
    ) -> ModelCard:
        """Check a candidate against its declared requirements.

        Recording the metrics is not enough to release: the requirements decide.
        A candidate that fails is marked REJECTED with the reasons, and stays that
        way until new evidence is supplied.
        """
        card = self.card(identifier)
        if card.status == ModelStatus.RELEASED:
            raise ModelReleaseError(f"{identifier} is the live release; register a new version to change it")
        if card.status == ModelStatus.RETIRED:
            raise ModelReleaseError(f"{identifier} is retired and cannot be revalidated")
        if not card.requirements:
            raise ModelReleaseError(
                f"{identifier} declares no requirements; without them 'validated' would mean nothing"
            )

        card.metrics = {key: float(value) for key, value in metrics.items()}
        if provenance is not None:
            card.provenance = provenance

        hard_failures, soft_failures, passed = [], [], []
        for requirement in card.requirements:
            ok, reason = requirement.check(card.metrics.get(requirement.metric))
            if ok:
                passed.append(reason)
            elif requirement.hard:
                hard_failures.append(reason)
            else:
                soft_failures.append(reason)

        card.validation = {
            "passed": passed,
            "hardFailures": hard_failures,
            "softFailures": soft_failures,
            "validatedAt": time.time(),
            "metrics": dict(card.metrics),
        }
        for note in soft_failures:
            if note not in card.limitations:
                card.limitations.append(note)

        if hard_failures:
            card.status = ModelStatus.REJECTED
            card.history.append({"at": time.time(), "event": "validation_failed", "reasons": hard_failures})
            self._log("validation_failed", identifier, reasons=hard_failures)
        else:
            card.status = ModelStatus.VALIDATED
            card.history.append({"at": time.time(), "event": "validated", "passed": passed})
            self._log("validated", identifier)
        return card

    # --- release ----------------------------------------------------------

    def release(self, identifier: str, *, notes: str = "") -> ModelCard:
        """Promote a validated candidate, superseding the previous release."""
        card = self.card(identifier)
        if card.status == ModelStatus.RELEASED:
            return card
        if card.status != ModelStatus.VALIDATED:
            # This is the gate. A candidate, a rejected card and a retired card all
            # stop here, which is what prevents unvalidated weights from shipping.
            raise ModelReleaseError(
                f"{identifier} is '{card.status}', not validated; it cannot be released. "
                f"Validation: {json.dumps(card.validation.get('hardFailures') or 'not attempted')}"
            )
        if card.provenance is None:
            raise ModelReleaseError(
                f"{identifier} has no evaluation provenance; a release must be able to say "
                "what hardware, data and settings its metrics came from"
            )
        if card.provenance.status.blocked:
            raise ModelReleaseError(
                f"{identifier} was evaluated with status '{card.provenance.status.value}'; "
                "a blocked evaluation is not evidence"
            )

        previous = self.current()
        if previous is not None:
            previous.status = ModelStatus.SUPERSEDED
            previous.superseded_at = time.time()
            previous.history.append({"at": previous.superseded_at, "event": "superseded", "by": identifier})
            self._log("superseded", previous.identifier, by=identifier)

        card.status = ModelStatus.RELEASED
        card.released_at = time.time()
        if previous is not None and card.parent_version is None:
            card.parent_version = previous.version
        card.history.append({"at": card.released_at, "event": "released", "notes": notes, "superseded": previous.identifier if previous else None})
        self._released.append(identifier)
        self._log("released", identifier, notes=notes)
        return card

    def current(self) -> ModelCard | None:
        """The live release, if any."""
        for card in self.cards.values():
            if card.status == ModelStatus.RELEASED:
                return card
        return None

    def rollback(self, identifier: str, *, reason: str) -> ModelCard:
        """Return to a previously released version.

        Only a SUPERSEDED version that was validated can be rolled back to. A
        retired or rejected one cannot, because rolling back to something known to
        be bad is worse than staying on the current release.
        """
        if not reason or not reason.strip():
            raise ModelReleaseError("a rollback needs a reason")
        card = self.card(identifier)
        if card.status == ModelStatus.RELEASED:
            return card
        if card.status != ModelStatus.SUPERSEDED:
            # This also covers RETIRED and REJECTED: rolling back to something
            # known to be bad is worse than staying on the current release.
            raise ModelReleaseError(
                f"{identifier} is '{card.status}'; only a superseded release can be rolled back to"
            )

        live = self.current()
        if live is not None:
            live.status = ModelStatus.RETIRED
            live.retired_at = time.time()
            live.history.append({"at": live.retired_at, "event": "retired", "reason": reason, "rolledBackTo": identifier})
            self._log("retired", live.identifier, reason=reason)

        card.status = ModelStatus.RELEASED
        card.released_at = time.time()
        card.history.append({"at": card.released_at, "event": "rolled_back_to", "reason": reason})
        self._released.append(identifier)
        self._log("rolled_back_to", identifier, reason=reason)
        return card

    def retire(self, identifier: str, *, reason: str) -> ModelCard:
        """Withdraw a version permanently. It can no longer be released or rolled back to."""
        if not reason or not reason.strip():
            raise ModelReleaseError("retiring a model needs a reason")
        card = self.card(identifier)
        was_live = card.status == ModelStatus.RELEASED
        card.status = ModelStatus.RETIRED
        card.retired_at = time.time()
        card.history.append({"at": card.retired_at, "event": "retired", "reason": reason, "wasLive": was_live})
        self._log("retired", identifier, reason=reason)
        return card

    # --- inspection -------------------------------------------------------

    def rollback_targets(self) -> list[ModelCard]:
        """Versions that a rollback could legally return to."""
        return [card for card in self.cards.values() if card.status == ModelStatus.SUPERSEDED]

    def release_history(self) -> list[str]:
        return list(self._released)

    def events(self) -> list[dict]:
        return list(self._events)

    def summary(self) -> dict:
        by_status: dict[str, int] = {}
        for card in self.cards.values():
            by_status[card.status] = by_status.get(card.status, 0) + 1
        current = self.current()
        return {
            "models": len(self.cards),
            "byStatus": by_status,
            "current": current.identifier if current else None,
            "rollbackTargets": [card.identifier for card in self.rollback_targets()],
            "releases": len(self._released),
        }

    def _log(self, event: str, identifier: str, **extra) -> None:
        self._events.append({"at": time.time(), "event": event, "model": identifier, **extra})

    # --- persistence ------------------------------------------------------

    def to_dict(self) -> dict:
        return {
            "format": "aetheris-model-registry/1",
            "cards": {identifier: card.to_dict() for identifier, card in self.cards.items()},
            "released": list(self._released),
            "events": list(self._events),
            "summary": self.summary(),
        }

    def save(self, path) -> Path:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(self.to_dict(), indent=2, sort_keys=True), encoding="utf-8")
        return target

    @classmethod
    def load(cls, path) -> "ModelReleaseManager":
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        if payload.get("format") != "aetheris-model-registry/1":
            raise ValueError(f"unsupported model registry format: {payload.get('format')!r}")
        manager = cls()
        for identifier, entry in payload.get("cards", {}).items():
            provenance = None
            if entry.get("provenance"):
                raw = entry["provenance"]
                provenance = EvaluationProvenance(
                    subject=raw.get("subject", ""),
                    comparator=raw.get("comparator", ""),
                    hardware=raw.get("hardware", {}),
                    decoding=raw.get("decoding", {}),
                    context=raw.get("context", {}),
                    quantization=raw.get("quantization"),
                    prompts=raw.get("prompts", []),
                    dataset_digest=raw.get("datasetDigest"),
                    corpus_size=raw.get("corpusSize"),
                    queries=raw.get("queries"),
                    code_revision=raw.get("codeRevision"),
                    seed=raw.get("seed"),
                    limitations=raw.get("limitations", []),
                    status=StageStatus(raw.get("status", "completed")),
                    measured_at=raw.get("measuredAt", time.time()),
                )
            card = ModelCard(
                name=entry["name"],
                version=entry["version"],
                family=entry["family"],
                licence=entry["licence"],
                weights_digest=entry["weightsDigest"],
                base_checkpoint=entry.get("baseCheckpoint"),
                config_digest=entry.get("configDigest"),
                dataset_digest=entry.get("datasetDigest"),
                parameter_count=entry.get("parameterCount"),
                status=entry.get("status", ModelStatus.CANDIDATE),
                metrics=entry.get("metrics", {}),
                provenance=provenance,
                limitations=entry.get("limitations", []),
                requirements=tuple(
                    Requirement(
                        metric=item["metric"],
                        minimum=item.get("minimum"),
                        maximum=item.get("maximum"),
                        category=BenchmarkCategory(item["category"]) if item.get("category") else None,
                        hard=item.get("hard", True),
                    )
                    for item in entry.get("requirements", [])
                ),
                validation=entry.get("validation", {}),
                artifacts=entry.get("artifacts", {}),
                parent_version=entry.get("parentVersion"),
                created_at=entry.get("createdAt", time.time()),
                released_at=entry.get("releasedAt"),
                superseded_at=entry.get("supersededAt"),
                retired_at=entry.get("retiredAt"),
                history=entry.get("history", []),
            )
            manager.cards[identifier] = card
        manager._released = list(payload.get("released", []))
        manager._events = list(payload.get("events", []))
        return manager

    def digest(self) -> str:
        encoded = json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()
