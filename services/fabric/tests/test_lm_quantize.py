"""Relative quality gates, compact artifacts and reproducible CPU parity (not a release)."""
import base64
import copy
import hashlib
import json
import io
from pathlib import Path
import subprocess
import sys

import numpy as np
import pytest

from fabric.lm.quantize import (INT8_SCHEME, compare_models, load_source, load_quantized_reference,
                               quantize_artifact, quantize_parameters)

REPO = Path(__file__).resolve().parents[3]
FIXTURE = json.loads((REPO / "services/core/test/fixtures/klyvaron-lite-parity.json").read_text())
INT8 = json.loads((REPO / "services/core/test/fixtures/klyvaron-lite-int8-parity.json").read_text())
TEXT = "Aetheris Klyvaron " * 32


def source_at(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    manifest = copy.deepcopy(FIXTURE["manifest"])
    (source / "model.klyvaron.json").write_text(json.dumps(manifest))
    (source / manifest["weights"]["file"]).write_bytes(base64.b64decode(FIXTURE["npzBase64"]))
    return source


def convert(tmp_path, **overrides):
    args = dict(version="test-int8", validation_text=TEXT, max_nll_increase=0.02, max_disagreement=0.05)
    args.update(overrides)
    return quantize_artifact(source_at(tmp_path), tmp_path / "candidate", **args)


def test_int8_roundtrip_bounds_and_zero_tensor():
    params = {"weights": np.linspace(-0.8, 0.9, 200, dtype=np.float32).reshape(10, 20),
              "zero": np.zeros((2, 2), dtype=np.float32), "norm": np.ones(20, dtype=np.float32)}
    packed, reference = quantize_parameters(params)
    assert packed["weights"].dtype == np.int8
    assert packed["weights.scale"].dtype == np.float32
    assert np.max(np.abs(params["weights"] - reference["weights"])) <= packed["weights.scale"][0] / 2 + 1e-7
    assert packed["zero.scale"].tolist() == [1.0]
    assert np.array_equal(reference["zero"], params["zero"])
    assert np.array_equal(packed["norm"], params["norm"])
    assert packed["norm"] is not params["norm"]
    assert not np.any(packed["weights"] == -128)


def test_bad_dtype_nonfinite_and_underflow_are_not_silently_quantized():
    for value in [np.ones((2, 2), dtype=np.float64), np.full((2, 2), np.nan, dtype=np.float32),
                  np.full((2, 2), np.inf, dtype=np.float32), np.full((2, 2), np.nextafter(np.float32(0), np.float32(1)), dtype=np.float32)]:
        with pytest.raises(ValueError):
            quantize_parameters({"bad": value})


def test_conversion_preserves_identity_limitations_and_measures_savings(tmp_path):
    report = convert(tmp_path)
    assert report["status"] == "passed"
    assert report["metrics"]["tokensEvaluated"] == len(TEXT) - 1
    assert report["metrics"]["unknownRate"] == 0
    assert report["quantizedResidentWeightBytes"] < report["sourceResidentWeightBytes"] / 3
    assert report["quantizedWeightBytes"] < report["sourceWeightBytes"]
    manifest, _, _ = load_quantized_reference(tmp_path / "candidate")
    assert manifest["format"] == "klyvaron.artifact/2"
    assert manifest["weights"]["quantization"]["scheme"] == INT8_SCHEME
    assert manifest["id"] == FIXTURE["manifest"]["id"] + "-int8"
    assert manifest["instructionTuned"] is False
    assert manifest["licence"] == FIXTURE["manifest"]["licence"]
    assert manifest["provenance"]["quantizedFrom"]["weightsSha256"] == FIXTURE["manifest"]["weights"]["sha256"]
    assert manifest["limitations"][:len(FIXTURE["manifest"]["limitations"])] == FIXTURE["manifest"]["limitations"]
    assert manifest["benchmarks"][0]["report"] == report


def test_quality_failure_keeps_report_but_does_not_publish_model(tmp_path):
    report = convert(tmp_path, max_nll_increase=0.0, max_disagreement=0.0)
    assert report["status"] == "rejected"
    assert report["failures"]
    assert not (tmp_path / "candidate").exists()
    assert (tmp_path / "source").exists()


def test_unknown_rate_is_measured_and_gated(tmp_path):
    report = convert(tmp_path, validation_text="未知" * 30)
    assert report["metrics"]["unknownRate"] == 1
    assert report["status"] == "rejected"
    assert any("unknownRate" in failure for failure in report["failures"])


def test_bad_thresholds_and_empty_evaluation_are_refused(tmp_path):
    source = source_at(tmp_path)
    for settings in [{"max_nll_increase": float("nan")}, {"max_disagreement": 1.1},
                     {"max_unknown_rate": -1}, {"validation_text": ""}, {"max_tokens": 0}]:
        args = dict(version="test", validation_text=TEXT, max_nll_increase=0.02, max_disagreement=0.05)
        args.update(settings)
        with pytest.raises(ValueError):
            quantize_artifact(source, tmp_path / "candidate", **args)
    assert not (tmp_path / "candidate").exists()


def test_source_integrity_and_safe_paths_are_required(tmp_path):
    source = source_at(tmp_path)
    path = source / "model.klyvaron.json"
    for mutate in [lambda m: m["weights"].update(file="../outside.npz"),
                   lambda m: m["weights"].update(sha256="0" * 64),
                   lambda m: m["weights"].update(bytes=1),
                   lambda m: m["tokenizer"].update(digest="0" * 64),
                   lambda m: m.update(format="klyvaron.artifact/2")]:
        manifest = copy.deepcopy(FIXTURE["manifest"])
        mutate(manifest)
        path.write_text(json.dumps(manifest))
        with pytest.raises(ValueError):
            load_source(source)


def test_existing_outputs_are_never_replaced(tmp_path):
    source = source_at(tmp_path)
    output = tmp_path / "candidate"
    output.mkdir()
    (output / "keep").write_text("user data")
    with pytest.raises(ValueError, match="already exists"):
        quantize_artifact(source, output, version="1", validation_text=TEXT, max_nll_increase=0.1, max_disagreement=0.1)
    assert (output / "keep").read_text() == "user data"


def test_committed_fixture_matches_the_export_and_reference(tmp_path):
    report = convert(tmp_path)
    # NPZ ZIP64 framing can differ by Python/NumPy build; compare tensor bytes,
    # not container framing. Each report must still hash its own actual archive.
    candidate = next((tmp_path / "candidate").glob("*.npz"))
    assert hashlib.sha256(candidate.read_bytes()).hexdigest() == report["quantizedWeightsSha256"]
    committed = base64.b64decode(INT8["npzBase64"])
    assert hashlib.sha256(committed).hexdigest() == INT8["report"]["quantizedWeightsSha256"]
    with np.load(candidate, allow_pickle=False) as current, np.load(io.BytesIO(committed), allow_pickle=False) as previous:
        assert sorted(current.files) == sorted(previous.files)
        for name in current.files:
            assert current[name].dtype == previous[name].dtype
            np.testing.assert_array_equal(current[name], previous[name])
    assert report["metrics"]["nllIncrease"] == pytest.approx(INT8["report"]["metrics"]["nllIncrease"], abs=1e-6)
    _, model, tokenizer = load_quantized_reference(tmp_path / "candidate")
    for case in INT8["cases"]:
        logits = model.forward(tokenizer.encode(case["prompt"])[None, :])[0, -1]
        np.testing.assert_allclose(logits, case["logits"], atol=2e-5, rtol=1e-5)


def test_quantized_verifier_rejects_bad_scale_and_missing_members(tmp_path):
    convert(tmp_path)
    directory = tmp_path / "candidate"
    path = next(directory.glob("*.klyvaron.json"))
    manifest = json.loads(path.read_text())
    weights = directory / manifest["weights"]["file"]
    with np.load(weights, allow_pickle=False) as data:
        original = {name: data[name].copy() for name in data.files}
    for scale in [0, -1, float("nan"), 1e38]:
        arrays = dict(original)
        arrays["emb.scale"] = np.asarray([scale], dtype=np.float32)
        np.savez(weights, **arrays)
        manifest["weights"].update(bytes=weights.stat().st_size, sha256=hashlib.sha256(weights.read_bytes()).hexdigest())
        path.write_text(json.dumps(manifest))
        with pytest.raises(ValueError, match="scale"):
            load_quantized_reference(directory)
    original.pop("emb.scale")
    np.savez(weights, **original)
    manifest["weights"].update(bytes=weights.stat().st_size, sha256=hashlib.sha256(weights.read_bytes()).hexdigest())
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="members"):
        load_quantized_reference(directory)


def test_cli_records_refusals_and_existing_verifier_accepts_v2(tmp_path):
    source = source_at(tmp_path)
    text = tmp_path / "evaluation.txt"
    text.write_text(TEXT)
    script = REPO / "services/fabric/scripts/quantize_lm.py"
    for suffix, threshold, expected in [("rejected", "0", 1), ("passed", "0.02", 0)]:
        report = tmp_path / f"{suffix}.json"
        output = tmp_path / suffix
        result = subprocess.run([sys.executable, str(script), "--source", str(source), "--output", str(output),
            "--version", "test", "--validation-text", str(text), "--report", str(report),
            "--max-nll-increase", threshold, "--max-disagreement", "0.05"], capture_output=True, text=True)
        assert result.returncode == expected, result.stderr
        assert json.loads(report.read_text())["status"] == suffix
        assert output.exists() == (expected == 0)
    verified = subprocess.run([sys.executable, str(REPO / "services/fabric/scripts/export_lm.py"), "--verify", str(tmp_path / "passed")], capture_output=True, text=True)
    assert verified.returncode == 0, verified.stderr


def test_untied_output_matrix_is_quantized_too(tmp_path):
    from fabric.lm.model import TransformerLM, TransformerConfig
    from fabric.lm.export import build_manifest
    from fabric.lm.tokenizer import CharacterTokenizer
    tokenizer = CharacterTokenizer.fit([TEXT])
    model = TransformerLM(TransformerConfig(vocab_size=tokenizer.size, d_model=16, n_heads=2, n_layers=1, d_ff=32, seq_len=16, tie_embeddings=False), seed=9)
    source = tmp_path / "source"
    source.mkdir()
    model.save(source / "weights.npz")
    manifest = build_manifest(config=model.config, tokenizer=tokenizer, weights_file="weights.npz", weights_bytes=(source / "weights.npz").read_bytes(), weights_names=list(model.params), artifact_id="untied", version="test", limitations=["Random fixture, no instruction following."])
    (source / "model.klyvaron.json").write_text(json.dumps(manifest))
    report = quantize_artifact(source, tmp_path / "candidate", version="test", validation_text=TEXT, max_nll_increase=0.1, max_disagreement=0.2)
    assert report["status"] == "passed"
    manifest, reference, _ = load_quantized_reference(tmp_path / "candidate")
    assert "head" in reference.params
    with np.load(tmp_path / "candidate" / manifest["weights"]["file"]) as packed:
        assert packed["head"].dtype == np.int8
        assert packed["head.scale"].shape == (1,)
