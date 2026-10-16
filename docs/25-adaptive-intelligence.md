# 25 — Klyvaron Adaptive Intelligence: audit, integration map and plan

This page is the record of a **change of direction**, and of what was found when the first phase of it
was done. It supersedes the parts of earlier pages that assumed a trained foundation model had to
exist before the product could.

## 1. What changed

The family's goal is now: **a usable, experience-driven AI system that remembers, plans, uses tools,
learns reusable skills, coordinates specialists, communicates with emotional intelligence and improves
through verified experience — with model training optional rather than prerequisite.**

Three consecutive pages of this documentation (`11`, `12`, `24`) describe tiers whose capabilities come
from *training this family's own models*. That requirement is **withdrawn for the product tiers**.
Lite, Pro and Max are now **capability profiles over one shared adaptive core**, chosen from what the
hardware, installed models, tools, permissions and services can actually do.

What is **not** withdrawn, and is carried forward verbatim:

* a mechanism is never presented as a capability;
* no fabricated artifact, no unmeasured number, no competitor claim;
* nothing here claims AGI, consciousness, sentience or human-equivalent feeling, and the system must
  never simulate attachment, guilt or dependence to keep a user;
* a card describes only the artifact it names;
* every phase produces working code, tests and a status report, and a phase is not complete until its
  acceptance tests pass.

This is **not** the composed path that `23` records as refused and `24` keeps as a checked
alternative. Routing a tier to an authorised provider is a routing decision about *whose model answers
this request*; it is not a claim that the answer came from a Klyvaron model. The composed path claimed
the latter, which is why it was refused, and that refusal stands.

The factual claims of `24` remain true and are not deleted: `klyvaron-pro-lm` and `klyvaron-max-lm`
have no weights, and no accelerated trainer backend exists in this repository. What changes is that
**their absence no longer blocks the product** — a tier is a routing profile, not a checkpoint.

The five user-facing areas are unchanged, because they were already exactly right: `apps/web/src/areas.js`
defines Chat, Image, Video, Plugins and MCP and nothing else, and `structure.test.mjs` asserts that.
Memory, emotions, skills, agents and training are internal services rendered inside those areas, never
a sixth navigation entry.

## 2. Phase 1 — Sparsiz inspected, at an exact commit

Repository: `github.com/rajaram-2005/sparsiz`, inspected at
**`76ec6f0f0f501ea9fbf99f0769ef224d3dbc0d69`** (branch `main`, 2026-09-28), working tree unmodified.
Its licence is the Unlicense (public domain), so reuse is unencumbered.

### 2.1 What was measured, not assumed

| Measured | Value |
|---|---|
| Python files / Rust files / C files | 176 / 26 / 3 |
| Python lines | 20,574 |
| Distinct Python lines | ~11,000 — most modules exist **twice**, byte-identically (`agi/agi_core.py` and `sparsiz/agi/agi_core.py` hash the same; checked for three sampled paths) |
| Test files | 4 (`test_faisanth`, `test_premsoth`, `test_rajaram`, `test_saram`), 206 lines total |
| Test result | **15 passed in 0.24 s** |
| Files mentioning placeholder / mock / simulate / hypothetical language | 109 of 202 |
| Directory names | `agi/`, `bci/`, `quantum/`, `neuromorphic/`, `superalignment/`, `world-model/`, `patent/`, `digital-twin/`, `scada/` |

### 2.2 What is real and worth reusing

Small, specific, and each one verified by reading it rather than by its name:

| Piece | File | Why it is real |
|---|---|---|
| Exact deduplication by content hash | `sparsiz/training/dataforge.py` (`DeduplicationEngine`) | A set of hashes; correct as written, no hidden randomness |
| Contamination check against an evaluation set | same file (`ContaminationDetector`) | Hash membership against supplied test hashes — the right shape for held-out evaluation |
| Topology matrix and Moore-Penrose pseudoinverse | `sparsiz/faisanth.py` (`YBus`) | Builds `Y = G + jB` from a graph, then calls `numpy.linalg.pinv` — genuine SVD, and its docstring refuses to overclaim: *"Do NOT claim automatic optimal route — this is research direction"* |
| Route as argmin over a weighted cost | `sparsiz/faisanth.py` (`Faisanth.route`) | Filters candidates by constraint, scores each, takes the minimum — deterministic and inspectable |
| A ten-node fixture graph | `sparsiz/faisanth.py` (`ComputeGraph.default_10_nodes`) | Usable as a routing fixture |

The `YBus` docstrings are the best thing in the repository: they state what the code does not do. That
standard is the one to carry across.

### 2.3 What must not be reused, and why

The directive asks for stubs, simulations, placeholders, untested code and unsupported claims to be
named rather than inherited. Named:

* **`validate_and_promote()` in `self-improvement/self_improvement.py` decides by coin flip.** It
  prints `Regression test … PREMSOTH verification … Red Team attacks`, then executes
  `passed = random.random() > 0.2`. A validation that succeeds 80% of the time regardless of the
  improvement is not a validation, and its printout is a claim of work that did not happen.
* **`benchmark_vs_baselines()` invents its baselines.** Under the comment `# Baselines simulated` it
  adds the constants `50.0`, `60.0`, `40.0` for round-robin, random and shortest-path. The reported
  `efficiency_vs_rr` is therefore a computed cost divided by an invented number.
* **`QualityEngine.score()` is a random draw in a weighted-sum costume.** Under
  `# Mock scoring — in production would use models, heuristics, source reputation`, all five quality
  terms are `random.uniform(...)` with two constant overrides keyed on substrings like `"code"` and
  `"arxiv"`. The arithmetic is real; its inputs are noise.
* **The memory fabric is in-process lists.** `memory/memory_fabric.py` stores entries in Python lists;
  `recall()` is substring matching with the comment `# Mock recall — in production use vector search`.
  There is no persistence, provenance, permission or version field, which §5 of the directive requires.
* **The tests assert non-emptiness, not correctness.** `assert len(graph.nodes) == 10`,
  `assert cost > 0`, `assert bench["efficiency_vs_rr"] > 0` — the last one passes precisely because the
  invented constants are positive. A suite like this cannot fail for a substantive reason, so it cannot
  certify anything.
* **The "skills" are declarations, not procedures.** `create_skill(...)` takes an id, a name, a field,
  prose capabilities and a safety level; `SkillRegistry._register_all_fields()` is roughly 200 lines of
  hardcoded catalogue entries. §6 of the directive defines a skill more strictly — executable or
  procedural, with inputs, outputs, permissions, dependencies, **tests** and limitations. The registry
  is a good *taxonomy* and a poor *skill system*, and it is not the one to build on.

None of this is a criticism of the repository's purpose: it is a design-and-roadmap repository, and a
roadmap is allowed to name destinations it has not reached. It becomes a problem only if a module is
inherited on the strength of its name, which is exactly what the directive forbids.

## 3. Integration map

Directive section → what already exists in this repository and passes its tests → what is missing.
"Exists" means there is a module **and** a test that fails when it breaks; anything else is listed as
missing.

| Directive | Exists here | Missing |
|---|---|---|
| §3 Adaptive core | `router/registry.mjs`, `klyvaron/{plan,execution,runtime}.mjs`, `knowledge/{bm25,pipeline,store}.mjs`, `policy/{classify,egress}.mjs` | Intent analysis, task decomposition, token-budget management, resumable task state, cost/latency measurement per route |
| §4 Emotional intelligence | `klyvaron/affect.mjs` + `affect.test.mjs` (181 / 104 lines) | The seven interaction states, user-facing controls, personality settings, the honesty constraints restated per state |
| §5 Memory fabric | `memory/store.mjs` + `memory.test.mjs` | The seven layers as distinct stores, provenance/confidence/scope/permission/version fields, user inspection and deletion, local encryption |
| §6 Experience & skills | `skills/{registry,manifest,lifecycle,store}.mjs` with promotion gates and version history; the fabric's failure-memory recurrence | The full OBSERVE→…→REUSE loop, skill *execution* with declared permissions, regression tests attached to a skill |
| §7 Verification & safety | `audit/ledger.mjs`, `policy/{classify,egress}.mjs`, `hardware/admission.mjs`, and the fabric's release gates | Per-task acceptance criteria, evidence tracking on a task, sandboxed execution, approval gates for high-impact actions |
| §8 Model & provider fabric | `providers/{base,klyvaron,local}.mjs`, `catalog/{registry,sources}.mjs`, `hardware/{detect,accelerators}.mjs`, `online/gateway.mjs` | A capability-based registry (modality, context, cost, privacy), routing by those fields, Ollama / llama.cpp / OpenVINO adapters |
| §9 Image & video | `media/{jobs,validate}.mjs` + `media.test.mjs`; the two areas exist in the UI | Real generation adapters and quality evaluation |
| §10 Plugins & MCP | `plugins/{manifest,registry,signing}.mjs`, `mcp/{layer,schema}.mjs`, with tests | Tool-output validation as untrusted input, approval gates, audit of tool calls |
| §11 Sparsiz | — | This section of the document |
| §12 Industry packs | `catalog/registry.mjs`, `knowledge/*` | Domain packs with their own sources, validation and evaluations |
| §13 Privacy, offline, resilience | `policy/egress.mjs`, `offline.test.mjs`, `storage/budget.mjs` | Task-level checkpoints and resume; explicit LOCAL/OFFLINE/ONLINE/HYBRID mode gating |

The honest headline: **the plumbing is largely present and tested; the loops through it are not.**
There is a skill registry with promotion gates but no loop that turns an experience into a skill; a
memory store but no provenance model; an affect module but no interaction states; a router registry but
no routing decision that considers cost, privacy and modality.

## 4. Backlog and acceptance criteria

Ordered as the directive orders them. Each item names the test that will prove it, because a phase
without a failing-then-passing test is not done.

**Phase 2 — adaptive router and one end-to-end task (the first milestone).** Ship a single command that:
routes one real task, executes it, verifies it independently, records the lesson with provenance,
turns the procedure into a versioned skill with its own test, reuses that skill on a second similar
task, and measures the difference; and whose wording adapts to an interaction state without changing
its honesty constraints. Acceptance: a test that runs the whole loop, asserts the second run used the
stored skill (not the original path), asserts the recorded measurement, and asserts that a *failing*
task is recorded as failed rather than promoted.

**Phase 3 — memory with provenance and permissions.** The seven layers, each entry carrying
provenance, timestamp, confidence, scope, permissions and version; contradiction and duplicate
handling; inspect/correct/delete. Acceptance: a test that stores a user claim and a verified fact,
retrieves both, and asserts the two are distinguishable and that deleting one removes its provenance.

**Phase 4 — versioned skills with evaluation and regression.**
OBSERVE→RECORD→EVALUATE→DIAGNOSE→PROPOSE→TEST→APPROVE→VERSION→REUSE with rollback. Acceptance: a
candidate improvement that fails its regression test is **rejected and retained**, and the rejection is
in the record; a skill's declared permissions are enforced by the executor.

**Phase 5 — emotional interaction states and controls.** The seven states, estimated from context,
treating estimates as uncertain and correctable; personality settings; a switch that disables
adaptation. Acceptance: the same input under two states produces different wording and identical
factual content; no state ever emits an unverified claim, a feeling claim, or a dependency appeal.

**Phase 6 — providers.** Capability registry and adapters. Acceptance: routing refuses a request the
available capabilities cannot serve rather than degrading silently; offline mode makes no network call
(already tested for the existing path).

**Phase 7 — plugins and MCP safeguards.** Acceptance: a tool output containing an instruction that
conflicts with policy is treated as data, not obeyed.

**Phase 8 — image and video workflows.** **Phase 9 — industry packs.** **Phase 10 — benchmark, harden,
document, release.**

## 5. Durability, and the run that is not running

Two facts learned the hard way, recorded so they are not re-learned:

1. **Only what is committed to Git survives.** The workspace was restarted mid-session: `artifacts/`,
   the assembled 167.94 MB corpus, the Python dependencies and an eighteen-hour training run with its
   checkpoints were all gone, while every file committed and pushed was intact — the branch, the pull
   request and its green CI. This is the second time in this project that an uncommitted artifact was
   lost. The consequence for this architecture is direct: memory, skills and task state must live in
   version-controlled, inspectable storage, which is what §5 and §6 ask for anyway.
2. **A CPU run measured in hours cannot be the critical path on a box that resets without warning.**
   `klyvaron-mini-lm@0.2.0` — a 4,264,448-parameter byte-BPE model, sized from measured step rate
   (4.467 s/step), a measured learning-rate probe and a measured evaluation cost — was killed at step
   ~600 of 13,900 and its record is kept at `docs/experiments/klyvaron-mini-lm-0.2.0-run.json`. **It is
   parked, not abandoned**: the directive makes training optional, and an eighteen-hour run would hold
   both cores for the whole of Phases 1–4. The single command to restart it is in that record, and the
   run's design is unchanged.

Setup after a restart is one line, and is deliberately recorded here rather than remembered:

```
python3 -m pip install --user --break-system-packages numpy==2.4.6 pytest==9.1.1
```

## 6. What this page does not claim

It does not claim that any adaptive capability works. It claims that the direction changed, that
Sparsiz was inspected at a named commit and is mostly a roadmap rather than an implementation, that
five small pieces of it are reusable and the rest must not be inherited, that most of the plumbing
this architecture needs already exists here with tests, and that the loops through that plumbing are
the work — with the first of them defined precisely enough to be built and tested next.
