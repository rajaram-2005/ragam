"""The pipeline must run for real where it can, and say so where it cannot."""

from __future__ import annotations

import json

import pytest

from fabric.modelcards import ModelStatus
from fabric.pipeline import STAGE_NAMES, Pipeline, PipelineConfig
from fabric.run import RunRecord, code_revision, file_digest, hardware_profile, resource_usage
from fabric.taxonomy import BenchmarkCategory, ExperimentVerdict, StageStatus

FAST = PipelineConfig(epochs=4, candidate_dims=(16,), candidate_epochs=2)


@pytest.fixture(scope="module")
def completed_run():
    """One full pipeline run, shared because it is the expensive part of this file."""
    pipeline = Pipeline(PipelineConfig(epochs=10, candidate_dims=(16, 24), candidate_epochs=3))
    return pipeline, pipeline.run(run_id="run-test")


def statuses(record: RunRecord) -> dict[str, str]:
    return {stage["name"]: stage["status"] for stage in record.stages}


# --- the run record --------------------------------------------------------


def test_all_eight_stages_are_recorded_in_order(completed_run):
    _, record = completed_run
    assert [stage["name"] for stage in record.stages] == list(STAGE_NAMES)
    assert STAGE_NAMES == (
        "data_validation", "base_selection", "domain_training", "sft",
        "preference_optimization", "distillation", "evaluation", "release",
    )


def test_the_run_is_partial_because_three_stages_are_blocked(completed_run):
    _, record = completed_run
    assert record.status == "partial"
    found = statuses(record)
    for name in ("data_validation", "base_selection", "domain_training", "evaluation", "release"):
        assert found[name] == StageStatus.COMPLETED.value, f"{name} should have run, got {found[name]}"
    for name in ("sft", "preference_optimization", "distillation"):
        assert found[name] == StageStatus.BLOCKED_NEEDS_WEIGHTS.value


def test_a_blocked_stage_says_what_is_missing(completed_run):
    _, record = completed_run
    blocked = [stage for stage in record.stages if stage["status"].startswith("blocked")]
    assert len(blocked) == 3
    for stage in blocked:
        assert stage["detail"]["reason"], f"{stage['name']} gave no reason"
        assert stage["detail"]["whatIsNeeded"], f"{stage['name']} did not say what would be needed"
        assert any(stage["name"] in note for note in record.limitations)


def test_a_blocked_stage_is_never_reported_as_completed(completed_run):
    _, record = completed_run
    assert not any(
        stage["status"] == StageStatus.COMPLETED.value and stage["name"] in ("sft", "preference_optimization", "distillation")
        for stage in record.stages
    )
    assert any("could not run on this host" in note for note in record.limitations)


def test_the_run_record_carries_full_provenance(completed_run):
    _, record = completed_run
    assert record.config["epochs"] == 10
    assert record.seeds == {"data": 1, "model": 7}
    assert record.dataset["digest"]
    assert record.dataset["generated"] is True, "the fixture corpus must be labelled as generated"
    assert record.dataset["manifestDigest"]
    assert record.results["model"]["weightsDigest"]
    assert record.resources.get("maxRssKb"), "resource usage must be measured, not omitted"
    assert record.duration_seconds > 0


def test_no_superiority_claim_over_models_that_could_not_be_evaluated(completed_run):
    _, record = completed_run
    joined = json.dumps(record.to_dict())
    for name in ("mistral", "qwen", "llama", "gemma", "deepseek"):
        assert name not in joined.lower() or "no comparison against" in joined.lower() or "none can be" in joined.lower(), (
            f"the record mentions {name} without recording that no comparison was possible"
        )
    assert any("no comparison against Mistral" in note or "none can be installed" in note for note in record.limitations)


def test_skipped_stages_are_recorded_as_skipped():
    pipeline = Pipeline(FAST)
    record = pipeline.run(stages=("data_validation",))
    found = statuses(record)
    assert found["data_validation"] == StageStatus.COMPLETED.value
    assert found["evaluation"] == StageStatus.SKIPPED.value
    assert found["sft"] == StageStatus.SKIPPED.value


def test_an_unknown_stage_is_refused():
    with pytest.raises(ValueError, match="unknown stage"):
        Pipeline(FAST).run(stages=("data_validation", "quantum_training"))


# --- the real stages -------------------------------------------------------


def test_data_validation_checks_contamination(completed_run):
    _, record = completed_run
    stage = next(s for s in record.stages if s["name"] == "data_validation")
    assert stage["detail"]["contamination"]["contaminated"] is False
    assert stage["detail"]["documents"] == 96
    assert stage["detail"]["trainQueries"] + stage["detail"]["evaluationQueries"] == 72
    assert stage["detail"]["meanQuality"] > 0


def test_base_selection_chooses_by_measurement_not_preference(completed_run):
    _, record = completed_run
    stage = next(s for s in record.stages if s["name"] == "base_selection")
    candidates = stage["detail"]["candidates"]
    assert len(candidates) == 2
    best = max(candidates, key=lambda entry: entry["validationMrr"])
    assert stage["detail"]["selected"] == best
    assert stage["detail"]["selectedBy"] == "MRR on a validation split carved from the training queries"
    assert "not selected" in stage["detail"]["languageModelBase"]


def test_base_selection_does_not_choose_on_the_evaluation_split(completed_run):
    """The choice must be explicable by validation scores alone.

    If any candidate were selected because of its evaluation score, the reported
    evaluation number would be a maximum over candidates rather than a held-out
    estimate. This asserts the selection equals the validation-best candidate, and
    that the two scores are genuinely different measurements rather than one value
    copied under two names.
    """
    _, record = completed_run
    stage = next(s for s in record.stages if s["name"] == "base_selection")
    candidates = stage["detail"]["candidates"]

    for entry in candidates:
        assert "validationMrr" in entry, "each candidate must report its validation score"
        assert "evaluationMrr" in entry, "each candidate's evaluation score is recorded for transparency"

    validation_best = max(candidates, key=lambda entry: entry["validationMrr"])
    assert stage["detail"]["selected"]["dModel"] == validation_best["dModel"]

    # The evaluation score is recorded but is not what decided it. If these two
    # columns were identical the test would be vacuous, so require that at least
    # one candidate's evaluation score disagrees with its validation score.
    assert any(
        entry["validationMrr"] != entry["evaluationMrr"] for entry in candidates
    ), "validation and evaluation scores must be independent measurements"


def test_base_selection_validation_split_is_disjoint_from_evaluation(completed_run):
    _, record = completed_run
    stage = next(s for s in record.stages if s["name"] == "base_selection")
    split = stage["detail"]["validationSplit"]

    assert split["disjointFromEvaluation"] is True
    assert split["count"] > 0
    assert split["fitCount"] > 0
    assert split["count"] + split["fitCount"] == 48, "the split partitions the training queries"
    for query_id in split["queries"]:
        assert not query_id.startswith("eval-"), "no evaluation query may enter selection"


def test_a_selection_that_provides_no_separation_is_refused():
    """A tie on the validation split is refused rather than broken arbitrarily.

    ``max`` would silently return the first candidate on a tie, which a reader
    would then misread as a decision supported by measurement. Two identical
    widths is a guaranteed tie — same width, same seed, same fit queries, so the
    models are identical — which makes this an exact negative control rather than
    a hope that some pair happens to collide.

    The refusal surfaces as a failed stage, because ``Pipeline._stage`` records a
    stage failure rather than propagating it, and the run as a whole is then failed
    and cannot be released.
    """
    from fabric.pipeline import Pipeline, PipelineConfig

    record = Pipeline(PipelineConfig(epochs=3, candidate_dims=(16, 16), candidate_epochs=1)).run()
    stage = next(s for s in record.stages if s["name"] == "base_selection")

    assert stage["status"] == StageStatus.FAILED.value
    assert "identically" in stage["detail"]["error"]
    assert record.status == "failed"


def test_a_single_candidate_is_not_treated_as_a_tie():
    """One candidate cannot tie with anything, so it must not be refused."""
    from fabric.pipeline import Pipeline, PipelineConfig

    record = Pipeline(PipelineConfig(epochs=3, candidate_dims=(16,), candidate_epochs=1)).run()
    stage = next(s for s in record.stages if s["name"] == "base_selection")
    assert stage["status"] == StageStatus.COMPLETED.value
    assert len(stage["detail"]["candidates"]) == 1
    assert stage["detail"]["selected"]["dModel"] == 16



def test_domain_training_reports_a_real_loss_curve(completed_run):
    _, record = completed_run
    stage = next(s for s in record.stages if s["name"] == "domain_training")
    detail = stage["detail"]
    assert detail["finalLoss"] < detail["firstLoss"], "training must reduce the loss"
    assert detail["finalInBatchAccuracy"] > detail["firstInBatchAccuracy"]
    assert detail["triples"] > 0
    assert len(detail["weightsDigest"]) == 64
    assert detail["parameters"] > 0


def test_evaluation_compares_against_an_unchanged_baseline_and_a_control(completed_run):
    _, record = completed_run
    stage = next(s for s in record.stages if s["name"] == "evaluation")
    detail = stage["detail"]

    # The untrained control is what makes the gain attributable to training.
    assert detail["untrainedControl"]["mrr"] < detail["trained"]["mrr"]
    assert detail["trained"]["mrr"] > detail["bm25"]["mrr"]
    assert detail["conditions"]["corpusSize"] == 96


def test_the_improvement_cycle_reaches_a_verdict(completed_run):
    _, record = completed_run
    detail = next(s for s in record.stages if s["name"] == "evaluation")["detail"]
    assert detail["verdict"] in {verdict.value for verdict in ExperimentVerdict}
    assert detail["verdictReasons"]
    assert record.results["experimentLedger"]["experiments"] >= 1


def test_the_held_out_topic_limitation_is_recorded_not_hidden(completed_run):
    _, record = completed_run
    detail = next(s for s in record.stages if s["name"] == "evaluation")["detail"]
    condition = detail["heldOutTopicCondition"]
    assert condition["splitBy"] == "topic"
    # This is the honest bad result: the model does not generalise to unseen topics.
    assert condition["trained"]["mrr"] < condition["bm25"]["mrr"]
    assert any("held-out-TOPIC" in note for note in record.limitations)


def test_release_is_gated_on_validation(completed_run):
    pipeline, record = completed_run
    detail = next(s for s in record.stages if s["name"] == "release")["detail"]
    assert detail["identifier"] == "aetheris-lite-retriever@0.1.1"
    assert detail["statusAfterValidation"] in (ModelStatus.VALIDATED, ModelStatus.RELEASED)
    assert detail["metrics"]["mrr"] >= pipeline.config.min_mrr
    assert detail["requirements"], "the gate must be explicit requirements, not a judgement call"
    assert any(requirement["metric"] == "mrr" for requirement in detail["requirements"])


def test_a_model_that_misses_its_mrr_floor_is_not_released():
    pipeline = Pipeline(PipelineConfig(epochs=6, candidate_dims=(16,), candidate_epochs=2, min_mrr=0.999))
    record = pipeline.run()
    detail = next(s for s in record.stages if s["name"] == "release")["detail"]
    assert detail["released"] is None
    assert detail["statusAfterValidation"] == ModelStatus.REJECTED
    assert any("below the required minimum" in reason for reason in detail["validation"]["hardFailures"])
    assert any("NOT released" in note for note in record.limitations)


def test_a_rejected_experiment_blocks_release_even_with_good_metrics():
    # The ledger's verdict is a gate, not advice. The config must clear the
    # release floors on its own merits (measured mrr 0.8536), so the forced
    # verdict is the only thing that can block the release. The previous
    # epochs=6/dims=16 config stopped clearing the 0.6 floor once the dense
    # tokenizer began emitting hyphen-part tokens (2026-10-25 re-baseline).
    pipeline = Pipeline(PipelineConfig(epochs=12, candidate_dims=(32,), candidate_epochs=4))
    pipeline.run(stages=("data_validation", "base_selection", "domain_training", "evaluation"))
    evaluation = pipeline.stages["evaluation"]
    evaluation.detail["verdict"] = ExperimentVerdict.REJECT.value
    evaluation.detail["verdictReasons"] = ["forced rejection for this test"]
    result = pipeline.release()
    assert result.detail["released"] is None
    assert result.detail["statusAfterValidation"] == ModelStatus.REJECTED
    assert any("improvement cycle returned 'reject'" in reason for reason in result.detail["validation"]["hardFailures"])


def test_the_pipeline_is_reproducible_from_its_config():
    config = PipelineConfig(epochs=5, candidate_dims=(16,), candidate_epochs=2)
    first = Pipeline(config).run()
    second = Pipeline(config).run()
    a = next(s for s in first.stages if s["name"] == "evaluation")["detail"]["trained"]
    b = next(s for s in second.stages if s["name"] == "evaluation")["detail"]["trained"]
    assert a == b, "the same config must give the same metrics"
    assert first.results["model"]["weightsDigest"] == second.results["model"]["weightsDigest"]


def test_the_run_record_round_trips(tmp_path, completed_run):
    _, record = completed_run
    path = record.save(tmp_path / "nested" / "run.json")
    restored = RunRecord.load(path)
    assert restored.run_id == record.run_id
    assert restored.status == record.status
    assert [stage["name"] for stage in restored.stages] == list(STAGE_NAMES)
    assert restored.results["model"]["weightsDigest"] == record.results["model"]["weightsDigest"]
    assert restored.limitations == record.limitations


def test_loading_an_unknown_run_format_is_refused(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text(json.dumps({"format": "other/1", "runId": "x", "kind": "y"}))
    with pytest.raises(ValueError, match="unsupported run record format"):
        RunRecord.load(path)


# --- run helpers -----------------------------------------------------------


def test_hardware_profile_reports_what_is_actually_there():
    profile = hardware_profile()
    assert profile["cpuCount"] >= 1
    assert profile["python"]
    assert profile["numpy"]
    # A GPU is not assumed just because the field exists.
    assert profile["gpuDetected"] is False
    assert "no vendor tooling" in profile["gpuNote"]


def test_code_revision_is_never_invented():
    revision = code_revision()
    assert revision is None or (isinstance(revision, str) and len(revision) == 40)
    # Outside a repository the honest answer is unknown, not a placeholder.
    assert code_revision(cwd="/") is None


def test_resource_usage_measures_this_process():
    usage = resource_usage()
    assert usage.get("maxRssKb", 0) > 0
    assert usage.get("userCpuSeconds", 0) >= 0


def test_file_digest_is_streamed_and_stable(tmp_path):
    target = tmp_path / "artifact.bin"
    target.write_bytes(b"aetheris" * 1000)
    first = file_digest(target)
    assert len(first) == 64
    assert first == file_digest(target)
    target.write_bytes(b"different")
    assert file_digest(target) != first


def test_a_run_record_hashes_its_artifacts(tmp_path):
    target = tmp_path / "weights.json"
    target.write_text('{"parameters": []}')
    record = RunRecord.start("test")
    entry = record.add_artifact("weights", target)
    assert entry["exists"] is True
    assert entry["sha256"] == file_digest(target)
    assert entry["bytes"] == target.stat().st_size

    missing = record.add_artifact("absent", tmp_path / "nope.json")
    assert missing["exists"] is False
    assert missing["sha256"] is None, "a missing artifact must not get an invented hash"


def test_a_finished_record_cannot_claim_a_duration_it_did_not_measure():
    record = RunRecord.start("test")
    assert record.duration_seconds is None
    record.finish("completed")
    assert record.duration_seconds is not None
    assert record.status == "completed"


def test_finish_deduplicates_limitations():
    record = RunRecord.start("test")
    record.limitations.append("only two cores")
    record.finish("completed", limitations=["only two cores", "no gpu"])
    assert record.limitations == ["only two cores", "no gpu"]


def test_the_release_stage_requires_its_dependencies():
    pipeline = Pipeline(FAST)
    result = pipeline.release()
    assert result.status is StageStatus.FAILED
    assert "must run first" in result.detail["error"] or "must complete" in result.detail["error"]


def test_evaluation_without_training_fails_and_says_why():
    pipeline = Pipeline(FAST)
    pipeline.data_validation()
    result = pipeline.evaluation()
    assert result.status is StageStatus.FAILED
    assert "domain_training" in result.detail["error"]


def test_a_stage_failure_does_not_abort_the_run():
    # The record is more useful than a traceback: it shows where it broke and that
    # the stages after it cannot be trusted.
    pipeline = Pipeline(FAST)
    record = pipeline.run()
    assert record.status in ("completed", "partial", "failed")
    assert len(record.stages) == len(STAGE_NAMES)
    assert record.error is None or "failed" in record.error
