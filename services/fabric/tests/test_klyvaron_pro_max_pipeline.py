"""Comprehensive unit & integration tests for the Klyvaron Pro/Max training,
Byte-BPE serialization, SFT whole-repo isolation, export, and int8 quantization pipeline.
"""

from __future__ import annotations

import json
from pathlib import Path
import subprocess

import numpy as np
import pytest

from fabric.lm.bpe import ByteBPETokenizer
from fabric.lm.export import bpe_digest, export_artifact, load_tokenizer_manifest
from fabric.lm.model import TransformerConfig, TransformerLM
from fabric.lm.quantize import quantize_artifact
from fabric.lm.sft import (
    CHAT_SYSTEM_PROMPT,
    HELD_OUT_REPOS,
    STATE_CLASSES,
    VERDICT_LABELS,
    assert_non_anthropomorphic,
    build_sft_examples,
    encode_sft_batch_arrays,
    format_turn,
    split_assembled_corpus,
)
from scripts.export_lm import verify
from scripts.train_klyvaron import PRESETS

REPO_ROOT = Path(__file__).resolve().parents[3]


def test_pro_and_max_presets_match_exact_architecture_contracts():
    pro = PRESETS["pro"]
    max_spec = PRESETS["max"]

    assert pro["artifact_id"] == "klyvaron-pro-lm"
    assert pro["expected_params"] == 27_559_946
    assert pro["config"].parameter_count() == 27_559_946
    assert pro["config"].vocab_size == 4096
    assert pro["config"].d_model == 512
    assert pro["config"].n_layers == 8
    assert pro["config"].n_heads == 8
    assert pro["config"].d_ff == 2048
    assert pro["config"].seq_len == 512
    assert pro["config"].age_buckets == 16
    assert pro["config"].state_classes == 8
    assert pro["config"].verdict_head is True
    assert pro["config"].state_head is True

    assert max_spec["artifact_id"] == "klyvaron-max-lm"
    assert max_spec["expected_params"] == 92_077_066
    assert max_spec["config"].parameter_count() == 92_077_066
    assert max_spec["config"].vocab_size == 8192
    assert max_spec["config"].d_model == 768
    assert max_spec["config"].n_layers == 12
    assert max_spec["config"].n_heads == 12
    assert max_spec["config"].d_ff == 3072
    assert max_spec["config"].seq_len == 1024
    assert max_spec["config"].age_buckets == 16
    assert max_spec["config"].state_classes == 8
    assert max_spec["config"].verdict_head is True
    assert max_spec["config"].state_head is True
    assert pro["architecture_digest"] != max_spec["architecture_digest"]


def test_byte_bpe_manifest_roundtrip_and_node_digest_parity():
    samples = [
        "def verify_digest(payload: bytes) -> str: return hashlib.sha256(payload).hexdigest()\n",
        "தமிழ் மொழி மற்றும் Klyvaron Pro / Max first-party Transformer architecture 🚀\n",
        format_turn(user="Explain KV cache parity.", context="KV cache stores past keys and values.", reply="KV cache avoids recomputing prior positions."),
    ]
    tok = ByteBPETokenizer.fit(samples * 8, vocab_size=320)
    assert tok.size == 320

    raw_tok_dict = tok.to_dict()
    raw_tok_dict["digest"] = bpe_digest(raw_tok_dict["merges"])
    manifest_tok = load_tokenizer_manifest(raw_tok_dict)
    assert manifest_tok.kind == "byte-bpe"
    assert manifest_tok.size == 320
    assert raw_tok_dict["digest"] == bpe_digest(manifest_tok.merges)

    for text in samples:
        encoded = tok.encode(text)
        assert tok.decode(encoded) == text

    node_out = subprocess.check_output(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import { byteBpeDigest } from './services/core/src/klyvaron/format.mjs';"
                "import { buildTokenizerFromManifest } from './services/core/src/klyvaron/runtime.mjs';"
                f"const spec = {json.dumps(raw_tok_dict)};"
                "const t = buildTokenizerFromManifest(spec);"
                f"const sample = {json.dumps(samples[1])};"
                "console.log(JSON.stringify({ digest: byteBpeDigest(spec.merges), ids: Array.from(t.encode(sample)), text: t.decode(t.encode(sample)) }));"
            ),
        ],
        cwd=REPO_ROOT,
        text=True,
    ).strip()
    parsed = json.loads(node_out)
    assert parsed["digest"] == raw_tok_dict["digest"]
    assert parsed["ids"] == list(map(int, tok.encode(samples[1])))
    assert parsed["text"] == samples[1]


def test_sft_whole_repo_split_and_non_anthropomorphic_guard(tmp_path: Path):
    for repo_name, body in [
        ("mit_repo_alpha", "def add_numbers(a: int, b: int) -> int:\n    '''Return the sum of two integers cleanly.'''\n    return a + b\n" * 6),
        ("apache_repo_beta", "class CacheStore:\n    '''Deterministic LRU store with bounded byte footprint.'''\n    def clear(self) -> None:\n        pass\n" * 6),
        ("pallets__click", "def option_secret_click_marker(param_name: str) -> str:\n    '''Unique held-out click docstring sentinel.'''\n    return param_name\n" * 6),
        ("psf__requests", "def session_secret_requests_marker(url: str) -> str:\n    '''Unique held-out requests docstring sentinel.'''\n    return url\n" * 6),
    ]:
        d = tmp_path / repo_name
        d.mkdir()
        (d / "module.py").write_text(body, encoding="utf-8")

    split = split_assembled_corpus(tmp_path, held_out_repos=HELD_OUT_REPOS)
    assert "option_secret_click_marker" not in split["train_text"]
    assert "session_secret_requests_marker" not in split["train_text"]
    assert "option_secret_click_marker" in split["val_text"]
    assert "session_secret_requests_marker" in split["val_text"]

    examples = build_sft_examples(split["train_passages"], seed=7, count=32, include_product_domain=True)
    assert len(examples) == 32
    assert {ex.verdict for ex in examples} == {0, 1}
    assert len({ex.state_class for ex in examples}) >= 4
    assert len(STATE_CLASSES) == 8
    assert len(VERDICT_LABELS) == 2

    tok = ByteBPETokenizer.fit([split["train_text"]], vocab_size=288)
    arrays = encode_sft_batch_arrays(examples, tok, seq_len=128)
    assert arrays["inputs"].shape == (32, 128)
    assert np.all(arrays["prompt_pos"] >= 0) and np.all(arrays["prompt_pos"] < 128)
    assert np.all(arrays["head_pos"] >= arrays["prompt_pos"])

    with pytest.raises(ValueError):
        assert_non_anthropomorphic("I'm so proud of you and I really care about your feelings!")


def test_export_and_int8_quantization_preserve_differentiator_heads_and_js_parity(tmp_path: Path):
    cfg = TransformerConfig(
        vocab_size=272,
        d_model=64,
        n_layers=2,
        n_heads=4,
        d_ff=128,
        seq_len=64,
        tie_embeddings=True,
        age_buckets=16,
        state_classes=8,
        verdict_head=True,
        state_head=True,
    )
    model = TransformerLM(cfg, seed=1234)
    text = "Aetheris Klyvaron grounded transformer check with Byte-BPE and task heads.\n" * 20
    tok = ByteBPETokenizer.fit([text], vocab_size=272)

    raw_dir = tmp_path / "run"
    raw_dir.mkdir()
    raw_npz = raw_dir / "tiny.npz"
    raw_sha = model.save(raw_npz)
    tok_json = raw_dir / "tokenizer.json"
    tok_json.write_text(json.dumps(tok.to_dict()), encoding="utf-8")
    report = {
        "model_config": {
            "vocab_size": cfg.vocab_size,
            "d_model": cfg.d_model,
            "n_layers": cfg.n_layers,
            "n_heads": cfg.n_heads,
            "d_ff": cfg.d_ff,
            "seq_len": cfg.seq_len,
            "tie_embeddings": cfg.tie_embeddings,
            "age_buckets": cfg.age_buckets,
            "state_classes": cfg.state_classes,
            "verdict_head": cfg.verdict_head,
            "state_head": cfg.state_head,
        },
        "provenance": {"seed": 1234, "parameterCount": cfg.parameter_count()},
        "tokenizer": {"kind": "byte-bpe", "vocabSize": 272, "vocabularyDigest": tok.digest},
        "corpus": {"manifestDigest": "a" * 64, "trainCharacters": len(text), "validationCharacters": 64},
        "training": {"totalSteps": 2, "finalLoss": 4.5, "tokensSeen": 128},
        "evaluation": {"perplexity": 90.0, "loss": 4.5},
        "artifact": {"filename": raw_npz.name, "sha256": raw_sha},
    }
    report_path = raw_dir / "report.json"
    report_path.write_text(json.dumps(report), encoding="utf-8")

    fp32_out = tmp_path / "fp32"
    export_artifact(
        report=report,
        artifact_path=raw_npz,
        tokenizer_path=tok_json,
        output_dir=fp32_out,
        artifact_id="klyvaron-test-bpe-fp32",
        version="0.1.0",
        tier="pro",
        instruction_tuned=True,
        generation={"maxNewTokens": 16, "temperature": 0.0, "topK": 0, "stop": ["<|end|>"]},
        chat_template={"format": "klyvaron-chat-v1", "systemPrompt": CHAT_SYSTEM_PROMPT, "stop": ["<|end|>"]},
        differentiators={"ageBuckets": 16, "stateClasses": list(STATE_CLASSES), "verdictLabels": list(VERDICT_LABELS)},
        limitations=["Synthetic unit-test checkpoint."],
        benchmarks=[],
        report_path=report_path,
    )
    assert verify(fp32_out) == 0

    int8_out = tmp_path / "int8"
    q_report = quantize_artifact(
        fp32_out,
        int8_out,
        version="0.1.0",
        validation_text=text[:512],
        max_nll_increase=0.5,
        max_disagreement=0.5,
        max_tokens=128,
        artifact_id="klyvaron-test-bpe",
        compress=True,
    )
    assert q_report["status"] == "passed"
    assert q_report["quantizedResidentWeightBytes"] < q_report["sourceResidentWeightBytes"]
    assert verify(int8_out) == 0

    js_check = subprocess.check_output(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import { KlyvaronRuntime } from './services/core/src/klyvaron/runtime.mjs';"
                f"const rt = KlyvaronRuntime.load({json.dumps(str(int8_out))});"
                "const kv = rt.verifyKvCacheParity(rt.tokenizer.encode('Aetheris Klyvaron parity check'));"
                "const gen = rt.generate({ prompt: 'Aetheris', maxNewTokens: 5 });"
                "console.log(JSON.stringify({ kv, differentiators: gen.differentiators, tokens: gen.generatedTokens }));"
            ),
        ],
        cwd=REPO_ROOT,
        text=True,
    ).strip()
    parsed = json.loads(js_check)
    assert parsed["kv"]["greedyMatch"] is True
    assert parsed["kv"]["maxAbsError"] < 1e-4
    assert parsed["differentiators"]["verdict"]["label"] in ("grounded", "ungrounded")
    assert isinstance(parsed["differentiators"]["state"]["label"], str)
    assert parsed["tokens"] == 5
