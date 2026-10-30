# 02 — Architecture

> **Active product: online-only (Phase 2).** [Current setup, features and limitations](19-online-only-phase-2.md) supersede the offline-first product instructions below. Legacy local/research **service** code remains for reference and regression tests; it is not loaded by `npm run core`. Superseded UI components were deleted on 2026-10-17, not retained. Suite totals include retained legacy coverage.

How the three upstream repositories became one system, what each component owns,
and where the enforcement points are.

Phase 1 (what was found in each repository) is in [`01-audit.md`](./01-audit.md).
Current implementation status is in [`03-status.md`](./03-status.md).

---

## 1. The shape of the system

Three processes, one product surface.

```
┌──────────────────────────────────────────────────────────────────────┐
│  apps/web            React 18 + Vite                                 │
│  FIVE product areas: Chat · Image · Video · Plugins · MCP            │
│  No credentials. No policy decisions. Relative /api paths only.      │
└───────────────┬──────────────────────────────────────────────────────┘
                │  /api  (Vite proxy in dev; same-origin in production)
┌───────────────▼──────────────────────────────────────────────────────┐
│  services/core       Node 22 ESM, ZERO npm dependencies              │
│                                                                      │
│  policy ── router ── providers ── knowledge ── media ── plugins      │
│     │         │          │            │          │         │         │
│     └─────────┴──────────┴─────┬──────┴──────────┴─────────┘         │
│                                │                                     │
│                          godcore (8-phase lifecycle)                 │
│                                │                                     │
│                          audit ledger (SQLite, append-only)          │
└───────┬──────────────────────────────────────────┬───────────────────┘
        │ loopback only                            │ optional, HTTP
┌───────▼───────────────┐                ┌─────────▼──────────────────┐
│ Local runtimes        │                │ services/fabric            │
│ Ollama :11434         │                │ Python 3.11 + NumPy only   │
│ llama.cpp :8080       │                │ training · evaluation      │
│ (reachable offline)   │                │ experiment ledger          │
└───────────────────────┘                │ model release + rollback   │
                                         └────────────────────────────┘
```

The dependency direction is strict: `web → core`, and `core → fabric` only over
HTTP when enabled. No cloud provider is bundled. Configured non-loopback
Ollama/OpenAI-compatible endpoints are remote inference, gated by task mode and
server policy; only in-process/loopback execution is labelled local. Each arrow that
crosses a process boundary is a place where a credential, a policy decision or an
output validation happens — never in the browser.

### Why three processes and not one

- **`services/core` has zero npm dependencies.** That is a testable property, and
  it is why the root `package.json` is a script runner rather than an npm
  workspace: hoisting `apps/web`'s 62-package tree over the core would give it a
  dependency surface it does not have and make that property unverifiable.
- **`services/fabric` is Python** because the training work is NumPy-shaped. It
  runs as its own service on `:8791`, so a training run can never take down
  request handling, and so its (deliberately minimal) dependency set stays
  separate.
- **No online gateway is bundled.** External providers were removed rather than
  vendored: a gateway with a native SQLite dependency does not belong inside this
  repository, and a build with no external provider is one where the offline
  guarantee has nothing to leak past. The router still supports `online` model
  descriptors, so adding one later is a provider adapter, not a redesign.

---

## 2. Component responsibilities

Line counts are real (`wc -l`), listed so the weight of each part is visible.

### `services/core` — 37,293 source lines, 24,547 test lines

| Module | Lines | Owns |
|---|---|---|
| `hardware/detect.mjs` | 61 | OS memory, CPU features, disk and optional bounded GPU probes |
| `hardware/admission.mjs` | 92 | Measured model/workload eligibility, GPU qualification and tier recommendations |
| `legacy-server.mjs` | 153 | Retained offline-first entry; not the active product |
| `online/accounts.mjs` | 387 | Accounts, scrypt password hashes, lockouts, throttling and host-delivered reset codes |
| `online/app.mjs` | 1,815 | Authenticated online application, per-account context, verified native Klyvaron Pro/Max multimodal local inference, runtime qualification & manifest endpoints, and user-computer training worker controls alongside exact-model external gateway routing |
| `online/native-klyvaron.mjs` | 469 | First-party Klyvaron Pro (27,559,946 params) and Klyvaron Max (92,077,066 params) SHA-256 verification, preset-architecture enforcement, startup live inference self-test, and fail-closed selector gating |
| `online/context-routes.mjs` | 260 | Authenticated context and reviewed read-only tool routes |
| `online/gateway.mjs` | 222 | Bounded transport for every saved connection: destination validation, deadline, size bounds, SSE, no redirects. Wire adapters supply the request shape; the resolver admits a catalogue id only when its wire is implemented and its status is not pending |
| `online/failure.mjs` | 9 | One coded error shape, in its own module so wire adapters raise it without importing the transport |
| `online/http.mjs` | 32 | Bounded JSON requests and no-store responses |
| `online/klyvaron.mjs` | 87 | Klyvaron product tiers in the online build: resolve a tier to a saved connection and a listed model, refuse an unconfigured tier by name, and name the third-party provider and model as provenance |
| `online/store.mjs` | 405 | Multi-connection encrypted store (schema 2): one sealed credential per connection, an active id, a store-wide revision, native first-party model selection persistence, and optional Klyvaron tier presets |
| `app.mjs` | 1,835 | Composition root, the HTTP route table, error→status mapping, chat/image/video/skill entry points, readiness |
| `godcore/lifecycle.mjs` | 738 | The eight-phase lifecycle, budgets, retries, checkpoints, pause/resume/cancel/approve, verification |
| `klyvaron/format.mjs` | 721 | The Klyvaron artifact format: manifest validation, character and learned Byte-BPE vocabulary digests, differentiator head metadata, and a ZIP/`.npy` reader that refuses a mismatched checkpoint |
| `builtins.mjs` | 378 | Two built-in plugins and the in-process MCP server |
| `media/jobs.mjs` | 444 | Job queue, progress, cancellation, timeouts, image/video/audio artifact storage |
| `klyvaron/runtime.mjs` | 1,045 | First-party `aetheris-core-v1` Transformer inference in plain JavaScript across Lite/Pro/Max: Byte-BPE + character tokenizers, int8 LUT dequantization, incremental KV-cache parity, age/state conditioning, verdict/state heads, and cancellation |
| `klyvaron/multimodal-host.mjs` | 677 | First-party multimodal host for Klyvaron Image, Video, and Voice (`pro` & `max`): SHA-256 verification, native Python runtime execution, PNG/MP4/WAV output validation, and runtime qualification |
| `klyvaron/qualification.mjs` | 257 | Persistent runtime qualification registry keyed by hardware signature, backend, runtime version, model version, and SHA-256 digest with automatic staleness invalidation |
| `klyvaron/training-worker.mjs` | 674 | Consent-gated local training worker setup and execution manager: hardware/software inspection, stable preflight snapshot with live-resource separation, compute/license/storage/energy pre-consent disclosure, expiry-bound consent, resource re-checks, atomic checkpointing, cancellation, and recovery |
| `klyvaron/training-controller.mjs` | 1,155 | User-computer-first training & adaptation controller: unpaired fail-closed default, 5-mode resource-aware planner across all 8 models, non-silent downgrade approval gate, 7-field training specification + disclosure consent, 120s interactive ceiling vs unbounded foundation pretraining, and hot rollback |
| `klyvaron/local-worker.mjs` | 1,161 | Authenticated cross-platform local worker HTTP RPC server: single-use pairing handshake, constant-time Bearer token verification, realpath directory confinement, zero shell execution, and 9 typed local inference/qualification/training operations |
| `providers/local.mjs` | 329 | Ollama and OpenAI-compatible local providers |
| `router/registry.mjs` | 356 | Model descriptors, capability matching, candidate scoring, tag exclusions |
| `plugins/registry.mjs` | 613 | Install/enable/disable/uninstall, scope enforcement, preflight, invocation, signature checks |
| `mcp/layer.mjs` | 624 | Servers, tools, risk tiers, approval gates, allowlist, output neutralisation |
| `mcp/authority.mjs` | 537 | The data/instruction boundary: provenance on every tool, plugin, resource and prompt output, an authority that only a user turn can mint, and a consequential action refused when its only reason is data — with the classifier kept as audit evidence precisely so the refusal does not depend on it |
| `shared/timeout.mjs` | 46 | The one timeout-and-cancellation race, shared by the MCP layer and the plugin registry: a thunk so the clock starts where the work does, a `{ once: true }` abort listener so a signal cannot reject a promise nobody is waiting for, and the timer cleared on every path — with each caller supplying its own error type, because the failure's type is contract and the mechanism is not |
| `knowledge/pipeline.mjs` | 470 | Ingest, dedupe, chunk, index, search, grounded context, purge |
| `knowledge/store.mjs` | 385 | SQLite metadata, chunks, ACL rows, deletion records |
| `mcp/schema.mjs` | 246 | JSON Schema subset: validation of schemas *and* of arguments/output |
| `catalog/registry.mjs` | 126 | Versioned discovery-only model records, provenance, bounded snapshots, TTL and search |
| `catalog/sources.mjs` | 100 | Operator-configured metadata adapters, safe credential loading, egress, body/deadline bounds |
| `klyvaron/execution.mjs` | 125 | One-slot CPU worker admission, bounded token acknowledgements, cancellation/deadlines and residency |
| `klyvaron/worker.mjs` | 49 | Lazy local artifact loading, pinned identity verification and isolated synchronous CPU execution |
| `klyvaron/store.mjs` | 256 | Installing, verifying, listing, loading and removing local models inside the managed storage budget |
| `knowledge/bm25.mjs` | 224 | BM25 index (k1=1.5, b=0.75), rebuilt from stored chunks |
| `plugins/manifest.mjs` | 216 | Manifest validation, scope vocabulary, semver |
| `plugins/signing.mjs` | 262 | Ed25519 manifest signatures, canonical form, the local trust store |
| `config.mjs` | 248 | Environment → config, secret loading, `publicConfig` redaction |
| `policy/egress.mjs` | 253 | The egress guard, runtime policies, data classes, `*` allow-all, global fetch hook |
| `providers/klyvaron.mjs` | 295 | The first-party provider adapter: `klyvaron-chat-v1` multi-turn rendering, freshness age conditioning, local worker execution, and explicit limitations carried into every response |
| `server.mjs` | 100 | Entry point, startup banner, graceful shutdown |
| `knowledge/text.mjs` | 147 | Tokeniser, stemmer, sentence splitter, chunker |
| `media/validate.mjs` | 199 | Magic-byte sniffing, video genuineness check |
| `media/workflow.mjs` | 487 | Image and video generation as a workflow rather than an attempt: routed through the provider fabric so an unservable request is refused by name, authorised through the broker when the provider is external, measured from the artifact's own header (PNG/GIF/JPEG dimensions, MP4 `mvhd` duration) before it is described, and a still image returned for a video request refused as a substitution rather than delivered |
| `klyvaron/footprint.mjs` | 137 | The footprint report a user sees: categorized bytes plus unmanaged files, against the 5 GB budget |
| `providers/base.mjs` | 136 | Provider contract, timeout and retry helpers |
| `policy/classify.mjs` | 143 | Secret and sensitivity classification, redaction |
| `audit/ledger.mjs` | 137 | Append-only SQLite ledger, query, NDJSON export, subject purge |
| `memory/store.mjs` | 702 | User-approved memory, candidates that need approval before use, and session recall with citations |
| `memory/fabric.mjs` | 790 | Seven layers, each entry carrying assertion and verification as separate records, required provenance rows, a confidence with a required basis, scope and readers enforced on read, and deletion that takes the provenance with it |
| `memory/bridge.mjs` | 138 | Approved memory entering the fabric as a claim (never a fact), and fabric entries leaving as candidates a person must approve; one direction, because the schema refuses the other |
| `skills/permissions.mjs` | 272 | The permission block of a SKILL.md: parsed, refused when malformed or wildcarded, bounded against the runtime grant, and used as the scope the procedure runs with — a caller cannot widen it |
| `skills/evaluation.mjs` | 274 | EVALUATE and DIAGNOSE: an append-only digest-chained verdict log, the incumbent's passing checks as the regression set, and a closed set of diagnoses (regression, regression_not_run, new_failure) so a rejection says which kind it was |
| `storage/budget.mjs` | 429 | Managed-footprint accounting against the 5 GB mobile limit, integrity checks, regenerable-only cleanup |
| `storage/supabase-admin.mjs` | 104 | Server-only Supabase REST client with fixed-origin, endpoint, header, timeout and credential-redaction guards |
| `storage/supabase-account-repository.mjs` | 138 | Account-scoped PostgREST operations that force owner filters and reject identity changes |
| `klyvaron/tiers.mjs` | 1,140 | Separated subscription tiers, 8 first-party Klyvaron model identities (`pro` & `max` across Chat, Image, Video, Voice), programmatic runtime capability readiness (`ready`, `partially_available`, `missing_artifact`, `runtime_unqualified`, `training_required`, `unsupported_hardware`), and separate Pro/Max capability manifests |
| `klyvaron/plan.mjs` | 187 | The development plan: thirteen per-tier gates derived from the tier records, including the stance, the two differentiators, modality separation and `own_weights`, each open gate with its reason |
| `klyvaron/trends.mjs` | 186 | Dated, sourced observations that expire and abstain; the mechanism `trend.awareness` is defined against, with no model behind it |
| `klyvaron/affect.mjs` | 181 | Consent-gated, evidence-cited states from the user's own messages, with abstention and no diagnosis; the mechanism `affect.history` is defined against |
| `klyvaron/architecture.mjs` | 640 | The family's own models: `aetheris-core-v1` (Lite/Mini/Pro/Max presets), `aetheris-image-v1`, `aetheris-video-v1`, and `aetheris-voice-v1`, the two differentiators as parts of the LM, parameter/memory arithmetic, and per-size recipe evidence |
| `klyvaron/composition.mjs` | 259 | The training-free path this family refused: the eight composition steps, the licence allowlist, and the rules that keep a composed tier from claiming a trained one or from wearing a tier label |
| `hardware/accelerators.mjs` | 194 | The accelerator registry (CUDA, ROCm, Metal, Vulkan, OpenVINO GPU/NPU, CPU) and the weight plus KV-cache arithmetic that decides whether a model fits |
| `skills/registry.mjs` | 425 | Skill states and the append-only version history; promotion requires recorded checks that all passed |
| `skills/manifest.mjs` | 327 | The SKILL.md document format: frontmatter, sections, platform gating, description limits |
| `skills/lifecycle.mjs` | 286 | The curator walk and the five invariants that make "never delete a skill" structural |
| `skills/store.mjs` | 246 | Skills on disk: document + state split, version files for rollback, deletion tombstones |
| `skills/product.mjs` | 337 | Reviewed procedures as a product surface: structured install, a structural review that promotes a candidate, versions and rollback, per-account selection for one message, and deletion with a tombstone. No executor, so a procedure that declares access is refused in chat |
| `skills/measure.mjs` | 158 | Deterministic scoring and comparison for two versions of a procedure on the same cases; a regression rule before aggregation, and a no-difference verdict that refuses to call equal scores an improvement |
| `online/styles.mjs` | 87 | Seven user-controlled response styles over one fixed instruction, a per-account durable preference, and a store that reports an unreadable preference instead of guessing one. No inference from message content |
| `adaptive/capability.mjs` | 194 | The capability descriptor every route is described by: kind, dotted `provides` tags, declared cost with no `measured` escape, fs/network/permission scope, and the `implementation` tag verification independence is decided on |
| `adaptive/router.mjs` | 230 | `routeTask`: gates, refusals that name their reason, measured cost outranking an unmeasured claim, and a pin that is honoured only when it passes every gate |
| `adaptive/providers.mjs` | 535 | The model and provider fabric: adapters that declare the capability tags they serve, an eligibility rule shared by routing *and* probing so a provider the policy forbids is never contacted, and a request no single adapter covers refused by name rather than split across two or trimmed to fit |
| `adaptive/executors.mjs` | 199 | Two line counters over a tree — a materialising baseline and a 64 KiB streaming one — used as the milestone's genuinely independent pair |
| `adaptive/verify.mjs` | 139 | Verification by recomputation against a counterpart implementation, plus a stride-sampled `wc -l` check that is honest about being a sample |
| `adaptive/episodes.mjs` | 296 | Outcome computed rather than asserted, labelled failure hypotheses, acceptance evaluation, and an append-only JSONL episode log with a digest chain that reports where it broke |
| `adaptive/wording.mjs` | 673 | Seven interaction states over one verbatim facts block, settings that report when they changed nothing, and a render-time §4 audit that throws instead of emitting |
| `adaptive/loop.mjs` | 593 | The loop itself: measure, run, verify through a named counterpart, propose a skill from a verified success only, test it, promote it, reuse it, roll back by appending a version |
| `adaptive/intent.mjs` | 183 | Capability requirements read from a request with the phrase that produced each; an unmatched request gets a question rather than a default, and emotional signals are read and used for nothing |
| `adaptive/registry.mjs` | 157 | Which implementations exist for a capability tag and which tags a plan needs that nothing provides; one id with two meanings is refused |
| `adaptive/plan.mjs` | 171 | Dependency-ordered plans with a digest; a plan longer than its budget or needing an uninstalled capability is refused by name rather than truncated |
| `adaptive/budget.mjs` | 202 | Steps, calls, wall time and tokens; a gate that refuses to *start* work its measurement cannot cover, and unreported token counts kept as unreported rather than counted as zero |
| `adaptive/checkpoint.mjs` | 248 | Atomic, digest-chained checkpoints; newest intact record read, torn writes skipped and reported, and a resume against a different plan refused |
| `adaptive/runner.mjs` | 428 | A plan executed step by step with a checkpoint after each, resumable by inheriting only steps that completed *and* verified; deadlines gated before a synchronous step and reported after it |
| `packs/manifest.mjs` | 249 | The pack document: vocabulary, refusals, review requirements and restriction *floors* — unknown keys refused and the data-class floor only ever raised, so a pack cannot be used to widen a policy |
| `packs/registry.mjs` | 277 | Installed, enabled and disabled packs; readiness measured against the provider fabric (a capability this installation cannot serve is reported by name, never substituted), application that refuses an unavailable pack unless the caller acknowledges it, and no method that grants, authorises or executes |
| `packs/builtin.mjs` | 131 | Three shipped packs — engineering repo maintenance, legal document review (confidential, human review, "reading support, not legal advice"), grounded tutoring — each narrow, and each capability either evidenced by a file in this repository or marked unimplemented |
| `benchmark/harness.mjs` | 254 | The measured benchmark of the adaptive core: every entry calls the real module, a failed entry is kept in the table with its error and fails the run, and a benchmark that measures nothing is refused rather than reported as zero |
| `release/manifest.mjs` | 287 | Release verification: one version across `VERSION` and the three packages, a dated changelog entry, documented totals compared against supplied measurements (not against each other), all 8 Pro/Max multimodal cards and run records verified present, and every shipped pack capability evidenced |
| `providers/catalog.mjs` | 388 | The vendor catalogue: wire format, auth kind, documentation URL and a status per provider. A `ready` entry may only claim capabilities backed by a test in this repository; `gateway_only` may claim none; `pending` is refused by name. Validation is what keeps a credential field unrepresentable |
| `providers/select.mjs` | 173 | Capability selection with reasons: strict offline refuses a remote request before candidates are considered, an unrecorded context limit does not satisfy a stated minimum, and every rejected candidate is returned with a code rather than silently dropped |
| `providers/errors.mjs` | 228 | One failure shape for every provider: status→code mapping, retryability decided by code, bounded `Retry-After`, and messages redacted against six credential patterns before they can reach a log |
| `providers/wires/index.mjs` | 121 | The wire registry: `IMPLEMENTED_WIRES` is derived from it, so a provider cannot be promoted onto a wire nothing implements |
| `providers/wires/openai.mjs` | 72 | OpenAI-compatible chat: `{base}/models`, `{base}/chat/completions`, SSE with a `[DONE]` sentinel |
| `providers/wires/deepseek.mjs` | 12 | DeepSeek Chat Completions and rich model metadata for context, output limits and modalities |
| `providers/wires/fireworks.mjs` | 50 | Fireworks inference plus bounded, account-scoped cursor-paginated model discovery |
| `providers/wires/groq.mjs` | 12 | Groq OpenAI-compatible Chat Completions over its documented /openai/v1 base |
| `providers/wires/huggingface.mjs` | 12 | Hugging Face Inference Providers router adapter; provider-dependent capabilities remain unknown |
| `providers/wires/localai.mjs` | 12 | Optional LocalAI Chat Completions adapter without inferred backend/parser capabilities |
| `providers/wires/mistral.mjs` | 13 | Mistral Chat Completions and native model-list shape, retaining reported metadata only |
| `providers/wires/novita.mjs` | 12 | Novita OpenAI-compatible API with documented /openai/v1 endpoint paths |
| `providers/wires/openai-compatible.mjs` | 116 | Shared tested request/response envelope with provider-specific model-list parsers, metadata normalization and safe provider error mapping |
| `providers/wires/openrouter.mjs` | 12 | OpenRouter routed Chat Completions and model catalogue, with routed model ids preserved |
| `providers/wires/perplexity.mjs` | 13 | Perplexity routed API with separate /v1/models and /router/v1/chat/completions paths |
| `providers/wires/sambanova.mjs` | 12 | SambaNova Cloud Chat Completions and model-list adapter |
| `providers/wires/together.mjs` | 13 | Together Chat Completions and chat-only model catalogue parsing |
| `providers/wires/vllm.mjs` | 12 | Optional self-hosted vLLM Chat Completions adapter, still subject to trusted-origin egress policy |
| `providers/wires/xai.mjs` | 68 | Native xAI Responses API, language-model metadata and response.completed stream validation |
| `providers/wires/common.mjs` | 70 | Conversation shaping shared by the native wires: system hoisting, same-role merging, user-first refusal, token counts |
| `providers/wires/anthropic.mjs` | 93 | Anthropic Messages: `x-api-key`, `anthropic-version`, top-level `system`, content blocks, `message_stop` as the completion signal |
| `providers/wires/gemini.mjs` | 102 | Gemini generateContent: model in the path, `x-goog-api-key`, `contents`/`systemInstruction`, `alt=sse`, blocked-prompt refusal |
| `providers/wires/cohere.mjs` | 112 | Cohere Chat v2: Bearer auth, `/v2/chat` with a `system` message, typed SSE ending at `message-end`, and paginated `/v1/models` |
| `providers/wires/azure.mjs` | 74 | Azure OpenAI v1: `api-key` header, `/openai/v1/chat/completions`, the deployment name in `model`, and OpenAI SSE |
| `providers/wires/sigv4.mjs` | 107 | AWS Signature Version 4 for Bedrock: canonical request, credential scope and derived signing key, checked against AWS's published worked example |
| `providers/wires/vertex.mjs` | 192 | Vertex AI: a service-account JWT assertion exchanged for an OAuth token, the regional `generateContent` path, and v1beta1 publisher-model discovery |
| `providers/wires/bedrock.mjs` | 158 | Bedrock Converse: SigV4-signed requests, an IAM credential document, model-metadata filtering, and non-streaming by contract |
| `providers/wires/gemini-images.mjs` | 105 | Gemini image generation over `generateContent`: inline `inlineData` bytes, size-to-aspect-ratio mapping, and the same refusal of a returned URL |
| `providers/wires/images.mjs` | 82 | OpenAI Images: `{base}/images/generations`, inline base64 decoded and re-encoded before it is accepted, a 4,000-character product prompt cap, four sizes, and a refusal rather than a fetch when a response carries only a URL |
| `providers/wires/veo.mjs` | 172 | Veo through the Gemini API: `predictLongRunning`, bounded cancellable polling, a file download that sends the key only to the API origin, and MP4 duration measured from `moov/mvhd` |
| `providers/wires/media-common.mjs` | 225 | Shared media-wire helpers: strict base64 decoding, inline-versus-URL artifact acquisition, a bounded cancellable poll schedule, multipart bodies, container sniffing, and the rule that a provider URL receives the credential only on the exact configured API origin |
| `providers/wires/stability-images.mjs` | 88 | Stability AI v2beta: Bearer auth, multipart `prompt`/`output_format`/`aspect_ratio`, `Accept: image/*`, and raw response bytes validated as a real image container |
| `providers/wires/recraft-images.mjs` | 66 | Recraft: `/images/generations` with `response_format: b64_json`, a URL-only response refused rather than fetched, and the requested PNG format pinned |
| `providers/wires/ideogram-images.mjs` | 108 | Ideogram v2: `Api-Key` multipart generation, both the synchronous `data[]` result and an accepted asynchronous `generation_id` polled to completion, and delivery URLs fetched without the key |
| `providers/wires/bfl-images.mjs` | 102 | Black Forest Labs FLUX: `x-key` submission, polling the provider-supplied `polling_url` only on its own origin, and a signed `result.sample` downloaded without the key |
| `providers/wires/fal-queue.mjs` | 104 | The fal.ai queue contract shared by image and video: submit, poll status, fetch the result, same-origin URL checks, and best-effort `PUT` cancellation |
| `providers/wires/fal-images.mjs` | 70 | fal.ai image models: the documented prompt and preset `image_size` inputs, result URL extraction, and no credential on the CDN hop |
| `providers/wires/fal-video.mjs` | 70 | fal.ai video models: documented prompt, aspect-ratio and resolution inputs, queue polling, and MP4 download without the key |
| `providers/wires/replicate-predictions.mjs` | 105 | Replicate predictions: `POST /models/{owner}/{name}/predictions`, polling the prediction's own `urls.get`, cancellation, and output-URL extraction across the shapes models return |
| `providers/wires/replicate-images.mjs` | 54 | Replicate image models with a deliberately empty size list (no common geometry input), a prompt-only prediction, and a signed output URL downloaded without the token |
| `providers/wires/replicate-video.mjs` | 54 | Replicate video models with empty geometry lists, a prompt-only prediction, and a validated MP4 download |
| `providers/wires/runway-video.mjs` | 125 | Runway: the mandatory `X-Runway-Version` header, `text_to_video`, ratio mapping, `duration` only for the gen4 family, bounded task polling, output download and `DELETE` cancellation |
| `providers/wires/luma-video.mjs` | 109 | Luma Dream Machine: `POST /generations`, `queued`/`dreaming`/`completed`/`failed` translation, `assets.video` download without the key, and `DELETE` cancellation |
| `providers/wires/firefly-images.mjs` | 126 | Adobe Firefly: a validated two-part OAuth client credential, an in-memory IMS token exchange and cache, `x-api-key` plus Bearer generation, and a delivery download that carries neither secret |

### `services/fabric` — 17,241 source lines, 10,540 test lines

Data validation → base selection → domain training → SFT → preference
optimization → distillation → evaluation → release, as a single reproducible
`Pipeline`. Plus the experiment ledger, the failure-memory recurrence, the model
release manager, first-party multimodal architectures (`fabric/multimodal/` for
`aetheris-image-v1`, `aetheris-video-v1`, and `aetheris-voice-v1`), a hand-written
dual encoder whose **five parameter gradients all match central finite differences to ~3e-10**,
and a prototype that trains the two differentiator parts in the same loss as the language objective.
See its own [`README`](../services/fabric/README.md).

### `apps/web` — 5,595 source lines, 2,247 test lines

Five area components, three sign-in pages (sign in, create account, reset
password), the account card and the Klyvaron tier panel, a shell, shared primitives,
an API client and five test files. The sign-in pages are not areas and add no navigation
entry; see [20 — Accounts and sign-in](20-accounts-and-sign-in.md). Design tokens and the shell's visual structure come from upstream Aetheris
(see [`../third-party/NOTICES.md`](../third-party/NOTICES.md) §1.1).

---

## 3. The five areas, and where everything else went

Upstream Aetheris exposed twelve navigation entries
(`_audit/Aetheris-/src/main.jsx:73-86`). This system exposes five. The mapping is
recorded in code, in `apps/web/src/areas.js`, and tested by
`apps/web/test/structure.test.mjs`.

| Upstream section | Now |
|---|---|
| command, coding, knowledge | **Chat** |
| studio-image | **Image** |
| studio-video | **Video** |
| plugins | **Plugins** |
| mcp | **MCP** |
| observability, architecture, workflows, agents, models, devices | **internal — no navigation entry** |

Internal services are surfaced *inside* the areas that need them, labelled
"INTERNAL SERVICE" in the interface:

| Internal service | Where it appears |
|---|---|
| Model routing | Chat → "Model routing decision" panel: chosen model, explanation, rejected candidates with reasons |
| Model management | Chat → "Registered models" table with availability, location, capabilities; sidebar status card shows `ready/total` |
| Private knowledge pipeline | Chat → "Private company knowledge": ingest, search, citations, stats, reindex |
| God Core orchestration | Chat → "God Core task lifecycle": eight phases, budgets, pause/resume/cancel/approve, verification checks, limitations |
| Memory & retention | Chat → knowledge stats (`deletions` counter) and per-document classification/owner/sha256 |
| Safety / data classification | Chat composer (data-class selector) + per-message classification chip; redaction chips on messages |
| Resource management | Sidebar status card: CPU, RAM, GPU; Image/Video areas echo the hardware profile |
| Media validation | Image/Video → job detail: validation record, rejection reasons, artifact sha256 |
| Execution control | Image/Video → job cancellation, progress, state history; Chat → task pause/resume/cancel |
| Training & benchmarking | Not in the web app at all. `services/fabric` is a separate service; results are published as model cards and run records |

Two consequences are deliberate:

- **The runtime policy is displayed, never toggled from the browser.** Policy is
  server configuration. A client-side switch would be a fake control, so
  `structure.test.mjs` fails if any `setPolicy`/`changePolicy` appears in
  browser-facing source.
- **Training is not a product area.** Making it one would invite the assumption
  that a run is safe to trigger from a browser tab. It is an operator action on a
  separate service, with its own ledger.

---

## 4. Model routing

Hardware detection, model-specific admission and the task execution modes are
specified in [13-hardware-execution-policy.md](./13-hardware-execution-policy.md).
The CPU completion runtime checks load/forward-pass allocations; GPU tiers require
benchmark-qualified profiles. No production GPU profile is bundled yet.

The router is capability-aware and provider-independent. A model descriptor
declares what it can do; nothing in the router knows which provider serves it.

**Capabilities** (`MODALITIES`): `text_in`, `text_out`, `image_in`, `image_out`,
`video_in`, `video_out`, `audio_in`, `audio_out`, `embedding_out`, `rerank`.

**Kinds** (`MODEL_KINDS`): `local_llm`, `local_embedding`, `local_reranker`,
`local_vision`, `local_image_gen`, `local_video_gen`, `online_llm`,
`online_embedding`, `online_image_gen`, `online_video_gen`, `online_audio`.

**Availability** (`AVAILABILITY`): `ready`, `not_installed`, `unreachable`,
`needs_credentials`, `needs_hardware`, `disabled`. These are *measured* by
probing, never assumed. A model is not "offline-ready" because its adapter exists.

**Gating** happens before scoring (`#reject`): tool calling, streaming,
structured output, minimum context window, capability match, location vs policy,
and external permission. A pinned model (`preferId`) wins only if it survived the
same gates — pinning cannot bypass policy.

**Scoring** (`#score`) is a weighted sum, weights in `DEFAULT_ROUTING_WEIGHTS`:

| Factor | Weight | Meaning |
|---|---|---|
| `capabilityFit` | 0.40 | fraction of requested capabilities the model declares |
| `privacy` | 0.25 | 1.0 for `local`, 0 for external |
| `latency` | 0.15 | measured median ms inverted over a 4 s soft ceiling; **unknown = 0.5**, so probing is rewarded and an unprobed model cannot win on an assumed-zero latency |
| `resourceFit` | 0.10 | `min(ramGb/minRamGb, vramGb/minVramGb)` for local models |
| `quality` | 0.10 | `1 / costWeight` — smaller and cheaper wins when it can do the job |

The privacy weight of 0.25 is what makes local win ties. Every decision returns
`candidates` with their score breakdowns and `rejected` with per-model reasons, so
"why this model?" is answerable from the response rather than from a log dive. The
Chat area renders both.

The scoring approach descends from `sparsiz/faisanth.py`, which contains real
mathematics (YBus construction, edge and node cost). The formula itself was
replaced; see [`../third-party/NOTICES.md`](../third-party/NOTICES.md) §1.2.

---

## 5. Enforcement points

Everything below is enforced in `services/core`. The browser is a display.

### 5.1 Network egress

`createEgressGuard` decides *before* `fetch` is called, so a blocked request
opens no socket and performs no DNS lookup. `installGlobalEgressGuard` also
replaces `globalThis.fetch`, which covers code that never imported the guard —
the realistic failure mode.

| Policy | Behaviour |
|---|---|
| `strict_offline` | external hosts rejected; loopback runtimes stay reachable |
| `hybrid` | exact-host allowlist, and only data classified at or below `externalCeiling` |
| `online_enabled` | exact-host allowlist, no classification ceiling |

Allowlists match **exact hosts** — no wildcards, no suffix matching.

The single entry `*` means **any** external host. It is a normal allowlist entry, so
it is exact and not a glob: `*.example.com` still matches nothing. It exists because
the two axes above are independent and the policy alone could not express "fully
online". `online_enabled` relaxes the *classification* gate, but the egress guard
still consulted the allowlist, so `online_enabled` with an empty allowlist rejected
every external host and was indistinguishable from `strict_offline` at the point of
enforcement. The capability is now stated explicitly rather than implied by the
policy name.

`*` is checked **after** `strict_offline`, so it can never weaken offline mode;
`offline.test.mjs` asserts that ordering, and a negative control that swaps the two
checks fails. `hybrid` with `*` and `online_enabled` with `*` are both fully online
and are **not the same decision** — the first keeps the ceiling, the second does not.
The loader warns specifically when the bypass is combined with wide-open egress. A blank or
invalid policy **fails safe to `strict_offline`** and records a warning; it never
fails open. `offline.test.mjs` proves the blocking with a recording `fetch` spy:
`api.openai.com`, `api.example.com`, `huggingface.co` and `api.anthropic.com` are
all rejected while the spy's call log stays empty, and a real loopback
Ollama-protocol server still completes a genuine chat round-trip under
`strict_offline`. Offline must not mean "nothing works".

### 5.2 Data classification and redaction

`classifyText` assigns `public | internal | confidential | restricted`. Patterns
include whole-identifier matches for env-var-style credentials, because
`\bsecret\b` cannot match inside `AWS_SECRET_ACCESS_KEY` (`_` is a word
character) — a gap that would have let such a prompt classify as `public` and
leave the machine in hybrid mode. Redaction runs **before** egress and is audited;
the Chat UI shows a `redacted N` chip rather than hiding it.

### 5.3 Credentials

`readSecret` accepts a value or a `*_FILE` path (prefer the latter in containers).
`publicConfig` is the only config view that crosses the HTTP boundary and carries
booleans (`keyConfigured`), never values. `redactUrl` reduces a URL to
`protocol://host/path` — no query string. A `VITE_*(KEY|TOKEN|SECRET|PASSWORD)`
variable is reported as a warning at load, because Vite ships `VITE_*` into the
browser bundle. Seven endpoints were swept for `LLAMACPP_API_KEY` leakage.

### 5.4 Plugins

Scopes are an allowlist; anything undeclared is denied at invocation time.
Manifests are validated outright (semver, id pattern, protocol, per-capability
`inputSchema`, scope coverage) and an invalid one is rejected with *every* problem
listed. `ELEVATED_SCOPES` (`fs.write`, `terminal.exec`, `network.external`,
`credentials.read`, `service.external`, `device.access`, `knowledge.write`) always
need an explicit per-call approval. `FORBIDDEN_SCOPES` (`credentials.write`,
`policy.override`, `godcore.bypass`, `audit.erase`) can never be granted.
Installation is not authorisation: a plugin installs as `installed`, not
`enabled`. Uninstalling keeps an auditable record (`state='uninstalled'`) rather
than deleting it, which is what stops an older version being silently reinstalled
over a known-good one. Built-ins cannot be uninstalled, and the refusal is
audited.

`preflight` answers a question, so it returns HTTP 200 with `allowed: false`;
`invoke` must actually fail. Both are rendered distinctly in the UI so "denied" is
never mistaken for "broken".

### 5.5 MCP

Risk tiers drive the gates: `read_only`, `write`, `destructive`, `external`,
`system`. `destructive`, `external` and `system` **always** require an approval
naming `server:tool` or the tier. Schemas are validated at *registration*
(`assertValidSchema`), not at first call, and `$ref` is rejected outright so a
schema cannot smuggle in an unvalidated reference. Arguments are validated before
the handler runs and output after it returns; output is then sanitised regardless
— size-bounded and control-character neutralised — because tool results are
attacker-controllable in the general case. Every result carries `untrusted: true`.
Timeouts are per-tool, capped at 300 s. Cancellation aborts the call, which for
video means aborting the request, since a video response is a raw binary
container rather than a pollable status.

`SYSTEM` risk is refused outright by this build's `allowedRisks`, so nothing may
advertise a system tool.

### 5.6 Media validation

`validateMedia` sniffs magic bytes and compares against the claimed content type;
`looksLikeTextPayload` catches a JSON or HTML error page masquerading as media — a
common provider failure path. For video, `assertGenuineVideo` additionally rejects
a payload whose sniffed kind is an image, and one below 8 KB. **A still image is
never presented as a generated video**: the job fails with the reason recorded,
and `MediaPreview` refuses to embed anything whose sniffed kind is not video even
if an artifact somehow exists. Every stored artifact carries format, mime, byte
length and sha256.

### 5.7 God Core

`Understand → Plan → Retrieve → Route → Execute → Observe → Verify → Synthesize`,
with per-phase budget accounting performed **by the core before any handler runs**
(`#accountPhase`), so a custom phase handler cannot bypass it. Steps record an
`evidence` quality — `observed`, `verified`, `planned_only`, `unavailable`,
`skipped`, `failed` — which is what allows the honesty rule:

> A plan-only run ends `state=partial` with limitations naming the heuristic
> intent detection, the absent executor and the unverified results. It never
> reports `SUCCEEDED`.

Phase failures retry within `maxRetries`, then fail honestly. Exceeding a budget
ends the task as `partial` with the reason recorded. Pause/resume is checkpointed
by `phaseIndex` (a pause→resume yields 2 → 9 steps with
`checkpoint.phaseIndex=1`). Task states: `pending`, `running`,
`awaiting_approval`, `paused`, `succeeded`, `partial`, `failed`, `cancelled`,
`timed_out`.

### 5.8 Audit

An append-only SQLite ledger. Every policy decision, capability refusal, plugin
install/enable/deny, MCP server registration and tool call, media job transition,
ingestion, duplication and deletion is recorded with category, action, outcome,
actor, subject and detail. `exportNdjson` supports export; `purgeSubject` supports
retention obligations. Refusals are audited — an early defect had capability
refusals returning without a ledger entry, which meant the most security-relevant
events were the ones missing.

---

## 6. Storage

One database would have been the wrong tool for four different access patterns.

| Data | Store | Why |
|---|---|---|
| Document metadata, chunks, ACL grants, deletion records | SQLite (`node:sqlite`) | relational, transactional, queried by classification and owner |
| Audit ledger | SQLite, append-only | ordered, paginated, exported, purged by subject |
| Generated media | filesystem | blobs; addressed by sha256, served through `/api/media/artifact/:id` |
| BM25 index | in-memory | **rebuildable** from stored chunks at startup; never a source of truth |
| Learned procedures | filesystem (`<dataDir>/skills`) | a procedure is reviewed by a person, so its document stays a file that can be read and edited. State, usage counters and version metadata sit in a machine-maintained `.state.json` beside it, and `.versions/` is what makes rollback survive a restart. Not a database, because a failed review of a database row is not a review |
| Model weights | not stored by default | `output_dir` opts in; digests are recorded either way |

Absolute paths never reach the browser: `publicView` on media jobs omits them, and
the artifact route serves bytes by job id.

---

## 7. HTTP surface

40 literal routes plus segment-matched routes under `/api/tasks`, `/api/plugins`,
`/api/mcp`, `/api/media`, `/api/knowledge`, `/api/memory`, `/api/sessions` and
`/api/skills`. There is no `/api/routes`.

Domain errors map to accurate statuses through `ERROR_STATUS`/`statusForError` —
`unknown_task` and `unknown_server` are 404, `approval_required` is 409,
`plugin_permission_denied` is 403, `no_model_available` and
`capability_unavailable` are 503, `not_implemented` and `needs_hardware` are 501.
An early defect let these fall through to HTTP 500, which made a policy refusal
indistinguishable from a crash. Error bodies carry `error`, `message`, and where
relevant `limitation` and `route`; the web client's `ApiError` preserves all of
them, so the UI can say "no model is installed" instead of "request failed".

---

## 8. What is deliberately absent

Recorded so the absence is a decision rather than an oversight.

- **No simulation layer.** Upstream `src/runtime/` (~65 modules of in-browser
  simulation) was not ported. Where a capability cannot be real here, it reports a
  limitation.
- **No `system`-risk MCP tools and no `external`-risk tools.** The former is
  refused by `allowedRisks`; the latter has no configured endpoint. Neither is
  stubbed to look complete.
- **No online provider at all.** No external gateway is vendored, consumed or
  configured; the image and video areas refuse with an explicit limitation rather
  than route a prompt anywhere.
- **No speculative acceleration.** No quantum, neuromorphic, bare-metal, BCI or
  industrial-control features. Everything runs on 2 CPUs and 3.85 GB RAM with no
  GPU, which is the point: the first implementation must be portable and testable
  on conventional hardware.
- **No multi-agent fan-out.** The simplest workflow that meets the quality bar is
  preferred; added latency and cost need justification, and none was found.
- **No weights in the repository.** `.gitignore` excludes `*.gguf`,
  `*.safetensors` and `checkpoints/`.


### Catalog boundary

`/api/models/catalog` and `/api/models/catalog/refresh` are metadata-only operations,
inside Chat. They do not change `/api/models` routing readiness. See
[17](./17-model-catalog.md) for source versioning, optional operator configuration,
explicit metadata-network consent and the non-durable cache limitation.
