"""Training: the schedule, the optimiser, reproducibility, and artifact safety.

Two properties get the most attention. First, that the same inputs produce a
bit-identical artifact -- a training run that cannot be reproduced cannot be
released, and "it trained fine on my machine" is not evidence. Second, that an
existing artifact is never silently replaced: the whole point of recording a weights
digest is that a known-good model can be identified and protected.
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
import time
import zipfile
from pathlib import Path

import numpy as np
import pytest

from fabric.lm.model import TransformerConfig, TransformerLM, weights_digest
from fabric.lm.train import AdamW, TrainConfig, _is_matrix, read_checkpoint, train


#: The child process of the resume test. It trains with a checkpoint after every step, so killing
#: it leaves exactly what an interrupted run leaves: a state file and no artifact.
_INTERRUPTIBLE_LEG = """
import json, sys
from fabric.lm.train import TrainConfig, train
corpus, out, base = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
train(TrainConfig(**base), output_dir=out, corpus_root=corpus, run_name="r", checkpoint_every=1)
"""


@pytest.fixture(scope="module")
def corpus(tmp_path_factory):
    """A small but structured corpus: enough repetition that loss has somewhere to go."""
    root = tmp_path_factory.mktemp("corpus")
    body = (
        "export function alpha(input) {\n  return input.map((value) => value + 1);\n}\n\n"
        "# Heading\n\nThe quick brown fox jumps over the lazy dog repeatedly.\n\n"
        "const beta = { key: 'value', other: 42 };\n"
    )
    for i in range(10):
        (root / f"file{i}.mjs").write_text(body * (3 + i % 4), encoding="utf-8")
    return root


def small_config(**overrides):
    base = dict(
        d_model=32, n_layers=1, n_heads=2, d_ff=64, seq_len=32, batch_size=4,
        steps=12, warmup_steps=3, learning_rate=3e-3, eval_batch_size=2,
    )
    return TrainConfig(**{**base, **overrides})


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def test_a_warmup_that_never_ends_is_refused():
    """Otherwise the learning rate never enters its decay phase and the run is not
    the run the config describes."""
    with pytest.raises(ValueError, match="must be below steps"):
        small_config(steps=10, warmup_steps=10)
    with pytest.raises(ValueError, match="must be below steps"):
        small_config(steps=10, warmup_steps=11)


def test_invalid_budgets_are_refused():
    for bad, message in (
        ({"steps": 0}, "steps must be at least 1"),
        ({"learning_rate": 0.0}, "learning_rate must be positive"),
        ({"grad_clip": -1.0}, "grad_clip must be positive"),
        ({"min_learning_rate_ratio": 0.0}, "min_learning_rate_ratio"),
        ({"min_learning_rate_ratio": 1.5}, "min_learning_rate_ratio"),
        ({"dtype": "bfloat16"}, "unsupported dtype"),
    ):
        with pytest.raises(ValueError, match=message):
            small_config(**bad)


def test_the_learning_rate_warms_up_then_decays_to_the_floor():
    config = small_config(steps=100, warmup_steps=10, learning_rate=1.0, min_learning_rate_ratio=0.1)
    rates = [config.learning_rate_at(step) for step in range(100)]
    assert rates[0] == pytest.approx(0.1), "the first step is a tenth of the peak"
    assert rates[9] == pytest.approx(1.0), "warmup reaches the peak"
    assert max(rates) == pytest.approx(1.0)
    assert rates[-1] == pytest.approx(0.1, abs=0.02), "cosine decays to the floor"
    assert all(rates[i] >= rates[i + 1] - 1e-9 for i in range(9, 99)), "decay must be monotone"


def test_the_learning_rate_never_exceeds_the_configured_peak():
    for warmup in (1, 25, 50):
        config = small_config(steps=100, warmup_steps=warmup, learning_rate=5e-3)
        assert max(config.learning_rate_at(s) for s in range(100)) <= 5e-3 + 1e-12


# ---------------------------------------------------------------------------
# Optimiser
# ---------------------------------------------------------------------------


def test_weight_decay_applies_only_to_projection_matrices():
    """Decaying a LayerNorm gain shrinks the normalisation scale; that is damage,
    not regularisation. Decaying an embedding flattens the tied output logits."""
    assert _is_matrix("L0.wq", (16, 16))
    assert _is_matrix("L2.w2", (64, 16))
    for name, shape in (
        ("emb", (20, 16)), ("pos", (8, 16)),
        ("L0.ln1_gain", (16,)), ("L0.ln2_bias", (16,)),
        ("lnf_gain", (16,)), ("lnf_bias", (16,)),
    ):
        assert not _is_matrix(name, shape), f"{name} must not be decayed"


def test_gradient_clipping_bounds_the_global_norm():
    config = small_config(grad_clip=0.5)
    params = {"w": np.zeros((4, 4), dtype=np.float32)}
    grads = {"w": np.full((4, 4), 100.0, dtype=np.float32)}
    optimizer = AdamW(config, {"w": (4, 4)})
    reported = optimizer.step(params, grads, 0.1)
    assert reported == pytest.approx(0.5), "the clipped norm must equal the clip value"
    # Adam normalises by the second moment, so a uniformly large gradient still
    # produces a step of about the learning rate, not of magnitude 100.
    assert np.abs(params["w"]).max() == pytest.approx(0.1, rel=0.05)


def test_a_zero_gradient_produces_no_step():
    config = small_config()
    params = {"w": np.zeros((3, 3), dtype=np.float32)}
    optimizer = AdamW(config, {"w": (3, 3)})
    optimizer.step(params, {"w": np.zeros((3, 3), dtype=np.float32)}, 0.1)
    assert np.allclose(params["w"], 0.0)


# ---------------------------------------------------------------------------
# End to end
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def report(corpus, tmp_path_factory):
    out = tmp_path_factory.mktemp("out")
    return train(small_config(), output_dir=out, corpus_root=corpus, run_name="test-lm")


def test_a_run_produces_an_artifact_and_a_report(report):
    assert report.final_loss < report.loss_curve[0]["loss"], "loss did not fall at all"
    assert math.isfinite(report.final_loss)
    assert len(report.artifact["weightsDigest"]) == 64
    assert report.artifact["bytes"] > 0
    assert Path(report.artifact["path"]).exists()


def test_the_report_records_what_a_run_needs_to_be_re_derived(report):
    payload = report.to_dict()
    assert payload["corpus"]["manifestDigest"]
    assert payload["corpus"]["trainFiles"] > 0 and payload["corpus"]["validationFiles"] > 0
    assert payload["tokenizer"]["vocabularyDigest"]
    assert payload["provenance"]["seed"] == {"model": 0, "data": 0, "split": 20251012}
    assert payload["provenance"]["parameterCount"] > 0
    assert payload["provenance"]["numpy"]
    assert payload["provenance"]["codeRevision"]
    assert payload["model_config"]["vocab_size"] == payload["tokenizer"]["size"]
    assert payload["resource"]["wallSeconds"] >= 0
    assert payload["resource"]["tokensSeen"] == 4 * 32 * 12


def test_the_loss_curve_is_recorded_for_every_step(report):
    assert len(report.loss_curve) == 12
    assert [entry["step"] for entry in report.loss_curve] == list(range(12))
    assert all(math.isfinite(entry["loss"]) for entry in report.loss_curve)
    assert all(entry["lr"] > 0 for entry in report.loss_curve)


def test_evaluation_is_reported_against_real_baselines(report):
    evaluation = report.evaluation
    assert [b["name"] for b in evaluation["baselines"]] == ["uniform", "unigram", "bigram"]
    assert evaluation["tokensEvaluated"] > 0
    assert evaluation["bestBaseline"] == "bigram", "on this corpus order-1 statistics should win"
    # The verdict must be a computed comparison, not a constant.
    best = next(b for b in evaluation["baselines"] if b["name"] == evaluation["bestBaseline"])
    assert evaluation["beatsAllBaselines"] == (evaluation["nllNatsPerToken"] < best["nllNatsPerToken"])


def test_the_unknown_rate_is_measured_not_assumed(report):
    assert 0.0 <= report.tokenizer["validationUnknownRate"] < 0.05


def test_the_same_run_twice_produces_the_same_artifact(corpus, tmp_path):
    """Reproducibility, asserted on the weight bytes rather than on the loss."""
    first = train(small_config(), output_dir=tmp_path / "a", corpus_root=corpus, run_name="r")
    second = train(small_config(), output_dir=tmp_path / "b", corpus_root=corpus, run_name="r")
    assert first.artifact["weightsDigest"] == second.artifact["weightsDigest"]
    assert first.artifact["fileDigest"] == second.artifact["fileDigest"]
    assert first.loss_curve == second.loss_curve


def test_a_different_model_seed_produces_different_weights(corpus, tmp_path):
    """The complement of the test above: if the seed did nothing, reproducibility
    would be trivially satisfied and meaningless."""
    first = train(small_config(model_seed=0), output_dir=tmp_path / "a", corpus_root=corpus)
    second = train(small_config(model_seed=1), output_dir=tmp_path / "b", corpus_root=corpus)
    assert first.artifact["weightsDigest"] != second.artifact["weightsDigest"]


def test_a_colliding_artifact_is_not_silently_overwritten(corpus, tmp_path):
    """A same-name, different-content artifact must be refused, not replaced."""
    out = tmp_path / "out"
    report = train(small_config(), output_dir=out, corpus_root=corpus, run_name="r")
    path = Path(report.artifact["path"])

    # Simulate a previously released artifact at the same content-derived path.
    config = TransformerConfig(**report.model_config)
    decoy = TransformerLM(config, seed=999, dtype=np.float32)
    decoy.save(path)
    digest_of_decoy = weights_digest(decoy.params)

    with pytest.raises(FileExistsError, match="Refusing to overwrite"):
        train(small_config(), output_dir=out, corpus_root=corpus, run_name="r")
    assert weights_digest(TransformerLM.load(path, config).params) == digest_of_decoy, (
        "the refusal must leave the existing artifact untouched"
    )


def test_rerunning_an_identical_run_is_idempotent(corpus, tmp_path):
    """Re-running the *same* run must not be treated as a collision."""
    out = tmp_path / "out"
    first = train(small_config(), output_dir=out, corpus_root=corpus, run_name="r")
    second = train(small_config(), output_dir=out, corpus_root=corpus, run_name="r")
    assert first.artifact["weightsDigest"] == second.artifact["weightsDigest"]


def test_a_split_that_leaked_is_refused(monkeypatch, corpus, tmp_path):
    """The guard that makes the disjoint-split claim enforceable, not just intended."""
    import fabric.lm.train as train_module

    real_build = train_module.build_manifest

    def leaky_build(root, **kwargs):
        manifest = real_build(root, **kwargs)
        # Put the first validation file on the training side too.
        return type(manifest)(
            train=manifest.train + (manifest.validation[0],),
            validation=manifest.validation,
            extensions=manifest.extensions,
            exclude_dirs=manifest.exclude_dirs,
            split_seed=manifest.split_seed,
            validation_fraction=manifest.validation_fraction,
        )

    monkeypatch.setattr(train_module, "build_manifest", leaky_build)
    with pytest.raises(RuntimeError, match="leaked files across both sides"):
        train(small_config(), output_dir=tmp_path, corpus_root=corpus)


def test_the_report_serialises_to_json(report, tmp_path):
    """The report is the artifact of record; it must survive a round trip."""
    payload = report.to_dict()
    path = tmp_path / "report.json"
    path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    restored = json.loads(path.read_text(encoding="utf-8"))
    assert restored["artifact"]["weightsDigest"] == report.artifact["weightsDigest"]
    assert len(restored["loss_curve"]) == len(report.loss_curve)


def test_the_corpus_snapshot_is_written_and_hashed(corpus, tmp_path):
    """Without this, the model is only reproducible while the repository stands still.

    It is trained on this repository's own text, so any added file changes the corpus
    and therefore the weights. The manifest digest proves the corpus changed; the
    snapshot is what lets it be rebuilt.
    """
    report = train(small_config(), output_dir=tmp_path, corpus_root=corpus, run_name="r")
    snapshot = Path(report.artifact["path"]).parent / report.artifact["corpusSnapshot"]
    assert snapshot.exists()
    assert len(report.artifact["corpusSnapshotDigest"]) == 64

    payload = json.loads(snapshot.read_text(encoding="utf-8"))
    assert payload["format"] == "aetheris-corpus-snapshot/v1"
    # The split must round-trip, not just the text: an experiment has to train on
    # exactly the files this run did, on the same side.
    assert payload["manifestDigest"] == report.corpus["manifestDigest"]
    assert payload["train"] and payload["validation"]

    # And the reader must agree with the file, or the snapshot is decorative.
    from fabric.lm.train import load_corpus_snapshot

    train_text, validation_text, manifest = load_corpus_snapshot(snapshot)
    assert (train_text, validation_text) == (payload["train"], payload["validation"])
    assert manifest["digest"] == report.corpus["manifestDigest"]
    # The file counts must survive the round trip: they are what an experiment reports,
    # and counting newlines instead of files would produce a believable wrong number.
    assert len(manifest["train"]) == report.corpus["trainFiles"]
    assert len(manifest["validation"]) == report.corpus["validationFiles"]


def test_a_digest_only_corpus_record_carries_no_text_and_says_so(corpus, tmp_path):
    """A 168 MB corpus cannot be copied into its own run record, and a record that claimed to
    hold it while holding nothing would be worse than one that admits it holds a manifest."""
    report = train(small_config(), output_dir=tmp_path, corpus_root=corpus, run_name="r",
                   snapshot_text=False)
    record = Path(report.artifact["path"]).parent / report.artifact["corpusSnapshot"]
    assert record.exists()
    assert record.name.endswith(".manifest.json")
    assert report.artifact["corpusSnapshotFormat"] == "aetheris-corpus-manifest/v1"

    payload = json.loads(record.read_text(encoding="utf-8"))
    assert "train" not in payload and "validation" not in payload
    assert payload["manifestDigest"] == report.corpus["manifestDigest"]
    # The manifest itself still names every file, so the corpus is identified rather than lost.
    assert len(payload["manifest"]["train"]) == report.corpus["trainFiles"]
    assert all(len(entry["sha256"]) == 64 for entry in payload["manifest"]["train"])

    from fabric.lm.train import load_corpus_snapshot

    with pytest.raises(ValueError, match="by digest, not by copy"):
        load_corpus_snapshot(record)


def test_a_full_snapshot_says_which_format_it_wrote(corpus, tmp_path):
    """The report has to name the record it kept, so a reader is never left guessing whether
    the text is here or has to be re-assembled."""
    report = train(small_config(), output_dir=tmp_path, corpus_root=corpus, run_name="r")
    assert report.artifact["corpusSnapshotFormat"] == "aetheris-corpus-snapshot/v1"
    assert report.artifact["corpusSnapshot"].endswith(".corpus.json")


# ---------------------------------------------------------------------------
# Checkpoints and resuming
# ---------------------------------------------------------------------------


def test_a_resumed_run_is_the_same_run_it_would_have_been(corpus, tmp_path):
    """The only assertion that matters for a resume: the result must be identical, not close.

    Adam's moment estimates and step counter, the loss curve and the seeded data stream all have
    to survive the interruption. Drop any one of them and the run still finishes and still reports
    a falling loss -- it just trains a different model than the command describes.

    The interruption is a real one: a second process trains with checkpointing and is killed, so
    what the parent resumes from is the file a killed process actually leaves behind. A run that
    is allowed to finish deletes that file, and it should: a leftover checkpoint beside a release
    is a state somebody will eventually try to load as the release.
    """
    straight = tmp_path / "straight"
    interrupted = tmp_path / "interrupted"
    interrupted.mkdir()
    base = dict(d_model=32, n_layers=2, n_heads=2, d_ff=64, seq_len=32, batch_size=4,
                steps=12, warmup_steps=3, learning_rate=3e-2)

    whole = train(TrainConfig(**base), output_dir=straight, corpus_root=corpus, run_name="r")

    # A child process does the steps nobody finishes.
    child = subprocess.Popen(
        [sys.executable, "-c", _INTERRUPTIBLE_LEG,
         str(corpus), str(interrupted), json.dumps(base)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    saved = interrupted / "r.ckpt.npz"
    deadline = time.time() + 60
    meta = None
    while time.time() < deadline and meta is None:
        time.sleep(0.05)
        produced = sorted(interrupted.glob("*.ckpt.npz"))
        if not produced:
            continue
        for candidate in produced:
            # Copy first, then read the copy, and let the copy be the authority on which step was
            # interrupted. Reading the original and *then* copying it is a race the test lost in CI:
            # the child saved step 6 between the two calls, so the bytes were step 6 while the
            # metadata read step 5, and the resumed leg was then accused of resuming from the wrong
            # place. Copying a file that is replaced by an atomic rename cannot tear, and if the
            # copy does turn out unreadable the loop simply waits for the next checkpoint.
            saved.write_bytes(candidate.read_bytes())
            try:
                candidate_meta, _ = read_checkpoint(saved)
            except (OSError, ValueError, KeyError, EOFError, zipfile.BadZipFile):
                continue
            if candidate_meta["step"] >= 2:
                meta = candidate_meta
                break
    child.kill()
    child.wait(timeout=30)

    assert meta is not None, f"the child never wrote a readable checkpoint; output:\n{child.stdout.read()}"
    assert 0 < meta["step"] < base["steps"], f"the interruption landed at step {meta['step']}"

    second = train(TrainConfig(**base), output_dir=interrupted, corpus_root=corpus, run_name="r",
                   resume_from=saved, overwrite=True)

    assert second.provenance["resumedFrom"] == {"checkpoint": saved.name, "step": meta["step"]}
    assert [entry["step"] for entry in second.loss_curve] == list(range(base["steps"]))
    for a, b in zip(whole.loss_curve, second.loss_curve):
        assert a["loss"] == pytest.approx(b["loss"], rel=0, abs=0), "the loss curve must be identical"
    assert second.artifact["weightsDigest"] == whole.artifact["weightsDigest"], "different weights"
    # A resumed run's wall clock is the sum of its legs, not the age of the last one.
    assert second.resource["wallSeconds"] >= 0
    assert second.resource["trainingSeconds"] <= second.resource["wallSeconds"]
    assert second.checkpoints is None, "checkpointing was off for the second leg"


def test_resuming_under_another_configuration_is_refused(corpus, tmp_path):
    """Weights from one configuration loaded into another train happily at the wrong shape and
    report a number for a model that was never trained. Shape agreement is not agreement."""
    first = train(TrainConfig(d_model=16, n_layers=1, n_heads=2, d_ff=32, seq_len=12, batch_size=4,
                              learning_rate=1e-2, warmup_steps=2, steps=6),
                  output_dir=tmp_path, corpus_root=corpus, run_name="r", checkpoint_every=3,
                  keep_checkpoint=True)
    checkpoint = tmp_path / first.checkpoints["path"]

    with pytest.raises(RuntimeError, match="different configuration"):
        train(TrainConfig(d_model=16, n_layers=1, n_heads=2, d_ff=32, seq_len=12, batch_size=4,
                          learning_rate=1e-2, warmup_steps=2, steps=6, model_seed=7),
              output_dir=tmp_path, corpus_root=corpus, run_name="r", resume_from=checkpoint)


def test_a_finished_checkpoint_has_nothing_to_continue(corpus, tmp_path):
    first = train(TrainConfig(d_model=16, n_layers=1, n_heads=2, d_ff=32, seq_len=12, batch_size=4,
                              learning_rate=1e-2, warmup_steps=2, steps=6),
                  output_dir=tmp_path, corpus_root=corpus, run_name="r", checkpoint_every=3,
                  keep_checkpoint=True)
    checkpoint = tmp_path / first.checkpoints["path"]
    with pytest.raises(RuntimeError, match="nothing to continue"):
        train(TrainConfig(d_model=16, n_layers=1, n_heads=2, d_ff=32, seq_len=12, batch_size=4,
                          learning_rate=1e-2, warmup_steps=2, steps=6),
              output_dir=tmp_path, corpus_root=corpus, run_name="r", resume_from=checkpoint,
              overwrite=True)


def test_a_run_without_checkpointing_records_no_checkpoint(corpus, tmp_path):
    """None, not an empty dict: a run that never wrote a checkpoint and a run that wrote fourteen
    are different records, and the report has to distinguish them."""
    report = train(small_config(), output_dir=tmp_path, corpus_root=corpus, run_name="r")
    assert report.checkpoints is None
    assert report.provenance["resumedFrom"] is None


def test_a_completed_run_does_not_leave_its_checkpoint_behind(corpus, tmp_path):
    report = train(TrainConfig(d_model=16, n_layers=1, n_heads=2, d_ff=32, seq_len=12, batch_size=4,
                               learning_rate=1e-2, warmup_steps=2, steps=6),
                   output_dir=tmp_path, corpus_root=corpus, run_name="r", checkpoint_every=3)
    assert report.checkpoints["retained"] is False
    assert not (tmp_path / report.checkpoints["path"]).exists()


def test_an_expected_manifest_digest_that_does_not_match_is_refused(corpus, tmp_path):
    """Silent drift is the failure this prevents: a reproduction run that quietly
    trains a different model and reports success."""
    with pytest.raises(RuntimeError, match="corpus drift"):
        train(
            small_config(), output_dir=tmp_path, corpus_root=corpus, run_name="r",
            expect_manifest_digest="0" * 64,
        )


def test_the_matching_manifest_digest_is_accepted(corpus, tmp_path):
    """The guard must not be a blanket refusal; the right digest has to pass."""
    from fabric.lm.data import build_manifest

    digest = build_manifest(corpus).digest
    report = train(
        small_config(), output_dir=tmp_path, corpus_root=corpus, run_name="r",
        expect_manifest_digest=digest,
    )
    assert report.artifact["weightsDigest"]
    assert report.corpus["manifestDigest"] == digest


def test_the_revision_is_read_beside_the_corpus_not_after_training(corpus, tmp_path, monkeypatch):
    """A revision read at the end describes a tree the run may never have seen.

    The corpus is the working tree's own text, so the pair (revision, corpus digest) is
    the whole reproducibility claim: "check out this revision and you get this corpus".
    Reading the revision when the report is written -- after 12 steps here, after 35
    minutes on the release configuration -- makes that pair unverifiable, because the
    tree can be edited in between and the report still looks consistent.
    """
    import fabric.lm.train as train_module

    seen = []

    def spy(root):
        seen.append(str(root))
        return "revision-read-at-the-start"

    monkeypatch.setattr(train_module, "code_revision", spy)
    report = train(small_config(), output_dir=tmp_path, corpus_root=corpus, run_name="r")
    assert report.provenance["codeRevision"] == "revision-read-at-the-start"
    assert len(seen) == 1, f"the revision must be read exactly once, saw {len(seen)} reads"


def test_the_report_digest_ignores_where_the_artifact_was_written(corpus, tmp_path):
    """Same run in two directories is the same run."""
    a = train(small_config(), output_dir=tmp_path / "a", corpus_root=corpus, run_name="r")
    b = train(small_config(), output_dir=tmp_path / "b", corpus_root=corpus, run_name="r")
    assert a.digest == b.digest


# ---------------------------------------------------------------------------
# Evaluation held out by source
# ---------------------------------------------------------------------------


def test_a_held_out_source_is_recorded_and_never_trained_on(tmp_path):
    """The validation text must come from a source the training text does not contain.

    Checked end to end rather than on the manifest alone: the snapshot written beside the
    artifact holds both texts, so the claim "the model was evaluated on a source it never
    read" is verifiable from the run's own record instead of from the split code.
    """
    root = tmp_path / "corpus"
    (root / "trained").mkdir(parents=True)
    (root / "unseen").mkdir(parents=True)
    for i in range(4):
        (root / "trained" / f"t{i}.mjs").write_text("const alpha = 'TRAINONLY';\n" * (4 + i), encoding="utf-8")
    for i in range(2):
        (root / "unseen" / f"u{i}.mjs").write_text("const beta = 'HOLDOUTONLY';\n" * (4 + i), encoding="utf-8")

    report = train(
        small_config(steps=4, warmup_steps=1, validation_sources=("unseen",)),
        output_dir=tmp_path / "out", corpus_root=root, run_name="held-out",
    )
    assert report.corpus["heldOutSources"] == ["unseen"]
    assert {Path(f["path"]).parts[0] for f in report.corpus["validation"]} == {"unseen"}
    assert {Path(f["path"]).parts[0] for f in report.corpus["train"]} == {"trained"}
    assert report.corpus["sources"]["unseen"]["splits"] == ["validation"]

    snapshot = json.loads(
        (Path(report.artifact["path"]).parent / report.artifact["corpusSnapshot"]).read_text(encoding="utf-8")
    )
    # The file paths themselves contain the source name, so the assertion is on content that
    # only one side's text can contain.
    assert "HOLDOUTONLY" in snapshot["validation"] and "TRAINONLY" not in snapshot["validation"]
    assert "TRAINONLY" in snapshot["train"] and "HOLDOUTONLY" not in snapshot["train"]


def test_a_source_that_does_not_exist_in_the_corpus_stops_the_run(tmp_path):
    root = tmp_path / "corpus"
    root.mkdir()
    (root / "a").mkdir()
    (root / "a" / "x.mjs").write_text("const a = 1;\n", encoding="utf-8")
    (root / "b").mkdir()
    (root / "b" / "y.mjs").write_text("const b = 2;\n", encoding="utf-8")
    with pytest.raises(ValueError, match="not under the corpus root"):
        train(small_config(steps=4, warmup_steps=1, validation_sources=("typo",)),
              output_dir=tmp_path / "out", corpus_root=root, run_name="refused")
