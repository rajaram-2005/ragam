"""The Python text/BM25 port must agree with the Node implementation exactly.

``tests/fixtures/text-parity.json`` is generated from
``services/core/src/knowledge/{text,bm25}.mjs`` by
``scripts/generate-parity-fixture.mjs`` and committed, so this suite runs with
nothing but Python and NumPy.

Why this matters: the Aetheris Lite retriever is benchmarked against the BM25
index that serves production retrieval. If the two implementations segmented
text differently, the comparison would measure the tokeniser rather than the
model, and any "improvement" recorded in the experiment ledger would be noise.
Agreement is pinned here so a change on either side fails loudly.

Regenerate the fixture after touching either implementation:

    cd services/fabric && node scripts/generate-parity-fixture.mjs \\
        > tests/fixtures/text-parity.json
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from fabric.bm25 import Bm25Index
from fabric.text import chunk_text, content_tokens, split_sentences, stem, stem_tokens, tokenize

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "text-parity.json"


@pytest.fixture(scope="module")
def fixture() -> dict:
    if not FIXTURE_PATH.exists():
        pytest.fail(
            f"{FIXTURE_PATH} is missing; regenerate it with "
            "scripts/generate-parity-fixture.mjs (requires Node)"
        )
    return json.loads(FIXTURE_PATH.read_text())


def test_the_fixture_records_where_it_came_from(fixture):
    assert fixture["source"] == "services/core/src/knowledge/{text,bm25}.mjs"
    assert len(fixture["texts"]) == len(fixture["tokenize"])
    assert len(fixture["texts"]) > 5, "the fixture must cover awkward inputs, not just prose"


@pytest.mark.parametrize("field,function", [
    ("tokenize", tokenize),
    ("contentTokens", content_tokens),
    ("stemTokens", stem_tokens),
])
def test_tokenisation_matches(fixture, field, function):
    for text, expected in zip(fixture["texts"], fixture[field]):
        assert function(text) == expected, f"{field} diverged on {text[:60]!r}"


def test_stemming_matches(fixture):
    for token, expected in fixture["stem"]:
        assert stem(token) == expected, f"stem({token!r}) = {stem(token)!r}, expected {expected!r}"


def test_sentence_splitting_matches(fixture):
    for text, expected in zip(fixture["texts"], fixture["splitSentences"]):
        assert split_sentences(text) == expected, f"split_sentences diverged on {text[:60]!r}"


def test_chunking_matches(fixture):
    for text, expected in zip(fixture["texts"], fixture["chunkText"]):
        actual = chunk_text(text)
        assert actual == expected, f"chunk_text diverged on {text[:60]!r}"


def test_no_chunk_exceeds_the_hard_cap(fixture):
    # Guards the invariant the retriever relies on, independently of parity.
    for text in fixture["texts"]:
        for chunk in chunk_text(text, max_chars=2000):
            assert chunk["end"] - chunk["start"] <= 2000
            assert len(chunk["text"]) <= 2000


def _build(fixture) -> Bm25Index:
    index = Bm25Index()
    for i, text in enumerate(fixture["texts"]):
        index.add(f"doc-{i:02d}", text, {"index": i})
    return index


def test_bm25_defaults_match(fixture):
    index = _build(fixture)
    assert index.k1 == fixture["bm25"]["k1"] == 1.5
    assert index.b == fixture["bm25"]["b"] == 0.75


def test_bm25_corpus_statistics_match(fixture):
    assert _build(fixture).stats() == fixture["bm25"]["stats"]


def test_bm25_idf_matches(fixture):
    index = _build(fixture)
    node = Bm25Index()
    for i, text in enumerate(fixture["texts"]):
        node.add(f"doc-{i:02d}", text)
    for term in ["contactor", "open", "thermal", "absent-term"]:
        assert index.idf(term) == pytest.approx(node.idf(term), abs=1e-12)


def test_bm25_rankings_match(fixture):
    index = _build(fixture)
    for case in fixture["bm25"]["searches"]:
        actual = index.search(case["query"], top_k=case["topK"])
        expected = case["hits"]
        assert len(actual) == len(expected), f"hit count diverged for {case['query']!r}"
        for got, want in zip(actual, expected):
            assert got["docId"] == want["docId"], f"ranking diverged for {case['query']!r}"
            assert got["score"] == pytest.approx(want["score"], rel=1e-12, abs=1e-12)
            assert got["matchedTerms"] == want["matchedTerms"]
            assert got["meta"] == want["meta"]


def test_bm25_is_deterministic_across_rebuilds(fixture):
    # A benchmark that changes between runs cannot support an accept/reject verdict.
    first = _build(fixture)
    second = _build(fixture)
    for query in fixture["queries"]:
        assert [h["docId"] for h in first.search(query)] == [h["docId"] for h in second.search(query)]
        assert [h["score"] for h in first.search(query)] == [h["score"] for h in second.search(query)]


def test_removing_a_document_restores_the_statistics(fixture):
    index = _build(fixture)
    before = index.stats()
    index.add("doc-99", "a temporary document about contactors", {"temp": True})
    assert index.stats()["documents"] == before["documents"] + 1
    assert index.remove("doc-99") is True
    assert index.remove("doc-99") is False
    after = index.stats()
    # version advanced, but the corpus is byte-for-byte back to its prior state.
    assert {k: v for k, v in after.items() if k != "version"} == {k: v for k, v in before.items() if k != "version"}
    assert after["version"] > before["version"]


def test_reindexing_a_document_is_idempotent(fixture):
    index = _build(fixture)
    text = fixture["texts"][2]
    once = index.search("contactor opening threshold", top_k=3)
    index.add("doc-02", text, {"index": 2})
    twice = index.search("contactor opening threshold", top_k=3)
    assert [h["docId"] for h in once] == [h["docId"] for h in twice]
    assert index.stats()["documents"] == len(fixture["texts"])


def test_the_filter_predicate_is_applied_before_scoring(fixture):
    index = _build(fixture)
    unfiltered = index.search("contactor opening threshold", top_k=5)
    filtered = index.search(
        "contactor opening threshold",
        top_k=5,
        filter=lambda doc_id, meta: meta.get("index", -1) % 2 == 0,
    )
    assert all(hit["meta"]["index"] % 2 == 0 for hit in filtered)
    assert len(filtered) <= len(unfiltered)


def test_invalid_parameters_are_rejected():
    with pytest.raises(ValueError):
        Bm25Index(k1=0)
    with pytest.raises(ValueError):
        Bm25Index(b=1.5)
    with pytest.raises(ValueError):
        Bm25Index().add("", "text")
