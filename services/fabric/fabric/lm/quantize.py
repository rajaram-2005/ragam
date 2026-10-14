"""Evaluated weight-only int8 artifacts for the on-device CPU runtime.

This is a post-training conversion, not training or an assistant release. Matrices
stay int8 on the Core host; scales and normalisation vectors stay float32. NumPy
reconstructs a float32 reference ONLY in this offline evaluation/export tool.
"""
from __future__ import annotations

import copy
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import tempfile

import numpy as np

from .export import ARTIFACT_FORMAT, vocabulary_digest, write_json
from .model import TransformerConfig, TransformerLM
from .tokenizer import CharacterTokenizer

QUANTIZED_ARTIFACT_FORMAT = "klyvaron.artifact/2"
INT8_SCHEME = "symmetric-int8-per-tensor"


def quantize_parameters(params: dict) -> tuple[dict, dict]:
    """Symmetric per-tensor round-to-nearest-even, [-127,127], no zero point.

    Each scale is a one-element float32 NPZ member, bound to the weight digest.
    Norm vectors are deliberately unquantized. All-zero tensors use scale 1.
    """
    packed, reference = {}, {}
    for name, original in params.items():
        value = np.asarray(original)
        if value.dtype != np.float32 or value.ndim not in (1, 2) or not np.isfinite(value).all():
            raise ValueError(f"{name}: expected finite float32 vector or matrix")
        if value.ndim == 1:
            packed[name] = reference[name] = value.copy()
            continue
        maximum = float(np.max(np.abs(value)))
        scale = np.float32(maximum / 127 if maximum else 1)
        if not np.isfinite(scale) or scale <= 0:
            raise ValueError(f"{name}: scale underflow or overflow")
        quantized = np.clip(np.rint(value / scale), -127, 127).astype(np.int8)
        packed[name] = quantized
        packed[f"{name}.scale"] = np.asarray([scale], dtype=np.float32)
        reference[name] = quantized.astype(np.float32) * scale
    return packed, reference


def compare_models(source: TransformerLM, reference: TransformerLM, tokenizer: CharacterTokenizer,
                   validation_text: str, *, max_tokens: int = 4096) -> dict:
    if not isinstance(max_tokens, int) or isinstance(max_tokens, bool) or max_tokens < 1:
        raise ValueError("max_tokens must be positive")
    ids = tokenizer.encode(validation_text[:max_tokens + 1])
    if len(ids) < 2:
        raise ValueError("evaluation requires at least two characters")
    losses = [0.0, 0.0]
    disagreements = 0
    maximum_logit_error = 0.0
    count = 0
    for start in range(0, len(ids) - 1, source.config.seq_len):
        window = ids[start:min(start + source.config.seq_len + 1, len(ids))]
        targets = window[1:]
        logits = [model.forward(window[:-1][None, :])[0].astype(np.float64)
                  for model in (source, reference)]
        if not all(np.isfinite(values).all() for values in logits):
            raise ValueError("evaluation produced non-finite logits")
        for i, values in enumerate(logits):
            shifted = values - values.max(axis=-1, keepdims=True)
            nll = np.log(np.exp(shifted).sum(axis=-1)) - shifted[np.arange(len(targets)), targets]
            losses[i] += float(nll.sum())
        disagreements += int(np.count_nonzero(logits[0].argmax(axis=-1) != logits[1].argmax(axis=-1)))
        maximum_logit_error = max(maximum_logit_error, float(np.max(np.abs(logits[0] - logits[1]))))
        count += len(targets)
    original, quantized = (loss / count for loss in losses)
    return {
        "tokensEvaluated": count, "unknownRate": float(np.mean(ids == 0)),
        "sourceNll": original, "quantizedNll": quantized, "nllIncrease": quantized - original,
        "perplexityRatio": math.exp(min(quantized - original, 700)),
        "greedyDisagreementRate": disagreements / count, "maxAbsoluteLogitError": maximum_logit_error,
        "protocol": "non-overlapping context windows; teacher-forced next-token cross entropy; natural logs",
        "validationSha256": hashlib.sha256(validation_text.encode("utf-8")).hexdigest(),
        "evaluatedPrefixSha256": hashlib.sha256(validation_text[:max_tokens + 1].encode("utf-8")).hexdigest(),
        "independence": "caller-supplied text; disjointness from training is not verified by this converter",
    }


def load_source(directory: Path) -> tuple[dict, TransformerLM, CharacterTokenizer, str]:
    manifests = sorted(Path(directory).glob("*.klyvaron.json"))
    if len(manifests) != 1:
        raise ValueError("source must contain exactly one manifest")
    raw = manifests[0].read_bytes()
    manifest = json.loads(raw)
    if manifest.get("format") != ARTIFACT_FORMAT or manifest.get("weights", {}).get("quantization") is not None:
        raise ValueError("conversion requires an unquantized v1 artifact, not a requantized model")
    if not isinstance(manifest.get("instructionTuned"), bool) or not manifest.get("limitations") or not manifest.get("licence"):
        raise ValueError("source must retain instruction status, licence and limitations")
    tokenizer = CharacterTokenizer.from_dict(manifest["tokenizer"])
    if vocabulary_digest(tokenizer.characters) != manifest["tokenizer"]["digest"]:
        raise ValueError("source vocabulary digest mismatch")
    config = TransformerConfig(**manifest["architecture"])
    if config.vocab_size != tokenizer.size:
        raise ValueError("source vocabulary/config mismatch")
    file = manifest["weights"]["file"]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.npz", file):
        raise ValueError("unsafe source weights filename")
    weights = Path(directory) / file
    if weights.stat().st_size != manifest["weights"]["bytes"]:
        raise ValueError("source weight size mismatch")
    digest = hashlib.sha256(weights.read_bytes()).hexdigest()
    if digest != manifest["weights"]["sha256"]:
        raise ValueError("source weight digest mismatch")
    model = TransformerLM(config, seed=0)
    if sorted(model.params) != sorted(manifest["weights"]["names"]):
        raise ValueError("source parameter names disagree with architecture")
    with np.load(weights, allow_pickle=False) as arrays:
        if sorted(arrays.files) != sorted(model.params):
            raise ValueError("source archive has missing or unexpected parameters")
        for name, template in model.params.items():
            value = arrays[name]
            if value.shape != template.shape or value.dtype != np.float32 or not np.isfinite(value).all():
                raise ValueError(f"{name}: source shape/dtype/values are invalid")
            model.params[name] = value.copy()
    return manifest, model, tokenizer, hashlib.sha256(raw).hexdigest()


def quantize_artifact(source: Path, output: Path, *, version: str, validation_text: str,
                      max_nll_increase: float, max_disagreement: float,
                      max_unknown_rate: float = 0.01, max_tokens: int = 4096) -> dict:
    """Evaluate first, publish only if every gate passes, never overwrite a source.

    Returns a report even on a quality refusal. The CLI saves that report outside
    the artifact so rejected results survive without becoming installable models.
    """
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", version):
        raise ValueError("version must be a safe filename component")
    for value in (max_nll_increase, max_disagreement, max_unknown_rate):
        if not math.isfinite(value) or value < 0:
            raise ValueError("quality thresholds must be finite and nonnegative")
    if max_disagreement > 1 or max_unknown_rate > 1:
        raise ValueError("rate thresholds must be at most one")
    output = Path(output).resolve()
    if output.exists():
        raise ValueError("output already exists; candidates never overwrite installed or source artifacts")
    original, model, tokenizer, manifest_digest = load_source(source)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", original["id"]):
        raise ValueError("source artifact id is unsafe")
    packed, reference_params = quantize_parameters(model.params)
    reference = TransformerLM(model.config, seed=0)
    reference.params = reference_params
    metrics = compare_models(model, reference, tokenizer, validation_text, max_tokens=max_tokens)
    buffer = io.BytesIO()
    np.savez(buffer, **packed)
    payload = buffer.getvalue()
    resident_bytes = sum(value.nbytes for value in packed.values())
    source_resident = sum(value.nbytes for value in model.params.values())
    failures = []
    for metric, maximum in [("nllIncrease", max_nll_increase), ("greedyDisagreementRate", max_disagreement), ("unknownRate", max_unknown_rate)]:
        if metrics[metric] > maximum:
            failures.append(f"{metric} {metrics[metric]} exceeds {maximum}")
    if resident_bytes >= source_resident or len(payload) >= original["weights"]["bytes"]:
        failures.append("quantized artifact must reduce both resident weight bytes and NPZ bytes")
    report = {
        "format": "klyvaron.quantization-evaluation/1", "status": "rejected" if failures else "passed",
        "scheme": INT8_SCHEME, "failures": failures, "metrics": metrics,
        "source": {"id": original["id"], "version": original["version"],
                   "weightsSha256": original["weights"]["sha256"], "manifestSha256": manifest_digest},
        "thresholds": {"maxNllIncrease": max_nll_increase, "maxGreedyDisagreement": max_disagreement, "maxUnknownRate": max_unknown_rate},
        "sourceWeightBytes": original["weights"]["bytes"], "quantizedWeightBytes": len(payload),
        "sourceResidentWeightBytes": source_resident, "quantizedResidentWeightBytes": resident_bytes,
        "quantizedWeightsSha256": hashlib.sha256(payload).hexdigest(),
        "limitation": "A relative quantization check is not assistant capability, native-device qualification or a release approval.",
    }
    if failures:
        return report
    manifest = copy.deepcopy(original)
    manifest["format"] = QUANTIZED_ARTIFACT_FORMAT
    manifest["id"] += "-int8"
    manifest["version"] = version
    file = f"{manifest['id']}-{version}.npz"
    manifest["weights"] = {"file": file, "bytes": len(payload), "sha256": report["quantizedWeightsSha256"],
                           "names": sorted(model.params), "quantization": {"scheme": INT8_SCHEME, "scaleDtype": "float32"}}
    manifest["provenance"]["quantizedFrom"] = report["source"]
    manifest["provenance"]["sourceBenchmarks"] = manifest.get("benchmarks", [])
    manifest["benchmarks"] = [{"name": "int8 conversion evaluation", "report": report}]
    manifest["limitations"].append(report["limitation"])
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".klyvaron-int8-", dir=output.parent))
    try:
        (stage / file).write_bytes(payload)
        write_json(stage / f"{manifest['id']}.klyvaron.json", manifest)
        # The candidate is installed only after evaluation. Existing outputs are refused.
        if output.exists():
            raise ValueError("output appeared during conversion; refusing to overwrite it")
        os.rename(stage, output)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return report


def load_quantized_reference(directory: Path) -> tuple[dict, TransformerLM, CharacterTokenizer]:
    """Verify v2 and reconstruct a reference for OFFLINE tooling, not deployment.

    The Node inference runtime retains compressed weights instead. This function
    lets the existing exporter verification CLI inspect the new format too.
    """
    manifests = list(Path(directory).glob("*.klyvaron.json"))
    if len(manifests) != 1:
        raise ValueError("expected exactly one v2 manifest")
    manifest = json.loads(manifests[0].read_text(encoding="utf-8"))
    weights = manifest["weights"]
    if manifest.get("format") != QUANTIZED_ARTIFACT_FORMAT or weights.get("quantization") != {"scheme": INT8_SCHEME, "scaleDtype": "float32"}:
        raise ValueError("unsupported quantization format or scheme")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.npz", weights["file"]):
        raise ValueError("unsafe weights filename")
    file = Path(directory) / weights["file"]
    if file.stat().st_size != weights["bytes"] or hashlib.sha256(file.read_bytes()).hexdigest() != weights["sha256"]:
        raise ValueError("quantized weight size/digest mismatch")
    tokenizer = CharacterTokenizer.from_dict(manifest["tokenizer"])
    if vocabulary_digest(tokenizer.characters) != manifest["tokenizer"]["digest"]:
        raise ValueError("quantized tokenizer digest mismatch")
    model = TransformerLM(TransformerConfig(**manifest["architecture"]), seed=0)
    if model.config.vocab_size != tokenizer.size or sorted(weights["names"]) != sorted(model.params):
        raise ValueError("quantized parameter/vocabulary declaration mismatch")
    expected = set(model.params) | {f"{name}.scale" for name, value in model.params.items() if value.ndim == 2}
    with np.load(file, allow_pickle=False) as arrays:
        if len(arrays.files) != len(expected) or set(arrays.files) != expected:
            raise ValueError("missing, duplicate or unexpected quantized members")
        for name, template in model.params.items():
            value = arrays[name]
            if value.shape != template.shape:
                raise ValueError(f"{name}: quantized shape mismatch")
            if template.ndim == 2:
                scale = arrays[f"{name}.scale"]
                if (value.dtype != np.int8 or np.any(value == -128) or scale.dtype != np.float32
                        or scale.shape != (1,) or not np.isfinite(scale[0]) or scale[0] <= 0):
                    raise ValueError(f"{name}: invalid int8 values or scale")
                with np.errstate(over="ignore", invalid="ignore"):
                    restored = value.astype(np.float32) * scale[0]
                if not np.isfinite(restored).all():
                    raise ValueError(f"{name}: scale causes non-finite weights")
                model.params[name] = restored
            else:
                if value.dtype != np.float32 or not np.isfinite(value).all():
                    raise ValueError(f"{name}: invalid normalization weights")
                model.params[name] = value.copy()
    return manifest, model, tokenizer
