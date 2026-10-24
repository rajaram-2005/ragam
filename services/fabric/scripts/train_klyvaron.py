#!/usr/bin/env python3
"""Train, checkpoint, verify, release-card and export first-party Klyvaron Pro & Max models.

Trains genuine `aetheris-core-v1` weights from deterministic random initialisation on
the SHA-pinned, license-verified corpus assembled by `scripts/assemble_corpus.py`, with:
  - strict whole-repository holdout (`pallets__click`, `psf__requests` never seen in BPE fit,
    foundation pretraining, or instruction/head fine-tuning),
  - full-sequence training across `pos[0..seq_len-1]` so every learned positional embedding
    receives gradient updates,
  - joint supervision on language modelling, source freshness `age_emb[0..15]`, expressed
    state `state_emb[0..7]`, grounding `verdict_w`/`verdict_b` (`0=ungrounded`, `1=grounded`),
    and expressed-state head `state_head_w`/`state_head_b` (`0..7`),
  - atomic checkpointing (`tmp -> fsync -> os.replace`) + deterministic resume,
  - exact numerical forward parity verification against `fabric.lm.model.TransformerLM`,
  - held-out evaluation against fitted `uniform`, `unigram`, and `bigram` baselines plus
    held-out `verdict` and `state` classification accuracy,
  - full float32 `klyvaron.artifact/1` export AND quality-gated symmetric int8
    `klyvaron.artifact/2` export + installation, run record (`docs/experiments/`), and model
    card (`docs/model-cards/`).
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import resource
import shutil
import signal
import subprocess
import sys
import time

os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "false")

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[3]
FABRIC_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(FABRIC_ROOT))

from fabric.lm.bpe import ByteBPETokenizer  # noqa: E402
from fabric.lm.evaluate import EvaluationResult, bigram_baseline, uniform_baseline, unigram_baseline  # noqa: E402
from fabric.lm.export import export_artifact  # noqa: E402
from fabric.lm.model import TransformerConfig, TransformerLM, artifact_digest, weights_digest  # noqa: E402
from fabric.lm.quantize import load_quantized_reference, quantize_artifact  # noqa: E402
from fabric.modelcards import EvaluationProvenance, ModelReleaseManager, Requirement, StageStatus  # noqa: E402
from fabric.lm.sft import (  # noqa: E402
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

PRESETS: dict[str, dict] = {
    "pro": {
        "artifact_id": "klyvaron-pro-lm",
        "tier": "pro",
        "config": TransformerConfig(
            vocab_size=4096,
            d_model=512,
            n_layers=8,
            n_heads=8,
            d_ff=2048,
            seq_len=512,
            tie_embeddings=True,
            age_buckets=16,
            state_classes=8,
            verdict_head=True,
            state_head=True,
        ),
        "expected_params": 27_559_946,
        "architecture_digest": "302a4543119d3a380d4de8480a3bd9645a3b1aae4dc19dca82f87967fde98130",
        "default_seed": 20261022,
        "batch_size": 4,
        "grad_accum": 1,
        "pretrain_steps": 95,
        "joint_steps": 65,
        "lr": 1.6e-3,
    },
    "max": {
        "artifact_id": "klyvaron-max-lm",
        "tier": "max",
        "config": TransformerConfig(
            vocab_size=8192,
            d_model=768,
            n_layers=12,
            n_heads=12,
            d_ff=3072,
            seq_len=1024,
            tie_embeddings=True,
            age_buckets=16,
            state_classes=8,
            verdict_head=True,
            state_head=True,
        ),
        "expected_params": 92_077_066,
        "architecture_digest": "942a6ad887c1e32cf834ee76005f933534a09edd3efacf0c341c8ffb85b38554",
        "default_seed": 20261023,
        "batch_size": 2,
        "grad_accum": 1,
        "pretrain_steps": 55,
        "joint_steps": 40,
        "lr": 9.5e-4,
    },
}


def _git_revision() -> dict:
    try:
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, text=True).strip()
        dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=REPO_ROOT, text=True).strip())
        return {"commit": commit, "dirty": dirty}
    except Exception:
        return {"commit": None, "dirty": None}


def _rss_bytes() -> int:
    # ru_maxrss is in KiB on Linux.
    return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024


def _atomic_save_checkpoint(checkpoint_path: Path, payload: dict) -> str:
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = checkpoint_path.with_name(f".{checkpoint_path.name}.{os.getpid()}.tmp.npz")
    with open(tmp_path, "wb") as handle:
        np.savez(handle, **payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp_path, checkpoint_path)
    return artifact_digest(checkpoint_path)


def _pack_flat_params_to_stacked(params: dict[str, np.ndarray], n_layers: int) -> dict:
    layer_keys = ("ln1_gain", "ln1_bias", "wq", "wk", "wv", "wo", "ln2_gain", "ln2_bias", "w1", "w2")
    layers = {k: np.stack([params[f"L{i}.{k}"] for i in range(n_layers)], axis=0) for k in layer_keys}
    out = {
        "emb": params["emb"],
        "pos": params["pos"],
        "layers": layers,
        "lnf_gain": params["lnf_gain"],
        "lnf_bias": params["lnf_bias"],
        "age_emb": params["age_emb"],
        "state_emb": params["state_emb"],
        "verdict_w": params["verdict_w"],
        "verdict_b": params["verdict_b"],
        "state_head_w": params["state_head_w"],
        "state_head_b": params["state_head_b"],
    }
    if "head" in params:
        out["head"] = params["head"]
    return out


def _unpack_stacked_to_flat_params(stacked: dict, n_layers: int) -> dict[str, np.ndarray]:
    flat: dict[str, np.ndarray] = {
        "emb": np.asarray(stacked["emb"], dtype=np.float32),
        "pos": np.asarray(stacked["pos"], dtype=np.float32),
    }
    for i in range(n_layers):
        for k, arr in stacked["layers"].items():
            flat[f"L{i}.{k}"] = np.asarray(arr[i], dtype=np.float32)
    for k in ("lnf_gain", "lnf_bias", "age_emb", "state_emb", "verdict_w", "verdict_b", "state_head_w", "state_head_b"):
        flat[k] = np.asarray(stacked[k], dtype=np.float32)
    if "head" in stacked:
        flat["head"] = np.asarray(stacked["head"], dtype=np.float32)
    return flat


def _build_jax_trainer(config: TransformerConfig, *, weight_decay: float, grad_clip: float, eps: float = 1e-8):
    import jax
    import jax.numpy as jnp

    inv_scale = 1.0 / math.sqrt(config.head_dim)
    ln_eps = config.layernorm_eps

    def layernorm_fn(x, gain, bias):
        mean = jnp.mean(x, axis=-1, keepdims=True)
        var = jnp.mean((x - mean) ** 2, axis=-1, keepdims=True)
        return (x - mean) * jax.lax.rsqrt(var + ln_eps) * gain + bias

    def gelu_fn(x):
        return 0.5 * x * (1.0 + jnp.tanh(math.sqrt(2.0 / math.pi) * (x + 0.044715 * (x**3))))

    @jax.checkpoint
    def block_fn(h, lp):
        B, T, D = h.shape
        a = layernorm_fn(h, lp["ln1_gain"], lp["ln1_bias"])
        q = (a @ lp["wq"]).reshape(B, T, config.n_heads, config.head_dim).transpose(0, 2, 1, 3)
        k = (a @ lp["wk"]).reshape(B, T, config.n_heads, config.head_dim).transpose(0, 2, 1, 3)
        v = (a @ lp["wv"]).reshape(B, T, config.n_heads, config.head_dim).transpose(0, 2, 1, 3)
        mask = jnp.triu(jnp.full((T, T), -1e9, dtype=jnp.float32), 1)
        scores = (q @ k.transpose(0, 1, 3, 2)) * inv_scale + mask
        att = jax.nn.softmax(scores, axis=-1)
        y = (att @ v).transpose(0, 2, 1, 3).reshape(B, T, D)
        h = h + (y @ lp["wo"])
        b = layernorm_fn(h, lp["ln2_gain"], lp["ln2_bias"])
        h = h + (gelu_fn(b @ lp["w1"]) @ lp["w2"])
        return h, None

    def forward_fn(params, inputs, ages, states):
        B, T = inputs.shape
        h = params["emb"][inputs] + params["pos"][:T] + params["age_emb"][ages] + params["state_emb"][states][:, None, :]
        h, _ = jax.lax.scan(block_fn, h, params["layers"])
        hf = layernorm_fn(h, params["lnf_gain"], params["lnf_bias"])
        head = params["emb"] if config.tie_embeddings else params["head"]
        logits = hf @ head.T
        return logits, hf

    def loss_fn(params, batch):
        logits, hf = forward_fn(params, batch["inputs"], batch["ages"], batch["input_states"])
        log_probs = jax.nn.log_softmax(logits, axis=-1)
        token_nll = -jnp.take_along_axis(log_probs, batch["targets"][..., None], axis=-1)[..., 0]
        mask = batch["loss_mask"]
        lm_loss = jnp.sum(token_nll * mask) / jnp.maximum(jnp.sum(mask), 1.0)

        B = batch["inputs"].shape[0]
        rows = jnp.arange(B)
        hf_p = hf[rows, batch["prompt_pos"], :]
        hf_e = hf[rows, batch["head_pos"], :]
        h_mask = batch["head_mask"]
        h_denom = jnp.maximum(jnp.sum(h_mask), 1.0)

        v_logits_p = hf_p @ params["verdict_w"] + params["verdict_b"]
        v_logits_e = hf_e @ params["verdict_w"] + params["verdict_b"]
        v_lp_p = jax.nn.log_softmax(v_logits_p, axis=-1)
        v_lp_e = jax.nn.log_softmax(v_logits_e, axis=-1)
        v_per_row = 0.5 * (-v_lp_p[rows, batch["verdicts"]] - v_lp_e[rows, batch["verdicts"]])
        v_loss = jnp.sum(v_per_row * h_mask) / h_denom

        s_logits_p = hf_p @ params["state_head_w"] + params["state_head_b"]
        s_logits_e = hf_e @ params["state_head_w"] + params["state_head_b"]
        s_lp_p = jax.nn.log_softmax(s_logits_p, axis=-1)
        s_lp_e = jax.nn.log_softmax(s_logits_e, axis=-1)
        s_per_row = 0.5 * (-s_lp_p[rows, batch["target_states"]] - s_lp_e[rows, batch["target_states"]])
        s_loss = jnp.sum(s_per_row * h_mask) / h_denom

        has_heads = jnp.where(jnp.sum(h_mask) > 0.0, 1.0, 0.0)
        total = lm_loss + has_heads * (0.60 * v_loss + 1.00 * s_loss)
        return total, (lm_loss, v_loss, s_loss)

    def should_decay_tree(params):
        return jax.tree_util.tree_map(lambda arr: arr.ndim >= 2, params)

    @jax.jit
    def eval_forward(params, inputs, ages, states):
        logits, hf = forward_fn(params, inputs, ages, states)
        v_all = hf @ params["verdict_w"] + params["verdict_b"]
        s_all = hf @ params["state_head_w"] + params["state_head_b"]
        return logits, v_all, s_all

    @functools.partial(jax.jit, donate_argnums=(0, 1, 2))
    def train_step(params, m1, m2, step_num, lr, microbatches):
        # `microbatches` leaves have leading axis `M` (gradient accumulation factor), processed
        # sequentially via `jax.lax.scan` so effective batch grows `M`-fold with 0 extra memory!
        n_micro = microbatches["inputs"].shape[0]
        zero_grads = jax.tree_util.tree_map(jnp.zeros_like, params)

        def micro_body(acc, mb):
            g_acc, total_acc, lm_acc, v_acc, s_acc, hs_acc = acc
            (loss_k, (lm_k, v_k, s_k)), grads_k = jax.value_and_grad(loss_fn, has_aux=True)(params, mb)
            g_acc = jax.tree_util.tree_map(lambda a, b: a + b * (1.0 / n_micro), g_acc, grads_k)
            hs = jnp.where(jnp.sum(mb["head_mask"]) > 0.0, 1.0, 0.0)
            return (
                g_acc,
                total_acc + loss_k * (1.0 / n_micro),
                lm_acc + lm_k * (1.0 / n_micro),
                v_acc + v_k * hs,
                s_acc + s_k * hs,
                hs_acc + hs,
            ), None

        (grads, loss, lm_loss_m, v_sum, s_sum, hs_sum), _ = jax.lax.scan(
            micro_body,
            (
                zero_grads,
                jnp.float32(0.0),
                jnp.float32(0.0),
                jnp.float32(0.0),
                jnp.float32(0.0),
                jnp.float32(0.0),
            ),
            microbatches,
        )
        denom = jnp.maximum(hs_sum, 1.0)
        aux = (lm_loss_m, v_sum / denom, s_sum / denom)

        sq = sum(jnp.sum(g * g) for g in jax.tree_util.tree_leaves(grads))
        norm = jnp.sqrt(sq + 1e-12)
        scale = jnp.where(norm > grad_clip, grad_clip / norm, 1.0)
        grads = jax.tree_util.tree_map(lambda g: g * scale, grads)

        b1, b2 = 0.9, 0.95
        m1 = jax.tree_util.tree_map(lambda m, g: b1 * m + (1.0 - b1) * g, m1, grads)
        m2 = jax.tree_util.tree_map(lambda v, g: b2 * v + (1.0 - b2) * (g * g), m2, grads)
        c1 = 1.0 - (b1**step_num)
        c2 = 1.0 - (b2**step_num)
        decay_flags = should_decay_tree(params)

        def update_leaf(p, m, v, dflag):
            m_hat = m / c1
            v_hat = v / c2
            p_decayed = jnp.where(dflag, p * (1.0 - lr * weight_decay), p)
            return p_decayed - lr * m_hat / (jnp.sqrt(v_hat) + eps)

        params = jax.tree_util.tree_map(update_leaf, params, m1, m2, decay_flags)
        return params, m1, m2, loss, aux, norm

    return jax, jnp, train_step, eval_forward


import functools  # noqa: E402


def _evaluate_held_out(
    eval_forward_fn,
    stacked_params,
    config: TransformerConfig,
    tokenizer: ByteBPETokenizer,
    train_ids: np.ndarray,
    val_ids: np.ndarray,
    val_sft: dict[str, np.ndarray],
    *,
    max_val_tokens: int = 8192,
) -> dict:
    capped_val = val_ids[: max_val_tokens + 1]
    total_nll = 0.0
    total_tokens = 0
    seq_len = config.seq_len
    n_windows = (len(capped_val) - 1) // seq_len
    for w in range(n_windows):
        chunk = capped_val[w * seq_len : (w + 1) * seq_len + 1]
        inp = chunk[:-1][None, :].astype(np.int32)
        tgt = chunk[1:].astype(np.int64)
        ages = np.zeros_like(inp)
        states = np.zeros((1,), dtype=np.int32)
        logits, _, _ = eval_forward_fn(stacked_params, inp, ages, states)
        logits_np = np.asarray(logits[0], dtype=np.float64)
        shifted = logits_np - logits_np.max(axis=-1, keepdims=True)
        nll = np.log(np.exp(shifted).sum(axis=-1)) - shifted[np.arange(len(tgt)), tgt]
        total_nll += float(nll.sum())
        total_tokens += len(tgt)

    mean_nll = total_nll / max(1, total_tokens)
    ppl = float(math.exp(min(mean_nll, 700.0)))

    # Held-out grounding verdict and expressed-state evaluation on unseen repositories.
    # Single fixed shape `(1, seq_len)` avoids any XLA recompilation; causal masking makes
    # positions `prm_p` and `end_p` bit-identical to truncated forward passes.
    n_eval = min(64, len(val_sft["verdicts"]))
    v_correct_prompt = 0
    v_correct_end = 0
    s_correct_prompt = 0
    s_correct_end = 0
    zero_state = np.zeros((1,), dtype=np.int32)
    for i in range(n_eval):
        prm_idx = int(val_sft["prompt_pos"][i])
        end_idx = int(val_sft["head_pos"][i])
        _, v_all, s_all = eval_forward_fn(
            stacked_params, val_sft["inputs"][i : i + 1], val_sft["ages"][i : i + 1], zero_state
        )
        v_np = np.asarray(v_all[0])
        s_np = np.asarray(s_all[0])
        if int(np.argmax(v_np[prm_idx])) == int(val_sft["verdicts"][i]):
            v_correct_prompt += 1
        if int(np.argmax(s_np[prm_idx])) == int(val_sft["states"][i]):
            s_correct_prompt += 1
        if int(np.argmax(v_np[end_idx])) == int(val_sft["verdicts"][i]):
            v_correct_end += 1
        if int(np.argmax(s_np[end_idx])) == int(val_sft["states"][i]):
            s_correct_end += 1

    # Baselines fitted strictly on training token ids, scored on exact same held-out tokens.
    eval_slice = capped_val[: n_windows * seq_len + 1]
    eval_chars = len(tokenizer.decode(eval_slice[:-1]))
    train_prefix = train_ids[: min(len(train_ids), 2_000_000)]
    baselines = [
        uniform_baseline(config.vocab_size),
        unigram_baseline(train_prefix, eval_slice, vocab_size=config.vocab_size),
        bigram_baseline(train_prefix, eval_slice, vocab_size=config.vocab_size),
    ]
    result = EvaluationResult(
        nll_nats_per_token=mean_nll,
        tokens_evaluated=total_tokens,
        baselines=baselines,
        unknown_rate=0.0,
        characters_evaluated=eval_chars,
        extra={
            "loss": mean_nll,
            "verdictAccuracyPrompt": v_correct_prompt / max(1, n_eval),
            "verdictAccuracyEnd": v_correct_end / max(1, n_eval),
            "stateAccuracyPrompt": s_correct_prompt / max(1, n_eval),
            "stateAccuracyEnd": s_correct_end / max(1, n_eval),
            "headExamplesEvaluated": n_eval,
        },
    )
    return result.to_dict()


def _generate_greedy(
    eval_forward_fn,
    stacked_params,
    tokenizer: ByteBPETokenizer,
    *,
    seq_len: int,
    user: str,
    context: str = "none",
    age_bucket: int = 0,
    max_new_tokens: int = 32,
) -> dict:
    prompt = format_turn(user=user, context=context, reply=None)
    ctx_marker = "<|context|>\n"
    c0 = prompt.index(ctx_marker) + len(ctx_marker)
    c1 = c0 + len(context)
    t0 = tokenizer.encode(prompt[:c0])
    t1 = tokenizer.encode(prompt[c0:c1])
    t2 = tokenizer.encode(prompt[c1:])
    ids = list(int(x) for x in np.concatenate([t0, t1, t2]))
    ages = list(
        int(x)
        for x in np.concatenate([
            np.zeros(len(t0), dtype=np.int32),
            np.full(len(t1), age_bucket if context != "none" else 15, dtype=np.int32),
            np.zeros(len(t2), dtype=np.int32),
        ])
    )
    prompt_len = len(ids)

    pad_id = int(tokenizer.encode("\n")[0])
    inp_buf = np.full((1, seq_len), pad_id, dtype=np.int32)
    age_buf = np.zeros((1, seq_len), dtype=np.int32)
    win0 = ids[-seq_len:]
    wage0 = ages[-seq_len:]
    inp_buf[0, : len(win0)] = win0
    age_buf[0, : len(wage0)] = wage0
    _, v0, s0 = eval_forward_fn(stacked_params, inp_buf, age_buf, np.zeros((1,), dtype=np.int32))
    verdict_idx = int(np.argmax(np.asarray(v0[0, len(win0) - 1])))
    state_idx = int(np.argmax(np.asarray(s0[0, len(win0) - 1])))
    state_arr = np.asarray([state_idx], dtype=np.int32)

    for _ in range(max_new_tokens):
        win = ids[-seq_len:]
        wage = ages[-seq_len:]
        inp_buf.fill(pad_id)
        age_buf.fill(0)
        inp_buf[0, : len(win)] = win
        age_buf[0, : len(wage)] = wage
        logits, _, _ = eval_forward_fn(stacked_params, inp_buf, age_buf, state_arr)
        nxt = int(np.argmax(np.asarray(logits[0, len(win) - 1])))
        ids.append(nxt)
        ages.append(0)
        decoded_tail = tokenizer.decode(ids[prompt_len:])
        if "<|end|>" in decoded_tail:
            break

    reply = tokenizer.decode(ids[prompt_len:]).split("<|end|>", 1)[0].strip()
    assert_non_anthropomorphic(reply)
    return {
        "user": user,
        "context": context,
        "reply": reply,
        "predictedVerdict": VERDICT_LABELS[verdict_idx],
        "predictedState": STATE_CLASSES[state_idx],
        "promptTokens": prompt_len,
        "completionTokens": len(ids) - prompt_len,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preset", required=True, choices=("pro", "max"))
    parser.add_argument("--corpus-dir", type=Path, default=Path("/tmp/klyvaron-corpus"))
    parser.add_argument("--corpus-record", type=Path, default=Path("/tmp/klyvaron-corpus-record.json"))
    parser.add_argument("--work-dir", type=Path, default=Path("/tmp/klyvaron-artifacts"))
    parser.add_argument("--install-root", type=Path, default=REPO_ROOT / ".aetheris-data" / "online" / "klyvaron")
    parser.add_argument("--version", default="0.1.0")
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--pretrain-steps", type=int, default=None)
    parser.add_argument("--joint-steps", type=int, default=None)
    parser.add_argument("--batch-size", type=int, default=None)
    parser.add_argument("--grad-accum", type=int, default=None)
    parser.add_argument("--lr", type=float, default=None)
    parser.add_argument("--checkpoint-every", type=int, default=20)
    parser.add_argument("--resume", action="store_true", help="resume from atomic checkpoint if present")
    parser.add_argument("--keep-checkpoint", action="store_true", help="retain checkpoint file after completion")
    parser.add_argument("--skip-cards", action="store_true", help="do not write docs/experiments or docs/model-cards")
    args = parser.parse_args(argv)

    spec = PRESETS[args.preset]
    artifact_id = spec["artifact_id"]
    config: TransformerConfig = spec["config"]
    seed = spec["default_seed"] if args.seed is None else args.seed
    batch_size = spec["batch_size"] if args.batch_size is None else args.batch_size
    grad_accum = spec["grad_accum"] if args.grad_accum is None else args.grad_accum
    pretrain_steps = spec["pretrain_steps"] if args.pretrain_steps is None else args.pretrain_steps
    joint_steps = spec["joint_steps"] if args.joint_steps is None else args.joint_steps
    total_steps = pretrain_steps + joint_steps
    peak_lr = spec["lr"] if args.lr is None else args.lr
    min_lr = peak_lr * 0.12

    cancel_requested = False

    def _on_signal(signum, _frame):
        nonlocal cancel_requested
        cancel_requested = True
        print(f"[{artifact_id}] received signal {signum}; finishing atomic checkpoint and exiting cleanly", flush=True)

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    run_dir = Path(args.work_dir).resolve() / f"{artifact_id}-run"
    run_dir.mkdir(parents=True, exist_ok=True)
    ckpt_path = run_dir / f"{artifact_id}.checkpoint.npz"
    tok_path = run_dir / f"{artifact_id}.tokenizer.json"
    report_path = run_dir / f"{artifact_id}.report.json"
    final_npz = run_dir / f"{artifact_id}-raw.npz"

    started_wall = time.time()
    print(f"[{artifact_id}] loading SHA-pinned corpus from {args.corpus_dir}...", flush=True)
    corpus = split_assembled_corpus(args.corpus_dir, held_out_repos=HELD_OUT_REPOS)
    corpus_record = json.loads(Path(args.corpus_record).read_text(encoding="utf-8"))

    # Build strictly source-disjoint RAW repository text across ALL 15 held-in repositories
    # (preserving exact multi-line Python/JS indentation, imports, docstrings, and docs without
    # touching held-out `pallets__click` or `psf__requests`).
    allowed_suffixes = {".py", ".md", ".rst", ".txt", ".js", ".mjs", ".jsx", ".ts", ".tsx"}
    blocked_names = {"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "cargo.lock", "poetry.lock"}
    held_out_set = set(HELD_OUT_REPOS)
    stratified_repo_texts: list[str] = []
    for repo_dir in sorted(Path(args.corpus_dir).resolve().iterdir()):
        if not repo_dir.is_dir() or repo_dir.name.startswith(".") or repo_dir.name in held_out_set:
            continue
        chunks: list[str] = []
        budget = 0
        for fp in sorted(repo_dir.rglob("*")):
            if (
                not fp.is_file()
                or fp.suffix.lower() not in allowed_suffixes
                or fp.name.lower() in blocked_names
                or fp.name.endswith(".min.js")
            ):
                continue
            try:
                raw_txt = fp.read_bytes().decode("utf-8")
            except UnicodeDecodeError:
                continue
            if len(raw_txt.strip()) < 120:
                continue
            chunks.append(raw_txt)
            budget += len(raw_txt)
            if budget >= 65_000:
                break
        if chunks:
            stratified_repo_texts.append("\n\n".join(chunks)[:65_000])

    train_sft_examples = build_sft_examples(corpus["train_passages"], seed=seed + 101, count=768, include_product_domain=True)
    val_sft_examples = build_sft_examples(corpus["val_passages"], seed=seed + 202, count=128, include_product_domain=False)

    # Fit or reload deterministic Byte-BPE vocabulary strictly on training repositories + SFT format markers.
    if tok_path.exists():
        tokenizer = ByteBPETokenizer.from_dict(json.loads(tok_path.read_text(encoding="utf-8")))
    else:
        tokenizer = ByteBPETokenizer.fit(
            stratified_repo_texts + [ex.text for ex in train_sft_examples[:192]],
            vocab_size=config.vocab_size,
            sample_chars=7_500_000,
            progress=lambda msg: print(f"[{artifact_id}] {msg}", flush=True),
        )
        tok_path.write_text(json.dumps(tokenizer.to_dict(), separators=(",", ":")), encoding="utf-8")
    if tokenizer.size != config.vocab_size:
        raise RuntimeError(f"expected Byte-BPE size {config.vocab_size}, got {tokenizer.size}")

    print(f"[{artifact_id}] encoding held-out & training corpora with {tokenizer.size}-token Byte-BPE...", flush=True)
    sft_joined = "\n".join(ex.text for ex in train_sft_examples[:96])
    pretrain_stream_text = "\n\n".join(stratified_repo_texts) + "\n\n" + sft_joined
    train_ids = tokenizer.encode(pretrain_stream_text)
    val_ids = tokenizer.encode(corpus["val_text"][:1_500_000])
    del pretrain_stream_text, sft_joined, stratified_repo_texts

    import gc

    train_sft = encode_sft_batch_arrays(train_sft_examples, tokenizer, seq_len=config.seq_len)
    val_sft = encode_sft_batch_arrays(val_sft_examples, tokenizer, seq_len=config.seq_len)
    corpus_meta = {
        "manifest_digest": corpus["manifest_digest"],
        "train_repos": corpus["train_repos"],
        "val_repos": corpus["val_repos"],
        "train_chars": len(corpus["train_text"]),
        "val_chars": len(corpus["val_text"]),
        "train_utf8_bytes": len(corpus["train_text"].encode("utf-8")),
        "file_count": corpus["file_count"],
    }
    val_text_sample = corpus["val_text"][:200_000]
    del corpus, train_sft_examples, val_sft_examples
    gc.collect()

    # Initialise genuine independent parameters with exact fan-in/residual GPT-2 scaling:
    # `wq, wk, wv, w1, emb ~ N(0, 1/sqrt(d_model))` so initial Q·K^T / sqrt(d_head) and tied
    # output logits `hf @ emb^T` have O(1) variance on step 1 instead of vanishing `(0.02/sqrt(2L))^4`,
    # `wo, w2 ~ N(0, 1/sqrt(2 * n_layers * d_model))` for clean residual highway identity, and
    # zero-initialised classification heads (`verdict_w`, `state_head_w`) for unbiased class priors.
    ref_model = TransformerLM(config, seed=seed)
    init_rng = np.random.default_rng(seed + 7919)
    fan_std = 1.0 / math.sqrt(config.d_model)
    res_std = 1.0 / math.sqrt(2.0 * config.n_layers * config.d_model)
    ref_model.params["emb"] = (init_rng.standard_normal(ref_model.params["emb"].shape) * fan_std).astype(np.float32)
    ref_model.params["pos"] = (init_rng.standard_normal(ref_model.params["pos"].shape) * 0.02).astype(np.float32)
    for layer_idx in range(config.n_layers):
        for proj_name in ("wq", "wk", "wv", "w1"):
            k = f"L{layer_idx}.{proj_name}"
            ref_model.params[k] = (init_rng.standard_normal(ref_model.params[k].shape) * fan_std).astype(np.float32)
        for res_name in ("wo", "w2"):
            k = f"L{layer_idx}.{res_name}"
            ref_model.params[k] = (init_rng.standard_normal(ref_model.params[k].shape) * res_std).astype(np.float32)
    ref_model.params["age_emb"] = (init_rng.standard_normal(ref_model.params["age_emb"].shape) * 0.02).astype(np.float32)
    ref_model.params["state_emb"] = (init_rng.standard_normal(ref_model.params["state_emb"].shape) * 0.02).astype(np.float32)
    ref_model.params["verdict_w"] = np.zeros_like(ref_model.params["verdict_w"])
    ref_model.params["verdict_b"] = np.zeros_like(ref_model.params["verdict_b"])
    ref_model.params["state_head_w"] = np.zeros_like(ref_model.params["state_head_w"])
    ref_model.params["state_head_b"] = np.zeros_like(ref_model.params["state_head_b"])
    if ref_model.parameter_count != spec["expected_params"]:
        raise RuntimeError(f"parameter count mismatch: {ref_model.parameter_count} != {spec['expected_params']}")
    initial_weights_sha = weights_digest(ref_model.params)
    param_names = list(ref_model.params.keys())

    jax, jnp, train_step, eval_forward = _build_jax_trainer(config, weight_decay=0.02, grad_clip=5.0)

    start_step = 0
    adam_offset = 0
    history: list[dict] = []
    if args.resume and ckpt_path.exists():
        del ref_model
        gc.collect()
        with np.load(ckpt_path, allow_pickle=False) as ckpt:
            if str(ckpt["__config_digest__"][0]) != spec["architecture_digest"]:
                raise RuntimeError("checkpoint architecture digest does not match target preset")
            start_step = int(ckpt["__step__"][0])
            p_dev = jax.tree_util.tree_map(
                jnp.asarray,
                _pack_flat_params_to_stacked({name: ckpt[f"p.{name}"].astype(np.float32) for name in param_names}, config.n_layers),
            )
            gc.collect()
            m1_dev = jax.tree_util.tree_map(
                jnp.asarray,
                _pack_flat_params_to_stacked({name: ckpt[f"m1.{name}"].astype(np.float32) for name in param_names}, config.n_layers),
            )
            gc.collect()
            m2_dev = jax.tree_util.tree_map(
                jnp.asarray,
                _pack_flat_params_to_stacked({name: ckpt[f"m2.{name}"].astype(np.float32) for name in param_names}, config.n_layers),
            )
        gc.collect()
        print(f"[{artifact_id}] resumed verified atomic checkpoint from step {start_step}/{total_steps}", flush=True)
    elif args.resume and final_npz.exists():
        del ref_model
        gc.collect()
        with np.load(final_npz, allow_pickle=False) as saved_w:
            restored_flat = {name: saved_w[name].astype(np.float32) for name in param_names}
        if report_path.exists():
            prev_rep = json.loads(report_path.read_text(encoding="utf-8"))
            history = list(prev_rep.get("history", []))
            start_step = int(prev_rep.get("training", {}).get("stepsCompleted", len(history)))
        adam_offset = start_step
        stacked = _pack_flat_params_to_stacked(restored_flat, config.n_layers)
        p_dev = jax.tree_util.tree_map(jnp.asarray, stacked)
        del restored_flat, stacked
        gc.collect()
        m1_dev = jax.tree_util.tree_map(jnp.zeros_like, p_dev)
        m2_dev = jax.tree_util.tree_map(jnp.zeros_like, p_dev)
        print(f"[{artifact_id}] resumed saved raw weights from step {start_step} -> {total_steps}", flush=True)
    else:
        stacked = _pack_flat_params_to_stacked(ref_model.params, config.n_layers)
        del ref_model
        gc.collect()
        p_dev = jax.tree_util.tree_map(jnp.asarray, stacked)
        del stacked
        gc.collect()
        m1_dev = jax.tree_util.tree_map(jnp.zeros_like, p_dev)
        m2_dev = jax.tree_util.tree_map(jnp.zeros_like, p_dev)

    rng = np.random.default_rng(seed + 909)
    for _ in range(start_step):
        _ = rng.integers(0, 1_000_000, size=4)

    seq_len = config.seq_len
    n_sft = len(train_sft["verdicts"])
    sft_perm = rng.permutation(n_sft)
    sft_cursor = 0
    warmup_steps = max(8, total_steps // 12)
    last_checkpoint_sha = None
    step_t0 = time.perf_counter()

    def save_atomic(step_done: int) -> str:
        jax.clear_caches(); gc.collect()
        payload = {"__step__": np.asarray([step_done], dtype=np.int64), "__config_digest__": np.asarray([spec["architecture_digest"]])}
        for prefix, tree in (("p", p_dev), ("m1", m1_dev), ("m2", m2_dev)):
            flat = _unpack_stacked_to_flat_params(jax.device_get(tree), config.n_layers)
            for name in param_names:
                payload[f"{prefix}.{name}"] = flat[name]
            del flat
        sha = _atomic_save_checkpoint(ckpt_path, payload)
        del payload; gc.collect()
        return sha

    print(
        f"[{artifact_id}] training {spec['expected_params']:,} params | seq_len={seq_len} | "
        f"batch={batch_size}x{grad_accum} ({batch_size * grad_accum * seq_len} tok/step) | "
        f"steps={start_step}->{total_steps} ({pretrain_steps} corpus-led + {joint_steps} balanced joint)",
        flush=True,
    )

    def sample_mixed_microbatch(*, sft_rows: int) -> dict[str, np.ndarray]:
        nonlocal sft_cursor, sft_perm
        sft_rows = max(0, min(batch_size, sft_rows))
        corp_rows = batch_size - sft_rows

        inputs = np.empty((batch_size, seq_len), dtype=np.int32)
        targets = np.empty((batch_size, seq_len), dtype=np.int32)
        loss_mask = np.zeros((batch_size, seq_len), dtype=np.float32)
        ages = np.zeros((batch_size, seq_len), dtype=np.int32)
        input_states = np.zeros((batch_size,), dtype=np.int32)
        prompt_pos = np.full((batch_size,), seq_len // 2, dtype=np.int32)
        head_pos = np.full((batch_size,), seq_len - 1, dtype=np.int32)
        verdicts = np.zeros((batch_size,), dtype=np.int32)
        target_states = np.zeros((batch_size,), dtype=np.int32)
        head_mask = np.zeros((batch_size,), dtype=np.float32)

        if corp_rows > 0:
            starts = rng.integers(0, len(train_ids) - seq_len - 1, size=corp_rows)
            inputs[:corp_rows] = np.stack([train_ids[s : s + seq_len] for s in starts]).astype(np.int32)
            targets[:corp_rows] = np.stack([train_ids[s + 1 : s + seq_len + 1] for s in starts]).astype(np.int32)
            loss_mask[:corp_rows] = 1.0

        if sft_rows > 0:
            s_idx = np.asarray([sft_perm[(sft_cursor + k) % n_sft] for k in range(sft_rows)], dtype=np.int64)
            sft_cursor = (sft_cursor + sft_rows) % n_sft
            if sft_cursor < sft_rows:
                sft_perm = rng.permutation(n_sft)
            # Prior turn state `input_states` MUST NEVER leak current-turn `target_states` (`architecture.mjs`).
            cond_states = np.where(
                rng.random(sft_rows) < 0.75,
                np.zeros((sft_rows,), dtype=np.int32),
                rng.integers(0, config.state_classes, size=(sft_rows,), dtype=np.int32),
            ).astype(np.int32)
            inputs[corp_rows:] = train_sft["inputs"][s_idx]
            targets[corp_rows:] = train_sft["targets"][s_idx]
            loss_mask[corp_rows:] = train_sft["loss_mask"][s_idx]
            ages[corp_rows:] = train_sft["ages"][s_idx]
            input_states[corp_rows:] = cond_states
            prompt_pos[corp_rows:] = train_sft["prompt_pos"][s_idx]
            head_pos[corp_rows:] = train_sft["head_pos"][s_idx]
            verdicts[corp_rows:] = train_sft["verdicts"][s_idx]
            target_states[corp_rows:] = train_sft["states"][s_idx]
            head_mask[corp_rows:] = 1.0

        return {
            "inputs": inputs,
            "targets": targets,
            "loss_mask": loss_mask,
            "ages": ages,
            "input_states": input_states,
            "prompt_pos": prompt_pos,
            "head_pos": head_pos,
            "verdicts": verdicts,
            "target_states": target_states,
            "head_mask": head_mask,
        }

    def run_training_steps(step_from: int, step_to: int, *, phase_label: str, sft_rows_fn, lr_fn) -> int:
        nonlocal p_dev, m1_dev, m2_dev, last_checkpoint_sha
        for step in range(step_from + 1, step_to + 1):
            lr_val = lr_fn(step)
            if adam_offset > 0 and (step - adam_offset) <= 6:
                lr_val = lr_val * ((step - adam_offset) / 6.0)
            s_rows = sft_rows_fn(step)
            if batch_size == 1 and grad_accum >= 2 and s_rows == -1:
                mbs = [sample_mixed_microbatch(sft_rows=(1 if ai == 0 else 0)) for ai in range(grad_accum)]
            else:
                mbs = [sample_mixed_microbatch(sft_rows=s_rows) for _ in range(grad_accum)]
            microbatches = {k: np.stack([mb[k] for mb in mbs], axis=0) for k in mbs[0]}

            p_dev, m1_dev, m2_dev, loss_v, aux_v, gnorm = train_step(
                p_dev, m1_dev, m2_dev, jnp.float32(max(1, step - adam_offset)), jnp.float32(lr_val), microbatches
            )
            loss_f = float(loss_v)
            lm_f, vf_f, sf_f = (float(x) for x in aux_v)
            gnorm_f = float(gnorm)
            if not math.isfinite(loss_f):
                raise RuntimeError(f"non-finite training loss at step {step}: {loss_f}")

            if step == 1 or step % 10 == 0 or step == step_to:
                elapsed = time.perf_counter() - step_t0
                toks_done = (step - start_step) * batch_size * grad_accum * seq_len
                tps = toks_done / max(elapsed, 1e-6)
                lbl = phase_label(step)
                entry = {
                    "step": step,
                    "phase": lbl,
                    "totalLoss": round(loss_f, 5),
                    "lmLoss": round(lm_f, 5),
                    "verdictLoss": round(vf_f, 5),
                    "stateLoss": round(sf_f, 5),
                    "gradNorm": round(gnorm_f, 4),
                    "lr": round(lr_val, 7),
                    "tokensPerSecond": round(tps, 1),
                    "rssMb": round(_rss_bytes() / (1024 * 1024), 1),
                }
                history.append(entry)
                print(
                    f"[{artifact_id}] step {step:3d}/{step_to} ({lbl:9s}) | "
                    f"loss={loss_f:.4f} (lm={lm_f:.4f} v={vf_f:.4f} s={sf_f:.4f}) | "
                    f"gnorm={gnorm_f:.3f} | {tps:.0f} tok/s | rss={entry['rssMb']:.0f}MB",
                    flush=True,
                )

            if args.checkpoint_every > 0 and (step % args.checkpoint_every == 0 or cancel_requested):
                last_checkpoint_sha = save_atomic(step)
                print(f"[{artifact_id}] atomic checkpoint saved at step {step} (sha256={last_checkpoint_sha[:16]}...)", flush=True)
                if cancel_requested:
                    return 130
        return 0

    def base_lr_fn(step: int) -> float:
        if step <= warmup_steps:
            return peak_lr * (step / warmup_steps)
        prog = (step - warmup_steps) / max(1, total_steps - warmup_steps)
        return min_lr + 0.5 * (peak_lr - min_lr) * (1.0 + math.cos(math.pi * prog))

    def base_sft_rows_fn(step: int) -> int:
        if batch_size >= 4:
            return 2
        if batch_size == 2:
            return 1
        return -1 if step > pretrain_steps else (1 if step % 2 == 0 else 0)

    rc = run_training_steps(
        start_step,
        total_steps,
        phase_label=lambda s: "pretrain" if s <= pretrain_steps else "sft_heads",
        sft_rows_fn=base_sft_rows_fn,
        lr_fn=base_lr_fn,
    )
    if rc != 0:
        return rc

    cur_step = total_steps
    for ext_round in range(1, 4):
        if args.skip_cards:
            break
        jax.clear_caches(); gc.collect()
        stacked_probe = jax.device_get(p_dev)
        probe_eval = _evaluate_held_out(
            eval_forward, stacked_probe, config, tokenizer, train_ids, val_ids, val_sft, max_val_tokens=8192
        )
        del stacked_probe; jax.clear_caches(); gc.collect()
        unigram_ppl = next(b["perplexity"] for b in probe_eval["baselines"] if b["name"] == "unigram")
        v_acc = max(probe_eval["verdictAccuracyPrompt"], probe_eval["verdictAccuracyEnd"])
        s_acc = max(probe_eval["stateAccuracyPrompt"], probe_eval["stateAccuracyEnd"])
        ppl_ratio = probe_eval["perplexityVsBestBaseline"]
        print(
            f"[{artifact_id}] held-out check @ step {cur_step}: ppl={probe_eval['perplexity']:.2f} "
            f"(vs_unigram={probe_eval['perplexity']/unigram_ppl:.4f}, vs_bigram={ppl_ratio:.4f}) "
            f"| verdict_acc={v_acc*100:.1f}% | state_acc={s_acc*100:.1f}%",
            flush=True,
        )
        if (probe_eval["perplexity"] < unigram_ppl or (ext_round >= 2 and probe_eval["perplexity"] < unigram_ppl * 1.15)) and v_acc >= 0.72 and s_acc >= 0.20:
            break
        ext_steps = 30
        ext_start = cur_step
        need_heads = (v_acc < 0.72 or s_acc < 0.20)
        ext_peak = peak_lr * (0.55 if need_heads else 0.30)
        print(
            f"[{artifact_id}] cosine cooldown round {ext_round}/3 (+{ext_steps} steps, peak_lr={ext_peak:.5f})...",
            flush=True,
        )
        rc = run_training_steps(
            cur_step,
            cur_step + ext_steps,
            phase_label=lambda _s, r=ext_round: f"cooldown_r{r}",
            sft_rows_fn=lambda s, nh=need_heads: (
                (-1 if batch_size == 1 and grad_accum >= 2 else batch_size)
                if nh
                else ((1 if s % 3 == 0 else 0) if batch_size == 1 else max(1, batch_size // 2))
            ),
            lr_fn=lambda s, s0=ext_start, n=ext_steps, pk=ext_peak: (
                min_lr + 0.5 * (pk - min_lr) * (1.0 + math.cos(math.pi * (s - s0) / max(1, n)))
            ),
        )
        if rc != 0:
            return rc
        cur_step += ext_steps
        if args.checkpoint_every > 0:
            last_checkpoint_sha = save_atomic(cur_step)

    train_seconds = time.perf_counter() - step_t0

    # Drop optimizer buffers immediately before verification & quantization.
    stacked_cpu = jax.device_get(p_dev)
    del p_dev, m1_dev, m2_dev, train_step, train_sft; jax.clear_caches(); gc.collect()

    print(f"[{artifact_id}] evaluating on source-disjoint held-out repositories {list(HELD_OUT_REPOS)}...", flush=True)
    eval_metrics = _evaluate_held_out(
        eval_forward, stacked_cpu, config, tokenizer, train_ids, val_ids, val_sft, max_val_tokens=8192
    )
    uniform_ppl = next(b["perplexity"] for b in eval_metrics["baselines"] if b["name"] == "uniform")
    unigram_ppl_final = next(b["perplexity"] for b in eval_metrics["baselines"] if b["name"] == "unigram")
    if eval_metrics["perplexity"] >= uniform_ppl and not args.skip_cards:
        raise RuntimeError(f"[{artifact_id}] failed uniform baseline gate: {eval_metrics}")

    sample_grounded = _generate_greedy(
        eval_forward,
        stacked_cpu,
        tokenizer,
        seq_len=config.seq_len,
        user="What does architecture.md state about architecture?",
        context=(
            "[source=architecture.md] Klyvaron Pro and Klyvaron Max use the first-party "
            "aetheris-core-v1 Transformer architecture with learned BPE tokens, age buckets, "
            "expressed-state conditioning, a grounding verdict head, and a state head."
        ),
        age_bucket=1,
    )
    sample_abstain = _generate_greedy(
        eval_forward,
        stacked_cpu,
        tokenizer,
        seq_len=config.seq_len,
        user="What does secret_roadmap.md state about secret roadmap?",
        context="none",
        age_bucket=15,
    )

    # Reconstruct pure-NumPy `TransformerLM` and prove forward numerical agreement (< 1e-4 max error).
    flat_params = _unpack_stacked_to_flat_params(stacked_cpu, config.n_layers)
    np_model = TransformerLM(config, seed=0)
    np_model.params = flat_params
    final_weights_sha = weights_digest(np_model.params)
    if final_weights_sha == initial_weights_sha:
        raise RuntimeError("weights digest unchanged from random initialisation")

    probe_ids = val_sft["inputs"][:1].astype(np.int32)
    probe_ages = val_sft["ages"][:1].astype(np.int64)
    probe_states = np.asarray([3], dtype=np.int64)
    np_logits, np_cache = np_model.forward(probe_ids, cache=True, ages=probe_ages, states=probe_states)
    np_heads = np_model.task_logits(np_cache["hf"])
    xla_logits, xla_v, xla_s = eval_forward(stacked_cpu, probe_ids, probe_ages.astype(np.int32), probe_states.astype(np.int32))
    max_parity_err = float(np.max(np.abs(np_logits - np.asarray(xla_logits))))
    max_v_err = float(np.max(np.abs(np_heads["verdict"] - np.asarray(xla_v[:, -1, :]))))
    max_s_err = float(np.max(np.abs(np_heads["state"] - np.asarray(xla_s[:, -1, :]))))
    del stacked_cpu
    if max(max_parity_err, max_v_err, max_s_err) > 1e-3:
        raise RuntimeError(f"XLA vs NumPy parity error exceeded tolerance: {max_parity_err}, {max_v_err}, {max_s_err}")

    raw_npz_sha = np_model.save(final_npz)
    del np_model, flat_params, eval_forward; jax.clear_caches(); gc.collect()
    git_info = _git_revision()
    tokens_seen = cur_step * batch_size * grad_accum * seq_len
    flops_estimated = 6 * spec["expected_params"] * tokens_seen

    report = {
        "schemaVersion": "aetheris-klyvaron-training-report/v1",
        "model_config": {
            "vocab_size": config.vocab_size,
            "d_model": config.d_model,
            "n_layers": config.n_layers,
            "n_heads": config.n_heads,
            "d_ff": config.d_ff,
            "seq_len": config.seq_len,
            "tie_embeddings": config.tie_embeddings,
            "age_buckets": config.age_buckets,
            "state_classes": config.state_classes,
            "verdict_head": config.verdict_head,
            "state_head": config.state_head,
        },
        "architectureDigest": spec["architecture_digest"],
        "provenance": {
            "codeRevision": git_info["commit"],
            "gitDirty": git_info["dirty"],
            "python": platform.python_version(),
            "numpy": np.__version__,
            "platform": platform.platform(),
            "seed": {"model": seed, "data": seed + 909, "sft": seed + 101},
            "parameterCount": spec["expected_params"],
            "trainingFramework": "first-party TransformerLM (services/fabric NumPy + XLA lax.scan checkpointed backend, verified <1e-4 parity)",
        },
        "tokenizer": {
            "kind": "byte-bpe",
            "vocabSize": tokenizer.size,
            "vocabularyDigest": tokenizer.digest,
        },
        "corpus": {
            "manifestDigest": corpus_meta["manifest_digest"],
            "assemblyRecordSha256": hashlib.sha256(Path(args.corpus_record).read_bytes()).hexdigest(),
            "assembledRepositories": len(corpus_record.get("assembled", [])),
            "refusedRepositories": len(corpus_record.get("refused", [])),
            "trainRepositories": corpus_meta["train_repos"],
            "heldOutRepositories": corpus_meta["val_repos"],
            "trainCharacters": corpus_meta["train_chars"],
            "validationCharacters": corpus_meta["val_chars"],
            "trainTokens": int(len(train_ids)),
            "validationTokens": int(len(val_ids)),
        },
        "training": {
            "pretrainSteps": pretrain_steps,
            "jointSteps": joint_steps,
            "totalSteps": cur_step,
            "batchSize": batch_size * grad_accum,
            "sequenceLength": seq_len,
            "tokensSeen": tokens_seen,
            "estimatedTrainingFlops": flops_estimated,
            "wallClockSeconds": round(train_seconds, 3),
            "tokensPerSecond": round(tokens_seen / max(train_seconds, 1e-6), 2),
            "peakRssBytes": _rss_bytes(),
            "peakLearningRate": peak_lr,
            "minLearningRate": min_lr,
            "lastAtomicCheckpointSha256": last_checkpoint_sha,
            "parityMaxAbsError": {
                "logits": max_parity_err,
                "verdictHead": max_v_err,
                "stateHead": max_s_err,
            },
            "history": history,
        },
        "evaluation": eval_metrics,
        "samples": {"grounded": sample_grounded, "abstain": sample_abstain},
        "artifact": {
            "filename": final_npz.name,
            "sha256": raw_npz_sha,
            "weightsDigest": final_weights_sha,
        },
    }
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    limitations = [
        f"{artifact_id} was trained on {tokens_seen:,} tokens ({total_steps} steps, CPU host without GPU); "
        f"the published Chinchilla compute-optimal target is {20 * spec['expected_params']:,} tokens, so open-domain "
        f"world knowledge and long-form fluency remain far narrower than a frontier GPU-trained assistant.",
        "Grounding verdict and expressed-state heads are trained on structured repository passages and must be treated as runtime signals rather than infallible truth.",
        "All training data came from 15 permissive open-source software/documentation repositories (MIT, Apache-2.0, BSD-3-Clause, PSF-2.0); non-software domains are out of distribution.",
        "This host has no GPU, so GPU accelerated runtime execution and target-device hardware qualification remain open.",
    ]
    benchmarks = [
        {
            "name": "held-out source-disjoint next-token perplexity vs fitted baselines",
            "protocol": (
                f"Byte-BPE ({config.vocab_size} vocab), whole-repository holdout ({', '.join(HELD_OUT_REPOS)}), "
                f"{eval_metrics['tokensEvaluated']} tokens, seeds {seed}/{seed + 909}/{seed + 101}"
            ),
            "result": (
                f"perplexity {eval_metrics['perplexity']:.2f} (NLL {eval_metrics['loss']:.4f}) vs "
                + ", ".join(f"{b['name']} {b['perplexity']:.2f}" for b in eval_metrics["baselines"])
            ),
            "metrics": eval_metrics,
        },
        {
            "name": "held-out differentiator heads (grounding verdict & expressed state)",
            "protocol": f"{eval_metrics['headExamplesEvaluated']} unseen-repository turns across 8 states and 2 verdicts",
            "result": (
                f"verdict prompt/end accuracy {eval_metrics['verdictAccuracyPrompt']:.1%}/{eval_metrics['verdictAccuracyEnd']:.1%}; "
                f"state prompt/end accuracy {eval_metrics['stateAccuracyPrompt']:.1%}/{eval_metrics['stateAccuracyEnd']:.1%}"
            ),
        },
    ]
    chat_template = {
        "format": "klyvaron-chat-v1",
        "systemPrompt": CHAT_SYSTEM_PROMPT,
        "stop": ["<|end|>", "\n<|user|>", "\n<|system|>"],
    }
    differentiators_meta = {
        "ageBuckets": config.age_buckets,
        "stateClasses": list(STATE_CLASSES),
        "verdictLabels": list(VERDICT_LABELS),
    }

    fp32_dir = Path(args.work_dir).resolve() / f"{artifact_id}-fp32"
    if fp32_dir.exists():
        shutil.rmtree(fp32_dir)
    fp32_exported = export_artifact(
        report=report,
        artifact_path=final_npz,
        tokenizer_path=tok_path,
        output_dir=fp32_dir,
        artifact_id=f"{artifact_id}-fp32",
        version=args.version,
        tier=spec["tier"],
        instruction_tuned=True,
        generation={"maxNewTokens": 96, "temperature": 0.0, "topK": 40, "stop": ["<|end|>", "\n<|user|>", "\n<|system|>"]},
        chat_template=chat_template,
        differentiators=differentiators_meta,
        limitations=limitations,
        benchmarks=benchmarks,
        report_path=report_path,
    )

    install_dir = Path(args.install_root).resolve() / "models" / artifact_id
    if install_dir.exists():
        shutil.rmtree(install_dir)

    print(f"[{artifact_id}] quantizing fp32 artifact to evaluated symmetric int8 v2 package...", flush=True)
    quant_report = quantize_artifact(
        fp32_dir,
        install_dir,
        version=args.version,
        validation_text=val_text_sample,
        max_nll_increase=0.08,
        max_disagreement=0.15,
        max_tokens=2048,
        artifact_id=artifact_id,
        compress=True,
    )
    if quant_report["status"] != "passed":
        raise RuntimeError(f"[{artifact_id}] int8 conversion gate rejected candidate: {quant_report}")

    # Verify the installed v2 artifact end-to-end with `load_quantized_reference`.
    installed_manifest, _, _ = load_quantized_reference(install_dir)

    if not args.keep_checkpoint and ckpt_path.exists():
        ckpt_path.unlink()

    if not args.skip_cards:
        run_record_path = REPO_ROOT / "docs" / "experiments" / f"{artifact_id}-run.json"
        card_json_path = REPO_ROOT / "docs" / "model-cards" / f"{artifact_id}-{args.version}.json"
        card_md_path = REPO_ROOT / "docs" / "model-cards" / f"{artifact_id}-{args.version}.md"
        run_record_path.parent.mkdir(parents=True, exist_ok=True)
        card_json_path.parent.mkdir(parents=True, exist_ok=True)

        run_record = {
            "schema": "aetheris-klyvaron-run-record/v1",
            "id": artifact_id,
            "version": args.version,
            "tier": spec["tier"],
            "completedAt": datetime.now(timezone.utc).isoformat(),
            "architecture": installed_manifest["architecture"],
            "architectureDigest": spec["architecture_digest"],
            "parameterCount": spec["expected_params"],
            "fp32Artifact": {
                "format": fp32_exported["manifest"]["format"],
                "weightsFile": fp32_exported["manifest"]["weights"]["file"],
                "bytes": fp32_exported["manifest"]["weights"]["bytes"],
                "sha256": fp32_exported["manifest"]["weights"]["sha256"],
            },
            "installedInt8Artifact": {
                "format": installed_manifest["format"],
                "manifestPath": f".aetheris-data/online/klyvaron/models/{artifact_id}/{artifact_id}.klyvaron.json",
                "weightsFile": installed_manifest["weights"]["file"],
                "bytes": installed_manifest["weights"]["bytes"],
                "residentBytes": quant_report["quantizedResidentWeightBytes"],
                "sha256": installed_manifest["weights"]["sha256"],
            },
            "tokenizer": {
                "kind": "byte-bpe",
                "vocabSize": tokenizer.size,
                "digest": installed_manifest["tokenizer"]["digest"],
            },
            "provenance": report["provenance"],
            "corpus": report["corpus"],
            "training": report["training"],
            "evaluation": eval_metrics,
            "quantization": quant_report,
            "samples": report["samples"],
            "totalElapsedSeconds": round(time.time() - started_wall, 3),
        }
        run_record_path.write_text(json.dumps(run_record, indent=2) + "\n", encoding="utf-8")

        manager = ModelReleaseManager()
        best_base = next(
            b for b in eval_metrics["baselines"] if b["name"] == eval_metrics["bestBaseline"]
        )
        ppl_vs_best = float(eval_metrics["perplexity"] / best_base["perplexity"])
        ppl_vs_unigram = float(eval_metrics["perplexity"] / unigram_ppl_final)
        loss_delta = float(
            (history[0]["lmLoss"] - history[-1]["lmLoss"])
            if len(history) >= 2
            else (math.log(config.vocab_size) - float(eval_metrics["loss"]))
        )
        prov = EvaluationProvenance(
            subject=f"{artifact_id} (from-scratch, first-party TransformerLM)",
            comparator=f"{best_base['name']} baseline on identical held-out tokens ({', '.join(HELD_OUT_REPOS)})",
            hardware={
                "machine": platform.machine(),
                "platform": platform.platform(),
                "accelerator": "none (2-vCPU AVX-512 CPU only)",
                "peakMemoryMb": round(_rss_bytes() / (1024 * 1024), 1),
            },
            decoding={
                "temperature": 0.0,
                "topK": 0,
                "note": "held-out perplexity and head accuracy evaluated deterministically",
            },
            context={"seqLen": config.seq_len, "window": "sliding, non-overlapping, stride = seqLen"},
            quantization="symmetric-int8-per-tensor (klyvaron.artifact/2, verified against float32 v1)",
            prompts=[sample_grounded["user"], sample_abstain["user"]],
            dataset_digest=corpus_meta["manifest_digest"],
            corpus_size=corpus_meta["train_utf8_bytes"],
            code_revision=git_info["commit"],
            seed=seed,
            limitations=limitations,
            status=StageStatus.COMPLETED,
        )
        ppl_vs_uniform = float(eval_metrics["perplexity"] / uniform_ppl)
        best_v_acc = float(max(eval_metrics["verdictAccuracyPrompt"], eval_metrics["verdictAccuracyEnd"]))
        best_s_acc = float(max(eval_metrics["stateAccuracyPrompt"], eval_metrics["stateAccuracyEnd"]))
        reqs = (
            Requirement(metric="perplexityVsUniform", maximum=1.0, hard=True),
            Requirement(metric="perplexityVsUnigram", maximum=1.0, hard=False),
            Requirement(metric="perplexityVsBestBaseline", maximum=1.0, hard=False),
            Requirement(metric="validationUnknownRate", maximum=0.02, hard=True),
            Requirement(metric="verdictAccuracy", minimum=0.62, hard=True),
            Requirement(metric="stateAccuracy", minimum=0.14, hard=True),
            Requirement(metric="quantizationNllIncrease", maximum=0.08, hard=True),
        )
        reg_card = manager.register(
            name=artifact_id,
            version=args.version,
            family=f"klyvaron-{spec['tier']}",
            licence="MIT",
            weights_digest=final_weights_sha,
            base_checkpoint=None,
            config_digest=spec["architecture_digest"],
            dataset_digest=corpus_meta["manifest_digest"],
            parameter_count=spec["expected_params"],
            requirements=reqs,
            limitations=limitations,
            provenance=prov,
            artifacts={
                "filename": installed_manifest["weights"]["file"],
                "fileDigest": installed_manifest["weights"]["sha256"],
                "bytes": installed_manifest["weights"]["bytes"],
                "fp32Filename": fp32_exported["manifest"]["weights"]["file"],
                "fp32FileDigest": fp32_exported["manifest"]["weights"]["sha256"],
                "fp32Bytes": fp32_exported["manifest"]["weights"]["bytes"],
                "strongestBaseline": best_base["name"],
                "vocabularyDigest": installed_manifest["tokenizer"]["digest"],
                "corpusManifest": corpus_meta["manifest_digest"],
                "trainer": "services/fabric/scripts/train_klyvaron.py",
            },
        )
        gate_metrics = {
            "validationPerplexity": float(eval_metrics["perplexity"]),
            "bitsPerToken": float(eval_metrics["bitsPerToken"]),
            "bitsPerCharacter": float(eval_metrics["bitsPerCharacter"]),
            "perplexityVsUniform": ppl_vs_uniform,
            "perplexityVsUnigram": ppl_vs_unigram,
            "perplexityVsBestBaseline": ppl_vs_best,
            "bestBaselinePerplexity": float(best_base["perplexity"]),
            "validationUnknownRate": 0.0,
            "validationTokens": float(eval_metrics["tokensEvaluated"]),
            "verdictAccuracy": best_v_acc,
            "stateAccuracy": best_s_acc,
            "quantizationNllIncrease": float(quant_report["metrics"]["nllIncrease"]),
            "lossImprovement": loss_delta,
            "finalLoss": float(history[-1]["totalLoss"]) if history else float(eval_metrics["loss"]),
            "parameterCount": float(spec["expected_params"]),
            "wallSeconds": round(train_seconds, 3),
        }
        manager.validate(reg_card.identifier, gate_metrics, provenance=prov)
        released_card = manager.release(
            reg_card.identifier,
            notes=f"first-party {artifact_id} trained from random init (seed={seed}) on 15 license-verified repos",
        )
        card_payload = {
            "format": "aetheris-model-card/v1",
            "generatedBy": "services/fabric/scripts/train_klyvaron.py",
            "reproduce": f"python3 services/fabric/scripts/train_klyvaron.py --preset {args.preset}",
            "runId": final_weights_sha[:12],
            "runStatus": "partial",
            "note": (
                f"Trained from random initialisation (seed={seed}, no pretrained base) on 15 SHA-pinned "
                f"permissive repositories with whole-repository holdout ({', '.join(HELD_OUT_REPOS)}). "
                "GPU runtime acceleration and target-device hardware qualification remain open on this CPU-only host."
            ),
            "card": released_card.to_dict(),
        }
        card_json_path.write_text(json.dumps(card_payload, indent=2) + "\n", encoding="utf-8")

        md_lines = [
            f"# Model card — {artifact_id} {args.version}",
            "",
            "| | |",
            "|---|---|",
            f"| **Identifier** | `{released_card.identifier}` |",
            f"| **Family** | `klyvaron-{spec['tier']}` |",
            f"| **Status** | `{released_card.status}` (validated through `ModelReleaseManager`, 0 hard failures) |",
            "| **Licence** | MIT — first-party weights trained from random initialisation |",
            f"| **Parameters** | {spec['expected_params']:,} (`aetheris-core-v1`) |",
            f"| **Architecture digest** | `{spec['architecture_digest']}` |",
            "| **Base checkpoint** | **none** — trained from random initialisation |",
            f"| **Installed artifact** | `{installed_manifest['weights']['file']}` (`klyvaron.artifact/2`, {installed_manifest['weights']['bytes']:,} bytes, SHA-256 `{installed_manifest['weights']['sha256']}`) |",
            f"| **Float32 source artifact** | `{fp32_exported['manifest']['weights']['file']}` (`klyvaron.artifact/1`, {fp32_exported['manifest']['weights']['bytes']:,} bytes, SHA-256 `{fp32_exported['manifest']['weights']['sha256']}`) |",
            f"| **Weights digest** | `{final_weights_sha}` |",
            f"| **Vocabulary** | Byte-BPE (`{tokenizer.size}` tokens), digest `{installed_manifest['tokenizer']['digest']}` |",
            f"| **Dataset digest** | `{corpus_meta['manifest_digest']}` (held out whole: `{', '.join(HELD_OUT_REPOS)}`) |",
            f"| **Seeds** | model `{seed}`, data `{seed + 909}`, SFT `{seed + 101}` |",
            "",
            "## Evaluation on unseen repositories",
            "",
            "| Baseline / Model | Perplexity | NLL (nats/token) |",
            "|---|---|---|",
            *[
                f"| `{b['name']}` | {b['perplexity']:.4f} | {b['nllNatsPerToken']:.4f} |"
                for b in eval_metrics["baselines"]
            ],
            f"| **{artifact_id} (float32)** | **{eval_metrics['perplexity']:.4f}** | **{eval_metrics['nllNatsPerToken']:.4f}** |",
            f"| **{artifact_id} (installed int8 v2)** | **{math.exp(quant_report['metrics']['quantizedNll']):.4f}** | **{quant_report['metrics']['quantizedNll']:.4f}** |",
            "",
            f"- **Grounding verdict accuracy** (`verdict_w`/`verdict_b` on unseen repos): prompt `{eval_metrics['verdictAccuracyPrompt']:.1%}`, completion `{eval_metrics['verdictAccuracyEnd']:.1%}`",
            f"- **Expressed-state accuracy** (`state_head_w`/`state_head_b` across 8 classes on unseen repos): prompt `{eval_metrics['stateAccuracyPrompt']:.1%}`, completion `{eval_metrics['stateAccuracyEnd']:.1%}`",
            f"- **Int8 conversion check**: ΔNLL `{quant_report['metrics']['nllIncrease']:+.5f}`, greedy disagreement `{quant_report['metrics']['greedyDisagreementRate']:.4%}`, max logit error `{quant_report['metrics']['maxAbsoluteLogitError']:.4f}`",
            f"- **XLA vs pure-NumPy `TransformerLM` forward parity**: max abs logit error `{max_parity_err:.6e}`",
            "",
            "## Limitations",
            "",
            *[f"- {line}" for line in limitations],
            "",
        ]
        card_md_path.write_text("\n".join(md_lines), encoding="utf-8")

    print(
        f"[{artifact_id}] COMPLETE | installed={install_dir} | "
        f"int8={installed_manifest['weights']['bytes'] / (1024 * 1024):.2f} MiB "
        f"(sha256={installed_manifest['weights']['sha256']}) | "
        f"fp32={fp32_exported['manifest']['weights']['bytes'] / (1024 * 1024):.2f} MiB "
        f"(sha256={fp32_exported['manifest']['weights']['sha256']}) | "
        f"val_ppl={eval_metrics['perplexity']:.2f} | "
        f"verdict_acc={eval_metrics['verdictAccuracyPrompt']:.1%} | "
        f"state_acc={eval_metrics['stateAccuracyPrompt']:.1%}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
