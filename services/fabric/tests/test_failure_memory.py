"""E_{t+1} = E_t U F_t — the suite grows, but only from validated failures."""

from __future__ import annotations

import pytest

from fabric.failure_memory import (
    FailureMemory,
    FailureRecord,
    FailureStage,
    RegressionCase,
    secret_findings,
)
from fabric.taxonomy import BenchmarkCategory, FailureCategory, RootCause


@pytest.fixture()
def memory() -> FailureMemory:
    return FailureMemory()


def capture(memory: FailureMemory, **kwargs) -> FailureRecord:
    defaults = {
        "category": FailureCategory.RETRIEVAL,
        "input": "what is the requirement for leakage and impedance",
        "output": "canbus-d0",
        "expected": "isolation-d0",
        "model_version": "aetheris-lite-retriever-0.1.0",
    }
    defaults.update(kwargs)
    return memory.capture(**defaults)


# --- capture ---------------------------------------------------------------


def test_a_failure_is_captured_in_the_observed_stage(memory):
    record = capture(memory)
    assert isinstance(record, FailureRecord)
    assert record.stage == FailureStage.OBSERVED
    assert record.category is FailureCategory.RETRIEVAL
    assert record.root_cause is None, "nothing is assumed about the cause at capture time"
    assert record.history[0]["event"] == "captured"
    assert len(memory) == 1


def test_a_category_may_be_given_as_a_string(memory):
    record = memory.capture(category="retrieval_grounding", input="q", output="o", expected="e")
    assert record.category is FailureCategory.RETRIEVAL_GROUNDING


def test_capture_validates_its_inputs(memory):
    with pytest.raises(TypeError):
        memory.capture(category=FailureCategory.RETRIEVAL, input=None, output="o", expected="e")
    with pytest.raises(ValueError):
        capture(memory, difficulty=1.5)
    with pytest.raises(ValueError):
        memory.capture(category="not-a-category", input="q", output="o", expected="e")


def test_every_upstream_failure_category_is_still_present():
    upstream = {
        "hallucination", "reasoning", "mathematics", "coding", "retrieval", "tool_usage",
        "vision", "audio", "long_context", "physics", "planning", "safety", "agent_coordination",
    }
    assert upstream <= {member.value for member in FailureCategory}
    # The one addition is documented as such.
    assert {member.value for member in FailureCategory} - upstream == {"retrieval_grounding"}


def test_every_upstream_root_cause_is_still_present():
    upstream = {"DATA", "MODEL", "REASONING", "RETRIEVAL", "TOOL", "TRAINING", "ARCHITECTURE", "CONTEXT", "HARDWARE"}
    assert upstream <= {member.value for member in RootCause}
    assert {member.value for member in RootCause} - upstream == {"POLICY"}


# --- triage ----------------------------------------------------------------


def test_root_cause_suggestions_are_category_specific(memory):
    record = capture(memory, category=FailureCategory.RETRIEVAL)
    suggestions = memory.suggest_root_causes(record.failure_id)
    assert suggestions[0] == RootCause.RETRIEVAL.value
    assert RootCause.DATA.value in suggestions

    tool = capture(memory, category=FailureCategory.TOOL_USAGE)
    assert memory.suggest_root_causes(tool.failure_id)[0] == RootCause.TOOL.value


def test_triage_assigns_a_root_cause_and_moves_the_stage(memory):
    record = capture(memory)
    triaged = memory.triage(record.failure_id, root_cause=RootCause.RETRIEVAL, notes="index missed the paraphrase")
    assert triaged.stage == FailureStage.TRIAGED
    assert triaged.root_cause is RootCause.RETRIEVAL
    assert triaged.history[-1]["event"] == "triaged"


def test_triage_accepts_strings_and_a_benchmark(memory):
    record = capture(memory)
    memory.triage(record.failure_id, root_cause="RETRIEVAL", benchmark="retrieval")
    assert record.benchmark is BenchmarkCategory.RETRIEVAL


def test_a_settled_root_cause_cannot_be_quietly_changed(memory):
    record = capture(memory)
    memory.triage(record.failure_id, root_cause=RootCause.RETRIEVAL)
    memory.validate(record.failure_id)
    with pytest.raises(ValueError, match="already validated"):
        memory.triage(record.failure_id, root_cause=RootCause.DATA)


def test_an_unknown_failure_is_reported(memory):
    with pytest.raises(KeyError, match="unknown failure"):
        memory.triage("fail-9999", root_cause=RootCause.DATA)


# --- validation ------------------------------------------------------------


def test_validation_requires_a_root_cause_first(memory):
    record = capture(memory)
    with pytest.raises(ValueError, match="must be triaged"):
        memory.validate(record.failure_id)


def test_validation_moves_the_failure_into_the_suite_pipeline(memory):
    record = capture(memory)
    memory.triage(record.failure_id, root_cause=RootCause.RETRIEVAL)
    assert memory.validate(record.failure_id).stage == FailureStage.VALIDATED


def test_a_rejected_failure_cannot_be_validated_without_reopening(memory):
    record = capture(memory)
    memory.triage(record.failure_id, root_cause=RootCause.RETRIEVAL)
    memory.reject(record.failure_id, reason="the judgement was wrong; canbus-d0 is also a correct answer")
    with pytest.raises(ValueError, match="was rejected"):
        memory.validate(record.failure_id)


def test_a_rejection_needs_a_reason(memory):
    record = capture(memory)
    with pytest.raises(ValueError, match="needs a reason"):
        memory.reject(record.failure_id, reason="   ")


def test_rejected_failures_are_kept_with_their_reason(memory):
    record = capture(memory)
    rejected = memory.reject(record.failure_id, reason="bad expectation")
    assert rejected.stage == FailureStage.REJECTED
    assert rejected.rejection_reason == "bad expectation"
    assert len(memory) == 1, "a rejected failure is still evidence that it was investigated"
    assert memory.by_stage()[FailureStage.REJECTED] == 1


# --- promotion -------------------------------------------------------------


def test_a_validated_failure_becomes_a_regression_case(memory):
    record = capture(memory)
    memory.triage(record.failure_id, root_cause=RootCause.RETRIEVAL)
    memory.validate(record.failure_id)
    case = memory.to_regression_case(record.failure_id, checker="retrieval_hits_relevant")

    assert isinstance(case, RegressionCase)
    assert case.failure_id == record.failure_id
    assert case.category is FailureCategory.RETRIEVAL
    assert case.root_cause is RootCause.RETRIEVAL
    assert case.expectation == record.expected
    assert record.stage == FailureStage.PROMOTED
    assert record.regression_case_id == case.case_id
    assert memory.suite() == [case]


def test_an_unvalidated_failure_cannot_be_promoted(memory):
    observed = capture(memory)
    with pytest.raises(ValueError, match="only a validated failure"):
        memory.to_regression_case(observed.failure_id, checker="x")

    triaged = capture(memory, input="a different query")
    memory.triage(triaged.failure_id, root_cause=RootCause.DATA)
    with pytest.raises(ValueError, match="only a validated failure"):
        memory.to_regression_case(triaged.failure_id, checker="x")


def test_promotion_needs_a_checker(memory):
    record = capture(memory)
    memory.triage(record.failure_id, root_cause=RootCause.RETRIEVAL)
    memory.validate(record.failure_id)
    with pytest.raises(ValueError, match="needs a checker"):
        memory.to_regression_case(record.failure_id, checker="  ")


def test_promoting_twice_returns_the_same_case(memory):
    record = capture(memory)
    memory.triage(record.failure_id, root_cause=RootCause.RETRIEVAL)
    memory.validate(record.failure_id)
    first = memory.to_regression_case(record.failure_id, checker="retrieval_hits_relevant")
    second = memory.to_regression_case(record.failure_id, checker="retrieval_hits_relevant")
    assert first.case_id == second.case_id
    assert len(memory.cases) == 1, "the suite must not accumulate duplicates of one failure"


def test_the_default_benchmark_for_a_promoted_failure_is_historical(memory):
    record = capture(memory)
    memory.triage(record.failure_id, root_cause=RootCause.RETRIEVAL)
    memory.validate(record.failure_id)
    case = memory.to_regression_case(record.failure_id, checker="retrieval_hits_relevant")
    # This is what makes the zero-tolerance rule in the ledger apply to it.
    assert case.benchmark is BenchmarkCategory.HISTORICAL_FAILURES


def test_the_suite_can_be_filtered_by_benchmark(memory):
    record = capture(memory)
    memory.triage(record.failure_id, root_cause=RootCause.RETRIEVAL, benchmark=BenchmarkCategory.RETRIEVAL)
    memory.validate(record.failure_id)
    memory.to_regression_case(record.failure_id, checker="retrieval_hits_relevant")
    assert len(memory.suite()) == 1
    assert len(memory.suite(benchmark=BenchmarkCategory.RETRIEVAL)) == 1
    assert memory.suite(benchmark=BenchmarkCategory.CODING) == []


# --- the privacy gate ------------------------------------------------------


def test_a_failure_carrying_a_credential_cannot_be_promoted(memory):
    record = capture(
        memory,
        input="debug this AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY",
        output="retrieved nothing",
    )
    memory.triage(record.failure_id, root_cause=RootCause.DATA)
    memory.validate(record.failure_id)
    with pytest.raises(ValueError, match="credential material"):
        memory.to_regression_case(record.failure_id, checker="retrieval_hits_relevant")
    assert record.stage == FailureStage.VALIDATED, "a refused promotion must not change the stage"
    assert memory.suite() == []


def test_a_secret_in_the_output_is_also_blocked(memory):
    record = capture(memory, output="-----BEGIN RSA PRIVATE KEY----- MIIEow...")
    memory.triage(record.failure_id, root_cause=RootCause.DATA)
    memory.validate(record.failure_id)
    with pytest.raises(ValueError, match="credential material"):
        memory.to_regression_case(record.failure_id, checker="x")


def test_secret_findings_names_the_kind_without_leaking_the_value():
    findings = secret_findings("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY")
    assert "env_style_secret" in findings
    assert "wJalrXUtnFEMI" not in "".join(findings)
    assert secret_findings("an ordinary engineering question about contactors") == []
    assert secret_findings("") == []


# --- the recurrence --------------------------------------------------------


def test_the_suite_grows_by_the_union_of_validated_failures(memory):
    records = []
    for index in range(4):
        record = capture(memory, input=f"query number {index} about a distinct subsystem")
        memory.triage(record.failure_id, root_cause=RootCause.RETRIEVAL)
        records.append(record)

    # All four are triaged; two are then validated, one rejected, and the fourth
    # is left triaged but never validated. Only the validated pair may join E.
    memory.validate(records[0].failure_id)
    memory.validate(records[1].failure_id)
    memory.reject(records[2].failure_id, reason="expectation was wrong")

    before = len(memory.suite())
    result = memory.grow(records)
    assert before == 0
    assert result["added"] == 2, "only the two validated failures join E"
    assert result["suiteSize"] == 2
    assert len(result["skipped"]) == 2
    assert any("stage is 'rejected'" in entry["reason"] for entry in result["skipped"])
    assert any("stage is 'rejected'" in entry["reason"] or "stage is 'triaged'" in entry["reason"] for entry in result["skipped"])
    assert {entry["id"] for entry in result["skipped"]} == {records[2].failure_id, records[3].failure_id}


def test_an_untriaged_failure_is_skipped_with_its_stage(memory):
    record = capture(memory, input="never investigated")
    assert record.stage == FailureStage.OBSERVED
    result = memory.grow([record])
    assert result["added"] == 0
    assert result["skipped"] == [{"id": record.failure_id, "reason": "stage is 'observed'"}]


def test_growing_twice_does_not_duplicate_cases(memory):
    record = capture(memory)
    memory.triage(record.failure_id, root_cause=RootCause.RETRIEVAL)
    memory.validate(record.failure_id)
    first = memory.grow([record])
    second = memory.grow([record])
    assert first["suiteSize"] == 1
    assert second["added"] == 0
    assert second["suiteSize"] == 1


def test_grow_reports_a_secret_bearing_failure_instead_of_promoting_it(memory):
    record = capture(memory, input="token sk-abcdefghij1234567890 leaked here")
    memory.triage(record.failure_id, root_cause=RootCause.DATA)
    memory.validate(record.failure_id)
    result = memory.grow([record])
    assert result["added"] == 0
    assert any("credential material" in entry["reason"] for entry in result["skipped"])


# --- inspection and persistence -------------------------------------------


def test_summaries_count_by_category_root_cause_and_stage(memory):
    a = capture(memory, category=FailureCategory.RETRIEVAL)
    b = capture(memory, category=FailureCategory.RETRIEVAL, input="another retrieval query")
    c = capture(memory, category=FailureCategory.HALLUCINATION, input="a fabricated citation")
    memory.triage(a.failure_id, root_cause=RootCause.RETRIEVAL)
    memory.validate(a.failure_id)
    memory.reject(b.failure_id, reason="duplicate of the first")

    summary = memory.summary()
    assert summary["failures"] == 3
    assert summary["byCategory"]["retrieval"] == 2
    assert summary["byStage"][FailureStage.VALIDATED] == 1
    assert summary["byStage"][FailureStage.REJECTED] == 1
    assert summary["byRootCause"]["RETRIEVAL"] == 1
    assert summary["byRootCause"]["untriaged"] == 2
    assert c.failure_id in memory.failures


def test_near_duplicate_failures_are_grouped(memory):
    capture(memory, input="what is the requirement for leakage and impedance regarding isolation")
    capture(memory, input="what is the requirement for leakage and impedance regarding isolation")
    capture(memory, input="a completely unrelated question about torque ripple in the inverter")
    groups = memory.duplicates(threshold=0.95)
    assert len(groups) == 1
    assert len(groups[0]) == 2


def test_the_memory_round_trips_through_disk(tmp_path, memory):
    record = capture(memory)
    memory.triage(record.failure_id, root_cause=RootCause.RETRIEVAL, benchmark=BenchmarkCategory.RETRIEVAL)
    memory.validate(record.failure_id)
    memory.to_regression_case(record.failure_id, checker="retrieval_hits_relevant")
    second = capture(memory, input="a second, rejected failure")
    memory.reject(second.failure_id, reason="not a defect")

    path = memory.save(tmp_path / "nested" / "failures.json")
    restored = FailureMemory.load(path)

    assert restored.digest() == memory.digest()
    assert len(restored) == 2
    assert restored.suite()[0].checker == "retrieval_hits_relevant"
    loaded = restored.failures[record.failure_id]
    assert loaded.stage == FailureStage.PROMOTED
    assert loaded.root_cause is RootCause.RETRIEVAL
    assert loaded.benchmark is BenchmarkCategory.RETRIEVAL
    assert loaded.regression_case_id == record.regression_case_id


def test_loading_an_unknown_format_is_refused(tmp_path):
    import json

    path = tmp_path / "bad.json"
    path.write_text(json.dumps({"format": "something-else/9"}))
    with pytest.raises(ValueError, match="unsupported failure-memory format"):
        FailureMemory.load(path)


def test_the_digest_changes_when_the_memory_changes(memory):
    first = memory.digest()
    capture(memory)
    assert memory.digest() != first
    assert memory.digest() == memory.digest()
