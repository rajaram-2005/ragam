"""Clean-room instruction, grounding-verdict and expressed-state dataset builder.

Every example in this module is built strictly from license-verified, SHA-pinned
sources assembled by `scripts/assemble_corpus.py` (`MIT`, `Apache-2.0`, `BSD-3-Clause`,
`PSF-2.0`), with whole-repository train/validation separation so no file or symbol
from a held-out repository (`psf__requests`, `pallets__click`) ever enters BPE
vocabulary fitting, foundation pretraining, or instruction/head supervision.

Every assistant target is also checked against the non-anthropomorphic reply rules
enforced by `services/core/src/online/styles.mjs` (`auditReply`).
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re

import numpy as np

HELD_OUT_REPOS = ("pallets__click", "psf__requests")

CHAT_SYSTEM_PROMPT = (
    "Klyvaron first-party language model. Answer directly from available context "
    "and state clearly when supporting evidence is absent."
)

STATE_CLASSES = (
    "direct_question",
    "code_explanation",
    "summary_request",
    "debugging_report",
    "verification_check",
    "stepwise_procedure",
    "comparison_request",
    "uncertain_or_ambiguous",
)

VERDICT_LABELS = ("ungrounded", "grounded")

FORBIDDEN_REPLY_PATTERNS = (
    re.compile(r"\bi\s+(?:really\s+)?(?:feel|care|miss|love|worry)\b", re.IGNORECASE),
    re.compile(r"\bi(?:'m|\s+am)\s+(?:so\s+)?(?:proud|glad|happy|sad|sorry\s+to\s+hear|here\s+for\s+you)\b", re.IGNORECASE),
    re.compile(r"\bmy\s+(?:feelings|heart|emotions)\b", re.IGNORECASE),
    re.compile(r"\bas\s+a\s+friend\b", re.IGNORECASE),
    re.compile(r"\byou(?:'re|\s+are)\s+not\s+alone\b", re.IGNORECASE),
)


@dataclass(frozen=True)
class SFTExample:
    text: str
    prompt_prefix: str
    context_span_chars: tuple[int, int]
    context_age_bucket: int
    secondary_span_chars: tuple[int, int] | None
    secondary_age_bucket: int
    verdict: int
    state_class: int
    source_repo: str


def assert_non_anthropomorphic(reply: str) -> None:
    for pattern in FORBIDDEN_REPLY_PATTERNS:
        if pattern.search(reply):
            raise ValueError(f"reply violated non-anthropomorphic rule {pattern.pattern!r}: {reply!r}")


def format_turn(*, user: str, context: str = "none", reply: str | None = None, system: str = CHAT_SYSTEM_PROMPT) -> str:
    prefix = f"<|system|>\n{system}\n<|context|>\n{context}\n<|user|>\n{user}\n<|assistant|>\n"
    if reply is None:
        return prefix
    assert_non_anthropomorphic(reply)
    return f"{prefix}{reply}<|end|>\n"


def split_assembled_corpus(
    corpus_dir: Path,
    *,
    held_out_repos: tuple[str, ...] = HELD_OUT_REPOS,
    max_train_bytes_per_repo: int = 12_000_000,
) -> dict:
    """Load an assembled corpus directory with strict whole-repository holdout."""
    corpus_dir = Path(corpus_dir).resolve()
    train_parts: list[str] = []
    val_parts: list[str] = []
    repo_passages_train: list[tuple[str, str, str]] = []
    repo_passages_val: list[tuple[str, str, str]] = []
    manifest_entries: list[dict] = []

    held_out_set = set(held_out_repos)
    for child in sorted(corpus_dir.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        is_val = child.name in held_out_set
        used_bytes = 0
        files = [p for p in sorted(child.rglob("*")) if p.is_file()]
        for file_path in files:
            raw = file_path.read_bytes()
            text = raw.decode("utf-8", errors="replace").strip()
            if len(text) < 120:
                continue
            rel = f"{child.name}/{file_path.relative_to(child).as_posix()}"
            manifest_entries.append({
                "path": rel,
                "repo": child.name,
                "split": "validation" if is_val else "train",
                "bytes": len(raw),
                "sha256": hashlib.sha256(raw).hexdigest(),
            })
            if not is_val and used_bytes >= max_train_bytes_per_repo:
                continue
            used_bytes += len(raw)
            if is_val:
                val_parts.append(text)
            else:
                train_parts.append(text)
            passage = _extract_clean_passage(text)
            if passage:
                target = repo_passages_val if is_val else repo_passages_train
                target.append((child.name, file_path.name, passage))

    if not train_parts or not val_parts:
        raise ValueError(f"corpus split at {corpus_dir} produced empty train ({len(train_parts)}) or val ({len(val_parts)})")

    manifest_json = json.dumps(manifest_entries, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {
        "train_text": "\n\n".join(train_parts),
        "val_text": "\n\n".join(val_parts),
        "train_passages": repo_passages_train,
        "val_passages": repo_passages_val,
        "manifest_digest": hashlib.sha256(manifest_json).hexdigest(),
        "train_repos": sorted({e["repo"] for e in manifest_entries if e["split"] == "train"}),
        "val_repos": sorted({e["repo"] for e in manifest_entries if e["split"] == "validation"}),
        "file_count": len(manifest_entries),
    }


def _extract_clean_passage(text: str) -> str | None:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    prose = [
        ln for ln in lines
        if 35 <= len(ln) <= 220
        and not ln.startswith(("#!", "/*", "//", "import ", "from ", "export "))
        and sum(ch.isalpha() for ch in ln) >= 20
    ]
    if len(prose) < 2:
        return None
    snippet = " ".join(prose[:3])
    snippet = re.sub(r"\s+", " ", snippet).strip()
    return snippet[:340]


def _first_sentence(passage: str) -> str:
    parts = re.split(r"(?<=[.!?])\s+", passage.strip())
    first = parts[0].strip() if parts else passage.strip()
    return first[:220] if len(first) >= 24 else passage[:220].strip()


def build_sft_examples(
    passages: list[tuple[str, str, str]],
    *,
    seed: int,
    count: int,
    include_product_domain: bool = True,
) -> list[SFTExample]:
    """Deterministically build balanced supervision across all 8 states, 2 verdicts and 16 ages."""
    if not passages:
        raise ValueError("cannot build SFT examples from empty passages")
    rng = np.random.default_rng(seed)
    examples: list[SFTExample] = []

    domain_items = [
        (
            "rajaram-2005__ragam",
            "architecture.md",
            "Klyvaron Pro uses a 27,559,946-parameter aetheris-core-v1 Transformer with 8 layers, "
            "8 heads, d_model 512, 4,096 BPE tokens, age buckets, state embeddings, verdict head, and state head.",
        ),
        (
            "rajaram-2005__ragam",
            "architecture-max.md",
            "Klyvaron Max uses an independent 92,077,066-parameter aetheris-core-v1 Transformer with 12 layers, "
            "12 heads, d_model 768, 8,192 BPE tokens, 1,024 context window, verdict head, and state head.",
        ),
        (
            "rajaram-2005__ragam",
            "tiers.md",
            "Product plans in RAGAM control workspace routing preferences and remain separate from first-party "
            "Klyvaron model identities klyvaron-pro-lm and klyvaron-max-lm.",
        ),
        (
            "rajaram-2005__ragam",
            "areas.md",
            "The RAGAM web interface exposes five primary areas: Chat, Image, Video, Plugins, and MCP. "
            "Third-party providers are never silently substituted when a native Klyvaron model is selected.",
        ),
    ]
    pool = list(passages) + (domain_items * 6 if include_product_domain else [])

    for idx in range(count):
        state_class = idx % len(STATE_CLASSES)
        p_idx = int(rng.integers(0, len(pool)))
        other_idx = int(rng.integers(0, len(pool)))
        repo, filename, passage = pool[p_idx]
        _, other_file, other_passage = pool[other_idx]
        fact = _first_sentence(passage)
        topic = filename.rsplit(".", 1)[0].replace("_", " ").replace("-", " ").strip() or "module"

        # Alternate grounded (verdict=1) vs ungrounded/insufficient evidence (verdict=0) across all states.
        grounded = (idx // len(STATE_CLASSES)) % 2 == 1 or state_class in (1, 2)
        if state_class == 7:
            grounded = (idx % 3) == 0

        age_bucket = 1 + (idx % 14) if grounded else 15
        secondary_age = None

        if state_class == 0:  # direct_question
            user = f"What does {filename} state about {topic}?"
            if grounded:
                context = f"[source={filename}] {passage}"
                reply = f"According to {filename}, {fact}"
                verdict = 1
            else:
                context = "none"
                reply = f"No context passage for {filename} was provided in this turn, so that detail cannot be verified here."
                verdict = 0
        elif state_class == 1:  # code_explanation
            if (idx % 4) == 0:
                user = f"Explain the implementation detail for {topic} in {filename}."
                context = "none"
                reply = f"The source file {filename} is not attached in context. Provide the relevant snippet to inspect {topic}."
                verdict = 0
                age_bucket = 15
            else:
                user = f"Explain how {filename} describes {topic}."
                context = f"[source={filename}] {passage}"
                reply = f"In {filename}, the documented behavior is: {fact}"
                verdict = 1
        elif state_class == 2:  # summary_request
            if (idx % 4) == 0:
                user = f"Summarize the release notes for {topic}."
                context = "none"
                reply = f"No release note text for {topic} is present in context to summarize."
                verdict = 0
                age_bucket = 15
            else:
                user = f"Summarize the provided note from {filename} in one sentence."
                context = f"[source={filename}] {passage}"
                reply = f"Summary from {filename}: {fact}"
                verdict = 1
        elif state_class == 3:  # debugging_report
            user = f"Diagnose why {topic} failed checksum verification during load."
            if grounded:
                context = f"[source={filename}] {passage}"
                reply = f"Check the manifest SHA-256 digest and tensor shapes first. Reference note in {filename}: {fact}"
                verdict = 1
            else:
                context = "none"
                reply = "No error trace or manifest digest is in context. Check the SHA-256 checksum, tensor list, and file size."
                verdict = 0
                age_bucket = 15
        elif state_class == 4:  # verification_check (includes fresh vs stale two-passage grounding)
            user = f"Verify what the current source states for {topic}."
            if grounded:
                fresh = f"[recent:{filename}] {fact}"
                stale = f"[older:{other_file}] {_first_sentence(other_passage)}"
                context = f"{fresh}\n{stale}"
                age_bucket = 1 + (idx % 4)
                secondary_age = 10 + (idx % 5)
                reply = f"Supported by the fresher source {filename}: {fact}"
                verdict = 1
            else:
                context = f"[unrelated:{other_file}] {_first_sentence(other_passage)}"
                age_bucket = 12
                reply = f"The attached passage from {other_file} does not verify claims about {filename}."
                verdict = 0
        elif state_class == 5:  # stepwise_procedure
            user = f"List the steps to verify {topic} using {filename}."
            if grounded:
                context = f"[source={filename}] {passage}"
                reply = f"1. Read {filename}. 2. Confirm the documented rule: {fact}"
                verdict = 1
            else:
                context = "none"
                reply = f"No procedure document for {filename} is present in context; supply the file before running steps."
                verdict = 0
                age_bucket = 15
        elif state_class == 6:  # comparison_request
            user = f"Compare {filename} and {other_file} based on the attached context."
            if grounded:
                context = f"[source={filename}] {fact}\n[source={other_file}] {_first_sentence(other_passage)}"
                reply = f"{filename} states: {fact} Meanwhile, {other_file} notes: {_first_sentence(other_passage)}"
                verdict = 1
            else:
                context = "none"
                reply = f"Neither {filename} nor {other_file} was supplied in context for direct comparison."
                verdict = 0
                age_bucket = 15
        else:  # 7: uncertain_or_ambiguous
            user = f"Is {topic} enabled right now?"
            if grounded:
                context = f"[source={filename}] {passage}"
                reply = f"Based on the attached {filename} note: {fact}"
                verdict = 1
            else:
                context = "none"
                reply = f"The request is underspecified and no runtime status for {topic} is included in context."
                verdict = 0
                age_bucket = 15

        full_text = format_turn(user=user, context=context, reply=reply)
        prefix = format_turn(user=user, context=context, reply=None)
        ctx_marker = "<|context|>\n"
        c_start = full_text.index(ctx_marker) + len(ctx_marker)
        c_end = c_start + len(context)
        sec_span = None
        if secondary_age is not None and "\n" in context:
            split_at = c_start + context.index("\n")
            c_end_primary = split_at
            sec_span = (split_at, c_start + len(context))
        else:
            c_end_primary = c_end

        examples.append(
            SFTExample(
                text=full_text,
                prompt_prefix=prefix,
                context_span_chars=(c_start, c_end_primary),
                context_age_bucket=age_bucket,
                secondary_span_chars=sec_span,
                secondary_age_bucket=secondary_age if secondary_age is not None else age_bucket,
                verdict=verdict,
                state_class=state_class,
                source_repo=repo,
            )
        )
    return examples


def encode_sft_batch_arrays(examples: list[SFTExample], tokenizer, *, seq_len: int) -> dict[str, np.ndarray]:
    """Encode examples left-aligned at `pos[0..L-1]` matching runtime inference positions.

    `head_pos[idx] = L - 1` points to the exact last non-padding token where runtime
    inference reads `hf[0, -1, :]` for `verdict` and `state` predictions.
    """
    pad_id = int(tokenizer.encode("\n")[0])
    n = len(examples)
    inputs = np.full((n, seq_len), pad_id, dtype=np.int32)
    targets = np.full((n, seq_len), pad_id, dtype=np.int32)
    loss_mask = np.zeros((n, seq_len), dtype=np.float32)
    ages = np.zeros((n, seq_len), dtype=np.int32)
    prompt_pos = np.zeros((n,), dtype=np.int32)
    head_pos = np.zeros((n,), dtype=np.int32)
    verdicts = np.zeros((n,), dtype=np.int32)
    states = np.zeros((n,), dtype=np.int32)

    for idx, ex in enumerate(examples):
        before_ctx = ex.text[: ex.context_span_chars[0]]
        primary_ctx = ex.text[ex.context_span_chars[0] : ex.context_span_chars[1]]
        if ex.secondary_span_chars is not None:
            secondary_ctx = ex.text[ex.secondary_span_chars[0] : ex.secondary_span_chars[1]]
            after_ctx = ex.text[ex.secondary_span_chars[1] :]
        else:
            secondary_ctx = ""
            after_ctx = ex.text[ex.context_span_chars[1] :]

        t_before = tokenizer.encode(before_ctx)
        t_primary = tokenizer.encode(primary_ctx) if primary_ctx else np.empty((0,), dtype=np.int32)
        t_secondary = tokenizer.encode(secondary_ctx) if secondary_ctx else np.empty((0,), dtype=np.int32)
        t_after = tokenizer.encode(after_ctx)

        seq = np.concatenate([t_before, t_primary, t_secondary, t_after])
        age_seq = np.concatenate([
            np.zeros(len(t_before), dtype=np.int32),
            np.full(len(t_primary), ex.context_age_bucket, dtype=np.int32),
            np.full(len(t_secondary), ex.secondary_age_bucket, dtype=np.int32),
            np.zeros(len(t_after), dtype=np.int32),
        ])
        prefix_len = len(tokenizer.encode(ex.prompt_prefix))
        mask_seq = np.zeros(len(seq), dtype=np.float32)
        mask_seq[max(1, prefix_len - 1) :] = 1.0

        if len(seq) >= seq_len + 1:
            seq = seq[: seq_len + 1]
            age_seq = age_seq[: seq_len + 1]
            mask_seq = mask_seq[: seq_len + 1]
            inputs[idx] = seq[:-1]
            targets[idx] = seq[1:]
            ages[idx] = age_seq[:-1]
            loss_mask[idx] = mask_seq[:-1]
            prompt_pos[idx] = min(max(0, prefix_len - 1), seq_len - 1)
            head_pos[idx] = seq_len - 1
        else:
            L = len(seq) - 1
            inputs[idx, :L] = seq[:-1]
            targets[idx, :L] = seq[1:]
            ages[idx, :L] = age_seq[:-1]
            loss_mask[idx, :L] = mask_seq[:-1]
            prompt_pos[idx] = min(max(0, prefix_len - 1), max(0, L - 1))
            head_pos[idx] = max(0, L - 1)

        verdicts[idx] = ex.verdict
        states[idx] = ex.state_class

    return {
        "inputs": inputs,
        "targets": targets,
        "loss_mask": loss_mask,
        "ages": ages,
        "prompt_pos": prompt_pos,
        "head_pos": head_pos,
        "verdicts": verdicts,
        "states": states,
    }
