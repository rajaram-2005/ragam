# Aetheris Fabric

Training, evaluation and experiment control for Aetheris Omni. The Sparsiz
lineage of the platform, and an **internal** service: it is reached through the
five product areas, never presented as one of them.

## What it does

| Module | Responsibility |
| --- | --- |
| `fabric/taxonomy.py` | Failure categories, root causes, benchmark categories — adopted from Sparsiz |
| `fabric/text.py` | Tokeniser and stemmer, mirroring `services/core/src/knowledge/text.mjs` exactly |
| `fabric/bm25.py` | The BM25 baseline, ported from `services/core/src/knowledge/bm25.mjs` |
| `fabric/dataforge.py` | Deterministic data quality scoring, dedupe, splitting, contamination checking |
| `fabric/dataset.py` | Generated retrieval corpus with BM25-mined hard negatives |
| `fabric/dual_encoder.py` | The Aetheris Lite retriever, trained from scratch on NumPy |
| `fabric/hybrid.py` | Rank fusion of the lexical and dense retrievers |
| `fabric/dataset.py::split_fit_validation` | Fit/validation split so selection never touches the evaluation set |
| `fabric/metrics.py` | Recall@k, MRR, nDCG@k, hit rate |
| `fabric/experiments.py` | The improvement cycle and its accept/reject ledger |
| `fabric/failure_memory.py` | `E_{t+1} = E_t ∪ F_t` — validated failures become regression cases |
| `fabric/modelcards.py` | Versioned cards, validation gate, promotion, rollback |
| `fabric/run.py` | Run records: config, seeds, dataset digest, revision, resources, hashes |
| `fabric/pipeline.py` | The eight stages, each reporting its own status |
| `fabric/server.py` | Thin HTTP surface |

## Requirements

Python ≥ 3.11 and **NumPy only**. NumPy is the sole runtime dependency, and that
is deliberate — see *What cannot run here* below.

```bash
python -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
pytest                     # 256 tests
python -m fabric.server    # http://127.0.0.1:8791
```

## The pipeline

```
Data Validation → Base Selection → Domain Training → SFT
  → Preference Optimization → Distillation → Evaluation → Release
```

Each stage reports its own `StageStatus`. On a host with no GPU and no route to
model weights, `sft`, `preference_optimization` and `distillation` return
`blocked_needs_weights` and say what would be needed. They are never reported as
completed, and a run containing one is marked `partial`.

## Measured result on this host

Two CPU cores, 3.9 GB RAM, no GPU, Python 3.11.2, NumPy 2.1.3. Generated fixture
corpus: 96 documents over 24 topics, held-out queries as tabulated below.

| Condition | Held-out queries | BM25 MRR | Trained MRR | Untrained control |
| --- | --- | --- | --- | --- |
| low lexical overlap, split by query | 24 | 0.335 | **0.850** | 0.050 |
| high lexical overlap, split by query | 24 | 0.767 | **0.889** | 0.024 |
| low lexical overlap, split by **topic** | 18 | 0.382 | 0.094 | 0.048 |

Reproduce with `python -m pytest tests/test_pipeline.py -q`, or measure directly:
`Pipeline(PipelineConfig(epochs=25)).run()` reports all three conditions in its run
record.

The untrained control — same architecture, same seed, no training — is what makes
the gain attributable to training rather than to the initialisation.

The third row is a **failure, reported deliberately**. When entire topics are held
out, their vocabulary is unseen and the generated topics share only ~21% of terms,
so there is no shared substructure to generalise through. The dense model loses
badly to BM25. That condition is not how a retriever is deployed (the corpus is
always indexed before queries arrive), but the result is recorded rather than
hidden by choosing the flattering split.

No comparison is made against Mistral, Qwen, Llama, Gemma or DeepSeek. None can be
installed here, so no claim about them is made or implied.

## What cannot run here

Recorded as `blocked_needs_weights` / `blocked_needs_hardware`, not stubbed:

* Real LoRA/QLoRA fine-tuning — needs a base checkpoint and a GPU.
  `huggingface.co` and `download.pytorch.org` are both unreachable from this host.
* Distillation — needs a teacher model.
* Preference optimization — needs paired preference data, a reward signal, and the
  compute to justify it. Upstream `sparsiz` simulated this step with `random`
  values; simulating it here would produce a number that looks like a result.
* Local video generation and local LLM inference — see `services/core`.

## Provenance

The taxonomies, the `Q(x)` quality formula, the tier thresholds and the
no-regression rule come from [`sparsiz`](https://github.com/rajaram-2005/sparsiz)
(Unlicense / public domain). Upstream *computed* its quality terms and benchmark
scores with `random.uniform`; every number here is measured. See
`../../third-party/NOTICES.md` and `../../docs/01-audit.md`.
