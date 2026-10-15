"""Admission of conversation-derived examples into a review queue. It never trains.

Experience-driven learning is allowed only through this gate. A conversation that
goes well can become a candidate example. An example is admitted when it has
consent, is free of secret-like text, and has a passing quality score from a named
reviewer. Admission changes no weights. An admitted example waits in a queue until a
person starts a training job that names it, and the job then passes the same
licence, privacy and provenance checks as any other dataset.

The module deliberately has no import of the trainer or the runner. A test checks
that, so an edit that wires admission straight to training fails loudly.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from fabric.lm.privacy import redact_secrets

MIN_QUALITY = 0.8


@dataclass(frozen=True)
class Example:
    example_id: str
    prompt: str
    response: str
    source: str
    consent: bool
    consent_basis: str
    reviewer: str
    quality_score: float


@dataclass(frozen=True)
class Admission:
    example_id: str
    admitted: bool
    reasons: tuple = field(default_factory=tuple)
    redaction_findings: tuple = field(default_factory=tuple)


def admit(example: Example, *, min_quality: float = MIN_QUALITY) -> Admission:
    reasons: list = []
    if not example.example_id or not example.example_id.strip():
        reasons.append("no example id")
    if not example.prompt.strip() or not example.response.strip():
        reasons.append("prompt and response must both be non-empty")
    if example.consent is not True or not example.consent_basis.strip():
        reasons.append("the user's consent and its basis must be recorded")
    if not example.reviewer.strip():
        reasons.append("a reviewer must be named")
    if not isinstance(example.quality_score, (int, float)) or not 0.0 <= example.quality_score <= 1.0:
        reasons.append("quality score must be between 0 and 1")
    elif example.quality_score < min_quality:
        reasons.append(f"quality {example.quality_score:.2f} is below the threshold {min_quality:.2f}")

    # Reject rather than repair. A redacted secret is still a leaked secret in the
    # transcript, and a model trained on it has learned that it was once present.
    findings = []
    for text in (example.prompt, example.response):
        redaction = redact_secrets(text)
        findings.extend(redaction.findings)
    if findings:
        reasons.append("contains secret-like text: " + ", ".join(sorted(set(findings))))

    return Admission(
        example_id=example.example_id,
        admitted=not reasons,
        reasons=tuple(reasons),
        redaction_findings=tuple(sorted(set(findings))),
    )
