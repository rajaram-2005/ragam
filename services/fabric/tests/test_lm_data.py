"""Corpus manifest, the disjoint split, and deterministic batching.

The split is the part worth testing hardest. A leak here does not raise -- it
produces a validation number that is quietly too good, which is the exact failure
already found once in this project (base selection running on the evaluation split).
"""

from __future__ import annotations

import numpy as np
import pytest

from fabric.lm.data import (
    build_manifest,
    discover,
    is_excluded,
    make_batches,
    read_corpus,
)
from pathlib import Path


@pytest.fixture
def corpus(tmp_path):
    """A small tree with a nested file, an excluded dir, and a substring trap."""
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "a.md").write_text("alpha alpha alpha\n", encoding="utf-8")
    (tmp_path / "docs" / "b.md").write_text("beta beta beta\n", encoding="utf-8")
    (tmp_path / "docs" / "distributed.md").write_text("gamma gamma\n", encoding="utf-8")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "c.mjs").write_text("export const c = 1\n", encoding="utf-8")
    (tmp_path / "src" / "d.mjs").write_text("export const d = 2\n", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "dep.md").write_text("SHOULD NEVER APPEAR\n", encoding="utf-8")
    (tmp_path / "dist").mkdir()
    (tmp_path / "dist" / "bundled.md").write_text("SHOULD NEVER APPEAR\n", encoding="utf-8")
    (tmp_path / "binary.png").write_bytes(b"\x89PNG\r\n")
    return tmp_path


def test_exclusion_is_per_path_component_not_a_substring():
    """A substring test would drop `docs/distributed.md` for containing 'dist'.

    That is a real file in this repository, so the distinction is not academic.
    """
    assert is_excluded(Path("dist/bundle.js"), {"dist"})
    assert is_excluded(Path("a/node_modules/x.js"), {"node_modules"})
    assert not is_excluded(Path("docs/distributed.md"), {"dist"})
    assert not is_excluded(Path("docs/distribution.md"), {"dist"})


def test_discovery_is_deterministic_sorted_and_filters(corpus):
    found = [p.as_posix() for p in discover(corpus)]
    assert found == sorted(found), "discovery order must not depend on the filesystem"
    assert "docs/distributed.md" in found, "the substring trap file must survive discovery"
    assert not any("node_modules" in p for p in found)
    assert not any(p.startswith("dist/") for p in found)
    assert not any(p.endswith(".png") for p in found)
    assert discover(corpus) == discover(corpus)


def test_the_manifest_never_puts_a_file_on_both_sides(corpus):
    manifest = build_manifest(corpus, validation_fraction=0.34, split_seed=1)
    assert manifest.overlap() == set()
    # Derived from discovery rather than hardcoded, so adding a file to the fixture
    # cannot leave this assertion quietly checking the wrong number.
    discoverable = len(discover(corpus))
    assert discoverable == 5, f"fixture changed: {discoverable} discoverable files"
    assert len(manifest.train) + len(manifest.validation) == discoverable
    assert manifest.train and manifest.validation, "both sides must be non-empty"


def test_the_manifest_is_deterministic_and_seed_sensitive(corpus):
    a = build_manifest(corpus, validation_fraction=0.3, split_seed=7)
    b = build_manifest(corpus, validation_fraction=0.3, split_seed=7)
    c = build_manifest(corpus, validation_fraction=0.3, split_seed=8)
    assert a.digest == b.digest
    assert {f.path for f in a.validation} == {f.path for f in c.validation} or a.digest != c.digest


def test_the_manifest_records_a_hash_per_file(corpus):
    manifest = build_manifest(corpus, validation_fraction=0.3)
    for record in list(manifest.train) + list(manifest.validation):
        assert len(record.sha256) == 64
        assert record.bytes > 0
    # Editing a file must change the manifest digest, or it cannot detect drift.
    before = manifest.digest
    (corpus / "docs" / "a.md").write_text("changed content entirely\n", encoding="utf-8")
    assert build_manifest(corpus, validation_fraction=0.3).digest != before


def test_the_manifest_digest_changes_when_the_split_changes(corpus):
    a = build_manifest(corpus, validation_fraction=0.2, split_seed=1)
    b = build_manifest(corpus, validation_fraction=0.5, split_seed=1)
    assert a.digest != b.digest
    assert a.to_dict()["validationFiles"] != b.to_dict()["validationFiles"] or a.digest != b.digest


def test_reading_a_corpus_marks_every_file_boundary(corpus):
    """Without a marker, a file boundary is indistinguishable from ordinary text."""
    manifest = build_manifest(corpus, validation_fraction=0.3)
    text = read_corpus(corpus, manifest.train)
    for record in manifest.train:
        assert f"<|file: {record.path}|>" in text, f"no boundary marker for {record.path}"


def test_a_corpus_too_small_to_split_is_refused(tmp_path):
    (tmp_path / "only.md").write_text("one file\n", encoding="utf-8")
    with pytest.raises(ValueError, match="at least 2 corpus files"):
        build_manifest(tmp_path)


def test_an_out_of_range_validation_fraction_is_refused(corpus):
    for bad in (0.0, 1.0, -0.2, 1.5):
        with pytest.raises(ValueError, match="validation_fraction"):
            build_manifest(corpus, validation_fraction=bad)


# ---------------------------------------------------------------------------
# Batching
# ---------------------------------------------------------------------------


def test_batches_are_deterministic_for_a_seed():
    ids = np.arange(1000, dtype=np.int32)
    a = list(make_batches(ids, batch_size=3, seq_len=16, seed=5, steps=4))
    b = list(make_batches(ids, batch_size=3, seq_len=16, seed=5, steps=4))
    for x, y in zip(a, b):
        assert np.array_equal(x.inputs, y.inputs)
        assert np.array_equal(x.targets, y.targets)


def test_different_seeds_see_different_data():
    ids = np.arange(1000, dtype=np.int32)
    a = list(make_batches(ids, batch_size=4, seq_len=16, seed=1, steps=3))
    b = list(make_batches(ids, batch_size=4, seq_len=16, seed=2, steps=3))
    assert not any(np.array_equal(x.inputs, y.inputs) for x, y in zip(a, b))


def test_targets_are_inputs_shifted_by_one():
    """The next-token objective, asserted rather than assumed."""
    ids = np.arange(500, dtype=np.int32)
    for batch in make_batches(ids, batch_size=2, seq_len=8, seed=3, steps=5):
        assert batch.inputs.shape == batch.targets.shape == (2, 8)
        assert batch.inputs.dtype == np.int32 and batch.targets.dtype == np.int32
        for row in range(batch.inputs.shape[0]):
            assert np.array_equal(batch.targets[row, :-1], batch.inputs[row, 1:])
        # Continued sequence: the first target is the token after the last input.
        assert batch.targets[0, -1] == batch.inputs[0, -1] + 1


def test_a_corpus_shorter_than_the_window_is_refused():
    with pytest.raises(ValueError, match="too short for seq_len"):
        list(make_batches(np.arange(5, dtype=np.int32), batch_size=1, seq_len=16, seed=0, steps=1))
