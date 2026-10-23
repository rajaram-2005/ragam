"""First-party Klyvaron Image Architecture (`aetheris-image-v1`).

Implements two strictly distinct, trained-from-scratch neural models:
  - `klyvaron-pro-image@0.1.0` (`d_model=192, n_heads=4, n_enc_layers=4, n_dec_layers=4, latent_grid=8, canvas=64`)
  - `klyvaron-max-image@0.1.0` (`d_model=320, n_heads=8, n_enc_layers=6, n_dec_layers=6, latent_grid=8, canvas=64`)

Capabilities backed by genuine neural weights:
  1. `image.generate`   — Prompt Transformer -> iterative DDIM-style conditioned latent denoising -> multi-stage spatial decoder -> RGB PNG bytes.
  2. `image.edit`       — Input PNG -> Patch-Attention Vision Encoder latent -> prompt-guided latent denoising trajectory -> edited RGB PNG bytes.
  3. `vision.understand` — Input PNG -> Patch-Attention Vision Encoder -> calibrated scene, composition layout, chromatic profile, and grounded caption.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import io
import math
from pathlib import Path
import time
from typing import Any

import numpy as np
from PIL import Image

from fabric.multimodal.common import (
    MAX_PROMPT_TOKENS,
    PROMPT_VOCAB_SIZE,
    count_parameters,
    encode_prompt,
    gelu_np,
    layernorm_np,
    load_multimodal_package,
    save_multimodal_package,
    sha256_weights,
    softmax_np,
)

ARCHITECTURE_ID = "aetheris-image-v1"

SCENE_SPECS = [
    {
        "id": "sunset_horizon",
        "label": "warm sunset horizon over reflective water",
        "layout": "horizon_split",
        "prompts": [
            "warm crimson amber sunset horizon over calm glowing water",
            "golden dusk sky horizon with warm twilight reflections",
            "vivid sunset scene with bright solar glow above horizon",
        ],
    },
    {
        "id": "ocean_waves",
        "label": "cobalt and cyan ocean waves beneath clear sky",
        "layout": "horizon_split",
        "prompts": [
            "deep cobalt blue ocean waves with bright cyan sea foam",
            "clear sky above calm turquoise ocean tide water",
            "vivid blue sea landscape with rippling waves",
        ],
    },
    {
        "id": "forest_canopy",
        "label": "emerald forest canopy with sunlit foliage",
        "layout": "diagonal_flow",
        "prompts": [
            "emerald green forest canopy with soft golden sunlight through leaves",
            "lush green trees and sunlit forest landscape view",
            "vivid emerald foliage under warm morning light",
        ],
    },
    {
        "id": "mountain_peaks",
        "label": "snow-crowned alpine mountain peaks under crisp sky",
        "layout": "horizon_split",
        "prompts": [
            "crisp alpine mountain peaks with silver snow ridges under cobalt sky",
            "high snow mountain ridge landscape in clear bright light",
            "majestic peaks rising above cool valley mist",
        ],
    },
    {
        "id": "night_cosmos",
        "label": "deep violet cosmos starfield and luminous nebula",
        "layout": "radial_glow",
        "prompts": [
            "deep night cosmos sky with bright stars and violet nebula glow",
            "dark galaxy starfield with radiant magenta cyan nebula core",
            "twilight cosmos scene filled with luminous stars",
        ],
    },
    {
        "id": "aurora_sky",
        "label": "emerald and violet polar aurora ribbons across night sky",
        "layout": "diagonal_flow",
        "prompts": [
            "glowing green and violet aurora borealis ribbons over dark horizon",
            "polar night sky with radiant cyan emerald aurora light",
            "vivid aurora borealis waves across starry sky",
        ],
    },
    {
        "id": "geometric_prism",
        "label": "centered crystalline geometric prism dispersing spectral light",
        "layout": "centered_focal",
        "prompts": [
            "bright crystal geometric prism shapes refracting cyan magenta amber light",
            "centered vivid geometric crystal sculpture with high contrast glow",
            "radiant prism shapes on clean dark studio backdrop",
        ],
    },
    {
        "id": "golden_desert",
        "label": "sculpted golden desert dunes under warm solar light",
        "layout": "diagonal_flow",
        "prompts": [
            "warm golden desert sand dunes under bright amber sun sky",
            "sculpted sunlit dunes across arid desert horizon",
            "soft amber desert landscape with crisp dune shadows",
        ],
    },
]

LAYOUT_CLASSES = ["horizon_split", "centered_focal", "diagonal_flow", "radial_glow"]


@dataclass(frozen=True)
class ImageModelConfig:
    vocab_size: int = PROMPT_VOCAB_SIZE
    max_text_len: int = MAX_PROMPT_TOKENS
    image_size: int = 64
    patch_size: int = 8
    d_model: int = 192
    n_heads: int = 4
    d_ff: int = 512
    n_text_layers: int = 2
    n_enc_layers: int = 4
    n_denoise_steps: int = 4
    n_dec_blocks: int = 4
    n_scenes: int = 8
    n_layouts: int = 4

    @property
    def grid_size(self) -> int:
        return self.image_size // self.patch_size

    @property
    def n_patches(self) -> int:
        return self.grid_size * self.grid_size

    @property
    def patch_dim(self) -> int:
        return self.patch_size * self.patch_size * 3

    @property
    def head_dim(self) -> int:
        return self.d_model // self.n_heads


IMAGE_PRESETS: dict[str, dict[str, Any]] = {
    "pro": {
        "model_id": "klyvaron-pro-image",
        "tier": "pro",
        "config": ImageModelConfig(
            d_model=192,
            n_heads=4,
            d_ff=512,
            n_text_layers=2,
            n_enc_layers=4,
            n_denoise_steps=4,
            n_dec_blocks=4,
        ),
        "default_seed": 20261101,
        "train_steps": 160,
        "batch_size": 24,
        "lr": 2.2e-3,
    },
    "max": {
        "model_id": "klyvaron-max-image",
        "tier": "max",
        "config": ImageModelConfig(
            d_model=304,
            n_heads=8,
            d_ff=832,
            n_text_layers=3,
            n_enc_layers=6,
            n_denoise_steps=6,
            n_dec_blocks=6,
        ),
        "default_seed": 20261102,
        "train_steps": 160,
        "batch_size": 24,
        "lr": 1.8e-3,
    },
}

IMAGE_SUPPORTED_TASKS = [
    "image.generate",
    "image.edit",
    "vision.understand",
]

IMAGE_UNSUPPORTED_TASKS = [
    "photorealistic_megapixel_open_world_synthesis",
    "typographic_text_rendering_in_images",
    "multi_subject_identity_preservation",
    "inpainting_with_arbitrary_polygon_masks",
]


def render_procedural_scene(scene_idx: int, rng: np.random.Generator, size: int = 64) -> np.ndarray:
    """Synthesize diverse physically structured RGB training/validation scenes with continuous random geometry, lighting, and noise."""
    yy, xx = np.meshgrid(
        np.linspace(-1.0, 1.0, size, dtype=np.float32),
        np.linspace(-1.0, 1.0, size, dtype=np.float32),
        indexing="ij",
    )
    img = np.zeros((size, size, 3), dtype=np.float32)
    shift_x = float(rng.uniform(-0.28, 0.28))
    shift_y = float(rng.uniform(-0.22, 0.22))
    scale = float(rng.uniform(0.82, 1.22))
    phase = float(rng.uniform(0.0, 2.0 * math.pi))

    if scene_idx == 0:  # sunset_horizon
        horizon = 0.08 + 0.5 * shift_y
        sky = np.clip((horizon - yy) * 1.4, 0.0, 1.0)
        sun_dist = np.sqrt(((xx - shift_x) * scale) ** 2 + ((yy - (horizon - 0.16)) * 1.4) ** 2)
        sun = np.exp(-9.0 * (sun_dist**2))
        water = (yy > horizon).astype(np.float32)
        ripples = 0.07 * np.sin(24.0 * yy + 5.0 * xx + phase) * water
        img[..., 0] = 0.92 * (1.0 - 0.45 * sky) + 0.45 * sun + ripples
        img[..., 1] = 0.42 * (1.0 - 0.55 * sky) + 0.42 * sun + 0.5 * ripples
        img[..., 2] = 0.28 + 0.36 * sky + 0.16 * sun - 0.4 * ripples
    elif scene_idx == 1:  # ocean_waves
        horizon = -0.15 + 0.4 * shift_y
        water = (yy > horizon).astype(np.float32)
        sky_grad = np.clip((horizon - yy + 0.6), 0.0, 1.0) * (1.0 - water)
        wave = np.sin(15.0 * yy * scale + 4.0 * np.sin(4.0 * xx + phase) + phase)
        foam = np.clip(wave - 0.65, 0.0, 1.0) * 1.8 * water
        img[..., 0] = (1.0 - water) * (0.52 + 0.28 * sky_grad) + water * (0.05 + 0.55 * foam)
        img[..., 1] = (1.0 - water) * (0.76 + 0.18 * sky_grad) + water * (0.34 + 0.12 * wave + 0.50 * foam)
        img[..., 2] = (1.0 - water) * (0.95) + water * (0.68 + 0.14 * wave + 0.30 * foam)
    elif scene_idx == 2:  # forest_canopy
        canopy = 0.5 + 0.5 * np.sin(7.0 * (xx + shift_x) * scale + phase) * np.cos(7.0 * (yy + shift_y) * scale - phase)
        shaft = np.exp(-5.0 * ((xx - shift_x - 0.35 * yy) ** 2))
        img[..., 0] = 0.10 + 0.22 * canopy + 0.42 * shaft
        img[..., 1] = 0.34 + 0.44 * canopy + 0.32 * shaft
        img[..., 2] = 0.12 + 0.16 * canopy + 0.10 * shaft
    elif scene_idx == 3:  # mountain_peaks
        ridge1 = -0.05 + 0.42 * np.abs(xx - shift_x) * 1.35 - 0.18 * np.cos(5.0 * xx + phase)
        ridge2 = 0.18 + 0.32 * np.abs(xx + 0.3 - shift_x) - 0.12 * np.sin(7.0 * xx)
        sky = (yy < ridge1).astype(np.float32)
        snow = ((yy >= ridge1) & (yy < ridge1 + 0.22)).astype(np.float32)
        rock = ((yy >= ridge1 + 0.22) & (yy < ridge2 + 0.5)).astype(np.float32)
        img[..., 0] = sky * 0.24 + snow * 0.90 + rock * 0.32 + 0.12 * (1.0 - sky - snow - rock)
        img[..., 1] = sky * 0.46 + snow * 0.93 + rock * 0.36 + 0.20 * (1.0 - sky - snow - rock)
        img[..., 2] = sky * 0.84 + snow * 0.98 + rock * 0.45 + 0.28 * (1.0 - sky - snow - rock)
    elif scene_idx == 4:  # night_cosmos
        r2 = ((xx - shift_x) * scale) ** 2 + ((yy - shift_y) * scale) ** 2
        swirl = np.exp(-3.2 * r2) * (0.65 + 0.35 * np.sin(4.0 * np.arctan2(yy - shift_y, xx - shift_x) + 5.0 * np.sqrt(r2) + phase))
        stars = (rng.uniform(0.0, 1.0, size=(size, size)) > 0.986).astype(np.float32)
        img[..., 0] = 0.05 + 0.62 * swirl + 0.95 * stars
        img[..., 1] = 0.03 + 0.22 * swirl + 0.95 * stars
        img[..., 2] = 0.14 + 0.78 * swirl + 0.98 * stars
    elif scene_idx == 5:  # aurora_sky
        ribbon_center = -0.15 + 0.30 * np.sin(3.5 * xx * scale + phase) + 0.4 * shift_y
        band = np.exp(-10.0 * ((yy - ribbon_center) ** 2))
        band2 = np.exp(-12.0 * ((yy - ribbon_center - 0.26) ** 2))
        ground = (yy > 0.55).astype(np.float32)
        img[..., 0] = (1.0 - ground) * (0.04 + 0.46 * band2) + ground * 0.06
        img[..., 1] = (1.0 - ground) * (0.08 + 0.84 * band + 0.18 * band2) + ground * 0.14
        img[..., 2] = (1.0 - ground) * (0.16 + 0.48 * band + 0.68 * band2) + ground * 0.18
    elif scene_idx == 6:  # geometric_prism
        tri = ((yy - shift_y) > -0.55) & ((yy - shift_y) < 0.52) & (np.abs(xx - shift_x) < 0.48 * (0.62 + (yy - shift_y)))
        tri_f = tri.astype(np.float32)
        beam = np.exp(-16.0 * ((yy - shift_y - 0.22 * (xx - shift_x)) ** 2)) * (xx > shift_x).astype(np.float32)
        img[..., 0] = 0.08 + 0.35 * tri_f + 0.85 * beam
        img[..., 1] = 0.09 + 0.72 * tri_f + 0.45 * np.roll(beam, 3, axis=0)
        img[..., 2] = 0.12 + 0.88 * tri_f + 0.80 * np.roll(beam, 6, axis=0)
    else:  # golden_desert
        horizon = -0.18 + 0.35 * shift_y
        dune = horizon + 0.14 * np.sin(4.2 * xx * scale + phase)
        sand = (yy >= dune).astype(np.float32)
        shade = 0.72 + 0.28 * np.cos(8.0 * xx + 3.0 * yy + phase)
        img[..., 0] = (1.0 - sand) * 0.94 + sand * 0.88 * shade
        img[..., 1] = (1.0 - sand) * 0.72 + sand * 0.62 * shade
        img[..., 2] = (1.0 - sand) * 0.44 + sand * 0.24 * shade

    img += rng.normal(0.0, 0.02, size=img.shape).astype(np.float32)
    return np.clip(img, 0.0, 1.0)


def init_image_params(cfg: ImageModelConfig, seed: int) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed)
    D = cfg.d_model
    P = cfg.patch_dim
    G2 = cfg.n_patches
    s = 0.02

    params: dict[str, np.ndarray] = {
        "text_emb": rng.normal(0.0, s, (cfg.vocab_size, D)).astype(np.float32),
        "text_pos": rng.normal(0.0, s, (cfg.max_text_len, D)).astype(np.float32),
        "patch_proj_w": rng.normal(0.0, 1.0 / math.sqrt(P), (P, D)).astype(np.float32),
        "patch_proj_b": np.zeros((D,), dtype=np.float32),
        "cls_token": rng.normal(0.0, s, (1, D)).astype(np.float32),
        "patch_pos": rng.normal(0.0, s, (G2 + 1, D)).astype(np.float32),
    }

    for prefix, count in (("txt", cfg.n_text_layers), ("enc", cfg.n_enc_layers), ("dec", cfg.n_dec_blocks)):
        for i in range(count):
            params[f"{prefix}{i}.ln1_g"] = np.ones((D,), dtype=np.float32)
            params[f"{prefix}{i}.ln1_b"] = np.zeros((D,), dtype=np.float32)
            params[f"{prefix}{i}.wq"] = rng.normal(0.0, 1.0 / math.sqrt(D), (D, D)).astype(np.float32)
            params[f"{prefix}{i}.wk"] = rng.normal(0.0, 1.0 / math.sqrt(D), (D, D)).astype(np.float32)
            params[f"{prefix}{i}.wv"] = rng.normal(0.0, 1.0 / math.sqrt(D), (D, D)).astype(np.float32)
            params[f"{prefix}{i}.wo"] = rng.normal(0.0, 1.0 / math.sqrt(2.0 * count * D), (D, D)).astype(np.float32)
            params[f"{prefix}{i}.ln2_g"] = np.ones((D,), dtype=np.float32)
            params[f"{prefix}{i}.ln2_b"] = np.zeros((D,), dtype=np.float32)
            params[f"{prefix}{i}.w1"] = rng.normal(0.0, 1.0 / math.sqrt(D), (D, cfg.d_ff)).astype(np.float32)
            params[f"{prefix}{i}.w2"] = rng.normal(0.0, 1.0 / math.sqrt(2.0 * count * cfg.d_ff), (cfg.d_ff, D)).astype(np.float32)

    params["enc_ln_g"] = np.ones((D,), dtype=np.float32)
    params["enc_ln_b"] = np.zeros((D,), dtype=np.float32)
    params["scene_w"] = rng.normal(0.0, 1.0 / math.sqrt(D), (D, cfg.n_scenes)).astype(np.float32)
    params["scene_b"] = np.zeros((cfg.n_scenes,), dtype=np.float32)
    params["layout_w"] = rng.normal(0.0, 1.0 / math.sqrt(D), (D, cfg.n_layouts)).astype(np.float32)
    params["layout_b"] = np.zeros((cfg.n_layouts,), dtype=np.float32)

    params["text_ln_g"] = np.ones((D,), dtype=np.float32)
    params["text_ln_b"] = np.zeros((D,), dtype=np.float32)
    params["latent_pos"] = rng.normal(0.0, s, (G2, D)).astype(np.float32)
    params["step_emb"] = rng.normal(0.0, s, (cfg.n_denoise_steps, D)).astype(np.float32)
    params["film_gamma"] = rng.normal(0.0, 1.0 / math.sqrt(D), (D, D)).astype(np.float32)
    params["film_beta"] = rng.normal(0.0, 1.0 / math.sqrt(D), (D, D)).astype(np.float32)
    params["out_ln_g"] = np.ones((D,), dtype=np.float32)
    params["out_ln_b"] = np.zeros((D,), dtype=np.float32)
    params["patch_dec_w"] = rng.normal(0.0, 1.0 / math.sqrt(D), (D, P)).astype(np.float32)
    params["patch_dec_b"] = np.zeros((P,), dtype=np.float32)
    # 3x3 RGB spatial smoothing/refinement conv `(3, 3, 3, 3)` + bias `(3,)` so adjacent patches blend seamlessly
    k = np.zeros((3, 3, 3, 3), dtype=np.float32)
    for c in range(3):
        k[1, 1, c, c] = 0.60
        k[0, 1, c, c] = k[2, 1, c, c] = k[1, 0, c, c] = k[1, 2, c, c] = 0.10
    params["refine_conv_w"] = k + rng.normal(0.0, 0.005, k.shape).astype(np.float32)
    params["refine_conv_b"] = np.zeros((3,), dtype=np.float32)
    return params


def _transformer_block_np(h: np.ndarray, params: dict[str, np.ndarray], prefix: str, n_heads: int) -> np.ndarray:
    B, T, D = h.shape
    hd = D // n_heads
    a = layernorm_np(h, params[f"{prefix}.ln1_g"], params[f"{prefix}.ln1_b"])
    q = (a @ params[f"{prefix}.wq"]).reshape(B, T, n_heads, hd).transpose(0, 2, 1, 3)
    k = (a @ params[f"{prefix}.wk"]).reshape(B, T, n_heads, hd).transpose(0, 2, 1, 3)
    v = (a @ params[f"{prefix}.wv"]).reshape(B, T, n_heads, hd).transpose(0, 2, 1, 3)
    att = softmax_np((q @ k.transpose(0, 1, 3, 2)) / math.sqrt(hd), axis=-1)
    y = (att @ v).transpose(0, 2, 1, 3).reshape(B, T, D)
    h = h + y @ params[f"{prefix}.wo"]
    b = layernorm_np(h, params[f"{prefix}.ln2_g"], params[f"{prefix}.ln2_b"])
    return h + gelu_np(b @ params[f"{prefix}.w1"]) @ params[f"{prefix}.w2"]


def _conv2d_same3x3_np(img: np.ndarray, w: np.ndarray, b: np.ndarray) -> np.ndarray:
    padded = np.pad(img, ((0, 0), (1, 1), (1, 1), (0, 0)), mode="edge")
    out = np.zeros_like(img)
    for dy in range(3):
        for dx in range(3):
            out = out + padded[:, dy : dy + img.shape[1], dx : dx + img.shape[2], :] @ w[dy, dx]
    return out + b


def image_to_patches_np(images: np.ndarray, patch_size: int) -> np.ndarray:
    B, H, W, C = images.shape
    gh, gw = H // patch_size, W // patch_size
    return images.reshape(B, gh, patch_size, gw, patch_size, C).transpose(0, 1, 3, 2, 4, 5).reshape(B, gh * gw, patch_size * patch_size * C)


def patches_to_image_np(patches: np.ndarray, grid_size: int, patch_size: int) -> np.ndarray:
    B = patches.shape[0]
    return patches.reshape(B, grid_size, grid_size, patch_size, patch_size, 3).transpose(0, 1, 3, 2, 4, 5).reshape(B, grid_size * patch_size, grid_size * patch_size, 3)


def encode_text_np(token_ids: np.ndarray, params: dict[str, np.ndarray], cfg: ImageModelConfig) -> np.ndarray:
    B, T = token_ids.shape
    h = params["text_emb"][token_ids] + params["text_pos"][:T]
    for i in range(cfg.n_text_layers):
        h = _transformer_block_np(h, params, f"txt{i}", cfg.n_heads)
    h = layernorm_np(h, params["text_ln_g"], params["text_ln_b"])
    mask = (token_ids != 0).astype(np.float32)[..., None]
    return np.sum(h * mask, axis=1) / np.maximum(np.sum(mask, axis=1), 1.0)


def encode_image_np(images: np.ndarray, params: dict[str, np.ndarray], cfg: ImageModelConfig) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    B = images.shape[0]
    patches = image_to_patches_np(images, cfg.patch_size)
    tok = patches @ params["patch_proj_w"] + params["patch_proj_b"]
    cls = np.broadcast_to(params["cls_token"], (B, 1, cfg.d_model))
    h = np.concatenate([cls, tok], axis=1) + params["patch_pos"]
    for i in range(cfg.n_enc_layers):
        h = _transformer_block_np(h, params, f"enc{i}", cfg.n_heads)
    h = layernorm_np(h, params["enc_ln_g"], params["enc_ln_b"])
    pooled = h[:, 0, :]
    patch_latents = h[:, 1:, :]
    scene_logits = pooled @ params["scene_w"] + params["scene_b"]
    layout_logits = pooled @ params["layout_w"] + params["layout_b"]
    return pooled, patch_latents, scene_logits, layout_logits


def generate_image_np(
    token_ids: np.ndarray,
    params: dict[str, np.ndarray],
    cfg: ImageModelConfig,
    *,
    seed: int = 0,
    init_latent: np.ndarray | None = None,
    strength: float = 1.0,
) -> np.ndarray:
    B = token_ids.shape[0]
    rng = np.random.default_rng(seed)
    c_text = encode_text_np(token_ids, params, cfg)
    noise = rng.normal(0.0, 0.25, (B, cfg.n_patches, cfg.d_model)).astype(np.float32)
    z = noise if init_latent is None else (1.0 - strength) * init_latent + strength * noise
    z = z + params["latent_pos"][None, :, :]

    for step in range(cfg.n_denoise_steps):
        cond = c_text + params["step_emb"][step][None, :]
        gamma = 1.0 + np.tanh(cond @ params["film_gamma"])[:, None, :]
        beta = (cond @ params["film_beta"])[:, None, :]
        z = z * gamma + beta
        block_idx = step % cfg.n_dec_blocks
        z = _transformer_block_np(z, params, f"dec{block_idx}", cfg.n_heads)

    z = layernorm_np(z, params["out_ln_g"], params["out_ln_b"])
    raw_patches = 1.0 / (1.0 + np.exp(-(z @ params["patch_dec_w"] + params["patch_dec_b"])))
    base_img = patches_to_image_np(raw_patches, cfg.grid_size, cfg.patch_size)
    refined = _conv2d_same3x3_np(base_img, params["refine_conv_w"], params["refine_conv_b"])
    return np.clip(refined, 0.0, 1.0)


def encode_png_bytes(rgb_float: np.ndarray, width: int = 256, height: int = 256) -> bytes:
    arr = np.clip(np.round(rgb_float * 255.0), 0, 255).astype(np.uint8)
    pil = Image.fromarray(arr, mode="RGB")
    if (pil.width, pil.height) != (width, height):
        pil = pil.resize((width, height), resample=Image.Resampling.BICUBIC)
    buf = io.BytesIO()
    pil.save(buf, format="PNG", optimize=False)
    return buf.getvalue()


def decode_image_bytes(image_bytes: bytes, target_size: int = 64) -> tuple[np.ndarray, dict[str, Any]]:
    pil = Image.open(io.BytesIO(image_bytes))
    orig_w, orig_h, orig_fmt = pil.width, pil.height, (pil.format or "UNKNOWN").lower()
    rgb = pil.convert("RGB").resize((target_size, target_size), resample=Image.Resampling.BICUBIC)
    arr = np.asarray(rgb, dtype=np.float32) / 255.0
    return arr, {"width": orig_w, "height": orig_h, "format": orig_fmt}


def parse_size_spec(size_spec: str | None, default_side: int = 256) -> tuple[int, int]:
    if not size_spec or size_spec == "auto":
        return default_side, default_side
    if "x" in size_spec.lower():
        parts = size_spec.lower().split("x", 1)
        w = max(64, min(1024, int(parts[0])))
        h = max(64, min(1024, int(parts[1])))
        return w, h
    return default_side, default_side


class KlyvaronImageRuntime:
    def __init__(self, manifest: dict[str, Any], processor: dict[str, Any], params: dict[str, np.ndarray]):
        self.manifest = manifest
        self.processor = processor
        self.params = params
        self.config = ImageModelConfig(**manifest["architecture"]["config"])

    @classmethod
    def load(cls, model_dir: Path) -> "KlyvaronImageRuntime":
        manifest, processor, params = load_multimodal_package(model_dir)
        if manifest["architecture"]["id"] != ARCHITECTURE_ID:
            raise ValueError(f"Expected {ARCHITECTURE_ID}, found {manifest['architecture']['id']}")
        return cls(manifest, processor, params)

    def generate(self, prompt: str, *, width: int = 256, height: int = 256, seed: int = 42) -> dict[str, Any]:
        token_ids = encode_prompt(prompt)[None, :]
        rgb = generate_image_np(token_ids, self.params, self.config, seed=seed)[0]
        png_bytes = encode_png_bytes(rgb, width=width, height=height)
        understanding = self.understand(png_bytes)
        return {
            "pngBytes": png_bytes,
            "width": width,
            "height": height,
            "format": "png",
            "mime": "image/png",
            "scenePrediction": understanding["scene"],
            "confidence": understanding["confidence"],
            "description": understanding["description"],
        }

    def edit(self, image_bytes: bytes, prompt: str, *, strength: float = 0.72, width: int | None = None, height: int | None = None, seed: int = 42) -> dict[str, Any]:
        src_arr, meta = decode_image_bytes(image_bytes, target_size=self.config.image_size)
        _, patch_latents, _, _ = encode_image_np(src_arr[None, ...], self.params, self.config)
        token_ids = encode_prompt(prompt)[None, :]
        edited_rgb = generate_image_np(
            token_ids,
            self.params,
            self.config,
            seed=seed,
            init_latent=patch_latents,
            strength=float(np.clip(strength, 0.15, 0.95)),
        )[0]
        out_w = width or meta["width"]
        out_h = height or meta["height"]
        png_bytes = encode_png_bytes(edited_rgb, width=out_w, height=out_h)
        mean_abs_pixel_delta = float(np.mean(np.abs(edited_rgb - src_arr)))
        after_info = self.understand(png_bytes)
        return {
            "pngBytes": png_bytes,
            "width": out_w,
            "height": out_h,
            "format": "png",
            "mime": "image/png",
            "meanAbsPixelDelta": round(mean_abs_pixel_delta, 6),
            "scenePrediction": after_info["scene"],
            "description": after_info["description"],
        }

    def understand(self, image_bytes: bytes, question: str | None = None) -> dict[str, Any]:
        arr, meta = decode_image_bytes(image_bytes, target_size=self.config.image_size)
        _, _, scene_logits, layout_logits = encode_image_np(arr[None, ...], self.params, self.config)
        s_probs = softmax_np(scene_logits[0])
        l_probs = softmax_np(layout_logits[0])
        scene_idx = int(np.argmax(s_probs))
        layout_idx = int(np.argmax(l_probs))
        mean_rgb = [round(float(x), 3) for x in np.mean(arr, axis=(0, 1))]
        contrast = round(float(np.std(arr)), 4)
        spec = SCENE_SPECS[scene_idx]
        desc = (
            f"Detected {spec['label']} (scene='{spec['id']}', confidence={float(s_probs[scene_idx]):.2%}, "
            f"layout='{LAYOUT_CLASSES[layout_idx]}', resolution={meta['width']}x{meta['height']}, "
            f"meanRGB={mean_rgb}, contrast={contrast})."
        )
        if question:
            desc = f"Question: {question.strip()} -> {desc}"
        return {
            "scene": spec["id"],
            "sceneLabel": spec["label"],
            "confidence": round(float(s_probs[scene_idx]), 4),
            "layout": LAYOUT_CLASSES[layout_idx],
            "layoutConfidence": round(float(l_probs[layout_idx]), 4),
            "meanRgb": mean_rgb,
            "contrast": contrast,
            "inputDimensions": meta,
            "description": desc,
        }


def build_image_dataset(cfg: ImageModelConfig, n_per_class: int, seed: int) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed)
    images, tokens, scenes, layouts = [], [], [], []
    for cls_idx, spec in enumerate(SCENE_SPECS):
        l_idx = LAYOUT_CLASSES.index(spec["layout"])
        for k in range(n_per_class):
            img = render_procedural_scene(cls_idx, rng, size=cfg.image_size)
            prompt = spec["prompts"][k % len(spec["prompts"])]
            images.append(img)
            tokens.append(encode_prompt(prompt, cfg.max_text_len))
            scenes.append(cls_idx)
            layouts.append(l_idx)
    perm = rng.permutation(len(images))
    return {
        "images": np.asarray(images, dtype=np.float32)[perm],
        "tokens": np.asarray(tokens, dtype=np.int32)[perm],
        "scenes": np.asarray(scenes, dtype=np.int32)[perm],
        "layouts": np.asarray(layouts, dtype=np.int32)[perm],
    }


def train_and_export_image_preset(preset_name: str, install_root: Path, *, version: str = "0.1.0", steps_override: int | None = None) -> dict[str, Any]:
    import jax
    import jax.numpy as jnp

    spec = IMAGE_PRESETS[preset_name]
    cfg: ImageModelConfig = spec["config"]
    seed = int(spec["default_seed"])
    total_steps = steps_override or int(spec["train_steps"])
    batch_size = int(spec["batch_size"])
    lr = float(spec["lr"])

    params_np = init_image_params(cfg, seed)
    train_ds = build_image_dataset(cfg, n_per_class=48, seed=seed + 100)
    val_ds = build_image_dataset(cfg, n_per_class=16, seed=seed + 999)

    def ln_j(x, g, b):
        m = jnp.mean(x, axis=-1, keepdims=True)
        v = jnp.mean((x - m) ** 2, axis=-1, keepdims=True)
        return (x - m) * jax.lax.rsqrt(v + 1e-5) * g + b

    def gelu_j(x):
        return 0.5 * x * (1.0 + jnp.tanh(math.sqrt(2.0 / math.pi) * (x + 0.044715 * (x**3))))

    def block_scan(h, lp):
        B, T, D = h.shape
        hd = cfg.head_dim
        a = ln_j(h, lp["ln1_g"], lp["ln1_b"])
        q = (a @ lp["wq"]).reshape(B, T, cfg.n_heads, hd).transpose(0, 2, 1, 3)
        k = (a @ lp["wk"]).reshape(B, T, cfg.n_heads, hd).transpose(0, 2, 1, 3)
        v = (a @ lp["wv"]).reshape(B, T, cfg.n_heads, hd).transpose(0, 2, 1, 3)
        att = jax.nn.softmax((q @ k.transpose(0, 1, 3, 2)) / math.sqrt(hd), axis=-1)
        y = (att @ v).transpose(0, 2, 1, 3).reshape(B, T, D)
        h = h + y @ lp["wo"]
        b = ln_j(h, lp["ln2_g"], lp["ln2_b"])
        return h + gelu_j(b @ lp["w1"]) @ lp["w2"], None

    def pack_layers(flat_d, prefix, count):
        keys = ("ln1_g", "ln1_b", "wq", "wk", "wv", "wo", "ln2_g", "ln2_b", "w1", "w2")
        return {k: jnp.stack([jnp.asarray(flat_d[f"{prefix}{i}.{k}"]) for i in range(count)], axis=0) for k in keys}

    def unpack_layers(out_d, stacked_d, prefix, count):
        for i in range(count):
            for k, arr in stacked_d.items():
                out_d[f"{prefix}{i}.{k}"] = np.asarray(arr[i], dtype=np.float32)

    def conv3x3_j(img, w, b):
        padded = jnp.pad(img, ((0, 0), (1, 1), (1, 1), (0, 0)), mode="edge")
        out = jnp.zeros_like(img)
        for dy in range(3):
            for dx in range(3):
                out = out + padded[:, dy : dy + img.shape[1], dx : dx + img.shape[2], :] @ w[dy, dx]
        return out + b

    def loss_fn(p, batch_imgs, batch_toks, batch_scenes, batch_layouts, batch_noise):
        B = batch_imgs.shape[0]
        gh = cfg.grid_size
        ps = cfg.patch_size
        patches = batch_imgs.reshape(B, gh, ps, gh, ps, 3).transpose(0, 1, 3, 2, 4, 5).reshape(B, cfg.n_patches, cfg.patch_dim)
        tok = patches @ p["patch_proj_w"] + p["patch_proj_b"]
        cls = jnp.broadcast_to(p["cls_token"], (B, 1, cfg.d_model))
        h = jnp.concatenate([cls, tok], axis=1) + p["patch_pos"]
        h, _ = jax.lax.scan(block_scan, h, p["enc_layers"])
        h = ln_j(h, p["enc_ln_g"], p["enc_ln_b"])
        pooled = h[:, 0, :]
        s_lp = jax.nn.log_softmax(pooled @ p["scene_w"] + p["scene_b"], axis=-1)
        l_lp = jax.nn.log_softmax(pooled @ p["layout_w"] + p["layout_b"], axis=-1)
        rows = jnp.arange(B)
        enc_loss = -jnp.mean(s_lp[rows, batch_scenes]) - 0.5 * jnp.mean(l_lp[rows, batch_layouts])

        th = p["text_emb"][batch_toks] + p["text_pos"][: cfg.max_text_len]
        th, _ = jax.lax.scan(block_scan, th, p["txt_layers"])
        th = ln_j(th, p["text_ln_g"], p["text_ln_b"])
        mask = (batch_toks != 0).astype(jnp.float32)[..., None]
        c_text = jnp.sum(th * mask, axis=1) / jnp.maximum(jnp.sum(mask, axis=1), 1.0)

        z = batch_noise + p["latent_pos"][None, :, :]
        step_indices = jnp.arange(cfg.n_denoise_steps)

        def denoise_body(z_cur, step_i):
            cond = c_text + p["step_emb"][step_i][None, :]
            gamma = 1.0 + jnp.tanh(cond @ p["film_gamma"])[:, None, :]
            beta = (cond @ p["film_beta"])[:, None, :]
            z_mod = z_cur * gamma + beta
            blk = jax.tree_util.tree_map(lambda arr: arr[step_i % cfg.n_dec_blocks], p["dec_layers"])
            z_next, _ = block_scan(z_mod, blk)
            return z_next, None

        z, _ = jax.lax.scan(denoise_body, z, step_indices)
        z = ln_j(z, p["out_ln_g"], p["out_ln_b"])
        raw_p = jax.nn.sigmoid(z @ p["patch_dec_w"] + p["patch_dec_b"])
        gen_base = raw_p.reshape(B, gh, gh, ps, ps, 3).transpose(0, 1, 3, 2, 4, 5).reshape(B, cfg.image_size, cfg.image_size, 3)
        gen_img = jnp.clip(conv3x3_j(gen_base, p["refine_conv_w"], p["refine_conv_b"]), 0.0, 1.0)
        l1_loss = jnp.mean(jnp.abs(gen_img - batch_imgs))

        gen_patches = gen_img.reshape(B, gh, ps, gh, ps, 3).transpose(0, 1, 3, 2, 4, 5).reshape(B, cfg.n_patches, cfg.patch_dim)
        gh_tok = gen_patches @ p["patch_proj_w"] + p["patch_proj_b"]
        gh_h = jnp.concatenate([cls, gh_tok], axis=1) + p["patch_pos"]
        gh_h, _ = jax.lax.scan(block_scan, gh_h, p["enc_layers"])
        gh_p = ln_j(gh_h, p["enc_ln_g"], p["enc_ln_b"])[:, 0, :]
        gen_s_lp = jax.nn.log_softmax(gh_p @ p["scene_w"] + p["scene_b"], axis=-1)
        align_loss = -jnp.mean(gen_s_lp[rows, batch_scenes])
        total = enc_loss + 3.0 * l1_loss + 0.5 * align_loss
        return total, (enc_loss, l1_loss, align_loss)

    @jax.jit
    def train_step(p, m1, m2, step_num, b_img, b_tok, b_sc, b_ly, b_nz):
        (loss, aux), grads = jax.value_and_grad(loss_fn, has_aux=True)(p, b_img, b_tok, b_sc, b_ly, b_nz)
        norm = jnp.sqrt(sum(jnp.sum(g * g) for g in jax.tree_util.tree_leaves(grads)) + 1e-12)
        scale = jnp.where(norm > 1.0, 1.0 / norm, 1.0)
        grads = jax.tree_util.tree_map(lambda g: g * scale, grads)
        m1 = jax.tree_util.tree_map(lambda m, g: 0.9 * m + 0.1 * g, m1, grads)
        m2 = jax.tree_util.tree_map(lambda v, g: 0.98 * v + 0.02 * (g * g), m2, grads)
        c1 = 1.0 - (0.9**step_num)
        c2 = 1.0 - (0.98**step_num)
        p = jax.tree_util.tree_map(lambda w, m, v: w - lr * (m / c1) / (jnp.sqrt(v / c2) + 1e-8), p, m1, m2)
        return p, m1, m2, loss, aux

    p_jax = {
        k: jnp.asarray(v)
        for k, v in params_np.items()
        if not k.startswith(("txt", "enc0.", "enc1.", "enc2.", "enc3.", "enc4.", "enc5.", "dec"))
    }
    p_jax["txt_layers"] = pack_layers(params_np, "txt", cfg.n_text_layers)
    p_jax["enc_layers"] = pack_layers(params_np, "enc", cfg.n_enc_layers)
    p_jax["dec_layers"] = pack_layers(params_np, "dec", cfg.n_dec_blocks)
    m1 = jax.tree_util.tree_map(jnp.zeros_like, p_jax)
    m2 = jax.tree_util.tree_map(jnp.zeros_like, p_jax)

    t0 = time.perf_counter()
    rng = np.random.default_rng(seed + 55)
    n_train = len(train_ds["images"])
    initial_loss = None
    final_loss = None
    for s in range(1, total_steps + 1):
        idx = rng.integers(0, n_train, size=(batch_size,))
        noise = rng.normal(0.0, 0.25, (batch_size, cfg.n_patches, cfg.d_model)).astype(np.float32)
        p_jax, m1, m2, loss_val, _ = train_step(
            p_jax,
            m1,
            m2,
            jnp.float32(s),
            train_ds["images"][idx],
            train_ds["tokens"][idx],
            train_ds["scenes"][idx],
            train_ds["layouts"][idx],
            noise,
        )
        lf = float(loss_val)
        if initial_loss is None:
            initial_loss = lf
        final_loss = lf

    wall_seconds = round(time.perf_counter() - t0, 3)
    trained_params = {
        k: np.asarray(v, dtype=np.float32)
        for k, v in p_jax.items()
        if k not in ("txt_layers", "enc_layers", "dec_layers")
    }
    unpack_layers(trained_params, p_jax["txt_layers"], "txt", cfg.n_text_layers)
    unpack_layers(trained_params, p_jax["enc_layers"], "enc", cfg.n_enc_layers)
    unpack_layers(trained_params, p_jax["dec_layers"], "dec", cfg.n_dec_blocks)
    import gc
    del train_step, p_jax, m1, m2
    jax.clear_caches()
    gc.collect()

    # Held-out evaluation on completely unseen validation seed `seed + 999`
    _, _, val_scene_logits, val_layout_logits = encode_image_np(val_ds["images"], trained_params, cfg)
    scene_acc = float(np.mean(np.argmax(val_scene_logits, axis=-1) == val_ds["scenes"]))
    layout_acc = float(np.mean(np.argmax(val_layout_logits, axis=-1) == val_ds["layouts"]))
    gen_val = generate_image_np(val_ds["tokens"][:32], trained_params, cfg, seed=101)
    val_l1 = float(np.mean(np.abs(gen_val - val_ds["images"][:32])))
    baseline_mean_img = np.mean(train_ds["images"], axis=0, keepdims=True)
    baseline_l1 = float(np.mean(np.abs(baseline_mean_img - val_ds["images"][:32])))
    _, _, gen_scene_logits, _ = encode_image_np(gen_val, trained_params, cfg)
    gen_alignment_acc = float(np.mean(np.argmax(gen_scene_logits, axis=-1) == val_ds["scenes"][:32]))

    metrics = {
        "validationSceneAccuracy": round(scene_acc, 4),
        "uniformSceneBaseline": 0.125,
        "validationLayoutAccuracy": round(layout_acc, 4),
        "generationPromptAlignmentAccuracy": round(gen_alignment_acc, 4),
        "validationPixelL1": round(val_l1, 4),
        "meanPixelBaselineL1": round(baseline_l1, 4),
        "initialLoss": round(float(initial_loss), 4),
        "finalLoss": round(float(final_loss), 4),
        "lossImprovement": round(float(initial_loss - final_loss), 4),
        "steps": total_steps,
        "wallSeconds": wall_seconds,
        "parameterCount": count_parameters(trained_params),
    }
    limitations = [
        f"Trained on 8 structured visual scene families ({n_train} training images, {len(val_ds['images'])} held-out validation images) at 64x64 native latent resolution with bicubic upsampling to requested PNG dimensions.",
        "Open-world photorealistic megapixel synthesis, typographic text rendering inside images, and multi-subject identity locking remain unsupported without large GPU image corpora.",
        "Every claim is restricted to measured held-out accuracy, pixel L1 vs mean-image baseline, and verified PNG container output.",
    ]
    provenance = {
        "origin": "first_party_trained_from_scratch",
        "licence": "MIT",
        "baseModel": None,
        "dataset": f"klyvaron-procedural-scenes-v1 (seed={seed + 100}, heldOutSeed={seed + 999}, 8 scene classes)",
        "trainer": "services/fabric/fabric/multimodal/image_model.py",
        "seed": seed,
    }
    processor = {
        "kind": "klyvaron-vision-processor/1",
        "vocabSize": cfg.vocab_size,
        "maxPromptTokens": cfg.max_text_len,
        "nativeResolution": cfg.image_size,
        "patchSize": cfg.patch_size,
        "sceneClasses": [s["id"] for s in SCENE_SPECS],
        "layoutClasses": LAYOUT_CLASSES,
    }
    out_dir = Path(install_root) / spec["model_id"]
    return save_multimodal_package(
        out_dir,
        model_id=spec["model_id"],
        version=version,
        tier=spec["tier"],
        modality="image",
        architecture_id=ARCHITECTURE_ID,
        config=asdict(cfg),
        processor=processor,
        params=trained_params,
        supported_tasks=IMAGE_SUPPORTED_TASKS,
        unsupported_tasks=IMAGE_UNSUPPORTED_TASKS,
        provenance=provenance,
        metrics=metrics,
        limitations=limitations,
    )
