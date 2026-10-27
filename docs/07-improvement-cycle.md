# 07 — The Sparsiz improvement cycle, run on a real failure

This document records one complete pass of the improvement cycle defined in
[`docs/02-architecture.md`](./02-architecture.md):

```
Task → Baseline → Failure Capture → Root-Cause Analysis → Hypothesis
     → Controlled Experiment → Evaluation → Accept or Reject
```

It is not a description of a process. It is the output of one, produced by
`services/fabric/scripts/sparsiz_cycle.py`, which drives the real
`ExperimentLedger` and `FailureMemory` implementations. Every number below is
reproducible with the command in [§7](#7-reproducing-this).

**Status: implemented and tested.** The cycle ran, reached a verdict, and the
verdict was enforced by the ledger rather than asserted by the script. The
limitations this pass exposed are recorded in [§6](#6-what-this-pass-does-not-establish),
including one measurement artefact that was found and corrected part-way through.

## 1. Task and baseline

The task was chosen from an existing, unfixed result rather than invented: in
[`docs/06-benchmarks.md`](./06-benchmarks.md) the `high`-overlap condition was
**rejected** because the trained dense retriever gave up recall that the lexical
baseline had. A rejected run is the right starting point, because the failure is
already known to be real.

The baseline is BM25 over the same corpus, frozen before any variant was measured.
`ExperimentLedger.record_baseline` refuses to overwrite a baseline, so the
reference cannot drift underneath the comparison.

Measured conditions: `high` (query reuses document wording) and `low` (query and
document wording deliberately differ), both split by query. The `low` condition is
included because a fix that repairs `high` while breaking `low` is not a fix.

| Condition | Baseline | mrr | recall@1 | recall@5 | ndcg@10 | latencyMs |
|---|---|---|---|---|---|---|
| `high`/query | BM25 | 0.766667 | 0.666667 | **1.0000** | 0.823904 | 0.0242 |
| `low`/query | BM25 | 0.335185 | 0.250000 | 0.541667 | 0.394233 | 0.0210 |

Dataset digest: `ec565a36f1925c2ba7f770ebfab30b44e539e68a54e94e9f114c364538bacf8f`
(`high`), 96 documents, 24 evaluation queries.

## 2. Failure capture

The dense retriever was measured first, since it is the system that produced the
recorded failure. Two held-out queries lost a judgement the baseline kept:

| Query | Baseline recall@5 | Dense recall@5 |
|---|---|---|
| `calibration-q0` | 1.0 | 0.0 |
| `storage-q0` | 1.0 | 0.0 |

Both became `FailureRecord`s in `FailureMemory` and were then triaged, validated
and promoted to permanent regression cases (`reg-0001`, `reg-0002`) with the
`relevant_in_top_k` checker. The checker is executed against both retrievers as
part of the run: it passes on the baseline and fails on the dense model, which is
what makes the case a regression case rather than a note.

## 3. Root-cause analysis

The diagnosis is a measurement, not an intuition. The vocabulary is fitted on
documents **plus training queries only**, so it represents everything the model
trains on and not everything it will be asked:

| | Queries | Contain an out-of-vocabulary token |
|---|---|---|
| `high`/query | training | **0 / 48** |
| `high`/query | evaluation | **6 / 24** |
| `low`/query | training | **0 / 48** |
| `low`/query | evaluation | **13 / 24** |

Vocabulary size 293 (`high`). In the `low` condition more than half the evaluation
queries carry a token the vocabulary has never seen.

The tokens are not incidental filler — they are the terms that identify which
topic is being asked about. For `calibration-q0` the token `adjustment` resolves to
`<unk>`; for `storage-q0` it is `keeping`. Both are the topic's query-side wording,
which by design never appears in that topic's documents.

The consequence is mechanical. `<unk>` is index 1 in the embedding table, and
because no training token ever resolves to it, **its embedding receives no gradient
during training** and stays at its random initialisation. Every query carrying an
out-of-vocabulary term therefore injects an untrained random vector into the query
representation it is scored on.

Root cause classification: **`DATA`** — the input representation is incomplete. It
is not a ranking defect: the scoring path is unchanged and works. It is not
`TRAINING` either; the optimiser does exactly what it is asked with the tokens it
is given.

## 4. Hypothesis and controlled experiment

Two hypotheses were tested against the same frozen baseline under a strict control
(the ledger compares dataset digest, corpus size and hardware and refuses the
comparison if they differ):

1. *The dense retriever alone matches or beats the lexical baseline.*
2. *Equal-weight rank fusion of the lexical and dense retrievers keeps the lexical
   recall while retaining the dense ordering, so no metric regresses beyond
   tolerance.*

Hypothesis 1 is a **negative control**. It must reproduce the documented
rejection; if it did not, the ledger's rules would not be the rules that produced
the recorded result.

| Condition | Variant | Verdict | mrr | recall@5 | latencyMs |
|---|---|---|---|---|---|
| `high` | dense only | **reject** | 0.889286 | 0.9167 | 0.1464 |
| `high` | hybrid 0.5/0.5 | **accept** | 0.915675 | 0.9583 | 0.1921 |
| `low` | dense only | accept | 0.849702 | 0.9583 | 0.1416 |
| `low` | hybrid 0.5/0.5 | accept | 0.935417 | **1.0000** | 0.1894 |

The rejection reason recorded by the ledger is:

```
recall@5 regressed: 1.0000 -> 0.9167 (tolerance 5%)
target 'mrr' improved 0.7667 -> 0.8893 (+16.0%), meeting the required +0.0500
```

The first line matches the rejection recorded in `docs/06-benchmarks.md`. The
negative control passed: the ledger, re-run against the same inputs, reaches the
same conclusion for the same reason.

**What that verdict is and is not.** The ledger decided, at seed 7, that the
fused ranker beat the frozen baseline on `mrr` while holding `recall@5` inside
tolerance. That is a correct application of its rules to one measurement, and it
is all it is. It is **not** evidence that fusion generally improves ordering —
[§5.2](#52-replication-what-survives-across-seeds) re-runs the comparison at five
further seeds and the `mrr` half of that verdict does not survive, while the
`recall@5` half does. Read the accept as "accepted at the recorded seed", which is
the literal claim.

An earlier version of this document said the fusion "improves ordering (+19.4% on
`high`)" without that qualification. That was a single-seed result reported as a
general one, and it is corrected here rather than quietly softened.

### 5.1 The mechanism

Fusion is rank-based: the document at position `i` of a list of length `n`
contributes `weight × (1 − i/n)`. Rank-based rather than score-based is deliberate —
BM25 scores are unbounded and corpus-dependent while cosine similarity is bounded,
so summing raw scores would let whichever ranker produces larger numbers dominate,
and the balance would drift with corpus size.

The two retrievers fail in different places, which is what makes the combination
work. BM25 cannot order the `high` condition well (`mrr` 0.7667) but never loses the
answer; the dense model orders well but loses the answer when a query term is
untrained. Agreement between an independent lexical and dense signal is stronger
evidence than either alone.

## 5. Cross-condition behaviour

The fused ranker was measured on all four benchmark conditions, and at three
weights, before any of it was released:

| Condition | BM25 mrr | dense mrr | w=0.3 | w=0.5 | w=0.7 |
|---|---|---|---|---|---|
| `low`/query | 0.335185 | 0.849702 | 0.763857 | **0.935417** | 0.920139 |
| `high`/query | 0.766667 | 0.889286 | 0.872917 | **0.915675** | 0.901010 |
| `low`/topic | 0.382011 | 0.093673 | **0.475066** | 0.402072 | 0.175623 |
| `high`/topic | 0.685714 | 0.063492 | **0.715344** | 0.545370 | 0.213121 |

Two conclusions the table supports directly:

- **The fusion repairs the topic-split collapse.** On the topic split the dense
  retriever is close to useless (0.0937 and 0.0635 against BM25's 0.3820 and
  0.6857). Fusing at `w=0.5` recovers both to above BM25 on `low`/topic and to
  within 20% on `high`/topic. A dense component that is catastrophic on its own
  stops being catastrophic when a lexical signal is allowed to outvote it.
- **`w=0.5` is not best everywhere.** It is best on both query conditions and worst
  of the three on both topic conditions, where `w=0.3` is better. There is no free
  lunch here, and [§6](#6-what-this-pass-does-not-establish) treats this as a live
  limitation rather than a tuning opportunity.

### 5.2 Replication: what survives across seeds

One run at one seed cannot separate a change from luck. The same measurement was
re-run at six seeds, and on each seed the dense and fused rankers were scored on
**the same trained model**, so the seed cannot confound the comparison. Reversible
with `npm run robustness`.

**First, how much does the released number itself move?** Same data, same
configuration, only the initialisation differs:

| | mean | min | max | spread | stdev |
|---|---|---|---|---|---|
| `mrr` | 0.872239 | 0.841667 | 0.944444 | 0.102777 | 0.042107 |
| `recall@5` | 0.951389 | 0.875000 | 1.000000 | 0.125000 | 0.040966 |

The released `mrr` of **0.849702** is seed 7's value. It sits below the six-seed
mean and ranks **4th of 6** ascending — so the reported figure is not the best of
several runs, which is the thing a reader most needs to know. But it is one draw
from a distribution with a stdev of 0.042, and the model card presents it as *the*
score. That is the honest unit of measurement, and the spread is the error bar that
was missing.

**Second, does the fusion help?** Paired comparison, `high` overlap — the condition
the rejection was about, where BM25 has perfect `recall@5`:

| seed | dense mrr | dense r@5 | fused mrr | fused r@5 |
|---|---|---|---|---|
| 7 | 0.8893 | 0.9167 | 0.9157 | 0.9583 |
| 11 | 0.9365 | 0.9583 | 0.9792 | 1.0000 |
| 13 | 0.9583 | 0.9583 | 0.9421 | 0.9583 |
| 17 | 0.8694 | 0.9583 | 0.9302 | 0.9583 |
| 23 | 0.9389 | 1.0000 | 0.9514 | 1.0000 |
| 29 | 0.8278 | 0.9167 | 0.9062 | 0.9583 |

and `low` overlap:

| seed | dense mrr | dense r@5 | fused mrr | fused r@5 |
|---|---|---|---|---|
| 7 | 0.8497 | 0.9583 | 0.9354 | 1.0000 |
| 11 | 0.9444 | 1.0000 | 0.9132 | 1.0000 |
| 13 | 0.9032 | 0.9583 | 0.8590 | 1.0000 |
| 17 | 0.8472 | 0.9583 | 0.8837 | 0.9583 |
| 23 | 0.8417 | 0.9583 | 0.9076 | 1.0000 |
| 29 | 0.8472 | 0.8750 | 0.8441 | 0.9167 |

Two claims come out of this, and they are not the same claim.

**Robust: the fusion never reduces `recall@5`.** On all twelve measurements — two
conditions across six seeds — the fused ranker's `recall@5` is greater than or equal
to the dense model's. Mean paired gain +0.0208 on `high`, +0.0278 on `low`. This is
the property the fusion was introduced for, it is the reason the change is worth
keeping, and it holds everywhere measured.

**Not robust: the fusion improves `mrr`.** On `high` the mean paired gain is +0.0341
against a seed stdev of 0.0499, and it is **negative on one seed**. On `low` it is
+0.0183 against 0.0421, and **negative on three of six seeds**. Neither gain exceeds
the noise floor, and neither is consistent in sign. The `mrr` improvement in §4 is
seed 7's result and does not replicate.

**The original defect is narrowed, not eliminated.** BM25 has perfect `recall@5` on
`high`, and neither learned ranker matches it on every seed: the dense model
regresses on 5 of 6 seeds, the fused ranker on 4 of 6 (min 0.9583 against BM25's
1.0000). Fusion makes the regression less frequent and less severe. It does not
make it go away.

That the two claims differ is the reason the report states both. A summary quoting
only the mean `mrr` gain would read as a win; a summary quoting only the seed table
would bury the one property that does hold everywhere.

### 5.3 Training-set size

The model is trained from scratch, so how much data it sees matters more than it
would for a fine-tuned base. Vocabulary held constant at the full training
vocabulary, so the only variable is the number of training triples:

| training queries | triples | mrr | recall@5 |
|---|---|---|---|
| 48 (released protocol) | 48 | 0.849702 | 0.9583 |
| 42 | 42 | 0.695238 | 0.8333 |
| 36 | 36 | 0.572487 | 0.6667 |
| 30 | 30 | 0.374074 | 0.5417 |
| 24 | 24 | 0.178968 | 0.2500 |
| 18 | 18 | 0.162434 | 0.2083 |

`mrr` falls 0.687269 across the range, and more than a third of it is gone by 36
queries. Losing a quarter of the training queries costs roughly a third of the
score. The released number is therefore not merely a single seed — it is also the
score at the largest training set available, and there is no evidence here about
how it behaves between 48 queries and the thousands a real corpus would have. The
direction is encouraging; the magnitude is unmeasured.

## 6. What this pass does not establish


### The accepted `mrr` improvement did not replicate

The headline weakness of this pass, and it is a weakness in the *result*, not just
in the reporting. Fusion was accepted at seed 7 on an `mrr` gain that reverses on
some seeds and never clears the seed-to-seed spread. The one property that does
replicate — `recall@5` never falling below the dense model — is a smaller claim than
"the fusion improves retrieval", and it is the claim that should be quoted.

The lesson generalises past this experiment: **a single-run accept/reject ledger
cannot establish robustness.** `ExperimentLedger` decides whether one measurement
beat a frozen baseline, which is exactly what it should do and all it can do.
Whether that beat is reproducible is a different question requiring replication
across seeds, and no amount of care inside a single run substitutes for it. A
ledger verdict is a hypothesis about the world until it is replicated.

### The verdict is knife-edge by construction

With 24 evaluation queries, **one query is 4.17%** and the recall tolerance is 5%.
A single judgement flipping therefore consumes 83% of the entire tolerance budget,
and the difference between the rejected variant and the accepted one is two
judgements. The accept/reject boundary is enforcing something real, but it is
being enforced on a sample small enough that one query decides it. Read the
`recall@5` figures as 23/24 and 22/24, not as decimals.

### `w=0.5` was chosen a priori, and that choice is load-bearing

`0.5/0.5` is equal trust in lexical and dense evidence — a defensible prior, and
the reason it was selected. But the table in §5 was produced by sweeping three
weights, and `0.5` is the best of them on the two conditions reported in §4. That
is a selection performed by someone who had already seen the results, and it should
be treated as such. The sweep is published in full so the landscape is visible
rather than only the winner.

### One measurement artefact was found and corrected mid-pass

The first run of this cycle built the BM25 index inside the per-query ranking
closure, so the index was rebuilt on every call. That reported the lexical baseline
at 4.119 ms per query instead of 0.0242 ms — roughly two orders of magnitude high —
and would have handed the fused ranker a latency comparison it had not earned. The
cause was in the cycle driver, not in `fabric`: `Pipeline` builds the index once.
It was fixed, the cycle was re-run, and the verdicts did not move, because they
were decided on `mrr` and `recall@5` rather than on timing. The corrected latencies
are the ones printed above, and `0.0242 ms` agrees with the `0.0198 ms` recorded
independently in `docs/06-benchmarks.md`.

This is recorded rather than quietly fixed because it is the failure mode the
benchmark rules exist to prevent: a rigged comparison does not have to be dishonest
to be wrong, and the first version of this document would have reported a slow
baseline that was an artefact of the harness.

### The fusion's recall is bounded by its first stage

A fused ranker can only return documents its component retrievers surfaced. Its
recall ceiling is the union of the components' candidate sets, which is why the
number of candidates is a recorded setting (`top_k`) and not an implicit default.
This is an architectural property of retrieve-then-fuse, not a defect, but it means
the reported `recall@5` is partly inherited rather than learned.

### Untested at scale

Everything here is measured on a 96-document synthetic corpus with 24 evaluation
queries on a two-core, GPU-less host. The mechanism — an untrained `<unk>`
embedding — is general and would be diagnosed the same way on a larger corpus, but
the *magnitudes* are not transferable, and no claim is made that they are. The
training-size sweep in §5.3 is the clearest evidence of how little of the
data-scaling behaviour has actually been observed.

### Six seeds is not a distribution

The replication sweep fixes six seeds, which bounds the spread loosely and cannot
support a confidence interval or a significance test. The seed values are pinned so
the measurement is reproducible, not because six is a sufficient sample. Anyone
extending this should treat the spread as indicative and the rank of the released
seed (4th of 6) as a single draw from it.

## 7. Reproducing this

```bash
cd services/fabric
python scripts/sparsiz_cycle.py --json cycle.json   # the cycle and its verdicts
python scripts/robustness.py   --json robust.json   # the seed, size and paired axes
```

`npm run cycle` and `npm run robustness` from the repository root do the same. Both
need only NumPy.

Deterministic under the recorded seeds (`data_seed=1`, `model_seed=7`) apart from
`latencyMs`, which is a timing measurement and is noise-floored in the spec so that
sub-millisecond differences cannot decide a verdict. The cycle's decisions are
pinned by `tests/test_sparsiz_cycle.py`, whose first assertion is the negative
control: the dense retriever must still be rejected, and for the same reason.

## 8. What changed in the codebase

| Change | File | Recorded status |
|---|---|---|
| Hybrid rank fusion | `services/fabric/fabric/hybrid.py` | Implemented and tested (29 tests) |
| Cycle driver | `services/fabric/scripts/sparsiz_cycle.py` | Implemented and tested (16 tests) |
| Robustness measurement (seed, size, paired axes) | `services/fabric/scripts/robustness.py` | Implemented and tested (21 tests) |
| Fusion + decision tests | `services/fabric/tests/test_hybrid.py`, `test_sparsiz_cycle.py` | Implemented and tested |
| Validation split for selection | `services/fabric/fabric/dataset.py` (`split_fit_validation`) | Implemented and tested (16 tests) |
| Selection protocol fix | `services/fabric/fabric/pipeline.py` (`base_selection`) | Implemented and tested; artifact unchanged |

The fusion is **not** wired into the released model artifact as a replacement for
it. `aetheris-lite-retriever@0.1.0` remained the released retriever and its recorded
digests are unchanged; this pass produced an accepted *candidate* improvement and
the regression cases that guard it. Promoting it would be a separate, versioned
release decision — see [`docs/model-cards/`](./model-cards/). (0.1.0 has since been
superseded by `0.1.1` for the tokenizer correction in the erratum below; the fusion
remains unpromoted.)

## 9. L4: does the lesson generalise across task families?

§5 asked whether the accepted fusion weight survived more seeds. It did not. This
section asks the question one level up, which is the question Level 4 of the learning
model is defined by: **a strategy that wins on one family of tasks — is it still the
winner on tasks it was never selected on?**

The protocol was written down and committed *before* it produced a number
(`services/fabric/fabric/transfer.py`, five strategies, thresholds, baseline and
verdict vocabulary), because a transfer test whose rules are chosen after seeing the
results cannot report a non-transfer. Those rules are not tuned below; the run
reported here is the run that protocol describes.

### 9.1 Protocol

Five candidates, all ranking the same queries with the same two component rankings
inside each seed:

| Strategy | Lexical weight | What it reads as |
|---|---|---|
| `lexical-only` | 1.0 | the baseline the corpus was built around |
| `dense-only` | 0.0 | the failure that started §1 |
| `equal-trust` | 0.5 | the a-priori choice from §4 — **the baseline for this test** |
| `coverage-weighted` | share of the query the index can match | the §4 failure read forwards |
| `coverage-inverse` | the complement | the same failure read backwards |

- Primary metric `mrr`; secondary `recall@5`, recorded for every cell.
- A candidate is a **lesson** only if its mean *paired* gain over the baseline is
  ≥ 0.01 **and** every seed moves the same direction. (Reason, recorded in §5.2: an
  accepted mean gain here already reversed in 3 of 3 re-runs once.)
- Selection sees **one family only**: `development-low` — 12 of the 24 topics, taken
  as every second topic of the sorted list, under the harder low-overlap condition.
- The other three cells are held out, and they separate two different kinds of shift:
  same topics with the condition changed (`development-high`), different topics with
  the condition unchanged (`held-out-low`), and both at once (`held-out-high`).
- Eight seeds (11–88). Each seed generates its own corpus, trains its own encoder and
  builds its own index; every strategy is scored on that same encoder and index, so a
  paired difference cannot come from one strategy drawing a better model.

### 9.2 Result: no lesson was available to transfer

`development-low`, 8 seeds, mean `mrr` and paired difference against `equal-trust`:

| Rank | Strategy | mean mrr | Δ vs baseline | seeds up/down/tie |
|---|---|---|---|---|
| 1 | `equal-trust` (baseline) | **0.8421** | — | — |
| 2 | `coverage-weighted` | 0.8088 | −0.0334 | 2 / 5 / 1 |
| 3 | `dense-only` | 0.7633 | −0.0788 | 1 / 6 / 1 |
| 4 | `coverage-inverse` | 0.7404 | −0.1017 | 0 / 8 / 0 |
| 5 | `lexical-only` | 0.4750 | −0.3672 | 0 / 8 / 0 |

The a-priori baseline is the best strategy on the family it was chosen for, and
**every candidate is worse**. No candidate cleared the bar, so the protocol recorded
`no_lesson` and had nothing to transport. The three held-out families were still
measured; they are reported as **observations**, which is a different label from a
transfer and never gets promoted to one.

### 9.3 Observations on the held-out families

Mean paired difference against `equal-trust`, primary (`mrr`) and secondary
(`recall@5`):

| Family | Strategy | Δ mrr | seeds up/down/tie | Δ recall@5 | seeds up/down/tie |
|---|---|---|---|---|---|
| `development-high` | `coverage-weighted` | −0.0079 | 2 / 5 / 1 | −0.0104 | 1 / 2 / 5 |
| `development-high` | `coverage-inverse` | −0.0138 | 4 / 3 / 1 | +0.0104 | 2 / 1 / 5 |
| `development-high` | `dense-only` | −0.0600 | 0 / 8 / 0 | −0.0729 | 0 / 5 / 3 |
| `development-high` | `lexical-only` | −0.1482 | 1 / 7 / 0 | **+0.0208** | 2 / 0 / 6 |
| `held-out-low` | `coverage-weighted` | **+0.0003** | 5 / 2 / 1 | −0.0104 | 1 / 2 / 5 |
| `held-out-low` | `dense-only` | −0.0262 | 3 / 5 / 0 | −0.0417 | 0 / 4 / 4 |
| `held-out-low` | `coverage-inverse` | −0.0722 | 0 / 8 / 0 | −0.0417 | 1 / 5 / 2 |
| `held-out-low` | `lexical-only` | −0.2988 | 0 / 8 / 0 | −0.1250 | 1 / 7 / 0 |
| `held-out-high` | `coverage-weighted` | +0.0063 | 4 / 2 / 2 | −0.0208 | 0 / 2 / 6 |
| `held-out-high` | `dense-only` | −0.0083 | 3 / 4 / 1 | −0.0312 | 0 / 3 / 5 |
| `held-out-high` | `coverage-inverse` | −0.0280 | 1 / 6 / 1 | −0.0104 | 0 / 1 / 7 |
| `held-out-high` | `lexical-only` | −0.1992 | 0 / 8 / 0 | −0.0417 | 1 / 4 / 3 |

Five readings, in the order they matter:

1. **The best strategy is family-dependent, and the margin is noise.** The ranking
   order changes between families: `coverage-weighted` is 2nd on `development-low`,
   2nd on `development-high` and 1st on both held-out families — by **+0.0003** on
   `held-out-low` (5 seeds up, 2 down, 1 tie) and **+0.0063** on `held-out-high`.
   Both are below the 0.01 bar and both have seeds against them: had a lesson existed,
   these would have been `inconclusive`, not `transferred`. Reading the third decimal
   of a mean as a finding is exactly what the paired per-seed counts are here to stop.
2. **The coarse conclusion reproduces; the fine one does not.** `lexical-only` is
   worse than the fused baseline on `mrr` in **8 of 8 seeds on all four families**
   (−0.15 to −0.37). `dense-only` is worse in 8/8 on both low-overlap families and 3
   up / 4 down / 1 tie on `held-out-high`. So §4's mechanism — fuse a ranker that
   keeps recall with one that orders well — holds up. *Which* weights fuse best does
   not, at this scale.
3. **The winner is not even stable inside the selection family.** Across the eight
   seeds on `development-low`, the top strategy is `equal-trust` 4 times,
   `coverage-weighted` twice, `dense-only` once, and a three-way tie once (seed 66,
   three strategies at 0.9583). A method that reported "the best strategy" from one
   seed would have reported a coin flip.
4. **The secondary metric would have picked a different winner.** On
   `development-high`, `lexical-only` is *above* the baseline on `recall@5`
   (+0.0208, no seed against) while being the worst strategy on `mrr` by −0.1482. Had
   `recall@5` been the selection metric, the run would have declared a lesson for the
   strategy that *is* the problem this pass started from. That is the argument for
   pinning one metric in advance, made by the data rather than by policy: verdicts
   here are computed from the primary metric only, and the secondary is reported.
5. **Nothing was tuned afterwards.** The serving configuration is unchanged. The
   released retriever and the a-priori 0.5/0.5 fusion stay exactly as they were; what
   changed is that there is now a measured reason to keep the a-priori choice instead
   of replacing it with the more interesting-looking one.

### 9.4 What this does not establish

- **These are not semantic domains.** The two families are interleaved halves of the
  24 generated topics: different topics, but from one generator and one vocabulary
  distribution. "Unseen family" here is weaker than "unseen domain", and this is the
  largest limitation of the pass.
- **Fixture scale.** 96 documents, 72 queries (48 training, 24 evaluation per
  condition), a ~326-term vocabulary, 18,784-parameter encoder, 2 CPU cores, no GPU.
- **Seeds bundle corpus and model variance.** The data seed and the model seed are the
  same value, so a seed varies both at once — the same limitation §5.2 records.
- **Direction counts, not a hypothesis test.** No confidence intervals and no
  multiplicity correction. The bar (mean ≥ 0.01 and 8/8 agreement) was set
  conservatively enough that it does not need one, and it still rejected everything.
- **`mrr` at this size is not precise.** The rankings move by thousandths between
  seeds; the honest summary is that the four fusion policies are indistinguishable
  here, not that one is best.

### 9.5 Reproducing

```bash
cd services/fabric
python scripts/l4_transfer.py                              # 8 seeds, ~4 s
python scripts/l4_transfer.py --json ../docs/experiments/l4-transfer.json
python scripts/l4_transfer.py --quick                      # 3 seeds, 8 epochs: smoke only
python -m pytest tests/test_transfer.py -q                 # 27 tests
```

The recorded run is [`docs/experiments/l4-transfer.json`](./experiments/l4-transfer.json):
every cell (family × seed × strategy × metric), the protocol block, the hardware and
the notes. `tests/test_transfer.py` pins the decision procedure, including the cases
where it must *refuse* a conclusion — a lesson that reverses in one seed must not
become one, target data must not reach selection, and observations must never be
labelled as transfers.

## Erratum (2026-10-25): tokenizer correction re-baselines this cycle

The stemmers (Python `fabric/text.py`, JavaScript `knowledge/text.mjs`) previously
dropped the parts of a hyphenated term from the stemmed token stream, so an
untrained compound was entirely out of vocabulary. Both now emit the stemmed parts
alongside the compound — a correctness fix for retrieval, pinned by a cross-language
parity fixture. Every measurement in §§4–5 above was taken under the old token
stream and is left as recorded history; the current pipeline measures differently:

- The released configuration now measures **MRR 0.787269** (was 0.849702) at `low`
  overlap. The retriever model card records this as a dated correction: the card is
  the record of the released weights at their training revision, and the current
  pipeline no longer reproduces them bit-for-bit.
- On `high`, the dense retriever alone now measures MRR 0.9074 with recall@5
  0.9583 against BM25's 1.0000 — a regression of 0.0417, **inside** the ledger's
  5% tolerance, where the historical run measured 0.9167 and was rejected. The
  ledger therefore **accepts** the dense-alone experiment on this condition today.
  The §4 negative control is not weakened by this: the ledger's recall enforcement
  is pinned at the mechanism level (`test_experiments.py` — a target gain that
  regresses a guarded metric is rejected) and end-to-end by the forced-verdict
  release gate (`test_pipeline.py`). What changed is the benchmark outcome, not
  the rule. One of the two captured failures on `high` no longer occurs.
- §5.2's "not robust" verdict on the fusion's `mrr` gain no longer holds on
  `high`: the mean paired gain is now +0.0277 against a dense-MRR seed stdev of
  0.0263, positive on all six seeds — a gain that exceeds the seed spread, but
  only just. The robust half of §5.2 is unchanged: fused recall@5 is never below
  dense. The dense ranker now regresses against BM25's perfect recall on 6 of 6
  seeds and the fused ranker on 5 of 6 (was 5 and 4).

Re-running `scripts/sparsiz_cycle.py` and `scripts/robustness.py` reproduces the
new figures deterministically; the recorded-outcome tests in
`tests/test_sparsiz_cycle.py` and `tests/test_robustness.py` were re-baselined to
them with this note as the reason. Nothing in the ledger's rules, tolerances or
release floors changed.

**Addendum (2026-10-27).** The card has been re-issued as
[`aetheris-lite-retriever@0.1.1`](./model-cards/aetheris-lite-retriever-0.1.1.md),
generated at `00dcb35` — the first committed revision containing the tokenizer
correction, so its recorded `codeRevision` is a revision from which the weights
actually reproduce. The pipeline's default `model_version` is now `0.1.1`. The
0.1.1 card reports the same configuration's lower ordering scores and a worse
held-out-topic result (MRR 0.012346 against 0.1.0's 0.093673); both are printed
on the card, not summarised away.
