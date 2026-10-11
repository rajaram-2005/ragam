# Phase 1 — Verified Repository Audit

Audit date: 2026-10-11 · Auditor: Arena agent (principal AI systems architect role)
Method: fresh `git clone` of each repository, direct source inspection, dependency
resolution, and execution of each project's own test suite. **No claim in this
document is taken from a README without a code citation.**

Status vocabulary used throughout (see `docs/03-status.md`):
`implemented+tested` · `implemented-untested` · `prototype/simulation` ·
`needs-credentials` · `needs-weights-or-hardware` · `planned` · `blocked`.

---

## 0. Audit host (bounds every conclusion below)

| Resource | Measured value |
|---|---|
| CPU | 2 cores |
| RAM | 3 939 MB total |
| GPU | **none** (`nvidia-smi` absent) |
| Disk | 21 GB, ~17 GB free after cleanup |
| Node | v22.22.3 (`node:sqlite` available and verified working) |
| Python | 3.11.2 |
| Outbound network | allowlist only: github.com, codeload, api.github.com, registry.npmjs.org, pypi.org, files.pythonhosted.org |

Two consequences drive the whole integration design:

1. **No meaningful local LLM inference or fine-tuning is possible on this host.**
   Any statement that a model is "offline-ready" here would be false. Model
   adapters are therefore implemented against real, documented provider
   contracts and report an *honest readiness state* (`needs-weights-or-hardware`)
   rather than faking output.
2. **`download.pytorch.org` and `huggingface.co` are not reachable.** A
   `pip install torch` attempt pulled the PyPI default wheel, which drags in the
   full CUDA 13 stack (~5 GB of `nvidia-*` libraries) onto a machine with no
   GPU. That install was **aborted and rolled back**; the fabric is built on
   NumPy only. See `docs/02-architecture.md` §7.

---

## 1. Repository A — `rajaram-2005/Aetheris-`

| Field | Verified value |
|---|---|
| Licence | MIT (`LICENSE`, "Copyright (c) 2026 RAJARAM K") |
| Primary language | JavaScript |
| Size | 1 399 KB (GitHub API) |
| Created / last push | 2026-10-03 / 2026-10-04 |
| Files | 86 total; ~9 582 lines across js/jsx/json/css/html/md |
| Stack | Vite + React + `lucide-react`, `node --test` |

### 1.1 Baseline build/test — **passes**

```
npm install        → added 22 packages in 4s
npm test           → # tests 37  # pass 37  # fail 0   (17.9 s)
```

This is a genuine, green baseline and it is the single most valuable asset in
Repository A. **All 37 tests were re-run and pass.** They must not be broken.

### 1.2 What is actually implemented

**Real and worth preserving (`implemented+tested`):**

- `server/agentGateway.mjs` (137 lines) — a genuinely security-conscious
  server-side provider gateway. Verified properties:
  - API key read only from `AETHERIS_API_KEY` / `AETHERIS_API_KEY_FILE`,
    **never accepted from the browser** (`handleChat` has no key input path).
  - Endpoint redaction via `redactEndpoint()` before it reaches any payload.
  - `browserKeyExposure: false` asserted in `/api/agent/health`.
  - Body-size cap (`MAX_BODY_BYTES = 1_500_000`) with `request.destroy()` on
    overflow → 413.
  - 120 s `AbortController` timeout mapped to 504, unreachable provider → 502.
  - Message allow-list: only roles `system|user|assistant|tool` with
    `typeof content === 'string'`, truncated to last 40.
  - Upstream call is `POST ${BASE_URL}/chat/completions` with
    `authorization: Bearer <key>` — i.e. **already OpenAI-compatible**, which is
    exactly FreeLLMAPI's `/v1/chat/completions` contract (§3.2).
- `src/runtime/phaseEngine.js`, `taskGraph.js`, `taskState.js`,
  `workflowEngine.js` — real state machines with pause/resume/cancel,
  checkpoints, DAG cycle validation, retries, timeouts and compensation. Covered
  by `test/phaseEngine.test.js`, `test/taskLifecycle.test.js`,
  `test/workflowEngine.test.js`, `test/phasePersistence.test.js`.
- `vite.config.js` — already binds `0.0.0.0`, sets `allowedHosts: true`, and
  proxies `/api` → `http://127.0.0.1:8787`. Correct pattern for a proxied
  preview environment; reused as-is.

**Prototype / simulation only (`prototype/simulation`) — the bulk of the repo:**

`src/runtime/` contains ~65 modules whose names advertise far more than the code
delivers. Evidence:

- The runtime is **in-browser**. `README.md` states: "In-browser runtime events
  for task creation, policy gating, agent/model delegation, verification,
  synthesis, and completion." There is no server behind them.
- `src/main.jsx` (1 252 lines) renders **hard-coded** telemetry:
  `<StatCard label="Trust score" value="98.4%" />`,
  `value="42 / 56"` agents online, `MODEL_ROWS` a literal array,
  `RUN-1042 / RUN-1041 / RUN-1039 / RUN-1037` a literal task list.
- `src/runtime/registry.js` defines the "56 specialist capabilities" as static
  data tables (`PLANE_DEFINITIONS`, `ARCHITECTURE_PHASES`, `CONTROL_PHASES`,
  `MODE_PHASES`, …). They are labels, not agents.
- Industrial/quantum/BCI/digital-twin modules (`industrialGateway.js`,
  `digitalTwin.js`, `hardwareStack.js`, `scientificMode.js`) have no transport,
  driver or device code behind them.
- The README's own closing line is the honest summary: *"This is an interface
  and local runtime prototype; real model providers, storage, OS, and device
  adapters can be connected behind the existing control-plane contracts."*

**Placeholder media presented as generated output (`prototype/simulation`):**

`public/media/aetheris-studio.jpg`, `digital-twin-factory.jpg`,
`ev-converter-lab.jpg`, `aetheris-offline-voice.wav`. The README calls these
"real local preview assets" inside a "Creative Studio … for generated assets".
Nothing generates them. Under the integration directive these are **development
fixtures** and are kept out of every production success path (§9).

### 1.3 Product-surface conflict

`NAV_ITEMS` in `src/main.jsx:73-86` defines **12** top-level sections:

`command`, `observability`, `architecture` ("150-phase engine"), `workflows`,
`agents` ("56"), `models`, `coding`, `mcp` ("57"), `plugins` ("12"),
`knowledge`, `studio`, `devices`.

The directive mandates **exactly five**: Chat, Image, Video, Plugins, MCP.
This is the largest structural change required in Repository A. Mapping used in
Phase 3 (`docs/02-architecture.md` §5):

| Existing section | Disposition |
|---|---|
| `command`, `coding`, `knowledge` | folded into **Chat** |
| `studio` (image part) | becomes **Image** |
| `studio` (video part) | becomes **Video** |
| `plugins` | stays **Plugins** |
| `mcp` | stays **MCP** |
| `observability`, `architecture`, `workflows`, `agents`, `models`, `devices` | demoted to **internal services**, surfaced through Chat/MCP only |

### 1.4 Security review

- **No credentials committed.** `.env.example` ships empty values; `.gitignore`
  covers `.env`. Verified by inspection, not assumption.
- Good secret hygiene in the gateway (§1.2).
- Weakness: `ALLOWED_ORIGIN` defaults to `'*'` in `agentGateway.mjs`. Acceptable
  for a single-user localhost gateway, **not** for multi-user. Tightened in
  Aetheris Omni.
- Weakness: all "policy gating" and "sandbox" enforcement lives in browser JS,
  so it is advisory only — a user can bypass it from devtools. Aetheris Omni
  moves enforcement server-side.

---

## 2. Repository B — `rajaram-2005/sparsiz`

| Field | Verified value |
|---|---|
| Licence | **Unlicense** (public domain) — compatible with MIT redistribution |
| Primary language | Python (176 files, 20 574 lines); + 26 `.rs`, 3 `.c`, 47 `.md` |
| Version | `setup.py` → `0.6.0` |
| Created / last push | 2026-09-26 / 2026-09-28 |
| README | 80 864 bytes — vastly larger than the code it describes |

### 2.1 Baseline test — **1 failure**

Dependencies declared in `setup.py` (`torch, numpy, scipy, networkx, pyyaml,
toml, prometheus_client, grpcio, protobuf`) were **not installed** in the audit
environment; a minimal venv with `pytest` only was used:

```
python -m pytest tests/ -q
→ 1 failed, 14 passed, 4 warnings in 0.19s
FAILED tests/test_saram.py::test_compression - ModuleNotFoundError
stdout: "Torch not available, using numpy mock encoder"
```

Honest baseline: **14 pass / 1 fail**. The failure is a missing-dependency path,
and the fallback it tries to take is itself described in-code as a *"numpy mock
encoder"*. Only 4 test files exist (`test_faisanth.py`, `test_premsoth.py`,
`test_rajaram.py`, `test_saram.py`) — all named after people, not subsystems.
There is **no CI workflow** in this repository.

### 2.2 The decisive finding: the training stack is randomised simulation

`setup.py` declares torch/numpy/scipy, but **no module in the repository imports
any of them.** Measured import histogram across all 176 `.py` files:

```
116 sparsiz   99 typing   84 dataclasses   70 random   33 enum
 26 time      25 sys      12 math          11 hashlib   5 uuid
  2 physics    2 os        2 cmath          1 json      1 abc   1 setuptools
```

`torch` — **0 imports**. `numpy` — **0 imports at module level** (it appears
only inside two function bodies as an optional fallback:
`sparsiz/faisanth.py:137` and `:287`). `random` — **70 imports**.

The metrics are therefore fabricated. Verbatim source evidence:

| File | Line | Evidence |
|---|---|---|
| `training/evaluation/evaluation.py` | 52-54 | `# Mock evaluation — in production would run actual benchmarks` then `baseline = random.uniform(0.5, 0.8)`; `score = baseline + random.uniform(-0.05, 0.15)` |
| `training/dataforge/dataforge.py` | 54-61 | `# Mock scoring — in production would use models, heuristics, source reputation` then five `random.uniform(...)` quality terms |
| `training/distillation/distillation.py` | 55-61 | `# Mock distillation steps`; prints `"Student training with KL divergence loss"` while performing no computation; `verification_score = random.uniform(0.7, 0.95)` |
| `training/rl/rl_engine.py` | 49-53 | all five reward terms `random.uniform(...)` |
| `training/evolution/evolution.py` | 47, 109 | `score = random.uniform(0.6, 0.95)`; `improvement = random.uniform(-0.05, 0.1)` |
| `training/neural-foundry/foundry.py` | 184, 243 | `scores[exp] = random.uniform(0.1, 0.5)` |
| `training/quantum/quantum_training.py` | 31-51 | `loss = 1.0 * (0.7 ** epoch) + random.uniform(0, 0.1)` — a hard-coded decaying curve plus noise |
| `training/neuromorphic_training.py` | 37, 46 | `conversion_loss = random.uniform(0.05, 0.15)` |
| `benchmarks/benchmark.py` | — | energy `E=∫P(t)dt` computed as `power * 10.0` from simulated telemetry |

Consequence: **`sparsiz` contains no real training, distillation, RL or
evaluation capability.** Its `EvaluationFabric.evaluate_category()` would return
a different "benchmark result" on every call for the same model. Any Aetheris
Lite claim built on it would be unfounded. This is precisely the failure mode
the directive warns about, so it is recorded explicitly rather than papered over.

Note the self-aware docstring in `benchmarks/benchmark.py`: *"Do not claim
superiority before benchmarking."* The code does not honour its own docstring.

### 2.3 What is genuinely reusable

Not everything is mock. Three real assets were extracted:

1. **Taxonomies and contracts** (real, well-designed, domain-agnostic):
   - `training/failure-memory/failure_memory.py` — `FailureCategory`
     (13 values: hallucination, reasoning, mathematics, coding, retrieval,
     tool_usage, vision, audio, long_context, physics, planning, safety,
     agent_coordination) and `RootCause` (9 values: DATA, MODEL, REASONING,
     RETRIEVAL, TOOL, TRAINING, ARCHITECTURE, CONTEXT, HARDWARE), plus the
     regression-memory invariant **`E_{t+1} = E_t ∪ F_t`**. Uses `uuid`/`time`
     only — no fabricated numbers. **Adopted directly.**
   - `training/evaluation/evaluation.py` — `BenchmarkCategory` (17 values
     including `HISTORICAL_FAILURES`) and the rule that historical failures must
     not regress (`passed = score >= baseline`, stricter than the other
     categories' `>= baseline * 0.95`). **The enum and the no-regression rule are
     adopted; the scoring function is replaced.**
   - `training/dataforge/dataforge.py` — `DataSample` with
     `sha256(content)[:16]` content hashing, `DataQualityTier`
     (BAD/MEDIUM/HIGH/ELITE), and the documented quality function
     `Q(x) = w₁Q_semantic + w₂Q_technical + w₃Q_novelty + w₄Q_source − w₅Q_risk`.
     **The formula and tiers are adopted; every input term is replaced with a
     real, deterministic measurement.**

2. **Real routing mathematics** — `sparsiz/faisanth.py` (298 lines) is not mock:
   an explicit edge-cost function
   `C_ij = αL_ij + βE_ij + γT_ij + δB_ij⁻¹ + εR_ij`, a node-cost function
   `J_i = w₁L_i + w₂T_i + w₃E_i + w₄U_i + w₅R_i`, a `ComputeGraph`, and a
   `YBus` admittance matrix with topology estimation and pseudoinverse. This is
   the conceptual ancestor of Aetheris Omni's capability-aware **Model Router**
   cost function (`docs/02-architecture.md` §4.3).

3. **Architectural honesty** — `ARCHITECTURE.md` §0 opens with a "Correction"
   section retracting an earlier over-claim ("Original concept conflated OS
   kernel, hypervisor, AI orchestration, eBPF, distributed systems, power math,
   BCI, crypto, hardware scheduling, quantum, neuromorphic"). It also states:
   *"Real security: OS perms, capabilities, memory protection, IOMMU, secure
   boot, TPM, signatures, isolation"* — explicitly disclaiming its own
   `PermissionMatrix` as "policy not crypto". That candour is carried forward.

### 2.4 Duplication — 35 byte-identical files

The repo ships two parallel copies of itself: top-level directories
(`agi/`, `scada/`, `skills/`, `training/`, …) and the importable `sparsiz/`
package (`sparsiz/agi/`, `sparsiz/scada/`, …).

Measured with a file-by-file `diff`:

```
identical duplicates:        35
same-name-but-different:      2   (skills/fields/__init__.py,
                                   training/distillation/distillation.py
                                   vs sparsiz/mobile/distillation.py)
.py files under ./sparsiz:   84
.py files outside ./sparsiz: 92
```

Only the `sparsiz/` package is importable (`tests/*.py` import
`from sparsiz.rajaram import …`, `from sparsiz.makesh import …`). The top-level
tree is dead weight that will silently diverge. **Aetheris Omni imports the
concepts, not the files**, so this duplication is not propagated.

### 2.5 Scope that the directive explicitly excludes

Present in sparsiz and deliberately **not** integrated: `quantum/`,
`training/quantum/`, `neuromorphic/`, `bci/`, `interfaces/bci/`, `kernel/`,
`kernel-baremetal/`, `hardware/fpga|npu|quantum`, `scada/`, `interfaces/modbus|
mqtt|opcua|scada`, `digital-twin/`, `robotics/`, `superalignment/`, `patent/`,
`world-model/`, `simulations/power_grid|thermal`.

Directive §7: *"Avoid introducing speculative quantum, neuromorphic, bare-metal,
BCI or industrial-control features merely to make the project appear more
advanced."* These are recorded as **`planned` (out of scope)**, not deleted from
upstream and not vendored.

### 2.6 Security review

No credentials, no network calls, no `eval`/`exec`/`subprocess` found in the
training stack. Risk is **epistemic rather than exploitative**: the fabricated
metrics are the vulnerability. `SECURITY.md` exists but describes the
aspirational RAJARAM/PREMSOTH model, not shipped code.

---

## 3. Repository C — `tashfeenahmed/freellmapi`

| Field | Verified value |
|---|---|
| Licence | MIT |
| Primary language | TypeScript (682 `.ts` + 112 `.tsx`) |
| Stars / forks | 33 138 / 4 583 |
| Created / last push | 2026-04-21 / **2026-10-11 (today)** — actively maintained |
| Structure | npm workspaces: `shared`, `server`, `client`, `cli` + `desktop/` |
| Storage | `better-sqlite3` with a real migration system (`src/db/migrations`) |
| Deployment | `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh` |

This is the only one of the three that is a mature production system. It is
**not** vendored or copied. Directive §4.E is followed: it is integrated as a
*separately versioned external service* through its published HTTP contract,
behind a provider abstraction, so Aetheris Omni keeps working when it is
absent.

### 3.1 Verified endpoint surface

Extracted from `server/src/**` by grepping declared router paths (not from the
README):

```
/v1/chat/completions        /v1/completions          /v1/embeddings
/v1/rerank                  /v1/images/generations   /v1/videos/generations
/v1/audio/speech            /v1/audio/transcriptions /v1/models
/v1/responses               /v1/messages  (Anthropic-compatible)
/v1/messages/count_tokens   /v1beta/models (Gemini-compatible)
/api/chat, /api/tags        (Ollama-compatible)
/v1/usage  /v1/providers  /v1/openapi.json  /v1/docs
/v1/t/{token}/chat/completions   (URL-scoped revocable tokens)
```

`server/src/routes/` contains a real `mcp.ts` — FreeLLMAPI is itself an MCP
host, which Aetheris Omni's MCP layer can interoperate with.

### 3.2 Exact contracts Aetheris Omni codes against

Auth: `Authorization: Bearer <unified API key>` (`db/index.ts:225
getUnifiedApiKey()`); missing/invalid → **401** (asserted by
`__tests__/routes/video-generations.test.ts`).

**Chat** (`routes/proxy.ts:599 chatCompletionSchema`): `messages` (required,
min 1; union of system/developer/user/assistant/tool/function), `model?`,
`temperature?` (0–2), `max_tokens?` (int; `<=0` treated as unset), `top_p?`
(0–1), `stop?`, `stream?`, `stream_options.include_usage?`, `tools?`,
`tool_choice?`, `parallel_tool_calls?`, `fusion?`, plus extended sampling /
`response_format` structured output. **Tool calling is genuinely supported.**

**Embeddings** (`:667`): `{model?, input: string|string[], dimensions?}` →
`{object:'list', data:[{object:'embedding', index, embedding}], model, provider,
usage:{prompt_tokens,total_tokens}}`.

**Rerank** (`:705`): `{model?, query (min 1), documents[] (min 1), top_n?}` —
Cohere/Jina style. Directly useful for the knowledge pipeline.

**Images** (`:745 ImageBody`, handler `:769`):
`{model?, prompt (required, min 1), n? (int 1–4), size?, response_format?:
'url'|'b64_json'}` → **JSON** `{created, data: images[], model, provider}`.
`model:'auto'` or omitted tries every enabled image provider in order; a
provider model id pins one. Failover is *across providers, never across
modalities*.

**Videos** (`:795 VideoBody`):
`{model?, prompt (required), duration? (int 1–120), aspect_ratio?:
'16:9'|'9:16', image? (url), seed? (int −1…2147483647), audio?: bool}` →
**raw binary MP4**, not JSON. Response headers: `Content-Type` (from provider,
default `video/mp4`), `Cache-Control: no-store`, `X-Provider`, `X-Model`.

Critical video semantics, quoted from the source comment at `:792`:
> *"Providers may use a synchronous binary response (Pollinations) or an
> asynchronous queue internally (Hugging Face/fal.ai), but this gateway presents
> one bounded request and returns the completed MP4."*

and at `:812`:
> *"A video job runs for minutes, so a caller that hangs up must actually stop
> the work … `res.on('close', …)` … `writableEnded` distinguishes."*

So **cancellation is achieved by aborting the HTTP request** — the gateway then
stops polling the provider. Aetheris Omni's video job queue is built around this
fact (`services/core/src/media/videoJobs.mjs`): it owns the job lifecycle,
progress and timeout locally, and cancels by aborting its own fetch.

`VIDEO_PLATFORMS = {pollinations, huggingface}` only (`services/media.ts:32`),
versus `MEDIA_PLATFORMS = {nvidia, pollinations, cloudflare, siliconflow,
google, speechify, electronhub, freeai}` for images (`:27`). And
`routes/keys.ts:921`: *"video generation models are not supported on custom
endpoints yet; skipped"*. **Chat support therefore does not imply video
support** — exactly the trap directive §4.E warns about, and now confirmed from
code rather than assumed.

**Error contract** (uniform across media/embeddings):
`{error: {message, type, code?}}` where `type ∈ invalid_request_error (400/413)
| authentication_error (401) | rate_limit_error (429) | server_error`, HTTP
status clamped to 400–599 else 502, plus a `Retry-After` header set from
`retryAfterMs` (soonest provider back-off) or `secondsUntilNextMonth()` on
`quota_exceeded`. Aetheris Omni's adapter honours `Retry-After` rather than
retrying blindly.

### 3.3 Security review

Strong: `ENCRYPTION_KEY`-based at-rest key encryption
(`lib/crypto.ts` `encrypt()` → `encrypted_key, iv, auth_tag` columns), CSP
tests (`csp-security.test.ts`, `csp-inline-bootstrap.test.ts`), body-limit
tests, error-handler information-leak tests, auth login throttling, revocable
URL-scoped tokens, key rotation/reveal endpoints. `.env.example` is 21 764 bytes
of *empty* settings — no committed secrets.

Residual risk for Aetheris Omni: it is a **third-party gateway to 34 upstream
providers**. Its own description scopes it as *"Personal experimentation only."*
Provider quotas, terms and availability change without notice. Hence:
hybrid-mode egress requires explicit authorisation, and company-private data
defaults to local processing (directive §5).

---

## 4. Cross-repository integration map

| Aetheris Omni capability | Reused from | Verified source | New code required |
|---|---|---|---|
| Server-side secret gateway | **A** | `server/agentGateway.mjs` | Extend: multi-provider, redaction, origin allowlist |
| Task lifecycle (pause/resume/cancel/checkpoint) | **A** | `runtime/taskState.js`, `phaseEngine.js`, `workflowEngine.js` (37 tests) | Port semantics server-side into God Core |
| Capability-aware routing cost function | **B** | `sparsiz/faisanth.py:184 edge_cost`, `:189 node_cost` | Real Model Router over model metadata |
| Failure taxonomy + regression memory | **B** | `training/failure-memory/failure_memory.py` | Persistent store, real classification, suite growth |
| Benchmark categories + no-regression rule | **B** | `training/evaluation/evaluation.py` | **Real** scoring (replaces `random.uniform`) |
| Data quality formula + tiers + hashing | **B** | `training/dataforge/dataforge.py` | **Real** deterministic quality terms, dedup, contamination check |
| Online chat / embeddings / rerank | **C** | `/v1/chat/completions`, `/v1/embeddings`, `/v1/rerank` | Provider adapter + failover + `Retry-After` |
| Online image generation | **C** | `/v1/images/generations` (JSON) | Adapter, output validation, storage |
| Online video generation | **C** | `/v1/videos/generations` (binary MP4, abort = cancel) | Job queue, progress, MP4 validation, storage |
| Local LLM inference | **none** | — | **New**: Ollama + llama.cpp/OpenAI-compatible adapters, honest readiness |
| Private knowledge retrieval | **none** | — | **New**: ingest, chunk, BM25, citations, ACL, deletion |
| Plugin permission enforcement | **A** (UI only) | `runtime/pluginFabric.js` | **New**: server-side manifest validation + enforcement |
| MCP with schema validation | **A** (in-browser) | `runtime/mcpFabric.js`; **C** `routes/mcp.ts` | **New**: real MCP client, untrusted-output handling |
| Aetheris Lite model family | **none** | — | **New**: NumPy training fabric (§2.2 shows sparsiz cannot supply it) |

---

## 5. Licence review

| Repository | Licence | Redistribution | Attribution action |
|---|---|---|---|
| Aetheris- | MIT | permitted with notice | notice preserved in `third-party/NOTICES.md` |
| sparsiz | Unlicense | unrestricted | recorded; concepts re-implemented, no files copied |
| freellmapi | MIT | permitted with notice | **not copied**; notice preserved for contract reference |
| ragam (this repo) | MIT | — | compatible with all three |

No GPL/AGPL contamination found. **Model-weight licences are a separate, still
open item**: no weights are redistributed or downloaded here, and any future
Aetheris Lite base must have its licence recorded in its model card before
release (directive §6 Stage 6).

---

## 6. Baseline recorded for regression comparison

| System | Command | Result |
|---|---|---|
| Aetheris- | `npm test` | **37 pass / 0 fail** |
| sparsiz | `python -m pytest tests/ -q` | **14 pass / 1 fail** (`test_saram.py::test_compression`, missing torch/numpy) |
| freellmapi | `npm test` (workspaces, needs `better-sqlite3` native build) | **not run** — `blocked` on native toolchain in this sandbox; contracts read from source instead |
| ragam (Aetheris Omni) | see `docs/03-status.md` | established in Phase 3+ |

The Aetheris 37-test suite and the sparsiz 14-passing-test baseline are the
measures Phase 3–11 changes are compared against.
