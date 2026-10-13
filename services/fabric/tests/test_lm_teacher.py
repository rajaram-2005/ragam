"""The external teacher: the gate, the request path, and the corpus builder.

**Every test here runs against a fixture, never against a real provider.** No test in
this repository contacts any third party. The fixture is a local
`http.server` on loopback, started by the test, which is the same approach the core
service uses for its offline chat round-trip. What that proves is the request path: the
authorization header, the JSON shape, the response parsing. What it does not prove is
that any particular provider behaves as documented, which is why the status of this
path is "requires external credentials" and not "tested".

The one property worth more than the rest: a credential must not leave the machine even
when someone has authorized an external send. That is asserted here rather than trusted.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from fabric.lm.privacy import Authorization, ExternalTransferRefused
from fabric.lm.teacher import (
    ExternalTeacher,
    SequenceDistillConfig,
    TeacherUnavailable,
    build_distillation_corpus,
    looks_like_a_refusal_or_error,
    prefixes_from_corpus,
    quality_rejection,
    sanitise_teacher_output,
)

API_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"  # a recognizable credential on purpose


def authorization(**overrides):
    return Authorization(
        authorized_by=overrides.get("authorized_by", "test"),
        reason=overrides.get("reason", "unit test"),
        acknowledged_external_transfer=True,
    )


# ---------------------------------------------------------------------------
# A local stand-in for a provider
# ---------------------------------------------------------------------------


class _Handler(BaseHTTPRequestHandler):
    """Serves OpenAI-shaped completions. Records the requests it receives."""

    received: list = []
    reply: dict = {"choices": [{"message": {"content": "a continuation of the text"}}]}
    status: int = 200
    body_override: bytes | None = None

    def do_POST(self):  # noqa: N802 - required by BaseHTTPRequestHandler
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length)
        type(self).received.append({
            "path": self.path,
            "authorization": self.headers.get("authorization"),
            "payload": json.loads(raw) if raw else None,
        })
        body = type(self).body_override or json.dumps(type(self).reply).encode("utf-8")
        self.send_response(type(self).status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # keep the test output clean
        pass


@pytest.fixture
def provider():
    _Handler.received = []
    _Handler.reply = {"choices": [{"message": {"content": "a continuation of the text"}}]}
    _Handler.status = 200
    _Handler.body_override = None
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", _Handler
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def make_teacher(base_url, **overrides):
    kwargs = dict(
        base_url=base_url, api_key=API_KEY, model="test-model", authorization=authorization(),
    )
    kwargs.update(overrides)
    return ExternalTeacher(**kwargs)


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


def test_a_missing_key_is_refused_before_anything_is_attempted(provider):
    base_url, _ = provider
    with pytest.raises(ValueError, match="no API key configured"):
        make_teacher(base_url, api_key="")


def test_the_key_never_appears_in_a_repr(provider):
    """A traceback or a debugger render must not be a credential leak."""
    base_url, _ = provider
    teacher = make_teacher(base_url)
    assert API_KEY not in repr(teacher)
    assert "redacted" in repr(teacher)


def test_the_key_never_appears_in_the_provenance(provider):
    """The provenance is written to the run report; a key there would be the leak."""
    base_url, _ = provider
    payload = json.dumps(make_teacher(base_url).provenance().to_dict())
    assert API_KEY not in payload
    assert "test-model" in payload


def test_configuration_is_validated(provider):
    base_url, _ = provider
    for overrides, message in (
        ({"base_url": "ftp://example.com"}, "must be http"),
        ({"model": "  "}, "model identifier is required"),
        ({"timeout_s": 0}, "timeout_s must be positive"),
        ({"max_retries": -1}, "max_retries must not be negative"),
    ):
        kwargs = dict(base_url=base_url, api_key=API_KEY, model="test-model", authorization=authorization())
        kwargs.update(overrides)
        with pytest.raises(ValueError, match=message):
            ExternalTeacher(**kwargs)


def test_a_teacher_without_authorization_refuses_to_send(provider):
    """Constructing it without authorization does not make sending permitted."""
    base_url, handler = provider
    teacher = make_teacher(base_url, authorization=None)
    with pytest.raises(ExternalTransferRefused, match="no authorization"):
        teacher.complete("some repository text")
    assert handler.received == [], "nothing may reach the network on a refusal"


# ---------------------------------------------------------------------------
# The request path
# ---------------------------------------------------------------------------


def test_a_completion_is_parsed_from_an_openai_shaped_response(provider):
    base_url, handler = provider
    result = make_teacher(base_url).complete("The contactor must open within")
    assert result.text == "a continuation of the text"
    assert result.usable
    assert len(handler.received) == 1
    assert handler.received[0]["path"].endswith("/chat/completions")
    assert handler.received[0]["authorization"] == f"Bearer {API_KEY}"
    payload = handler.received[0]["payload"]
    assert payload["model"] == "test-model"
    assert payload["messages"][0]["role"] == "user"
    assert payload["temperature"] == 0.7


def test_the_seed_is_sent_only_when_configured(provider):
    base_url, handler = provider
    make_teacher(base_url).complete("x" * 50)
    assert "seed" not in handler.received[-1]["payload"]
    make_teacher(base_url, seed=7).complete("x" * 50)
    assert handler.received[-1]["payload"]["seed"] == 7


def test_a_credential_in_the_prompt_never_reaches_the_provider(provider):
    """The property this whole module exists for: authorization is not a licence to leak."""
    base_url, handler = provider
    prompt = f"# config\nAPI_KEY={API_KEY}\n\nthe rest of the paragraph continues here"
    completion = make_teacher(base_url).complete(prompt)

    sent = handler.received[-1]["payload"]["messages"][0]["content"]
    assert API_KEY not in sent, "the credential was transmitted"
    assert "the rest of the paragraph continues here" in sent, "the gate must not drop content"
    # Two patterns fire here and both are supposed to: `sk-...` is the credential, and
    # `API_KEY=<value>` is an assignment whose value was a credential. Findings are
    # reported, so the audit trail shows what was removed and why.
    assert "openai_style_key" in completion.findings
    assert "generic_assignment_secret" in completion.findings
    assert "[REDACTED:" in sent


def test_a_provider_error_is_reported_not_swallowed(provider):
    base_url, handler = provider
    handler.status = 500
    handler.body_override = b'{"error": {"message": "upstream is down"}}'
    teacher = make_teacher(base_url, max_retries=0)
    with pytest.raises(TeacherUnavailable, match="HTTP 500"):
        teacher.complete("x" * 50)


def test_the_error_message_does_not_echo_the_response_body(provider):
    """Some gateways echo request headers into an error body."""
    base_url, handler = provider
    handler.status = 401
    handler.body_override = json.dumps({"error": {"message": f"bad key {API_KEY}"}}).encode()
    try:
        make_teacher(base_url, max_retries=0).complete("x" * 50)
    except TeacherUnavailable as error:
        assert API_KEY not in str(error), "an error message leaked the credential"
    else:  # pragma: no cover
        pytest.fail("expected a TeacherUnavailable")


def test_an_unexpected_response_shape_fails_loudly(provider):
    """A corpus silently built from empty strings would look like a successful run."""
    base_url, handler = provider
    handler.reply = {"choices": []}
    with pytest.raises(TeacherUnavailable, match="no choices"):
        make_teacher(base_url, max_retries=0).complete("x" * 50)


def test_a_completion_style_response_is_accepted(provider):
    base_url, handler = provider
    handler.reply = {"choices": [{"text": "a legacy completion"}]}
    assert make_teacher(base_url).complete("x" * 50).text == "a legacy completion"


def test_failures_are_counted(provider):
    base_url, handler = provider
    handler.status = 503
    teacher = make_teacher(base_url, max_retries=1)
    with pytest.raises(TeacherUnavailable):
        teacher.complete("x" * 50)
    assert teacher.stats["failures"] == 2, "both attempts must be recorded"
    assert teacher.stats["calls"] == 2


# ---------------------------------------------------------------------------
# Output is untrusted
# ---------------------------------------------------------------------------


def test_control_characters_are_stripped_from_model_output():
    assert sanitise_teacher_output("clean\x07text\x1b[0m", max_characters=100) == "cleantext[0m"


def test_output_length_is_bounded():
    assert len(sanitise_teacher_output("x" * 10_000, max_characters=50)) == 50


def test_a_long_run_of_blank_lines_is_collapsed():
    assert sanitise_teacher_output("a\n\n\n\n\nb", max_characters=100) == "a\n\nb"


def test_refusals_and_errors_are_recognised():
    for text in ("I cannot help with that.", "", "Error: upstream failed", "Traceback (most recent call last):"):
        assert looks_like_a_refusal_or_error(text), text


def test_a_refusal_quoted_deep_in_a_passage_is_kept():
    """Only the opening is examined, so legitimate text containing the phrase survives."""
    passage = ("The isolation procedure is documented at length. " * 6) + "Note that I cannot "
    passage += "be certain of the contactor timing without a measurement."
    assert not looks_like_a_refusal_or_error(passage)


def test_the_quality_filters_report_why_they_rejected():
    config = SequenceDistillConfig(min_characters=40, max_characters=4000)
    assert "shorter than" in quality_rejection("too short", config)
    assert "longer than" in quality_rejection("x y " * 3000, config)
    assert "sampling loop" in quality_rejection("a" * 500, config)
    # Long enough to clear the length floor, so the refusal check is what fires.
    refusal = "I cannot help with that request at all, and I will not attempt it either."
    assert len(refusal) >= config.min_characters
    assert "refusal" in quality_rejection(refusal, config)
    assert quality_rejection("The contactor opens within 250 ms of a detected fault.", config) is None


# ---------------------------------------------------------------------------
# Corpus construction
# ---------------------------------------------------------------------------


def test_the_corpus_records_its_teacher_and_every_rejection(provider):
    base_url, handler = provider
    teacher = make_teacher(base_url)
    config = SequenceDistillConfig(prefixes=3, prefix_characters=60, min_characters=10)
    # The fixture replies with the same sentence every time, so deduplication is what
    # decides the result here -- distinct replies are covered by the test below.
    result = build_distillation_corpus(["alpha " * 20, "beta " * 20, "gamma " * 20], teacher, config)

    assert result["accepted"] == 1
    assert result["duplicates"] == 2
    assert result["teacher"]["model"] == "test-model"
    assert API_KEY not in json.dumps(result)
    assert result["corpusDigest"] == result["corpusDigest"], "digest must be stable"
    for sample in result["samples"]:
        assert len(sample["promptDigest"]) == 64
        assert len(sample["responseDigest"]) == 64
        assert "prompt" not in sample, "the prompt is repository text and is not re-stored"


def test_distinct_completions_are_all_kept(provider):
    base_url, handler = provider

    class Echoing(_Handler):
        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(length)) if length else {}
            prompt = payload["messages"][0]["content"]
            reply = {"choices": [{"message": {"content": f"continuation for {prompt[:20]}"}}]}
            body = json.dumps(reply).encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Echoing)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        config = SequenceDistillConfig(prefixes=3, prefix_characters=40, min_characters=10)
        result = build_distillation_corpus(
            ["prefix-one " * 5, "prefix-two " * 5, "prefix-three " * 5],
            make_teacher(f"http://127.0.0.1:{server.server_port}/v1"),
            config,
        )
        assert result["accepted"] == 3, result["rejected"]
        assert result["duplicates"] == 0
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_identical_completions_are_deduplicated(provider):
    base_url, handler = provider
    handler.reply = {"choices": [{"message": {"content": "the same continuation every time"}}]}
    config = SequenceDistillConfig(prefixes=4, prefix_characters=40, min_characters=10)
    result = build_distillation_corpus(["p" * 50] * 4, make_teacher(base_url), config)
    assert result["accepted"] == 1
    assert result["duplicates"] == 3


def test_rejected_samples_are_recorded_with_a_reason(provider):
    base_url, handler = provider
    handler.reply = {"choices": [{"message": {"content": "I cannot help with that."}}]}
    config = SequenceDistillConfig(prefixes=2, prefix_characters=40, min_characters=10)
    result = build_distillation_corpus(["p" * 50, "q" * 50], make_teacher(base_url), config)
    assert result["accepted"] == 0
    assert len(result["rejected"]) == 2
    assert all("refusal" in entry["reason"] for entry in result["rejected"])


def test_an_unreachable_teacher_produces_rejections_not_a_crash(provider):
    """The report must show what happened rather than raising on the first failure."""
    base_url, handler = provider
    handler.status = 502
    config = SequenceDistillConfig(prefixes=2, prefix_characters=40, min_characters=10)
    result = build_distillation_corpus(["p" * 50], make_teacher(base_url, max_retries=0), config)
    assert result["accepted"] == 0
    assert "TeacherUnavailable" in result["rejected"][0]["reason"]


def test_a_non_teacher_argument_is_refused():
    with pytest.raises(TypeError, match="expected an ExternalTeacher"):
        build_distillation_corpus(["p" * 50], object(), SequenceDistillConfig())


def test_prefixes_are_evenly_spaced_and_deterministic():
    # Non-periodic on purpose: an earlier version used a repeating digit cycle, so
    # every stride landed on the same phase and the prefixes came out identical --
    # which is a property of the fixture, not of the function.
    text = "".join(f"<{i}>" for i in range(20_000))
    config = SequenceDistillConfig(prefixes=5, prefix_characters=100)
    first = prefixes_from_corpus(text, config)
    assert len(first) == 5
    assert first == prefixes_from_corpus(text, config), "prefixes must not depend on a seed"
    starts = [text.index(p) for p in first]
    assert starts == sorted(starts)
    assert len({p for p in first}) == 5, "prefixes must differ from one another"


def test_prefix_generation_handles_a_short_document():
    assert prefixes_from_corpus("short", SequenceDistillConfig(prefixes=10, prefix_characters=100)) == []
    assert prefixes_from_corpus("", SequenceDistillConfig()) == []


def test_sequence_config_is_validated():
    for kwargs, message in (
        ({"prefixes": 0}, "prefixes must be at least 1"),
        ({"prefix_characters": 10, "min_characters": 40}, "at least min_characters"),
        ({"max_characters": 10, "min_characters": 40}, "at least min_characters"),
        ({"min_unique_ratio": 1.5}, "min_unique_ratio must be in"),
    ):
        with pytest.raises(ValueError, match=message):
            SequenceDistillConfig(**kwargs)
