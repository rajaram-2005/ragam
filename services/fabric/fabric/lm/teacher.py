"""Sequence-level distillation from an external teacher.

This is the second distillation path, and the one that needs credentials. The teacher
generates continuations of real prefixes from the local corpus, the continuations are
quality-filtered and hashed, and the resulting corpus is fed to the same trainer that
produced the released model. From the trainer's point of view a teacher-generated
corpus is just a second data source, which is why this is a corpus builder rather than
a second training loop.

Two things this module does *not* do, both deliberately.

**It does not logits-distil from an external model.** That needs the teacher's full
distribution, so it needs the teacher's weights, so it needs the teacher to be local.
Sequence-level distillation is strictly weaker -- the student sees one sampled
continuation rather than the teacher's uncertainty -- and it is the only form available
across an HTTP boundary. `distill.py` handles the logit form for teachers whose weights
are on this machine.

**It does not run by default.** Sending repository text to a third party is a decision
that has to be made explicitly, so every send passes through `privacy.gate_send`,
which refuses without an `Authorization` and redacts credentials regardless. The
output is treated as untrusted input throughout: control characters are stripped,
length is bounded, and nothing from the response is executed or interpreted as
instructions.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

from .privacy import Authorization, ExternalTransferRefused, gate_send

#: Control characters that have no place in a training corpus. Tab and newline are
#: kept; everything else below 0x20 is removed rather than escaped, because a corpus
#: full of escape sequences teaches the model to emit them.
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

#: Markers a chat model emits when it declines or when the gateway reports a problem.
#: These are not training data and are filtered rather than trained on.
_REFUSAL_MARKERS = (
    "i cannot", "i can't", "i'm unable", "i am unable", "as an ai language model",
    "i must decline", "error:", "traceback (most recent call last)",
)


class TeacherUnavailable(RuntimeError):
    """The teacher could not be reached or did not answer usefully."""


@dataclass(frozen=True)
class TeacherProvenance:
    """Everything needed to say where a piece of the corpus came from."""

    provider: str
    base_url: str
    model: str
    authorization: dict
    temperature: float
    max_tokens: int
    seed: int | None
    started_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "provider": self.provider,
            "baseUrl": self.base_url,
            "model": self.model,
            "authorization": self.authorization,
            "temperature": self.temperature,
            "maxTokens": self.max_tokens,
            "seed": self.seed,
            "startedAt": self.started_at,
        }


@dataclass(frozen=True)
class Completion:
    prompt: str
    text: str
    findings: tuple[str, ...]
    latency_ms: float
    prompt_digest: str
    response_digest: str

    @property
    def usable(self) -> bool:
        return bool(self.text.strip())

    def to_dict(self) -> dict:
        return {
            "promptDigest": self.prompt_digest,
            "responseDigest": self.response_digest,
            # The prompt itself is not stored: it is repository text, and the corpus
            # builder already knows which prefix it asked about.
            "characters": len(self.text),
            "redactionsApplied": list(self.findings),
            "latencyMs": round(self.latency_ms, 2),
        }


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sanitise_teacher_output(text: str, *, max_characters: int) -> str:
    """Treat model output as untrusted: strip controls, bound the length.

    Nothing from a response is ever interpreted -- not as a path, not as a command,
    not as an instruction. It is text destined for a corpus file and nothing else.
    """
    if not isinstance(text, str):
        raise TypeError(f"expected text from the teacher, got {type(text).__name__}")
    cleaned = _CONTROL.sub("", text)
    lines = [line.rstrip() for line in cleaned.splitlines()]
    # Collapse runs of blank lines: a sampling artefact, not structure worth learning.
    out: list[str] = []
    blank = 0
    for line in lines:
        if line:
            blank = 0
            out.append(line)
        else:
            blank += 1
            if blank <= 1:
                out.append("")
    return "\n".join(out).strip()[:max_characters]


def looks_like_a_refusal_or_error(text: str) -> bool:
    lowered = text.strip().lower()
    if not lowered:
        return True
    # Only the opening of a response is examined: a legitimate continuation can quote
    # any of these phrases later on, and rejecting it would discard real data.
    head = lowered[:220]
    return any(marker in head for marker in _REFUSAL_MARKERS)


class ExternalTeacher:
    """An OpenAI-compatible completion endpoint, behind the privacy gate.

    Works against FreeLLMAPI and against anything else speaking `/v1/chat/completions`.
    The key is held in memory only, never included in a report, and never written to
    the corpus provenance -- only whether one was configured.
    """

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        authorization: Authorization | None,
        provider: str = "freellmapi",
        timeout_s: float = 60.0,
        max_retries: int = 2,
        max_tokens: int = 160,
        temperature: float = 0.7,
        seed: int | None = None,
    ) -> None:
        if not base_url.startswith(("http://", "https://")):
            raise ValueError(f"base_url must be http(s), got {base_url!r}")
        if not api_key or not api_key.strip():
            raise ValueError(
                "no API key configured. Set FREELLMAPI_API_KEY (or FREELLMAPI_API_KEY_FILE to a "
                "readable path). The key is read from the environment, never from the repository."
            )
        if not model or not model.strip():
            raise ValueError("a model identifier is required; the gateway serves many")
        if timeout_s <= 0:
            raise ValueError("timeout_s must be positive")
        if max_retries < 0:
            raise ValueError("max_retries must not be negative")
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self.model = model
        self.provider = provider
        self.authorization = authorization
        self.timeout_s = timeout_s
        self.max_retries = max_retries
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.seed = seed
        self._calls = 0
        self._failures = 0

    # -- introspection -----------------------------------------------------

    @property
    def stats(self) -> dict:
        return {"calls": self._calls, "failures": self._failures, "model": self.model}

    def provenance(self) -> TeacherProvenance:
        return TeacherProvenance(
            provider=self.provider,
            base_url=self._base_url,
            model=self.model,
            # The authorization, not the credential. A report containing a key would be
            # the leak this whole module exists to prevent.
            authorization=self.authorization.to_dict() if self.authorization else {},
            temperature=self.temperature,
            max_tokens=self.max_tokens,
            seed=self.seed,
        )

    def __repr__(self) -> str:  # pragma: no cover - defensive
        """Never render the key, even in a traceback or a debugger."""
        return f"ExternalTeacher(provider={self.provider!r}, model={self.model!r}, key=<redacted>)"

    # -- the call ----------------------------------------------------------

    def complete(self, prompt: str) -> Completion:
        """Ask for a continuation of `prompt`. Refuses if the gate does not pass."""
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError("a prompt is required")
        if self.authorization is None:
            raise ExternalTransferRefused(
                "no authorization: constructing an ExternalTeacher without one does not make sends "
                "permitted, and this call is where that is enforced"
            )

        # The gate is applied per send, on the text that would actually leave. Doing it
        # once at construction would miss text assembled later.
        permitted = gate_send(prompt, authorization=self.authorization)

        payload = {
            "model": self.model,
            "messages": [{"role": "user", "content": permitted.text}],
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
        }
        if self.seed is not None:
            payload["seed"] = self.seed

        started = time.perf_counter()
        last_error: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                self._calls += 1
                body = self._post("/chat/completions", payload)
                text = _first_message_content(body)
                break
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, TeacherUnavailable, ValueError) as error:
                self._failures += 1
                last_error = error
                if attempt == self.max_retries:
                    raise TeacherUnavailable(
                        f"{self.provider} did not return a usable completion after "
                        f"{self.max_retries + 1} attempt(s): {type(last_error).__name__}: {last_error}"
                    ) from error
                # Bounded backoff, no jitter: a reproducible corpus is worth more than
                # a marginally better retry distribution here.
                time.sleep(min(2.0**attempt, 8.0))
        else:  # pragma: no cover - the loop always breaks or raises
            raise TeacherUnavailable("unreachable")

        latency_ms = (time.perf_counter() - started) * 1000.0
        cleaned = sanitise_teacher_output(text, max_characters=self.max_tokens * 12)
        return Completion(
            prompt=prompt,
            text=cleaned,
            findings=permitted.findings,
            latency_ms=latency_ms,
            prompt_digest=_digest(permitted.text),
            response_digest=_digest(cleaned),
        )

    def _post(self, path: str, payload: dict) -> dict:
        request = urllib.request.Request(
            f"{self._base_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "content-type": "application/json",
                "accept": "application/json",
                # Never logged by urllib, and never included in an exception message
                # that this module raises.
                "authorization": f"Bearer {self._api_key}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_s) as response:  # noqa: S310
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            # A gateway error body can echo request headers on some providers, so the
            # status line is reported and the body is not.
            raise TeacherUnavailable(f"HTTP {error.code} from {path}") from None


def _first_message_content(body: dict) -> str:
    """Pull the assistant message out of an OpenAI-compatible response.

    Raises rather than returning a placeholder when the shape is unexpected: a corpus
    silently built from empty strings would look like a successful run.
    """
    if not isinstance(body, dict):
        raise TeacherUnavailable(f"expected a JSON object, got {type(body).__name__}")
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        error = body.get("error")
        detail = error.get("message") if isinstance(error, dict) else None
        raise TeacherUnavailable(f"no choices in the response{': ' + detail if detail else ''}")
    first = choices[0]
    message = first.get("message") if isinstance(first, dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str):
        # Some gateways return `text` for completion-style endpoints.
        content = first.get("text") if isinstance(first, dict) else None
    if not isinstance(content, str):
        raise TeacherUnavailable("the first choice carried no string content")
    return content


# ---------------------------------------------------------------------------
# Corpus construction
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SequenceDistillConfig:
    prefixes: int = 200
    prefix_characters: int = 400
    min_characters: int = 40
    max_characters: int = 4000
    min_unique_ratio: float = 0.25

    def __post_init__(self) -> None:
        if self.prefixes < 1:
            raise ValueError("prefixes must be at least 1")
        if self.prefix_characters < self.min_characters:
            raise ValueError("prefix_characters must be at least min_characters")
        if not 0.0 <= self.min_unique_ratio <= 1.0:
            raise ValueError("min_unique_ratio must be in [0, 1]")
        if self.max_characters < self.min_characters:
            raise ValueError("max_characters must be at least min_characters")


def quality_rejection(text: str, config: SequenceDistillConfig) -> str | None:
    """Why this sample should be dropped, or None to keep it.

    Returned as a reason rather than a boolean so the run report can say *why* samples
    were discarded. A filter that reports only a count makes it impossible to tell a
    clean run from one that rejected everything.
    """
    stripped = text.strip()
    if len(stripped) < config.min_characters:
        return f"shorter than {config.min_characters} characters"
    if len(stripped) > config.max_characters:
        return f"longer than {config.max_characters} characters"
    if looks_like_a_refusal_or_error(stripped):
        return "the response looks like a refusal or an error message"
    # Degenerate sampling: a model looping on one character produces a long string
    # with almost no information, and it would be overweighted in a small corpus.
    unique_ratio = len(set(stripped)) / len(stripped)
    if unique_ratio < config.min_unique_ratio:
        return f"only {unique_ratio:.3f} distinct characters; likely a sampling loop"
    return None


def build_distillation_corpus(prefixes, teacher: ExternalTeacher, config: SequenceDistillConfig) -> dict:
    """Generate a corpus from prefixes, with per-sample provenance and filtering.

    Returns a dict rather than a bare string: the corpus is useless without knowing
    which teacher produced it, which samples were discarded and why, and what was
    redacted on the way out.
    """
    if not isinstance(teacher, ExternalTeacher):
        raise TypeError(f"expected an ExternalTeacher, got {type(teacher).__name__}")

    samples: list[dict] = []
    rejected: list[dict] = []
    seen: set[str] = set()
    duplicated = 0
    pieces: list[str] = []

    for index, prefix in enumerate(prefixes[: config.prefixes]):
        try:
            completion = teacher.complete(prefix)
        except (TeacherUnavailable, ExternalTransferRefused) as error:
            rejected.append({"index": index, "reason": f"{type(error).__name__}: {error}"})
            continue

        digest = completion.response_digest
        if digest in seen:
            duplicated += 1
            continue
        reason = quality_rejection(completion.text, config)
        if reason:
            rejected.append({"index": index, "reason": reason, "characters": len(completion.text)})
            continue

        seen.add(digest)
        samples.append({"index": index, **completion.to_dict()})
        pieces.append(completion.text)

    corpus = "\n\n".join(pieces)
    return {
        "text": corpus,
        "corpusDigest": _digest(corpus),
        "teacher": teacher.provenance().to_dict(),
        "teacherStats": teacher.stats,
        "config": {
            "prefixes": config.prefixes,
            "prefixCharacters": config.prefix_characters,
            "minCharacters": config.min_characters,
            "maxCharacters": config.max_characters,
            "minUniqueRatio": config.min_unique_ratio,
        },
        "samples": samples,
        "rejected": rejected,
        "duplicates": duplicated,
        "accepted": len(samples),
        "attempted": min(len(prefixes), config.prefixes),
        "characters": len(corpus),
    }


def prefixes_from_corpus(text: str, config: SequenceDistillConfig) -> list[str]:
    """Deterministic, evenly spaced prefixes of a document.

    Evenly spaced rather than random so the corpus does not depend on a seed for its
    *inputs* as well as its sampling; the prefixes are then reproducible from the
    document alone, which is what makes a generated corpus traceable to its source.
    """
    if not text or config.prefix_characters < 1:
        return []
    stride = max(1, len(text) // config.prefixes)
    out = []
    for start in range(0, len(text) - config.prefix_characters, stride):
        out.append(text[start : start + config.prefix_characters])
        if len(out) >= config.prefixes:
            break
    return out
