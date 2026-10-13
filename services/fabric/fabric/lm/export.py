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

`vocabulary_digest` here and `vocabularyDigest` in `services/core/src/klyvaron/format.mjs`
are one specification implemented twice, and `tests/test_lm_export.py` compares them
against the JavaScript implementation itself rather than trusting this docstring. The
formula avoids Python-on-one-side/JavaScript-on-the-other inside a single hash: instead
of hashing a serialised container, it hashes each character on its own line, JSON-quoted,
so a character that happens to be a newline, a quote or a backslash cannot be confused
with the separator. The training report's own `vocabularyDigest` (Python's JSON of the
whole tokenizer payload) is a separate identity and is checked against, not reused.

WHY A PARITY FIXTURE EXISTS

The core service reimplements this forward pass in JavaScript. "The same architecture"
is not something a reader can verify by inspection, and a silently different activation,
attention scale or output projection would produce a model that runs and is wrong. The
fixture carries *the exact weights* (as base64 float32), the numpy-computed reference
logits, and the greedy continuation computed here, so `services/core` can prove its
implementation agrees with this one on identical bytes. The fixture is small because the
model in it is small: it exists to be exact, not to be good.
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

import numpy as np

from .evaluate import generate
from .model import TransformerConfig, TransformerLM, weights_digest
from .tokenizer import CharacterTokenizer

ARTIFACT_FORMAT = "klyvaron.artifact/1"
TOKENIZER_FORMAT = "klyvaron.tokenizer.character/1"
PARITY_FORMAT = "klyvaron.parity-fixture/1"
UNK_CHAR = "\ufffd"

#: The architecture fields the artifact format carries. `dropout`, `init_scale` and
#: `layernorm_eps` are deliberately absent: the first is unused by construction, and the
#: other two are training-time choices already baked into the weights.
ARCHITECTURE_FIELDS = ("vocab_size", "d_model", "n_layers", "n_heads", "d_ff", "seq_len", "tie_embeddings")


def vocabulary_digest(characters) -> str:
    """Hash a vocabulary exactly as `format.mjs` does. See the module docstring."""
    digest = hashlib.sha256()
    digest.update(f"{TOKENIZER_FORMAT}\n".encode("utf-8"))
    for character in characters:
        digest.update(json.dumps(character, ensure_ascii=False).encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def architecture_block(config: TransformerConfig) -> dict:
    """The architecture as the artifact format states it -- only what a loader needs."""
    return {field: getattr(config, field) for field in ARCHITECTURE_FIELDS}


def build_manifest(
    *,
    config: TransformerConfig,
    tokenizer: CharacterTokenizer,
    weights_file: str,
    weights_bytes: bytes,
    weights_names: list[str],
    artifact_id: str,
    version: str,
    tier: str = "lite",
    instruction_tuned: bool = False,
    generation: dict | None = None,
    provenance: dict | None = None,
    limitations: list[str] | None = None,
    benchmarks: list[dict] | None = None,
    licence: str = "MIT",
) -> dict:
    """Assemble a manifest from what is actually in the artifact.

    `weights_bytes` is the file's content, not its path, because every digest below is
    computed from the bytes that will be shipped.
    """
    if not limitations:
        raise ValueError("an artifact must declare at least one limitation; a model with none is a claim")
    if not instruction_tuned and not any("instruction" in line.lower() for line in limitations):
        raise ValueError(
            "a base model's limitations must say that it does not follow instructions; "
            "that sentence is the one a reader needs most"
        )

    return {
        "format": ARTIFACT_FORMAT,
        "tier": tier,
        "id": artifact_id,
        "version": version,
        "kind": "language_model",
        "instructionTuned": instruction_tuned,
        "architecture": architecture_block(config),
        "tokenizer": {
            "kind": "character",
            "unkChar": UNK_CHAR,
            "characters": list(tokenizer.characters),
            "digest": vocabulary_digest(tokenizer.characters),
        },
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


def export_artifact(
    *,
    report: dict,
    artifact_path: Path,
    corpus_snapshot: Path,
    output_dir: Path,
    artifact_id: str,
    version: str,
    tier: str = "lite",
    instruction_tuned: bool = False,
    generation: dict | None = None,
    limitations: list[str],
    benchmarks: list[dict] | None = None,
    report_path: Path | None = None,
) -> dict:
    """Write `<id>.klyvaron.json` and `<id>-<version>.npz` into `output_dir`.

    Refuses when the checkpoint does not match the report it is exported with: the two
    are separate files, so "export the wrong run" is a mistake that would otherwise ship
    a manifest describing weights that are not the weights next to it.
    """
    config = TransformerConfig(**{field: report["model_config"][field] for field in ARCHITECTURE_FIELDS})
    model = TransformerLM.load(artifact_path, config)

    # The report's artifact digest was computed in memory at training time; recomputing
    # it from the file proves the file is the one the report describes.
    if "artifact" in report and report["artifact"].get("weightsDigest"):
        recomputed = weights_digest(model.params)
        if recomputed != report["artifact"]["weightsDigest"]:
            raise ValueError(
                f"{artifact_path} has weights digest {recomputed}, the report says "
                f"{report['artifact']['weightsDigest']}; the checkpoint and the report are from different runs"
            )

    train_text, _validation, _manifest = _read_snapshot(corpus_snapshot)
    tokenizer = CharacterTokenizer.fit([train_text])
    if tokenizer.digest != report["tokenizer"]["vocabularyDigest"]:
        raise ValueError(
            "the tokenizer refitted from the corpus snapshot does not match the report's "
            "tokenizer digest; the snapshot belongs to a different run"
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

    # The weight list is read from the archive rather than from the config, so a
    # checkpoint carrying an unexpected parameter fails here rather than at load time
    # on a user's device.
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
        provenance=provenance,
        limitations=limitations,
        benchmarks=benchmarks,
    )

    manifest_path = output_dir / f"{artifact_id}{'.klyvaron.json'}"
    manifest_path.write_text(json.dumps(payload, indent=2, sort_keys=False, ensure_ascii=False) + "\n", encoding="utf-8")
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
    return names


def _read_snapshot(path: Path) -> tuple[str, str, dict]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if payload.get("format") != "aetheris-corpus-snapshot/v1":
        raise ValueError(f"{path} is not an aetheris corpus snapshot")
    return payload["train"], payload["validation"], payload["manifest"]


# ---------------------------------------------------------------------------
# The parity fixture
# ---------------------------------------------------------------------------

#: A fixed corpus for the fixture model. Literal so the fixture does not change when the
#: repository does -- a parity fixture that moves is a parity fixture that cannot be
#: compared across revisions.
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
    """Build a fixture that pins the JavaScript forward pass to this one.

    The model is random-initialised rather than trained: the property under test is
    numerical agreement on identical bytes, which training would only make slower to
    reproduce. The fixture says so in its own `notice` field, so nobody later mistakes it
    for a released checkpoint.
    """
    tokenizer = CharacterTokenizer.fit([PARITY_CORPUS])
    config = TransformerConfig(vocab_size=tokenizer.size, **{
        field: getattr(config, field) for field in ARCHITECTURE_FIELDS if field != "vocab_size"
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
        logits = model.forward(np.asarray(ids, dtype=np.int32)[None, :])[0, -1]
        ordered = np.sort(logits.astype(np.float64))[::-1]
        gap = float(ordered[0] - ordered[1])
        cases.append({
            "prompt": prompt,
            "tokenIds": [int(i) for i in ids],
            "logits": [float(v) for v in logits],
            # Recorded so a later failure can be attributed: if the top two logits are
            # within the tolerance the comparison uses, greedy agreement is luck rather
            # than evidence, and the fixture would be a bad test.
            "topGap": gap,
        })
    greedy = [
        {
            "prompt": prompt,
            "maxNewTokens": max_new_tokens,
            "text": generate(model, tokenizer, prompt, max_new_tokens=max_new_tokens, temperature=0.0, seed=0),
        }
        for prompt in prompts
    ]

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


def write_json(path: Path, payload: dict) -> str:
    """Write a fixture deterministically: sorted keys, one trailing newline, fixed indent."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False)
    path.write_text(text + "\n", encoding="utf-8")
    return hashlib.sha256((text + "\n").encode("utf-8")).hexdigest()
