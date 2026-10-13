"""The distillation experiment's own machinery: reading the teacher, and the verdict.

Two things here can go wrong quietly, and both did during development.

The first is the teacher's architecture. A checkpoint stores parameters, not a
configuration, so `n_heads` cannot be recovered from it at all -- and loading a model
with the wrong head count does not raise. It produces a forward pass that is simply
not the model that was trained, and the experiment would then measure "does distilling
from a slightly wrong teacher help", while reporting it as distillation.

The second is the verdict. A mean improvement is not evidence on its own: one seed
with a large gain and two with small losses gives a positive mean and no replication.
The verdict function is where that distinction is enforced, so it is tested on inputs
where the answer is not the sign of the mean.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from distill_experiment import read_teacher_config, summarise, verdict_for  # noqa: E402

from fabric.lm.model import TransformerConfig, TransformerLM  # noqa: E402


@pytest.fixture
def teacher(tmp_path):
    config = TransformerConfig(vocab_size=48, d_model=32, n_layers=2, n_heads=4, d_ff=96, seq_len=48)
    path = tmp_path / "teacher.npz"
    TransformerLM(config, seed=3).save(path)
    return path, config


def test_the_head_count_is_read_from_the_checkpoint_shapes_that_can_supply_it(teacher):
    path, config = teacher
    recovered, source = read_teacher_config(path, override_heads=4)
    assert recovered.n_heads == 4
    # Everything else is genuinely derivable from shapes, so it must be derived.
    assert (recovered.vocab_size, recovered.d_model, recovered.n_layers, recovered.d_ff,
            recovered.seq_len) == (config.vocab_size, config.d_model, config.n_layers,
                                   config.d_ff, config.seq_len)
    assert source == "shapes in the checkpoint"


def test_a_missing_head_count_is_refused_rather_than_guessed(teacher):
    """The original version defaulted to 4. That is a guess that changes the teacher."""
    path, _ = teacher
    with pytest.raises(SystemExit, match="head count"):
        read_teacher_config(path, None)


def test_the_run_report_supplies_the_head_count(teacher):
    path, config = teacher
    (path.parent / "run.report.json").write_text(
        json.dumps({"model_config": config.to_dict()}), encoding="utf-8"
    )
    recovered, source = read_teacher_config(path, None)
    assert recovered.n_heads == config.n_heads
    assert "run report" in source


def test_the_report_is_checked_against_the_checkpoint(teacher):
    """A report left beside the wrong checkpoint must not be treated as authoritative."""
    path, config = teacher
    mismatched = config.to_dict()
    mismatched["n_layers"] = 9
    (path.parent / "run.report.json").write_text(
        json.dumps({"model_config": mismatched}), encoding="utf-8"
    )
    with pytest.raises(RuntimeError, match="disagree on n_layers"):
        read_teacher_config(path, None)


def test_a_report_for_a_different_model_is_ignored_not_obeyed(teacher):
    """Reports are matched by vocabulary and width; a foreign one is skipped."""
    path, config = teacher
    other = config.to_dict()
    other["vocab_size"] = 999
    other["d_model"] = 111
    other["n_heads"] = 16
    (path.parent / "unrelated.report.json").write_text(
        json.dumps({"model_config": other}), encoding="utf-8"
    )
    with pytest.raises(SystemExit, match="head count"):
        read_teacher_config(path, None)


def test_a_checkpoint_without_layers_is_rejected(tmp_path):
    path = tmp_path / "not-a-checkpoint.npz"
    np.savez(path, emb=np.zeros((8, 8)), pos=np.zeros((4, 8)))
    with pytest.raises(KeyError, match="layer-1 projections"):
        read_teacher_config(path, override_heads=2)


# --- the verdict -----------------------------------------------------------------


def test_a_replicated_gain_is_accepted():
    summary = summarise([(0, 4.00, 3.80), (1, 4.10, 3.70), (2, 4.20, 3.75)])
    verdict, rationale = verdict_for(summary)
    assert verdict == "accept"
    assert summary["improvedOnEverySeed"] is True
    assert summary["gainExceedsSeedSpread"] is True


def test_a_mean_gain_that_one_seed_carried_is_not_an_improvement():
    """The mean is positive; two of three seeds got worse. That is not replication."""
    summary = summarise([(0, 4.0, 3.0), (1, 4.0, 4.1), (2, 4.0, 4.1)])
    verdict, _ = verdict_for(summary)
    assert summary["meanGain"] > 0, "the fixture must actually have a positive mean"
    assert verdict == "inconclusive"
    assert summary["improvedOnEverySeed"] is False


def test_a_consistent_but_tiny_gain_inside_seed_spread_is_inconclusive():
    """Better at every seed, but the spread across seeds is wider than the effect."""
    summary = summarise([(0, 3.999, 3.998), (1, 4.0, 3.98), (2, 4.0, 3.94)])
    assert summary["improvedOnEverySeed"] is True
    assert summary["gainExceedsSeedSpread"] is False
    assert verdict_for(summary)[0] == "inconclusive"


def test_consistent_harm_is_rejected():
    summary = summarise([(0, 4.0, 4.5), (1, 4.0, 4.4), (2, 4.0, 4.6)])
    verdict, rationale = verdict_for(summary)
    assert verdict == "reject"
    assert summary["reversedOnEverySeed"] is True
    assert "every one of 3 seeds" in rationale


def test_rejecting_also_requires_clearing_the_noise():
    """Symmetric with accept: consistent harm inside the spread is not a rejection."""
    summary = summarise([(0, 4.0, 4.001), (1, 4.0, 4.02), (2, 4.0, 4.005)])
    verdict, rationale = verdict_for(summary)
    assert summary["gainExceedsSeedSpread"] is False
    assert verdict == "inconclusive"
    assert "spread" in rationale


def test_a_single_seed_cannot_decide_anything():
    summary = summarise([(0, 4.0, 3.0)])
    verdict, rationale = verdict_for(summary)
    assert verdict == "inconclusive"
    assert "single seed" in rationale


def test_an_exact_tie_is_inconclusive_not_a_tie_break():
    summary = summarise([(0, 4.0, 4.0), (1, 4.0, 4.0)])
    assert summary["seedsImproved"] == 0 and summary["seedsReversed"] == 0
    assert verdict_for(summary)[0] == "inconclusive"


def test_the_summary_is_computed_from_the_pairs_not_asserted():
    """Change one number and both the mean and the verdict move together."""
    summary = summarise([(0, 4.0, 3.0), (1, 4.0, 3.0)])
    assert summary["meanGain"] == pytest.approx(1.0)
    assert summary["gainsNatsPerToken"] == [1.0, 1.0]
    assert verdict_for(summary)[0] == "accept"


# --- the script itself ------------------------------------------------------------


def test_the_experiment_runs_end_to_end_and_reports_both_arms(tmp_path, capsys):
    """The only test that executes main().

    It is here because every other test in this file calls a function, and the script's
    own argument handling and wiring is where the mistakes were: the first version
    guessed the teacher's head count, and the second crashed on a variable left behind
    by a refactor. Neither was reachable from a unit test of `summarise`.
    """
    from fabric.lm.model import TransformerConfig
    from distill_experiment import main

    root = tmp_path / "corpus"
    root.mkdir()
    body = "export function alpha(input) {\n  return input.map((v) => v + 1);\n}\n\n"
    for i in range(8):
        (root / f"f{i}.mjs").write_text(body * (2 + i % 3), encoding="utf-8")

    # A teacher's vocabulary is the character set of the text it saw; a fixture that
    # invents one is refused by the experiment, which is the point of the check.
    from fabric.lm.data import build_manifest, read_corpus
    from fabric.lm.tokenizer import CharacterTokenizer

    manifest = build_manifest(root)
    vocab = CharacterTokenizer.fit([read_corpus(root, manifest.train)]).size

    teacher_config = TransformerConfig(vocab_size=vocab, d_model=16, n_layers=1, n_heads=2, d_ff=32, seq_len=16)
    teacher_path = tmp_path / "tiny-teacher.npz"
    TransformerLM(teacher_config, seed=9).save(teacher_path)
    (tmp_path / "tiny.report.json").write_text(
        json.dumps({"model_config": teacher_config.to_dict()}), encoding="utf-8"
    )
    verdict_path = tmp_path / "verdict.json"

    code = main([
        "--teacher", str(teacher_path),
        "--corpus-root", str(root),
        "--steps", "2", "--seeds", "1", "--warmup-steps", "1",
        "--d-model", "16", "--n-layers", "1", "--n-heads", "2", "--d-ff", "32",
        "--seq-len", "16", "--batch-size", "4",
        "--json", str(verdict_path), "--quiet",
    ])
    assert code == 0, capsys.readouterr().out

    payload = json.loads(verdict_path.read_text(encoding="utf-8"))
    assert [run["arm"] for run in payload["runs"]] == ["baseline", "distilled"]
    assert payload["runs"][0]["alpha"] == 1.0 and payload["runs"][1]["alpha"] == 0.5
    # The baseline must not pay for machinery it does not use.
    assert payload["runs"][0]["teacherForwards"] == 0
    assert payload["runs"][1]["teacherForwards"] > 0
    assert payload["verdict"] == "inconclusive" and payload["summary"]["seedCount"] == 1
    assert payload["teacherConfig"]["n_heads"] == 2, "the head count came from the report"


def test_the_experiment_prefers_a_snapshot_over_the_live_repository(tmp_path):
    """A snapshot pins the text; editing the repository afterwards must not change it."""
    from distill_experiment import main

    root = tmp_path / "corpus"
    root.mkdir()
    (root / "a.mjs").write_text("export const alpha = (x) => x + 1;\n" * 12, encoding="utf-8")
    (root / "b.mjs").write_text("export const beta = (x) => x - 1;\n" * 12, encoding="utf-8")

    from fabric.lm.data import build_manifest, read_corpus
    from fabric.lm.tokenizer import CharacterTokenizer

    manifest = build_manifest(root, validation_fraction=0.5, split_seed=1)
    train_text = read_corpus(root, manifest.train)
    validation_text = read_corpus(root, manifest.validation)
    vocab = CharacterTokenizer.fit([train_text]).size

    snapshot = tmp_path / "run.corpus.json"
    snapshot.write_text(json.dumps({
        "format": "aetheris-corpus-snapshot/v1",
        "manifest": manifest.to_dict(), "manifestDigest": manifest.digest,
        "train": train_text, "validation": validation_text,
    }), encoding="utf-8")

    teacher_config = TransformerConfig(vocab_size=vocab, d_model=16, n_layers=1, n_heads=2, d_ff=32, seq_len=16)
    teacher_path = tmp_path / "teacher.npz"
    TransformerLM(teacher_config, seed=2).save(teacher_path)
    (tmp_path / "teacher.report.json").write_text(
        json.dumps({"model_config": teacher_config.to_dict()}), encoding="utf-8"
    )
    verdict_path = tmp_path / "verdict.json"

    # The live corpus is then moved out from under the run: only the snapshot remains.
    for path in (root / "a.mjs", root / "b.mjs"):
        path.unlink()

    code = main([
        "--teacher", str(teacher_path), "--corpus-snapshot", str(snapshot),
        "--steps", "2", "--seeds", "1", "--warmup-steps", "1",
        "--d-model", "16", "--n-layers", "1", "--n-heads", "2", "--d-ff", "32",
        "--seq-len", "16", "--batch-size", "4", "--json", str(verdict_path), "--quiet",
    ])
    assert code == 0
    payload = json.loads(verdict_path.read_text(encoding="utf-8"))
    assert payload["corpus"]["manifestDigest"] == manifest.digest
    assert payload["corpus"]["snapshot"] == str(snapshot)
    assert payload["corpus"]["trainTokens"] > 0
