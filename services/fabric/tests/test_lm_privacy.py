"""The external-transfer gate, and the parity of the Python redactor with Node.

Two things are being defended here. First, that a credential cannot leave the machine
even when someone has authorized an external send. Second, that the Python copy of the
patterns still agrees with the Node original -- a security control implemented twice is
a liability unless the two are pinned together, and the pinning is what this file does.

The fixture is generated from `services/core/src/policy/classify.mjs` by
`scripts/generate-redaction-parity-fixture.mjs`, which refuses to emit anything unless
every pattern declared in the Node source is exercised by at least one probe. That
refusal is what stops this suite passing because the probe set happens to miss a
pattern -- the "passes by omission" failure mode already found once in this project.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from fabric.lm.privacy import (
    SECRET_PATTERNS,
    Authorization,
    ExternalTransferRefused,
    gate_send,
    redact_secrets,
)

FIXTURE = Path(__file__).parent / "fixtures" / "redaction-parity.json"


@pytest.fixture(scope="module")
def fixture():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Parity with the Node implementation
# ---------------------------------------------------------------------------


def test_the_fixture_exercises_every_pattern_the_node_source_declares(fixture):
    """If this fails, the parity below is only testing the patterns we happened to probe."""
    declared = set(fixture["declaredPatterns"])
    exercised = {name for probe in fixture["probes"] for name in probe["findings"]}
    assert exercised == declared, f"unexercised patterns: {sorted(declared - exercised)}"
    assert len(declared) == 16, f"classify.mjs declares {len(declared)} patterns; this suite pins 16"


def test_the_python_pattern_list_matches_the_node_names(fixture):
    assert {name for name, _ in SECRET_PATTERNS} == set(fixture["declaredPatterns"])


def test_python_finds_what_node_finds(fixture):
    for probe in fixture["probes"]:
        mine = sorted(redact_secrets(probe["text"]).findings)
        theirs = sorted(probe["findings"])
        assert mine == theirs, f"disagreement on {probe['text'][:60]!r}: node={theirs} python={mine}"


def test_python_redacts_to_the_same_text_as_node(fixture):
    """Not just the same findings: the same output bytes.

    A corpus built by one implementation and audited by the other would differ if the
    markers or the replacement order differed, and the difference would be invisible.
    """
    for probe in fixture["probes"]:
        assert redact_secrets(probe["text"]).text == probe["redacted"], f"on {probe['text'][:60]!r}"


def test_known_clean_text_is_not_redacted(fixture):
    """Over-redaction is also a defect: it removes the signal the corpus exists for."""
    for probe in fixture["probes"]:
        if probe["expectedPattern"] is None:
            assert redact_secrets(probe["text"]).findings == (), probe["text"][:60]


def test_each_pattern_is_tripped_by_the_probe_that_names_it(fixture):
    for probe in fixture["probes"]:
        if probe["expectedPattern"]:
            assert probe["expectedPattern"] in redact_secrets(probe["text"]).findings


# ---------------------------------------------------------------------------
# Redaction behaviour
# ---------------------------------------------------------------------------


def test_a_credential_is_marked_not_deleted():
    """A silently shortened string hides that anything was removed."""
    redacted = redact_secrets("key is sk-proj-abcdefghijklmnopqrstuvwxyz0123 ok")
    assert "[REDACTED:openai_style_key]" in redacted.text
    assert "sk-proj" not in redacted.text
    assert redacted.text.startswith("key is ")
    assert redacted.text.endswith(" ok")


def test_findings_are_reported_once_each():
    text = "a: sk-proj-aaaaaaaaaaaaaaaaaaaa b: sk-proj-bbbbbbbbbbbbbbbbbbbb"
    findings = redact_secrets(text).findings
    assert findings.count("openai_style_key") == 1


def test_a_specific_pattern_is_reported_by_its_own_name():
    """The Node list had the OpenAI pattern first, making this one unreachable.

    Found by the coverage check in the fixture generator. The credential was redacted
    either way, so nothing failed loudly -- only the audit-trail name was wrong.
    """
    assert redact_secrets("k sk-ant-api03-abcdefghijklmnopqrstuvwx").findings == ("anthropic_style_key",)
    assert redact_secrets("k sk-proj-abcdefghijklmnopqrstuvwxyz0123").findings == ("openai_style_key",)


def test_a_short_non_key_is_left_alone():
    assert redact_secrets("a short key like sk-abc is not a credential").findings == ()


def test_empty_and_non_string_input_are_safe():
    assert redact_secrets("").findings == ()
    assert redact_secrets("").text == ""


# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------


def test_without_authorization_nothing_is_sent():
    with pytest.raises(ExternalTransferRefused, match="no authorization"):
        gate_send("ordinary repository text", authorization=None)


def test_an_authorization_must_name_who_and_why():
    for kwargs, message in (
        ({"authorized_by": "  ", "reason": "because"}, "must name who"),
        ({"authorized_by": "alice", "reason": ""}, "must state why"),
        ({"authorized_by": "alice", "reason": "r", "acknowledged_external_transfer": False}, "must acknowledge"),
    ):
        with pytest.raises(ValueError, match=message):
            Authorization(**kwargs)


def test_an_authorization_records_the_decision():
    authorization = Authorization(
        authorized_by="rajaram", reason="distillation corpus", acknowledged_external_transfer=True
    )
    payload = authorization.to_dict()
    assert payload["authorizedBy"] == "rajaram"
    assert payload["reason"] == "distillation corpus"
    assert payload["acknowledgedExternalTransfer"] is True
    # The digest must be stable regardless of when the decision was made.
    later = Authorization(
        authorized_by="rajaram", reason="distillation corpus",
        acknowledged_external_transfer=True, at=authorization.at + 10_000,
    )
    assert authorization.digest == later.digest


def test_authorized_text_is_redacted_before_it_leaves():
    """Authorization permits the transfer; it does not permit sending the credential."""
    authorization = Authorization(authorized_by="a", reason="r", acknowledged_external_transfer=True)
    result = gate_send(
        "config: sk-proj-abcdefghijklmnopqrstuvwxyz0123 and the rest of the paragraph",
        authorization=authorization,
    )
    assert "sk-proj" not in result.text
    assert result.findings == ("openai_style_key",)
    assert "the rest of the paragraph" in result.text, "the gate must not discard the content"


def test_no_pattern_in_the_current_set_leaves_a_residual(fixture):
    """A property of the pattern set as it stands: one pass consumes everything.

    This is worth asserting rather than assuming, because the re-scan below only ever
    fires when it stops being true. If a future pattern can match its own replacement
    marker, this test says so.
    """
    for probe in fixture["probes"]:
        once = redact_secrets(probe["text"])
        assert redact_secrets(once.text).findings == (), (
            f"redaction left a findable credential in {probe['text'][:50]!r}: {once.text[:80]!r}"
        )


def test_the_gate_refuses_when_a_credential_survives_redaction(monkeypatch):
    """The re-scan mechanism, exercised directly.

    No probe in the fixture can produce a residual with the current patterns, so
    waiting for one to appear would mean testing nothing. The pattern list is replaced
    with one that matches its own replacement marker instead -- `aaa` in the text
    becomes `[REDACTED:aaa]`, which still contains `aaa` -- and the gate must refuse.
    """
    authorization = Authorization(authorized_by="a", reason="r", acknowledged_external_transfer=True)

    # Confirm the real gate passes this text first, so the monkeypatch is what changes
    # the outcome rather than the input.
    assert gate_send("x aaab x", authorization=authorization).text == "x aaab x"

    monkeypatch.setattr("fabric.lm.privacy._COMPILED", ((("aaa", re.compile("aaa"))),))
    with pytest.raises(ExternalTransferRefused, match="survived redaction"):
        gate_send("x aaab x", authorization=authorization)


def test_clean_text_passes_the_gate_unchanged():
    authorization = Authorization(authorized_by="a", reason="r", acknowledged_external_transfer=True)
    result = gate_send("The contactor must open within 250 milliseconds.", authorization=authorization)
    assert result.findings == ()
    assert result.text == "The contactor must open within 250 milliseconds."


def test_the_refusal_type_is_distinguishable_from_a_plain_error():
    """Callers must be able to tell a policy refusal from a bug."""
    assert issubclass(ExternalTransferRefused, RuntimeError)
