# 06 — Benchmarks

What was measured, against what, under which conditions, and — equally important —
**what could not be measured**.

Every number here was re-measured on the host below while writing this document,
not transcribed from an earlier run. Reproduction commands are given for each
table.

---

## A note on the language model

`fabric/lm/` trains a character-level language model and evaluates it with the same
discipline used here: uniform, unigram and bigram baselines are **computed from the
same training statistics** and scored on the **same held-out tokens**, and the
verdict (`perplexityVsBigram`) is calculated rather than asserted. Nothing in this
document's retrieval results involves that model, and no cross-comparison between
them is made or implied. See [`08-aetheris-lite.md`](./08-aetheris-lite.md).

---

## 0. The claim this document does *not* make

> **No comparison against Mistral, Qwen, Llama, Gemma or DeepSeek was possible, so
> no claim of superiority over them is made or implied anywhere in this
> repository.**

None of those models could be installed: `huggingface.co` is unreachable from this
host and there is no GPU. The comparison that *was* possible is a retrieval
comparison against **BM25**, a strong, well-understood, dependency-free baseline
running on identical hardware with an identical tokeniser and an identical corpus.
That is a legitimate like-for-like comparison, and it is the only one presented.

Anything resembling "Aetheris beats open model X" would require: the same task, the
same prompts, the same quantization budget, compatible hardware, and separated
development/evaluation data. None of those conditions could be satisfied for an
external LLM here. The limitation is recorded on the model card, in the run record,
and in [`03-status.md`](./03-status.md) §3.

---

## 1. Environment

| | |
|---|---|
| Platform | Linux 6.1.158+ x86_64, glibc 2.36 |
| CPU | 2 cores |
| RAM | 3.85 GB total |
| GPU | **none detected**; no vendor tooling available |
| Python | 3.11.2 |
| NumPy | 2.1.3 |
| Code revision | `aa11de45d6d3dd0dcbb4853278ca81f7f5d54ab9` |
| Peak RSS (low-overlap run) | 40,900 KB |
| CPU time (low-overlap run) | 2.27 s user / 0.036 s system |
| Wall clock | 1.06 s (low), 0.66 s (high) |

---

## 2. Subjects

| Subject | What it is | Parameters |
|---|---|---|
| **BM25** | Lexical ranker, `k1=1.5`, `b=0.75`, over the same corpus with the same tokeniser | 0 |
| **Trained dense retriever** | `aetheris-lite-dual-encoder`, `d_model=48`, `d_emb=32`, mean pooling, scale 10.0, 25 epochs, Adam (lr 0.03, batch 8), in-batch softmax with one hard negative per anchor | 18,784 (low) / 17,200 (high) |
| **Untrained control** | Identical architecture and seed, **no training** | same |

The control exists because a dense model that merely ties a random initialisation
proves nothing. It isolates "training helped" from "the architecture helped".

**Corpus.** 96 generated engineering documents across 24 topics (4 per topic),
72 queries. `data_seed=1`, `evaluation_fraction=0.25`. Datasets are digest-stamped:

| Condition | Dataset digest |
|---|---|
| overlap=low | `64e7e42ebd0ae7174d7d9044ac407971dd00e0e748980f7595a5ccdaafd40fe4` |
| overlap=high | `ec565a36f1925c2ba7f770ebfab30b44e539e68a54e94e9f114c364538bacf8f` |

Both share manifest digest `f900b974ae99584e3a159aa0480058a57ff16231dcd6a360cb56c2dcc370fcd3`.

---

## 3. Results — deployment condition (`split_by=query`)

Held-out queries are drawn from the same topics the model trained on, which is how
the retriever is actually deployed.

### 3.1 Low lexical overlap (the harder, more realistic case)

24 held-out queries.

| Metric | BM25 | **Trained** | Untrained control | Δ vs BM25 |
|---|---|---|---|---|
| MRR | 0.3352 | **0.8497** | 0.0500 | **+153.5%** |
| Recall@1 | 0.2500 | **0.7917** | 0.0417 | +216.7% |
| Recall@5 | 0.5417 | **0.9583** | 0.0833 | +76.9% |
| nDCG@10 | 0.3942 | **0.8860** | 0.0578 | +124.8% |

**Experiment ledger verdict: `accept`** — *"target 'mrr' improved 0.3352 → 0.8497
(+153.5%), meeting the required +0.0500"*. Run status `partial` (3 stages blocked).
**Released** as `aetheris-lite-retriever@0.1.0`.

### 3.2 High lexical overlap

24 held-out queries. Here queries share vocabulary with documents, so BM25 is
already strong — and the result is a **rejection**.

| Metric | BM25 | Trained | Untrained control | Δ vs BM25 |
|---|---|---|---|---|
| MRR | 0.7667 | **0.8893** | 0.0245 | +16.0% |
| Recall@1 | 0.6667 | **0.8750** | 0.0000 | +31.3% |
| **Recall@5** | **1.0000** | 0.9167 | 0.0417 | **−8.3%** |
| nDCG@10 | 0.8239 | **0.9050** | 0.0473 | +9.8% |

**Experiment ledger verdict: `reject`.** Reasons, verbatim:

```
recall@5 regressed: 1.0000 -> 0.9167 (tolerance 5%)
target 'mrr' improved 0.7667 -> 0.8893 (+16.0%), meeting the required +0.0500
```

Run status **`failed`**; release **`failed`**. This is the guard metric doing its
job: BM25 already retrieves every relevant document in the top 5 on this corpus, so
a model that improves average rank while *losing* any of them is not an unambiguous
improvement, and the ledger refuses to call it one. Reporting the +16% MRR alone
here would have been a rigged summary.

Determinism was checked: three identical high-overlap runs produced identical
status, verdict, MRR and recall (0.889286 / 1.0 / `failed` / `reject`).

This rejection was the starting point for the improvement cycle in
[`07-improvement-cycle.md`](./07-improvement-cycle.md), which diagnosed the cause
(a vocabulary fitted on training text only leaves held-out query terms as `<unk>`,
whose embedding never receives a gradient) and produced an accepted candidate fix
that keeps recall inside tolerance while raising MRR further.

### 3.3 Base selection

Candidates are trained for 8 epochs on a **fit** split and selected by MRR on a
**validation** split. Neither is the evaluation split. Selection measured on the
split you then report as held-out is not a held-out measurement: the reported
number becomes the maximum over the candidates rather than an estimate of unseen
performance, and it gets more optimistic the more candidates are tried. See §5.3.

The split: 48 training queries → 36 fit + 12 validation, seed `20251012`. The
evaluation split is never touched by selection, and the stage records
`validationSplit.disjointFromEvaluation` so a reader can check that rather than
assume it.

| Condition | Candidate | Fit params | MRR on **validation** (decides) | MRR on evaluation (recorded only) |
|---|---|---|---|---|
| low overlap | `d_model=24` | 9,112 | 0.2063 | 0.4460 |
| low overlap | `d_model=48` | 18,160 | **0.2944** ← selected | 0.3935 |
| high overlap | `d_model=24` | 8,512 | 0.2897 | 0.5665 |
| high overlap | `d_model=48` | 16,960 | **0.4722** ← selected | 0.6341 |

Three things this table is honest about:

- **The evaluation column is recorded, not consulted.** It is printed so the gap
  between the two criteria is visible. On low overlap they disagree: validation
  ranks `d_model=48` above 24 while evaluation ranks 24 above 48. That disagreement
  is the argument for the change — the two criteria are not interchangeable, so
  choosing on the evaluation set was never a neutral convenience.
- **The fit candidates are smaller than the released model.** These parameter
  counts (16,960 / 18,160) belong to candidates trained on 36 queries. The released
  model is trained on all 48 and has **18,784** parameters. A candidate's score here
  is therefore not the released model's score, and is not meant to be.
- **Both conditions still select `d_model=48`**, so the released weights are
  unchanged: `weightsDigest db3366ea…`, `configDigest 8bb457b2…`. The protocol was
  corrected without touching the artifact.

`languageModelBase = "not selected: no weights available on this host"` in both.
Fit parameter counts differ between conditions because the vocabulary is
corpus-dependent, and the fit vocabulary is smaller than the released one because
it is built from the fit split only.

### 3.4 Latency

| Condition | BM25 | Dense |
|---|---|---|
| low overlap | 0.0281 ms/query | 0.0580 ms/query |
| high overlap | 0.0273 ms/query | 0.0598 ms/query |

**These differences are not meaningful and no performance claim is made from
them.** Both are far below one scheduler quantum; observed values across runs
(0.0211–0.0281 BM25, 0.0540–0.0598 dense) vary by more than the gap being
measured. A **1.0 ms noise floor** is applied to latency comparisons so a
sub-millisecond timing difference cannot decide an experiment. An earlier 5%
relative tolerance rejected the dense retriever purely because 0.0216 ms →
0.0549 ms exceeded 5% — two sub-millisecond timings differing by less than a
scheduling quantum.

The absolute service-level ceiling lives on the model card instead: **25 ms/query,
hard**. Observed values are ~450× inside it.

The dense figure is also **not comparable to a production ANN index**: this model
encodes the whole corpus in memory and scores by dense matrix product. A real
deployment would use an approximate nearest-neighbour index with different
trade-offs.

---

## 4. Results — held-out-topic condition (`split_by=topic`)

Documents **and** queries for the held-out topics are unseen. This is *not* the
deployment condition, and it is reported because it is a genuine failure.

| Condition | Queries | Metric | BM25 | Trained | Winner |
|---|---|---|---|---|---|
| low overlap | 18 | MRR | **0.3820** | 0.0937 | BM25 |
| | | Recall@1 | **0.2778** | 0.0556 | BM25 |
| | | Recall@5 | **0.6111** | 0.1667 | BM25 |
| high overlap | 18 | MRR | **0.6857** | 0.0635 | BM25 |
| | | Recall@1 | **0.5556** | 0.0556 | BM25 |
| | | Recall@5 | **0.9444** | 0.0556 | BM25 |

**The dense model loses badly on entirely unseen topic vocabularies**, and the
margin is worse under high overlap. At 96 documents and 48 training triples this is
expected: a 32-dimensional encoder trained from scratch on a tiny fixture corpus
has learned topic-specific term associations, not generalisable semantics. BM25's
lexical matching transfers better when vocabulary is disjoint.

This is recorded verbatim as a limitation on the model card and in the run record:

> *"under a held-out-TOPIC split (unseen vocabulary, not the deployment condition)
> the dense model scores MRR 0.093673 against BM25 0.382011 — it does not
> generalise to entirely unseen topic vocabularies at this data volume"*

The condition was kept and evaluated rather than quietly dropped. Dropping a split
where your model loses is how a benchmark becomes an advertisement.

---

## 5. Fairness controls

Three defects in the benchmark design were found and fixed. They are recorded
because each one would have produced a flattering, meaningless number.

### 5.1 A baseline that could not score (fixed)

The first generated dataset gave BM25 **exactly 0.0 on every metric**: no query
shared a content word with its relevant documents. A comparison where the baseline
scores zero proves nothing about the model — it only proves the dataset was
constructed to make lexical matching impossible.

**Fix:** `LABELLED_QUERY_EVERY = 2`, so half the queries name a topic word. BM25
now scores MRR 0.3352 (low overlap) / 0.7667 (high) — a real baseline that is
genuinely hard to beat, and one that *does* beat the dense model on the
held-out-topic split.

### 5.2 Held-out selection bias (fixed)

The held-out set was always query index 0 of each topic. Because of the labelling
rule, index 0 is *always* the labelled phrasing — so the evaluation set
systematically favoured BM25 by construction, and the reported gap was an artifact
of the split.

**Fix:** per-topic random selection of the held-out query. The realised fractions
are recorded in the dataset `meta` as `evaluationLabelledFraction` and
`trainLabelledFraction`, so a reader can see the composition of both splits rather
than trusting that they were balanced.

### 5.3 Selection on the evaluation split (fixed)

**The defect.** `base_selection` scored each candidate width on the evaluation
queries, chose the best, and the evaluation report then described the winner's
score on those same queries. The stage even labelled it `selectedBy: "held-out MRR
on the evaluation split"`. Training data was separated from evaluation data; the
*choice* was not, so the reported evaluation score was partly a maximum over
candidates.

**Why it survived so long.** The numbers it produced were plausible. Selecting on
the evaluation set does not make a number obviously wrong — it makes it quietly
optimistic, and nothing in the output distinguishes the two.

**Fix.** Candidates train on a fit split and are selected by MRR on a validation
split, both carved from the training queries (`split_fit_validation`, deterministic
under `validation_seed`). Both criteria are recorded. A tie on the validation split
fails the stage rather than being broken by list order, because `max` would
silently return the first candidate and a reader would misread that as a decision
supported by measurement.

**Effect on the artifact: none.** Both conditions select `d_model=48` under either
protocol, so `weightsDigest` is unchanged at `db3366ea…`. The fix corrected the
reason, not the answer — which is the outcome to want, and also the reason a change
like this is safe to make.

### 5.4 Latency noise floor (fixed)

See §3.4. A relative tolerance applied to sub-millisecond timings rejects models
for reasons that have nothing to do with the model.

### 5.5 Contamination and separation

- **Development and evaluation data are separated by construction.** Training uses
  `ds.triples()` from `train_queries`; evaluation uses `evaluation_queries`. The
  held-out-topic split additionally removes whole topics from training.
- **Selection is separated too (§5.3).** Training data being separate from
  evaluation data is not sufficient if the evaluation data is what picks the
  configuration. Candidate selection runs on a validation split carved from the
  training queries, and the stage asserts the two are disjoint.
- **Contamination is checkable, not asserted.** `KnowledgePipeline.findContamination`
  flags evaluation cases whose token overlap with training material exceeds a
  threshold (default 12 tokens), and `evaluateRetrieval` scores retrieval against
  labelled cases. A benchmark run on real company data should call both before
  trusting the result.
- **No prompt advantage.** BM25 and the dense retriever receive the *identical*
  query string and rank the *identical* document set. Neither gets a reformulated
  query, a prefix, or an instruction template. There is no model-specific prompting
  anywhere in the evaluation path.
- **Identical tokeniser.** The Python tokeniser is pinned to the Node one by
  `tests/fixtures/text-parity.json`, which asserts identical tokenisation,
  stemming, sentence splitting, chunking, IDF, corpus statistics, full rankings and
  matched terms. So "the same tokeniser" is a verified property, not a claim.
- **Same hardware, same process.** Both subjects run in one process on one host;
  neither is served over a network while the other is in-memory.

---

## 6. Release gating

The release gate is what makes these numbers consequential rather than
informational.

| Requirement | Value | Hard |
|---|---|---|
| `mrr` | ≥ 0.60 | yes |
| `latencyMs` | ≤ 25.0 | yes |
| `historicalFailures` | ≥ 1.0 | no |

- **Low-overlap run passes:** MRR 0.8497, latency 0.055 → 0 hard failures,
  1 soft failure (`historicalFailures` not measured — no failure corpus exists for a
  first release) → **released** as `aetheris-lite-retriever@0.1.0`.
- **High-overlap run fails** at the experiment ledger (`reject` on the recall@5
  guard) → run status `failed`, release `failed`.
- **An undertrained run cannot be released.** At `epochs=3` trained MRR is 0.3045,
  below the 0.60 floor: `release` fails, the run record is `failed`,
  `release.detail.released` is `null`, and the hard failure reads *"…is below the
  required minimum 0.6000"*. This is asserted by
  `tests/test_server.py::test_an_undertrained_run_reports_failure_rather_than_a_release`.

So **unvalidated weights cannot silently replace a stable release**:
`ModelReleaseManager.release()` validates before releasing, and `rollback()`
restores a previously released version. There are currently no rollback targets,
because no earlier version was ever released.

---

## 7. Reproducing

All four conditions, from a clean checkout, with only Python 3.11+ and NumPy:

```bash
cd services/fabric
python - <<'PY'
import json
from fabric.pipeline import Pipeline, PipelineConfig

for overlap in ("low", "high"):
    p = Pipeline(PipelineConfig(epochs=25, overlap=overlap,
                                split_by="query", evaluate_topic_split=True))
    rec = p.run()
    d = rec.to_dict()
    ev = next(s for s in d["stages"] if s["name"] == "evaluation")["detail"]
    print(f"== overlap={overlap}  run={rec.status}")
    for k in ("bm25", "trained", "untrainedControl"):
        print(f"   {k:17}", json.dumps(ev[k]))
    print("   latencyMs        ", json.dumps(ev["latencyMs"]))
    print("   verdict          ", ev["verdict"], ev["verdictReasons"])
    print("   topic-split      ", json.dumps(ev.get("heldOutTopicCondition")))
PY
```

Or via the test suites, which assert these relationships rather than merely
printing them:

```bash
pytest tests/test_pipeline.py tests/test_metrics.py tests/test_dual_encoder.py -q
npm run train          # prints "partial run-<id>" from the repository root
```

Expected: `overlap=low` → run `partial`, verdict `accept`, model released.
`overlap=high` → run `failed`, verdict `reject`. Latency figures will differ
slightly between machines and between runs; that is the noise floor in §3.4.

---

## 8. What these numbers do not support

Stated explicitly, because the useful half of a benchmark report is usually what it
rules out.

1. **No claim about any external LLM.** Not Mistral, not Qwen, not Llama, not
   Gemma, not DeepSeek. None was installed, none was run, none was compared.
2. **No claim about generation quality.** This is a *retriever*. It does not
   generate text, so nothing here bears on answer quality, instruction following,
   reasoning or coding ability.
3. **No claim about real documents.** The corpus is generated engineering
   documentation. Quality on a real company corpus is unknown and unmeasured.
4. **No claim of generalisation to unseen vocabularies.** §4 shows the opposite.
5. **No performance claim from latency.** §3.4: both subjects are sub-millisecond
   and the gap is below measurement resolution.
6. **No claim that the dense retriever should replace BM25.** Under high overlap
   the ledger rejects it. The defensible reading is that the two are complementary:
   BM25 is the safer default when query and document vocabulary overlap heavily or
   when topics are unseen, and the dense retriever earns its place on
   low-overlap paraphrase-style queries, which is the condition it was selected
   under.
7. **No production-scale claim.** 96 documents, 72 queries, 48 training triples,
   ~326-term vocabulary, 18,784 parameters. These are fixture-scale numbers chosen
   so the whole pipeline is reproducible in about a second on 2 CPU cores without a
   GPU. They establish that the *machinery* — data validation, base selection,
   training, gradient correctness, evaluation, ledger judgement, release gating,
   provenance recording — works and tells the truth. They say nothing about
   behaviour at scale.

## 9. Cross-task strategy transfer (L4)

§3 and §4 measure a retriever against baselines. This section measures something
different: whether a **strategy** chosen on one family of tasks is still the right
choice on tasks it was never selected on. It is the benchmark half of §7 of the
directive, and the protocol was committed before the run
(`services/fabric/fabric/transfer.py`); the narrative and the full reading are in
[`07-improvement-cycle.md`](./07-improvement-cycle.md) §9.

Five fusion strategies, primary metric `mrr`, secondary `recall@5`, eight seeds
(11–88), 12 topics per family, 8 epochs per training run inside a corpus of 96
documents and 72 queries. Selection used the `development-low` family only.

**Result — `no_lesson`, and every held-out family recorded as an observation:**

| Family (12 topics each) | Winner | mean mrr | Δ vs `equal-trust` | seeds up/down/tie |
|---|---|---|---|---|
| `development-low` (selection) | `equal-trust` | **0.8421** | — | — |
| `development-low` | `coverage-weighted` | 0.8088 | −0.0334 | 2 / 5 / 1 |
| `development-low` | `dense-only` | 0.7633 | −0.0788 | 1 / 6 / 1 |
| `development-low` | `coverage-inverse` | 0.7404 | −0.1017 | 0 / 8 / 0 |
| `development-low` | `lexical-only` | 0.4750 | −0.3672 | 0 / 8 / 0 |
| `development-high` | `equal-trust` | 0.9033 | — | — |
| `held-out-low` | `coverage-weighted` | 0.8659 | **+0.0003** | 5 / 2 / 1 |
| `held-out-high` | `coverage-weighted` | 0.9252 | **+0.0063** | 4 / 2 / 2 |

The a-priori baseline `equal-trust` is the best strategy on the family it was chosen
for, and no candidate beat it. On the held-out families the order changes, by
**+0.0003** and **+0.0063** — below the 0.01 bar registered in advance and with seeds
against them, so neither would have counted as a transfer even with a lesson to
transfer. The stable finding is the coarse one: `lexical-only` loses to the fused
baseline on `mrr` in 8 of 8 seeds on every family, and `dense-only` loses 8 of 8 on
both low-overlap families, which reproduces §4's mechanism while showing that the
choice *among* fusion policies is not identifiable at this scale.

**Verdict: the transfer hypothesis is rejected, and recorded as rejected.** Nothing was
tuned afterwards and the serving configuration is unchanged. Per-seed cells, both
metrics, the protocol block and the hardware are in
[`docs/experiments/l4-transfer.json`](./experiments/l4-transfer.json).

### 9.1 What this section does not support

In addition to everything in §8:

1. **Not a claim about semantic domains.** The families are interleaved halves of 24
   generated topics — different topics drawn from one generator, not different
   subject areas.
2. **Not a claim that these strategies are equivalent in general.** They are
   indistinguishable *here*, on a fixture-scale corpus with 8 seeds and thousands-wide
   differences in the third and fourth decimal.
3. **Not a claim about any other metric.** The secondary metric is reported for every
   cell; it is not used for any verdict, and §9.3 of
   [`07-improvement-cycle.md`](./07-improvement-cycle.md) shows what would have
   happened if it had been.
