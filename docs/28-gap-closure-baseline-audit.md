# RAGAM — Gap-Closure Baseline Audit (Step 1)

> **Model archive notice:** model-training, weight, evaluation and release statements below describe historical experiments or plans only. Matching payloads are absent from this checkout; these records do not establish any current model release. Active Klyvaron uses deterministic model-independent processing, with Lite/Pro/Max as resource/workflow profiles.

**Audit date:** 2026-10-17  
**Baseline branch:** `arena/57c1d756-ragam`  
**Baseline commit:** `935f8e7a6f0501e43633f848c91469789259a4fe` — `Add Klyvaron product tiers with third-party provenance`  
**PR:** [#10](https://github.com/rajaram-2005/ragam/pull/10), open at the audit baseline.  
**Scope:** working checkout synchronized to that PR head before testing. No provider credentials were used and no provider was contacted live. The audit documentation is a separate, audit-only change.

## Executive finding

> **Progress since this 2026-10-17 baseline (2026-11-01):** ComfyUI has since moved from `pending` to a direct, keyless, local image adapter. The wire discovers installed checkpoints, submits a stock workflow, polls within a bounded deadline, validates the returned image and is covered by local HTTP fixtures. It does not install ComfyUI or model weights, and the exact private origin must be trusted by the operator. Diffusers remains pending because the Python library has no standard HTTP inference API; choosing a concrete bridge and model/license is deferred. No live vendor call was made.

At the baseline date, the active entry (`npm run core` → `services/core/src/server.mjs` → `OnlineApp`) was online-only and the web structure test fixed the primary areas to **Chat, Image, Video, Plugins, MCP**. Since then, ComfyUI has a direct fixture-tested local image adapter; Diffusers remains pending. The remaining gaps include 14 chat catalogue entries classified `gateway_only`, image editing and non-text video operations with no routes, and the absence of Klyvaron weight payloads in this checkout (Pro/Max artifacts do not exist, and the active online entry does not load the legacy local Klyvaron runtime).

## 1. Repository, scripts, and CI

The repository is a Node 22 monorepo without npm workspaces: `services/core` uses Node standard-library modules (including `node:sqlite`), `apps/web` is React/Vite, and `services/fabric` is Python/NumPy. The five-area declaration and the exact-nav assertion are in `apps/web/src/areas.js` and `apps/web/test/structure.test.mjs`. `freellmapi` is absent from the catalogue and explicitly rejected by `services/core/test/provider-framework.test.mjs`.

Relevant root scripts (`package.json`):

| Script | Action | Baseline |
|---|---|---|
| `npm run test:core` | Node test runner over `services/core/test/*.test.mjs` | **924 passed** |
| `npm run test:web` | Node test runner over `apps/web/test/*.test.mjs` | **96 passed** |
| `npm run test:fabric` | pytest over `services/fabric/tests` | **814 passed** |
| `npm run web:build` | Vite production build | **passed** |
| `npm test` / `npm run verify` | The three suites; `verify` also builds the web app | Equivalent constituent commands above passed |

The five CI jobs in `.github/workflows/ci.yml` are Core, Fabric, Web, Release verification, and Documentation. The Web job also installs/audits npm dependencies and scans the built bundle. Fabric checks the Python dependency advisory service and reproduces a model-card training/release run. Release verification runs all three suites, the release count check, and an adaptive benchmark. Those latter checks are not vendor live tests; the training/benchmark step was not run separately as part of this safe baseline. PR #10's five checks were all **pass** at the baseline commit.

### Commands actually run

- `npm ci --no-audit --no-fund` in `apps/web` (installed to ignored `node_modules`; no tracked dependency-file change).
- Created ignored `services/fabric/.venv`; installed NumPy **2.4.6** and pytest **9.1.1** there.
- `npm run test:core`: **924/924**, 0 failures (97.2 s).
- `npm run test:web`: **96/96**, 0 failures (1.4 s).
- `AETHERIS_PYTHON=./.venv/bin/python npm run test:fabric` from `services/fabric`: **814 passed**, 0 failures (76.8 s).
- `npm run web:build`: passed (Vite 8.3.4; JS bundle 241.94 kB, gzip 72.22 kB).

These tests use local HTTP fixture servers, synthetic model fixtures, and deterministic checks. They do not require provider credentials or contact vendor endpoints. No tests were deleted or weakened. No failure occurred in the commands run.

## 2. The 14 `gateway_only` Chat catalogue entries

Source of truth: the OpenAI-compatible array in `services/core/src/providers/catalog.mjs`; the shared wire is `services/core/src/providers/wires/openai.mjs`, registered by `wires/index.mjs`. Each row currently has `status: gateway_only`, wire `openai_chat`, Bearer/API-key shape, **an empty capability list**, and a vendor documentation URL. This status means only that a compatible endpoint might use the shared wire. It is not a vendor adapter, vendor qualification, or proof of authentication, model discovery, usage, quota, or capability behavior. No direct vendor call or vendor-specific fixture exists for these rows.

| Catalogue id | Vendor | Current implementation status |
|---|---|---|
| `openai` | OpenAI | `gateway_only`; shared OpenAI-compatible wire only; no independent vendor qualification |
| `openrouter` | OpenRouter | `gateway_only`; shared wire only; no independent vendor qualification |
| `mistral` | Mistral AI | `gateway_only`; shared wire only; no independent vendor qualification |
| `deepseek` | DeepSeek | `gateway_only`; shared wire only; no independent vendor qualification |
| `groq` | Groq | `gateway_only`; shared wire only; no independent vendor qualification |
| `together` | Together AI | `gateway_only`; shared wire only; no independent vendor qualification |
| `fireworks` | Fireworks AI | `gateway_only`; shared wire only; no independent vendor qualification |
| `xai` | xAI | `gateway_only`; shared wire only; no independent vendor qualification |
| `perplexity` | Perplexity | `gateway_only`; shared wire only; no independent vendor qualification |
| `novita` | Novita AI | `gateway_only`; shared wire only; no independent vendor qualification |
| `sambanova` | SambaNova | `gateway_only`; shared wire only; no independent vendor qualification |
| `huggingface` | Hugging Face Inference Providers | `gateway_only`; shared wire only; no independent vendor qualification |
| `vllm` | vLLM | `gateway_only`; shared wire only; optional operator-hosted endpoint; no independent qualification |
| `localai` | LocalAI | `gateway_only`; shared wire only; optional operator-hosted endpoint; no independent qualification |

Common code paths are provider descriptors and status (`catalog.mjs`), transport/auth and `GET /models`/chat request handling (`gateway.mjs`, `wires/openai.mjs`), credential sealing and connection records (`online/store.mjs`), save/test/probe/chat routes (`online/app.mjs`), and provider settings (`ProviderSettings.jsx`). The Provider Settings catalogue lets a user configure compatible endpoints, but that control does not promote any vendor to `ready`. The shared wire uses generic OpenAI-shaped requests; vendor-specific endpoint defaults, auth exceptions, model-list pagination, error/quota translation, and per-vendor capability checks have not been qualified.

**Testing now:** `provider-framework.test.mjs` asserts the 14 count, empty capability claims, selection refusal, and FreeLLMAPI exclusion; `online-wires.test.mjs` exercises the shared wire against local fixtures. **Not tested:** any of the 14 against its actual vendor, including key validity, account/model access, current rate/quota behavior, or actual request/response compatibility.

## 3. Image and Video route inventory

The active HTTP router is in `services/core/src/online/app.mjs` (media routes around lines 835–879); the client is `apps/web/src/api.js`; processing/persistence is `services/core/src/media/jobs.mjs` and `media/validate.mjs`.

| Available operation | Current route |
|---|---|
| Text-to-image submission | `POST /api/image/generate` → durable per-account job (`202`) |
| Image job list / read / delete / cancel / validated artifact | `GET /api/image/jobs`, `GET|DELETE /api/image/jobs/<id>`, `POST /api/image/jobs/<id>/cancel`, `GET /api/image/jobs/<id>/content` |
| Text-to-video submission | `POST /api/video/generate` → durable per-account job (`202`) |
| Video job list / read / delete / cancel / validated artifact | `GET /api/video/jobs`, `GET|DELETE /api/video/jobs/<id>`, `POST /api/video/jobs/<id>/cancel`, `GET /api/video/jobs/<id>/content` |
| Combined listing | `GET /api/media/jobs` |

**Missing operations/routes:** image edit/inpainting (including mask input), variations, upscaling, and other image-to-image transformations; image-to-video; video-to-video/edit; clip extension/continuation; storyboard/multi-shot generation; and other frame/sequence controls. The present generation requests are prompt-led, not media-input workflows. There is no route or UI control for these missing operations. Existing single-generation, job persistence, cancellation and output validation must not be described as support for them. Current fixture coverage is in `online-image.test.mjs`, `online-video.test.mjs`, `online-media-wires.test.mjs`, and `media-workflow.test.mjs`.

Before implementing an operation, verify that a named vendor documents it and record the exact input/output and async-job contract. Add route validation, job state/persistence, cancellation semantics where supported, output validation, UI controls, and fixture tests. A vendor without the operation must refuse rather than substitute another output.

## 4. ComfyUI and Diffusers status

At the 2026-10-17 baseline, both catalogue records were `pending` with `wire: null` and no adapter. Since then, ComfyUI has moved to `ready` with `comfyui_images` and credential kind `none`. Its adapter discovers installed checkpoints, submits a built-in text-to-image workflow, polls within a bounded deadline, validates output paths and image bytes, and is covered by a local HTTP fixture. Core must trust the exact configured origin; the service and model weights are not installed or bundled, and no live server was contacted.

Diffusers remains `pending`: the Python library has no standard HTTP inference API. It will not be wired to an invented endpoint; a concrete user-selected service/model and its license are needed first. Optional local integrations are not a required local mode or fallback. Any future adapter must retain safe origin/SSRF handling, explicit authentication behavior, bounded timeouts, output validation, tests, and explicit capability status. No GPU/CUDA dependency may be made mandatory.

## 5. Klyvaron model and inference status

**Metadata and plans:** `services/core/src/klyvaron/architecture.mjs`, `tiers.mjs`, and `plan.mjs` record the architecture, tier/model metadata, and open gates. Pro and Max configs exist as design metadata only (`released: false`, `artifact: null`); hardware qualification remains open. No Pro/Max weight artifact is present or claimed.

**Model-card records:** `docs/model-cards/aetheris-lite-lm-0.1.1.json` records a released Aetheris Lite card and weights digest; `docs/model-cards/klyvaron-mini-lm-0.1.0.json` records a released Klyvaron Mini card and digest. The latter records 1,421,952 parameters, CPU-only run provenance, and a stated wall-time soft-limit miss. These are committed metadata/report records, not weight bytes. This audit searched the checkout for `.npz`, `.npy`, `.safetensors`, `.gguf`, `.onnx`, `.pt`, `.pth`, `.bin`, and `.weights` payloads and found none. Therefore the card digests could not be recomputed from an artifact here; this audit does **not** independently verify the payload or measurements.

**Storage and loader:** the legacy `CoreApp` (`services/core/src/app.mjs`) opens `KlyvaronStore` under `<AETHERIS_DATA_DIR>/klyvaron`, scans already-installed artifacts, verifies on load, and uses `KlyvaronRuntime` plus `LocalCpuExecutor`. `klyvaron/format.mjs` validates manifest, digest, array shape and available memory; `klyvaron/store.mjs` manages storage and installed files. Model payloads are intentionally not committed; `.gitignore` excludes generated `artifacts/` and model-weight formats. No installed payload was present in the audited checkout.

**Active online path:** `npm run core` starts `services/core/src/server.mjs`, which constructs `OnlineApp`, stores data under `.aetheris-data/online` by default, and does not construct `KlyvaronStore` or load `KlyvaronRuntime`. The current `online/klyvaron.mjs` and `/api/klyvaron` endpoints represent Lite/Pro/Max as pointers to saved third-party connections/models, with explicit third-party provenance. They are product tiers, not first-party weights. The CPU runtime and local artifact library belong to the separate legacy `CoreApp` path; they are not online inference in the active entry.

**Hardware evidence:** Lite/Mini cards record CPU-only training runs; those figures are historical card claims, not new benchmark results from this audit. Pro/Max have no weights, serving measurements, or qualified hardware. CPU-only tests use synthetic fixtures; no GPU or CUDA was required for the safe test/build commands. The active product defaults to the online provider path.

## 6. Test inventory and credential boundary

Current source tests: **58 core test files**, **4 web test files**, and **39 Fabric pytest files**. Representative coverage:

- **Unit/contract:** `provider-framework.test.mjs`, `online-wires.test.mjs`, `online-media-wires.test.mjs`, `media.test.mjs`, `media-workflow.test.mjs`, `klyvaron-format/runtime/store/plan` tests.
- **HTTP/integration with local fixtures:** `online-runtimes.test.mjs`, `online.test.mjs`, `online-image.test.mjs`, `online-video.test.mjs`, `online-media-wires.test.mjs`, `online-klyvaron.test.mjs`.
- **Web structural/render regression:** `structure.test.mjs`, `render.test.mjs`, `api.test.mjs`, `format.test.mjs`.
- **Documentation/regression:** `services/core/test/docs.test.mjs` checks totals, module line counts, provider matrix, and doc assertions.
- **Fabric:** deterministic unit/integration tests across data, training, evaluation, release, storage, and service paths; no external teacher/provider is needed for the suite.

**No credentials needed:** all three local suites, local fixture server tests, docs checks, and web build. They establish code-path/contract behavior only. **Credentials/live access needed:** vendor qualification of every one of the 14 Chat entries and each claimed image/video provider requires an appropriately entitled account/credential, current model access, quota/billing availability, and an actual request to that vendor. IAM/service-account credentials apply where the provider requires them. Live checks must be run from an approved environment, secrets entered through the server-side encrypted connection flow or protected runtime secret injection, and results recorded without committing or logging secrets. No credentials are present in this audit and none were requested.

The Python advisory query and npm audit in CI need access to public advisory/package services. CI's separate release job also reproduces a Fabric model-card run and runs an adaptive benchmark; neither was part of the local test/build baseline above.

## 7. Prioritized Step 2 checklist

Do not start these changes until Step 1 is reviewed. Keep each provider at its current status until its acceptance criteria pass.

| Priority / requirement | Actual code paths to change | Tests / evidence to add | Acceptance criteria |
|---|---|---|---|
| **P0 — 14 gateway-only Chat vendors: OpenAI, OpenRouter, Mistral, DeepSeek, Groq, Together, Fireworks, xAI, Perplexity, Novita, SambaNova, Hugging Face Inference, vLLM, LocalAI** | `providers/catalog.mjs`; `providers/wires/openai.mjs`, `wires/index.mjs`; `online/gateway.mjs`, `online/store.mjs`, `online/app.mjs`; `ProviderSettings.jsx`, `ProviderCatalogue.jsx` | Vendor-specific deterministic fixture contract tests for auth, base URL, model discovery (including pagination/quirks), chat request/response, and 401/403/429/5xx translation; update catalogue/doc assertions. Then separately run a protected live smoke test per provider. | Each row is independently documented and wired; only observed capabilities are claimed; generic compatibility alone never earns `ready`; tests pass; actual-vendor smoke succeeds with model/date/result evidence before live qualification is stated. FreeLLMAPI remains excluded. |
| **P1 — Image editing and transformations** | `online/app.mjs` media routes/validation; `providers/wires/*-images.mjs`; `media/jobs.mjs`, `media/validate.mjs`; `apps/web/src/areas/ImageArea.jsx`, `api.js` | Operation-specific fixtures, invalid-input tests, job restart/cancel/output tests, UI/API regressions; verify each provider's current API docs first. | Only documented operations exposed; supported masks/inputs checked against provider schema; real returned image bytes validated; unsupported providers refuse clearly; no fake or substituted output. |
| **P1 — Video beyond text-to-video** (image-to-video, edit/extend, storyboard) | `online/app.mjs`; `providers/wires/*-video.mjs`; `media/jobs.mjs`, `validate.mjs`; `VideoArea.jsx`, `api.js` | Per-operation submission/status/cancel fixtures and failure cases; output must be a genuine validated clip; live qualification for each advertised provider operation. | Each operation is implemented only for a vendor that documents it; input media and output validated; async lifecycle bounded/persistent; no still-image substitution or invented support. |
| **P2 — Optional local media integrations (ComfyUI complete; Diffusers pending)** | `providers/catalog.mjs`; `providers/wires/comfyui-images.mjs`; `wires/index.mjs`; `online/gateway.mjs`; Provider Settings | ComfyUI has local HTTP fixture coverage for checkpoint discovery, workflow submission, bounded polling and output validation; no GPU dependency. Diffusers needs a concrete user-selected service/model before integration work can be scoped. | ComfyUI is operator-enabled and never a required service or automatic offline fallback. Keep Diffusers pending rather than inventing a service boundary. |
| **P2 — Verify accessible Klyvaron Lite/Mini payloads and keep Pro/Max blocked** | `docs/model-cards/*.json`; `services/core/src/klyvaron/{format,store,runtime,plan}.mjs`; artifact acquisition/reproduction instructions in docs | Obtain the actual expected payload through an approved artifact source or a reproducible run; verify manifest, byte count, SHA-256, arrays and runtime load; tests must fail on wrong/missing payload. No fabricated fixture may count as release evidence. | Mark Lite/Mini payload verification only after bytes match card digests and load; keep Pro/Max `artifact: null`/gates open until released, measured weights exist. Clearly distinguish active online tier pointers from the legacy local runtime. |
| **P2 — Live qualification and honest status ledger across Chat/Image/Video** | `providers/catalog.mjs`, `docs/27-provider-framework.md`, `docs/03-status.md`, provider evidence tests | Protected per-provider run records with date, endpoint/model, capability tested, normalized result, and redacted response digest; repeat after material API/auth changes. | Contract tests and live vendor qualification have separate labels; no `ready`/live-qualified claim without actual successful calls and evidence; secrets never enter tests, logs, docs, or Git. |
| **P3 — Preserve product and security invariants** | `apps/web/src/areas.js`, `online/store.mjs`, `online/gateway.mjs`, `online/app.mjs`, `services/core/test/provider-framework.test.mjs`, `apps/web/test/structure.test.mjs` | Keep five-area, credential-redaction, SSRF/origin, consent, refusal, and FreeLLMAPI regression tests. Review legacy `docs/13-hardware-execution-policy.md` and strict-offline legacy selection test separately; do not convert them into a mandatory local/offline product path. | Exactly five primary areas; online-first; encrypted server-side credentials; optional local integrations only; no secret exposure; no FreeLLMAPI; no unsupported training or capability claims. |

---

**Step 1 outcome:** baseline inspected and safe tests/build passed. The actual code paths, tests, unsupported operations, credential boundary, and acceptance criteria are recorded above. This audit makes no implementation changes to those gaps and does not start Step 2.
