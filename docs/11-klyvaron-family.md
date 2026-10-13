# The Klyvaron family, and the six levels of learning

Two things that are easy to claim and hard to make true: that a platform has its own
models, and that it learns. This document records what exists for each, and — more
usefully — the mechanism that stops the claim drifting away from the fact.

Everything here is checkable from the repository. Where a count or a digest appears,
it is read from the artifact of record rather than copied from a summary.

---

## 1. The three tiers

| Tier | Hardware | Status | Capabilities available | Backing artifact |
|---|---|---|---|---|
| **Klyvaron Lite** | Phones and constrained devices | **Partial** | 2 of 11 | `aetheris-lite-lm-0.1.0` |
| **Klyvaron Pro** | Laptops and desktops | **Unbuilt** | 0 of 11 | none |
| **Klyvaron High** | Workstations, authorised remote compute | **Unbuilt** | 0 of 9 | none |

The status column is a value in `services/core/src/klyvaron/tiers.mjs`, not prose. Pro
and High are recorded as **unbuilt** rather than omitted, because an omitted capability
and a capability that does not exist are indistinguishable in a listing — and a listing
is exactly where overclaiming starts.

### 1.1 What Klyvaron Lite actually is

A 359,136-parameter character-level language model trained from random initialisation on
this repository's own text, on two CPU cores, in about 37 minutes. Its measurements come
from a committed run report and model card:

| Measure | Value |
|---|---|
| Validation perplexity | 4.4033 |
| Bits per character | 2.1386 |
| Best of three computed baselines | bigram, 15.9109 |
| Ratio to that baseline | 0.276748 |
| Weights digest | `82392ef8907455e56e1cee56bf4a074cb9337dc38f79775859b67efa5b822e94` |

The two capabilities it backs are `text.completion` and `text.extract`. **It does not
chat, and it is deliberately not wired into `/api/chat`.** Presenting it as an assistant
would be a fiction: it continues text, its output is not fluent, and no instruction
tuning has been done. The capability record for `chat` is `unavailable` with that reason
attached, and `services/core/test/klyvaron.test.mjs` asserts the reason stays there.

Its limitations are part of the record, not a footnote, and one of them is load-bearing:
**Lite meets the storage target and no capability target.** It is smaller than the 1.5 GB
per-model budget because it is tiny, not because it is efficient. The validator refuses a
backing record with an empty limitations list, on the grounds that a record with no
limitations reads as having none, which is a claim in itself.

### 1.2 Storage: the 5 GB mobile budget

`services/core/src/storage/budget.mjs` accounts for the managed mobile footprint against
the directive's numbers — **5 GB total, strictly below**, with a 500 MB reserve, a 200 MB
app-package target and a 1.5 GB per-primary-model target.

Three decisions are worth stating, because each is a place the accounting could have been
wrong while looking right:

- **It measures.** No parameter count is multiplied by an assumed bytes-per-parameter.
  `measure()` walks the directory and sums `stat.size` over the real files. An estimate is
  fine for planning and useless for a limit, because the failure mode is a device that
  runs out of space while the accounting says it has not. The test proves the difference
  by replacing measurement with an estimate and watching seven tests fail.
- **Deletion is unreachable, not forbidden.** `clean()` iterates only the regenerable
  categories. A protected category raises an error rather than being filtered out, so a
  mistaken caller finds out instead of believing it succeeded. "Never silently delete
  user-owned data" is therefore a property of the code path rather than a rule someone
  has to remember.
- **Refusal is advice, not action.** When a download does not fit, the decision names what
  could be cleared and leaves it to the user. A model download never makes room by
  deleting something the user owns.

Symlinks are counted as their own size and never followed, so a link cannot make the
footprint look larger or smaller than it is.

### 1.3 The mechanism that makes relabelling impossible

The directive's hardest constraint on models is §5A: *"Do not present an unchanged
third-party model as an independently pretrained Klyvaron foundation model."*

Documented rules of this kind are followed until they are inconvenient. So there is no
`tier:` field to set on a model descriptor. A tier label is a **lookup**:

```
tierClaimFor(modelId) -> tier id, or null
```

It returns a tier only when the model id *is* the artifact named in a backing record for a
capability that tier actually provides. A rebranded third-party model, a made-up product
name, and a version that does not exist all return `null` — the label does not appear,
because no string matches. Tested with all three cases.

The family is validated **at startup**. `AetherisOmniApp`'s constructor builds the family
report and throws with the violation list if it is invalid, so a record that claims a
capability nothing backs stops the process instead of reaching a user. By the time a
request arrives, the check has already run.

The validator rejects, among others:

| Refused | Why it matters |
|---|---|
| `available` with no backing artifact | "A tier label is not evidence." |
| A non-`from_scratch` provenance with no base model named | Relabelling a fine-tuned model is the easiest overclaim, and a licence defect |
| `available` with no measurements | A capability record with no numbers is an assertion |
| `available` with no stated limitations | no limitations reads as having none |
| `unbuilt` with an available capability | A tier cannot be less built than its capabilities |
| `available`/`partial` with nothing available | A status can drift from its content |

All six are tested by constructing the offending record and asserting the validator
refuses it. When this validator was first written it caught two violations in the
author's own data — Pro and High carried comparative descriptions — and the fix was to
make tiers declare `status` + `statusNote`, so the report cannot present an unbuilt tier
as a product.

The report is served on `GET /api/models` as `family`, alongside the routable models.
They answer different questions: `models` is what can serve a request now, `family` is
what Aetheris has built and what backs each claim. It lives there rather than in a
separate area because the model control a user actually sees is in Chat.

### 1.4 Provenance and licence

| Artifact | Provenance | Licence | Base model |
|---|---|---|---|
| `aetheris-lite-lm-0.1.0` | `from_scratch` | MIT (this repository) | none — random initialisation |

No third-party weights are redistributed, and none are present in this repository. The
weights are gitignored by policy and referenced by digest. What this means for
redistribution is in [`03-status.md`](03-status.md) §7 and [`05-security.md`](05-security.md).

---

## 2. The six levels of learning

The directive requires these to be formal levels rather than a synonym for conversation
history. The distinction that makes them levels is **what survives a session boundary and
what has to be verified before it does.**

| Level | What is learned | Persists? | Verified before use? | Status |
|---|---|---|---|---|
| **L1** Contextual adaptation | The current conversation's context | No — session only | n/a, nothing is stored | **Implemented and tested** |
| **L2** User-approved memory | Facts the user explicitly asked to keep | Yes, inspectable | User approval is the gate | **Implemented and tested** |
| **L3** Procedural skills | How to perform a recurring task | Yes, as versioned documents | Recorded checks that all passed | **Implemented and tested** |
| **L4** Strategy across tasks | Which approach works, generally | Yes, as regression cases | A validated failure must join the suite | **Partial** — failure recurrence is implemented; cross-task transfer is not tested |
| **L5** Model adaptation | Changed weights | Yes, as artifacts | Held-out evaluation, and the release gate | **Partial** — SFT, preference and distillation paths exist; stages 4–6 are blocked here |
| **L6** Verified release improvement | A newer artifact replacing an older one | Yes, with rollback | Data manifest, digest, benchmarks, regression + safety checks | **Implemented and tested** |

### 2.1 The central rule

> Learn from experience, verify the lesson, test its generality, then reuse it safely.

Each level is the previous one plus a stronger form of verification. L1 verifies nothing
because it stores nothing. L3 will not promote a skill without recorded checks. L4 will not
add a failure to the permanent suite until it is *validated* rather than merely observed.
L6 will not promote a release at all without a data manifest, base checkpoint, config, code
revision, artifact checksum, benchmarks and a retained known-good baseline.

The distance between the levels is the point. Collapsing them is how "the system learns"
becomes a claim with nothing behind it.

### 2.2 L3 in detail — procedural skills

`services/core/src/skills/` implements the level the directive describes as
experience-driven skill improvement. The governing text is §6C, and its last paragraph —
*"Do not silently rewrite core system instructions, grant new permissions or install
arbitrary code because an agent believes it has learned something"* — is a structural
problem, not a prompt-engineering one. A rule that says "do not do X" can be argued with;
a rule that makes X unreachable cannot.

So the dangerous operations are **unreachable rather than forbidden**:

| Invariant | Enforced by |
|---|---|
| **I1** There is no delete | The registry has no delete method; `ARCHIVED` is terminal and reversible |
| **I2** Automatic transitions apply only to `agent`-created skills | A provenance gate, checked per skill |
| **I3** A pinned skill is exempt from every automatic transition | Checked unconditionally, including for `retire()` |
| **I4** No automatic path validates a skill | Promotion requires recorded checks that all passed; there is no "trust the agent" branch, because the agent is the thing being governed |
| **I5** A disabled skill is not a curation candidate | Excluded from the walk, so it is not rewritten either |

Each invariant has a test, and each test was verified to bite by removing the enforcement
and confirming the suite fails: removing the provenance gate fails one test; removing the
pinned exemption fails one; making candidates loadable fails three; skipping the evidence
requirement fails one. The source files were restored byte-identically afterwards.

I1, I3 and I2's provenance gate are adopted from Hermes Agent's documented curator
invariants. See [`10-hermes-audit.md`](10-hermes-audit.md) §3.1 for what was taken and
what was deliberately not.

**One bug found by the tests rather than by reading.** `curate()` originally set
`updatedAt` on each transition, which reset the idle clock — a skill that went stale on day
31 then measured its archive threshold from day 31, needing `staleAfterDays +
archiveAfterDays` of idleness instead of `archiveAfterDays`. Two tests failed for a reason
that had nothing to do with the assertions they appeared to be making. The tests were wrong
about the clock in one place too (they advanced the curator's clock while the registry used
the real one), and that is recorded here because "the test failed" is not the same as "the
code was wrong".

### 2.2b L2 in detail — memory that cannot remember on its own behalf

The directive requires user-approved memory to be inspectable, editable and deletable,
and requires it to stay distinct from contextual memory, retrieval indexes and training
data. `services/core/src/memory/store.mjs` implements it, and the distinctions are
enforced rather than described:

| Property | How it is enforced |
|---|---|
| Nothing is remembered without the user | The `approved_by` column carries `CHECK (approved_by = 'user')`, so the database refuses an agent-approved row |
| Memory is never training data | Every row carries `CHECK (training_use = 'prohibited')`; the restriction travels in the export too |
| A proposal cannot reach a prompt | `contextFor()` reads a view filtered on `status = 'approved'`; a candidate lives in a different table with no path into a prompt |
| Deletion is real | `forget()` removes the row, its index entries and writes a tombstone that records *that* a deletion happened, never what it said |
| Recall is not memory | `recall()` searches the user's own turns on demand and returns each hit with its session and role |
| Memory is local | Its own database file, and a test drives the store with egress blocked and a fetch recorder, asserting **no network call is attempted** |

The gate has a user interface. L2 was implemented for one commit with no way to reach it:
a memory store whose approval step is only callable through the API is a memory system
that cannot be used as intended, because the whole point of the gate is that a person
decides. `apps/web/src/areas/ChatArea.jsx` now carries two panels inside **Chat** — never a
sixth navigation entry:

| Panel | What it offers | Where the promise is kept |
|---|---|---|
| **Memory you approved** | List, add, edit, delete, delete everything, search, and **approve or reject each pending proposal** | The candidate card says in words that a proposal is not a memory and is not injected; the composer's switch reads *Use what I asked you to remember* and is off by default |
| **Conversation history** | List stored sessions with their turn counts, search your own past turns, delete a session | A search that finds nothing says how many turns it searched and that **nothing was invented to fill the result** |

The panel also states its own limits from the store's `limits` block, and when the list
comes back full it says so rather than implying those are all of them. Deletion is real in
the interface — the confirmations report the counts the server actually returned, and a
duplicate is reported as a duplicate rather than as a second copy. Export is now reachable
too (`GET /api/memory/export`), so "delete and export" is one right rather than half of one.

One defect the interface's own test found, worth recording: `forgetAll()` failed with
`FOREIGN KEY constraint failed` for any user who had ever approved a proposal. Both
`memory_candidates.memory_id` and `memories.superseded_by` reference `memories`, and with
`PRAGMA foreign_keys = ON` the wipe deleted the memories before the rows pointing at them.
Approval is exactly what the panel is for, so the feature's headline promise — real
deletion — was broken for the memories that came through the gate. The delete paths now
release the references first; the decision records survive and lose only the pointer to a
row that no longer exists.

Two properties are worth calling out because they were bugs before they were features:

**Egress is decided on the assembled request, not on the question.** Memory injection and
document retrieval both add text to a prompt, so both can raise its sensitivity. The chat
path now builds the full context first and takes the most sensitive class of everything in
it. Before this, a public question that retrieved a confidential chunk was classified
public and could have been sent externally: the retrieval path was an exfiltration channel
with a friendly name. The decision is shared by the streaming and non-streaming paths
through one implementation, because there were two copies and one of them would have been
missed.

**Two independent layers, discovered by a control that failed to bite.** The first
attempt at proving "a candidate cannot reach a prompt" removed the index filter and the
test still passed. The reason is that `contextFor()` re-checks the row's status when it
hydrates a hit. The control was rewritten to defeat both layers and then the test failed
as it should — the guard is defence in depth, which is a better answer than the one the
control was looking for.

### 2.3 L5 and L6 — what the training system can and cannot do here

`services/fabric` implements data validation → base selection → domain training → SFT →
preference optimisation → distillation → evaluation → release as a single reproducible
pipeline. **Stages 4, 5 and 6 report themselves blocked on this host** and say what they
would need; a run containing a blocked stage is never eligible to release the artifact that
stage would have produced. This is the mechanism behind the honest status column above.

L6 has one real promotion and one real rejection:

- **Promoted:** `aetheris-lite-lm-0.1.0`, which cleared the hard gate
  (`pplVsBigram ≤ 1.0`, `unknownRate ≤ 0.02`, `lossImprovement ≥ 1.0`), with a committed
  model card, a weights digest and a rollback path.
- **Rejected:** logit-level distillation from our own released model, on all three seeds,
  with the acceptance rule "same sign every seed AND `|mean| > spread`". The primary
  condition regressed by 0.0922 perplexity points and the untrained-teacher control by
  0.3105 — the control was *worse*, which is what makes the result worth recording. See
  [`09-distillation.md`](09-distillation.md) §5.

The rejection is the more useful of the two: it is evidence that the gate refuses a change
that a looser process would have shipped as an improvement.

### 2.4 Privacy separation — five things that must not be merged

The directive requires the following to stay distinct, and the distinction is enforced by
where the data lives rather than by a policy statement:

| | What it is | Where it lives now |
|---|---|---|
| Contextual memory | The current session's context | In the request; nothing is written |
| User-approved memory | Facts the user asked to keep | `memory.sqlite` — approval is a database `CHECK`, so a row cannot be written without one |
| Reusable skills | Procedures, not data | `skills/` — validated documents, no user content |
| Candidate training data | Failures and feedback that *might* train | `fabric/failure_memory.py`, behind a triage gate and a privacy filter that refuses credential material |
| Released weights | A promoted artifact | Gitignored, referenced by digest, with a model card |

**No personal conversation or document is auto-trained on.** Company-private material
defaults to local processing, and the path from a captured failure to a regression case
refuses credential material outright, because a regression suite is exactly the kind of
artifact that gets committed.

---

## 3. What is not built

Stated plainly, because §7 of the directive asks for it and because a list of what exists
without a list of what does not is a sales document:

- **Klyvaron Pro and High do not exist.** No artifact, no measurements, no plan that has
  produced a file. On this host no route to a model registry exists and there is no GPU,
  so obtaining base weights is not possible; the tiers are unbuilt rather than pending.
- **Lite does not chat, translate, summarise or reason.** Only `text.completion` and
  `text.extract` are backed.
- **L2's user interface does not cover superseding.** The panel lists, adds, edits,
  deletes, exports, searches and decides proposals; the store's `supersede()` — replacing a
  memory with a corrected one while keeping the link to what it used to say — is implemented
  and tested but still has no control. Editing a memory in place is offered instead, which
  loses the history that superseding preserves.
- **L4 transfer testing is not implemented.** A lesson that helps on task A is not
  currently tested for whether it helps on task B; the directive's requirement to record
  non-generalisation is met only for the failure-recurrence case.
- **LoRA/PEFT, external distillation and local video generation cannot be exercised here.**
  The external distillation path exists behind an explicit authorization object and a
  redaction gate, and **has never been run against a real provider** — it is
  *Requires external credentials*, not working code.
- **The skills subsystem is not yet reachable from the API.** It is a tested module with
  no route wired to it; that is the next integration step, not a finished feature.

Nothing in this document should be read as a claim of parity with any other model family.
Lite is a 359,136-parameter character model that beats three computed baselines on
perplexity. That is the whole claim.
