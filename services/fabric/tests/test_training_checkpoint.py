"""The checkpoint store: atomic, verified, bound to one run, and never silently mixed.

These tests simulate the failures a rented notebook actually produces: a session that
dies mid-write, a truncated file, a directory reused with a changed configuration.
"""

from __future__ import annotations

import pytest

from fabric.training.checkpoint import CheckpointError, CheckpointStore, ResumeMismatch

CONFIG = "c" * 64


def store_with(tmp_path, steps=(10, 20, 30)):
    store = CheckpointStore(tmp_path / "ckpt")
    for step in steps:
        store.save(step, {"weights.bin": f"weights-{step}".encode(), "opt.bin": b"opt"},
                   config_digest=CONFIG, meta={"step": step})
    return store


def test_a_saved_checkpoint_round_trips_byte_for_byte(tmp_path):
    store = store_with(tmp_path, steps=(7,))
    loaded = store.load_latest(CONFIG)
    assert loaded.step == 7
    assert loaded.files == {"weights.bin": b"weights-7", "opt.bin": b"opt"}
    assert loaded.meta == {"step": 7}
    assert loaded.skipped == ()


def test_the_newest_verified_checkpoint_is_loaded(tmp_path):
    store = store_with(tmp_path)
    assert store.load_latest(CONFIG).step == 30


def test_an_empty_directory_means_start_fresh(tmp_path):
    assert CheckpointStore(tmp_path / "nothing").load_latest(CONFIG) is None


def test_a_crash_mid_save_leaves_no_checkpoint(tmp_path):
    store = store_with(tmp_path, steps=(10,))
    with pytest.raises(TypeError):
        # Unserialisable metadata fails after the files are written, while the staging
        # directory is still disposable. Nothing may be left behind.
        store.save(20, {"weights.bin": b"x"}, config_digest=CONFIG, meta={"bad": object()})
    assert store.steps() == [10]
    assert not [p for p in (tmp_path / "ckpt").iterdir() if p.name.startswith(".staging")]


def test_a_directory_without_a_manifest_is_skipped_with_the_reason(tmp_path):
    store = store_with(tmp_path)
    (tmp_path / "ckpt" / "step-00000040").mkdir()  # a session died before the manifest
    loaded = store.load_latest(CONFIG)
    assert loaded.step == 30
    assert any("step 40" in note and "no manifest" in note for note in loaded.skipped)


def test_a_truncated_file_is_detected_and_the_previous_checkpoint_used(tmp_path):
    store = store_with(tmp_path)
    (tmp_path / "ckpt" / "step-00000030" / "weights.bin").write_bytes(b"weights-3")  # truncated
    loaded = store.load_latest(CONFIG)
    assert loaded.step == 20
    assert any("step 30" in note and "checksum" in note for note in loaded.skipped)


def test_a_missing_file_is_detected(tmp_path):
    store = store_with(tmp_path)
    (tmp_path / "ckpt" / "step-00000030" / "opt.bin").unlink()
    loaded = store.load_latest(CONFIG)
    assert loaded.step == 20
    assert any("'opt.bin' is missing" in note for note in loaded.skipped)


def test_a_checkpoint_from_another_configuration_is_refused_not_resumed(tmp_path):
    store = store_with(tmp_path)
    with pytest.raises(ResumeMismatch, match="different"):
        store.load_latest("d" * 64)


def test_one_foreign_checkpoint_poisons_the_directory(tmp_path):
    store = store_with(tmp_path)
    store.save(40, {"weights.bin": b"other"}, config_digest="e" * 64)
    with pytest.raises(ResumeMismatch):
        store.load_latest(CONFIG)


def test_saving_over_a_rejected_checkpoint_moves_it_aside_and_keeps_the_evidence(tmp_path):
    store = store_with(tmp_path, steps=(10, 20))
    (tmp_path / "ckpt" / "step-00000020" / "weights.bin").write_bytes(b"corrupt")
    assert store.load_latest(CONFIG).step == 10
    store.save(20, {"weights.bin": b"fresh"}, config_digest=CONFIG)
    assert store.load_latest(CONFIG).files["weights.bin"] == b"fresh"
    quarantined = [p for p in (tmp_path / "ckpt").iterdir() if p.name.startswith("quarantine-step-00000020")]
    assert len(quarantined) == 1
    assert (quarantined[0] / "weights.bin").read_bytes() == b"corrupt"


def test_prune_keeps_the_newest_and_never_zero(tmp_path):
    store = store_with(tmp_path, steps=(10, 20, 30, 40))
    assert store.prune(2) == [10, 20]
    assert store.steps() == [30, 40]
    with pytest.raises(CheckpointError):
        store.prune(0)


@pytest.mark.parametrize("name", ["../escape", "sub/file", "manifest.json", "", "."])
def test_illegal_file_names_are_refused(tmp_path, name):
    with pytest.raises(CheckpointError):
        CheckpointStore(tmp_path / "ckpt").save(1, {name: b"x"}, config_digest=CONFIG)


def test_non_bytes_payloads_are_refused(tmp_path):
    with pytest.raises(CheckpointError):
        CheckpointStore(tmp_path / "ckpt").save(1, {"w": "text"}, config_digest=CONFIG)


def test_a_verified_checkpoint_is_never_overwritten_or_moved_aside(tmp_path):
    """Regression: a run that forgot to resume used to quarantine the good checkpoint at
    the same step. The store now refuses, and the good checkpoint stays exactly where it is."""
    store = store_with(tmp_path, steps=(10,))
    with pytest.raises(CheckpointError, match="verified checkpoint"):
        store.save(10, {"weights.bin": b"second"}, config_digest=CONFIG)
    assert store.load_latest(CONFIG).files["weights.bin"] == b"weights-10"
    assert not any(p.name.startswith("quarantine") for p in (tmp_path / "ckpt").iterdir())
