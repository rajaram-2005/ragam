"""Redaction and authorization for text leaving the machine.

Why this exists: distillation from an **external** teacher means sending repository
text to a third party. The standing rule is that company-private material defaults to
local processing and needs explicit authorization to leave, so the corpus builder
cannot be a thin wrapper around an HTTP client -- it needs a gate, and the gate has to
be enforced rather than documented.

Why it is a second implementation. `services/core/src/policy/classify.mjs` is the
authority for text leaving through the application, and it is JavaScript. This service
is Python and cannot import it, and adding an HTTP classification route purely so a
batch script can call it would expose a new endpoint to solve an offline problem. So
the patterns are mirrored, and the mirror is **pinned by a fixture generated from the
Node implementation** (`tests/fixtures/redaction-parity.json`, produced by
`scripts/generate-redaction-parity-fixture.mjs`). Fixture generation fails if any
pattern declared in `classify.mjs` is not exercised by a probe, so a pattern cannot be
added on one side and silently missed on the other.

Scope, stated plainly: this covers the same 16 credential patterns as the core
classifier. It is **not** the core classifier and does not classify data sensitivity --
`classifyText` in `classify.mjs` remains authoritative for that. Nothing here should be
used to decide whether content is sensitive; it decides whether content still contains
a recognizable credential.

The gate itself is deliberately awkward. Sending repository text to an external model
requires an explicit `Authorization` object naming who authorized it and why, and the
default is refusal. A gate that passes by default is a formality, and this one exists
because the default answer is supposed to be no.
"""

from __future__ import annotations

import hashlib
import re
import time
from dataclasses import dataclass, field

#: Mirrors SECRET_PATTERNS in services/core/src/policy/classify.mjs, in the same
#: order. Order is load-bearing there for the same reason it is here: the first match
#: consumes the text, so a specific pattern must precede any general one that also
#: matches it. `sk-ant-...` satisfies both, so anthropic precedes openai.
SECRET_PATTERNS: tuple[tuple[str, str], ...] = (
    ("anthropic_style_key", r"\bsk-ant-[A-Za-z0-9_-]{16,}\b"),
    ("openai_style_key", r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    ("github_token", r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    ("aws_access_key_id", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    ("google_api_key", r"\bAIza[0-9A-Za-z_-]{30,}\b"),
    ("slack_token", r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
    ("stripe_key", r"\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b"),
    ("private_key_block", r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
    ("jwt", r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
    ("bearer_header", r"\bauthorization\s*[:=]\s*bearer\s+\S+"),
    ("generic_assignment_secret", r"\b(?:api[_-]?key|secret|passwd|password|token)\b\s*[:=]\s*['\"]?[^\s'\"]{8,}['\"]?"),
    (
        "env_style_secret",
        r"(?:^|[^A-Za-z0-9_])([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[:=]\s*['\"]?[^\s'\";,}]{8,}",
    ),
    ("azure_account_key", r"\bAccountKey=[A-Za-z0-9+/=]{20,}"),
    ("npm_token", r"\bnpm_[A-Za-z0-9]{30,}\b"),
    ("connection_string", r"\b(?:postgres|postgresql|mysql|mongodb|redis|amqp)://[^\s'\"]+:[^\s'\"]+@[^\s'\"]+"),
    ("url_basic_auth", r"\bhttps?://[^\s/:@'\"]+:[^\s@'\"]+@[^\s'\"/]+"),
)

#: Patterns that are case-insensitive in the Node source.
_CASE_INSENSITIVE = frozenset(
    {"bearer_header", "generic_assignment_secret", "azure_account_key", "connection_string", "url_basic_auth"}
)

_COMPILED: tuple[tuple[str, re.Pattern], ...] = tuple(
    (name, re.compile(pattern, re.IGNORECASE if name in _CASE_INSENSITIVE else 0))
    for name, pattern in SECRET_PATTERNS
)


@dataclass(frozen=True)
class Redaction:
    text: str
    findings: tuple[str, ...]

    @property
    def changed(self) -> bool:
        return bool(self.findings)

    def to_dict(self) -> dict:
        return {"findings": list(self.findings), "changed": self.changed, "redactedLength": len(self.text)}


def redact_secrets(text: str) -> Redaction:
    """Replace recognizable credentials with an explicit marker.

    Marked, not deleted, for the same reason the Node implementation marks them: a
    silently shortened string changes the text the model is being taught from, and
    whoever reads the corpus later needs to know something was removed and what kind
    of thing it was.
    """
    if not text:
        return Redaction(text="", findings=())
    out = text
    findings: list[str] = []
    for name, pattern in _COMPILED:
        def _replace(_match, _name=name):
            findings.append(_name)
            return f"[REDACTED:{_name}]"

        out = pattern.sub(_replace, out)
    return Redaction(text=out, findings=tuple(dict.fromkeys(findings)))


@dataclass(frozen=True)
class Authorization:
    """An explicit decision to send content to an external model.

    Required by `ExternalTeacher`. There is no default instance and no way to
    construct one without naming who authorized it and why, because the whole point
    is that this decision is attributable.
    """

    authorized_by: str
    reason: str
    scope: str = "repository text"
    acknowledged_external_transfer: bool = False
    at: float = field(default_factory=time.time)

    def __post_init__(self) -> None:
        if not self.authorized_by or not self.authorized_by.strip():
            raise ValueError("an authorization must name who granted it")
        if not self.reason or not self.reason.strip():
            raise ValueError("an authorization must state why")
        if not self.acknowledged_external_transfer:
            raise ValueError(
                "an authorization must acknowledge that the content leaves this machine; "
                "construct it with acknowledged_external_transfer=True once that is understood"
            )

    def to_dict(self) -> dict:
        return {
            "authorizedBy": self.authorized_by,
            "reason": self.reason,
            "scope": self.scope,
            "at": self.at,
            "acknowledgedExternalTransfer": self.acknowledged_external_transfer,
        }

    @property
    def digest(self) -> str:
        import json

        payload = {k: v for k, v in self.to_dict().items() if k != "at"}
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


class ExternalTransferRefused(RuntimeError):
    """Raised instead of sending content when the gate does not permit it."""


def gate_send(text: str, *, authorization: Authorization | None, allow_secrets: bool = False) -> Redaction:
    """Decide whether `text` may be sent externally, and return it redacted.

    Three rules, in order:

    1. **No authorization, no transfer.** Refusal, not a warning.
    2. **Redact recognizable credentials before sending.** Even with authorization,
       a key does not need to be sent for the teacher to continue a sentence.
    3. **Refuse if a credential survives redaction**, unless explicitly overridden.
       Redaction is a set of patterns, and a pattern set has gaps; "we redacted what we
       recognized" is not the same as "there is nothing sensitive left". The check is
       on the text that would actually go out, which is the only text that matters.
    """
    if authorization is None:
        raise ExternalTransferRefused(
            "no authorization: external distillation requires an explicit Authorization naming "
            "who approved sending repository text to a third-party model"
        )
    if not isinstance(authorization, Authorization):  # pragma: no cover - defensive
        raise TypeError(f"expected an Authorization, got {type(authorization).__name__}")

    redaction = redact_secrets(text)
    # Re-scan the outgoing text. Any finding here means a credential the first pass
    # could not consume -- for example one that spans a replacement marker.
    residual = redact_secrets(redaction.text).findings
    if residual and not allow_secrets:
        raise ExternalTransferRefused(
            f"a credential survived redaction ({', '.join(residual)}); refusing to send. "
            "Pass allow_secrets=True only after inspecting the text by hand."
        )
    return redaction
