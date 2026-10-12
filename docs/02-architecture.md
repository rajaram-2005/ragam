# 02 — Architecture

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
        ┌────────────────────────────────────────┐
        │ FreeLLMAPI — NOT vendored. Consumed as │
        │ a separately versioned service over    │
        │ /v1, only when policy allows it.       │
        └────────────────────────────────────────┘
```

The dependency direction is strict: `web → core`, and `core → fabric` only over
HTTP when enabled. Nothing depends on FreeLLMAPI being present. Each arrow that
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
- **FreeLLMAPI is consumed, not copied** (see [`01-audit.md`](./01-audit.md) §3).
  A 33k-star TypeScript gateway with a native SQLite dependency does not belong
  inside this repository. Aetheris must — and does — work when it is absent.

---

## 2. Component responsibilities

Line counts are real (`wc -l`), listed so the weight of each part is visible.

### `services/core` — 7,380 source lines, 5,237 test lines

| Module | Lines | Owns |
|---|---|---|
| `app.mjs` | 1,122 | Composition root, the HTTP route table, error→status mapping, chat/image/video entry points, readiness |
| `godcore/lifecycle.mjs` | 739 | The eight-phase lifecycle, budgets, retries, checkpoints, pause/resume/cancel/approve, verification |
| `builtins.mjs` | 378 | Two built-in plugins and the in-process MCP server |
| `media/jobs.mjs` | 359 | Job queue, progress, cancellation, timeouts, artifact storage |
| `providers/local.mjs` | 344 | Ollama and OpenAI-compatible local providers |
| `providers/freellmapi.mjs` | 330 | The online gateway client: chat, images (JSON), video (raw binary) |
| `router/registry.mjs` | 322 | Model descriptors, capability matching, candidate scoring |
| `plugins/registry.mjs` | 510 | Install/enable/disable/uninstall, scope enforcement, preflight, invocation |
| `mcp/layer.mjs` | 502 | Servers, tools, risk tiers, approval gates, output neutralisation |
| `knowledge/pipeline.mjs` | 462 | Ingest, dedupe, chunk, index, search, grounded context, purge |
| `knowledge/store.mjs` | 387 | SQLite metadata, chunks, ACL rows, deletion records |
| `mcp/schema.mjs` | 246 | JSON Schema subset: validation of schemas *and* of arguments/output |
| `knowledge/bm25.mjs` | 224 | BM25 index (k1=1.5, b=0.75), rebuilt from stored chunks |
| `plugins/manifest.mjs` | 216 | Manifest validation, scope vocabulary, semver |
| `config.mjs` | 209 | Environment → config, secret loading, `publicConfig` redaction |
| `policy/egress.mjs` | 172 | The egress guard, runtime policies, data classes, global fetch hook |
| `server.mjs` | 151 | Entry point, startup banner, graceful shutdown |
| `knowledge/text.mjs` | 147 | Tokeniser, stemmer, sentence splitter, chunker |
| `media/validate.mjs` | 143 | Magic-byte sniffing, video genuineness check |
| `providers/base.mjs` | 143 | Provider contract, timeout and retry helpers |
| `policy/classify.mjs` | 137 | Secret and sensitivity classification, redaction |
| `audit/ledger.mjs` | 137 | Append-only SQLite ledger, query, NDJSON export, subject purge |

### `services/fabric` — 5,466 source lines, 3,135 test lines

Data validation → base selection → domain training → SFT → preference
optimization → distillation → evaluation → release, as a single reproducible
`Pipeline`. Plus the experiment ledger, the failure-memory recurrence, the model
release manager, and a hand-written dual encoder whose **five parameter gradients
all match central finite differences to ~3e-10**. See its own
[`README`](../services/fabric/README.md).

### `apps/web` — 3,486 source lines, 1,100 test lines

Five area components, a shell, shared primitives, an API client and three test
files. Design tokens and the shell's visual structure come from upstream Aetheris
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

Allowlists match **exact hosts** — no wildcards, no suffix matching. A blank or
invalid policy **fails safe to `strict_offline`** and records a warning; it never
fails open. `offline.test.mjs` proves the blocking with a recording `fetch` spy:
`api.openai.com`, `freellmapi.co`, `huggingface.co` and `api.anthropic.com` are
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
browser bundle. Seven endpoints were swept for `FREELLMAPI_API_KEY` leakage.

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
| Model weights | not stored by default | `output_dir` opts in; digests are recorded either way |

Absolute paths never reach the browser: `publicView` on media jobs omits them, and
the artifact route serves bytes by job id.

---

## 7. HTTP surface

31 literal routes plus segment-matched routes under `/api/tasks`, `/api/plugins`,
`/api/mcp`, `/api/media` and `/api/knowledge`. There is no `/api/routes`.

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
- **No vendored FreeLLMAPI.** Optional, external, separately versioned.
- **No speculative acceleration.** No quantum, neuromorphic, bare-metal, BCI or
  industrial-control features. Everything runs on 2 CPUs and 3.85 GB RAM with no
  GPU, which is the point: the first implementation must be portable and testable
  on conventional hardware.
- **No multi-agent fan-out.** The simplest workflow that meets the quality bar is
  preferred; added latency and cost need justification, and none was found.
- **No weights in the repository.** `.gitignore` excludes `*.gguf`,
  `*.safetensors` and `checkpoints/`.
