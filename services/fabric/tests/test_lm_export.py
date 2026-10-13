"""Exporting a checkpoint: the manifest must describe the bytes next to it.

Two things are checked here that nothing else in the suite can check. First, the
vocabulary digest formula is verified against the JavaScript implementation that consumes
it, because a formula that exists twice and is only tested once is a formula that will
disagree. Second, the export refuses a checkpoint that does not match its report -- the
failure it exists to prevent is a manifest describing weights it was not computed from,
which no loader can detect after the fact.
"""

from __future__ import annotations

import base64
import hashlib
import json
import shutil
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from fabric.lm.export import (
    ARTIFACT_FORMAT,
    PARITY_CORPUS,
    architecture_block,
    build_manifest,
    export_artifact,
    parity_fixture,
    vocabulary_digest,
    write_json,
)
from fabric.lm.evaluate import generate
from fabric.lm.model import TransformerConfig, TransformerLM
from fabric.lm.tokenizer import CharacterTokenizer

REPO = Path(__file__).resolve().parents[3]
FORMAT_MJS = REPO / "services/core/src/klyvaron/format.mjs"
CORE_FIXTURE = REPO / "services/core/test/fixtures/klyvaron-lite-parity.json"

node = shutil.which("node")


def tiny_config(tokenizer: CharacterTokenizer) -> TransformerConfig:
    return TransformerConfig(vocab_size=tokenizer.size, d_model=16, n_layers=1, n_heads=2, d_ff=32, seq_len=16)


def tiny_run(tmp_path: Path):
    """A complete, tiny training run's outputs: checkpoint, snapshot and report."""
    tokenizer = CharacterTokenizer.fit([PARITY_CORPUS])
    config = tiny_config(tokenizer)
    model = TransformerLM(config, seed=3)
    checkpoint = tmp_path / "tiny.npz"
    model.save(checkpoint)
    snapshot = tmp_path / "tiny.corpus.json"
    snapshot.write_text(json.dumps({
        "format": "aetheris-corpus-snapshot/v1",
        "manifest": {"root": "/tmp/tiny", "trainFiles": 1, "validationFiles": 0},
        "manifestDigest": "0" * 64,
        "train": PARITY_CORPUS,
        "validation": PARITY_CORPUS[:64],
    }), encoding="utf-8")
    from fabric.lm.model import weights_digest

    report = {
        "model_config": config.to_dict(),
        "tokenizer": {"size": tokenizer.size, "vocabularyDigest": tokenizer.digest, "characters": len(tokenizer.characters)},
        "corpus": {"manifestDigest": "0" * 64, "trainCharacters": len(PARITY_CORPUS), "validationCharacters": 64, "trainTokens": len(PARITY_CORPUS), "validationTokens": 64},
        "provenance": {
            "codeRevision": "test", "python": sys.version.split()[0], "numpy": np.__version__,
            "platform": "test", "seed": {"model": 3, "data": 0, "split": 1}, "parameterCount": model.parameter_count,
        },
        "evaluation": {"perplexity": 30.0, "bitsPerCharacter": 4.9, "tokensEvaluated": 64,
                       "baselines": [{"name": "bigram", "perplexity": 28.0}, {"name": "uniform", "perplexity": 30.0}]},
        "artifact": {"filename": checkpoint.name, "weightsDigest": weights_digest(model.params)},
    }
    return tokenizer, config, model, checkpoint, snapshot, report


def test_the_vocabulary_digest_matches_the_javascript_implementation(tmp_path):
    """One specification, two languages. The JavaScript side is the consumer, so it is
    the one that decides whether an exported artifact loads at all."""
    characters = list("Aetheris Klyvaron\n\t\"\\\u00e9\U0001f600")
    python_digest = vocabulary_digest(characters)
    assert python_digest == vocabulary_digest(characters), "the digest must be stable"
    assert vocabulary_digest(characters[:-1]) != python_digest, "every character must matter"

    if not node:
        pytest.skip("node is not installed; the cross-language check needs it")
    script = (
        f"import {{ vocabularyDigest, TOKENIZER_FORMAT }} from {json.dumps(str(FORMAT_MJS))};"
        f"process.stdout.write(TOKENIZER_FORMAT + '\\n' + vocabularyDigest({json.dumps(characters)}));"
    )
    result = subprocess.run([node, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    tokenizer_format, javascript_digest = result.stdout.split("\n", 1)
    assert tokenizer_format == "klyvaron.tokenizer.character/1"
    assert javascript_digest == python_digest, "services/core would reject every artifact this module exports"


def test_a_base_model_must_declare_that_it_does_not_follow_instructions():
    tokenizer = CharacterTokenizer.fit([PARITY_CORPUS])
    config = tiny_config(tokenizer)
    with pytest.raises(ValueError, match="does not follow instructions"):
        build_manifest(
            config=config, tokenizer=tokenizer, weights_file="w.npz", weights_bytes=b"x",
            weights_names=[], artifact_id="x", version="0.1.0",
            limitations=["It is small."],
        )
    with pytest.raises(ValueError, match="at least one limitation"):
        build_manifest(
            config=config, tokenizer=tokenizer, weights_file="w.npz", weights_bytes=b"x",
            weights_names=[], artifact_id="x", version="0.1.0", limitations=[],
        )


def test_the_parity_fixture_is_deterministic_and_internally_consistent(tmp_path):
    fixture = parity_fixture(config=TransformerConfig(vocab_size=64, d_model=24, n_layers=1, n_heads=4, d_ff=48, seq_len=32))
    again = parity_fixture(config=TransformerConfig(vocab_size=64, d_model=24, n_layers=1, n_heads=4, d_ff=48, seq_len=32))
    assert write_json(tmp_path / "a.json", fixture) == write_json(tmp_path / "b.json", again)

    manifest = fixture["manifest"]
    assert manifest["format"] == ARTIFACT_FORMAT
    assert manifest["instructionTuned"] is False
    assert manifest["weights"]["names"] == sorted(fixture["weights"].keys())
    assert manifest["weights"]["bytes"] == len(base64.b64decode(fixture["npzBase64"]))
    assert manifest["weights"]["sha256"] == hashlib.sha256(base64.b64decode(fixture["npzBase64"])).hexdigest()

    # The archive and the encoded arrays must be the same numbers: a fixture whose two
    # halves disagree would let a wrong implementation pass.
    archive = tmp_path / "parity.npz"
    archive.write_bytes(base64.b64decode(fixture["npzBase64"]))
    with np.load(archive) as loaded:
        for name, entry in fixture["weights"].items():
            expected = np.frombuffer(base64.b64decode(entry["base64"]), dtype="<f4").reshape(entry["shape"])
            assert np.array_equal(loaded[name], expected), f"{name} differs between the archive and the encoded weights"

    # And the greedy continuation is reproducible from those weights alone.
    config = TransformerConfig(**manifest["architecture"])
    model = TransformerLM.load(archive, config)
    tokenizer = CharacterTokenizer.from_dict(manifest["tokenizer"])
    for greedy in fixture["greedy"]:
        assert generate(model, tokenizer, greedy["prompt"], max_new_tokens=greedy["maxNewTokens"], temperature=0.0, seed=0) == greedy["text"]

    # The recorded top gap is what makes the JavaScript comparison meaningful rather than
    # lucky; a tie within the tolerance would need a different fixture model.
    for case in fixture["cases"]:
        assert case["topGap"] > 1e-2, "the fixture model has a near-tie; regenerate it with a different seed"


def _describe_npz_difference(left_b64: str, right_b64: str) -> str:
    """One line saying *how* two .npz payloads differ, for a fixture that drifted.

    A byte comparison answers "yes/no"; the question that follows is always "which array
    changed", and on a machine you do not have access to, the answer has to come out of the
    failure message itself. Here it is: container lengths, member names, and for each member
    whether the arrays are equal, their dtype and shape, and the largest absolute difference.
    When every array is identical the containers still differ, so the ZIP metadata is compared
    field by field and the first differing byte offset is named.
    """
    import io
    import zipfile

    left, right = base64.b64decode(left_b64), base64.b64decode(right_b64)
    parts = [f"npz {len(left)} vs {len(right)} bytes; python {sys.version.split()[0]}, numpy {np.__version__}"]
    try:
        with zipfile.ZipFile(io.BytesIO(left)) as za, zipfile.ZipFile(io.BytesIO(right)) as zb:
            if za.namelist() != zb.namelist():
                parts.append(f"members differ: {za.namelist()} vs {zb.namelist()}")
            else:
                for name in za.namelist():
                    a = np.load(io.BytesIO(za.read(name)))
                    b = np.load(io.BytesIO(zb.read(name)))
                    if a.shape != b.shape or a.dtype != b.dtype:
                        parts.append(f"{name}: {a.dtype}{a.shape} vs {b.dtype}{b.shape}")
                    elif not np.array_equal(a, b):
                        delta = float(np.abs(a.astype(np.float64) - b.astype(np.float64)).max())
                        parts.append(f"{name}: same shape {a.shape}, max abs delta {delta:.3e}")
                if len(parts) == 1:
                    for name in za.namelist():
                        ia, ib = za.getinfo(name), zb.getinfo(name)
                        if (ia.compress_type, ia.date_time, ia.create_system, ia.external_attr) != (
                            ib.compress_type, ib.date_time, ib.create_system, ib.external_attr
                        ):
                            parts.append(
                                f"{name}: zip metadata differs -- compress {ia.compress_type}/{ib.compress_type}, "
                                f"date_time {ia.date_time}/{ib.date_time}, create_system {ia.create_system}/{ib.create_system}"
                            )
    except Exception as exc:  # noqa: BLE001 - a difference in the container itself, reported as one
        parts.append(f"not both readable as zip: {type(exc).__name__}: {exc}")
    if len(parts) == 1:
        offset = next((i for i, (x, y) in enumerate(zip(left, right)) if x != y), min(len(left), len(right)))
        parts.append(
            f"no member differs; first differing byte at offset {offset}: "
            f"{left[offset:offset + 16].hex()} vs {right[offset:offset + 16].hex()}"
        )
    return "; ".join(parts)


def test_the_committed_core_fixture_is_regenerable(tmp_path):
    """The fixture services/core tests against is the one this code produces."""
    committed = json.loads(CORE_FIXTURE.read_text(encoding="utf-8"))
    regenerated = parity_fixture(config=TransformerConfig(vocab_size=64, d_model=24, n_layers=1, n_heads=4, d_ff=48, seq_len=32))
    assert committed["manifest"]["tokenizer"]["digest"] == regenerated["manifest"]["tokenizer"]["digest"]
    assert committed["npzBase64"] == regenerated["npzBase64"], (
        "the committed fixture no longer matches the exporter; regenerate it with "
        "python services/fabric/scripts/export_lm.py --parity-fixture "
        "services/core/test/fixtures/klyvaron-lite-parity.json -- "
        + _describe_npz_difference(committed["npzBase64"], regenerated["npzBase64"])
    )


def test_export_writes_a_manifest_that_describes_the_bytes_next_to_it(tmp_path):
    tokenizer, config, model, checkpoint, snapshot, report = tiny_run(tmp_path)
    output = tmp_path / "artifact"
    result = export_artifact(
        report=report, artifact_path=checkpoint, corpus_snapshot=snapshot, output_dir=output,
        artifact_id="tiny-lm", version="0.0.1", limitations=["It is tiny.", "It does not follow instructions."],
        report_path=snapshot, benchmarks=[{"name": "none", "protocol": "none", "result": "none"}],
    )
    manifest = result["manifest"]
    weights_path = Path(result["weightsPath"])
    assert weights_path.name == "tiny-lm-0.0.1.npz"
    assert manifest["weights"]["bytes"] == weights_path.stat().st_size
    assert manifest["weights"]["sha256"] == hashlib.sha256(weights_path.read_bytes()).hexdigest()
    assert manifest["tokenizer"]["digest"] == vocabulary_digest(tokenizer.characters)
    assert manifest["tokenizer"]["characters"] == list(tokenizer.characters)
    assert manifest["architecture"] == architecture_block(config)
    assert manifest["provenance"]["weightsDigest"] == report["artifact"]["weightsDigest"]
    assert manifest["provenance"]["corpus"]["manifestDigest"] == "0" * 64
    assert manifest["provenance"]["trainingVocabularyDigest"] == tokenizer.digest
    assert manifest["limitations"] == ["It is tiny.", "It does not follow instructions."]
    assert json.loads(Path(result["manifestPath"]).read_text(encoding="utf-8")) == json.loads(
        json.dumps(manifest, ensure_ascii=False)
    )

    # The CLI's verifier agrees, and is what a build step would run.
    sys.path.insert(0, str(REPO / "services/fabric/scripts"))
    from export_lm import main as export_main

    assert export_main(["--verify", str(output), "--quiet"]) == 0


def test_export_refuses_a_checkpoint_from_a_different_run(tmp_path):
    _tokenizer, _config, _model, checkpoint, snapshot, report = tiny_run(tmp_path)
    report = json.loads(json.dumps(report))
    report["artifact"]["weightsDigest"] = "f" * 64
    with pytest.raises(ValueError, match="different runs"):
        export_artifact(
            report=report, artifact_path=checkpoint, corpus_snapshot=snapshot, output_dir=tmp_path / "out",
            artifact_id="tiny-lm", version="0.0.1", limitations=["It does not follow instructions."],
        )


def test_export_refuses_a_snapshot_from_a_different_run(tmp_path):
    tokenizer, config, model, checkpoint, snapshot, report = tiny_run(tmp_path)
    other = CharacterTokenizer.fit(["completely different text with other characters 0123456789"])
    snapshot.write_text(json.dumps({
        "format": "aetheris-corpus-snapshot/v1", "manifest": {}, "manifestDigest": "0" * 64,
        "train": "".join(other.characters), "validation": "",
    }), encoding="utf-8")
    with pytest.raises(ValueError, match="tokenizer digest"):
        export_artifact(
            report=report, artifact_path=checkpoint, corpus_snapshot=snapshot, output_dir=tmp_path / "out",
            artifact_id="tiny-lm", version="0.0.1", limitations=["It does not follow instructions."],
        )
