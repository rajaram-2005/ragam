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

**Phase 2 — adaptive router and one end-to-end task (the first milestone).** ✅ **Met, 2026-10-16.**
`services/core/test/adaptive-loop.test.mjs` — 16 tests, all passing, one of which is the milestone
itself ("the milestone: a verified run becomes a tested skill, and the second task reuses it"). The
loop lives in `services/core/src/adaptive/`: `capability.mjs`, `router.mjs`, `executors.mjs`,
`verify.mjs`, `episodes.mjs`, `wording.mjs`, `loop.mjs`.

What the milestone test actually runs, in order: a 12-file/3.6 MB tree is counted with the
*materialising* baseline; the result is verified by recomputing with the *streaming* implementation
and against sampled `wc -l` output; the episode is recorded as a success with both methods named;
the procedure is proposed as a skill in `candidate` state; four checks run against it (agreement
with the baseline on a fixture tree, an empty file, a file with no trailing newline, and a path
outside its declared read scope being refused); every check passing is what promotion requires; the
skill is then offered as a third candidate for a *second, similar but different* tree, along with
the baseline that ran the first task.

Three things the loop refuses to do, each with a test:

| Refusal | Code | Why it is load-bearing |
|---|---|---|
| Assert an outcome | `classifyOutcome` computes it from route, execution, verification and acceptance | An outcome a caller can assert is an outcome a caller can inflate; success is `execution.ok && verification.agree && acceptance passed` |
| Propose a skill from anything but a verified success | `not_a_verified_success`, `unverified` | A procedure extracted from an unverified run encodes whatever went wrong |
| Promote a skill whose checks did not all pass | `validation_failed`, `not_loadable` | No version exists until every recorded check passed |

The verification independence rule needed correcting mid-build, and the correction is the interesting
part: independence must be compared on an `implementation` tag, not on a route id. The first version
required a *routable* second candidate, which made the milestone impossible in the very case it was
written for — a tree with exactly one route and one implementation behind it — and it would also have
accepted two routes that are the same code wearing different names (a tool and the skill wrapped
around it) as mutual verification. Now `verifyWith` may name implementations that are not routable,
and a verifier sharing the route's implementation is refused with the reason
*"every available verifier runs the same implementation as the route under test, so it could only
agree with itself"*. The same rule drives the second half of the milestone: the skill *wraps* the
streaming implementation, so it is checked against the baseline, not against itself.

**Measured, and where the measurement disagreed with the plan.** The milestone's premise is that the
stored procedure is the cheaper route on the second task. On the test's tree it is — but running the
same loop on a differently shaped tree (~180 files of ~200 lines each) showed the *baseline* winning
5.0 ms to 6.1 ms, and the router chose the baseline. That is the system working, and it is also the
system's own record disagreeing with its own story, so the comparison was measured properly at
constant total bytes (3.5 MB) with the measurement method fixed first (`measure()` now interleaves
candidates round by round instead of measuring one candidate to completion before starting the next,
which handed the second candidate a warmer page cache):

| Bytes per file | Files | Materialising | Streaming | Result |
|---|---|---|---|---|
| 8 KB | 450 | 10.06 ms | 17.94 ms | baseline 1.8x faster |
| **32 KB** | 113 | 4.17 ms | 4.15 ms | **crossover** |
| 128 KB | 28 | 4.52 ms | 2.79 ms | streaming 1.62x faster |
| 300 KB | 12 | 4.18 ms | 2.70 ms | streaming 1.55x faster |
| 1 MB | 4 | 5.03 ms | 2.94 ms | streaming 1.71x faster |
| 4 MB | 1 | 5.01 ms | 2.75 ms | streaming 1.82x faster |

Both figures are medians of seven interleaved runs on this box (2 cores, 3,939 MB). The consequence
is recorded on the skill itself rather than in a note: the stored procedure declares its crossover as
a limitation, `proposeSkill` refuses to describe an improvement its own measurement contradicts (the
proposal carries the sentence *"the stored procedure is NOT the cheaper route here, and the router
will not prefer it on this shape"* or the opposite one, whichever the numbers say), and the router
re-measures per input, so the choice is made on evidence each time and not on what was true once.
A second, unrelated defect surfaced at the same time: the default in-memory episode log accepted
appends while `list()` returned nothing — `count` grew, `verify()` called an empty log intact, and
`successes()` reported none about a session that had recorded some. It now reads back what it stored.

Wording is audited at render time, not at review time: seven interaction states share one verbatim
facts block (`renderFacts` is the only place a number is formatted), `renderOutcome` throws
`forbidden_wording` on a claim of feeling, consciousness, dependency, possessiveness, guilt,
fabricated emotional history or unsupported praise, and throws `unverified_not_disclosed` on a
non-boolean claim of verification — `verified: 'probably'` is truthy in JavaScript and would have
rendered as *"Verified: yes - undefined"*. Personality settings report which of them changed the text
and which are recorded but have no effect yet (`warmth`, `formality`, `voiceExpression`), because a
setting the user cannot perceive should not look like one the system is applying quietly. That audit
caught the page's own author first: the `reflective` closing line said *"keep the diagnosis beside
the result"*, and the guard refused it — the word is scanned for diagnosis of the *person*, so the
sentence was rewritten rather than the rule weakened.

**Not claimed.** One narrow capability (counting newline bytes across a tree) routed, verified,
learned, versioned, reused and measured — not general task competence, and not any of Phases 3-10.

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

It claims exactly one capability, demonstrated end to end in §4 and nothing beyond it: counting
newline bytes across a tree — routed on measurement, verified by a second implementation, learned as
a versioned skill, reused on a second tree, and measured. The measurement includes the run that
contradicted the plan: on a differently shaped tree the stored procedure lost to the baseline and the
router chose the baseline, which is reported here rather than smoothed over.

It does not claim general task competence. It does not claim that any adaptive capability beyond that
one works, or that Phases 3-10 are built. Timing here is timing on this box (2 cores, 3,939 MB), at
the sample counts stated beside each figure — not a property of another machine. And the rule this
page states rather than claims: no phase is complete before its acceptance tests pass, which is why
§4 describes Phase 2 by what its test runs and refuses to describe the phases that have none.

What it does claim: the direction changed; Sparsiz was inspected at a named commit and is mostly a
roadmap rather than an implementation; five small pieces of it are reusable and the rest must not be
inherited; most of the plumbing this architecture needs already exists here with tests; and the loops
through that plumbing are the work — the first of them now built, tested and measured.
