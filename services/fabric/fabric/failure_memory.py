"""Failure capture, root-cause analysis, and the growing regression suite.

Provenance
----------
Adopted from ``sparsiz/training/failure-memory/failure_memory.py``, whose stated
objective is: *"Every validated failure becomes permanent learning and evaluation
signal, not never fail claim."* The regression-memory recurrence is upstream's::

    E_{t+1} = E_t U F_t

where ``E_t`` is the existing evaluation suite and ``F_t`` the newly validated
failures. That idea is kept exactly.

What changed is the discipline around it. Upstream stored failures but never
distinguished a failure that had been *validated* from one that had merely been
observed, so a flaky test or a mislabelled expectation would enter the permanent
suite and could never be removed. Here a failure has an explicit lifecycle:

    observed -> triaged -> validated -> regression test
                     \\-> rejected (with a reason)

Only a **validated** failure joins ``E``. Rejections are kept too, with their
reason, so a failure that was investigated and found to be a bad expectation is
not re-investigated next month.

Also added: the privacy gate. A captured failure contains the prompt and the
output, which for company-private work is sensitive. ``to_regression_case``
refuses to emit a case carrying credential material, because a regression suite is
exactly the kind of artifact that gets committed.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Mapping, Sequence

from .taxonomy import BenchmarkCategory, FailureCategory, RootCause

__all__ = [
    "FailureStage",
    "FailureRecord",
    "RegressionCase",
    "FailureMemory",
]


class FailureStage:
    OBSERVED = "observed"
    TRIAGED = "triaged"
    VALIDATED = "validated"
    PROMOTED = "promoted"          # a regression case has been emitted
    REJECTED = "rejected"          # investigated; not a real defect


#: Root-cause candidates worth considering for each failure category. This is a
#: triage aid, not an oracle: it narrows the search and records that the narrowing
#: was deliberate.
ROOT_CAUSE_HINTS: dict[FailureCategory, tuple[RootCause, ...]] = {
    FailureCategory.RETRIEVAL: (RootCause.RETRIEVAL, RootCause.DATA, RootCause.ARCHITECTURE),
    FailureCategory.RETRIEVAL_GROUNDING: (RootCause.RETRIEVAL, RootCause.REASONING, RootCause.DATA),
    FailureCategory.HALLUCINATION: (RootCause.REASONING, RootCause.DATA, RootCause.TRAINING),
    FailureCategory.REASONING: (RootCause.REASONING, RootCause.ARCHITECTURE, RootCause.CONTEXT),
    FailureCategory.MATHEMATICS: (RootCause.REASONING, RootCause.TRAINING, RootCause.DATA),
    FailureCategory.CODING: (RootCause.REASONING, RootCause.TOOL, RootCause.TRAINING),
    FailureCategory.TOOL_USAGE: (RootCause.TOOL, RootCause.CONTEXT, RootCause.ARCHITECTURE),
    FailureCategory.LONG_CONTEXT: (RootCause.CONTEXT, RootCause.ARCHITECTURE, RootCause.HARDWARE),
    FailureCategory.SAFETY: (RootCause.POLICY, RootCause.DATA, RootCause.TRAINING),
    FailureCategory.PLANNING: (RootCause.REASONING, RootCause.CONTEXT, RootCause.ARCHITECTURE),
    FailureCategory.AGENT_COORDINATION: (RootCause.ARCHITECTURE, RootCause.CONTEXT, RootCause.TOOL),
    FailureCategory.VISION: (RootCause.MODEL, RootCause.DATA, RootCause.HARDWARE),
    FailureCategory.AUDIO: (RootCause.MODEL, RootCause.DATA, RootCause.HARDWARE),
    FailureCategory.PHYSICS: (RootCause.REASONING, RootCause.DATA, RootCause.MODEL),
}

#: Credential shapes that must never end up in a committed regression case.
#: Mirrors fabric.dataforge.RISK_PATTERNS.
_SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("openai_style_key", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b")),
    ("aws_access_key_id", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    ("private_key_block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("connection_string", re.compile(r"\b(?:postgres|mysql|mongodb|redis|amqp)://[^\s'\"]+:[^\s'\"]+@[^\s'\"]+")),
    ("url_basic_auth", re.compile(r"\bhttps?://[^\s/:@'\"]+:[^\s@'\"]+@[^\s'\"/]+")),
    ("env_style_secret", re.compile(
        r"(?:^|[^A-Za-z0-9_])[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY)"
        r"[A-Z0-9_]*\s*[:=]\s*['\"]?[^\s'\";,}]{8,}"
    )),
)


def secret_findings(text: str) -> list[str]:
    """Names of credential patterns present. Never returns the matched values."""
    return [name for name, pattern in _SECRET_PATTERNS if pattern.search(text or "")]


@dataclass
class RegressionCase:
    """A validated failure turned into a permanent check."""

    case_id: str
    failure_id: str
    category: FailureCategory
    root_cause: RootCause
    benchmark: BenchmarkCategory
    #: The input that broke, and the property the output must satisfy.
    input: str
    expectation: str
    #: How to check it: a predicate name the harness knows, plus its parameters.
    checker: str
    checker_args: dict = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    notes: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.case_id,
            "failureId": self.failure_id,
            "category": self.category.value,
            "rootCause": self.root_cause.value,
            "benchmark": self.benchmark.value,
            "input": self.input,
            "expectation": self.expectation,
            "checker": self.checker,
            "checkerArgs": dict(self.checker_args),
            "createdAt": self.created_at,
            "notes": self.notes,
        }


@dataclass
class FailureRecord:
    """One observed failure, with its whole triage history."""

    failure_id: str
    category: FailureCategory
    input: str
    output: str
    expected: str
    stage: str = FailureStage.OBSERVED
    root_cause: RootCause | None = None
    benchmark: BenchmarkCategory | None = None
    difficulty: float = 0.5
    model_version: str = ""
    prompt: str = ""
    tools_used: list = field(default_factory=list)
    hardware: dict = field(default_factory=dict)
    training_history: list = field(default_factory=list)
    history: list = field(default_factory=list)
    rejection_reason: str = ""
    regression_case_id: str | None = None
    created_at: float = field(default_factory=time.time)
    error: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.failure_id,
            "category": self.category.value,
            "stage": self.stage,
            "rootCause": self.root_cause.value if self.root_cause else None,
            "benchmark": self.benchmark.value if self.benchmark else None,
            "input": self.input,
            "output": self.output,
            "expected": self.expected,
            "difficulty": self.difficulty,
            "modelVersion": self.model_version,
            "toolsUsed": list(self.tools_used),
            "hardware": dict(self.hardware),
            "history": list(self.history),
            "rejectionReason": self.rejection_reason,
            "regressionCaseId": self.regression_case_id,
            "createdAt": self.created_at,
            "error": self.error,
        }


class FailureMemory:
    """``E_{t+1} = E_t U F_t`` — the evaluation suite grows as failures are validated."""

    def __init__(self) -> None:
        self.failures: dict[str, FailureRecord] = {}
        self.cases: dict[str, RegressionCase] = {}
        self._counter = 0
        self._case_counter = 0

    def __len__(self) -> int:
        return len(self.failures)

    # --- capture ----------------------------------------------------------

    def capture(
        self,
        *,
        category: FailureCategory | str,
        input: str,
        output: str,
        expected: str,
        error: str = "",
        difficulty: float = 0.5,
        model_version: str = "",
        prompt: str = "",
        tools_used: Sequence[str] = (),
        hardware: Mapping | None = None,
        training_history: Sequence[str] = (),
    ) -> FailureRecord:
        """Record an observed failure. Nothing is assumed about its cause yet."""
        resolved = FailureCategory(category) if not isinstance(category, FailureCategory) else category
        if not isinstance(input, str) or not isinstance(output, str) or not isinstance(expected, str):
            raise TypeError("input, output and expected must be strings")
        if not 0.0 <= difficulty <= 1.0:
            raise ValueError("difficulty must be within [0, 1]")

        self._counter += 1
        record = FailureRecord(
            failure_id=f"fail-{self._counter:04d}",
            category=resolved,
            input=input,
            output=output,
            expected=expected,
            error=error,
            difficulty=float(difficulty),
            model_version=model_version,
            prompt=prompt or input,
            tools_used=list(tools_used),
            hardware=dict(hardware or {}),
            training_history=list(training_history),
        )
        record.history.append({"at": record.created_at, "event": "captured", "stage": record.stage})
        self.failures[record.failure_id] = record
        return record

    # --- triage -----------------------------------------------------------

    def suggest_root_causes(self, failure_id: str) -> list[str]:
        """Candidate root causes for this failure's category, most likely first."""
        record = self._require(failure_id)
        hints = ROOT_CAUSE_HINTS.get(record.category, (RootCause.DATA, RootCause.MODEL))
        return [hint.value for hint in hints]

    def triage(
        self,
        failure_id: str,
        *,
        root_cause: RootCause | str,
        benchmark: BenchmarkCategory | str | None = None,
        notes: str = "",
    ) -> FailureRecord:
        """Assign a root cause. Required before a failure can be validated."""
        record = self._require(failure_id)
        if record.stage in (FailureStage.VALIDATED, FailureStage.PROMOTED):
            raise ValueError(f"{failure_id} is already {record.stage}; its root cause is settled")
        resolved = RootCause(root_cause) if not isinstance(root_cause, RootCause) else root_cause
        record.root_cause = resolved
        if benchmark is not None:
            record.benchmark = BenchmarkCategory(benchmark) if not isinstance(benchmark, BenchmarkCategory) else benchmark
        record.stage = FailureStage.TRIAGED
        record.history.append({"at": time.time(), "event": "triaged", "rootCause": resolved.value, "notes": notes})
        return record

    def validate(self, failure_id: str, *, notes: str = "") -> FailureRecord:
        """Mark a failure as a real, reproducible defect. It now joins E."""
        record = self._require(failure_id)
        if record.root_cause is None:
            raise ValueError(f"{failure_id} must be triaged with a root cause before it can be validated")
        if record.stage == FailureStage.REJECTED:
            raise ValueError(f"{failure_id} was rejected ({record.rejection_reason}); reopen it explicitly")
        record.stage = FailureStage.VALIDATED
        record.history.append({"at": time.time(), "event": "validated", "notes": notes})
        return record

    def reject(self, failure_id: str, *, reason: str) -> FailureRecord:
        """Record that a failure was investigated and is not a defect.

        Kept, with its reason, so the same observation is not re-investigated.
        """
        record = self._require(failure_id)
        if not reason or not reason.strip():
            raise ValueError("a rejection needs a reason")
        if record.stage == FailureStage.PROMOTED:
            raise ValueError(f"{failure_id} already produced regression case {record.regression_case_id}; withdraw that first")
        record.stage = FailureStage.REJECTED
        record.rejection_reason = reason.strip()
        record.history.append({"at": time.time(), "event": "rejected", "reason": record.rejection_reason})
        return record

    # --- promotion --------------------------------------------------------

    def to_regression_case(
        self,
        failure_id: str,
        *,
        checker: str,
        expectation: str | None = None,
        checker_args: Mapping | None = None,
        benchmark: BenchmarkCategory | str | None = None,
        notes: str = "",
    ) -> RegressionCase:
        """Turn a validated failure into a permanent regression case.

        Refuses to emit a case whose input or output carries credential material:
        a regression suite gets committed, and that is exactly where a secret
        should not land.
        """
        record = self._require(failure_id)
        if record.stage not in (FailureStage.VALIDATED, FailureStage.PROMOTED):
            raise ValueError(f"{failure_id} is '{record.stage}'; only a validated failure can become a regression case")
        if record.stage == FailureStage.PROMOTED:
            existing = self.cases.get(record.regression_case_id or "")
            if existing is not None:
                return existing
        if not checker or not checker.strip():
            raise ValueError("a regression case needs a checker")

        findings = sorted(set(secret_findings(record.input)) | set(secret_findings(record.output)))
        if findings:
            raise ValueError(
                f"{failure_id} carries credential material ({', '.join(findings)}); "
                "redact it before promoting, a regression suite is committed to source control"
            )

        resolved_benchmark = record.benchmark
        if benchmark is not None:
            resolved_benchmark = BenchmarkCategory(benchmark) if not isinstance(benchmark, BenchmarkCategory) else benchmark
        if resolved_benchmark is None:
            resolved_benchmark = BenchmarkCategory.HISTORICAL_FAILURES

        self._case_counter += 1
        case = RegressionCase(
            case_id=f"reg-{self._case_counter:04d}",
            failure_id=failure_id,
            category=record.category,
            root_cause=record.root_cause,
            benchmark=resolved_benchmark,
            input=record.input,
            expectation=expectation if expectation is not None else record.expected,
            checker=checker.strip(),
            checker_args=dict(checker_args or {}),
            notes=notes,
        )
        self.cases[case.case_id] = case
        record.stage = FailureStage.PROMOTED
        record.regression_case_id = case.case_id
        record.history.append({"at": time.time(), "event": "promoted", "caseId": case.case_id})
        return case

    # --- the recurrence ---------------------------------------------------

    def suite(self, *, benchmark: BenchmarkCategory | str | None = None) -> list[RegressionCase]:
        """E_t: the current regression suite, optionally filtered by benchmark."""
        wanted = None
        if benchmark is not None:
            wanted = BenchmarkCategory(benchmark) if not isinstance(benchmark, BenchmarkCategory) else benchmark
        return [case for case in self.cases.values() if wanted is None or case.benchmark is wanted]

    def grow(self, failures: Iterable[FailureRecord]) -> dict:
        """Apply ``E_{t+1} = E_t U F_t`` for a batch of already-validated failures.

        Returns how many cases the suite gained. Failures that are not validated,
        or that carry secrets, are reported rather than silently skipped.
        """
        before = len(self.cases)
        promoted, skipped = [], []
        for record in failures:
            if record.stage not in (FailureStage.VALIDATED, FailureStage.PROMOTED):
                skipped.append({"id": record.failure_id, "reason": f"stage is '{record.stage}'"})
                continue
            try:
                case = self.to_regression_case(record.failure_id, checker="retrieval_hits_relevant")
            except ValueError as error:
                skipped.append({"id": record.failure_id, "reason": str(error)})
                continue
            promoted.append(case.case_id)
        return {"added": len(self.cases) - before, "promoted": promoted, "skipped": skipped, "suiteSize": len(self.cases)}

    def duplicates(self, *, threshold: float = 0.95) -> list[list[str]]:
        """Group failures that look like the same underlying defect.

        Uses character-trigram Jaccard similarity over the input. Cheap, and good
        enough to stop the same bug being triaged five times.
        """
        def trigrams(text: str) -> set[str]:
            normalised = re.sub(r"\s+", " ", (text or "").strip().lower())
            if len(normalised) < 3:
                return {normalised} if normalised else set()
            return {normalised[i : i + 3] for i in range(len(normalised) - 2)}

        records = list(self.failures.values())
        vectors = [trigrams(record.input) for record in records]
        groups: list[list[str]] = []
        assigned: set[str] = set()
        for i, first in enumerate(records):
            if first.failure_id in assigned:
                continue
            cluster = [first.failure_id]
            for j in range(i + 1, len(records)):
                second = records[j]
                if second.failure_id in assigned:
                    continue
                union = len(vectors[i] | vectors[j])
                similarity = len(vectors[i] & vectors[j]) / union if union else 0.0
                if similarity >= threshold:
                    cluster.append(second.failure_id)
                    assigned.add(second.failure_id)
            if len(cluster) > 1:
                assigned.add(first.failure_id)
                groups.append(cluster)
        return groups

    # --- inspection -------------------------------------------------------

    def by_category(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for record in self.failures.values():
            counts[record.category.value] = counts.get(record.category.value, 0) + 1
        return dict(sorted(counts.items(), key=lambda item: (-item[1], item[0])))

    def by_root_cause(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for record in self.failures.values():
            key = record.root_cause.value if record.root_cause else "untriaged"
            counts[key] = counts.get(key, 0) + 1
        return dict(sorted(counts.items(), key=lambda item: (-item[1], item[0])))

    def by_stage(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for record in self.failures.values():
            counts[record.stage] = counts.get(record.stage, 0) + 1
        return counts

    def summary(self) -> dict:
        return {
            "failures": len(self.failures),
            "regressionCases": len(self.cases),
            "byStage": self.by_stage(),
            "byCategory": self.by_category(),
            "byRootCause": self.by_root_cause(),
        }

    def _require(self, failure_id: str) -> FailureRecord:
        # A FailureRecord is unhashable, so passing one here by mistake would
        # otherwise surface as "TypeError: unhashable type" from the dict lookup.
        if isinstance(failure_id, FailureRecord):
            raise TypeError("expected a failure id string, got a FailureRecord; pass record.failure_id")
        if not isinstance(failure_id, str):
            raise TypeError(f"failure_id must be a string, got {type(failure_id).__name__}")
        try:
            return self.failures[failure_id]
        except KeyError:
            raise KeyError(f"unknown failure '{failure_id}'") from None

    # --- persistence ------------------------------------------------------

    def to_dict(self) -> dict:
        return {
            "format": "aetheris-failure-memory/1",
            "failures": [record.to_dict() for record in self.failures.values()],
            "cases": [case.to_dict() for case in self.cases.values()],
            "summary": self.summary(),
        }

    def save(self, path) -> Path:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(self.to_dict(), indent=2, sort_keys=True), encoding="utf-8")
        return target

    @classmethod
    def load(cls, path) -> "FailureMemory":
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        if payload.get("format") != "aetheris-failure-memory/1":
            raise ValueError(f"unsupported failure-memory format: {payload.get('format')!r}")
        memory = cls()
        for entry in payload.get("failures", []):
            memory._counter += 1
            record = FailureRecord(
                failure_id=entry["id"],
                category=FailureCategory(entry["category"]),
                input=entry["input"],
                output=entry["output"],
                expected=entry["expected"],
                stage=entry["stage"],
                root_cause=RootCause(entry["rootCause"]) if entry.get("rootCause") else None,
                benchmark=BenchmarkCategory(entry["benchmark"]) if entry.get("benchmark") else None,
                difficulty=entry.get("difficulty", 0.5),
                model_version=entry.get("modelVersion", ""),
                error=entry.get("error", ""),
                tools_used=entry.get("toolsUsed", []),
                hardware=entry.get("hardware", {}),
                history=entry.get("history", []),
                rejection_reason=entry.get("rejectionReason", ""),
                regression_case_id=entry.get("regressionCaseId"),
                created_at=entry.get("createdAt", time.time()),
            )
            memory.failures[record.failure_id] = record
        for entry in payload.get("cases", []):
            memory._case_counter += 1
            case = RegressionCase(
                case_id=entry["id"],
                failure_id=entry["failureId"],
                category=FailureCategory(entry["category"]),
                root_cause=RootCause(entry["rootCause"]),
                benchmark=BenchmarkCategory(entry["benchmark"]),
                input=entry["input"],
                expectation=entry["expectation"],
                checker=entry["checker"],
                checker_args=entry.get("checkerArgs", {}),
                created_at=entry.get("createdAt", time.time()),
                notes=entry.get("notes", ""),
            )
            memory.cases[case.case_id] = case
        return memory

    def digest(self) -> str:
        encoded = json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()
