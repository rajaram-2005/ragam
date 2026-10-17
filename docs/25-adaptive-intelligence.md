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

**Phase 2, second half — the rest of the adaptive core.** ✅ **Built, 2026-10-16.** The milestone above
covered routing, verification, measurement and the skill cycle. The directive's Phase 2 also names
intent, planning, a capability registry, context/token budgets, timeouts, checkpoints and resumable
tasks; those are `intent.mjs`, `plan.mjs`, `registry.mjs`, `budget.mjs`, `checkpoint.mjs` and
`runner.mjs`, with `adaptive-intent.test.mjs` (19 tests) and `adaptive-runtime.test.mjs` (18).

What was checked before building any of it, because this repository already had a lifecycle claiming
budgets, checkpoints and pause/resume:
`godcore/lifecycle.mjs` is real and tested — eight phases, budgets that a custom handler cannot
bypass, bounded retries, a cancellation signal, an approval gate — and **its checkpoints are in-memory
labels**: `#checkpoint` sets `task.checkpoint` and emits an event; nothing is written, and "resume" is
calling `run()` again on the same live object. That is genuine pause/resume within one process and it
does not survive a restart, which is the case the directive names. So the durable half is new work and
the vocabulary was reused rather than duplicated (`maxSteps`, `maxCalls`, `maxWallMs`, the distinction
between `observed` and `planned_only` evidence).

| Piece | What it does, and the decision inside it |
|---|---|
| `intent.mjs` | Reads capability requirements from a request, and cites the phrase for each. An unmatched request produces a **question**, not a default — there is no general-purpose route here to fall back to, so a default would be a route to nothing. Emotional signals are read and used for nothing: the interaction state may change how an answer is worded, never which capability is required. |
| `registry.mjs` | Which implementations exist for a tag, and which tags a plan needs that nothing provides. One id with two meanings is refused (`duplicate_id`); a re-registration of the same interface is idempotent. It does not test that an implementation works — that is verification's job, and a registry claiming otherwise would report an intent as a fact. |
| `plan.mjs` | Dependencies ordered, cycles and unknown dependencies refused, a digest over the plan. Two deliberate differences from GodCore's planner: a plan longer than the budget is **refused, not truncated** (`plan_too_long`) because a truncated plan drops required work while the run still reports success; and a step whose capability is not installed is refused by name (`capability_unavailable`, *"this is a missing capability, not a failed task"*) unless the step is optional, in which case it stays in the plan marked optional. |
| `budget.mjs` | Steps, calls, wall time and tokens. The gate is `assertCanStart`: a step whose **measured** cost on this input does not fit what is left is refused before it starts. A charge with no token count is recorded as *unreported* rather than as zero, so `tokensExact: false` and `remainingTokensAtMost` — a limit backed by a guess is not a limit. |
| `checkpoint.mjs` | Atomic writes (temp then rename), a digest chain, newest-intact-read, and `resume()` refusing a plan that is not the checkpointed one (`checkpoint_mismatch`). A `.tmp` left by a crash is skipped and reported rather than parsed as a shorter run; a tampered record is *readable* and reported, because the edit is the finding. Nothing is deleted. |
| `runner.mjs` | A plan executed step by step: route, gate, run, verify against a second implementation, charge, checkpoint. Resumable: only steps recorded complete **and verified** are inherited, and the result names `replayed`, `skipped` and `resumedFrom`. |

**The bug the resume test found.** The first version of `resume()` handed the resumed attempt the
*remaining* budget as its new *limit* — which looks equivalent and is not: the resumed attempt then
charged nothing for what the first attempt had already spent, and a run that had used its whole
allowance refused to start anything at all. The fix is carry-over accounting: a resumed attempt runs
on the run's **original limits** with the earlier spend carried into them, so a run has one budget
rather than one per attempt. Giving a stuck run more room is still possible, it is now an explicit
choice, and the result says which happened (`limitsReplaced`).

**Timeouts, stated for what they are.** A synchronous call cannot be interrupted from JavaScript, so a
`Promise.race` around one would report "timed out" while the function kept running — a claim about the
past the runtime does not support. The runner therefore gates synchronous steps before they start, and
reports an overrun after (`overDeadline: true`, and the run stops being a clean success). For work that
*can* be awaited, `runWithinDeadline` races it and, when the deadline wins, reports `abandoned: true`
with the note that the underlying work was not interrupted and may still be running. The test asserts
the abandoned promise really did finish, so the note is a fact rather than a figure of speech.

**Not claimed.** The runner drives synchronous steps: an executor that returns a promise is refused with
a message saying so rather than compared as an object. Nothing in the product surface calls the runner
yet — it is exercised by tests, not by a route. And the demonstration is still one capability wide.

**Phase 3 — the memory fabric with provenance and permissions.** ✅ **Built, 2026-10-16.**
`services/core/src/memory/fabric.mjs` and `memory/bridge.mjs`, with `memory-fabric.test.mjs` (18 tests)
and `memory-bridge.test.mjs` (7). The acceptance criterion written into this page in Phase 1 — *store a
user claim and a verified fact, retrieve both, assert the two are distinguishable, and assert that
deleting one removes its provenance* — is the third test in the fabric suite, met directly.

What was checked before writing it, because `memory/store.mjs` already existed: the store is the
*product* memory — what a user asked Aetheris to remember — and it is disciplined in the right places
(`approved_by` is a CHECK that only accepts `'user'`, `training_use` is a CHECK that only accepts
`'prohibited'`, deletion removes the row and its index entries and writes a tombstone). What it does
**not** have is any difference between *a user said so* and *an independent check confirmed it*: it has
`kind = 'fact'` and `approved_by = 'user'`, which is a statement about permission, and a reader who
takes those two columns for verification has turned a sentence into a fact. So the fabric is built
around that difference and the store is left alone, with a bridge between them.

| Rule | How it is enforced |
|---|---|
| A user statement is not a fact | Two separate records on every entry: `assertion` (who said it, and how) and `verification` (whether an independent check confirmed it, naming the check). A claim's `confidence.value` is **null** with basis `user-stated` and the record says in words that it records the saying and not the truth |
| Evidence must be independent | A `check` provenance row is the only thing that verifies, it must have `agreed: true`, and it may not come from the source that asserted the entry (`self_verification`) — the same independence rule the loop applies to routes |
| Provenance is required | An entry with no provenance row is refused (`missing_provenance`), and provenance is rows in its own table, not a string field |
| Nothing is silently overwritten | A correction appends a version and supersedes the old one, which stays readable; `history()` walks the chain from either end; replacing a verified entry with a claim is refused (`would_downgrade`) unless forced with a reason |
| Contradictions are kept | Two live entries that disagree about one subject and predicate are both retrievable, each marked `contradicts`, and `conflicts()` lists the groups. Resolving requires a reason and supersedes rather than deletes |
| Duplicates collapse | The same content, layer and scope from a second source is one belief held twice: `seenCount` rises and the provenance gains a row |
| Confidence is never a bare number | Every value has a basis; `inferred` must name the entries it came from and those entries must exist; `measured` needs a measured provenance row; a claim may not carry a number at all (`no_truth_estimate_for_claim`) |
| Scope and readers are enforced on read | Scope is applied over candidate rows rather than in SQL, so `allowScopes` can widen a query and every exclusion is reported with its reason. `denied` means *matched the request but was withheld* — an entry from another layer was never in the question, and keeping those apart stops a denial list reading as "the system is hiding things" |
| Deletion takes the provenance | `forget()` deletes the entry and its provenance rows, clears the bookkeeping links, and writes a tombstone holding the id, layer, time, actor, reason and the number of provenance rows removed — and no subject, content or value. A test searches the tombstone table for the deleted text and subject and finds neither |
| References, not copies | The skill, episodic and failure layers point at the skill registry and the episode log and refuse a dangling pointer (`unknown_reference`); with no checker configured the pointer is stored marked `unchecked` rather than assumed good |

**The bridge, and why it goes one way only.** An approved memory enters the fabric as a **claim** whose
provenance records the approval, the store's own label and a note that approval is permission rather
than verification — never as a verified fact, whatever `kind` the store row carries. In the other
direction an entry becomes a **candidate** in the store, pending, for a person to approve; the bridge
has no path that approves anything, which is also what the store's schema enforces. The bridge's status
view reports the gap — approved memories the fabric has not yet recorded — and a test pins the
consequence of two different deletion semantics: deleting a memory in the store does not reach into the
fabric, so the fabric offers its own deletion rather than a bridge that reports a deletion it did not do.

**Not claimed.** Nothing in the product surface reads the fabric: it is exercised by tests, and the
store remains the only memory a prompt can see. The layers are a schema and a set of rules, not a
retrieval model — there is no ranking over them beyond SQL ordering, and no embedding of any kind.

**Phase 5 — emotional interaction states and controls.** ✅ **Built, 2026-10-16.**
`src/adaptive/wording.mjs` grows from a renderer into the layer the directive describes, plus a
consumer in the loop (`AdaptiveLoop.explain`), exercised by `test/emotional-states.test.mjs` (16
tests). Both acceptance criteria written into this page in Phase 1 are tests:
`acceptance: two states produce different wording and byte-identical facts` and
`acceptance: no state emits an unverified result without saying it is unverified`.

What was already here from Phase 2, and what changed. The seven states, the phrase families they
are estimated from, the shared facts renderer and the forbidden-sentence guard existed and were
tested. What they did not have was the rest of the directive's constraints, each of which turned
out to be a rule that could be broken by code:

| Constraint | What it now means in code |
|---|---|
| Estimates are uncertain and correctable | Every estimate carries `uncertain: true`, the phrases that produced it, the other families that *also* matched as `alternatives`, and a `disclosure` sentence a surface can show: *"Tone: supportive, guessed from your message (phrase the user typed: …). It changes wording only, not the result."* No confidence number is produced — one phrase is one phrase, and a percentage would be precision this method cannot have |
| Corrections persist, and can be withdrawn | `ToneCorrectionLog` — a reloadable store the estimator reads. `storePreferences: false` means the correction applies to the reply and is never written down, and the refusal says which of the two happened rather than assuming "noted". `forget()` deletes a correction outright; this file is deliberately *not* append-only, because it holds user data and the append-only record of which tone was used is the audit ledger |
| Sensitive material is never a signal | `SENSITIVE_SIGNAL_TERMS` (36 terms, deliberately broad). A message containing any of them is not read for tone at all, and the record stores an **offset**, not the phrase — a test asserts the serialised estimate contains neither the term nor the sentence around it. A dull answer is the cheap side of that trade |
| No fabricated emotional history | `HISTORY_CLAIM_PATTERNS` refuse any sentence about the user over time unless it cites signals read with `klyvaron/affect.mjs` and consented to by the user. The citation check runs at *render* time, on the composed text, so composing outside the renderer does not bypass it — and the citation source is the module that already refuses to read without consent and stamps every signal with its message id |
| No feelings, consciousness, sadness, jealousy, possessiveness, guilt or dependency | The forbidden list gained simulated sadness (including the conditional "I'd be sad if you left"), simulated worry, claimed subjective experience, possessiveness in the present tense, an attachment claim ("I care about you", "I love working with you"), and a guilt variant. Each carries the reason it exists, because a refusal that explains itself is the difference between a guard and a mystery |
| Settings a user owns | `assertPersonality` refuses an unknown key and an unknown value instead of merging it away. The bug this fixed is worth naming: `adaptTone: 'off'` was truthy, so a user asking to switch tone adaptation **off** was switched on. Warmth and formality now change the message — one sentence about the *message*, never about the result — and the only setting still recorded without an effect says so (`noEffectYet`) |
| Safety outranks every setting | A safety-critical task forces `cautious` and humour stays off, whatever the user asked for |

**The bug the tests found in the tests' own expectation, and one in the code.** An episode whose
outcome is `failed` was rendered under the opener *"Task complete."* — the facts block said
`Outcome: failed` underneath a heading that contradicted it, and the heading is the line people
read. Failures now get their own openers and an `outcome_not_disclosed` guard that refuses any
rendering where the text does not say the run failed. Separately, `alternatives` came back empty
because the caller's `extra` object was spread *last* and overwrote the computed list, which made
every estimate look more certain than it was.

**Not claimed.** The layer is not in the product surface: `AdaptiveLoop.explain` is its only
consumer, and the Chat panel renders its own text. There is no voice output (the setting is
recorded, listed as having no effect, and unused), no model is involved in any of this — the
estimate is a phrase lookup with a stated tie-break and a documented refusal to guess — and the
seven states are a wording setting, not a model of anybody's inner life.

**Phase 4 — versioned skills with evaluation, regression and declared permissions.** ✅ **Built,
2026-10-16.** `services/core/src/skills/evaluation.mjs` and `skills/permissions.mjs`, with
`test/skills-evaluation.test.mjs` (13 tests). Both acceptance criteria written into this page in
Phase 1 are met as tests, not as prose; the loop (Phase 2) gained an EVALUATE stage and lost the
ability to promote anything it has not evaluated.

**The rule that carries the weight: a check that passed for the incumbent version must still pass,
and it must still be run.** A suite written fresh for each candidate proves the candidate does what
its author just tested and says nothing about what the previous version did, which is the entire risk
of an improvement. Three ways that rule breaks, each with its own diagnosis rather than one
undifferentiated "rejected":

| Diagnosis | What happened | Why it is not a pass |
|---|---|---|
| `regression` | a check that passed for the incumbent now fails | the improvement broke something it was supposed to leave alone |
| `regression_not_run` | a check that passed for the incumbent is missing from the candidate's suite | a suite that dropped a test cannot fail it; every check that *did* run passed, and that is exactly the trap |
| `new_failure` | a check the candidate introduced fails | the new behaviour does not do what it claims |

The verdict log is append-only and digest-chained, like the episode log, and for the same reason: a
rejection that can be edited away is not a record. A rejected version **stays in the registry** — its
document is still retrievable, it is still a candidate, and the rejection survives later acceptances.
`promote()` now refuses a version with no accepted evaluation (`not_evaluated`) and refuses one whose
accepted evaluation ran a *different* check list (`evaluation_mismatch`): approval follows evaluation,
and a pass on one set of checks is not a pass on another.

**Permissions are part of the artifact.** A `SKILL.md` declares `fsRead`, `fsWrite` and `network`, and
that declaration — not the caller's intentions — is the scope the procedure runs with. Two failures
the module exists to prevent: a declaration nothing reads, and a runtime that chooses the scope, where
a procedure written to read one directory is handed the filesystem by whoever wraps it, including the
agent that proposed it. The direction of the refusal matters:

* **declared ⊄ granted → refuse** (`permission_widening`), naming the root the runtime does not allow.
  Silently narrowing would run the procedure with less than it declared and fail somewhere inside it.
* **granted ⊄ declared → the excess is dropped.** The procedure gets exactly what its document asked
  for, however generous the caller was feeling. A test passes a grant of `/` and asserts the executor
  still cannot read outside the declared tree.
* **A skill the agent wrote may not ask for `/`, the home directory or the network.** A human author
  may; the rule is about who inferred the procedure, not about the parser. Both are still bounded by
  the grant.
* Unknown keys, wildcard scopes, empty entries and a string `yes` for `network` are refused rather
  than ignored — `internet: true` looks to a human like a constraint and would be a restriction
  nobody enforces, which is worse than no restriction.

**The bug these tests found in existing code.** The frontmatter parser entered a nested block by
descending into the last key it had seen and never came back up, so two sibling keys in one block
landed inside each other: `fsWrite` was written into `fsRead`'s list. Every nested block in the
repository had exactly one child — `metadata: aetheris: tags:` — which is why nothing had caught it.
Containers are now tracked by indentation. The first permission block with three keys found it
immediately.

**Not claimed.** Nothing in the product surface evaluates or executes a skill: the 12 skill routes and
the Chat panel read documents and promotion state, and the evaluation/permission machinery is
exercised by tests and available to the loop. Only one capability has a stored procedure to evaluate.

**Phase 3 — memory with provenance and permissions.** ✅ **Met, 2026-10-16.** The seven layers, each
entry carrying provenance, timestamp, confidence, scope, permissions and version; contradiction and
duplicate handling; inspect/correct/delete. Acceptance: a test that stores a user claim and a
verified fact, retrieves both, and asserts the two are distinguishable and that deleting one removes
its provenance — `test/memory-fabric.test.mjs` (18 tests), with `test/memory-bridge.test.mjs` (7) for
the one-way bridge to and from the product memory. Stated as a debt rather than a claim: this
paragraph read as outstanding work for three phases because the detail lived in `docs/03` and this
page never said so.

**Phase 4 — versioned skills with evaluation and regression.** ✅ **Met, 2026-10-16.** See the Phase 4
record above: `skills/evaluation.mjs` and `skills/permissions.mjs`, `test/skills-evaluation.test.mjs`
(13 tests). OBSERVE→RECORD→EVALUATE→DIAGNOSE→PROPOSE→TEST→APPROVE→VERSION→REUSE, with rollback, is
now the loop's actual path rather than its ambition.

**Phase 5 — emotional interaction states and controls.** ✅ **Met, 2026-10-16.** See the Phase 5
record above: `wording.mjs` (673 lines) with `test/emotional-states.test.mjs` (16 tests), and
`AdaptiveLoop.explain` as the consumer. The seven states, estimates reported as estimates with
their alternatives, a correction store the user can withdraw, settings that are refused rather
than interpreted, and one switch that stops the reading as well as the effect.

**Phase 6 — the model and provider fabric.** ✅ **Met, 2026-10-16.**
`services/core/src/adaptive/providers.mjs` (535 lines) with `test/adaptive-providers.test.mjs`
(15 tests). Both acceptance criteria written into this page in Phase 1 are tests, and both are
about refusal:

| Criterion | Test | What it proves |
|---|---|---|
| "routing refuses a request the available capabilities cannot serve rather than degrading silently" | `acceptance: a capability nothing declares is refused, with the list of what is declared`; `acceptance: the planner refuses a step whose provider the fabric did not measure` | The refusal names the missing tag, lists what *is* declared, and reaches the Phase 2 planner: `planSteps` refuses with `capability_unavailable` rather than letting a task fail four steps in, which is a missing capability reported as a failed task |
| "offline mode makes no network call" | `acceptance: nothing is probed that policy forbids, so offline mode makes no call`; `acceptance: the fabric has no way to make a network call of its own` | A **counter on the adapter**, not the absence of an exception: under `strict_offline` the external adapter's `probe` is called 0 times while the loopback one is called once. And the module contains no `fetch`, no `node:http`/`net`/`tls`, no `undici` — checked by reading it — so the property survives future edits rather than depending on a comment |

An adapter declares its kind (`in-process`, `local`, `external`), the tags it serves, its limits and
its notes; the fabric measures availability by probing and never invents it. **One `eligibility()`
is shared by `candidates()` and `probe()`**, which is the load-bearing decision: the same function
that decides who may be routed to decides who may be *contacted*, so a provider the policy forbids
is never asked anything — not probed, not timed, not counted as unreachable after a failed request.
An adapter that was never probed is `unverified`, and `allowUnverified` widens *who may be routed
to*, never what a probe found: a failed probe stays a refusal with its detail ("model llama3 is not
pulled").

The refusals, each with its own code, because "it did not work" is not a diagnosis:

| Code | When | Why it is not silently fixed |
|---|---|---|
| `no_capability` | nothing declares a requested tag | the alternative is substituting a provider that serves a different tag |
| `only_external_capability` | only a forbidden external adapter declares it | the request needs a capability this machine cannot provide offline |
| `provider_unavailable` | probed not-ready, with the probe's own message | readiness is a measurement here, not a claim |
| `capability_exceeds_limits` | the request needs more context or output than the adapter declares | truncating to fit answers a different, shorter question and returns a result that looks complete |
| `no_eligible_provider` | eligible providers exist but none can take it | every per-adapter reason is attached, including `partial_coverage`: two adapters that between them cover a request are **not** combined, because the combination is a different request |
| `preference_not_eligible` | the caller named a provider that cannot serve it | naming a provider is not a way to bypass the gates |
| `no_egress_guard` | an external adapter with no guard installed | without a guard nothing is enforcing the policy, so "external" would be unchecked |
| `unverified_provider` | a probe was never run | an unmeasured provider is not a maybe |

`allowExternal` is one caller's opt-in and never overrides policy; `requireLocal` forces a local
adapter; an external adapter registered with `privacy: 'local-only'` is refused at registration,
because claiming local-only for a provider that leaves the machine is a false claim about where the
data goes. Eligible adapters become `kind: 'model'` capability descriptors that
`validateCapability` accepts, carrying their notes — an adapter whose notes say "sampled output at
temperature 0.7" is described as `sampled`, not `deterministic` — and
`toCapabilityRegistry(registry, null)` publishes every eligible adapter, so the planner's registry
holds what was measured and nothing else.

**The bug this phase found in the docs, of the same shape as Phase 4's parser bug.** README's setup
snippet and its "run in CI" line still said **709 / 1615** while its own component table two
sections below said 738 — and `docs.test.mjs` required the stale form, so the contradiction passed
every check. The docs test now requires README and `docs/03` to state the *same* total, and every
superseded form is refused in both documents. A number stated twice with one test guarding one copy
is a number nobody is guarding.

**Not claimed.** No external provider was contacted: this sandbox has no provider credentials, so
the external path is exercised against a stub that records calls, and no adapter for a real
endpoint is wired in. The fabric feeds `AdaptiveLoop` and the planner's registry; no HTTP route or
Chat panel calls it, and the online-only entry (`src/router/registry.mjs`) is untouched. It does
not pick between two eligible providers by quality — that is the router's measurement, and the
fabric hands it every candidate rather than choosing.

**Phase 6 — providers.** ✅ **Met, 2026-10-16.** See the Phase 6 record above:
`adaptive/providers.mjs` (535 lines), `test/adaptive-providers.test.mjs` (15 tests), one
`eligibility()` shared by routing and probing, and refusals by name at every gate.

**Phase 7 — plugins and MCP safeguards.** ✅ **Met, 2026-10-16.**
`services/core/src/mcp/authority.mjs` (537 lines) with `test/mcp-authority.test.mjs` (11 tests),
plus a provenance label on every result that `mcp/layer.mjs` and `plugins/registry.mjs` already
returned.

**The acceptance criterion is achievable only in its strong reading, and that is the one built.**
"Treat tool output as data, not as instructions" has a weak reading — *filter instructions out of
tool output* — and a strong one — *nothing that arrives as data can authorise anything*. The weak
reading cannot be implemented: any keyword filter is defeated by paraphrase, translation, encoding
or a sentence that simply does not look like an order, and its test suite passes because it only
contains payloads its author imagined. The strong reading is a property of the program: it never
consults the phrasing, so an instruction it fails to recognise is still not obeyed.

So the module has two mechanisms and keeps them apart:

| Mechanism | What it is | What it decides |
|---|---|---|
| `scanInstructions` | a classifier over nine signal families, returning the matched spans | **nothing.** Every result says so in a `note` field. Its output goes into the audit record so a human can see what a tool tried to say |
| `AuthorityBroker` | provenance on every value, an authority minted only from a user turn, a decision that reads provenance and never text | whether a consequential action may run |

The test that carries the criterion is `acceptance: the gate does not depend on the detector`: a
sentence that matches **no** signal (asserted: `instructionShaped === false`) is put through the
same path and refused with the same code, and the refusal records explicitly that it detected
nothing. The other is `acceptance: an instruction in tool output is recorded as data and never
obeyed`, which proves the output is labelled, **kept rather than censored** — deleting the sentence
would also delete the evidence that the tool is hostile, and silently alter a document the user
asked to read — and refused as the reason for `repo.delete`, while the same action with a reason
from the user's own turn is allowed.

The rules, each with its own code rather than one undifferentiated "denied":

| Refusal | When |
|---|---|
| `not_a_user_turn` | authority requested from a tool, a document, a model output, or an unlabelled source |
| `wildcard_grant` | a grant names `*` or `all`; every action is named, so the record says what the user approved |
| `action_not_granted` / `risk_exceeds_authority` | the action is not in the grant, or its tier is above the ceiling |
| `authority_tampered` | the presented token's **fields** re-digest differently from the stored record |
| `authority_expired` / `authority_revoked` | the grant's clock ran out, or the user withdrew it |
| `tainted_justification` | a write/destructive/external/system action's reason came from data — including when a model summarised that data first |
| `justification_missing` | a consequential action with no reason, or with nothing but endorsements |
| `unlabelled_justification` | a reason that does not say where it came from, which is treated as the least trusted thing rather than the most |

Taint survives derivation (`combineProvenance`): *"the model read the tool output and wrote a
plan"* produces a derived value whose provenance still begins at the tool, so the laundering step
is refused as `tainted_justification`. `endorse` is the one way across: a **user turn** may take
responsibility for acting on a tool's suggestion, it must record the reason the user gave, and the
returned provenance still says `untrusted` while carrying `endorsedBy` — because the user approved
an action, not a fact.

**Two bugs found by writing the tests rather than by reading the code.** First, scanning
`JSON.stringify(value)` looked equivalent to scanning the text and was not: JSON escapes a newline
as `\n`, so a line beginning `IGNORE …` became `nIGNORE …`, and `\bignore\b` stopped matching
because `n` and `I` are both word characters. The same sentence matched when scanned alone and was
missed when it arrived inside an object — which is how every tool result arrives. It is now scanned
as the text a person would read, with a regression test for the exact pair. Second, a token is
spreadable and the spread keeps the `digest` property, so a verifier that compared only that string
accepted `{ ...authority, actions: ['fs.delete'] }`. The fields are re-digested now and privileges
are read from the stored record, not from the caller's copy. A third slip was caught the same way:
the tamper assertion was written with `assert.throws` on an async call, which sees nothing, and it
reported "missing expected exception" while the refusal was in fact happening — the same
static-versus-runtime distinction as the shell bug in docs/03 §4.2.

**Not claimed.** The classifier is not a defence and does not claim to be; the defence is that no
consequential action can be authorised by text. The broker is **not yet wired to a route** — the
same position as the rest of the adaptive core — so nothing here claims the running HTTP server is
protected by it. The 11 tests exercise the boundary through the real `McpRegistry` and
`PluginRegistry`, and what is claimed is narrower and checkable: **the boundary exists, it refuses
by name, and its correctness does not depend on recognising an attacker's phrasing.**

**Phase 7 — plugins and MCP safeguards.** ✅ **Met, 2026-10-16.** See the Phase 7 record above:
`mcp/authority.mjs` (537 lines), `test/mcp-authority.test.mjs` (11 tests), provenance on every
tool/plugin/resource/prompt result, and a named test proving the gate does not consult the
classifier that exists only as evidence.

**Phase 8 — image and video workflows.** ✅ **Met, 2026-10-17.**
`services/core/src/media/workflow.mjs` (487 lines) with `test/media-workflow.test.mjs` (11 tests),
layered on the byte validation and job queue the repository already had rather than replacing them.

The directive does not state Phase 8's acceptance criteria, so they are derived from the standing
rules instead of invented for the tests — and each one is a named test:

| Rule | Criterion | Test |
|---|---|---|
| "Do not falsely advertise a capability the available model or hardware cannot deliver" | a modality nothing can serve is reported unavailable and refused by name | `acceptance: a modality nothing can serve is reported unavailable and refused by name` |
| "Do not represent a still image, static preview or synthetic placeholder as a completed generated video" | a video request answered with an image is refused, never delivered | `acceptance: a video request answered with a still image is refused, never delivered` |
| "Do not report success without execution evidence" | a delivered artifact is measured before it is described | `acceptance: a delivered artifact is measured before it is described` |

**A request is routed, not attempted.** `generate()` asks the Phase 6 fabric for `image.generate` or
`video.generate`, and a request nothing can serve is refused with the fabric's own code and reason —
`unavailable`, carrying `fabricCode` (usually `no_capability`) and the fabric's sentence. There is no
code path that produces "a picture" out of whatever is lying around, which is the whole point: the
failure mode this prevents is a product that answers an image request with a placeholder and calls it
a result.

**An artifact is measured before it is described.** The job queue already refuses bytes that are not
the modality they claim and already refuses a still image presented as a video; this layer adds the
properties the caller was actually promised, read from the artifact's own header:

| Measurement | Source | Refusal when it disagrees |
|---|---|---|
| image width/height | PNG `IHDR`, GIF logical screen, JPEG SOF | `dimensions_mismatch`, naming the axis and both numbers |
| video duration | MP4 `mvhd` (timescale and duration) | `duration_short` (tolerance 250 ms — a clip shorter than asked for is a different answer, not rounding) |
| container is a video at all | magic bytes | `still_image_substitution`, `output_not_verified` |
| the clip is not a stub | byte length | `output_too_small` (under 8 KiB) |

The fixtures in the test are **real containers** — a PNG with correct chunk CRCs, an MP4 with a real
`ftyp`/`moov`/`mvhd` — so the measurement code parses headers rather than a mock of a header. The
*provider* is a test double, because this build has none; that is criterion 1 and it is stated rather
than implied.

`verified` is `'full'` only when every property the caller asked for was measured from the bytes. When
a container this build does not parse is returned — WebM's duration lives in an EBML tree it does not
read — the result is `'partial'` and `unverified` names the gap: *"duration (the WebM duration lives in
an EBML tree this build does not parse)"*. It does not guess, and it does not refuse a format merely
for being unfamiliar.

**Pointing it at a cloud provider is a governed action, not a flag.** Two separate decisions:

* the **installation** opts in (`allowExternal`), which is what makes an external provider eligible
  at all — without it the fabric refuses with `no_eligible_provider`, and `describe()` says so;
* the **request** needs an authority minted from a user turn (Phase 7), because sending a prompt to a
  cloud provider is egress. Missing grant → `authority_required`; a grant that does not name
  `media.generate` → `action_not_granted` from the broker, passed through with its own code rather
  than flattened into `provider_failed`. `describe()` therefore reports `requiresAuthority: true`
  for an external provider: reachable and still not usable without a grant.

**Not claimed.** No image or video provider exists in this build, so nothing here claims that
generation works — it claims that the workflow refuses correctly, measures what arrives, and says
which parts it could not measure. The product's routes still refuse with their own limitation codes
(`not_implemented`, `needs_hardware`); `MediaWorkflow` is not wired to them yet, which is the same
position as the rest of the adaptive core. Quality, safety filtering of the *prompt* and multi-artifact
requests are out of scope: `count` above 1 is refused rather than silently reduced.

**Phase 8 — image and video workflows.** ✅ **Met, 2026-10-17.** See the Phase 8 record above:
`media/workflow.mjs` (487 lines), `test/media-workflow.test.mjs` (11 tests), routed and refused
through the provider fabric, measured from artifact headers, and a still image refused as a video.

**Phase 9 — industry packs.** ✅ **Met, 2026-10-17.**
`services/core/src/packs/manifest.mjs` (249), `packs/registry.mjs` (277), `packs/builtin.mjs` (131)
and `test/industry-packs.test.mjs` (12 tests). A pack is content and restriction, never capability
and never authority.

The directive does not state Phase 9's criteria either, so they are derived from the standing rules
and each is a named test:

| Rule | Criterion | Test |
|---|---|---|
| "industry packs for regulated industries … should stay optional" + the tier rule that a profile narrows and never widens | a pack can only narrow a policy: a weaker data-class floor, an unknown key or a non-refusable action is refused at validation | `acceptance: a pack can only narrow policy, never widen it` |
| tool output is data and cannot authorise anything (Phase 7) | a pack is data too: applying one yields a frozen profile, and presenting that profile as an authority is refused | `acceptance: a pack is data and cannot authorise anything` |
| "Do not falsely advertise a capability the available model or hardware cannot deliver" | a pack whose capability this installation cannot serve reports it by name and is not applied unless the caller acknowledges the gap | `acceptance: a pack whose capability is unavailable is reported, never substituted` |

**What a pack is.** A versioned document: `id`, `industry`, `description`, `capabilities` (each with
the file in this repository that evidences it, or `unimplemented: true`), `vocabulary`,
`disclaimers`, `sources`, `refuses` and `restrictions`. The validator refuses unknown keys, refuses a
`dataClassFloor` below `internal` (so a pack cannot declassify `confidential` data to `public`), and
requires a regulated pack (`finance`, `healthcare`, `legal`, `public-sector`) to set
`requireHumanReview` and to name at least one refused action. Installing, enabling and uninstalling
are all governance events: history is kept, a downgrade needs an explicit flag, and there is no
`grant`, `authorise`, `approve`, `execute` or `invoke` on the registry, so a pack cannot become a
principal.

**Readiness is measured, not asserted.** `readiness(id)` asks the Phase 6 fabric for each required
tag and reports one of four states, which exist because they have four different answers:
`unknown` (no fabric configured — *not* a claim that it works), `unavailable` (a capability the pack
relies on is not served; application is refused as `pack_unavailable` unless
`profileFor(id, { allowPartial: true })` is asked for by name), `partial` (everything it relies on is
served, but it declares a gap it admits to), and `complete`. That fourth case was found by the
Phase 10 benchmark, which failed on it: the first implementation treated a pack's *honest admission*
that a capability is unimplemented as though the capability were missing, which would have made
disclosure more expensive than silence. Fixed before release, and the fix has its own assertion.

**Shipped packs.** `engineering.repo-maintenance` (refuses `fs.delete`, `network.external`, requires
human review), `legal.document-review` (confidential floor, refuses `fs.write`, `fs.delete`,
`network.external`, `media.generate`, and carries "reading support, not legal advice" as a disclaimer
rather than a footnote) and `education.grounded-tutoring` (refuses `network.external`,
`media.generate`). Their capabilities are the modules this repository actually has —
`tree.line-count`, `memory.layer.*` — plus `chat.completion` marked unimplemented, because no chat
provider ships in this build. Neither source-citing pack cites a source: `requireSources` is false
for both, since inventing a citation to satisfy a field is the failure the field exists to prevent.

**Not claimed.** No pack is reachable from the product, and a pack is not a compliance
certification. `profileFor` returns restrictions; it does not enforce them — enforcement is the
Phase 5/7 gates, and the profile is an input to them.

**Phase 10 — benchmark, harden, document, release.** ✅ **Met, 2026-10-17.**
`src/benchmark/harness.mjs` (254), `src/release/manifest.mjs` (268), `test/benchmark.test.mjs`
(7 tests), `test/release.test.mjs` (14 tests), a measured artefact at
`docs/experiments/phase10-benchmark.json`, the release note [26 — Release 0.2.0](26-release.md) and a
`VERSION`/`CHANGELOG.md` pair at **0.2.0**.

The derived criteria, each a named test:

| Rule | Criterion | Test/artefact |
|---|---|---|
| "Do not report success without execution evidence" | every benchmark number comes from calling the real module, and a benchmark that fails is kept in the table and fails the run | `acceptance: a benchmark reports the measurement its number came from`; `acceptance: a failed benchmark is kept in the table and fails the run` (in `test/benchmark.test.mjs`) |
| a documented number is a claim | the release is refused unless the documents' totals equal the measured suites | crafted refusals in `test/release.test.mjs`, including two documents that agree with each other and not with the suite |
| no release without its artefacts | `VERSION`, one version across three packages, a dated changelog entry, required files and every pack capability's evidence | `a consistent release verifies` / `a required artefact that is missing is refused` |

**The benchmark measures the modules, and says so.** Seven entries — authority decisions,
instruction classification, PNG header parsing, MP4 `mvhd` parsing, provider routing, pack
application and a line count over 24 files on disk — each produced by a real call with an assertion
inside the timed loop, so a benchmark that stops doing the work fails instead of getting faster. The
report carries `environment` (Node, platform, CPU count) and a `scope` string stating that it is not
a product throughput claim. A zero-elapsed-time run raises rather than reporting `0 ops/s`; the
`recordBenchmark` failure paths are tested directly.

**One measured run**, 2026-10-17, 2 CPUs, Node v22.22.3, in the committed artefact (absolute rates
vary by host and by run; the medians are what the run had):

| Benchmark | ops/s | p50 ms | p95 ms |
|---|---|---|---|
| `authority.decide` | 58,576 | 0.013 | 0.025 |
| `authority.scan` | 59,327 | 0.015 | 0.022 |
| `media.measure-image` | 358,766 | 0.001 | 0.005 |
| `media.measure-video` | 97,310 | 0.002 | 0.004 |
| `fabric.route` | 137,846 | 0.005 | 0.009 |
| `packs.profile` | 71,474 | 0.009 | 0.023 |
| `adaptive.line-count` | 119 | 6.827 | 22.397 |

**The release verifier is the deliverable, not the tag.** `verifyRelease(state)` takes the version,
the package versions, the changelog, the status document, the README, the artefact list and the
*measured* suite totals, and refuses on disagreement. `scripts/release-check.mjs` makes the totals
arguments rather than reading them from the documents it is checking, because a verifier that reads
its own expectations verifies nothing. The tests prove it refuses: a package on an old version, an
undated changelog entry, an empty one, a total one too high, a stale grand total, a README that
drifts, two documents that corroborate a wrong number, a missing artefact, a pack citing evidence
that is not there, and a pack that does not validate.

**What was hardened.** The benchmark found the `partial`/`unavailable` conflation described above;
the release verifier found nothing new in the tree, because the documentation counts it checks were
already the ones `docs.test.mjs` pins to the filesystem. No API was changed in this phase, so no
consumer needed updating.

**Not claimed.** This is not a performance claim, not a load test, and not a security review. It is
a reproducible benchmark of a library and a release check for a version number.

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
one works, or that the later phases are built. It does not claim the adaptive core is reachable from the
product: intent, planning, budgets, timeouts, checkpoints, the runner and the memory fabric are
exercised by tests, and no HTTP route or Chat panel calls them. The fabric is a schema and a set of
rules for what may be believed and why — not a retrieval model. Emotional interaction states and the provider
fabric are built and tested but not reachable from the product — the seven states are a wording
setting, and the provider fabric measures eligibility for a loop no HTTP route calls — the plugin/MCP authority
boundary and the image and video workflows are built and tested, but the HTTP layer consults neither,
so the running server is not protected by the boundary and its media routes still refuse with their
own limitation codes. Industry packs are not built. Timing here is timing on this box (2 cores, 3,939 MB), at
the sample counts stated beside each figure — not a property of another machine. And the rule this
page states rather than claims: no phase is complete before its acceptance tests pass, which is why
§4 describes Phase 2 by what its test runs and refuses to describe the phases that have none.

What it does claim: the direction changed; Sparsiz was inspected at a named commit and is mostly a
roadmap rather than an implementation; five small pieces of it are reusable and the rest must not be
inherited; most of the plumbing this architecture needs already exists here with tests; and the loops
through that plumbing are the work — the first of them now built, tested and measured.
