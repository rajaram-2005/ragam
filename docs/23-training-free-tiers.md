# 23 — The composed tier: a training-free path this family does not take

**Status, stated first.** The technique is implemented and tested. **No tier of this family takes
it.** Pro and Max were going to be composed — an unmodified, licence-checked third-party base on
the user's own accelerator — and that was rejected: a composed tier delivers someone else's weights
and puts our tier label above them, and a model of this family has to be *this family's* model.
[24](24-own-models.md) is what Pro and Max are instead: presets of `aetheris-core-v1`, trained from
random initialisation on the user's own machine, exactly like Lite.

The module is kept, tested and documented for one reason: refusing a path is stronger when the
refusal is a checked rule rather than a paragraph. `own_weights` is that rule — a composed tier can
never satisfy it, no matter how well it is built — and the plan derives it from the record rather
than from this page.

This page is the technique. `services/core/src/klyvaron/composition.mjs` is the same thing in code,
`services/core/src/hardware/accelerators.mjs` is the memory arithmetic, and both have tests.

```bash
node services/core/scripts/klyvaron.mjs compose pro
node services/core/scripts/klyvaron.mjs plan
```

## 1. Why it was considered at all

Training a first-party assistant needs three things: data with the right to train on it, compute,
and a licence review of whatever weights went in. [24](24-own-models.md) is how this family trains
its own models from random initialisation — no licence review needed, because nothing third-party
goes in — and it is the path Pro and Max take. The composed path was the alternative considered
first, for the case where there is no compute to train with at all: if you cannot train, compose.
It is a real option, and it is still the wrong one for *this* family, for the reason in the status
note above.

A tier does not have to be a trained model to be real. It can be a **composition**: an unmodified,
licence-checked third-party base running on the user's own accelerator, wrapped in this
repository's retrieval, evidence and policy mechanisms. That needs **no training at all** — and
every step of it is checkable *before* a user is told it works, which is more than can be said for
"we will fine-tune something".

Each tier records which path it takes, and the values are plain data in `klyvaron/tiers.mjs`:
Lite's is `trained_from_scratch` — one artifact, trained here, measured and released — while Pro's
and Max's are `composed_no_training`, with `trainingRequired: false`. A composed tier that claimed
to require training, or that hid a step, fails validation rather than passing review.

## 2. What the technique is not

The base is not a Klyvaron model and never gets the tier label. A tier label is a lookup in the
backings of *available* capabilities (`tierClaimForArtifact()`), and a composed tier has none — so
an unchanged third-party model cannot be relabelled as Pro or Max. Directive §5A is enforced by that
lookup; a test asserts the lookup returns `null` for a composed base while still returning `lite`
for the trained artifact.

Nothing here downloads weights either. The repository ships none, converts none in CI, and claims
nothing about a base until a run on a real machine records what happened.

## 3. The eight steps

| # | Step | Machine? | Satisfied when |
| --- | --- | --- | --- |
| 1 | Licence on the allowlist, read at the pinned revision | no | The licence is one of Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, CC0-1.0, CC-BY-4.0 |
| 2 | Base pinned to one revision, weight hash recorded | no | A moving ref is not a base, and an unhashed download cannot be verified |
| 3 | Weights fetched on the user's machine | **yes** | The user's own computer fetched them; nothing is redistributed from here |
| 4 | Optional quantisation with a parity check | yes | A conversion that was compared with its source, not assumed faithful |
| 5 | A runtime the accelerator probe confirmed | yes | A probe — not a hardware name — named the backend |
| 6 | Model and context fit measured memory | no | The arithmetic in §4 fits, with a reserve |
| 7 | The differentiation mechanisms attached | no | `klyvaron/trends.mjs` and `klyvaron/affect.mjs` — code, not weights, and already tested |
| 8 | One real run measured | yes | Device, tokens/s and peak memory are recorded; **a plan is not a measurement** |

Every unsatisfied step carries its reason, and the plan is not "ready" while any step is still
required or blocked. What is already true today is step 7: the mechanisms exist and are tested.
Everything a machine has to do is outstanding, which is what the CLI prints.

## 4. "GPU or any other" — the accelerator table

Pro and Max need an accelerator a **runtime probe confirms**. Which one is the user's business:

| Accelerator | Kind | Confirmed by | First runtime |
| --- | --- | --- | --- |
| CUDA (NVIDIA) | GPU | `nvidia-smi`, which `hardware/detect.mjs` already runs | llama.cpp (CUDA) |
| ROCm (AMD) | GPU | a runtime probe reporting backend `rocm` | llama.cpp (ROCm) |
| Metal (Apple) | GPU | a runtime probe reporting backend `mps` on darwin/arm64 | llama.cpp (Metal) |
| Vulkan | GPU | a runtime probe reporting backend `vulkan` | llama.cpp (Vulkan) |
| OpenVINO GPU (Intel) | GPU | an OpenVINO probe listing a GPU device | OpenVINO GenAI |
| OpenVINO NPU (Intel) | **NPU** | an OpenVINO probe listing an NPU device | OpenVINO GenAI (NPU) |
| CPU | none | always | llama.cpp (CPU) |

Three rules make that table honest. **A candidate is not a placement**: an Apple laptop with no
`mps` probe is offered Metal as something to install and re-probe, and the placement refuses while
it is unconfirmed. **Unknown memory is a refusal, not a zero**: a card that does not report free
memory is not judged to have enough of it. **CPU is not a GPU tier**: a Pro or Max placement on a
CPU-only machine is refused, naming the candidate accelerators and their probes.

## 5. The arithmetic that decides

Two numbers, both computed rather than estimated:

* **Weights** = parameters x bits per weight / 8.
* **KV cache** = 2 (K and V) x layers x **kv-heads** x head-dim x context x bytes per element.
  It uses the key/value head count, not the attention head count: with grouped-query attention the
  difference is the group factor, and using the wrong one would claim 8x the memory and refuse a
  card that would have run the model.

For a 494,032,768-parameter base with 24 layers, 4 KV heads and head dim 128, plus a 512 MB reserve:

| Precision | Context | Weights | KV cache | Total | Plus reserve |
| --- | ---: | ---: | ---: | ---: | ---: |
| int4 | 4096 | 247,016,384 | 201,326,592 | 448,342,976 | 0.96 GB |
| int4 | 8192 | 247,016,384 | 402,653,184 | 649,669,568 | 1.16 GB |
| int4 | 32768 | 247,016,384 | 1,610,612,736 | 1,857,629,120 | 2.37 GB |
| int8 | 8192 | 494,032,768 | 402,653,184 | 896,685,952 | 1.41 GB |
| float16 | 8192 | 988,065,536 | 402,653,184 | 1,390,718,720 | 1.90 GB |

So a 4 GB card runs this base at 8k context in int4, and a 2 GB card does not at 32k — and the
refusal says which of *reduce the context*, *quantise further* or *use a smaller model* applies,
rather than failing somewhere inside a runtime.

## 6. What a user is told, and what is still not claimed

A composed tier is usable only when all eight steps hold. Until then:

* No Pro or Max artifact, no trained Pro or Max model, and no date for one.
* No base has been chosen: choosing one is a licence decision that gets recorded before any weights
  move, and the record (`backingPath.bases`) is empty on purpose.
* No accelerator has been measured on any machine, including this host — which has no GPU at all.
* No tokens-per-second figure, no peak-memory figure, and no comparison with any other model or
  vendor. The only comparisons this family makes are against its own computed baselines
  ([22 §1](22-klyvaron-differentiation.md)).
* The differentiators remain `unavailable` as *model capabilities* even though their mechanisms
  are attached to every composed plan: a mechanism is not an artifact, and the tier record still
  says so.
* No tier of this family is composed. `backingPathGates()` reports `own_weights` open for a
  composed path with the reason, and `validateFamily()` refuses a from-scratch tier that names a
  base at all — the two directions of the same rule.

## Where the code is

* `services/core/src/klyvaron/composition.mjs` — the eight steps, the licence allowlist, the plan
  and the gate derivation; `backingPathViolations()` refuses a composed tier that claims to
  require training, hides a step, or records its base as anything but `third_party`.
* `services/core/src/hardware/accelerators.mjs` — the accelerator registry, the weight and KV-cache
  arithmetic, and `placementFor()`, which refuses with the numbers.
* `services/core/src/klyvaron/plan.mjs` — `own_weights` and `accelerated_runtime`, both derived
  from the record. The first is met only by a released artifact of this family; a composed tier
  fails it by construction, which is the checked form of the refusal on this page.
* `services/core/test/composition.test.mjs` — the arithmetic, the refusals, the label rule and the
  gates.
