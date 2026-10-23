# Aetheris — online AI workspace

> **Active product: online-only (Phase 2).** [Current setup, features and limitations](docs/19-online-only-phase-2.md) and [accounts and sign-in](docs/20-accounts-and-sign-in.md) supersede the offline-first product instructions below. Legacy local/research **service** code remains for reference and regression tests; it is not loaded by `npm run core`. Superseded UI components were deleted on 2026-10-17, not retained. Suite totals include retained legacy coverage.

## Current product

Exactly **Chat, Image, Video, Plugins, MCP**, with Provider Settings in a dialog and an explicit persistent model picker. Inference is online-only; there are no active local-runtime, hardware-tier, training or task-diagnostic panels. Optional history, approved memory, text-file knowledge and reviewed procedures remain.

Run `npm run core` and `npm run web`, then **create an account** at `#/signup` and sign in with it at `#/signin`. Sign-in is traditional — an email address and a password, on three pages (sign in, create account, reset password) — and it is the only way in: the operator access-token file and its login route have been removed. The first account created owns the installation and is the only one that can change the gateway connection; later accounts are members with their own history, memory and knowledge. Then open **Provider Settings**, save your gateway URL/key, test the connection, and choose a model in Chat. Never paste provider credentials into a chat message. On HTTP-only local development, start Core with `AETHERIS_COOKIE_SECURE=false`; keep secure cookies enabled for HTTPS deployments. If the web app is served inside another site's iframe, also start Core with `AETHERIS_COOKIE_SAMESITE=none` — a strict session cookie is never sent cross-site, so sign-in would appear to work and every request after it would be a `401`. Password reset cannot be emailed — this product has no mail transport — so the single-use code is delivered on the Core host; see [docs/20](docs/20-accounts-and-sign-in.md).

Current release: **0.2.0** — [release note](docs/26-release.md), [changelog](CHANGELOG.md), version in [`VERSION`](VERSION). Provider Settings shows a read-only [provider matrix](docs/27-provider-framework.md): it distinguishes native vendor, OpenAI-compatible, and gateway-routed APIs; the fourteen audited Chat adapters are contract-tested but live verification is pending. Model-level capabilities stay unknown unless the vendor catalogue reports evidence. The release carries the adaptive core (ten phases, code and tests) as a library; the product surface described above is unchanged by it.

**Current limits:** image generation has nine adapters (OpenAI Images, Gemini Images, Stability, Recraft, Ideogram, FLUX, fal.ai, Replicate and Adobe Firefly) and video has five (Veo, Runway, Luma, fal.ai video and Replicate video); remote MCP servers are not connected. All 37 non-pending provider entries have contract-tested code paths: 23 are `ready`, and 14 audited Chat providers retain `gateway_only` for catalogue compatibility while using individually defined adapters. No real vendor credential or deployment has been qualified live, and no generation has been purchased. Synthetic fixtures are used only in tests. Accounts have no email delivery, no second factor and no self-service deletion. See the [Phase 2 guide](docs/19-online-only-phase-2.md) for security boundaries and setup, and [accounts and sign-in](docs/20-accounts-and-sign-in.md) for the account model.

## Retained legacy architecture and verification history

The following documents the earlier research foundation. Its local/offline capabilities are not part of the active product.


An **online-first** AI platform built by integrating two repositories into one system:
[`Aetheris-`](https://github.com/rajaram-2005/Aetheris-) (application and
orchestration) and [`sparsiz`](https://github.com/rajaram-2005/sparsiz) (research and
compute optimisation). The active product is online-only: chat, image and video requests go to
the provider connection you configure, and an internet connection is required for AI
functionality. Local runtimes (Ollama, llama.cpp, vLLM, LocalAI) remain optional developer and
self-hosted integrations and do not dictate the architecture. Optional catalog metadata refresh
is separate from inference consent.

This is **not** a concatenation of the two. Each was audited first
([`docs/01-audit.md`](docs/01-audit.md)), responsibilities were assigned by
capability, duplication was removed, and conflicting interfaces were resolved.
Provenance for every adopted piece is in
[`third-party/NOTICES.md`](third-party/NOTICES.md).

---

## Five product areas

**Chat · Image · Video · Plugins · MCP**

Nothing else is a top-level section. Upstream Aetheris exposed twelve navigation
entries; training, memory, safety, model management, God Core orchestration,
benchmarking, resource management and execution control are now **internal
services** surfaced inside the five areas that need them. The mapping is recorded
in code (`apps/web/src/areas.js`) and enforced by a test — a sixth area, or any
internal service promoted to a navigation entry, fails the build.

| Internal service | Where it appears |
|---|---|
| Model routing | Chat → routing decision, candidates, rejection reasons |
| Model management | Chat → registered models table |
| Private knowledge pipeline | Chat → ingest, search, citations, retention |
| God Core lifecycle | Chat → eight-phase task lifecycle with budgets and verification |
| Safety / data classification | Chat composer + per-message classification chips |
| Resource management | Sidebar hardware card; Image and Video echoes |
| Media validation | Image/Video → job detail, rejection reasons, artifact sha256 |
| Execution control | Image/Video job cancellation; Chat generation Stop; task pause/resume/cancel |
| Training & benchmarking | Not in the web app. Separate service; results published as model cards |

---

## Quick start

```bash
node services/core/src/server.mjs        # core API on :8790
cd apps/web && npm install && npm run dev # UI, proxies /api to core
```

Requirements: **Node ≥ 22.12** — the core service needs ≥ 22.5 for `node:sqlite`
and the web app's build tooling (Vite 8) needs ≥ 22.12, so the higher bound
applies — and, for the training service,
**Python ≥ 3.11 + NumPy**. No GPU. No model weights are downloaded.

```bash
npm test          # 1869 tests: core 947, web 100, fabric 822
npm run lm:quick  # 60-step Aetheris Lite LM smoke run (seconds, no GPU)
npm run lm:train  # the full from-scratch LM run (~35-40 min on 2 CPUs)
npm run train     # in-process training run
```

The optional real Qwen LoRA smoke path is separate from normal setup. On a machine
with internet access and about 8 GB RAM (a Codespace is sufficient), it bootstraps
its own reviewed torch/Transformers/PEFT packages and uses CPU when no GPU exists:

```bash
python services/fabric/remote/run_smoke_local.py --workdir ./aetheris-smoke
# then inspect aetheris-smoke/status.json
```

All 1869 run in CI on every push and pull request
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) as five jobs — one per
component, plus one that fails if this documentation stops matching the code, plus one
that counts what the suites reported and verifies the release against those counts. The
Fabric job asserts the release gate in **both** directions: a trained model must
release, and an undertrained one must fail *and* must not become the current model.

Full instructions, environment variables and troubleshooting:
[`docs/04-setup.md`](docs/04-setup.md).

> **Do not `pip install torch` for normal development or tests.** The Fabric service
> is NumPy-only. Only the explicit optional LoRA command above bootstraps torch and
> its model stack; use that runner rather than adding torch to Fabric's dependencies.

---

## What actually works

On a machine with **no language model installed** — which is the default state of
this repository — the core service reports:

```
readiness     degraded
local models  0 ready
limitation    no local chat model is installed; /api/chat will return no_model_available
limitation    no video generation model is available; /api/video will refuse rather
              than substitute a still image
```

That is the correct output, not a failure. Install Ollama, pull any chat model,
re-probe, and the same code path serves real inference
([`docs/04-setup.md` §6](docs/04-setup.md)).

Verified by test, on this host, with no external service:

- **Offline enforcement is real, not cosmetic.** A recording `fetch` spy proves
  `api.openai.com`, `api.example.com`, `huggingface.co` and `api.anthropic.com` are
  rejected under `strict_offline` without opening a socket or resolving DNS — while
  a real loopback server speaking the Ollama wire protocol still completes a genuine
  chat round-trip. Offline does not mean nothing works.
- **No credential reaches a response.** Seven endpoints swept for a configured API
  key and any prefix of it; `publicConfig` carries `keyConfigured: true`, never a
  value.
- **A still image is never presented as generated video.** Magic-byte sniffing plus
  `assertGenuineVideo` fail the job with the reason recorded and the refusal audited.
- **Plugin and MCP permissions hold.** A missing required argument is `403`;
  an unapproved destructive tool call is `409`; granting an elevated scope is *not*
  consent to use it — an approval must name the scope.
- **Unvalidated weights cannot replace a release.** A 3-epoch run scores below the
  MRR floor, so release fails and `released` is `null`.
- **A plan-only task never reports success.** It ends `partial`, naming the heuristic
  intent detection, the absent executor and the unverified results.

Status of every acceptance criterion, with evidence:
[`docs/03-status.md`](docs/03-status.md).

---

## Components

| Component | Stack | Source lines | Test lines | Dependencies | Tests |
|---|---|---|---|---|---|
| `services/core` | Node 22 ESM | 36,820 | 24,019 | **zero npm packages** | 947 |
| `services/fabric` | Python 3.11 | 17,241 | 10,540 | NumPy only | 822 |
| `apps/web` | React 18 + Vite | 4,318 | 2,023 | react, react-dom | 100 |

The core service has **no npm dependencies at all** — that is why the root
`package.json` is a script runner rather than an npm workspace: hoisting the web
app's 62-package tree over it would give the core a dependency surface it does not
have and make that property unverifiable.

Architecture, component responsibilities and enforcement points:
[`docs/02-architecture.md`](docs/02-architecture.md).

---

## Aetheris Lite

Three first-party artifacts exist, and all three are real.

### A language model, trained from nothing

**`aetheris-lite-lm@0.1.1`** — a **359,616-parameter character-level transformer**
trained from random initialisation, in pure NumPy, on this repository's own text.
No pretrained weights, no PyTorch, no GPU, no downloads. It supersedes
`@0.1.0` (359,136 parameters), whose figures stay published as a superseded record.

This exists because every route to *fine-tuning someone else's* model was blocked —
`huggingface.co` and `download.pytorch.org` are unreachable, `llama-cpp-python` ships
no manylinux wheel for this platform, and there is no `.gguf` or `.safetensors`
anywhere on the host. Training from random initialisation needs none of that.

The gradients are derived by hand and **every one is checked against a central finite
difference**. That check found a real bug on its first run: the positional-embedding
gradient scattered with a `(T, B)` layout while the hidden state is `(B, T)`. It
reported `pos: exceeds tolerance by 1.6e-01` and nothing else would have noticed.

> **This is not a good language model, and it is not presented as one.** Its output is
> mostly meaningless. It proves the pipeline — data validation, a disjoint split,
> hand-derived backprop, held-out evaluation against computed uniform/unigram/bigram
> baselines, a versioned card and a release gate that refuses. Its limitations are
> generated onto its own model card, not tucked into a footnote.

It **is** reachable from `/api/chat`, and that is the point rather than an oversight:
the artifact is registered as a local provider, an ordinary request is refused with
`model_not_instruction_tuned` (**501**) unless the model is pinned by id, and a pinned
request returns a continuation labelled as one, carrying the model's own limitations.
The model never answers as if it were an assistant. See
[`docs/08-aetheris-lite.md`](docs/08-aetheris-lite.md) and
[`docs/11-klyvaron-family.md`](docs/11-klyvaron-family.md).

The family does not compete. It is built for two things instead — knowing what is
current, with a date and a source, and understanding what the user expressed across a
session, quoted from their own words — and it refuses benchmark-superiority claims in
code rather than in a disclaimer. Pro and Max are **unbuilt** and **this family's own
models**: presets of `aetheris-core-v1` trained from random initialisation, with the two
differentiators as parts of the model rather than wrappers around it, on the user's own
accelerator (CUDA, ROCm, Metal, Vulkan, an OpenVINO GPU or NPU). No third-party weights are
involved anywhere in the plan — and no weights exist yet. See
[`docs/22-klyvaron-differentiation.md`](docs/22-klyvaron-differentiation.md) and
[`docs/23-training-free-tiers.md`](docs/23-training-free-tiers.md) — and
[`docs/24-own-models.md`](docs/24-own-models.md), which records the decision that Pro and Max are
trained models of this family's own architecture rather than someone else's weights behind a tier label.

### A second language model, on a corpus that was assembled and licensed

**`klyvaron-mini-lm@0.1.0`** — a **1,421,952-parameter character-level transformer**, the `mini`
preset of the same `aetheris-core-v1` architecture, trained from random initialisation on **9.87 MB
of text assembled from seven licence-checked sources**: this repository's own text plus
`pallets/flask`, `expressjs/express`, `psf/requests`, `microsoft/TypeScript`, `pytest-dev/pytest` and
`pallets/click`. Every source is pinned to a commit SHA and its licence is read **at that commit**.
`numpy/numpy` was **refused** — GitHub reports its licence as `NOASSERTION` — so it contributed zero
bytes rather than a note that someone thought it looked permissive.

The evaluation split is **held out by source**: `pallets__click` and `psf__requests` are validation
in their entirety and supply **not one byte** of training text. On those 1,907,072 held-out
characters it reaches **perplexity 4.7342** against a bigram baseline of **15.8644** — 29.8 % of the
baseline, 3.35× better than the best non-neural one. That is a harder test than the Lite model's
file-disjoint split, and the two perplexities are not comparable with each other.

It took **8,456 s (2 h 21 min) on two CPU cores**, and the release gate recorded **one soft failure
rather than waiving it**: the wall-clock target is 3,600 s. The miss is on the card and in its
limitation list. The run's command, config, digests and outcome are in
[`docs/experiments/klyvaron-mini-lm-run.json`](docs/experiments/klyvaron-mini-lm-run.json), which
carried `status: running` until the run exited and was not written ahead of it.

> **Its output is no better in kind than the Lite model's**: character-level text shaped like source
> code and mostly meaningless. `mini` is **not a tier** and it moves nothing — Pro and Max stay
> unbuilt. What it is for is making the whole recipe real: corpus assembly, licence checking, a
> tokenizer fitted on the training split only, training, evaluation and a release gate that refuses.
> It has **not** been exported to the runtime's artifact format or verified there; that path exists
> and has not been run for these weights.

Model card: [`docs/model-cards/klyvaron-mini-lm-0.1.0.md`](docs/model-cards/klyvaron-mini-lm-0.1.0.md).

### Hardware-based execution

Klyvaron **Lite / Pro / Max** are online deployment profiles: cost-conscious hosted inference for
Lite, higher-capability hosted models for Pro, and benchmarked high-performance or distributed
inference for Max. The hardware and local-runtime machinery described below belongs to the retained
legacy service and optional self-hosted use; it is not a requirement of the active product, which
performs **no local inference and downloads no models**. Where a Klyvaron-branded feature uses a
third-party hosted model, its metadata names the actual model and provider rather than claiming
first-party weights.

The admission framework, CPU memory safeguards, and [evaluated weight-only int8
inference](docs/14-cpu-int8-inference.md) are implemented. A useful
quantized Lite assistant, native mobile packaging, and benchmark-qualified Pro/Max
models remain release gates. See [the policy and acceptance matrix](docs/13-hardware-execution-policy.md).

### The retriever

**`aetheris-lite-retriever@0.1.0`**, a 18,784-parameter dual encoder trained from
scratch by a hand-written NumPy Adam loop whose five parameter gradients all match
central finite differences to ~3e-10. Trained from scratch, not a fine-tune:
`baseCheckpoint: null`.

On held-out queries at low lexical overlap it scores **MRR 0.8497 against BM25's
0.3352** (+153.5%), with an untrained control at 0.0500. The experiment ledger
verdict is `accept`.

> **This is not a claim that Aetheris beats Mistral, Qwen, Llama, Gemma or
> DeepSeek.** None of those could be installed on this host, so no such comparison
> exists, and none is implied anywhere in this repository. The only comparison made
> is against BM25 on identical hardware, corpus, tokeniser and query strings.

The model also **loses** to BM25 on a held-out-topic split (unseen vocabulary):
MRR 0.0937 vs 0.3820. That result is kept and reported rather than dropped. And
under high lexical overlap the ledger **rejects** the model outright, because BM25
already achieves recall@5 = 1.0 and the dense model regresses it to 0.9167 — a
guard metric doing its job.

Full numbers, conditions, fairness controls and reproduction commands:
[`docs/06-benchmarks.md`](docs/06-benchmarks.md).
Model card: [`docs/model-cards/aetheris-lite-retriever-0.1.0.md`](docs/model-cards/aetheris-lite-retriever-0.1.0.md).

Three of eight pipeline stages are **blocked** on this host — SFT, preference
optimization and distillation all need weights, and the first and third need a GPU.
They are named as blocked, with reasons, in every run record. The pipeline reports
`partial`, never `completed`.

---

## Security

Enforcement lives entirely in `services/core`. The browser is a display.

- **Three runtime policies** — `strict_offline` (default), `hybrid`,
  `online_enabled`. A blank or invalid policy **fails safe to `strict_offline`**
  and records a warning; it never fails open.
- **Company data stays local by default.** `confidential` and `restricted` content
  needs explicit per-request authorization to leave the machine, even in `hybrid`.
- **Sixteen secret patterns**, including env-var-style credentials (`\bsecret\b`
  cannot match inside `AWS_SECRET_ACCESS_KEY` — that gap was found and fixed),
  PEM blocks, JWTs and credentials in ordinary HTTP URLs. Redaction runs before
  egress and is audited.
- **All tool output is untrusted** — schema-validated, size-bounded, control
  characters neutralised, marked `untrusted: true`, never executed as instruction.
- **Scopes are an allowlist.** Seven elevated scopes always need per-call approval;
  four (`credentials.write`, `policy.override`, `godcore.bypass`, `audit.erase`)
  can never be granted.
- **Append-only audit ledger.** Refusals are audited — an early defect returned
  capability refusals with no ledger entry, meaning the most security-relevant
  events were the ones missing.

Details, including seven open items stated plainly:
[`docs/05-security.md`](docs/05-security.md).

---

## Documentation

| | |
|---|---|
| [`docs/01-audit.md`](docs/01-audit.md) | What was found in each upstream repository, with `file:line` evidence |
| [`docs/02-architecture.md`](docs/02-architecture.md) | Design, responsibilities, enforcement points, the 12→5 mapping |
| [`docs/03-status.md`](docs/03-status.md) | Status of all twelve phases and every acceptance criterion |
| [`docs/04-setup.md`](docs/04-setup.md) | Install, run, test, make chat actually work, troubleshooting |
| [`docs/05-security.md`](docs/05-security.md) | Threat model and every control, each tied to a test |
| [`docs/06-benchmarks.md`](docs/06-benchmarks.md) | Measurements, conditions, fairness controls, what they do not support |
| [`docs/07-improvement-cycle.md`](docs/07-improvement-cycle.md) | The Sparsiz improvement cycle run on a real failure, end to end |
| [`docs/08-aetheris-lite.md`](docs/08-aetheris-lite.md) | The from-scratch model family: method, verified gradients, release gate |
| [`docs/09-distillation.md`](docs/09-distillation.md) | Distillation: the logit path that runs here, the credentialed path that does not |
| [`docs/10-hermes-audit.md`](docs/10-hermes-audit.md) | Hermes Agent audit: what was adopted, what was rejected, and why |
| [`docs/11-klyvaron-family.md`](docs/11-klyvaron-family.md) | The Klyvaron family, the six learning levels, and what is not built |
| [`docs/22-klyvaron-differentiation.md`](docs/22-klyvaron-differentiation.md) | What the family is for: the present, the person, and the comparisons it refuses |
| [`docs/23-training-free-tiers.md`](docs/23-training-free-tiers.md) | The composed path this family considered and refused, kept because the refusal is a checked rule |
| [`docs/24-own-models.md`](docs/24-own-models.md) | Pro and Max as this family's own models: the `aetheris-core-v1` architecture, the two differentiators as parts of it, and what training them costs |
| [`docs/12-feature-matrix.md`](docs/12-feature-matrix.md) | Every capability marked completed / partial / planned / unsupported |
| [`docs/model-cards/`](docs/model-cards/) | Versioned model cards (Markdown + machine-readable JSON) |
| [`third-party/NOTICES.md`](third-party/NOTICES.md) | Provenance, what was adopted vs replaced, licence compatibility |
| [`services/fabric/README.md`](services/fabric/README.md) | Training pipeline and experiment ledger |
| [`.env.example`](.env.example) | Every environment variable, with its real default |

---

## Honesty rules this codebase follows

Written down because they explain several results that look pessimistic.

1. **A README claim is not evidence.** Every critical assumption was inspected and
   verified. Upstream `src/runtime/` is ~65 modules of in-browser simulation; it was
   not ported, and no substitute was written.
2. **Nothing is mocked to look complete.** Where a capability cannot be real here it
   reports a limitation. There is no "prototype or simulation only" category in
   [`docs/03-status.md`](docs/03-status.md) because nothing belongs in it.
3. **Mock data is labelled in the interface** (`.fixture-tag`) and kept out of
   production success paths. The sample plugin manifest is marked *"development
   fixture"* because no server-side handler implements it.
4. **No test was removed or relaxed to obtain a green build.** Two existing
   assertions were rewritten when built-in plugins arrived — they had counted
   absolute registry size, and now assert about the plugin under test *and*
   separately verify the built-ins are present, enabled and bound. That is a
   stronger claim than the count it replaced.
5. **Failing results are kept.** The held-out-topic loss and the high-overlap
   rejection are both reported in full.
6. **No superiority claim without reproducible evidence.** None exists, so none is
   made.

---

## Licence

MIT — see [`LICENSE`](LICENSE).

Upstream attribution, the dependency licence inventory, and a note on the model
weights that could *not* be assessed:
[`third-party/NOTICES.md`](third-party/NOTICES.md). All upstream licences are
permissive and MIT-compatible; no GPL/AGPL/LGPL code is present.

`services/fabric` derives its taxonomy and recurrence from `sparsiz` (Unlicense /
public domain) and its scoring from `Aetheris-/src/runtime/faisanth.mjs` (MIT).
Both are credited in-file.

### Responsive local execution

Installed Klyvaron text models now use one shared CPU worker, incremental token
streaming, disconnect cancellation and enforced deadlines. Startup still verifies
all installed artifacts; only one selected model is cached afterward. Busy tasks
are refused, not queued indefinitely or sent online. See
[15 — Responsive local execution](./docs/15-responsive-local-execution.md) for
residency reporting, verification and the remaining release limitations.

### Universal ecosystem foundation

The [updated integration map and roadmap](./docs/16-universal-ecosystem-roadmap.md)
tracks the broader provider, agent, industry and durable-execution directive without
claiming those goals are already delivered. The [versioned model catalog](./docs/17-model-catalog.md)
adds opt-in metadata discovery inside Chat, separate from model installation,
licence approval, credentials and inference readiness.
