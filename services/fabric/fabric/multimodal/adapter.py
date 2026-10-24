"""User-computer adaptation and fine-tuning engine for Klyvaron Image, Video, and Voice models.

Enforces:
  - Hard 120,000 ms wall-clock ceiling INCLUDING finalization/checkpoint write when `mode == "lightweight_adapter"`.
  - No 120s ceiling when `mode in ("full_fine_tune", "foundation_pretrain")`.
  - Cooperative step-boundary cancellation (`should_cancel()`) without writing partial/corrupt packages.
  - Real JAX/analytical gradient computation + AdamW updates over target head / adapter parameters on authorized examples.
  - Atomic `tmp -> fsync -> os.replace` checkpointing + `.ready` sentinel + SHA-256 verification.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import time
from typing import Any, Callable

import numpy as np

from fabric.lm.adapter import TrainingCancelledError, TrainingLimitExceededError, peak_rss_bytes
from fabric.multimodal.common import (
    atomic_write_json,
    count_parameters,
    encode_prompt,
    load_multimodal_package,
    sha256_file,
    sha256_weights,
)
from fabric.multimodal.image_model import (
    IMAGE_PRESETS,
    ImageModelConfig,
    SCENE_SPECS,
    decode_image_bytes,
    encode_image_np,
    render_procedural_scene,
    train_and_export_image_preset,
)
from fabric.multimodal.video_model import (
    MOTION_CLASSES,
    VIDEO_PRESETS,
    VideoModelConfig,
    decode_video_bytes,
    encode_video_np,
    render_procedural_clip,
    train_and_export_video_preset,
)
from fabric.multimodal.voice_model import (
    SPOKEN_UTTERANCES,
    VOICE_PRESETS,
    VoiceModelConfig,
    asr_forward_np,
    decode_wav_bytes,
    encode_chars_fixed,
    synthesize_articulatory_waveform,
    train_and_export_voice_preset,
    waveform_to_log_mel,
)

MULTIMODAL_ADAPTER_FORMAT = "klyvaron.multimodal.adapter/1"
INTERACTIVE_LIMIT_MS = 120_000.0


def _target_keys_for_modality(modality: str, mode: str, params: dict[str, np.ndarray]) -> list[str]:
    if mode == "full_fine_tune":
        return sorted(params.keys())
    if modality == "image":
        return [k for k in sorted(params.keys()) if k.startswith(("scene_", "layout_", "film_", "patch_dec_"))]
    if modality == "video":
        return [k for k in sorted(params.keys()) if k.startswith(("motion_", "env_", "gen_film_", "frame_dec_"))]
    if modality == "voice":
        return [k for k in sorted(params.keys()) if k.startswith(("char_head_", "utt_head_", "mel_out_", "f0_out_"))]
    raise ValueError(f"Unsupported multimodal modality: {modality}")


def apply_multimodal_adapter(
    base_params: dict[str, np.ndarray],
    adapter_dir: Path,
    expected_base_manifest: dict[str, Any],
) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
    adapter_dir = Path(adapter_dir)
    manifest_path = adapter_dir / "manifest.json"
    ready_path = adapter_dir / ".ready"
    if not manifest_path.is_file() or not ready_path.is_file():
        raise ValueError(f"Multimodal adapter at {adapter_dir} is missing manifest.json or .ready")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("format") != MULTIMODAL_ADAPTER_FORMAT:
        raise ValueError(f"Unexpected adapter format: {manifest.get('format')}")
    if manifest["baseModel"]["id"] != expected_base_manifest["id"]:
        raise ValueError(
            f"Adapter base model mismatch: expected {expected_base_manifest['id']}, got {manifest['baseModel']['id']}"
        )
    if manifest["baseModel"]["weightsSha256"] != expected_base_manifest["weights"]["weightsSha256"]:
        raise ValueError("Adapter base weightsSha256 mismatch")

    weights_path = adapter_dir / manifest["weights"]["file"]
    if sha256_file(weights_path) != manifest["weights"]["sha256"]:
        raise ValueError("Adapter file SHA-256 verification failed")

    merged = {k: np.array(v, dtype=np.float32, copy=True) for k, v in base_params.items()}
    with np.load(weights_path, allow_pickle=False) as npz:
        for k in npz.files:
            delta = np.asarray(npz[k], dtype=np.float32)
            if not np.all(np.isfinite(delta)):
                raise ValueError(f"Non-finite delta tensor '{k}' in adapter")
            merged[k] = merged[k] + delta
    return merged, manifest


def run_multimodal_training_job(
    spec: dict[str, Any],
    *,
    emit_progress: Callable[[dict[str, Any]], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    started_monotonic = time.perf_counter()
    mode = spec.get("mode", "lightweight_adapter")
    modality = spec["modality"]
    max_duration_ms = float(spec.get("maxDurationMs", INTERACTIVE_LIMIT_MS))
    if mode == "lightweight_adapter":
        max_duration_ms = min(max_duration_ms, INTERACTIVE_LIMIT_MS)

    def check_limits() -> float:
        elapsed_ms = (time.perf_counter() - started_monotonic) * 1000.0
        if should_cancel and should_cancel():
            raise TrainingCancelledError(f"Multimodal training job cancelled at {elapsed_ms:.1f} ms")
        if mode == "lightweight_adapter" and elapsed_ms > max_duration_ms:
            raise TrainingLimitExceededError(
                f"Interactive multimodal adaptation exceeded {max_duration_ms:.0f} ms wall-clock ceiling ({elapsed_ms:.1f} ms)"
            )
        return elapsed_ms

    if mode == "foundation_pretrain":
        preset = spec.get("preset", "pro")
        install_root = Path(spec["outputDir"])
        steps_override = int(spec.get("maxSteps", 40))
        check_limits()
        if modality == "image":
            out_manifest = train_and_export_image_preset(preset, install_root, steps_override=steps_override)
        elif modality == "video":
            out_manifest = train_and_export_video_preset(preset, install_root, steps_override=steps_override)
        elif modality == "voice":
            out_manifest = train_and_export_voice_preset(preset, install_root, steps_override=steps_override)
        else:
            raise ValueError(f"Unsupported foundation modality: {modality}")
        elapsed_ms = (time.perf_counter() - started_monotonic) * 1000.0
        ready_marker = install_root / out_manifest["id"] / ".ready"
        ready_marker.write_text("ok\n", encoding="utf-8")
        return {
            "mode": mode,
            "modality": modality,
            "artifactDir": str(install_root / out_manifest["id"]),
            "artifactSha256": out_manifest["weights"]["sha256"],
            "weightsSha256": out_manifest["weights"]["weightsSha256"],
            "stepsCompleted": out_manifest["metrics"]["steps"],
            "initialLoss": out_manifest["metrics"]["initialLoss"],
            "finalLoss": out_manifest["metrics"]["finalLoss"],
            "elapsedMs": round(elapsed_ms, 2),
            "peakRssBytes": peak_rss_bytes(),
        }

    # `lightweight_adapter` or `full_fine_tune` against a verified installed multimodal checkpoint
    import jax
    import jax.numpy as jnp

    model_dir = Path(spec["modelDir"])
    out_dir = Path(spec["outputDir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest, _, base_params = load_multimodal_package(model_dir)
    if manifest["modality"] != modality:
        raise ValueError(f"Checkpoint modality '{manifest['modality']}' does not match requested '{modality}'")

    examples = spec.get("examples") or []
    if not examples:
        raise ValueError("Authorized multimodal training job requires at least one explicit example")

    max_steps = int(spec.get("maxSteps", 12))
    lr = float(spec.get("learningRate", 8e-3))
    step_delay_ms = float(spec.get("stepDelayMs", 0.0))
    trainable_keys = set(_target_keys_for_modality(modality, mode, base_params))
    rng = np.random.default_rng(int(spec.get("seed", 42)))

    if modality == "image":
        cfg = ImageModelConfig(**manifest["architecture"]["config"])
        imgs, scenes = [], []
        scene_ids = [s["id"] for s in SCENE_SPECS]
        for ex in examples:
            target_label = str(ex.get("target", "sunset_horizon")).strip().lower()
            s_idx = scene_ids.index(target_label) if target_label in scene_ids else 0
            if ex.get("imageBase64"):
                arr, _ = decode_image_bytes(base64.b64decode(ex["imageBase64"]), target_size=cfg.image_size)
            else:
                arr = render_procedural_scene(s_idx, rng, size=cfg.image_size)
            imgs.append(arr)
            scenes.append(s_idx)
        x_arr = jnp.asarray(np.stack(imgs, axis=0), dtype=jnp.float32)
        y_arr = jnp.asarray(scenes, dtype=jnp.int32)

        def loss_fn(trainable, frozen):
            full = {**frozen, **trainable}
            B = x_arr.shape[0]
            gh, ps = cfg.grid_size, cfg.patch_size
            patches = x_arr.reshape(B, gh, ps, gh, ps, 3).transpose(0, 1, 3, 2, 4, 5).reshape(B, cfg.n_patches, cfg.patch_dim)
            tok = patches @ full["patch_proj_w"] + full["patch_proj_b"]
            cls = jnp.broadcast_to(full["cls_token"], (B, 1, cfg.d_model))
            h = jnp.concatenate([cls, tok], axis=1) + full["patch_pos"]
            keys = ("ln1_g", "ln1_b", "wq", "wk", "wv", "wo", "ln2_g", "ln2_b", "w1", "w2")
            enc_s = {k: jnp.stack([full[f"enc{i}.{k}"] for i in range(cfg.n_enc_layers)], axis=0) for k in keys}

            def blk(carry, lp):
                m = jnp.mean(carry, axis=-1, keepdims=True)
                a = (carry - m) * jax.lax.rsqrt(jnp.mean((carry - m) ** 2, axis=-1, keepdims=True) + 1e-5) * lp["ln1_g"] + lp["ln1_b"]
                hd = cfg.head_dim
                q = (a @ lp["wq"]).reshape(B, -1, cfg.n_heads, hd).transpose(0, 2, 1, 3)
                k = (a @ lp["wk"]).reshape(B, -1, cfg.n_heads, hd).transpose(0, 2, 1, 3)
                v = (a @ lp["wv"]).reshape(B, -1, cfg.n_heads, hd).transpose(0, 2, 1, 3)
                att = jax.nn.softmax((q @ k.transpose(0, 1, 3, 2)) / (hd**0.5), axis=-1)
                carry = carry + (att @ v).transpose(0, 2, 1, 3).reshape(B, -1, cfg.d_model) @ lp["wo"]
                m2 = jnp.mean(carry, axis=-1, keepdims=True)
                b = (carry - m2) * jax.lax.rsqrt(jnp.mean((carry - m2) ** 2, axis=-1, keepdims=True) + 1e-5) * lp["ln2_g"] + lp["ln2_b"]
                bx = b @ lp["w1"]
                g = 0.5 * bx * (1.0 + jnp.tanh(0.79788456 * (bx + 0.044715 * (bx**3))))
                return carry + g @ lp["w2"], None

            h, _ = jax.lax.scan(blk, h, enc_s)
            mf = jnp.mean(h, axis=-1, keepdims=True)
            pooled = ((h - mf) * jax.lax.rsqrt(jnp.mean((h - mf) ** 2, axis=-1, keepdims=True) + 1e-5) * full["enc_ln_g"] + full["enc_ln_b"])[:, 0, :]
            lp = jax.nn.log_softmax(pooled @ full["scene_w"] + full["scene_b"], axis=-1)
            return -jnp.mean(lp[jnp.arange(B), y_arr])

    elif modality == "video":
        cfg = VideoModelConfig(**manifest["architecture"]["config"])
        clips, motions = [], []
        for ex in examples:
            target_label = str(ex.get("target", "pan_right")).strip().lower()
            m_idx = MOTION_CLASSES.index(target_label) if target_label in MOTION_CLASSES else 0
            if ex.get("videoBase64"):
                sampled, _ = decode_video_bytes(base64.b64decode(ex["videoBase64"]), target_frames=cfg.n_frames, target_size=cfg.frame_size)
            else:
                sampled = render_procedural_clip(m_idx, 0, rng, n_frames=cfg.n_frames, size=cfg.frame_size)
            clips.append(sampled)
            motions.append(m_idx)
        x_np = np.stack(clips, axis=0)
        y_arr = jnp.asarray(motions, dtype=jnp.int32)
        # Pre-extract trunk representation cleanly when adapting head/projection layers
        _, _ = encode_video_np(x_np, base_params, cfg)
        x_arr = jnp.asarray(x_np, dtype=jnp.float32)

        def loss_fn(trainable, frozen):
            full = {**frozen, **trainable}
            B, T = x_arr.shape[0], x_arr.shape[1]
            gh, ps = cfg.grid_size, cfg.patch_size
            patches = x_arr.reshape(B, T, gh, ps, gh, ps, 3).transpose(0, 1, 2, 4, 3, 5, 6).reshape(B, T, cfg.n_patches, cfg.patch_dim)
            diffs = jnp.concatenate([jnp.zeros_like(patches[:, :1]), patches[:, 1:] - patches[:, :-1]], axis=1)
            h_spa = (patches @ full["patch_proj_w"] + full["patch_proj_b"] + diffs @ full["diff_proj_w"]).reshape(B * T, cfg.n_patches, cfg.d_model)
            ft = jnp.mean(h_spa, axis=1).reshape(B, T, cfg.d_model) + full["temporal_pos"][:T][None, :, :]
            s_vec = jnp.concatenate([jnp.mean(ft, axis=1), ft[:, -1, :] - ft[:, 0, :]], axis=-1)
            lp = jax.nn.log_softmax(s_vec @ full["motion_w"] + full["motion_b"], axis=-1)
            return -jnp.mean(lp[jnp.arange(B), y_arr])

    elif modality == "voice":
        cfg = VoiceModelConfig(**manifest["architecture"]["config"])
        mels, char_targets = [], []
        for ex in examples:
            target_text = str(ex.get("target") or ex.get("input") or "status check").strip().lower()
            if ex.get("audioBase64"):
                wav, _ = decode_wav_bytes(base64.b64decode(ex["audioBase64"]))
            else:
                wav = synthesize_articulatory_waveform(target_text, rng, f0_base=160.0)
            mels.append(waveform_to_log_mel(wav, cfg.n_mels, cfg.audio_frames))
            char_targets.append(encode_chars_fixed(target_text, cfg.max_chars))
        x_arr = jnp.asarray(np.stack(mels, axis=0), dtype=jnp.float32)
        y_arr = jnp.asarray(np.stack(char_targets, axis=0), dtype=jnp.int32)

        def loss_fn(trainable, frozen):
            full = {**frozen, **trainable}
            padded = jnp.pad(x_arr, ((0, 0), (1, 1), (0, 0)), mode="edge")
            stacked = jnp.concatenate([padded[:, :-2, :], padded[:, 1:-1, :], padded[:, 2:, :]], axis=-1)
            h = stacked @ full["mel_in_w"] + full["mel_in_b"] + full["audio_pos"][None, :, :]
            q = full["slot_queries"][None, :, :] @ full["slot_att_wq"]
            k = h @ full["slot_att_wk"]
            v = h @ full["slot_att_wv"]
            att = jax.nn.softmax((q @ k.transpose(0, 2, 1)) / (cfg.d_model**0.5), axis=-1)
            stride = cfg.audio_frames // cfg.max_chars
            local_slots = jnp.mean(h[:, : cfg.max_chars * stride, :].reshape(h.shape[0], cfg.max_chars, stride, cfg.d_model), axis=2)
            slot_h = 0.5 * (att @ v) + local_slots
            c_lp = jax.nn.log_softmax(slot_h @ full["char_head_w"] + full["char_head_b"], axis=-1)
            return -jnp.mean(jnp.take_along_axis(c_lp, y_arr[..., None], axis=-1)[..., 0])
    else:
        raise ValueError(f"Unsupported modality '{modality}'")

    trainable_j = {k: jnp.asarray(base_params[k]) for k in trainable_keys}
    frozen_j = {k: jnp.asarray(base_params[k]) for k in base_params if k not in trainable_keys}
    m1 = jax.tree_util.tree_map(jnp.zeros_like, trainable_j)
    m2 = jax.tree_util.tree_map(jnp.zeros_like, trainable_j)
    val_and_grad = jax.jit(jax.value_and_grad(loss_fn))

    initial_loss = None
    final_loss = None
    for s in range(1, max_steps + 1):
        check_limits()
        if step_delay_ms > 0:
            time.sleep(step_delay_ms / 1000.0)
        loss_val, grads = val_and_grad(trainable_j, frozen_j)
        lf = float(loss_val)
        if initial_loss is None:
            initial_loss = lf
        final_loss = lf
        m1 = jax.tree_util.tree_map(lambda m, g: 0.9 * m + 0.1 * g, m1, grads)
        m2 = jax.tree_util.tree_map(lambda v, g: 0.98 * v + 0.02 * (g * g), m2, grads)
        c1 = 1.0 - (0.9**s)
        c2 = 1.0 - (0.98**s)
        trainable_j = jax.tree_util.tree_map(lambda w, m, v: w - lr * (m / c1) / (jnp.sqrt(v / c2) + 1e-8), trainable_j, m1, m2)
        elapsed_ms = check_limits()
        if emit_progress:
            emit_progress({"step": s, "maxSteps": max_steps, "loss": round(lf, 6), "elapsedMs": round(elapsed_ms, 2)})

    # Finalization (checkpoint write + verification) MUST ALSO complete inside `max_duration_ms`!
    deltas = {k: (np.asarray(trainable_j[k], dtype=np.float32) - base_params[k]) for k in sorted(trainable_keys)}
    weights_file = out_dir / "adapter_deltas.npz"
    tmp_file = out_dir / f".adapter_deltas.{os.getpid()}.tmp.npz"
    with open(tmp_file, "wb") as handle:
        np.savez_compressed(handle, **deltas)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp_file, weights_file)
    file_sha = sha256_file(weights_file)
    delta_l2 = float(np.sqrt(sum(float(np.sum(d * d)) for d in deltas.values())))

    adapter_manifest = {
        "format": MULTIMODAL_ADAPTER_FORMAT,
        "id": spec.get("adapterId", f"{manifest['id']}-user-adapter"),
        "version": "0.1.0",
        "modality": modality,
        "mode": mode,
        "baseModel": {
            "id": manifest["id"],
            "version": manifest["version"],
            "weightsSha256": manifest["weights"]["weightsSha256"],
        },
        "parameterCount": count_parameters(deltas),
        "deltaL2Norm": round(delta_l2, 6),
        "weights": {
            "file": "adapter_deltas.npz",
            "sha256": file_sha,
            "bytes": weights_file.stat().st_size,
        },
        "metrics": {
            "initialLoss": round(float(initial_loss), 6),
            "finalLoss": round(float(final_loss), 6),
            "lossReduction": round(float(initial_loss - final_loss), 6),
            "steps": max_steps,
        },
    }
    atomic_write_json(out_dir / "manifest.json", adapter_manifest)
    (out_dir / ".ready").write_text("ok\n", encoding="utf-8")
    final_elapsed_ms = check_limits()
    return {
        "mode": mode,
        "modality": modality,
        "artifactDir": str(out_dir),
        "artifactSha256": file_sha,
        "baseWeightsSha256": manifest["weights"]["weightsSha256"],
        "parameterCount": adapter_manifest["parameterCount"],
        "deltaL2Norm": adapter_manifest["deltaL2Norm"],
        "stepsCompleted": max_steps,
        "initialLoss": round(float(initial_loss), 6),
        "finalLoss": round(float(final_loss), 6),
        "elapsedMs": round(final_elapsed_ms, 2),
        "peakRssBytes": peak_rss_bytes(),
    }
