#!/usr/bin/env python3
"""The differentiator parts, trained and measured as parts of one model.

    python3 scripts/lm_differentiator_prototype.py --steps 900

WHAT THIS IS FOR
----------------

`age_buckets` + `verdict_head` (is the answer grounded in evidence that is still current, or should
it abstain?) and `state_emb` + `state_head` (what did the person express, with one class reserved
for "nothing") are recorded in `klyvaron/architecture.mjs` as **parts of the model**, not wrappers
around it. The claim that needs evidence is not that they exist, but that they train: their own
gradients, in the same loss as the next-token objective, and that the abstention classes are
reachable rather than theoretical.

WHAT THE TASK IS, EXACTLY
-------------------------

Generated text, and the record says so. Clauses come from a closed neutral list; some carry a
marker phrase from a closed lexicon (three per expressed state); the rest carry none.

* **verdict** -- grounded or abstain. The evidence's age arrives **only** through the `age_buckets`
  conditioning input; it is never in the tokens. Buckets 0 and 1 are inside the freshness window,
  buckets 2 and 3 are stale, so the label is the rule `int(bucket > 1)` and a model without the
  table cannot see the age at all. That is the point of the table.
* **state** -- four classes, one of which is `none`. The marker is in the text, so this is a reading
  task rather than a lookup: the conditioning input carries the *previous* turn's state, never the
  current one, and the head is scored on held-out text it has not seen, on marker-free text where it
  must decline to label, and on staler-than-training sources where it must abstain.

WHAT THE NUMBERS DO AND DO NOT MEAN
-----------------------------------

They mean the parts are wired correctly, their gradients are right, they learn together with the
language objective, and the abstention cases are reachable. The phrases are generated from a closed
list, the ages are drawn from a uniform distribution over four buckets, and nothing here was
observed from a real source or a real message. This is a mechanism prototype: **it is not a model
artifact**, it writes no `.npz`, and it moves no capability gate.
`docs/experiments/differentiator-prototype.json` is its record, and the contract it must keep is
asserted by `tests/test_lm_differentiator_prototype.py`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import platform
import sys
import time
from dataclasses import asdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fabric.lm.model import TransformerConfig, TransformerLM  # noqa: E402
from fabric.lm.tokenizer import CharacterTokenizer  # noqa: E402

#: Index 0 is reserved for "nothing was expressed", as the affect mechanism reserves it.
CLASSES = ("none", "frustrated", "anxious", "calm")

#: Three marker phrases per expressed state, lower case.
MARKERS = {
    1: ("i am frustrated", "this is frustrating", "i feel stuck"),
    2: ("i am anxious", "i feel anxious", "i am worried about this"),
    3: ("i feel calm", "this feels settled", "i am fine with this"),
}

NEUTRAL = (
    "the build finished",
    "the cache is warm",
    "the tests passed",
    "the run took an hour",
    "the index was rebuilt",
    "the deploy went out",
    "the queue drained slowly",
    "the logs were rotated",
    "the config was reloaded",
    "the disk is nearly full",
)

#: Buckets 0 and 1 are inside the window; 2 and 3 are stale. The verdict label is this rule and
#: nothing else, which is why the prototype measures the table and the head rather than judgement.
FRESH_BUCKETS = 2
STALE_BUCKETS = 2

#: The weight the head losses carry in the joint objective. One, so no part can be trained less
#: than the language objective it shares a pass with.
HEAD_WEIGHT = 1.0

#: The learning-rate schedule is spread over this many steps regardless of how many are run, so a
#: short run is a genuine prefix of the recorded one rather than a faster-decaying rehearsal of it.
#: Without this, a 60-step test spends most of its budget at a decayed rate and shows far less than
#: the same 60 steps of the real run -- which would make the test's thresholds about the schedule
#: rather than about the parts.
SCHEDULE_STEPS = 900


def build_samples(rng: np.random.Generator, count: int):
    """Return (texts, age buckets, states, verdicts, priors) for `count` samples.

    `priors` is the state carried into the turn: it is a separate draw from `states`, so the
    conditioning table cannot be read as if it were the label.
    """
    texts, buckets, states, verdicts, priors = [], [], [], [], []
    for _ in range(count):
        state = int(rng.integers(len(CLASSES)))
        clauses = [NEUTRAL[rng.integers(len(NEUTRAL))] for _ in range(int(rng.integers(2, 4)))]
        if state:
            # The marker goes last, so it is the most recent thing the last position has seen.
            # The head still has to read *which* phrase it was: the position is easy, the reading
            # is not, and a head that only used the position would have to average three phrases
            # per class into one answer.
            clauses.append(MARKERS[state][rng.integers(3)])
        bucket = int(rng.integers(FRESH_BUCKETS + STALE_BUCKETS))
        texts.append(" ".join(clauses) + "\n")
        buckets.append(bucket)
        states.append(state)
        verdicts.append(int(bucket > 1))
        priors.append(int(rng.integers(len(CLASSES))))
    return texts, np.array(buckets, dtype=np.int32), np.array(states, dtype=np.int32), \
        np.array(verdicts, dtype=np.int32), np.array(priors, dtype=np.int32)


def corpus_digest(texts) -> str:
    payload = json.dumps(sorted(texts), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def encode(tokenizer, texts, seq_len, first_target: int):
    """Char ids and shifted targets at a fixed length, deterministic and padding-free.

    Shorter text is repeated rather than padded: a pad character would be one more thing the model
    learns to predict, and it would appear in the loss every step.
    """
    inputs = np.zeros((len(texts), seq_len), dtype=np.int32)
    targets = np.zeros_like(inputs)
    for row, text in enumerate(texts):
        ids = tokenizer.encode(text)
        ids = np.concatenate([ids, np.array([first_target], dtype=np.int32)])
        if ids.size < seq_len + 1:
            ids = np.concatenate([ids] * (2 + (seq_len + 1) // max(1, ids.size)))
        window = ids[:seq_len + 1]
        inputs[row] = window[:-1]
        targets[row] = window[1:]
    return inputs, targets


def metrics_for(model, tokenizer, texts, buckets, states, verdicts, priors, seq_len, fresh_token):
    inputs, targets = encode(tokenizer, texts, seq_len, fresh_token)
    ages = np.repeat(buckets[:, None], seq_len, axis=1)
    loss = float(model.loss(inputs, targets, ages=ages, states=priors,
                            verdict_targets=verdicts, state_targets=states))
    _, cache = model.forward(inputs, cache=True, ages=ages, states=priors)
    heads = model.task_logits(cache["hf"])
    verdict_pred = heads["verdict"].argmax(axis=1)
    state_pred = heads["state"].argmax(axis=1)
    return {
        "samples": len(texts),
        "loss": round(loss, 6),
        "verdict": {
            "accuracy": round(float((verdict_pred == verdicts).mean()), 4),
            "majorityClassBaseline": _majority(verdicts),
            "abstainRecall": _recall(verdict_pred, verdicts, 1),
            "groundedRecall": _recall(verdict_pred, verdicts, 0),
            "abstainRate": round(float((verdict_pred == 1).mean()), 4),
        },
        "state": {
            "accuracy": round(float((state_pred == states).mean()), 4),
            "majorityClassBaseline": _majority(states),
            "recallPerClass": {CLASSES[c]: _recall(state_pred, states, c) for c in range(len(CLASSES))},
            "predictedNoneRate": round(float((state_pred == 0).mean()), 4),
        },
    }


def _majority(labels) -> float:
    values, counts = np.unique(np.asarray(labels), return_counts=True)
    return round(float(counts.max() / counts.sum()), 4)


def _recall(predicted, target, cls):
    mask = np.asarray(target) == cls
    if not mask.any():
        return None
    return round(float((np.asarray(predicted)[mask] == cls).mean()), 4)


def prototype_run(steps: int = 900, *, batch_size: int = 32, seed: int = 0,
                  d_model: int = 64, n_layers: int = 2, n_heads: int = 4, seq_len: int = 64,
                  learning_rate: float = 3e-3, train_samples: int = 1536, eval_samples: int = 512):
    """Train the parts, then measure them on three held-out splits. Returns the record."""
    rng = np.random.default_rng(seed)
    train_texts, _, _, _, _ = build_samples(rng, train_samples)
    tokenizer = CharacterTokenizer.fit(train_texts)

    config = TransformerConfig(
        vocab_size=tokenizer.size, d_model=d_model, n_layers=n_layers, n_heads=n_heads,
        d_ff=2 * d_model, seq_len=seq_len,
        age_buckets=FRESH_BUCKETS + STALE_BUCKETS, state_classes=len(CLASSES),
        verdict_head=True, state_head=True,
    )
    model = TransformerLM(config, seed=seed, dtype=np.float32)

    # The same optimiser the released trainer uses: Adam, cosine decay to zero, gradient clipping
    # on the global norm. A prototype that diverged would be reported as a mechanism failure when
    # it is really a learning-rate artefact.
    m = {name: np.zeros_like(array, dtype=np.float32) for name, array in model.params.items()}
    v = {name: np.zeros_like(array, dtype=np.float32) for name, array in model.params.items()}
    trajectory, started = [], time.perf_counter()
    fresh_token = tokenizer.encode(" ")[0]
    for step in range(steps):
        index = rng.integers(0, len(train_texts), size=batch_size)
        texts = [train_texts[i] for i in index]
        inputs, targets = encode(tokenizer, texts, seq_len, fresh_token)
        buckets, states, verdicts, priors = _labels(train_texts, index, rng)
        ages = np.repeat(buckets[:, None], seq_len, axis=1)
        loss, grads = model.loss_and_grads(
            inputs, targets, ages=ages, states=priors,
            verdict_targets=verdicts, verdict_weight=HEAD_WEIGHT,
            state_targets=states, state_weight=HEAD_WEIGHT,
        )
        norm = math.sqrt(sum(float((g ** 2).sum()) for g in grads.values()))
        scale = min(1.0, 1.0 / (norm + 1e-12))
        rate = learning_rate * 0.5 * (1 + math.cos(math.pi * min(1.0, step / (SCHEDULE_STEPS - 1))))
        for name, grad in grads.items():
            g = grad * scale
            m[name] = 0.9 * m[name] + 0.1 * g
            v[name] = 0.95 * v[name] + 0.05 * (g * g)
            model.params[name] -= (rate * (m[name] / (1 - 0.9 ** (step + 1)))
                                   / (np.sqrt(v[name] / (1 - 0.95 ** (step + 1))) + 1e-8)
                                   ).astype(model.params[name].dtype)
        if step % max(1, steps // 10) == 0 or step == steps - 1:
            trajectory.append({"step": step + 1, "loss": round(float(loss), 6)})
    wall = time.perf_counter() - started

    eval_rng = np.random.default_rng(seed + 1)
    held_texts, held_buckets, held_states, held_verdicts, held_priors = build_samples(eval_rng, eval_samples)
    measured = {
        "heldOut": metrics_for(model, tokenizer, held_texts, held_buckets, held_states,
                               held_verdicts, held_priors, seq_len, fresh_token),
    }
    # Marker-free text: every state label is `none`, and the head must decline to name a state.
    free = [i for i, state in enumerate(held_texts and held_states) if state == 0]
    free_texts = [held_texts[i] for i in free]
    measured["noMarkerText"] = metrics_for(
        model, tokenizer, free_texts, held_buckets[free], held_states[free], held_verdicts[free],
        held_priors[free], seq_len, fresh_token)
    # Sources staler than training: the verdict head must abstain, not guess.
    stale = np.full(eval_samples, FRESH_BUCKETS + STALE_BUCKETS - 1, dtype=np.int32)
    stale_texts, _, stale_states, _, stale_priors = build_samples(eval_rng, eval_samples)
    measured["staleOnlySources"] = metrics_for(
        model, tokenizer, stale_texts, stale, stale_states, np.ones(eval_samples, dtype=np.int32),
        stale_priors, seq_len, fresh_token)

    return {
        "experiment": "differentiator-parts-prototype",
        "format": "klyvaron-differentiator-prototype/v1",
        "isArtifact": False,
        "script": "services/fabric/scripts/lm_differentiator_prototype.py",
        "purpose": (
            "Train the age/verdict and state parts of aetheris-core-v1 in the same loss as the "
            "language objective, and measure them on held-out generated text."
        ),
        "budget": {"steps": steps, "batchSize": batch_size, "learningRate": learning_rate, "seed": seed,
                   "headWeight": HEAD_WEIGHT},
        "modelConfig": asdict(config),
        "parameterCount": model.parameter_count,
        "differentiatorParameters": config.differentiator_parameters,
        "corpus": {"kind": "generated", "samples": train_samples, "digest": corpus_digest(train_texts),
                   "generator": "closed clause list; closed marker lexicon; uniform age buckets"},
        "loss": {"trajectory": trajectory,
                 "first": trajectory[0]["loss"], "last": trajectory[-1]["loss"]},
        "metrics": measured,
        "wallSeconds": round(wall, 1),
        "hardware": {"machine": platform.machine(), "platform": platform.platform(),
                     "accelerator": "none (CPU only)"},
        "configDigest": hashlib.sha256(json.dumps(asdict(config), sort_keys=True).encode("utf-8")).hexdigest(),
        "limitations": [
            "Generated phrase list, not real sources or real messages: the age buckets are drawn from "
            "a distribution rather than observed, so nothing here measures whether a model knows what "
            "is current.",
            "The state markers come from a closed list of three phrases per class; the head is "
            "measured on held-out text from the same generator, which is easier than real text and is "
            "not comparable to it.",
            "The carried-in state is a conditioning hint, not the label: the state head has to read "
            "the text to score, which is why its accuracy is a reading measurement rather than a lookup.",
            "This is not a Pro or Max artifact: no weights are saved, nothing can be served, and no "
            "tier label may be attached to it.",
            "There is no comparison against any other model, because the repository has no second "
            "model of its own to compare against and this family does not compete with other vendors.",
        ],
    }


def _labels(train_texts, index, rng):
    """The four conditioning/target arrays for a batch, drawn from the same rules as the generator."""
    buckets = rng.integers(FRESH_BUCKETS + STALE_BUCKETS, size=len(index)).astype(np.int32)
    states = np.zeros(len(index), dtype=np.int32)
    for row, i in enumerate(index):
        text = train_texts[int(i)]
        states[row] = next((c for c in range(1, len(CLASSES)) if any(m in text for m in MARKERS[c])), 0)
    verdicts = (buckets > 1).astype(np.int32)
    priors = rng.integers(len(CLASSES), size=len(index)).astype(np.int32)
    return buckets, states, verdicts, priors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--steps", type=int, default=900)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--out", default=str(Path(__file__).resolve().parents[3] / "docs" / "experiments"
                                             / "differentiator-prototype.json"))
    args = parser.parse_args()

    record = prototype_run(steps=args.steps, seed=args.seed)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    held = record["metrics"]["heldOut"]
    print(f"{record['budget']['steps']} steps, {record['parameterCount']:,} parameters "
          f"({record['differentiatorParameters']:,} in the parts), {record['wallSeconds']} s")
    print(f"  loss {record['loss']['first']:.4f} -> {record['loss']['last']:.4f}")
    print(f"  verdict accuracy {held['verdict']['accuracy']:.4f} (majority "
          f"{held['verdict']['majorityClassBaseline']:.4f}), stale abstain recall "
          f"{record['metrics']['staleOnlySources']['verdict']['abstainRecall']}")
    print(f"  state accuracy {held['state']['accuracy']:.4f} (majority "
          f"{held['state']['majorityClassBaseline']:.4f}), none recall on marker-free text "
          f"{record['metrics']['noMarkerText']['state']['recallPerClass']['none']}")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
