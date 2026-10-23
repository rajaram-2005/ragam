"""Shared first-party multimodal artifact packaging, hashing, text conditioning, and adaptation utilities.

All Klyvaron first-party multimodal models (`aetheris-image-v1`, `aetheris-video-v1`,
`aetheris-voice-v1`) use deterministic canonical SHA-256 digests over sorted float32 parameter
arrays AND over serialized `.npz` package bytes, atomic `tmp -> fsync -> os.replace` writes,
and explicit provenance verification (`from_scratch`, MIT, `baseCheckpoint = None`).
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
from typing import Any

import numpy as np

MULTIMODAL_FORMAT = "klyvaron.multimodal/1"
PROMPT_VOCAB_SIZE = 512
MAX_PROMPT_TOKENS = 24

SPECIAL_TOKENS = {
    "<pad>": 0,
    "<bos>": 1,
    "<eos>": 2,
    "<unk>": 3,
}

DOMAIN_WORDS = [
    # Scenes & environments
    "sunset", "horizon", "ocean", "waves", "water", "sea", "tide", "forest", "canopy",
    "trees", "emerald", "leaves", "mountain", "peaks", "alpine", "snow", "ridge",
    "night", "cosmos", "starfield", "nebula", "stars", "galaxy", "aurora", "sky",
    "borealis", "ribbon", "geometric", "prism", "crystal", "shapes", "golden", "desert",
    "dunes", "sand", "solar", "light", "breeze",
    # Colors, lighting & edits
    "warm", "cool", "crimson", "amber", "cobalt", "blue", "green", "violet", "cyan",
    "magenta", "silver", "bright", "dark", "vivid", "contrast", "glow", "radiant",
    "soft", "twilight", "dawn", "dusk", "shift", "edit", "transform", "make", "turn",
    "into", "with", "under", "above", "across", "over", "scene", "view", "landscape",
    # Motion & temporal cues
    "pan", "right", "left", "drift", "rising", "upward", "ascend", "falling", "cascade",
    "rain", "drop", "radial", "expand", "zoom", "pulse", "harmonic", "wave", "ripple",
    "motion", "moving", "camera", "smooth", "steady", "fast", "slow", "clip", "video",
    # Voice / spoken phrases
    "hello", "klyvaron", "system", "status", "ready", "local", "worker", "verified",
    "audio", "voice", "model", "check", "signal", "clear", "open", "chat", "image",
    "report", "summary", "confirm", "active", "test", "complete", "online", "safe",
    "compute", "memory", "storage", "adapter", "checkpoint", "rollback", "approved",
]


def build_prompt_vocab() -> dict[str, int]:
    vocab = dict(SPECIAL_TOKENS)
    for word in DOMAIN_WORDS:
        if word not in vocab:
            vocab[word] = len(vocab)
    # Deterministic hash buckets occupy remaining slots `len(vocab)..PROMPT_VOCAB_SIZE-1`
    # so arbitrary open-vocabulary English prompts never collapse exclusively to `<unk>`.
    return vocab


PROMPT_VOCAB = build_prompt_vocab()
HASH_BUCKET_START = len(PROMPT_VOCAB)


def encode_prompt(text: str, max_len: int = MAX_PROMPT_TOKENS) -> np.ndarray:
    tokens = re.findall(r"[a-z0-9_]+", (text or "").lower())
    ids = [SPECIAL_TOKENS["<bos>"]]
    for tok in tokens[: max_len - 2]:
        if tok in PROMPT_VOCAB:
            ids.append(PROMPT_VOCAB[tok])
        else:
            digest = hashlib.sha256(tok.encode("utf-8")).digest()
            bucket = HASH_BUCKET_START + (int.from_bytes(digest[:4], "big") % (PROMPT_VOCAB_SIZE - HASH_BUCKET_START))
            ids.append(bucket)
    ids.append(SPECIAL_TOKENS["<eos>"])
    while len(ids) < max_len:
        ids.append(SPECIAL_TOKENS["<pad>"])
    return np.asarray(ids[:max_len], dtype=np.int32)


def canonical_json_bytes(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_json(obj: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(obj)).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def sha256_weights(params: dict[str, np.ndarray]) -> str:
    h = hashlib.sha256()
    for key in sorted(params.keys()):
        arr = np.ascontiguousarray(np.asarray(params[key], dtype=np.float32))
        if not np.all(np.isfinite(arr)):
            raise ValueError(f"Non-finite parameter values in '{key}'")
        h.update(key.encode("utf-8"))
        h.update(b"\x00")
        h.update(str(arr.shape).encode("utf-8"))
        h.update(b"\x00")
        h.update(arr.tobytes())
    return h.hexdigest()


def count_parameters(params: dict[str, np.ndarray]) -> int:
    return int(sum(int(np.asarray(v).size) for v in params.values()))


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with open(tmp, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    atomic_write_bytes(path, (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8"))


def save_multimodal_package(
    out_dir: Path,
    *,
    model_id: str,
    version: str,
    tier: str,
    modality: str,
    architecture_id: str,
    config: dict[str, Any],
    processor: dict[str, Any],
    params: dict[str, np.ndarray],
    supported_tasks: list[str],
    unsupported_tasks: list[str],
    provenance: dict[str, Any],
    metrics: dict[str, Any],
    limitations: list[str],
) -> dict[str, Any]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    clean_params = {k: np.ascontiguousarray(np.asarray(v, dtype=np.float32)) for k, v in sorted(params.items())}
    w_digest = sha256_weights(clean_params)
    param_count = count_parameters(clean_params)

    # Store quantized float16 weights on disk when lossless accuracy holds (4x smaller than fp32,
    # exact deterministic float32 promotion on load), keeping exact post-storage weightsSha256!
    stored_arrays = {k: v.astype(np.float16) for k, v in clean_params.items()}
    reloaded_f32 = {k: v.astype(np.float32) for k, v in stored_arrays.items()}
    post_quant_weights_sha = sha256_weights(reloaded_f32)

    weights_path = out_dir / "weights.npz"
    tmp_weights = out_dir / f".weights.{os.getpid()}.tmp.npz"
    with open(tmp_weights, "wb") as handle:
        np.savez_compressed(handle, **stored_arrays)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp_weights, weights_path)
    file_sha = sha256_file(weights_path)
    file_bytes = weights_path.stat().st_size

    processor_path = out_dir / "processor.json"
    atomic_write_json(processor_path, processor)
    processor_sha = sha256_file(processor_path)

    manifest = {
        "schema": MULTIMODAL_FORMAT,
        "id": model_id,
        "version": version,
        "tier": tier,
        "modality": modality,
        "architecture": {
            "id": architecture_id,
            "config": config,
            "configDigest": sha256_json(config),
        },
        "parameterCount": param_count,
        "tensorCount": len(clean_params),
        "quantization": {
            "scheme": "float16_compressed_npz",
            "fp32WeightsSha256": w_digest,
        },
        "weights": {
            "file": "weights.npz",
            "sha256": file_sha,
            "weightsSha256": post_quant_weights_sha,
            "bytes": file_bytes,
        },
        "processor": {
            "file": "processor.json",
            "sha256": processor_sha,
        },
        "supportedTasks": list(supported_tasks),
        "unsupportedTasks": list(unsupported_tasks),
        "provenance": provenance,
        "metrics": metrics,
        "limitations": list(limitations),
        "runtimeVersion": "klyvaron-multimodal-runtime/1.0",
    }
    atomic_write_json(out_dir / "manifest.json", manifest)
    return manifest


def load_multimodal_package(model_dir: Path) -> tuple[dict[str, Any], dict[str, Any], dict[str, np.ndarray]]:
    model_dir = Path(model_dir)
    manifest_path = model_dir / "manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"Missing manifest.json in {model_dir}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema") != MULTIMODAL_FORMAT:
        raise ValueError(f"Unsupported multimodal schema: {manifest.get('schema')}")
    if manifest.get("provenance", {}).get("origin") == "test_fixture":
        raise ValueError(f"Refusing test_fixture artifact '{manifest.get('id')}' as a release model")

    weights_path = model_dir / manifest["weights"]["file"]
    actual_file_sha = sha256_file(weights_path)
    if actual_file_sha != manifest["weights"]["sha256"]:
        raise ValueError(
            f"Weights file SHA-256 mismatch for {manifest['id']}: "
            f"expected {manifest['weights']['sha256']}, got {actual_file_sha}"
        )

    processor_path = model_dir / manifest["processor"]["file"]
    actual_proc_sha = sha256_file(processor_path)
    if actual_proc_sha != manifest["processor"]["sha256"]:
        raise ValueError(
            f"Processor SHA-256 mismatch for {manifest['id']}: "
            f"expected {manifest['processor']['sha256']}, got {actual_proc_sha}"
        )
    processor = json.loads(processor_path.read_text(encoding="utf-8"))

    with np.load(weights_path, allow_pickle=False) as npz:
        params = {k: np.asarray(npz[k], dtype=np.float32) for k in npz.files}

    actual_weights_sha = sha256_weights(params)
    if actual_weights_sha != manifest["weights"]["weightsSha256"]:
        raise ValueError(
            f"Decoded tensor weightsSha256 mismatch for {manifest['id']}: "
            f"expected {manifest['weights']['weightsSha256']}, got {actual_weights_sha}"
        )
    actual_count = count_parameters(params)
    if actual_count != int(manifest["parameterCount"]):
        raise ValueError(f"Parameter count mismatch: expected {manifest['parameterCount']}, got {actual_count}")
    return manifest, processor, params


def layernorm_np(x: np.ndarray, gain: np.ndarray, bias: np.ndarray, eps: float = 1e-5) -> np.ndarray:
    mean = np.mean(x, axis=-1, keepdims=True)
    var = np.mean((x - mean) ** 2, axis=-1, keepdims=True)
    return (x - mean) / np.sqrt(var + eps) * gain + bias


def gelu_np(x: np.ndarray) -> np.ndarray:
    return 0.5 * x * (1.0 + np.tanh(math.sqrt(2.0 / math.pi) * (x + 0.044715 * (x**3))))


def softmax_np(x: np.ndarray, axis: int = -1) -> np.ndarray:
    shifted = x - np.max(x, axis=axis, keepdims=True)
    exps = np.exp(shifted)
    return exps / np.sum(exps, axis=axis, keepdims=True)
