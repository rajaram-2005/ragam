"""Export a trained checkpoint as a loadable Klyvaron artifact, and as a parity fixture.

A training run produces an `.npz` and a report. Neither is loadable by anything except
this package: the report describes the run, and an `.npz` is a bag of arrays with no
statement of the architecture, the vocabulary, the digests or the limitations. This
module is the last step that turns those into an *artifact*:

    <id>.klyvaron.json   the manifest -- architecture, vocabulary, digests, provenance,
                         measurements and limitations. Read by the core service.
    <id>-<version>.npz   the same weights, under a name the manifest points at.

Everything the manifest asserts is computed from files on disk at export time, never
copied from a claim: the weight digest is the SHA-256 of the bytes being shipped, the
vocabulary digest is recomputed from the tokenizer about to be embedded, and the corpus
manifest digest is read back out of the run's snapshot.

THE SHARED DIGEST FORMULA

`vocabulary_digest` / `bpe_digest` here and `vocabularyDigest` / `bpeDigest` in
`services/core/src/klyvaron/format.mjs` are one specification implemented twice, and
`tests/test_lm_export.py` compares them against the JavaScript implementation itself
rather than trusting this docstring.

WHY A PARITY FIXTURE EXISTS

The core service reimplements this forward pass in JavaScript. "The same architecture"
is not something a reader can verify by inspection, and a silently different activation,
attention scale or output projection would produce a model that runs and is wrong. The
fixture carries *the exact weights* (as base64 float32), the numpy-computed reference
logits, and the greedy continuation computed here, so `services/core` can prove its
implementation agrees with this one on identical bytes.
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

import numpy as np

from .bpe import BASE_VOCAB_SIZE, ByteBPETokenizer
from .evaluate import generate
from .model import TransformerConfig, TransformerLM, weights_digest
from .tokenizer import CharacterTokenizer

ARTIFACT_FORMAT = "klyvaron.artifact/1"
TOKENIZER_FORMAT = "klyvaron.tokenizer.character/1"
BYTE_BPE_FORMAT = "klyvaron.tokenizer.byte-bpe/1"
PARITY_FORMAT = "klyvaron.parity-fixture/1"
UNK_CHAR = "\ufffd"

#: Trunk architecture fields present on every artifact.
ARCHITECTURE_FIELDS = ("vocab_size", "d_model", "n_layers", "n_heads", "d_ff", "seq_len", "tie_embeddings")
DIFFERENTIATOR_FIELDS = ("age_buckets", "state_classes", "verdict_head", "state_head")


def vocabulary_digest(characters) -> str:
    """Hash a character vocabulary exactly as `format.mjs` does."""
    digest = hashlib.sha256()
    digest.update(f"{TOKENIZER_FORMAT}\n".encode("utf-8"))
    for character in characters:
        digest.update(json.dumps(character, ensure_ascii=False).encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


def bpe_digest(merges, base_vocab_size: int = BASE_VOCAB_SIZE) -> str:
    """Hash a byte-BPE merge list exactly as `format.mjs` does."""
    digest = hashlib.sha256()
    digest.update(f"{BYTE_BPE_FORMAT}\n{int(base_vocab_size)}\n".encode("utf-8"))
    for left, right in merges:
        digest.update(f"{int(left)},{int(right)}\n".encode("utf-8"))
    return digest.hexdigest()


def serialize_tokenizer(tokenizer) -> dict:
    """Serialise either first-party tokenizer with its shared cross-language digest."""
    if isinstance(tokenizer, CharacterTokenizer):
        return {
            "kind": "character",
            "unkChar": UNK_CHAR,
            "characters": list(tokenizer.characters),
            "digest": vocabulary_digest(tokenizer.characters),
        }
    if isinstance(tokenizer, ByteBPETokenizer):
        return {
            "kind": "byte-bpe",
            "baseVocabSize": BASE_VOCAB_SIZE,
            "merges": [[int(a), int(b)] for a, b in tokenizer.merges],
            "digest": bpe_digest(tokenizer.merges, BASE_VOCAB_SIZE),
        }
    raise TypeError(f"unsupported tokenizer type: {type(tokenizer)!r}")


def load_tokenizer_manifest(payload: dict):
    """Reconstruct a first-party tokenizer from a manifest `tokenizer` block."""
    kind = payload.get("kind")
    if kind == "character":
        tokenizer = CharacterTokenizer.from_dict(payload)
        expected = vocabulary_digest(tokenizer.characters)
    elif kind == "byte-bpe":
        tokenizer = ByteBPETokenizer.from_dict(payload)
        expected = bpe_digest(tokenizer.merges, payload.get("baseVocabSize", BASE_VOCAB_SIZE))
    else:
        raise ValueError(f"unsupported tokenizer kind: {kind!r}")
    if payload.get("digest") != expected:
        raise ValueError("tokenizer digest mismatch")
    return tokenizer


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _has_differentiators(config: TransformerConfig) -> bool:
    return bool(config.age_buckets or config.state_classes or config.verdict_head or config.state_head)


def architecture_block(config: TransformerConfig) -> dict:
    """The architecture as the artifact format states it -- only what a loader needs."""
    block = {field: getattr(config, field) for field in ARCHITECTURE_FIELDS}
    if _has_differentiators(config):
        for field in DIFFERENTIATOR_FIELDS:
            block[field] = getattr(config, field)
    return block


def config_from_architecture(block: dict) -> TransformerConfig:
    """Build `TransformerConfig` from a manifest or training report architecture dict."""
    kwargs = {field: block[field] for field in ARCHITECTURE_FIELDS}
    for field in DIFFERENTIATOR_FIELDS:
        if field in block:
            kwargs[field] = block[field]
    return TransformerConfig(**kwargs)


def build_manifest(
    *,
    config: TransformerConfig,
    tokenizer,
    weights_file: str,
    weights_bytes: bytes,
    weights_names: list[str],
    artifact_id: str,
    version: str,
    tier: str = "lite",
    instruction_tuned: bool = False,
    generation: dict | None = None,
    chat_template: dict | None = None,
    differentiators: dict | None = None,
    provenance: dict | None = None,
    limitations: list[str] | None = None,
    benchmarks: list[dict] | None = None,
    licence: str = "MIT",
) -> dict:
    """Assemble a manifest from what is actually in the artifact."""
    if not limitations:
        raise ValueError("an artifact must declare at least one limitation; a model with none is a claim")
    if not instruction_tuned and not any("instruction" in line.lower() for line in limitations):
        raise ValueError(
            "a base model's limitations must say that it does not follow instructions; "
            "that sentence is the one a reader needs most"
        )

    manifest = {
        "format": ARTIFACT_FORMAT,
        "tier": tier,
        "id": artifact_id,
        "version": version,
        "kind": "language_model",
        "instructionTuned": instruction_tuned,
        "architecture": architecture_block(config),
        "tokenizer": serialize_tokenizer(tokenizer),
        "weights": {
            "file": weights_file,
            "sha256": _sha256_bytes(weights_bytes),
            "bytes": len(weights_bytes),
            "names": sorted(weights_names),
        },
        "generation": {
            "maxNewTokens": 64,
            "temperature": 0.0,
            "topK": 40,
            "stop": [],
            **(generation or {}),
        },
        "provenance": {
            "origin": "first_party",
            "trainedFrom": "random initialisation (no pretrained base)",
            "trainingFramework": "pure NumPy (services/fabric)",
            **(provenance or {}),
        },
        "benchmarks": list(benchmarks or []),
        "limitations": list(limitations),
        "licence": licence,
    }
    if chat_template is not None:
        manifest["chatTemplate"] = dict(chat_template)
    if differentiators is not None:
        manifest["differentiators"] = dict(differentiators)
    return manifest


def export_artifact(
    *,
    report: dict,
    artifact_path: Path,
    corpus_snapshot: Path | None = None,
    tokenizer_path: Path | None = None,
    output_dir: Path,
    artifact_id: str,
    version: str,
    tier: str = "lite",
    instruction_tuned: bool = False,
    generation: dict | None = None,
    chat_template: dict | None = None,
    differentiators: dict | None = None,
    limitations: list[str],
    benchmarks: list[dict] | None = None,
    report_path: Path | None = None,
) -> dict:
    """Write `<id>.klyvaron.json` and `<id>-<version>.npz` into `output_dir`."""
    config = config_from_architecture(report["model_config"])
    model = TransformerLM.load(artifact_path, config)

    if "artifact" in report and report["artifact"].get("weightsDigest"):
        recomputed = weights_digest(model.params)
        if recomputed != report["artifact"]["weightsDigest"]:
            raise ValueError(
                f"{artifact_path} has weights digest {recomputed}, the report says "
                f"{report['artifact']['weightsDigest']}; the checkpoint and the report are from different runs"
            )

    if tokenizer_path is not None:
        tok_payload = json.loads(Path(tokenizer_path).read_text(encoding="utf-8"))
        tokenizer = (
            ByteBPETokenizer.from_dict(tok_payload)
            if tok_payload.get("kind") == "byte-bpe"
            else CharacterTokenizer.from_dict(tok_payload)
        )
    else:
        if corpus_snapshot is None:
            raise ValueError("export_artifact requires either corpus_snapshot or tokenizer_path")
        train_text, _validation, _manifest = _read_snapshot(corpus_snapshot)
        tokenizer = CharacterTokenizer.fit([train_text])

    if tokenizer.digest != report["tokenizer"]["vocabularyDigest"]:
        raise ValueError(
            "the tokenizer does not match the report's tokenizer digest; "
            "the tokenizer or snapshot belongs to a different run"
        )

    weights_bytes = Path(artifact_path).read_bytes()
    weights_file = f"{artifact_id}-{version}.npz"
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / weights_file).write_bytes(weights_bytes)

    provenance = {
        "codeRevision": report["provenance"].get("codeRevision"),
        "python": report["provenance"].get("python"),
        "numpy": report["provenance"].get("numpy"),
        "platform": report["provenance"].get("platform"),
        "seeds": report["provenance"].get("seed"),
        "parameterCount": report["provenance"].get("parameterCount"),
        "corpus": {
            "manifestDigest": report["corpus"].get("manifestDigest"),
            "trainCharacters": report["corpus"].get("trainCharacters"),
            "validationCharacters": report["corpus"].get("validationCharacters"),
            "trainTokens": report["corpus"].get("trainTokens"),
            "validationTokens": report["corpus"].get("validationTokens"),
        },
        "trainingReport": {
            "file": report_path.name if report_path else None,
            "sha256": _sha256_file(report_path) if report_path else None,
        },
        "trainingVocabularyDigest": report["tokenizer"]["vocabularyDigest"],
        "weightsDigest": weights_digest(model.params),
    }
    if "trainingFramework" in report.get("provenance", {}):
        provenance["trainingFramework"] = report["provenance"]["trainingFramework"]

    with np.load(artifact_path) as archive:
        declared = sorted(archive.files)
    expected = sorted(_expected_names(config))
    if declared != expected:
        raise ValueError(f"the archive holds {declared}, the architecture expects {expected}")

    payload = build_manifest(
        config=config,
        tokenizer=tokenizer,
        weights_file=weights_file,
        weights_bytes=weights_bytes,
        weights_names=declared,
        artifact_id=artifact_id,
        version=version,
        tier=tier,
        instruction_tuned=instruction_tuned,
        generation=generation,
        chat_template=chat_template,
        differentiators=differentiators,
        provenance=provenance,
        limitations=limitations,
        benchmarks=benchmarks,
    )

    manifest_path = output_dir / f"{artifact_id}.klyvaron.json"
    manifest_text = _format_manifest_json(payload, sort_keys=False)
    manifest_path.write_text(manifest_text, encoding="utf-8")
    return {"manifest": payload, "manifestPath": str(manifest_path), "weightsPath": str(output_dir / weights_file)}


def _expected_names(config: TransformerConfig) -> list[str]:
    names = ["emb", "pos"]
    for layer in range(config.n_layers):
        names += [
            f"L{layer}.ln1_gain", f"L{layer}.ln1_bias",
            f"L{layer}.wq", f"L{layer}.wk", f"L{layer}.wv", f"L{layer}.wo",
            f"L{layer}.ln2_gain", f"L{layer}.ln2_bias",
            f"L{layer}.w1", f"L{layer}.w2",
        ]
    names += ["lnf_gain", "lnf_bias"]
    if not config.tie_embeddings:
        names.append("head")
    if config.age_buckets:
        names.append("age_emb")
    if config.state_classes:
        names.append("state_emb")
    if config.verdict_head:
        names += ["verdict_w", "verdict_b"]
    if config.state_head:
        names += ["state_head_w", "state_head_b"]
    return names


def _read_snapshot(path: Path) -> tuple[str, str, dict]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if payload.get("format") != "aetheris-corpus-snapshot/v1":
        raise ValueError(f"{path} is not an aetheris corpus snapshot")
    return payload["train"], payload["validation"], payload["manifest"]


# ---------------------------------------------------------------------------
# The parity fixture
# ---------------------------------------------------------------------------

PARITY_CORPUS = (
    "Aetheris Omni runs a model on the device, not in a data centre. "
    "Klyvaron Lite continues text; it does not answer questions. "
    "A small model that is honest about its limits is more useful than a large claim. "
) * 8


def _encode_arrays(params: dict) -> dict:
    encoded = {}
    for name, array in params.items():
        little = np.ascontiguousarray(array.astype(np.float32))
        encoded[name] = {
            "shape": list(little.shape),
            "dtype": "float32",
            "base64": base64.b64encode(little.tobytes(order="C")).decode("ascii"),
        }
    return encoded


def parity_fixture(
    *,
    config: TransformerConfig,
    seed: int = 7,
    prompts: tuple[str, ...] = ("Aetheris", "Klyvaron "),
    max_new_tokens: int = 24,
    artifact_id: str = "klyvaron-parity-tiny",
    version: str = "0.1.0",
    tier: str = "lite",
) -> dict:
    """Build a fixture that pins the JavaScript forward pass to this one."""
    tokenizer = CharacterTokenizer.fit([PARITY_CORPUS])
    config = TransformerConfig(vocab_size=tokenizer.size, **{
        field: getattr(config, field) for field in ARCHITECTURE_FIELDS + DIFFERENTIATOR_FIELDS if field != "vocab_size"
    })
    model = TransformerLM(config, seed=seed)

    from tempfile import TemporaryDirectory

    with TemporaryDirectory() as tmp:
        npz_path = Path(tmp) / "parity.npz"
        model.save(npz_path)
        weights_bytes = npz_path.read_bytes()

    cases = []
    for prompt in prompts:
        ids = tokenizer.encode(prompt)
        kwargs = {}
        if config.age_buckets:
            kwargs["ages"] = np.zeros((1, len(ids)), dtype=np.int64)
        if config.state_classes:
            kwargs["states"] = np.zeros((1,), dtype=np.int64)
        logits = model.forward(np.asarray(ids, dtype=np.int32)[None, :], **kwargs)[0, -1]
        ordered = np.sort(logits.astype(np.float64))[::-1]
        gap = float(ordered[0] - ordered[1])
        cases.append({
            "prompt": prompt,
            "tokenIds": [int(i) for i in ids],
            "logits": [float(v) for v in logits],
            "topGap": gap,
        })
    greedy = []
    for prompt in prompts:
        if _has_differentiators(config):
            ids = list(int(i) for i in tokenizer.encode(prompt))
            for _ in range(max_new_tokens):
                win = np.asarray(ids[-config.seq_len :], dtype=np.int32)[None, :]
                kwargs = {}
                if config.age_buckets:
                    kwargs["ages"] = np.zeros_like(win, dtype=np.int64)
                if config.state_classes:
                    kwargs["states"] = np.zeros((1,), dtype=np.int64)
                nxt = int(np.argmax(model.forward(win, **kwargs)[0, -1]))
                ids.append(nxt)
            text = tokenizer.decode(ids)
        else:
            text = generate(model, tokenizer, prompt, max_new_tokens=max_new_tokens, temperature=0.0, seed=0)
        greedy.append({"prompt": prompt, "maxNewTokens": max_new_tokens, "text": text})

    manifest = build_manifest(
        config=config,
        tokenizer=tokenizer,
        weights_file="parity.npz",
        weights_bytes=weights_bytes,
        weights_names=sorted(model.params.keys()),
        artifact_id=artifact_id,
        version=version,
        tier=tier,
        instruction_tuned=False,
        generation={"maxNewTokens": max_new_tokens, "temperature": 0.0, "topK": 40, "stop": []},
        provenance={
            "origin": "test_fixture",
            "trainedFrom": "not trained: deterministic random initialisation (seed %d)" % seed,
            "parameterCount": model.parameter_count,
        },
        limitations=[
            "This is a test fixture, not a released model. It does not follow instructions.",
            "Its weights are random initialisation; no training step was run.",
        ],
    )
    return {
        "format": PARITY_FORMAT,
        "notice": (
            "Generated by services/fabric/scripts/export_lm.py --parity-fixture. "
            "The weights are random initialisation and are here to compare two implementations "
            "of the same forward pass, not to be used as a model."
        ),
        "manifest": manifest,
        "npzBase64": base64.b64encode(weights_bytes).decode("ascii"),
        "weights": _encode_arrays(model.params),
        "cases": cases,
        "greedy": greedy,
    }


def _format_manifest_json(payload: dict, *, sort_keys: bool) -> str:
    """Format JSON cleanly while keeping large BPE `[a, b]` merge pairs compact."""
    if payload.get("tokenizer", {}).get("kind") != "byte-bpe":
        return json.dumps(payload, indent=2, sort_keys=sort_keys, ensure_ascii=False) + "\n"
    sentinel = "__BPE_MERGES_COMPACT_SENTINEL__"
    cloned = dict(payload)
    tok = dict(cloned["tokenizer"])
    merges = tok["merges"]
    tok["merges"] = sentinel
    cloned["tokenizer"] = tok
    rendered = json.dumps(cloned, indent=2, sort_keys=sort_keys, ensure_ascii=False)
    compact_merges = "[" + ",".join(f"[{int(a)},{int(b)}]" for a, b in merges) + "]"
    return rendered.replace(f'"{sentinel}"', compact_merges, 1) + "\n"


def write_json(path: Path, payload: dict) -> str:
    """Write JSON deterministically: sorted keys, one trailing newline, fixed indent."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = _format_manifest_json(payload, sort_keys=True)
    path.write_text(text, encoding="utf-8")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
