"""Data quality scoring must be deterministic — that is the whole point of the rewrite.

Upstream ``sparsiz/training/dataforge/dataforge.py`` computed every quality term
with ``random.uniform``, so the same sample scored differently on each run and a
dataset manifest could not be reproduced. These tests pin determinism first, then
the formula, thresholds, dedupe, splitting and contamination checking.
"""

from __future__ import annotations

import pytest

from fabric.dataforge import (
    RESTRICTED_RISK,
    ContaminationReport,
    DatasetManifest,
    DataSample,
    QualityEngine,
    QualityWeights,
    SOURCE_TRUST,
    check_contamination,
)
from fabric.taxonomy import DataQualityTier
from fabric.text import stem_tokens

GOOD = (
    "The pack contactor must open within 250 milliseconds when any cell exceeds "
    "68 degrees Celsius. Isolation resistance must remain above 500 ohms per volt "
    "at all times, measured with the bms firmware in its diagnostic mode."
)

TECHNICAL = (
    "def open_contactor(cell_temp_c, threshold_c=68): return cell_temp_c > threshold_c  "
    "# latency budget 250 ms, busbar voltage 400 V"
)


def sample(content=GOOD, **kwargs) -> DataSample:
    return DataSample(content=content, **kwargs)


# --- determinism -----------------------------------------------------------


def test_the_same_sample_scores_identically_every_time():
    engine = QualityEngine()
    scores = [engine.score(sample())[0] for _ in range(25)]
    assert len(set(scores)) == 1, f"quality score is not deterministic: {set(scores)}"


def test_scoring_is_independent_of_engine_instance():
    first = QualityEngine().score(sample())
    second = QualityEngine().score(sample())
    assert first == second


def test_every_term_is_reproducible():
    engine = QualityEngine()
    for text in (GOOD, TECHNICAL, "short", "", "a" * 5000):
        target = sample(text)
        assert engine.score(target)[2] == engine.score(target)[2]


# --- the formula -----------------------------------------------------------


def test_the_formula_matches_the_documented_weights():
    weights = QualityWeights()
    engine = QualityEngine(weights)
    _, _, terms = engine.score(sample())
    expected = (
        weights.w_semantic * terms["q_semantic"]
        + weights.w_technical * terms["q_technical"]
        + weights.w_novelty * terms["q_novelty"]
        + weights.w_source * terms["q_source"]
        - weights.w_risk * terms["q_risk"]
    )
    actual = engine.score(sample())[0]
    assert actual == pytest.approx(max(0.0, min(1.0, expected)), abs=1e-6)


def test_the_risk_term_is_subtracted_not_added():
    engine = QualityEngine()
    clean = engine.score(sample(GOOD))[0]
    risky = engine.score(sample(f"{GOOD} AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY"))[0]
    assert risky < clean, "a sample carrying credentials must score lower than the same sample without"


def test_scores_are_clamped_to_the_unit_interval():
    engine = QualityEngine()
    for text in ("", "x", GOOD, "AWS_SECRET_ACCESS_KEY=zzzzzzzzzz " * 40):
        q, _, terms = engine.score(sample(text, source="social", metadata={"safety": "unsafe"}))
        assert 0.0 <= q <= 1.0
        assert all(0.0 <= value <= 1.0 for value in terms.values())


def test_custom_weights_change_the_outcome():
    default = QualityEngine().score(sample(TECHNICAL))[0]
    technical_heavy = QualityEngine(QualityWeights(w_technical=0.9, w_semantic=0.02)).score(sample(TECHNICAL))[0]
    assert technical_heavy != default


# --- tier thresholds (upstream, unchanged) ---------------------------------


@pytest.mark.parametrize(
    "score,tier",
    [(0.0, DataQualityTier.BAD), (0.29, DataQualityTier.BAD), (0.3, DataQualityTier.MEDIUM),
     (0.59, DataQualityTier.MEDIUM), (0.6, DataQualityTier.HIGH), (0.84, DataQualityTier.HIGH),
     (0.85, DataQualityTier.ELITE), (1.0, DataQualityTier.ELITE)],
)
def test_tier_thresholds_match_upstream(score, tier):
    assert DataQualityTier.for_score(score) is tier


# --- individual terms ------------------------------------------------------


def test_technical_content_scores_higher_on_the_technical_term():
    engine = QualityEngine()
    assert engine.q_technical(sample(TECHNICAL)) > engine.q_technical(sample("The weather is pleasant today."))


def test_empty_content_scores_zero_semantically():
    assert QualityEngine().q_semantic(sample("")) == 0.0


def test_an_answer_that_ignores_its_question_scores_worse():
    engine = QualityEngine()
    coherent = sample("Answer.", fields={"query": "contactor opening threshold", "answer": "the contactor opens at the threshold"})
    incoherent = sample("Answer.", fields={"query": "contactor opening threshold", "answer": "bananas are yellow fruit"})
    assert engine.q_semantic(coherent) > engine.q_semantic(incoherent)


def test_a_half_populated_qa_pair_is_penalised():
    engine = QualityEngine()
    complete = sample(GOOD, fields={
        "query": "within how many milliseconds must the contactor open",
        "answer": "the contactor must open within 250 milliseconds above 68 degrees Celsius",
    })
    partial = sample(GOOD, fields={"query": "within how many milliseconds must the contactor open"})
    assert engine.q_semantic(partial) < engine.q_semantic(complete)


def test_an_answer_that_shares_nothing_with_its_question_is_penalised():
    engine = QualityEngine()
    on_topic = sample(GOOD, fields={
        "query": "contactor opening threshold",
        "answer": "the contactor opens at the thermal threshold",
    })
    off_topic = sample(GOOD, fields={
        "query": "contactor opening threshold",
        "answer": "bananas are a yellow tropical fruit",
    })
    assert engine.q_semantic(off_topic) < engine.q_semantic(on_topic)


def test_source_trust_comes_from_a_declared_table():
    engine = QualityEngine()
    assert engine.q_source(sample(GOOD, source="textbook")) == SOURCE_TRUST["textbook"]
    assert engine.q_source(sample(GOOD, source="social")) < engine.q_source(sample(GOOD, source="textbook"))
    # A qualified source string still resolves.
    assert engine.q_source(sample(GOOD, source="arxiv:2401.12345")) == SOURCE_TRUST["arxiv"]
    # An undeclared source falls back to 'unknown', not to the most trusted entry.
    assert engine.q_source(sample(GOOD, source="mystery-corp")) == SOURCE_TRUST["unknown"]


def test_novelty_collapses_for_near_duplicate_content():
    engine = QualityEngine()
    first = sample(GOOD)
    seen = [set(stem_tokens(GOOD))]
    assert engine.q_novelty(first, seen=seen) == 0.0
    assert engine.q_novelty(sample("An entirely different subject about torque ripple in motors."), seen=seen) > 0.9


def test_novelty_without_history_is_maximal():
    assert QualityEngine().q_novelty(sample(GOOD)) == 1.0


# --- risk detection --------------------------------------------------------


@pytest.mark.parametrize(
    "text,expected",
    [
        ("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY", "env_style_secret"),
        ("key AKIAIOSFODNN7EXAMPLE", "aws_access_key_id"),
        ("token sk-abcdefghij1234567890", "openai_style_key"),
        ("-----BEGIN RSA PRIVATE KEY-----", "private_key_block"),
        ("postgres://user:pw12345678@db.internal:5432/app", "connection_string"),
        ("https://svc:sup3rsecret@internal.example/api", "url_basic_auth"),
        ("contact ops@example.com for details", "email_address"),
    ],
)
def test_risk_patterns_are_detected(text, expected):
    assert expected in QualityEngine().risk_findings(sample(text))


def test_clean_technical_prose_has_no_risk_findings():
    assert QualityEngine().risk_findings(sample(GOOD)) == []


def test_restricted_risk_kinds_are_a_subset_of_detected_kinds():
    engine = QualityEngine()
    for text, name in [("AKIAIOSFODNN7EXAMPLE", "aws_access_key_id"), ("AWS_SECRET_ACCESS_KEY=abcdefgh12345", "env_style_secret")]:
        assert name in engine.risk_findings(sample(text))
        assert name in RESTRICTED_RISK


def test_findings_never_include_the_secret_value():
    findings = QualityEngine().risk_findings(sample("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY"))
    assert "wJalrXUtnFEMI" not in "".join(findings)


# --- the manifest ----------------------------------------------------------


def test_the_manifest_deduplicates_by_content_hash():
    manifest = DatasetManifest()
    first = manifest.add(sample(GOOD, source="textbook"))
    second = manifest.add(sample(GOOD, source="textbook"))
    assert first["sha256"] == second["sha256"]
    assert len(manifest) == 1
    assert manifest.samples[0]["duplicates"] == 1
    assert manifest.quality_summary()["duplicates"] == 1


def test_a_sample_below_the_minimum_tier_is_rejected_with_a_reason():
    manifest = DatasetManifest(min_tier=DataQualityTier.HIGH)
    entry = manifest.add(sample("short", source="social"))
    assert entry.get("rejected")
    assert "below the required" in entry["rejected"]
    assert len(manifest) == 0
    assert len(manifest.rejected) == 1


def test_credential_material_is_rejected_even_when_otherwise_high_quality():
    manifest = DatasetManifest(min_tier=DataQualityTier.BAD)
    entry = manifest.add(sample(f"{GOOD} AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY", source="textbook"))
    assert entry.get("rejected")
    assert "credential material" in entry["rejected"]
    assert len(manifest) == 0


def test_novelty_falls_as_similar_samples_accumulate():
    manifest = DatasetManifest(min_tier=DataQualityTier.BAD)
    base = "The contactor opens within 250 milliseconds above 68 degrees Celsius."
    first = manifest.add(sample(base, source="textbook"))
    second = manifest.add(sample(base + " Isolation resistance must stay above 500 ohms per volt.", source="textbook"))
    assert second["terms"]["q_novelty"] < first["terms"]["q_novelty"]


def test_the_manifest_digest_is_stable_and_content_sensitive():
    def build(extra=""):
        manifest = DatasetManifest()
        manifest.add(sample(GOOD, source="textbook"))
        manifest.add(sample(TECHNICAL, source="github", modality="code"))
        if extra:
            manifest.add(sample(extra, source="textbook"))
        return manifest.digest()

    assert build() == build(), "the same dataset must hash identically"
    assert build() != build("An additional sample about torque ripple."), "different data must hash differently"


def test_the_digest_changes_when_the_weights_change():
    plain = DatasetManifest()
    plain.add(sample(GOOD, source="textbook"))
    weighted = DatasetManifest(engine=QualityEngine(QualityWeights(w_semantic=0.9)))
    weighted.add(sample(GOOD, source="textbook"))
    assert plain.digest() != weighted.digest()


# --- splitting and contamination -------------------------------------------


def build_manifest(count=40):
    manifest = DatasetManifest(min_tier=DataQualityTier.BAD)
    for i in range(count):
        manifest.add(
            sample(
                f"Document {i} describes the contactor behaviour at {60 + i} degrees Celsius "
                f"with an isolation resistance of {500 + i} ohms per volt and latency {200 + i} ms.",
                source="textbook",
            )
        )
    return manifest


def test_the_split_is_disjoint_and_covers_everything():
    manifest = build_manifest()
    parts = manifest.split(evaluation_fraction=0.2)
    train_ids = {entry["sha256"] for entry in parts["train"]}
    eval_ids = {entry["sha256"] for entry in parts["evaluation"]}
    assert not (train_ids & eval_ids), "development and evaluation data must not overlap"
    assert train_ids | eval_ids == {entry["sha256"] for entry in manifest.samples}
    assert len(parts["evaluation"]) == pytest.approx(len(manifest) * 0.2, abs=1)


def test_the_split_is_deterministic_and_order_independent():
    first = build_manifest().split()
    second = build_manifest().split()
    assert [e["sha256"] for e in first["train"]] == [e["sha256"] for e in second["train"]]

    # Insertion order must not decide the split: it is keyed by content hash.
    reversed_manifest = DatasetManifest(min_tier=DataQualityTier.BAD)
    originals = [
        f"Document {i} describes the contactor behaviour at {60 + i} degrees Celsius "
        f"with an isolation resistance of {500 + i} ohms per volt and latency {200 + i} ms."
        for i in range(40)
    ]
    for text in reversed(originals):
        reversed_manifest.add(sample(text, source="textbook"))
    third = reversed_manifest.split()
    assert {e["sha256"] for e in third["train"]} == {e["sha256"] for e in first["train"]}


def test_a_different_seed_gives_a_different_split():
    manifest = build_manifest()
    a = manifest.split(seed=0)
    b = manifest.split(seed=7)
    assert {e["sha256"] for e in a["evaluation"]} != {e["sha256"] for e in b["evaluation"]}


def test_invalid_split_parameters_are_rejected():
    manifest = build_manifest(4)
    with pytest.raises(ValueError):
        manifest.split(evaluation_fraction=0.0)
    with pytest.raises(ValueError):
        manifest.split(evaluation_fraction=1.0)
    # One sample cannot be both trained on and evaluated against; a silent empty
    # evaluation split would make every downstream metric vacuous.
    single = DatasetManifest(min_tier=DataQualityTier.BAD)
    single.add(sample(GOOD, source="textbook"))
    with pytest.raises(ValueError, match="at least 2 samples"):
        single.split()

    empty = DatasetManifest(min_tier=DataQualityTier.BAD)
    with pytest.raises(ValueError):
        empty.split()


def test_a_clean_split_reports_no_contamination():
    manifest = build_manifest()
    parts = manifest.split()
    train = [sample(e["sha256"]) for e in parts["train"]]
    evaluation = [sample(e["sha256"]) for e in parts["evaluation"]]
    report = check_contamination(train, evaluation)
    assert isinstance(report, ContaminationReport)
    assert report.contaminated is False
    assert report.exactDuplicates == []
    assert report.nearDuplicates == []


def test_an_exact_leak_is_detected():
    train = [sample(GOOD), sample(TECHNICAL)]
    evaluation = [sample(GOOD)]
    report = check_contamination(train, evaluation)
    assert report.contaminated is True
    assert len(report.exactDuplicates) == 1


def test_a_reworded_leak_is_detected_by_shingle_overlap():
    original = (
        "The pack contactor must open within 250 milliseconds when any cell exceeds 68 degrees "
        "Celsius and the isolation resistance must remain above 500 ohms per volt at all times "
        "while the bms firmware continues to sample every cell voltage in its diagnostic loop."
    )
    train = [sample(original)]
    # Same content, different opening clause: an exact hash check would miss this.
    paraphrase = "NOTE: " + original
    assert sample(paraphrase).sha256 != sample(original).sha256
    report = check_contamination(train, [sample(paraphrase)])
    assert report.contaminated is True
    assert report.exactDuplicates == []
    assert len(report.nearDuplicates) == 1
    assert report.nearDuplicates[0]["shingleOverlap"] > 0.8


def test_unrelated_content_is_not_flagged_as_contamination():
    train = [sample(GOOD)]
    evaluation = [sample("Torque ripple in the drive inverter causes audible noise at low speed.")]
    assert check_contamination(train, evaluation).contaminated is False


def test_the_contamination_threshold_is_respected():
    original = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron"
    train = [sample(original)]
    partial = "alpha beta gamma delta epsilon zeta eta theta CHANGED CHANGED CHANGED CHANGED"
    strict = check_contamination(train, [sample(partial)], threshold=0.99)
    lenient = check_contamination(train, [sample(partial)], threshold=0.1)
    assert lenient.contaminated is True
    assert strict.contaminated is False


def test_sample_hash_is_full_length_sha256():
    # Upstream truncated to 16 hex chars; a manifest should carry the full digest.
    assert len(sample(GOOD).sha256) == 64
    assert len(sample(GOOD).sample_id) == 16
