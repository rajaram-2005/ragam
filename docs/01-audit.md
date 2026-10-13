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
    the same shape the local llama.cpp adapter speaks.
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
There is **no CI workflow** in the sparsiz repository. (Aetheris Omni has one; see [`04-setup.md`](./04-setup.md) §5.)

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

## 3. Cross-repository integration map

| Aetheris Omni capability | Reused from | Verified source | New code required |
|---|---|---|---|
| Server-side secret gateway | **A** | `server/agentGateway.mjs` | Extend: multi-provider, redaction, origin allowlist |
| Task lifecycle (pause/resume/cancel/checkpoint) | **A** | `runtime/taskState.js`, `phaseEngine.js`, `workflowEngine.js` (37 tests) | Port semantics server-side into God Core |
| Capability-aware routing cost function | **B** | `sparsiz/faisanth.py:184 edge_cost`, `:189 node_cost` | Real Model Router over model metadata |
| Failure taxonomy + regression memory | **B** | `training/failure-memory/failure_memory.py` | Persistent store, real classification, suite growth |
| Benchmark categories + no-regression rule | **B** | `training/evaluation/evaluation.py` | **Real** scoring (replaces `random.uniform`) |
| Data quality formula + tiers + hashing | **B** | `training/dataforge/dataforge.py` | **Real** deterministic quality terms, dedup, contamination check |
| Local LLM inference | **none** | — | **New**: Ollama + llama.cpp/OpenAI-compatible adapters, honest readiness |
| Private knowledge retrieval | **none** | — | **New**: ingest, chunk, BM25, citations, ACL, deletion |
| Plugin permission enforcement | **A** (UI only) | `runtime/pluginFabric.js` | **New**: server-side manifest validation + enforcement |
| MCP with schema validation | **A** (in-browser) | `runtime/mcpFabric.js` | **New**: real MCP client, untrusted-output handling |
| Aetheris Lite model family | **none** | — | **New**: NumPy training fabric (§2.2 shows sparsiz cannot supply it) |

---

## 4. Licence review

| Repository | Licence | Redistribution | Attribution action |
|---|---|---|---|
| Aetheris- | MIT | permitted with notice | notice preserved in `third-party/NOTICES.md` |
| sparsiz | Unlicense | unrestricted | recorded; concepts re-implemented, no files copied |
| ragam (this repo) | MIT | — | compatible with both |

No GPL/AGPL contamination found. **Model-weight licences are a separate, still
open item**: no weights are redistributed or downloaded here, and any future
Aetheris Lite base must have its licence recorded in its model card before
release (directive §6 Stage 6).

---

## 5. Baseline recorded for regression comparison

| System | Command | Result |
|---|---|---|
| Aetheris- | `npm test` | **37 pass / 0 fail** |
| sparsiz | `python -m pytest tests/ -q` | **14 pass / 1 fail** (`test_saram.py::test_compression`, missing torch/numpy) |
| ragam (Aetheris Omni) | see `docs/03-status.md` | established in Phase 3+ |

The Aetheris 37-test suite and the sparsiz 14-passing-test baseline are the
measures Phase 3–11 changes are compared against.
