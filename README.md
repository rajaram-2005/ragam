# Aetheris Omni

A local-first AI platform built by integrating two repositories into one system:
[`Aetheris-`](https://github.com/rajaram-2005/Aetheris-) (application and
orchestration) and [`sparsiz`](https://github.com/rajaram-2005/sparsiz) (research and
compute optimisation). Everything runs on this machine: there is no online provider,
by design, so no prompt can leave the host without a policy decision recorded for it.

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
| Execution control | Image/Video job cancellation; Chat task pause/resume/cancel |
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
npm test          # 1076 tests: core 446, web 67, fabric 563
npm run lm:quick  # 60-step Aetheris Lite LM smoke run (seconds, no GPU)
npm run lm:train  # the full from-scratch LM run (~35-40 min on 2 CPUs)
npm run train     # in-process training run
```

All 1076 run in CI on every push and pull request
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) as four jobs — one per
component, plus one that fails if this documentation stops matching the code. The
Fabric job asserts the release gate in **both** directions: a trained model must
release, and an undertrained one must fail *and* must not become the current model.

Full instructions, environment variables and troubleshooting:
[`docs/04-setup.md`](docs/04-setup.md).

> **Do not `pip install torch`.** Nothing here imports it, and on a GPU-less host
> pip resolves it to the CUDA build. `services/fabric` is NumPy-only by design.

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
| `services/core` | Node 22 ESM | 12,346 | 9,422 | **zero npm packages** | 446 |
| `services/fabric` | Python 3.11 | 9,046 | 6,854 | NumPy only | 563 |
| `apps/web` | React 18 + Vite | 4,464 | 1,311 | react, react-dom | 67 |

The core service has **no npm dependencies at all** — that is why the root
`package.json` is a script runner rather than an npm workspace: hoisting the web
app's 62-package tree over it would give the core a dependency surface it does not
have and make that property unverifiable.

Architecture, component responsibilities and enforcement points:
[`docs/02-architecture.md`](docs/02-architecture.md).

---

## Aetheris Lite

Two first-party models exist, and both are real.

### A language model, trained from nothing

**`aetheris-lite-lm`** — a **359,136-parameter character-level transformer**
trained from random initialisation, in pure NumPy, on this repository's own text.
No pretrained weights, no PyTorch, no GPU, no downloads.

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
