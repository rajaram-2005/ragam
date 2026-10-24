"""First-party Klyvaron adapter training, full fine-tuning, foundation pretraining,
atomic checkpointing, validation, and verified artifact packaging.

Every gradient in `LoRAAdapter.loss_and_grads` is exact by the matrix chain rule on
`W_eff = W_base + (alpha / rank) * (A @ B)` and checked against central finite
differences in `tests/test_user_worker_architecture.py`.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import resource
import sys
import time
from pathlib import Path
from typing import Callable

import numpy as np

from .sft import CHAT_SYSTEM_PROMPT
from .evaluate import generate
from .export import (
    ARTIFACT_FORMAT,
    architecture_block,
    build_manifest,
    config_from_architecture,
    load_tokenizer_manifest,
    write_json,
)
from .model import TransformerConfig, TransformerLM, artifact_digest, weights_digest
from .quantize import QUANTIZED_ARTIFACT_FORMAT, quantize_parameters

ADAPTER_FORMAT = "klyvaron.adapter/1"
INTERACTIVE_ADAPTER_MAX_MS = 120_000
DEFAULT_LORA_SUFFIXES = ("wq", "wv", "wo", "w2")


class TrainingLimitExceededError(RuntimeError):
    """Raised when an interactive job exceeds its hard wall-clock ceiling (including finalization)."""


class TrainingCancelledError(RuntimeError):
    """Raised when a running job is cancelled cooperatively or by signal."""


def peak_rss_bytes() -> int:
    usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if sys.platform == "darwin":
        return int(usage)
    return int(usage) * 1024


def atomic_write_bytes(path: Path, data: bytes) -> str:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    with open(tmp, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)
    return hashlib.sha256(data).hexdigest()


def atomic_save_npz(path: Path, arrays: dict[str, np.ndarray]) -> str:
    import io

    buf = io.BytesIO()
    np.savez(buf, **arrays)
    return atomic_write_bytes(path, buf.getvalue())


def atomic_write_json(path: Path, payload: dict) -> str:
    raw = (json.dumps(payload, indent=2, sort_keys=False) + "\n").encode("utf-8")
    return atomic_write_bytes(path, raw)


def find_manifest_file(model_dir: Path) -> Path:
    model_dir = Path(model_dir)
    direct = sorted(model_dir.glob("*.klyvaron.json"))
    if direct:
        return direct[0]
    fallback = model_dir / "manifest.json"
    if fallback.is_file():
        return fallback
    raise FileNotFoundError(f"no *.klyvaron.json manifest found in {model_dir}")


def load_installed_klyvaron_model(model_dir: str | Path) -> tuple[TransformerLM, object, dict, dict[str, np.ndarray]]:
    """Load and SHA-256-verify any installed v1 (fp32/fp64) or v2 (symmetric int8) Klyvaron artifact."""
    model_dir = Path(model_dir)
    manifest_path = find_manifest_file(model_dir)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    fmt = manifest.get("format")
    if fmt not in (ARTIFACT_FORMAT, QUANTIZED_ARTIFACT_FORMAT):
        raise ValueError(f"unsupported Klyvaron artifact format: {fmt!r}")

    weights_meta = manifest["weights"]
    weights_path = model_dir / weights_meta["file"]
    if not weights_path.is_file():
        raise FileNotFoundError(f"missing weights file {weights_path}")
    actual_sha = artifact_digest(weights_path)
    if actual_sha != weights_meta["sha256"]:
        raise ValueError(
            f"base weights SHA-256 mismatch for {manifest['id']}: expected {weights_meta['sha256']}, got {actual_sha}"
        )

    config = config_from_architecture(manifest["architecture"])
    tokenizer = load_tokenizer_manifest(manifest["tokenizer"])
    if tokenizer.size != config.vocab_size:
        raise ValueError(
            f"tokenizer size ({tokenizer.size}) disagrees with architecture ({config.vocab_size})"
        )

    model = TransformerLM(config, seed=0, dtype=np.float32)
    with np.load(weights_path) as data:
        if fmt == QUANTIZED_ARTIFACT_FORMAT:
            for name in model.params:
                if name not in data:
                    raise KeyError(f"checkpoint missing parameter '{name}'")
                arr = data[name]
                if arr.ndim == 2:
                    scale_key = f"{name}.scale"
                    if scale_key not in data:
                        raise KeyError(f"quantized checkpoint missing scale '{scale_key}'")
                    scale = float(data[scale_key].reshape(-1)[0])
                    model.params[name] = arr.astype(np.float32) * np.float32(scale)
                else:
                    model.params[name] = arr.astype(np.float32)
        else:
            for name in model.params:
                if name not in data:
                    raise KeyError(f"checkpoint missing parameter '{name}'")
                model.params[name] = data[name].astype(np.float32)
            extra = set(data.files) - set(model.params)
            if extra:
                raise KeyError(f"unexpected tensors in checkpoint: {sorted(extra)}")

    base_snapshot = {k: v.copy() for k, v in model.params.items()}
    return model, tokenizer, manifest, base_snapshot


def masked_cross_entropy_and_dlogits(
    logits: np.ndarray,
    targets: np.ndarray,
    loss_mask: np.ndarray | None = None,
) -> tuple[float, np.ndarray]:
    """Cross-entropy over target positions selected by `loss_mask` (shape `(B, T)`)."""
    B, T, V = logits.shape
    flat = logits.reshape(-1, V).astype(np.float64)
    flat = flat - flat.max(axis=-1, keepdims=True)
    exp = np.exp(flat)
    probs = exp / exp.sum(axis=-1, keepdims=True)
    rows = np.arange(B * T)
    flat_targets = targets.reshape(-1).astype(np.int64)
    token_nll = -np.log(np.maximum(probs[rows, flat_targets], 1e-12))

    if loss_mask is None:
        weights = np.ones(B * T, dtype=np.float64)
    else:
        weights = np.asarray(loss_mask, dtype=np.float64).reshape(-1)
    denom = float(weights.sum())
    if denom <= 0.0:
        raise ValueError("loss_mask marks zero target tokens; refusing empty objective")

    loss = float((token_nll * weights).sum() / denom)
    grad = probs
    grad[rows, flat_targets] -= 1.0
    grad *= (weights / denom)[:, None]
    return loss, grad.astype(logits.dtype).reshape(B, T, V)


def default_conditioning(config: TransformerConfig, batch: int, seq_len: int) -> dict:
    kwargs = {}
    if config.age_buckets:
        kwargs["ages"] = np.zeros((batch, seq_len), dtype=np.int64)
    if config.state_classes:
        kwargs["states"] = np.zeros((batch,), dtype=np.int64)
    return kwargs


class LoRAAdapter:
    """Rank-`r` low-rank adapter over frozen `TransformerLM` weights.

    For each adapted matrix `M` (`shape = (rows, cols)`):
      `W_eff[M] = W_base[M] + (alpha / rank) * (A[M] @ B[M])`
    with `A[M]` shape `(rows, rank)` initialized Gaussian and `B[M]` shape `(rank, cols)`
    initialized strictly zero so initial forward logits are bit-identical to `W_base`.
    """

    def __init__(
        self,
        base_params: dict[str, np.ndarray],
        config: TransformerConfig,
        *,
        rank: int = 8,
        alpha: float = 16.0,
        target_suffixes: tuple[str, ...] = DEFAULT_LORA_SUFFIXES,
        adapt_lm_head: bool = True,
        layer_indices: list[int] | None = None,
        seed: int = 0,
    ):
        if rank < 1:
            raise ValueError(f"LoRA rank must be >= 1, got {rank}")
        if alpha <= 0 or not math.isfinite(alpha):
            raise ValueError(f"LoRA alpha must be finite and > 0, got {alpha}")

        self.config = config
        self.rank = int(rank)
        self.alpha = float(alpha)
        self.scale = np.float32(self.alpha / self.rank)
        self.base_params = {k: v.astype(np.float32, copy=True) for k, v in base_params.items()}
        self.targets: list[str] = []

        selected_layers = set(range(config.n_layers) if layer_indices is None else layer_indices)
        for layer in sorted(selected_layers):
            for suffix in target_suffixes:
                key = f"L{layer}.{suffix}"
                if key in self.base_params and self.base_params[key].ndim == 2:
                    self.targets.append(key)
        if adapt_lm_head:
            head_key = "emb" if config.tie_embeddings else "head"
            if head_key in self.base_params:
                self.targets.append(head_key)
        if not self.targets:
            raise ValueError("LoRAAdapter matched zero target matrices")

        rng = np.random.default_rng(seed)
        self.params: dict[str, np.ndarray] = {}
        for target in self.targets:
            rows, cols = self.base_params[target].shape
            std = 1.0 / math.sqrt(rows)
            self.params[f"{target}.lora_a"] = (rng.standard_normal((rows, self.rank)) * std).astype(np.float32)
            self.params[f"{target}.lora_b"] = np.zeros((self.rank, cols), dtype=np.float32)

    @property
    def parameter_count(self) -> int:
        return int(sum(arr.size for arr in self.params.values()))

    def delta_l2_norm(self) -> float:
        total = 0.0
        for target in self.targets:
            delta = float(self.scale) * (
                self.params[f"{target}.lora_a"].astype(np.float64)
                @ self.params[f"{target}.lora_b"].astype(np.float64)
            )
            total += float(np.sum(delta * delta))
        return math.sqrt(total)

    def apply_to_model(self, model: TransformerLM) -> None:
        s = np.float32(self.scale)
        for name, base in self.base_params.items():
            if name in self.targets:
                a = self.params[f"{name}.lora_a"]
                b = self.params[f"{name}.lora_b"]
                model.params[name] = (base + s * (a @ b)).astype(np.float32)
            else:
                model.params[name] = base.copy()

    def detach_from_model(self, model: TransformerLM) -> None:
        for name, base in self.base_params.items():
            model.params[name] = base.copy()

    def forward(self, model: TransformerLM, inputs: np.ndarray, **kwargs):
        self.apply_to_model(model)
        return model.forward(inputs, **kwargs)

    def loss(
        self,
        model: TransformerLM,
        inputs: np.ndarray,
        targets: np.ndarray,
        *,
        loss_mask: np.ndarray | None = None,
    ) -> float:
        self.apply_to_model(model)
        cond = default_conditioning(self.config, inputs.shape[0], inputs.shape[1])
        logits = model.forward(inputs, cache=False, **cond)
        loss, _ = masked_cross_entropy_and_dlogits(logits, targets, loss_mask)
        return float(loss)

    def loss_and_grads(
        self,
        model: TransformerLM,
        inputs: np.ndarray,
        targets: np.ndarray,
        *,
        loss_mask: np.ndarray | None = None,
    ) -> tuple[float, dict[str, np.ndarray]]:
        self.apply_to_model(model)
        cond = default_conditioning(self.config, inputs.shape[0], inputs.shape[1])
        logits, cache = model.forward(inputs, cache=True, **cond)
        loss, dlogits = masked_cross_entropy_and_dlogits(logits, targets, loss_mask)
        full_grads = model.backward_from_dlogits(dlogits, cache)
        s = np.float32(self.scale)
        lora_grads: dict[str, np.ndarray] = {}
        for target in self.targets:
            g_w = full_grads[target]
            a = self.params[f"{target}.lora_a"]
            b = self.params[f"{target}.lora_b"]
            lora_grads[f"{target}.lora_a"] = (s * (g_w @ b.T)).astype(np.float32)
            lora_grads[f"{target}.lora_b"] = (s * (a.T @ g_w)).astype(np.float32)
        return float(loss), lora_grads

    def export(
        self,
        out_dir: str | Path,
        *,
        adapter_id: str,
        version: str = "0.1.0",
        base_manifest: dict,
        objective: dict,
        metrics: dict,
        provenance: dict,
    ) -> dict:
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        for name, arr in self.params.items():
            if not np.isfinite(arr).all():
                raise ValueError(f"refusing to export non-finite adapter tensor '{name}'")

        weights_filename = f"{adapter_id}-{version}.npz"
        weights_path = out_dir / weights_filename
        file_sha = atomic_save_npz(weights_path, self.params)
        manifest = {
            "format": ADAPTER_FORMAT,
            "id": adapter_id,
            "version": version,
            "kind": "lora_adapter",
            "baseModel": {
                "id": base_manifest["id"],
                "version": base_manifest["version"],
                "weightsSha256": base_manifest["weights"]["sha256"],
                "tokenizerDigest": base_manifest["tokenizer"]["digest"],
                "architecture": base_manifest["architecture"],
            },
            "lora": {
                "rank": self.rank,
                "alpha": self.alpha,
                "scale": float(self.scale),
                "targets": list(self.targets),
                "parameterCount": self.parameter_count,
                "deltaL2Norm": self.delta_l2_norm(),
            },
            "weights": {
                "file": weights_filename,
                "sha256": file_sha,
                "bytes": weights_path.stat().st_size,
                "logicalDigest": weights_digest(self.params),
                "names": sorted(self.params.keys()),
            },
            "objective": objective,
            "metrics": metrics,
            "provenance": provenance,
        }
        atomic_write_json(out_dir / f"{adapter_id}.klyvaron.json", manifest)
        atomic_write_bytes(out_dir / ".ready", f"{file_sha}\n".encode("utf-8"))
        return manifest

    @classmethod
    def load_and_verify(
        cls,
        adapter_dir: str | Path,
        *,
        base_params: dict[str, np.ndarray],
        config: TransformerConfig,
        expected_base_manifest: dict | None = None,
    ) -> tuple["LoRAAdapter", dict]:
        adapter_dir = Path(adapter_dir)
        manifest_candidates = sorted(adapter_dir.glob("*.klyvaron.json"))
        if not manifest_candidates:
            raise FileNotFoundError(f"missing adapter manifest in {adapter_dir}")
        manifest = json.loads(manifest_candidates[0].read_text(encoding="utf-8"))
        if manifest.get("format") != ADAPTER_FORMAT:
            raise ValueError(f"expected format {ADAPTER_FORMAT}, got {manifest.get('format')!r}")
        if not (adapter_dir / ".ready").is_file():
            raise ValueError(f"adapter package at {adapter_dir} was never finalized (.ready missing)")

        if expected_base_manifest is not None:
            bm = manifest["baseModel"]
            if bm["id"] != expected_base_manifest["id"]:
                raise ValueError(
                    f"adapter targets base model '{bm['id']}', not '{expected_base_manifest['id']}'"
                )
            if bm["weightsSha256"] != expected_base_manifest["weights"]["sha256"]:
                raise ValueError(
                    "adapter baseWeightsSha256 does not match installed base weights; refusing stale/mismatched adapter"
                )
            if bm["tokenizerDigest"] != expected_base_manifest["tokenizer"]["digest"]:
                raise ValueError("adapter tokenizerDigest does not match base model tokenizer")

        weights_path = adapter_dir / manifest["weights"]["file"]
        actual_sha = artifact_digest(weights_path)
        if actual_sha != manifest["weights"]["sha256"]:
            raise ValueError(
                f"adapter SHA-256 mismatch: expected {manifest['weights']['sha256']}, got {actual_sha}"
            )

        lora_meta = manifest["lora"]
        adapter = cls(
            base_params,
            config,
            rank=int(lora_meta["rank"]),
            alpha=float(lora_meta["alpha"]),
            target_suffixes=(),
            adapt_lm_head=False,
        ) if False else object.__new__(cls)
        adapter.config = config
        adapter.rank = int(lora_meta["rank"])
        adapter.alpha = float(lora_meta["alpha"])
        adapter.scale = np.float32(adapter.alpha / adapter.rank)
        adapter.base_params = {k: v.astype(np.float32, copy=True) for k, v in base_params.items()}
        adapter.targets = list(lora_meta["targets"])
        adapter.params = {}

        expected_names = set()
        for target in adapter.targets:
            if target not in adapter.base_params:
                raise KeyError(f"adapter target '{target}' absent from base model")
            expected_names.add(f"{target}.lora_a")
            expected_names.add(f"{target}.lora_b")

        with np.load(weights_path) as data:
            if set(data.files) != expected_names:
                raise ValueError(
                    f"adapter tensor set mismatch: expected {sorted(expected_names)}, got {sorted(data.files)}"
                )
            for target in adapter.targets:
                rows, cols = adapter.base_params[target].shape
                a = data[f"{target}.lora_a"].astype(np.float32)
                b = data[f"{target}.lora_b"].astype(np.float32)
                if a.shape != (rows, adapter.rank) or b.shape != (adapter.rank, cols):
                    raise ValueError(f"invalid LoRA shape on '{target}': {a.shape}, {b.shape}")
                if not (np.isfinite(a).all() and np.isfinite(b).all()):
                    raise ValueError(f"non-finite LoRA weights in '{target}'")
                adapter.params[f"{target}.lora_a"] = a
                adapter.params[f"{target}.lora_b"] = b

        return adapter, manifest


class AdamWOptimizer:
    """Deterministic AdamW with global L2 gradient clipping and serializable state."""

    def __init__(
        self,
        params: dict[str, np.ndarray],
        *,
        lr: float = 3e-3,
        beta1: float = 0.9,
        beta2: float = 0.999,
        eps: float = 1e-8,
        weight_decay: float = 0.01,
        grad_clip: float = 1.0,
    ):
        self.lr = float(lr)
        self.beta1 = float(beta1)
        self.beta2 = float(beta2)
        self.eps = float(eps)
        self.weight_decay = float(weight_decay)
        self.grad_clip = float(grad_clip)
        self.step_count = 0
        self.m = {k: np.zeros_like(v, dtype=np.float32) for k, v in params.items()}
        self.v = {k: np.zeros_like(v, dtype=np.float32) for k, v in params.items()}

    def step(self, params: dict[str, np.ndarray], grads: dict[str, np.ndarray]) -> float:
        sq = 0.0
        for g in grads.values():
            gf = g.astype(np.float64)
            sq += float(np.sum(gf * gf))
        grad_norm = math.sqrt(sq)
        if not math.isfinite(grad_norm):
            raise ValueError(f"non-finite gradient norm ({grad_norm})")
        clip_coef = min(1.0, self.grad_clip / max(grad_norm, 1e-12)) if self.grad_clip > 0 else 1.0

        self.step_count += 1
        bc1 = 1.0 - self.beta1 ** self.step_count
        bc2 = 1.0 - self.beta2 ** self.step_count
        for name, param in params.items():
            g = grads[name].astype(np.float32) * np.float32(clip_coef)
            m = self.beta1 * self.m[name] + (1.0 - self.beta1) * g
            v = self.beta2 * self.v[name] + (1.0 - self.beta2) * (g * g)
            self.m[name] = m.astype(np.float32)
            self.v[name] = v.astype(np.float32)
            m_hat = m / bc1
            v_hat = v / bc2
            update = m_hat / (np.sqrt(v_hat) + self.eps) + self.weight_decay * param
            params[name] = (param - self.lr * update).astype(np.float32)
        return grad_norm

    def state_arrays(self, params: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
        out: dict[str, np.ndarray] = {"__step__": np.asarray([self.step_count], dtype=np.int64)}
        for k, val in params.items():
            out[f"param::{k}"] = val.astype(np.float32)
            out[f"m::{k}"] = self.m[k].astype(np.float32)
            out[f"v::{k}"] = self.v[k].astype(np.float32)
        return out

    def load_state_arrays(self, params: dict[str, np.ndarray], data) -> None:
        self.step_count = int(data["__step__"].reshape(-1)[0])
        for k in list(params.keys()):
            params[k] = data[f"param::{k}"].astype(np.float32)
            self.m[k] = data[f"m::{k}"].astype(np.float32)
            self.v[k] = data[f"v::{k}"].astype(np.float32)


def encode_input_target_example(
    tokenizer,
    example: dict,
    *,
    seq_len: int,
    instruction_tuned: bool = True,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Encode `{input, target}` into `(inputs[T], targets[T], loss_mask[T])` with loss masked to `target`."""
    inp_text = str(example["input"])
    tgt_text = str(example["target"])

    if instruction_tuned:
        prompt_str = (
            f"<|system|>\n{CHAT_SYSTEM_PROMPT}\n"
            f"<|context|>\nnone\n"
            f"<|user|>\n{inp_text.strip()}\n"
            f"<|assistant|>\n"
        )
        target_str = f"{tgt_text.strip()}<|end|>"
        prompt_ids = list(tokenizer.encode(prompt_str))
        target_ids = list(tokenizer.encode(target_str))
    else:
        prompt_ids = list(tokenizer.encode(inp_text))
        target_ids = list(tokenizer.encode(tgt_text))

    if not target_ids:
        raise ValueError("encoded target has 0 tokens")
    # Reserve space for at least 1 prompt token + target tokens inside seq_len + 1 window.
    max_total = seq_len + 1
    if len(target_ids) >= max_total:
        target_ids = target_ids[: max_total - 1]
    max_prompt = max_total - len(target_ids)
    if len(prompt_ids) > max_prompt:
        prompt_ids = prompt_ids[-max_prompt:]
    if not prompt_ids:
        prompt_ids = [target_ids[0]]

    full = prompt_ids + target_ids
    x = np.asarray(full[:-1], dtype=np.int64)
    y = np.asarray(full[1:], dtype=np.int64)
    # Position `len(prompt_ids) - 1` predicts `target_ids[0]`.
    mask = np.zeros_like(y, dtype=np.float32)
    mask[len(prompt_ids) - 1 :] = 1.0
    return x, y, mask


def collate_encoded_examples(
    encoded: list[tuple[np.ndarray, np.ndarray, np.ndarray]],
) -> list[tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """Pad variable-length sequences in `encoded` to batch arrays `(B, T_max)`."""
    if not encoded:
        return []
    max_t = max(len(x) for x, _, _ in encoded)
    B = len(encoded)
    xs = np.zeros((B, max_t), dtype=np.int64)
    ys = np.zeros((B, max_t), dtype=np.int64)
    ms = np.zeros((B, max_t), dtype=np.float32)
    for idx, (x, y, m) in enumerate(encoded):
        t = len(x)
        xs[idx, :t] = x
        ys[idx, :t] = y
        ms[idx, :t] = m
    return [(xs, ys, ms)]


def greedy_generate_reply(
    model: TransformerLM,
    tokenizer,
    prompt_text: str,
    *,
    max_new_tokens: int = 24,
    instruction_tuned: bool = True,
) -> dict:
    if instruction_tuned:
        prompt_str = (
            f"<|system|>\n{CHAT_SYSTEM_PROMPT}\n"
            f"<|context|>\nnone\n"
            f"<|user|>\n{prompt_text.strip()}\n"
            f"<|assistant|>\n"
        )
        ids = list(tokenizer.encode(prompt_str))
        stop_str = "<|end|>"
    else:
        ids = list(tokenizer.encode(prompt_text))
        stop_str = None

    if not ids:
        ids = [1]
    t0 = time.perf_counter()
    generated: list[int] = []
    for _ in range(max_new_tokens):
        window = np.asarray(ids[-model.config.seq_len :], dtype=np.int64)[None, :]
        cond = default_conditioning(model.config, 1, window.shape[1])
        logits = model.forward(window, cache=False, **cond)[0, -1]
        if not np.isfinite(logits).all():
            raise ValueError("model produced non-finite logits during inference")
        nxt = int(np.argmax(logits))
        generated.append(nxt)
        ids.append(nxt)
        if stop_str is not None and len(generated) >= 2:
            decoded_now = tokenizer.decode(generated)
            if stop_str in decoded_now:
                text = decoded_now.split(stop_str, 1)[0]
                elapsed_ms = (time.perf_counter() - t0) * 1000.0
                tok_per_s = len(generated) / max(elapsed_ms / 1000.0, 1e-6)
                return {
                    "text": text,
                    "generatedTokens": len(generated),
                    "tokenIds": generated,
                    "latencyMs": round(elapsed_ms, 3),
                    "tokensPerSecond": round(tok_per_s, 3),
                }
    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    text = tokenizer.decode(generated)
    tok_per_s = (len(generated) / max(elapsed_ms / 1000.0, 1e-6)) if generated else 0.0
    return {
        "text": text,
        "generatedTokens": len(generated),
        "tokenIds": generated,
        "latencyMs": round(elapsed_ms, 3),
        "tokensPerSecond": round(tok_per_s, 3),
    }


def evaluate_batches_loss(
    model: TransformerLM,
    batches: list[tuple[np.ndarray, np.ndarray, np.ndarray]],
) -> float:
    losses = []
    for xs, ys, ms in batches:
        cond = default_conditioning(model.config, xs.shape[0], xs.shape[1])
        logits = model.forward(xs, cache=False, **cond)
        loss, _ = masked_cross_entropy_and_dlogits(logits, ys, ms)
        losses.append(loss)
    return float(np.mean(losses)) if losses else float("nan")


def run_worker_training_job(
    job_spec: dict,
    *,
    emit_progress: Callable[[dict], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> dict:
    """Execute a validated `lightweight_adapter`, `full_fine_tune`, or `foundation_pretrain` job."""
    started = time.monotonic()
    mode = job_spec["mode"]
    if mode not in ("lightweight_adapter", "full_fine_tune", "foundation_pretrain"):
        raise ValueError(f"unsupported parameter-updating mode: {mode!r}")

    stopping = job_spec["stoppingCriteria"]
    requested_max_ms = float(stopping.get("maxDurationMs", INTERACTIVE_ADAPTER_MAX_MS))
    hard_limit_ms = (
        min(requested_max_ms, float(INTERACTIVE_ADAPTER_MAX_MS))
        if mode == "lightweight_adapter"
        else requested_max_ms
    )

    def elapsed_ms() -> float:
        return (time.monotonic() - started) * 1000.0

    def check_guards(stage: str) -> None:
        if should_cancel and should_cancel():
            raise TrainingCancelledError(f"job cancelled during {stage} at {elapsed_ms():.1f} ms")
        now_ms = elapsed_ms()
        if now_ms > hard_limit_ms:
            raise TrainingLimitExceededError(
                f"{mode} exceeded maximum wall-clock duration ({now_ms:.1f} ms > {hard_limit_ms:.1f} ms) during {stage}"
            )

    def report(phase: str, step: int, total_steps: int, train_loss=None, val_loss=None, extra=None) -> None:
        if emit_progress is None:
            return
        payload = {
            "phase": phase,
            "step": step,
            "totalSteps": total_steps,
            "trainLoss": round(float(train_loss), 6) if train_loss is not None else None,
            "valLoss": round(float(val_loss), 6) if val_loss is not None else None,
            "elapsedMs": round(elapsed_ms(), 2),
            "peakRssBytes": peak_rss_bytes(),
        }
        if extra:
            payload.update(extra)
        emit_progress(payload)

    work_dir = Path(job_spec["workDir"])
    work_dir.mkdir(parents=True, exist_ok=True)
    ckpt_path = Path(job_spec["checkpointPath"])
    output_dir = Path(job_spec["outputArtifactDir"])
    max_steps = int(stopping["maxSteps"])
    target_loss = stopping.get("targetLoss")
    checkpoint_every = max(1, int(job_spec.get("checkpointEvery", 1)))
    step_delay_ms = float(job_spec.get("stepDelayMs", 0.0))

    check_guards("initialization")
    report("initializing", 0, max_steps)

    if mode in ("lightweight_adapter", "full_fine_tune"):
        model, tokenizer, base_manifest, base_snapshot = load_installed_klyvaron_model(job_spec["baseModelDir"])
        instruction_tuned = bool(base_manifest.get("instructionTuned", False))
    else:
        # Foundation pretraining from scratch or verified checkpoint.
        if job_spec.get("baseModelDir"):
            model, tokenizer, base_manifest, base_snapshot = load_installed_klyvaron_model(job_spec["baseModelDir"])
            instruction_tuned = bool(base_manifest.get("instructionTuned", False))
        else:
            arch = config_from_architecture(job_spec["architecture"])
            tokenizer = load_tokenizer_manifest(job_spec["tokenizer"])
            model = TransformerLM(arch, seed=int(job_spec.get("seed", 42)), dtype=np.float32)
            base_manifest = None
            base_snapshot = {k: v.copy() for k, v in model.params.items()}
            instruction_tuned = False

    train_examples = job_spec["trainExamples"]
    val_examples = job_spec.get("validationExamples") or []
    train_encoded = [
        encode_input_target_example(
            tokenizer, ex, seq_len=model.config.seq_len, instruction_tuned=instruction_tuned
        )
        for ex in train_examples
    ]
    val_encoded = [
        encode_input_target_example(
            tokenizer, ex, seq_len=model.config.seq_len, instruction_tuned=instruction_tuned
        )
        for ex in val_examples
    ]
    train_batches = collate_encoded_examples(train_encoded)
    val_batches = collate_encoded_examples(val_encoded)

    loss_cfg = job_spec["trainingLoss"]
    lr = float(loss_cfg.get("learningRate", 8e-3 if mode == "lightweight_adapter" else 5e-4))
    weight_decay = float(loss_cfg.get("weightDecay", 0.01))
    seed = int(job_spec.get("seed", 20261023))

    if mode == "lightweight_adapter":
        layer_indices = loss_cfg.get("layerIndices")
        adapter = LoRAAdapter(
            base_snapshot,
            model.config,
            rank=int(loss_cfg.get("rank", 8)),
            alpha=float(loss_cfg.get("alpha", 16.0)),
            layer_indices=layer_indices,
            seed=seed,
        )
        trainable_params = adapter.params
    else:
        adapter = None
        trainable_params = model.params

    opt = AdamWOptimizer(trainable_params, lr=lr, weight_decay=weight_decay, grad_clip=1.0)
    if job_spec.get("resume") and ckpt_path.is_file():
        with np.load(ckpt_path) as ckpt_data:
            opt.load_state_arrays(trainable_params, ckpt_data)

    # Measure baseline before optimizer updates.
    if adapter is not None:
        adapter.apply_to_model(model)
    initial_train_loss = evaluate_batches_loss(model, train_batches)
    initial_val_loss = evaluate_batches_loss(model, val_batches) if val_batches else None
    pre_sample = greedy_generate_reply(
        model,
        tokenizer,
        train_examples[0]["input"],
        max_new_tokens=int(job_spec.get("evalMaxNewTokens", 16)),
        instruction_tuned=instruction_tuned,
    )

    last_train_loss = initial_train_loss
    last_grad_norm = 0.0
    last_ckpt_sha = None
    stopped_reason = "max_steps_reached"

    try:
        while opt.step_count < max_steps:
            check_guards(f"step_{opt.step_count + 1}")
            xs, ys, ms = train_batches[opt.step_count % len(train_batches)]
            if adapter is not None:
                step_loss, grads = adapter.loss_and_grads(model, xs, ys, loss_mask=ms)
            else:
                cond = default_conditioning(model.config, xs.shape[0], xs.shape[1])
                logits, cache = model.forward(xs, cache=True, **cond)
                step_loss, dlogits = masked_cross_entropy_and_dlogits(logits, ys, ms)
                grads = model.backward_from_dlogits(dlogits, cache)

            last_grad_norm = opt.step(trainable_params, grads)
            if adapter is not None:
                adapter.apply_to_model(model)
            last_train_loss = float(step_loss)

            if step_delay_ms > 0:
                time.sleep(step_delay_ms / 1000.0)

            if opt.step_count % checkpoint_every == 0 or opt.step_count == max_steps:
                last_ckpt_sha = atomic_save_npz(ckpt_path, opt.state_arrays(trainable_params))
                atomic_write_json(
                    ckpt_path.with_suffix(".meta.json"),
                    {
                        "step": opt.step_count,
                        "totalSteps": max_steps,
                        "mode": mode,
                        "sha256": last_ckpt_sha,
                        "lastTrainLoss": last_train_loss,
                    },
                )

            report(
                "training",
                opt.step_count,
                max_steps,
                train_loss=last_train_loss,
                extra={"gradNorm": round(last_grad_norm, 6), "checkpointSha256": last_ckpt_sha},
            )

            if target_loss is not None and last_train_loss <= float(target_loss):
                stopped_reason = "target_loss_reached"
                break
    except (TrainingCancelledError, TrainingLimitExceededError) as exc:
        # Save safe checkpoint if at least one step ran, restore model memory cleanly, never finalize artifact.
        if opt.step_count > 0:
            last_ckpt_sha = atomic_save_npz(ckpt_path, opt.state_arrays(trainable_params))
            atomic_write_json(
                ckpt_path.with_suffix(".meta.json"),
                {
                    "step": opt.step_count,
                    "totalSteps": max_steps,
                    "mode": mode,
                    "sha256": last_ckpt_sha,
                    "lastTrainLoss": last_train_loss,
                    "interrupted": type(exc).__name__,
                },
            )
        if adapter is not None:
            adapter.detach_from_model(model)
        raise

    # Validation & regression suite (still bounded by the 120s interactive budget!).
    check_guards("validation")
    if adapter is not None:
        adapter.apply_to_model(model)
    final_train_loss = evaluate_batches_loss(model, train_batches)
    final_val_loss = evaluate_batches_loss(model, val_batches) if val_batches else None
    post_sample = greedy_generate_reply(
        model,
        tokenizer,
        train_examples[0]["input"],
        max_new_tokens=int(job_spec.get("evalMaxNewTokens", 16)),
        instruction_tuned=instruction_tuned,
    )
    report("validating", opt.step_count, max_steps, train_loss=final_train_loss, val_loss=final_val_loss)

    regression_results = []
    for check in job_spec["regressionTests"]:
        kind = check["kind"]
        if kind == "finite_logits":
            probe_x = train_batches[0][0][:1]
            cond = default_conditioning(model.config, 1, probe_x.shape[1])
            ok = bool(np.isfinite(model.forward(probe_x, cache=False, **cond)).all())
            regression_results.append({"name": check["name"], "kind": kind, "passed": ok})
        elif kind == "target_loss_improved":
            ok = bool(final_train_loss < initial_train_loss)
            regression_results.append(
                {
                    "name": check["name"],
                    "kind": kind,
                    "passed": ok,
                    "before": round(initial_train_loss, 6),
                    "after": round(final_train_loss, 6),
                }
            )
        elif kind == "non_empty_generation":
            ok = bool(post_sample["generatedTokens"] >= 1 and len(post_sample["text"]) >= 1)
            regression_results.append(
                {"name": check["name"], "kind": kind, "passed": ok, "generatedTokens": post_sample["generatedTokens"]}
            )
        elif kind == "prompt_generation":
            probe = greedy_generate_reply(
                model,
                tokenizer,
                check["prompt"],
                max_new_tokens=int(check.get("maxNewTokens", 16)),
                instruction_tuned=instruction_tuned,
            )
            must_not = check.get("mustNotContain")
            ok = probe["generatedTokens"] >= 1 and (not must_not or must_not not in probe["text"])
            regression_results.append({"name": check["name"], "kind": kind, "passed": ok, "sample": probe["text"]})
        else:
            raise ValueError(f"unknown regression check kind: {kind!r}")

    all_regressions_passed = all(item["passed"] for item in regression_results)
    if not all_regressions_passed:
        raise ValueError(f"regression suite failed; refusing artifact promotion: {regression_results}")

    # Finalization MUST ALSO complete within the interactive 120,000 ms budget!
    check_guards("finalization_start")
    report("finalizing", opt.step_count, max_steps, train_loss=final_train_loss, val_loss=final_val_loss)

    metrics = {
        "stepsCompleted": opt.step_count,
        "stoppedReason": stopped_reason,
        "initialTrainLoss": round(initial_train_loss, 6),
        "finalTrainLoss": round(final_train_loss, 6),
        "trainPerplexityBefore": round(math.exp(min(initial_train_loss, 20.0)), 4),
        "trainPerplexityAfter": round(math.exp(min(final_train_loss, 20.0)), 4),
        "initialValLoss": round(initial_val_loss, 6) if initial_val_loss is not None else None,
        "finalValLoss": round(final_val_loss, 6) if final_val_loss is not None else None,
        "lastGradNorm": round(last_grad_norm, 6),
        "preTrainSample": pre_sample,
        "postTrainSample": post_sample,
        "regressionTests": regression_results,
        "allRegressionsPassed": all_regressions_passed,
    }
    provenance = {
        **job_spec["dataProvenance"],
        "mode": mode,
        "seed": seed,
        "checkpointSha256": last_ckpt_sha,
    }

    if mode == "lightweight_adapter":
        artifact_manifest = adapter.export(
            output_dir,
            adapter_id=job_spec["artifactId"],
            version=job_spec.get("version", "0.1.0"),
            base_manifest=base_manifest,
            objective={
                "intendedBehavior": job_spec["intendedBehavior"],
                "inputTargetFormat": job_spec["inputTargetFormat"],
                "trainingLoss": job_spec["trainingLoss"],
                "validationMethod": job_spec["validationMethod"],
                "stoppingCriteria": stopping,
            },
            metrics=metrics,
            provenance=provenance,
        )
    else:
        output_dir.mkdir(parents=True, exist_ok=True)
        artifact_id = job_spec["artifactId"]
        version = job_spec.get("version", "0.1.0")
        use_int8 = bool(job_spec.get("quantizeInt8", base_manifest and base_manifest.get("format") == QUANTIZED_ARTIFACT_FORMAT))
        weights_file = f"{artifact_id}-{version}.npz"
        weights_path = output_dir / weights_file
        if use_int8:
            packed, _ = quantize_parameters(model.params)
            file_sha = atomic_save_npz(weights_path, packed)
            fmt = QUANTIZED_ARTIFACT_FORMAT
            quant_meta = {"scheme": "symmetric-int8-per-tensor"}
        else:
            file_sha = atomic_save_npz(weights_path, model.params)
            fmt = ARTIFACT_FORMAT
            quant_meta = None

        raw_bytes = weights_path.read_bytes()
        artifact_manifest = build_manifest(
            config=model.config,
            tokenizer=tokenizer,
            weights_file=weights_file,
            weights_bytes=raw_bytes,
            weights_names=list(model.params.keys()),
            artifact_id=artifact_id,
            version=version,
            tier=job_spec.get("tier", base_manifest["tier"] if base_manifest else "lite"),
            instruction_tuned=instruction_tuned,
            generation=base_manifest.get("generation") if base_manifest else None,
            chat_template=base_manifest.get("chatTemplate") if base_manifest else None,
            differentiators=base_manifest.get("differentiators") if base_manifest else None,
            provenance={
                "origin": "first_party",
                "trainedFrom": (
                    f"checkpoint {base_manifest['id']}@{base_manifest['version']} ({base_manifest['weights']['sha256']})"
                    if base_manifest
                    else f"random initialisation (seed={seed})"
                ),
                "trainingFramework": "services/fabric/lm/adapter.py (AdamW)",
                "userJobProvenance": provenance,
            },
            limitations=(
                list(base_manifest.get("limitations", []))
                if base_manifest
                else ["Trained on user-authorized local corpus without instruction tuning; verify domain scope."]
            ),
        )
        if use_int8:
            artifact_manifest["format"] = fmt
            artifact_manifest["weights"]["quantization"] = quant_meta
        atomic_write_json(output_dir / f"{artifact_id}.klyvaron.json", artifact_manifest)
        atomic_write_bytes(output_dir / ".ready", f"{file_sha}\n".encode("utf-8"))

    # Final post-write guard: if finalizing pushed total elapsed past 120,000 ms for interactive
    # adaptation, remove `.ready` immediately so an over-budget artifact is NEVER promoted!
    try:
        check_guards("finalization_complete")
    except TrainingLimitExceededError:
        ready_marker = output_dir / ".ready"
        if ready_marker.exists():
            ready_marker.unlink()
        raise

    total_ms = round(elapsed_ms(), 2)
    rss = peak_rss_bytes()
    report("completed", opt.step_count, max_steps, train_loss=final_train_loss, val_loss=final_val_loss)
    return {
        "status": "completed",
        "mode": mode,
        "artifactDir": str(output_dir),
        "artifactId": artifact_manifest["id"],
        "artifactVersion": artifact_manifest["version"],
        "artifactFormat": artifact_manifest["format"],
        "artifactSha256": artifact_manifest["weights"]["sha256"],
        "artifactBytes": artifact_manifest["weights"]["bytes"],
        "checkpointPath": str(ckpt_path),
        "checkpointSha256": last_ckpt_sha,
        "elapsedMs": total_ms,
        "peakRssBytes": rss,
        "metrics": metrics,
        "manifest": artifact_manifest,
    }
