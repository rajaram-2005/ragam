"""Turn a training report into a model card, and let the release gate decide.

This module deliberately does not implement versioning, rollback or a release gate.
`fabric/modelcards.py` already has all three, tested, and building a second copy
would be exactly the duplication the brief forbids. What this adds is the *policy*
for a language model: which numbers count as requirements, and which are only
recorded as limitations.

The requirements are chosen so that passing them means something:

* **`perplexityVsBigram` <= 1.0 (hard).** The model must beat a bigram table
  estimated from the same training text and scored on the same held-out tokens. This
  is the only requirement that speaks to whether the model learned anything about
  order rather than about frequency. A model that cannot beat a bigram table has not
  earned the compute it cost.
* **`validationUnknownRate` <= 0.02 (hard).** The tokenizer is fitted on training
  text only, so validation characters can be unknown. If too many are, the perplexity
  is partly a measurement of the `<unk>` token and does not describe language
  modelling. A number that does not measure what it claims must not be releasable.
* **`lossImprovement` >= 1.0 (hard).** Final loss must be below initial loss.
  Guards against a run that diverged and was recorded anyway.
* **`parameterCount` <= 5,000,000 (soft).** A limitation, not a gate: exceeding it
  means the model is larger than the "Lite" family is meant to be, and that is
  recorded on the card rather than blocking the release.
* **`wallSeconds` <= 3600 (soft).** Records cost.
"""

from __future__ import annotations

import math

from ..modelcards import EvaluationProvenance, ModelReleaseManager, ModelReleaseError, Requirement, StageStatus


#: Name of the sole first-party language model in the Aetheris Lite family.
LM_NAME = "aetheris-lite-lm"
LM_FAMILY = "aetheris-lite"
LM_LICENCE = "MIT"  # first-party weights trained here; see the NOTICES for dependencies


def requirements_for_language_model() -> tuple[Requirement, ...]:
    return (
        Requirement(metric="perplexityVsBigram", maximum=1.0, hard=True),
        Requirement(metric="validationUnknownRate", maximum=0.02, hard=True),
        Requirement(metric="lossImprovement", minimum=1.0, hard=True),
        Requirement(metric="parameterCount", maximum=5_000_000, hard=False),
        Requirement(metric="wallSeconds", maximum=3600.0, hard=False),
    )


def metrics_from_report(report) -> dict:
    """Extract the numbers the requirements are checked against."""
    payload = report.to_dict() if hasattr(report, "to_dict") else dict(report)
    evaluation = payload["evaluation"]
    best = next(
        (b for b in evaluation["baselines"] if b["name"] == evaluation["bestBaseline"]),
        None,
    )
    if best is None:
        raise ValueError("the report has no baselines; a perplexity with nothing to compare to cannot be gated")
    ratio = evaluation["perplexity"] / best["perplexity"]
    first = payload["loss_curve"][0]["loss"]
    final = payload["final_loss"]
    # Numeric only. `ModelReleaseManager.validate` coerces every entry with float(),
    # which is correct -- a metric is a number. The name of the baseline that was
    # beaten is context, not a metric, and lives on the card's artifacts instead.
    return {
        "validationPerplexity": float(evaluation["perplexity"]),
        "bitsPerToken": float(evaluation.get("bitsPerToken", evaluation["nllNatsPerToken"] / 0.6931471805599453)),
        "bitsPerCharacter": float(evaluation["bitsPerCharacter"]),
        "perplexityVsBigram": float(ratio),
        "bestBaselinePerplexity": float(best["perplexity"]),
        "validationUnknownRate": float(evaluation["unknownRate"]),
        "validationTokens": float(evaluation["tokensEvaluated"]),
        "lossImprovement": float(first - final),
        "finalLoss": float(final),
        "parameterCount": float(payload["provenance"]["parameterCount"]),
        "wallSeconds": float(payload["resource"]["wallSeconds"]),
    }


def best_baseline_name(report) -> str:
    """Which baseline the model was measured against. Context, not a metric."""
    payload = report.to_dict() if hasattr(report, "to_dict") else dict(report)
    name = payload["evaluation"]["bestBaseline"]
    if not name:
        raise ValueError("the report does not record which baseline was strongest")
    return str(name)


def model_limitations(report) -> list[str]:
    """Limitations of the *model*, stated on the card itself.

    Distinct from `limitations_from_report`, which describes the *evaluation*
    conditions. The retriever card keeps both lists, and for good reason: "trained
    from scratch, not derived from a pretrained base" is a fact about the artifact,
    while "the corpus is in-distribution" is a fact about the measurement. Leaving
    the card's own `limitations` field empty would make a reader who looks there --
    which is where a reader looks -- conclude there are none.
    """
    payload = report.to_dict() if hasattr(report, "to_dict") else dict(report)
    return [
        "trained from random initialisation; not derived from any pretrained base model",
        # What the model emits is not a property of this project, it is a property of the
        # artifact's tokenizer: a byte-BPE model produces subword pieces, and a card that called
        # it character-level would misdescribe every prediction it makes.
        (
            f"byte-level BPE subword model: it predicts the next token of the text it was trained "
            f"on and follows no instructions "
            f"({payload['provenance']['parameterCount']:,} parameters, vocabulary of "
            f"{payload['tokenizer']['size']})"
            if payload["tokenizer"].get("kind") == "byte-bpe"
            else f"character-level base model: it predicts the next character of the text it was trained "
            f"on and follows no instructions "
            f"({payload['provenance']['parameterCount']:,} parameters, vocabulary of "
            f"{payload['tokenizer']['size']})"
        ),
        "output quality is low: this demonstrates the pipeline, not a usable assistant",
        # This sentence used to say the model is "deliberately not wired into /api/chat",
        # which stopped being true when the artifact became installable and routable: the
        # route exists and refuses. A limitation that describes the wrong behaviour is
        # worse than no limitation, because it is quoted as the reason the behaviour is safe.
        #
        # It is now stated as the rule that follows from the flag rather than as a claim that
        # this particular file has been through an export and a runtime verification run. The
        # refusal is a property of the router plus `instructionTuned: false` in the manifest,
        # and `instructionTuned` comes from the manifest rather than from a list of model ids,
        # so the rule holds for every artifact this trainer can produce -- including the ones
        # that have not been exported yet, which is exactly when a card must not imply they
        # have been.
        "not instruction-tuned: a runtime that serves it reports instructionTuned false, and "
        "/api/chat refuses an unpinned request with model_not_instruction_tuned (501), because it "
        "continues text and does not answer questions, and presenting it as an assistant would "
        "misrepresent it",
        "no comparison against any pretrained model was performed, and none is claimed",
    ]


def corpus_description(payload: dict) -> str:
    """How the training text is described, read out of the manifest rather than remembered.

    The released Lite run trained on this repository's own text, and its card says exactly
    that. A run over an assembled corpus is a different claim -- several sources, each
    licence-checked, with an evaluation split held out by source -- so a sentence about
    "this repository's own text" would be describing text the model did not train on.
    """
    corpus = payload["corpus"]
    sources = corpus.get("sources") or {}
    held_out = corpus.get("heldOutSources") or []
    if not sources:
        return f"{corpus['trainBytes']:,} bytes of this repository's own text"
    described = f"{corpus['trainBytes']:,} bytes assembled from {len(sources)} licence-checked sources"
    if held_out:
        described += (
            f", {len(held_out)} of them held out whole for validation "
            f"({', '.join(held_out)})"
        )
    return described


def limitations_from_report(report) -> list[str]:
    """What the evaluation conditions limit, recorded on the provenance."""
    payload = report.to_dict() if hasattr(report, "to_dict") else dict(report)
    parameters = payload["provenance"]["parameterCount"]
    baseline = payload["evaluation"]["bestBaseline"]
    bpe = payload["tokenizer"].get("kind") == "byte-bpe"
    limitations = [
        (
            "Byte-level BPE: the vocabulary is learned, and the merge list is stored with the "
            "weights because it cannot be re-derived from the corpus."
            if bpe else
            "Character-level, not subword: sequences are long for the parameter count."
        ),
        f"Trained from scratch on {corpus_description(payload)}. It has no world knowledge, "
        "no instruction-following and no safety behaviour.",
        f"Output quality is low by design of the experiment: {parameters:,} parameters trained for "
        f"{payload['resource']['steps']} steps. This proves the pipeline, not the model.",
        f"Evaluated only against {baseline}/uniform/unigram baselines on in-distribution held-out "
        "text; no comparison against any pretrained model was performed and none is claimed.",
        (
            "Not instruction-tuned: it continues text and cannot be exposed as a chat assistant in "
            "this state."
            if bpe else
            "Not instruction-tuned and has no tokenizer beyond ASCII-and-source-code characters; it "
            "cannot be exposed as a chat assistant in this state."
        ),
    ]
    if payload["tokenizer"]["validationUnknownRate"] > 0 and not bpe:
        limitations.append(
            f"{payload['tokenizer']['validationUnknownRate']:.6f} of held-out characters are outside "
            "the training vocabulary and scored as <unk>; perplexity is slightly pessimistic because "
            "of it."
        )
    return limitations


def build_provenance(report, *, hardware: dict | None = None, name: str = LM_NAME) -> EvaluationProvenance:
    payload = report.to_dict() if hasattr(report, "to_dict") else dict(report)
    provenance = payload["provenance"]
    model = payload["model_config"]
    return EvaluationProvenance(
        subject=f"{name} (from-scratch, pure NumPy)",
        comparator=f"{payload['evaluation']['bestBaseline']} baseline on identical held-out tokens",
        hardware=hardware or {
            "machine": provenance.get("machine"),
            "platform": provenance.get("platform"),
            "accelerator": "none (CPU only)",
            "peakMemoryMb": payload["resource"]["peakMemoryMb"],
        },
        decoding={
            "temperature": 0.0,
            "topK": 0,
            "note": "perplexity is teacher-forced; no sampling involved in the gate metric",
        },
        context={"seqLen": model["seq_len"], "window": "sliding, non-overlapping, stride = seqLen"},
        quantization=None,  # trained and evaluated in float32; no quantisation applied
        prompts=[],
        dataset_digest=payload["corpus"]["manifestDigest"],
        corpus_size=payload["corpus"]["trainBytes"],
        code_revision=provenance.get("codeRevision"),
        seed=provenance["seed"]["model"],
        limitations=limitations_from_report(payload),
        status=StageStatus.COMPLETED,
    )


def register_from_report(
    report,
    manager: ModelReleaseManager,
    *,
    version: str,
    hardware: dict | None = None,
    name: str = LM_NAME,
    family: str = LM_FAMILY,
    licence: str = LM_LICENCE,
):
    """Register a training report as a candidate version. Not released.

    `name`/`family` default to the released Lite model, so every existing call and card is
    unchanged; a second artifact of the same family (a different preset of the same
    architecture, trained the same way) passes its own name rather than being registered
    under a name that belongs to another set of weights.
    """
    payload = report.to_dict() if hasattr(report, "to_dict") else dict(report)
    return manager.register(
        name=name,
        version=version,
        family=family,
        licence=licence,
        weights_digest=payload["artifact"]["weightsDigest"],
        base_checkpoint=None,  # trained from random initialisation; there is no base
        config_digest=_config_digest(payload),
        dataset_digest=payload["corpus"]["manifestDigest"],
        parameter_count=int(payload["provenance"]["parameterCount"]),
        requirements=requirements_for_language_model(),
        limitations=model_limitations(payload),
        provenance=build_provenance(payload, hardware=hardware, name=name),
        artifacts={
            "filename": payload["artifact"]["filename"],
            "strongestBaseline": best_baseline_name(payload),
            "fileDigest": payload["artifact"]["fileDigest"],
            "bytes": payload["artifact"]["bytes"],
            "vocabularyDigest": payload["tokenizer"]["vocabularyDigest"],
            "corpusManifest": payload["corpus"]["manifestDigest"],
            "trainer": "services/fabric/fabric/lm/train.py",
        },
    )


def _config_digest(payload: dict) -> str:
    import hashlib
    import json

    return hashlib.sha256(
        json.dumps({"model": payload["model_config"], "train": payload["config"]}, sort_keys=True).encode("utf-8")
    ).hexdigest()


def candidate_from_report(
    report,
    manager: ModelReleaseManager,
    *,
    version: str,
    hardware: dict | None = None,
    name: str = LM_NAME,
    family: str = LM_FAMILY,
    licence: str = LM_LICENCE,
):
    """Register, validate against the declared requirements, and release only if it passes.

    Returns `(card, released)`. A rejected candidate is left in the manager as
    REJECTED with its reasons, which is the record that the attempt happened and why
    it did not ship.

    `name`/`family` are forwarded rather than fixed, so a second artifact of the same
    architecture can be registered under its own name. The defaults are the released
    Lite model, which is what every existing caller passes by not passing anything.
    """
    payload = report.to_dict() if hasattr(report, "to_dict") else dict(report)
    card = register_from_report(payload, manager, version=version, hardware=hardware,
                                name=name, family=family, licence=licence)
    manager.validate(card.identifier, metrics_from_report(payload), provenance=card.provenance)

    card = manager.card(card.identifier)
    if card.status != "validated":
        return card, False
    try:
        return manager.release(card.identifier, notes="from-scratch NumPy training run"), True
    except ModelReleaseError:
        return manager.card(card.identifier), False
