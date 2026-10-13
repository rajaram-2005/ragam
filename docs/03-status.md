# 03 — Implementation status

Every claim below is tied to a test, a measurement or a named limitation. Where
something does not work, it says so and says why.

**Host used for all of this work:** 2 CPUs · 3.85 GB RAM · **no GPU** ·
Node v22.22.3 (`node:sqlite` verified) · Python 3.11.2 · NumPy 2.1.3 ·
pytest 9.1.1. Reachable: `github.com`, `codeload.github.com`, `api.github.com`,
`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`. **Unreachable:
`download.pytorch.org`, `huggingface.co`.**

**Test totals: 1075 passing, 0 failing.**

| Suite | Command | Result |
|---|---|---|
| `services/core` | `node --test test/*.test.mjs` | **446 / 446** (20 files, ~50 s) |
| `services/fabric` | `pytest -q` | **562 / 562** (25 files, ~21 s) |
| `apps/web` | `node --test test/*.test.mjs` | **67 / 67** (4 files, ~1 s) |
| `apps/web` build | `vite build` | 242.71 kB → **71.78 kB gzip**, single chunk, no warnings |

All three suites run in CI on every push and pull request
([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)), as four jobs split so a
failure names the component that broke. The CI run also asserts two properties that
are easy to lose silently: that `services/core` still declares **zero** npm
dependencies, and that the Fabric release gate refuses an undertrained model rather
than merely accepting a trained one.

No test was removed or relaxed to obtain this. Two existing assertions in
`services/core/test/http.test.mjs` were rewritten when built-in plugins arrived —
they had counted absolute registry size, and now assert about the plugin the test
installed *and* separately verify the built-ins are present, enabled and bound.
That is a stronger claim than the count it replaced.

---

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
| 3 | Unified app, five areas | **Complete** | `apps/web`; 67 tests including "exactly five areas", "no internal service is a navigation entry", server-rendered markup for all five areas, and a guard against the re-export bug class |
| 4 | Local inference with ≥1 real local LM | **Partially met** | A real local LM now runs here end to end: the from-scratch 359,136-parameter model is exported as a versioned artifact, loaded by the core in plain JavaScript, and served through the normal provider path — with its logits checked against NumPy on identical bytes (`klyvaron-runtime.test.mjs` 9, `klyvaron-store.test.mjs` 8, `klyvaron-app.test.mjs` 6 — 23 tests). A full-size artifact was trained, verified, installed into the model library and served over HTTP from the store (1.4 MB, 359,520 parameters; `docs/experiments/lm-verification-run-67cdd58.json`), so the path from a training run to a served local model is demonstrated rather than only unit-tested. What is still unmet is a local **assistant**: the artifact is a base completion model, `/api/chat` refuses it unless the user pins it by id (`model_not_instruction_tuned`, 501, with the model's own limitations attached), and the Ollama/llama.cpp adapters remain proven only against a loopback fixture ("Phase 4 in detail", below) |
| 5 | Online provider integration | **Not met — removed by decision** | No external provider is configured, vendored or bundled. Image and video requests are refused with an explicit limitation, and the UI states that no provider exists rather than implying one can be enabled with a key |
| 6 | Secure private memory | **Complete** | Knowledge pipeline + ACL + retention + audit; 40+ tests |
| 7 | Tool / agent execution | **Complete** | Plugin and MCP permission enforcement; God Core lifecycle |
| 8 | Multimodal pipelines | **Complete** | Job queue, validation, video genuineness check |
| — | Procedural skills (meta-learning L3) | **Partial** | Documents on disk with append-only history, evidence-gated promotion, rollback, deletion tombstones and lexical relevance matching — reachable over 12 routes and from a panel inside Chat. Nothing loads a procedure automatically when a task needs it, and no proposal is captured from a failure without being asked |
| 9 | Sparsiz integration | **Complete** | Responsibility defined; taxonomies and `Q(x)` adopted, scoring replaced |
| — | Klyvaron artifact format, runtime and model library | **Complete** | `klyvaron/format.mjs` (manifest + digest verification, a ZIP/`.npy` reader in the core), `klyvaron/runtime.mjs` (the forward pass in JavaScript, parity-checked against NumPy), `klyvaron/store.mjs` (install/verify/load/remove inside the storage budget), `providers/klyvaron.mjs` and `scripts/export_lm.py`; a committed parity fixture ties the two implementations together |
| — | On-device storage accounting | **Complete** | `storage/budget.mjs` plus `klyvaron/footprint.mjs`; `/api/storage` reports measured bytes, verification results and headroom |
| 10 | Aetheris Lite experiments | **Partial** | Two real first-party models: the trained retriever, and a from-scratch **359,136-parameter character-level LM** trained in pure NumPy with hand-derived, finite-difference-verified gradients. SFT and preference optimization remain unimplemented for want of data and compute, and are not simulated |
| 11 | Competitive benchmark cycle | **Partial** | Real, reproducible BM25 comparison; **no** Mistral/Qwen/Llama/Gemma/DeepSeek comparison possible. Aetheris Lite is evaluated against computed uniform/unigram/bigram baselines on identical held-out tokens — never against a pretrained model, because none could be obtained |
| — | Sparsiz improvement cycle on a real failure | **Complete** | [`07-improvement-cycle.md`](./07-improvement-cycle.md): rejected run diagnosed, hypothesis tested, regression cases promoted; the accepted `mrr` gain **did not replicate** across seeds and is recorded as such; 66 tests |
| — | Selection-protocol correction | **Complete** | [`06-benchmarks.md`](./06-benchmarks.md) §5.3: base selection ran on the evaluation split; now runs on a training-side validation split. Released artifact unchanged (`weightsDigest db3366ea…`) |
| — | Robustness measurement | **Complete** | `scripts/robustness.py`: seed, training-size and paired axes. The released `mrr` is one seed of six (spread 0.103) and ranks 4th of 6 |
| 12 | Release readiness docs | **Complete** | This document plus 04, 05, 06 and the model card |
| — | From-scratch language model | **Complete** | [`08-aetheris-lite.md`](./08-aetheris-lite.md): character-level transformer, 98 new tests including every gradient against a finite difference. Found and fixed a real positional-gradient bug the numeric check reported as `pos: exceeds tolerance by 1.6e-01` |
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

## 3. Acceptance criteria

| Criterion | Status | Evidence |
|---|---|---|
| Five areas work in one app | **Met** | `apps/web`; `structure.test.mjs` fails if a sixth appears |
| Local chat inference with an actually installed model | **Not met — requires weights** | Adapter tested against a real loopback server; no LM installed here. Reported as `degraded`, never faked |
| Strict offline mode verifiably blocks network | **Met** | Recording-`fetch` spy: 4 external hosts rejected, call log empty, no socket, no DNS. Guard also installed over `globalThis.fetch` |
| Hybrid sends only authorized requests externally | **Met** | Exact-host allowlist + classification ceiling; `confidential`/`restricted` need explicit authorization |
| An external provider, when one is configured, uses supported endpoints and handles provider failure | **Not applicable — no external provider is configured** | The provider adapter was removed with the rest of the external integration. The router still supports `online` descriptors, so the gate this criterion describes would be re-established by a new adapter rather than assumed |
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

### `services/core` — Implemented and tested (446 tests)

| Subsystem | Status | Notes |
|---|---|---|
| Egress policy & guard | **Implemented and tested** | Three policies; fails safe to `strict_offline` on a blank/invalid value |
| Data classification & redaction | **Implemented and tested** | Whole-identifier patterns catch `AWS_SECRET_ACCESS_KEY`-style names |
| Audit ledger | **Implemented and tested** | Append-only SQLite; refusals audited; NDJSON export; subject purge |
| Model registry & router | **Implemented and tested** | Capability gating before scoring; unknown latency scores 0.5, not 0 |
| Ollama / llama.cpp providers | **Implemented and tested against a fixture server** | Real protocol handling; no real LM installed here |
| Knowledge pipeline | **Implemented and tested** | SQLite + filesystem + in-memory rebuildable BM25 |
| Media queue & validation | **Implemented and tested** | Progress, cancellation, timeouts, retry-after, state history |
| Plugin registry & manifests | **Implemented and tested** | Preflight vs invoke distinction; uninstall keeps a record |
| MCP layer & schema validator | **Implemented and tested** | Risk tiers, approval gates, output neutralisation, per-tool timeouts |
| God Core lifecycle | **Implemented and tested** | Eight phases, budgets, retries, checkpoints, verification |
| Built-in plugins & MCP server | **Implemented and tested** | 18 tests; see §5 |
| HTTP layer | **Implemented and tested** | 31 literal routes + segment routes; accurate error statuses |
| Local image generation | **Not implemented** | Refuses with `not_implemented` (501) and an audited refusal |
| Local video generation | **Not implemented** | Refuses with `needs_hardware` (501); **never substitutes a still image** |

### `services/fabric` — Implemented and tested (562 tests)

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
was then run a second time, end to end, on the tree at `67cdd58`: 2,005 s of training,
a corpus manifest of its own, a model of 359,520 parameters instead of 359,136, and a
gate verdict of **RELEASED** (perplexity 5.3585 against the bigram's 16.7151, 0 hard
failures). Its perplexity is not comparable with the release's — the same token budget
went into a corpus about 1.8× larger — and it is not reported as an improvement. That
artifact was then installed into a core data directory through `KlyvaronStore.install`,
loaded by the app, and served over HTTP: `/api/ready` reports `textCompletion: true`
and `chat: false`, an unpinned `/api/chat` is refused with `model_not_instruction_tuned`
(501), a pinned one returns a labelled continuation, and the streaming path emits
`route`/`delta`/`done` events. Python and JavaScript produce the same greedy text from
the same bytes (max logit difference 8.2e-06). Record:
[`experiments/lm-verification-run-67cdd58.json`](./experiments/lm-verification-run-67cdd58.json).
And the model emits mush at this size — 359,136 parameters is enough to beat every
baseline it was measured against and not enough to hold a conversation.

### `apps/web` — Implemented and tested (67 tests)

| Area | Status |
|---|---|
| Chat | **Implemented and tested** — streaming SSE, routing panel, knowledge ingest/search/citations, task lifecycle |
| Image | **Implemented** — job queue, validation display; generation refuses on this host |
| Video | **Implemented** — as above, plus the genuineness rule |
| Plugins | **Implemented and tested** — manifest validation, install, preflight, invoke, approvals |
| MCP | **Implemented and tested** — servers, tools, risk gates, elevated-scope approvals |

**Rendering is covered** by `test/render.test.mjs` (18 tests), added after an
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
an input; and that MCP's empty state does not invent servers or tools.

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
2. **Decide whether to add an external provider at all** (Phase 5). The online
   integration was removed rather than configured: there is no provider, no
   credential and no allowlisted gateway in this build. Adding one back is a new
   decision with its own adapter, credential handling and classification gate —
   not a configuration change. Until that decision is taken, image and video
   requests are refused with an explicit limitation, and the readiness view reports
   those capabilities as unavailable.
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
7. **Connect a verified procedure to a running task** (L3). Skills are stored, verified,
   served and visible, but the step that loads the relevant one while a task runs, and the
   step that proposes one from a failure without being asked, are not implemented. Until
   they are, a procedure is something a person loads deliberately, and the release notes
   say so rather than implying the assistant teaches itself.
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
