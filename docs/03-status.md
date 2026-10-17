# 03 — Implementation status

> **Active product: online-only (Phase 2).** [Current setup, features and limitations](19-online-only-phase-2.md) supersede the offline-first product instructions below. Legacy local/research **service** code remains for reference and regression tests; it is not loaded by `npm run core`. Superseded UI components were deleted on 2026-10-17, not retained. Suite totals include retained legacy coverage.

Every claim below is tied to a test, a measurement or a named limitation. Where
something does not work, it says so and says why.

**Host used for all of this work:** 2 CPUs · 3.85 GB RAM · **no GPU** ·
Node v22.22.3 (`node:sqlite` verified) · Python 3.11.2 · NumPy 2.1.3 ·
pytest 9.1.1. Reachable: `github.com`, `codeload.github.com`, `api.github.com`,
`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`. **Unreachable:
`download.pytorch.org`, `huggingface.co`.**

**Test totals: 1817 passing, 0 failing.**

| Suite | Command | Result |
|---|---|---|
| `services/core` | `node --test test/*.test.mjs` | **908 / 908** (56 files, ~52 s) |
| `services/fabric` | `pytest -q` | **814 / 814** (39 files, ~1 min) |
| `apps/web` | `node --test test/*.test.mjs` | **95 / 95** (4 files, ~1 s) |
| `apps/web` build | `vite build` | 235.62 kB → **70.30 kB gzip**, single chunk, no warnings |

All three suites run in CI on every push and pull request
([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)), as five jobs split so a
failure names the component that broke. The fifth runs all three suites, counts what they
reported, and passes those counts to the release verifier — a release gate that read the totals out
of the document it was checking would verify nothing. The CI run also asserts two properties that
are easy to lose silently: that `services/core` still declares **zero** npm
dependencies, and that the Fabric release gate refuses an undertrained model rather
than merely accepting a trained one.

For Phase 2, superseded offline UI expectations were replaced with online-only UI requirements; the legacy Core and Fabric regression suites remain. Two earlier assertions in
`services/core/test/http.test.mjs` were rewritten when built-in plugins arrived —
they had counted absolute registry size, and now assert about the plugin the test
installed *and* separately verify the built-ins are present, enabled and bound.
That is a stronger claim than the count it replaced.

For the own-models increment, Pro and Max stopped being a composition of somebody else's
weights and became presets of this family's architecture: `aetheris-core-v1` is recorded in
`klyvaron/architecture.mjs` with its parameter arithmetic, and the two differentiators are parts of
the model rather than wrappers around it. `services/fabric/tests/test_lm_model.py` gains
finite-difference checks for the new arrays, and a prototype trained them in one loss on generated
data (`docs/experiments/differentiator-prototype.json`, 900 steps, CPU). No weights exist, so the
tiers stay `unbuilt` — see [24 — Own models](./24-own-models.md).

For the accounts increment, the operator-token sign-in was **removed rather than
supplemented**: `services/core/test/accounts.test.mjs` (18 tests) covers scrypt password
storage, lockout scope, enumeration resistance, throttling, session bounds, owner-only
gateway control and per-account data isolation, and the web suite grew by 8 tests for the
three sign-in pages. `online.test.mjs` now signs in with an account. See
[20 — Accounts and sign-in](./20-accounts-and-sign-in.md).

---

## Hardware policy update

[13 — Hardware execution policy](./13-hardware-execution-policy.md) is the current
Lite / Pro / Max contract. Measured hardware discovery, fail-closed GPU admission,
CPU allocation guards, execution-mode controls, stream locality, retained drafts
and wider managed-directory accounting have regression coverage. Native mobile
support, useful quantized Lite weights, GPU runtime adapters and real Pro/Max
benchmarks are **not delivered**. Synthetic admission tests are not GPU benchmarks.

[14 — CPU int8 inference](./14-cpu-int8-inference.md) adds versioned quantized
artifacts, compressed resident matrix weights, conversion quality gates and a
repeatable CPU benchmark. Numerical test fixtures are not assistant releases.

[15 — Responsive local execution](./15-responsive-local-execution.md) adds a
shared CPU worker, bounded incremental streaming, disconnect cancellation,
deadlines and lazy residency after startup verification. Sixteen execution tests
cover these boundaries; they do not qualify a useful assistant or a mobile device.

## Universal ecosystem update

The 2026-10-14 master directive supersedes the earlier decision to exclude online
providers. [16 — Integration map](./16-universal-ecosystem-roadmap.md) tracks all
requested deliverables and blockers. [17 — Model catalog](./17-model-catalog.md)
adds a tested, opt-in metadata registry and in-Chat search. It does **not** add
online inference, useful assistant weights, industry packs or durable task recovery.
Earlier “complete” labels below refer to the original, narrower integration scope.

## 1. Status vocabulary

Used consistently throughout, per the reporting requirement:

| Status | Meaning |
|---|---|
| **Implemented and tested** | Code exists and a test exercises it in this repository |
| **Implemented, not fully tested** | Code exists; coverage is partial or indirect |
| **Prototype / simulation only** | Runs, but does not do the real thing |
| **Requires external credentials** | Cannot be exercised here without a secret |
| **Requires weights or hardware** | Cannot be exercised here without a download or a GPU |
| **Planned, not implemented** | Designed, no code |
| **Blocked by permissions/infrastructure** | Environment prevents it |

There is **nothing in the "prototype / simulation only" category**. Upstream
Aetheris's in-browser simulation layer was not ported, and no substitute was
written. Where a capability cannot be real on this host it reports a limitation
instead.

---

## 2. The twelve phases

| # | Phase | Status | Evidence |
|---|---|---|---|
| 1 | Repository audit | **Complete** | [`01-audit.md`](./01-audit.md): per-repo findings with `file:line` evidence, licence table, integration map, baselines re-run |
| 2 | Integration design | **Complete** | [`02-architecture.md`](./02-architecture.md) |
| 3 | Unified app, five areas | **Complete** | `apps/web`; 92 tests including "exactly five areas", "no internal service is a navigation entry", server-rendered markup for all five areas, and a guard against the re-export bug class |
| 4 | Local inference with ≥1 real local LM | **Partially met** | A real local LM now runs here end to end: the from-scratch 359,616-parameter model is exported as a versioned artifact, loaded by the core in plain JavaScript, and served through the normal provider path — with its logits checked against NumPy on identical bytes (`klyvaron-runtime.test.mjs` 11, `klyvaron-store.test.mjs` 10, `klyvaron-app.test.mjs` 7 — 28 tests; another 20 pin the tier record's own claims). Full-size artifacts were trained, verified, installed into the model library and served over HTTP from the store (1.4 MB; 359,520 parameters at `67cdd58` and 359,616 at `8d9cdf8` — `docs/experiments/lm-verification-run-67cdd58.json` and `docs/experiments/lm-verification-run-8d9cdf8.json`), so the path from a training run to a served local model is demonstrated rather than only unit-tested; the second run's corpus is rebuildable from its commit, and the update/rollback exercise behind it found and fixed a storage-accounting defect in the model library (`store.mjs`: a replace used to leave the previous version's weights behind, and to report the source directory's size as the device's). What is still unmet is a local **assistant**: the artifact is a base completion model, `/api/chat` refuses it unless the user pins it by id (`model_not_instruction_tuned`, 501, with the model's own limitations attached), and the Ollama/llama.cpp adapters remain proven only against a loopback fixture ("Phase 4 in detail", below) |
| 5 | Online provider integration | **Partially met** | The online entry reaches a LiteLLM gateway, an Ollama server, a llama.cpp server, or a saved OpenAI-compatible vendor endpoint through one OpenAI-compatible transport, with the same destination checks, consent, deadline and size limits for each. Verified only against synthetic loopback fixtures; no real gateway or runtime has been qualified in this sandbox. Provider-native protocols are not used online, and Image and Video have no adapter |
| 6 | Secure private memory | **Complete** | Knowledge pipeline + ACL + retention + audit; 40+ tests |
| 7 | Tool / agent execution | **Complete** | Plugin and MCP permission enforcement; God Core lifecycle |
| 8 | Multimodal pipelines | **Complete** | Job queue, validation, video genuineness check |
| — | Procedural skills (meta-learning L3) | **Partial** | Documents on disk with append-only history, evidence-gated promotion, rollback, deletion tombstones and lexical relevance matching — reachable over 12 routes and from a panel inside Chat. **Partly closed 2026-10-16:** the adaptive loop does both things this row used to say nothing did — it offers a stored procedure to a task as a candidate route without being asked, and it proposes one from a recorded verified success — demonstrated end to end for one capability ([docs/25](25-adaptive-intelligence.md) §4). What remains partial is the product surface: no HTTP route or Chat panel runs the loop, and its routing choice comes from a *fresh* measurement on the current input rather than from what past tasks showed |
| 9 | Sparsiz integration | **Complete** | Responsibility defined; taxonomies and `Q(x)` adopted, scoring replaced |
| — | Klyvaron artifact format, runtime and model library | **Complete** | `klyvaron/format.mjs` (manifest + digest verification, a ZIP/`.npy` reader in the core), `klyvaron/runtime.mjs` (the forward pass in JavaScript, parity-checked against NumPy), `klyvaron/store.mjs` (install/verify/load/remove inside the storage budget), `providers/klyvaron.mjs` and `scripts/export_lm.py`; a committed parity fixture ties the two implementations together |
| — | On-device storage accounting | **Complete** | `storage/budget.mjs` plus `klyvaron/footprint.mjs`; `/api/storage` reports measured bytes, verification results and headroom |
| 10 | Aetheris Lite experiments | **Partial** | Two real first-party models: the trained retriever, and a from-scratch **359,616-parameter character-level LM** trained in pure NumPy with hand-derived, finite-difference-verified gradients. SFT and preference optimization remain unimplemented for want of data and compute, and are not simulated |
| 11 | Competitive benchmark cycle | **Partial** | Real, reproducible BM25 comparison; **no** Mistral/Qwen/Llama/Gemma/DeepSeek comparison possible. Aetheris Lite is evaluated against computed uniform/unigram/bigram baselines on identical held-out tokens — never against a pretrained model, because none could be obtained |
| — | Sparsiz improvement cycle on a real failure | **Complete** | [`07-improvement-cycle.md`](./07-improvement-cycle.md): rejected run diagnosed, hypothesis tested, regression cases promoted; the accepted `mrr` gain **did not replicate** across seeds and is recorded as such; 66 tests |
| — | Selection-protocol correction | **Complete** | [`06-benchmarks.md`](./06-benchmarks.md) §5.3: base selection ran on the evaluation split; now runs on a training-side validation split. Released artifact unchanged (`weightsDigest db3366ea…`) |
| — | Robustness measurement | **Complete** | `scripts/robustness.py`: seed, training-size and paired axes. The released `mrr` is one seed of six (spread 0.103) and ranks 4th of 6 |
| 12 | Release readiness docs | **Complete** | This document plus 04, 05, 06 and the model card |
| — | From-scratch language model | **Complete** | [`08-aetheris-lite.md`](./08-aetheris-lite.md): character-level transformer, 98 new tests including every gradient against a finite difference. Found and fixed a real positional-gradient bug the numeric check reported as `pos: exceeds tolerance by 1.6e-01` |
| — | Remote training: free-first LoRA smoke run (Kaggle, Colab fallback) | **Built; smoke run not executed** | [`21-remote-training.md`](./21-remote-training.md): pinned base (Qwen2.5-0.5B-Instruct at a commit, licence checked at that commit), synthetic starter data with pinned hashes, a stage ledger that reports PASSED, FAILED or NOT RUN per stage, and persistence only after a read-back. Tested with a fake backend and a torch-free Hub gate; the Transformers + PEFT backend and the notebook have never run. No Pro or Max model is trained. A 2026-10-15 audit re-ran both suites, re-derived the dataset hashes, checked every package pin against PyPI, re-read the backend's calls against those exact wheels, corrected three widened Sparsiz numbers in §7, and stopped the notebook cloning a session branch |
| — | Klyvaron family: the stance, the two differentiators and the modalities | **Specified and enforced; the differentiators have no artifact yet** | [`22-klyvaron-differentiation.md`](./22-klyvaron-differentiation.md): the non-competitive stance and the four new plan gates are values in `klyvaron/tiers.mjs` and `klyvaron/plan.mjs`, so a tier that names a competitor is invalid and a relabelled text model cannot back an image capability. Trend awareness and understanding the user's expressed history are defined on every tier with acceptance criteria and are **`unavailable` everywhere**: the dated-source ledger (`klyvaron/trends.mjs`) and the consent-gated, evidence-cited reader (`klyvaron/affect.mjs`) are implemented and tested, and a mechanism is not a model artifact. Pro and Max remain **unbuilt**; no image or video artifact exists at any tier |
| — | Klyvaron: the family's own models | **Two artifacts released, two presets unbuilt** | `aetheris-core-v1` — four presets, the parameter and memory arithmetic and the seven-step recipe, all in `klyvaron/architecture.mjs` ([24](./24-own-models.md)). `aetheris-lite-lm@0.1.1` is the released Lite artifact. **`klyvaron-mini-lm@0.1.0`** is the second: 1,421,952 parameters trained from random initialisation on a corpus assembled from seven licence-checked sources, evaluated with the split held out **by source** — perplexity **4.7342** against a bigram baseline of **15.8644**, 0 hard failures and **one soft failure recorded rather than waived** (8,456 s against a 3,600 s wall-clock target; the threshold was not relaxed to pass it). `klyvaron-pro-lm` and `klyvaron-max-lm` have no weights: for them `corpus`, `tokenizer`, `backend`, `train`, `evaluate` and `release` are open |
| — | Universal provider framework | **Partially implemented** | [`27`](./27-provider-framework.md): a 39-entry catalogue with per-capability evidence, capability selection with explainable refusals, error normalisation with redaction, `GET /api/providers/catalog` and a capability matrix in Provider Settings. Twelve providers are `ready`: the three runtimes this build tests, plus nine native wires — Anthropic Messages, Gemini generateContent, Cohere Chat v2, Azure OpenAI v1, Vertex AI (service-account OAuth), Bedrock Converse (SigV4), OpenAI Images, Gemini Images and Google Veo — each contract-tested against a local fixture and never called live. Fourteen are reachable only through an OpenAI-compatible endpoint and thirteen are pending adapters refused by name. The store holds **several connections** (schema 2), each with its own encrypted credential, models and verification record, one active; `custom` and `custom-<name>` endpoints are first-class and a schema-1 file migrates with its key preserved. No live vendor call has been made |
| — | Aetheris Lite release gate | **Complete** | `fabric/lm/card.py` drives the existing `ModelReleaseManager`. Hard requirements: beat the bigram baseline, unknown-rate ≤ 2%, loss must fall. The rejection path is tested more than the acceptance path |

### Phase 4 in detail — the most important limitation

`services/core/src/providers/local.mjs` implements the Ollama and
OpenAI-compatible (llama.cpp) protocols for real. `offline.test.mjs` starts a
**real `node:http` server on loopback speaking the Ollama wire protocol** and
completes a genuine chat round-trip under `strict_offline` — the response carries
`sentExternally: false` and `modelId: 'ollama:tiny-local:latest'`.

What that proves is the **plumbing**: routing, policy, provider adaptation,
streaming, audit. What it does **not** prove is that a language model is
installed, because none is. `huggingface.co` is unreachable and there is no
`ollama` binary on this host, so no weights could be obtained.

The startup banner states this rather than hiding it:

```
readiness     degraded
local models  0 ready
limitation    no local chat model is installed; /api/chat will return no_model_available
limitation    no video generation model is available; /api/video will refuse rather
              than substitute a still image
```

`/api/ready` returns `capabilities.chat = false`, and the web UI renders a
`no model ready` chip and an empty model table. **No model is invented anywhere.**
Install Ollama and pull any model, then re-probe, and the same code path serves
real inference — that is the design, and the loopback test is its evidence.

As of this revision the from-scratch model is no longer an offline artifact: it is
exported with a manifest, verified, installed into `<dataDir>/klyvaron/models/`, loaded
by the core in JavaScript and registered in the routing table. `/api/ready` reports
`capabilities.chat = false` and `capabilities.textCompletion = true`, `/api/chat`
refuses it with `model_not_instruction_tuned` (501) unless the caller pins it by id, and
`/api/storage` reports the measured bytes. What is still missing is an
**instruction-tuned** local model; the wiring for one is what this revision built.

The second full-size run, on the clean revision `8d9cdf8`, makes the same journey with an
ending that can be checked — and its artifact is **the released `aetheris-lite-lm@0.1.1`**:
359,616 parameters, perplexity 4.8932 against a bigram baseline of 15.7588, gate verdict
RELEASED, installed by the store in 1,451,765 bytes, served at 26.2 tokens/s in JavaScript.
Its corpus manifest digest `70c5b78c…` was recomputed from that revision's own text
**before the run finished** and matched, so revision and corpus are known to be the same
thing rather than assumed to be: that is the property the superseded `@0.1.0` lacks, and
why the version that has it is the released one. The released export was installed and
served through the same path after the promotion, and both captures are in the record:
`tier: lite`, `tierClaim: lite`, `textCompletion: true`, `chat: false`, an unpinned chat
refused with `model_not_instruction_tuned`, and 22.7 tokens/s over HTTP. Record:
[`experiments/lm-verification-run-8d9cdf8.json`](./experiments/lm-verification-run-8d9cdf8.json). Two artifacts of the same id with
different weights (`2840150f…` and `165e150f…`) were then installed in sequence, replaced,
and rolled back; that exercise is what exposed a real defect — a replace left the previous
version's 1.4 MB weights in the library with no manifest referring to them, and reported
the source directory's size instead of the device's — which is now fixed in
`services/core/src/klyvaron/store.mjs` and covered by a test that fails against the old
code.

#### What was tried, in order, before accepting this

The gap is a missing binary and missing weights, so it was attacked directly
rather than assumed. Each attempt is recorded with its result, because "no model
could be obtained" is only an honest statement alongside the evidence for it.

| Attempt | Result |
|---|---|
| `release-assets.githubusercontent.com` (llama2.c prebuilt binaries) | HTTP **000**, host unreachable |
| `gh api repos/karpathy/llama2.c/releases` | **0** releases |
| `pip install llama-cpp-python` | 0.3.36 publishes **no manylinux x86_64 wheel** for any version — source build needs a compiler toolchain and time not available here |
| `pypi.org/pypi/{tinyllama,llama-models,model2vec,llm-gguf}` | reachable, but no weights: largest is 6.6 MB of Python, and `tinyllama` only wraps a PyTorch training utility |
| `command -v ollama llama-cli llama-server llamafile mlx_lm` | all absent |
| `find / -xdev -name '*.gguf' -o -name '*.safetensors'` | files as **.safetensors or .gguf: none** on the host |
| `download.pytorch.org`, `huggingface.co` | unreachable from this sandbox |

A local model is still the goal, and the code path is ready for one — but no
reachable source in this environment provides a runtime or weights. The correct
status for **Phase 4 is "Implemented but not fully tested"**, and it is recorded
that way in §2 rather than being upgraded by the loopback fixture.

---

The ten phases of the *Klyvaron adaptive intelligence* directive are a separate programme with its
own acceptance criteria and records: [25 — Adaptive intelligence](25-adaptive-intelligence.md).
Phases 9 and 10 of that programme are summarised in §4 below.

## 3. Acceptance criteria

| Criterion | Status | Evidence |
|---|---|---|
| Five areas work in one app | **Met** | `apps/web`; `structure.test.mjs` fails if a sixth appears |
| Local chat inference with an installed model | **Not a requirement (online-first)** | Retained legacy path is tested against a loopback server; the active product performs no local inference. The 2026-10-17 override makes cloud inference the default |
| Strict offline mode verifiably blocks network | **Superseded — not a completion criterion** | The 2026-10-17 online-first override removes offline operation as a product requirement; the recording-`fetch` measurement is kept as history of the legacy path, not as a gate |
| Hybrid sends only authorized requests externally | **Met** | Exact-host allowlist + classification ceiling; `confidential`/`restricted` need explicit authorization |
| An external provider, when one is configured, uses supported endpoints and handles provider failure | **Met against fixtures; no live provider called** | The online entry saves provider connections, requires explicit consent per revision, refuses a mismatched route, and normalises auth/quota/outage failures. Seven wires are contract-tested — OpenAI-compatible, Anthropic, Gemini, Cohere, Azure OpenAI, Vertex AI and Bedrock — including their differing credential chains; a valid key and quota remain unverified |
| Private knowledge indexed / retrieved / cited / managed locally | **Met** | Ingest, content-hash dedupe, chunk, BM25, cited grounding, ACL, purge, audit |
| Plugin + MCP enforce capability permissions | **Met** | Scope allowlist, elevated-scope approvals, forbidden scopes, risk-tier gates, schema validation of arguments and output |
| God Mode tasks observable / pausable / resumable / cancellable / verifiable | **Met** | All five exercised by tests; pause→resume checkpoints at `phaseIndex=1` (2 → 9 steps) |
| Image + video use real adapters when advertised | **Met** | Magic-byte validation; `assertGenuineVideo` rejects a still image and sub-8 KB payloads; refusal carries an explicit limitation |
| Sparsiz integration has a defined responsibility + reproducible tests | **Met** | [`02-architecture.md`](./02-architecture.md) §2; taxonomy/formula adopted, scoring replaced |
| ≥1 first-party Aetheris Lite model with versioned reproducible eval | **Met** | `aetheris-lite-retriever@0.1.0`; [model card](./model-cards/aetheris-lite-retriever-0.1.0.md) + machine-readable JSON |
| Benchmark comparisons identify exact models / configs / hardware / procedures | **Met for what was comparable** | [`06-benchmarks.md`](./06-benchmarks.md); every row records corpus, split, seeds, hardware and reproduction command |
| Unvalidated weights cannot silently replace stable releases | **Met** | `ModelReleaseManager.release()` validates first; a 3-epoch run yields MRR 0.3045 < 0.60 floor → `release` fails, run status `failed`, `released is null` |
| Docs match implementation | **Met** | Route table, env vars, licence texts and benchmark numbers were re-derived from source and re-measured, not transcribed from memory |

---

## 4. Component status

### `services/core` — Implemented and tested (908 tests)

| Subsystem | Status | Notes |
|---|---|---|
| Egress policy & guard | **Implemented and tested** | Three policies; fails safe to `strict_offline` on a blank/invalid value |
| Data classification & redaction | **Implemented and tested** | Whole-identifier patterns catch `AWS_SECRET_ACCESS_KEY`-style names |
| Audit ledger | **Implemented and tested** | Append-only SQLite; refusals audited; NDJSON export; subject purge |
| Accounts & sign-in (online entry) | **Implemented and tested** | 18 tests; scrypt hashes with no reversible copy, per-account lockout and throttling, owner/member roles, host-delivered reset codes, per-account stores; see doc 20 |
| Model registry & router | **Implemented and tested** | Capability gating before scoring; unknown latency scores 0.5, not 0 |
| Native provider adapters | **Implemented and tested against local fixtures; no live call** | Seven wires: OpenAI-compatible, Anthropic Messages, Gemini generateContent, Cohere Chat v2, Azure OpenAI v1, Vertex AI and Bedrock Converse. Cohere paginates discovery; Azure uses `api-key` and the deployment name; Vertex exchanges a service-account JWT for a cached OAuth token; Bedrock signs with SigV4 against AWS's published vector and is non-streaming by contract. Structured credentials are validated and compacted at save time. See [docs/27](27-provider-framework.md) §4.1 |
| Ollama / llama.cpp, legacy entry | **Implemented and tested against a fixture server** | `providers/local.mjs`, used by the retained legacy service only. The online entry uses the `/v1` routes of the same runtimes; see [docs/19](19-online-only-phase-2.md) |
| Ollama / llama.cpp, online entry | **Implemented and tested against a loopback fixture** | Same transport as LiteLLM; keyless by default; exact trusted origin required. No real runtime qualified here |
| Klyvaron development plan | **Implemented and tested** | Per-tier gates derived from the tier records, `klyvaron.mjs plan`; see [docs/11](11-klyvaron-family.md) §1.5 |
| Klyvaron CPU execution | **Implemented and tested** | Single worker, bounded incremental streaming, cancellation/deadlines, one-model residency; see doc 15 |
| Knowledge pipeline | **Implemented and tested** | SQLite + filesystem + in-memory rebuildable BM25 |
| Media queue & validation | **Implemented and tested** | Progress, cancellation, timeouts, retry-after, state history; an optional state file makes a terminal job and its artifact survive a restart, and a job interrupted mid-run is recorded as `failed` with `interrupted`, never replayed as running |
| Plugin registry & manifests | **Implemented and tested** | Preflight vs invoke distinction; uninstall keeps a record |
| MCP layer & schema validator | **Implemented and tested** | Risk tiers, approval gates, output neutralisation, per-tool timeouts |
| God Core lifecycle | **Implemented and tested** | Eight phases, budgets, retries, checkpoints, verification |
| Built-in plugins & MCP server | **Implemented and tested** | 18 tests; see §5 |
| HTTP layer | **Implemented and tested** | 31 literal routes + segment routes; accurate error statuses |
| Adaptive core: intent, planning, capability registry, budgets, timeouts, checkpoints, resumable tasks | **Implemented and tested** | `intent.mjs` (requirements with the phrase that produced each; unmatched requests get a question), `registry.mjs`, `plan.mjs` (refuses an over-long plan or an uninstalled capability by name), `budget.mjs` (refuses to start work its measurement cannot cover; unreported token counts stay unreported), `checkpoint.mjs` (atomic, digest-chained, refuses a resume against a different plan) and `runner.mjs` (step-by-step with a checkpoint after each, resumable in a fresh object from the checkpoint alone). Exercised by tests; no route calls it yet. See [docs/25](25-adaptive-intelligence.md) §4 |
| Adaptive routing, verification, experience & skills | **Implemented and tested, one capability end to end** | The Phase 2 loop: route on measured cost, verify against a second `implementation`, record to an append-only digest-chained episode log, propose a skill only from a verified success, promote only when every recorded check passed, reuse and re-measure. Demonstrated on counting newline bytes across a tree, with the measured crossover recorded as a limitation on the skill itself. See [docs/25](25-adaptive-intelligence.md) §4 |
| Emotional interaction states and controls | **Implemented and tested; not yet reachable from the product** | Seven states estimated from the user's own phrases, never from a model of them; every estimate reports itself as an estimate with the phrases that produced it and the other families that also matched, and can be corrected, remembered only if the user allows it, and withdrawn. Sensitive material is never read as a signal (the record keeps an offset, not the phrase), a claim about the user over time needs cited signals read with consent, and the forbidden-sentence guard refuses claimed feelings, consciousness, simulated sadness, worry, jealousy, possessiveness, guilt, dependency and invented history. Settings are validated rather than interpreted, and one switch stops the reading as well as the effect. `AdaptiveLoop.explain` renders a run with those rules; nothing in Chat uses it yet. See [docs/25](25-adaptive-intelligence.md) §4 |
| Skill evaluation, regression and permissions | **Implemented and tested; not yet reachable from the product** | `skills/evaluation.mjs` + `skills/permissions.mjs`. A candidate must run and pass every check that passed for the incumbent version; a suite that lost a check is rejected as `regression_not_run` rather than passing with fewer. Verdicts go to an append-only digest-chained log, a rejected version stays in the registry, and `promote()` refuses a version with no accepted evaluation or a different check list. A skill's permission block is the scope it runs with: a declaration wider than the runtime grant is refused rather than narrowed, a larger grant is never used, and an agent-written skill may not ask for `/`, the home directory or the network. See [docs/25](25-adaptive-intelligence.md) §4 |
| Model & provider fabric | **Implemented and tested; not yet reachable from the product** | Adapters declare their kind (`in-process`, `local`, `external`), the capability tags they serve, their limits and their notes; availability is measured by probing, never assumed. One `eligibility()` is shared by routing *and* probing, so a provider the policy forbids is never *contacted* — under `strict_offline` the external adapter's `probe` is called **0 times** while a loopback one is called once — and the module contains no network primitive at all (`fetch`, `node:http`/`net`/`tls`, `undici`), which is checked by reading it rather than by a comment. Refusals carry codes: `no_capability` (naming what is declared instead), `only_external_capability`, `provider_unavailable` (with the probe's own message), `capability_exceeds_limits` (a request too large is refused, never truncated to fit), `no_eligible_provider` (with `partial_coverage`: two adapters that between them cover a request are not combined), `preference_not_eligible` and `no_egress_guard`. Eligible adapters become validated `kind: model` descriptors — an adapter whose notes say `sampled` is not described as deterministic — and can be published into the planner's registry, so a plan is only ever built against providers that are registered *and* measured. No real provider, credential or gateway exists in this build: the external path is exercised against a stub that counts calls. `test/adaptive-providers.test.mjs` (15 tests). See [docs/25](25-adaptive-intelligence.md) §4 |
| Persistent memory fabric | **Implemented and tested; not yet reachable from the product** | Seven layers (working, episodic, semantic, preference, project, skill, failure) with `assertion` and `verification` held as **separate records** on every entry, so *the user said so* and *an independent check confirmed it* cannot be read as the same thing: a claim's confidence has no number at all. Required provenance rows, versions on correction, contradictions kept and listed, scope and readers enforced on read with each exclusion naming its reason, deletion that takes the provenance with it and leaves a content-free tombstone, and the skill/episodic/failure layers **referencing** the registry and the episode log instead of copying them. The bridge with the existing product memory goes one way each way: an approved memory enters as a claim (approval is permission, not verification) and a fabric entry leaves as a candidate a person must approve. Tested by `memory-fabric.test.mjs` (18) and `memory-bridge.test.mjs` (7). No HTTP route or panel reads it yet, and it is not a retrieval model — there is no ranking beyond SQL ordering and no embedding of any kind. See [docs/25](25-adaptive-intelligence.md) §4 |
| Plugin and MCP authority boundary | **Implemented and tested and reachable from the product** | Every tool, plugin, resource and prompt result now carries a **provenance** — origin, digest of the exact bytes, and whether the text is instruction-shaped — instead of a bare `untrusted: true`. A consequential action (write, destructive, external, system) must cite a reason, and a reason that came from data is refused (`tainted_justification`) no matter how clearly it asks: authority is minted only from a **user turn** (`not_a_user_turn`), a grant names its actions rather than `*`, the ceiling is checked against the action's risk tier, a hand-edited copy of a token is `authority_tampered` because the fields are re-digested and privileges are read from the stored record, and taint survives derivation so a model's summary of a tool output is refused for the same reason the output was. The instruction classifier is **audit evidence, not the gate**: one named test proves an instruction it does not recognise is refused identically, so a false negative costs nothing. A user turn may `endorse` acting on data, and the record names who and why while the provenance stays untrusted. `test/mcp-authority.test.mjs` (11 tests). See [docs/25](25-adaptive-intelligence.md) §4 |
| Image generation | **Implemented and tested for OpenAI Images and Gemini Images; no live call** | `POST /api/image/generate` validates prompt (4,000 characters), size and model, then queues a durable per-account job (202). The selected wire posts to its provider (OpenAI `{base}/images/generations`, Gemini `{base}/models/{model}:generateContent`), decodes inline bytes, and accepts the artifact only if the container re-encodes to the same bytes; a URL-only or non-image response is `invalid_completion`. Jobs survive a restart, are owned by one account, and `GET /api/image/jobs/<id>/content` serves the stored bytes with `nosniff` and a sandbox CSP. The Image area renders only a succeeded job and shows its prompt, provider, model, size, digest and byte length. `test/online-image.test.mjs` (9 tests) and `test/online-gemini-images.test.mjs` (3); see [docs/27](27-provider-framework.md) §5 |

| Video generation | **Implemented and tested for Google Veo; no live call** | `POST /api/video/generate` validates prompt, aspect ratio, resolution and model, then queues a durable per-account job (202). The `gemini_veo` wire starts `models/{model}:predictLongRunning`, polls the operation with a bounded cancellable loop, downloads the file URI as bytes (the key goes only to the API origin), and stores the MP4 only if the container validates. Duration is measured from `moov/mvhd`; a still image or stub fails `assertGenuineVideo`. `POST /api/video/jobs/<id>/cancel` aborts the live request. `test/online-video.test.mjs` (9 tests); see [docs/27](27-provider-framework.md) §5 |

| Reviewed procedures | **Implemented and tested** | Owner installs a structured document; a named structural review (document parses, at least two steps, scope declared, no network) promotes a candidate, and a new version is a candidate again. A validated, text-only procedure can be selected for one message: its text is sent as reference material, usage is counted only after the provider answers, and versions, rollback and deletion persist. A procedure declaring file or network access is refused because this product has no executor. `test/online-skills.test.mjs` (9 tests); the learned-procedure surface stays archived |

| Response styles | **Implemented and tested** | Seven styles (supportive, focused, curious, cautious, reflective, playful, technical), set by the person in Chat and stored per account. The server sends the style as an instruction with the prohibitions attached, audits every reply, shows soft findings without rewriting the text, and refuses a claim of consciousness, dependence or manipulation with `style_violation`, storing nothing. Nothing infers a style from a message: the estimator stays a library. `test/online-styles.test.mjs` (8 tests) |

| Measured procedure comparison | **Implemented and tested** | The owner can measure two versions on up to five cases through the active chat connection, with explicit consent and a listed model. Each case is scored deterministically against phrases it must and must not contain; a regression is checked before the aggregate, equal scores are reported as no measured difference, and the record stores measurements and prompt digests, never prompt text. It does not promote a version. `test/online-skill-measure.test.mjs` (6 tests) |
| Video workflow | **Implemented and tested; no provider installed** | Same module: a video request needs a real clip — a still image returned instead is refused as `still_image_substitution`, a stub under 8 KiB as `output_too_small`, and a clip shorter than requested as `duration_short`. Duration is read from the MP4 `mvhd` box; a WebM returns `verified: partial` naming the unparsed EBML duration rather than assuming it. The legacy route still refuses with `needs_hardware` (501); **never substitutes a still image**, and this workflow is the check that would catch it if it tried. See [docs/25](25-adaptive-intelligence.md) §4 |

### `services/fabric` — Implemented and tested (814 tests)

| Stage | Status |
|---|---|
| data_validation | **Implemented and tested** |
| base_selection | **Implemented and tested** — compares candidate widths by held-out MRR; a language-model base is *not* selected ("no weights available on this host") |
| domain_training | **Implemented and tested** — hand-written Adam; all 5 parameter gradients match central finite differences to ~3e-10 |
| sft | **Blocked — requires weights** |
| preference_optimization | **Blocked — requires weights, data and a reward signal** |
| distillation | **Implemented and tested** — logit distillation from a locally trained teacher runs here with no credentials; distillation from an *external* teacher is **Requires external credentials** (built and tested against a local fixture, never run against a provider). See [`09-distillation.md`](./09-distillation.md) |
| evaluation | **Implemented and tested** |
| release | **Implemented and tested** — validates before releasing; rollback restores a prior version |

Overall run status is therefore **`partial`**, never `completed`. Supporting
pieces all tested: failure taxonomy, failure memory (`E_{t+1} = E_t ∪ F_t`),
experiment ledger (baseline → experiment → verdict), metrics with a latency noise
floor, DataForge, the Node↔Python text-parity fixture, model cards, and the HTTP
server (23 tests).

The separate real Hugging Face + PEFT LoRA smoke path is built but **not run**. It no
longer requires a notebook or GPU: `services/fabric/remote/run_smoke_local.py` installs
the reviewed optional stack, uses CUDA when available and CPU otherwise, and keeps its
checkpoints and `status.json` under an explicit work directory. This sandbox still cannot
reach the model hub, so that implementation does not turn NOT RUN into a result; the first
external run remains the evidence needed. See [docs/21](./21-remote-training.md).

**Cross-task transfer (L4) is implemented and was run as a pre-registered
experiment.** `fabric/transfer.py` holds the protocol — five fusion strategies, one
a-priori baseline, a one-metric decision rule, a family split decided in advance —
and `scripts/l4_transfer.py` produces the measurements; `tests/test_transfer.py` (27
tests) pins the decision procedure, including the cases where it must *refuse* a
conclusion. The recorded run is a **null**: over eight seeds the a-priori baseline
was the best strategy on the selection family, so no lesson qualified for transfer,
and the held-out families are recorded as observations rather than as a transfer.
Numbers: [`06-benchmarks.md`](./06-benchmarks.md) §9, narrative:
[`07-improvement-cycle.md`](./07-improvement-cycle.md) §9, raw cells:
[`experiments/l4-transfer.json`](./experiments/l4-transfer.json).

`fabric/lm/` is the one part of this service that does **not** follow the
`base_selection → domain_training → sft` path, because it does not need a base to
select from. It trains a character-level language model from random initialisation
using corpora it already has, which is why it is not blocked where the retrieval
pipeline is. See [`08-aetheris-lite.md`](./08-aetheris-lite.md). It carries the
same discipline: a corpus split that cannot leak, held-out evaluation against
computed baselines, a versioned card, and a gate that refuses.

Two limits on that statement are worth stating plainly rather than implying. The
corpus is this repository's own text, so **every commit changes the corpus and
therefore the model**; the first attempt at a reproduction produced a different
model (first loss 4.8057 against the release's 4.8380) and the first attempt at the
distillation experiment was refused outright when eight characters entered the
corpus. A run now writes its exact corpus beside its weights, and a reproduction can
be demanded or refused by digest rather than assumed. The full release configuration
was then run twice more, end to end. The first, on the tree at `67cdd58`: 2,005 s of
training, a corpus manifest of its own, a model of 359,520 parameters, and a gate verdict of
**RELEASED** (perplexity 5.3585 against the bigram's 16.7151, 0 hard failures). That run's
corpus turned out to include this project's own build products — `artifacts/` was missing
from the directories discovery skips — so it was fixed and the configuration re-run on the
tree at `8d9cdf8`, whose corpus rebuilds byte for byte from the commit: **that artifact is
the released `aetheris-lite-lm@0.1.1`** (359,616 parameters, perplexity 4.8932 against the
bigram's 15.7588, ratio 0.310505, gate verdict RELEASED, 0 hard and 0 soft failures). The
superseded `@0.1.0` (359,136 parameters) stays published with its own card; none of the
three perplexities is comparable with another, because the same token budget went into
corpora of different sizes, and none is reported as an improvement. That
artifact was then installed into a core data directory through `KlyvaronStore.install`,
loaded by the app, and served over HTTP: `/api/ready` reports `textCompletion: true`
and `chat: false`, an unpinned `/api/chat` is refused with `model_not_instruction_tuned`
(501), a pinned one returns a labelled continuation, and the streaming path emits
`route`/`delta`/`done` events. Python and JavaScript produce the same greedy text from
the same bytes (max logit difference 8.2e-06). Record:
[`experiments/lm-verification-run-67cdd58.json`](./experiments/lm-verification-run-67cdd58.json).
### What the CI check found, and why it took a diagnostic to see it

The **Fabric** job was red on this branch from the first Klyvaron Lite commit while every
local run of the same suite was green — a clean venv, a pristine clone, depth-1 and full
history, the same NumPy and pytest. The reason could not be read the usual way: a job log is
served from a host an agent without the repository's browser session cannot reach, and the
log page itself is behind a sign-in wall. The test step now emits the failing test and its
assertion as a check annotation, which the checks API serves openly, and the answer arrived
in one line: the committed cross-language parity fixture regenerated *byte for byte
differently* on the runner while all fourteen arrays were identical. CPython 3.11.2 frames
each local record with version-needed 20 beside the real sizes; 3.11.17 writes 45 with both
sizes replaced by the `0xffffffff` sentinel that ZIP64 defines for "the value is in the extra
field". Same members, same weights, a different container — the fixture test was comparing a
container built by the standard library.

Two things changed, both in the honest direction. The fixture test now compares the *model*
(tokenizer digest, member names, per-array dtype, shape and values) and reports which array
changed and by how much when it fails; the container is the standard library's, not this
project's. And the JavaScript reader resolves ZIP64 sentinels instead of trusting the fixed
fields, because an artifact is bytes and the interpreter that wrote it is not recorded in
them — `klyvaron-runtime.test.mjs` reads the committed fixture reframed both ways and asserts
the weights are identical, and asserts a refusal (not a guess) when a sentinel cannot be
resolved anywhere. Both tests fail against the previous reader.

And the model emits mush at this size — 359,616 parameters is enough to beat every
baseline it was measured against and not enough to hold a conversation.

### `apps/web` — Implemented and tested (95 tests)

| Area | Status |
|---|---|
| Chat | **Implemented and tested** — streaming SSE, routing panel, knowledge ingest/search/citations, task lifecycle |
| Image | **Implemented** — job queue, validation display; generation refuses on this host |
| Video | **Implemented** — as above, plus the genuineness rule |
| Plugins | **Implemented and tested** — manifest validation, install, preflight, invoke, approvals |
| MCP | **Implemented and tested** — servers, tools, risk gates, elevated-scope approvals |

**Rendering is covered** by `test/render.test.mjs` (29 tests), added after an
earlier revision of this document recorded the rendering layer as "implemented, not
fully tested". There is no browser here, and adding `jsdom` would have meant a new
dependency tree — so instead the test bundles the JSX with `rolldown` (already a Vite 8
dependency) and renders it with `react-dom/server` (already a `react-dom`
dependency). **No new dependency**, and no DOM required. `renderToStaticMarkup`
does not run effects, so nothing hits the network: every component is rendered in
its pre-fetch state, which is what a user sees first and the state most likely to
crash on a missing field.

What it covers: all five areas in three states each (degraded readiness, ready
readiness, and `null` — the actual first-paint value); `App` and the shell;
`StatusCard` in all three of its branches; all sixteen shared UI primitives with
their real prop signatures; fixture labelling; that the policy is never rendered as
an input; and that MCP's empty state does not invent servers or tools. Since sign-in
became accounts, it also renders all three sign-in pages, both steps of the reset page
(the second is only reachable after a state change, so it is exported and rendered on
its own), and the change-password dialog in the sidebar.

**Writing this test found a real bug that nothing else had caught.** `Shell.jsx`
contained

```js
export { AREAS, AREA_IDS } from '../areas.js'
```

and then called `AREAS.map(...)` in the navigation. A re-export forwards a binding
to *importers*; it does not create one in the module's own scope. So the shell
threw `AREAS is not defined` on render — **the entire interface was broken**, and
it had been since `AREAS` moved out of `Shell.jsx` into `areas.js`. Fixed by
importing the list as well as re-exporting it.

This is worth recording precisely because of what did *not* catch it. All fourteen
modules transformed and served HTTP 200 through the dev server; `/` returned 200;
the production build succeeded with no warnings; and 39 tests passed. Every one of
those checks is about *compilation*, and the defect was at *runtime*. A module can
be perfectly valid JavaScript and still throw the first time React renders it. The
"modules return 200" verification recorded in an earlier revision of this document
was real but was not evidence that the app rendered, and it should not have been
treated as near-enough.

### 4.1 A flake in the fabric resume test, found by CI and fixed at the cause

`services/fabric/tests/test_lm_train.py::test_a_resumed_run_is_the_same_run_it_would_have_been`
failed once in CI on 2026-10-16 with `{'checkpoint': 'r-….ckpt.npz', 'step': 6} == {…, 'step': 5}`,
while passing locally and passing in every other CI run. It is the one test where two processes touch
one file: it kills a child mid-run and resumes from the checkpoint that child left behind. The test
validated the checkpoint in place and *then* copied it, and the child saved the next checkpoint
between those two calls — so the bytes that were copied came from step 6 while the metadata being
compared against came from step 5. **The mechanism is confirmed rather than inferred:** with a
deliberate 40 ms gap between the read and the copy, 3 of 3 trials copied a different step than they
read (`(3, 6) (4, 7) (2, 5)`); copying first and reading the copy agreed in 3 of 3. The fix is that
ordering. The assertion is unchanged — the test was right about the run and wrong about which file it
was holding, and the checkpoint file itself is written to a staging name and moved into place, so a
reader never sees a half-written one.

### 4.2 A docs check that could not fail, found while writing the Phase 6 record

`README.md` stated **709 / 1615** tests in its setup snippet and in its "run in CI" line while its own
component table, two sections below, said **738** — and `docs.test.mjs` asserted the *stale* form
(`README must state the same totals`), so the contradiction passed every check in CI for two phases.
The status document was checked against the filesystem and the README was checked against a literal,
which is how the same figure was right in one file and wrong in the other. The test now requires
README and `docs/03` to state the same total, requires the "run in CI" line to carry it too, and
refuses every superseded form in both documents. A number stated twice with one test guarding one copy
is a number nobody is guarding.

### 4.3 Repository hygiene: what was deleted, what was merged, and what was kept

A full inventory of the 322 tracked files, done 2026-10-17. The test for "unwanted" was evidence,
not taste: a file is dead if nothing imports it, nothing tests it, and no documented procedure runs
it. Three things qualified.

**Deleted: `apps/web/legacy/` (8 files, ~230 KB).** Eight superseded React components — a second
`ChatArea`, `Shell`, `ImageArea` and so on — that no module imported, no test loaded, and the Vite
build never reached. Every one has a current replacement in `apps/web/src/areas/` and
`apps/web/src/components/`. They were kept in the Phase 2 change as "prior UI references"; a
reference nothing reads is not a reference, it is a copy that will drift. `docs/19` said they were
preserved, so `docs/19` was corrected rather than the deletion being left to contradict it.

**Merged: `withTimeout`, from two files into one.** `mcp/layer.mjs` and `plugins/registry.mjs` each
had their own copy of the same race — a timer, an abort listener and a cleared timeout — differing
only in which error class they rejected with. It now lives in `src/shared/timeout.mjs` and each
caller passes the errors it needs, because the *type* of a failure is part of a caller's contract
and the *mechanism* is not. Two copies of a timeout are two places for a cancellation to be lost.
The shared version also fixes what the copies had in common: the work is a thunk (an already-running
promise cannot be cancelled, and the clock now starts where the work does) and the caller's timer is
cleared on every path.

**Kept, and why:**

| File | Verdict |
|---|---|
| `services/core/src/legacy-server.mjs` (153) | Nothing imports it, but it is a documented entry point (`docs/02`, `docs/04`) over `app.mjs`, which `builtins.test.mjs` does exercise. Removing an entry point is a product decision, not hygiene |
| `third-party/licenses/aetheris-MIT.txt` | Byte-identical to `LICENSE`, but it is the record of the *upstream* repository's licence and is asserted by `docs.test.mjs` and by CI. The duplicate is the point: a licence record has to travel with the code it covers |
| `docs/experiments/*.json` (15) and `phase1-probes.mjs` | Measurement records with dates and machine details. Deleting one deletes the evidence for a claim in the docs |
| `services/fabric/remote/*` | The notebook, its job spec and the local runner are exercised by `test_training_notebook.py` and `test_training_local_runner.py` |
| `apps/web/src/components/ContextPanels.jsx` | One direct importer, but that importer is the Chat panel that renders it, and two web tests assert its contents |

No untracked or ignored artefacts were found in the tree beyond the empty, gitignored
`.aetheris-data/`. The suite after the change: **831 / 831** core, 48/48 docs, 93/93 web (run with
`npm ci`), 814 fabric.

### Phases 9–10 — industry packs, and a release that verifies its own numbers

Two increments, both additive: no existing module changed API, and the product routes are untouched.

| Module | Lines | What it establishes |
|---|---|---|
| `packs/manifest.mjs` | 249 | A pack is content and restriction: unknown keys refused, `dataClassFloor` can only rise, a regulated pack must require human review and name a refusal, and every capability carries either the file that evidences it or `unimplemented: true` |
| `packs/registry.mjs` | 277 | Install/enable/disable/uninstall with history and no downgrade by accident; readiness measured against the provider fabric in four states (`unknown`, `unavailable`, `partial`, `complete`); `profileFor` refuses an unavailable pack unless the gap is acknowledged; **no method grants, authorises or executes** |
| `packs/builtin.mjs` | 131 | Three shipped packs — engineering repo maintenance, legal document review, grounded tutoring — each narrowing only |
| `benchmark/harness.mjs` | 254 | Seven benchmarks over the real modules; a failed entry is kept with its error and fails the run; a zero-duration run raises instead of reporting `0 ops/s` |
| `release/manifest.mjs` | 268 | One version across `VERSION` and three packages, a dated changelog entry, documented totals compared against *supplied* measurements, required artefacts present, pack evidence on disk |

**The benchmark found a defect before the release did.** The first `readiness()` reported a pack that
honestly declared an unimplemented capability as `partial` alongside packs whose dependencies were
genuinely missing, and `profileFor` refused both. That made disclosure more expensive than silence —
the exact incentive a project about not overclaiming cannot afford. The states were split:
`unavailable` (a dependency is not served; application refused by name) and `partial` (everything
required is served, a declared gap remains; applies normally). The fix has its own assertion.

**What the release check refuses**, each case a crafted test rather than a comment: a package on an
old version; a changelog with no entry, no date, or nothing in it; a documented total one too high; a
stale grand total; a README that drifts from `docs/03`; **two documents that agree with each other
and not with the suite**; a missing artefact; a pack citing a file that is not there.

Measured release verification on this host:

| Check | Result |
|---|---|
| `node services/core/scripts/release-check.mjs --core 908 --web 95 --fabric 814` | `release 0.2.0 verified against 908 + 95 + 814 = 1817 tests` |
| `node services/core/scripts/benchmark-adaptive.mjs` | 7/7 benchmarks, 0 failed, artefact at `docs/experiments/phase10-benchmark.json` |
| `VERSION` / three `package.json` / `package-lock.json` | all `0.2.0` |

---

## 5. Built-in plugins and the in-process MCP server

Added because the Plugins and MCP areas were otherwise unfillable: a browser
cannot bind a `local_tool` handler, so handlers must be bound in code at boot.

| Component | Capabilities | Risk / scopes |
|---|---|---|
| `aetheris.insight@1.0.0` | `system.hardware`, `system.readiness`, `audit.tail`, `media.jobs` | all read-only, **no scopes** |
| `aetheris.knowledge@1.0.0` | `knowledge.search`, `knowledge.stats`, `knowledge.documents` | read-only, `knowledge.read` (not elevated) |
| `aetheris.local` (MCP) | `aetheris.hardware`, `aetheris.knowledge.search` | `read_only` |
| | `aetheris.knowledge.ingest` | `write` + elevated `knowledge.write` |
| | `aetheris.task.cancel` | `destructive`, always needs approval |
| | resource `aetheris://status`, prompt `grounded_answer` | — |

`system` and `external` risk tiers are **deliberately absent**: `system` is
refused by this build's `allowedRisks`, and no external endpoint is configured.
Neither is stubbed to look complete, and `builtins.test.mjs` asserts their
absence.

Tested beyond "registers and returns data": every capability has a genuinely bound
handler; schemas are enforced against the built-ins themselves; granting a scope
at installation level is *not* consent to use it (an approval must name the
scope); disabling a built-in stops it being invocable; a built-in cannot be
uninstalled and the refusal is audited; **invoking every built-in capability opens
no network connection at all**; and handler output is plain serialisable data,
never a live internal reference.

Verified live over HTTP through the dev-server proxy: plugin invoke returns real
hardware data, a missing required argument yields **403 `plugin_permission_denied`**,
and an unapproved destructive MCP call yields **409 `approval_required`**.

The online product registers two in-process servers of its own: `aetheris.online`
(`connection.status`, read-only) and `installation-docs` (`list-documents` and
`read-document`, read-only, bounded to 20,000 characters, resolved from the
repository's `docs/` directory rather than the working directory). A member can
read both; only the owner can toggle a server. `test/online-mcp.test.mjs` (5
tests) checks the catalogue, preflight, argument validation, the path refusal,
the untrusted provenance label, the owner gate and the disabled-server refusal.

---

## 6. Known defects found and fixed

Recorded because the classes of bug matter more than the individual fixes.

**Core service**

- `publicView()` returned live references → deep-copied via `cloneValue()`.
- `this[\`#${phase}\`]` was always `undefined`, and a `continue` inside `for...of`
  skipped the retried phase → index-based loop.
- `resume()` sliced from `fromIndex + 1`, skipping the paused phase.
- Budget was spent inside builtin handlers, so a custom handler could bypass it →
  moved to `#accountPhase` in the run loop.
- Domain errors fell through to **HTTP 500**, making a policy refusal
  indistinguishable from a crash → `ERROR_STATUS`/`statusForError`.
- **Capability refusals were not audited** — the most security-relevant events were
  the ones missing → `#refuse()`.
- The secret classifier missed env-var-style credentials, so such a prompt
  classified `public` and could have left the machine in hybrid mode.
- **`online_enabled` could not actually go online.** The policy relaxed the
  data-classification gate, but the egress guard still consulted the allowlist, so
  with an empty allowlist it rejected every external host and enforced exactly what
  `strict_offline` did. A policy named "online enabled" that cannot reach anything
  online is a control whose name promises more than it delivers — and the failure
  was silent, since nothing distinguished "blocked because offline" from "blocked
  because no host was listed". → the `*` sentinel, checked *after* `strict_offline`;
  a distinct loader warning when `*` is combined with `online_enabled`, which
  bypasses classification; and `allowAllExternal` in `publicConfig` so wide-open
  egress is visible in `/api/config` rather than only in an env file.

Lesson recorded: `node --check` catches neither private-member misuse nor
control-flow errors. Always instantiate and exercise.

**Fabric**

- `math.sqrt` applied to a NumPy array in the Adam step.
- The backward pass concatenated *embedding matrices* along axis 1 instead of
  building the `[B, B+1]` logit matrix — hard negatives are a rowwise dot product,
  not shared candidates. All five gradients now verified against finite differences.
- `RecordMixin(dict)` mixed into a `@dataclass` made attribute-only records
  **falsy**, so `if card.provenance` was always False and provenance serialised to
  `null`.
- `base_selection` recorded the baseline before measuring latency, then mutated the
  frozen baseline.
- `MetricSpec.improved` accepted a *flat* result as an improvement.

**Fabric HTTP server** (found by `tests/test_server.py`)

- `/models/current` was registered under `do_POST`, so reading a release 404'd.
- Refusing an oversized body without consuming it left the client writing →
  `Broken pipe` instead of a clean 413.

**Benchmark design — two rounds of self-correction**

1. The first dataset gave BM25 **exactly 0.0 on every metric**: a rigged comparison
   proving nothing. Fixed by labelling half the queries with a topic word →
   BM25 MRR 0.335 (low overlap) / 0.767 (high).
2. The held-out set was always query index 0, which is always the labelled
   phrasing — systematically favouring BM25. Fixed with per-topic random selection,
   recording `evaluationLabelledFraction` in `meta`.
3. A 5% relative latency tolerance rejected the dense retriever because 0.0216 ms
   vs 0.0549 ms is a difference smaller than a scheduler quantum. Fixed with a
   1.0 ms noise floor, documented, with the absolute ceiling on the model card.

**Web app**

- The artifact URL was written as `/api/media/:id`; the real route is
  `/api/media/artifact/:id`. Caught by reading the router rather than by a browser.
- `/api/media/jobs` does not filter by `kind` server-side, so sending a `kind`
  parameter implied filtering that does not happen. Removed.
- The lifecycle renderer checked for step status `'completed'`; the real value is
  `'complete'`, which would have shown every finished phase as idle.
- **`Shell.jsx` re-exported `AREAS` without importing it**, so the navigation's
  `AREAS.map(...)` threw `AREAS is not defined` and the whole interface was broken.
  A re-export forwards a binding to importers; it does not create one locally. Found
  only by the render test — every module compiled, served 200 and built cleanly,
  because those are compile-time checks and this was a runtime defect. See §4.
- The MCP console exposed `grantedScopes` but not the **separate** elevated-scope
  approval, so an ingest call could never have succeeded from the UI.

---

## 7. What remains

Ordered by how much it blocks the acceptance criteria.

1. **Install a real local LM** (Phase 4). `ollama pull <model>` on a host with
   network access to a registry, then re-probe. No code change is expected — that
   is the claim the loopback test supports, and it is the single largest gap
   between this repository and a usable product.
2. **Add an external provider, or keep refusing** (Phase 6 gave the decision an
   executable form). The online integration was removed rather than configured:
   there is still no provider, no credential and no allowlisted gateway in this
   build. What is new is that the *rules* for adding one are code rather than
   intent: an external adapter cannot even be registered with `privacy:
   'local-only'`, it is ineligible whenever no egress guard is installed and under
   `strict_offline` it is never contacted, and it is only probed when the caller
   opts in. So the remaining work is genuinely the decision and its credentials,
   not the plumbing — and until it is taken, image and video requests are refused
   with an explicit limitation, and the readiness view reports those capabilities
   as unavailable.
3. **Run the pipeline against a real corpus.** The fixture corpus is generated
   engineering documentation; retrieval quality on real company documents is
   unknown and is recorded as a limitation on the model card.
4. **Build a failure corpus** so `historicalFailures` can be measured. It is
   currently the one soft failure on the release card.
5. ~~**Component-level UI tests.**~~ **Done** — `apps/web/test/render.test.mjs`
   server-renders all five areas, the shell, the status card and every shared
   primitive using `rolldown` and `react-dom/server`, both already installed, so no
   DOM or new dependency was needed. It found the `AREAS` re-export defect (§4).
   What is still absent is *interaction* testing: nothing clicks a button, submits
   a form or follows an effect-driven fetch, because that needs a DOM. The initial
   render path is covered; the post-interaction paths are not.
6. **SFT / preference optimization / distillation** (Phase 10). All three need
   weights and, for the first and third, a GPU. Not achievable on this host and
   not faked.
7. **Connect a verified procedure to a running task** (L3) — **narrowed 2026-10-16.** The step
   that offers a stored procedure to a task while it runs, and the step that proposes one from
   a recorded success without being asked, both exist now in the adaptive loop and carry the
   milestone test ([docs/25](25-adaptive-intelligence.md) §4). What is still absent is the
   product surface: no HTTP route and no Chat panel runs the loop, so in the running product a
   procedure is still something a person loads deliberately. The demonstration is also one
   capability wide — counting newline bytes across a tree — and its measured crossover is
   recorded on the skill, so nothing here implies the assistant teaches itself in general.
8. **Select a strategy from experience while serving** (L4). The transfer test is
   implemented and has been run, and its result was a null: nothing beat the a-priori
   fusion weights, so there is nothing to select. The gap that remains is the plumbing
   — no component chooses a strategy at request time from what past tasks showed —
   and it is a gap that the measurement says should not be closed by tuning this
   fixture.
9. **A competitive benchmark against named open models** (Phase 11). Requires
   downloads that are blocked here. Until it exists, **no superiority claim over
   Mistral, Qwen, Llama, Gemma or DeepSeek is made or implied anywhere in this
   repository.**
