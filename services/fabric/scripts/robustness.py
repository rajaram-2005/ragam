#!/usr/bin/env python3
"""Measure how stable the released retrieval numbers actually are.

The model card reports one number per metric. That is a single training run at a
single seed on a single corpus size, and a reader cannot tell from it how much the
number would move if any of those changed. This script measures that directly.

Two axes, because they answer different questions:

* **Seed** — same data, same configuration, different random initialisation. This
  bounds "how lucky was that run?" It is the cheap axis: nothing about the task
  changed.
* **Training-set size** — how many training queries the model sees. This bounds
  "how much does the result depend on the fixture being this size?" It is the
  axis that matters when someone asks whether the method would hold on a real
  corpus, and it is expected to fall: a dense retriever trained from scratch on
  fewer triples has less to learn from.

The vocabulary is held constant across the training-size sweep (built from every
training query, as the real pipeline builds it) so that the only variable is how
many triples the model trains on. Letting the vocabulary shrink too would conflate
data starvation with reduced vocabulary coverage, and the two have different fixes.

Nothing here is tuned or selected on. It reports what happened.

Usage::

    cd services/fabric
    python scripts/robustness.py                 # print the report
    python scripts/robustness.py --json out.json # and write it
    python scripts/robustness.py --quick         # fewer seeds, fewer epochs
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402

from fabric.dataset import build_dataset  # noqa: E402
from fabric.hybrid import fuse_rankings  # noqa: E402
from fabric.dual_encoder import DualEncoder, DualEncoderConfig, Vocabulary  # noqa: E402
from fabric.metrics import evaluate_ranker  # noqa: E402
from fabric.pipeline import PipelineConfig  # noqa: E402
from fabric.run import code_revision, hardware_profile  # noqa: E402

#: Seeds swept on the seed axis. Deliberately not the released seed alone: the
#: point is to see the spread, and one seed has no spread.
SEEDS: tuple[int, ...] = (7, 11, 13, 17, 23, 29)

#: How many training queries the model sees on the size axis, largest first.
TRAINING_SIZES: tuple[int, ...] = (48, 42, 36, 30, 24, 18)

#: Overlap conditions the paired comparison covers. ``high`` is the one whose run
#: was rejected, so it is the condition the fusion was introduced to repair.
PAIRED_CONDITIONS: tuple[str, ...] = ("high", "low")


def evaluate(model: DualEncoder, dataset, corpus: list[str], judgements: list[dict]) -> dict:
    vectors = model.encode_texts([document.text for document in dataset.documents], side="document")

    def rank(text: str) -> list[str]:
        query = model.encode_texts([text], side="query")[0]
        order = np.argsort(-(vectors @ query), kind="stable")
        return [corpus[index] for index in order[:10]]

    metrics = evaluate_ranker(judgements, rank, corpus_size=len(corpus)).metrics
    return {name: metrics[name] for name in ("mrr", "recall@1", "recall@5", "ndcg@10")}


def paired_axis(config: PipelineConfig, condition: str, seeds: tuple[int, ...], epochs: int) -> dict:
    """Dense vs fused, one model per seed, both rankers measured on that model.

    Reports two claims separately because they come out differently: whether the
    fusion protects recall@5 (it does, on every seed measured) and whether it
    improves mrr (it does not reliably — the mean gain sits inside the seed spread
    and reverses on some seeds). Separating them is the point; a summary that
    reported only the mean mrr gain would read as a win.
    """
    dataset = build_dataset(
        seed=config.data_seed,
        overlap=condition,
        split_by=config.split_by,
        evaluation_fraction=config.evaluation_fraction,
    )
    corpus = [document.doc_id for document in dataset.documents]
    judgements = [
        {"id": query.query_id, "text": query.text, "relevant": query.relevant}
        for query in dataset.evaluation_queries
    ]
    vocabulary = Vocabulary().build(
        [document.text for document in dataset.documents] + [query.text for query in dataset.train_queries]
    )
    index = dataset.index()

    def lexical(text: str) -> list[str]:
        return [hit["docId"] for hit in index.search(text, top_k=10)]

    def measure(rank) -> dict:
        metrics = evaluate_ranker(judgements, rank, corpus_size=len(corpus)).metrics
        return {name: metrics[name] for name in ("mrr", "recall@1", "recall@5", "ndcg@10")}

    bm25 = measure(lexical)
    runs = []
    for seed in seeds:
        encoder_config = DualEncoderConfig(
            d_model=config.d_model,
            d_emb=config.d_emb,
            batch_size=config.batch_size,
            epochs=epochs,
            learning_rate=config.learning_rate,
            scale=config.scale,
            seed=seed,
        )
        model = DualEncoder(vocabulary, encoder_config)
        model.train(dataset.triples())
        vectors = model.encode_texts([document.text for document in dataset.documents], side="document")

        def dense(text: str, model=model, vectors=vectors) -> list[str]:
            query = model.encode_texts([text], side="query")[0]
            order = np.argsort(-(vectors @ query), kind="stable")
            return [corpus[index] for index in order[:10]]

        def fused(text: str, dense=dense) -> list[str]:
            return fuse_rankings([lexical(text), dense(text)], (0.5, 0.5), top_k=10)

        # The digest makes the pairing auditable: both rankers below were measured
        # on this one model, so the comparison cannot be confounded by which
        # initialisation each side happened to get.
        runs.append({
            "seed": seed,
            "modelDigest": model.weights_digest(),
            "dense": measure(dense),
            "hybrid": measure(fused),
        })

    summary = summarise_paired(runs, bm25)

    return {
        "condition": condition,
        "corpusSize": len(corpus),
        "evaluationQueries": len(judgements),
        "bm25": bm25,
        "seeds": list(seeds),
        "runs": runs,
        "summary": summary,
    }


def summarise_paired(runs: list[dict], bm25: dict) -> dict:
    """The robustness summary for one condition, as a pure function of the runs.

    Separated from the measurement so it can be tested against crafted inputs.
    A test that reads the summary of a real run can pass by luck — if the real data
    happens to have no reversals, a hardcoded ``0`` is indistinguishable from the
    truth. Feeding in runs that *do* reverse removes that ambiguity.

    ``runs`` is one entry per seed, each holding the metrics of both rankers
    measured on that seed's single model.
    """
    dense_recall = [run["dense"]["recall@5"] for run in runs]
    hybrid_recall = [run["hybrid"]["recall@5"] for run in runs]
    dense_mrr = [run["dense"]["mrr"] for run in runs]
    hybrid_mrr = [run["hybrid"]["mrr"] for run in runs]
    mrr_gain = statistics.fmean(high - low for high, low in zip(hybrid_mrr, dense_mrr))
    seed_spread = statistics.stdev(dense_mrr) if len(dense_mrr) > 1 else 0.0

    return {
        # The property the fusion was introduced for. Holds on every seed measured.
        "recallAt5NeverBelowDense": bool(all(h >= d for h, d in zip(hybrid_recall, dense_recall))),
        "meanPairedRecallAt5Gain": round(
            statistics.fmean(h - d for h, d in zip(hybrid_recall, dense_recall)), 6
        ),
        "minPairedRecallAt5Gain": round(
            min(h - d for h, d in zip(hybrid_recall, dense_recall)), 6
        ),
        # The property it does NOT establish.
        "meanPairedMrrGain": round(mrr_gain, 6),
        # Two independent statements about robustness, because they can disagree and
        # the disagreement is the finding: a mean gain can exceed the spread while
        # still reversing sign on individual seeds. A reader deciding whether to
        # trust the change needs both facts, not a single verdict.
        "mrrGainExceedsSeedSpread": bool(abs(mrr_gain) > seed_spread),
        "mrrGainPositiveOnEverySeed": bool(all(h > d for h, d in zip(hybrid_mrr, dense_mrr))),
        "denseMrrSeedStdev": round(seed_spread, 6),
        "seedsWhereMrrGainIsNegative": sum(1 for h, d in zip(hybrid_mrr, dense_mrr) if h < d),
        "denseRecallRegressedVsBm25": sum(1 for value in dense_recall if value < bm25["recall@5"]),
        "hybridRecallRegressedVsBm25": sum(1 for value in hybrid_recall if value < bm25["recall@5"]),
        "seedCount": len(runs),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", type=Path, help="write the full report as JSON")
    parser.add_argument("--quick", action="store_true", help="smaller sweep, for a smoke check")
    arguments = parser.parse_args()

    config = PipelineConfig()
    seeds = (7, 11, 13) if arguments.quick else SEEDS
    sizes = (48, 36, 24) if arguments.quick else TRAINING_SIZES
    epochs = 8 if arguments.quick else config.epochs

    dataset = build_dataset(
        seed=config.data_seed,
        overlap=config.overlap,
        split_by=config.split_by,
        evaluation_fraction=config.evaluation_fraction,
    )
    corpus = [document.doc_id for document in dataset.documents]
    judgements = [
        {"id": query.query_id, "text": query.text, "relevant": query.relevant}
        for query in dataset.evaluation_queries
    ]
    train = dataset.train_queries

    # One vocabulary for every run: documents plus every training query, exactly as
    # the pipeline's final model builds it. Holding it fixed isolates the axes.
    vocabulary = Vocabulary().build(
        [document.text for document in dataset.documents] + [query.text for query in train]
    )

    def train_and_evaluate(subset, seed: int) -> dict:
        encoder_config = DualEncoderConfig(
            d_model=config.d_model,
            d_emb=config.d_emb,
            batch_size=config.batch_size,
            epochs=epochs,
            learning_rate=config.learning_rate,
            scale=config.scale,
            seed=seed,
        )
        model = DualEncoder(vocabulary, encoder_config)
        model.train(dataset.triples(subset))
        return evaluate(model, dataset, corpus, judgements)

    report: dict = {
        "codeRevision": code_revision(),
        "hardware": hardware_profile(),
        "config": {
            "dataSeed": config.data_seed,
            "overlap": config.overlap,
            "splitBy": config.split_by,
            "evaluationFraction": config.evaluation_fraction,
            "dModel": config.d_model,
            "dEmb": config.d_emb,
            "batchSize": config.batch_size,
            "epochs": epochs,
            "learningRate": config.learning_rate,
            "scale": config.scale,
        },
        "datasetDigest": dataset.digest(),
        "corpusSize": len(corpus),
        "evaluationQueries": len(judgements),
        "trainQueries": len(train),
    }

    # --- axis 1: seed ------------------------------------------------------
    started = time.perf_counter()
    seed_runs = [{"seed": seed, "metrics": train_and_evaluate(train, seed)} for seed in seeds]
    report["seedSweep"] = {
        "seeds": list(seeds),
        "runs": seed_runs,
        "seconds": round(time.perf_counter() - started, 3),
        "summary": {
            name: {
                "min": round(min(run["metrics"][name] for run in seed_runs), 6),
                "max": round(max(run["metrics"][name] for run in seed_runs), 6),
                "mean": round(statistics.fmean(run["metrics"][name] for run in seed_runs), 6),
                "stdev": round(
                    statistics.stdev([run["metrics"][name] for run in seed_runs]), 6
                )
                if len(seed_runs) > 1
                else 0.0,
            }
            for name in ("mrr", "recall@1", "recall@5", "ndcg@10")
        },
    }
    # The released configuration's own seed, for comparison with the card.
    released = next((run for run in seed_runs if run["seed"] == config.model_seed), None)
    report["releasedSeed"] = {
        "seed": config.model_seed,
        "metrics": released["metrics"] if released else None,
        "inSweep": released is not None,
    }

    # --- axis 2: training-set size ----------------------------------------
    ordered = np.random.default_rng(config.data_seed).permutation(len(train))
    size_runs = []
    started = time.perf_counter()
    for size in sizes:
        subset = [train[index] for index in sorted(ordered[:size].tolist())]
        metrics = train_and_evaluate(subset, config.model_seed)
        size_runs.append({"trainQueries": len(subset), "triples": len(dataset.triples(subset)), "metrics": metrics})
    report["trainingSizeSweep"] = {"runs": size_runs, "seconds": round(time.perf_counter() - started, 3)}
    # Degradation is the finding worth stating, not the individual numbers.
    if size_runs:
        report["trainingSizeSweep"]["mrrDropFromFull"] = round(
            size_runs[0]["metrics"]["mrr"] - size_runs[-1]["metrics"]["mrr"], 6
        )

    # --- axis 3: paired comparison across seeds ----------------------------
    # Seed noise is the floor any claimed improvement has to clear. Comparing a
    # variant at one seed against a baseline at the same seed removes the seed from
    # the comparison entirely: the difference is then about the change, not luck.
    paired = []
    started = time.perf_counter()
    for condition in PAIRED_CONDITIONS:
        paired.append(paired_axis(config, condition, seeds, epochs))
    report["pairedComparison"] = {"conditions": paired, "seconds": round(time.perf_counter() - started, 3)}

    if arguments.json:
        arguments.json.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    seed_summary = report["seedSweep"]["summary"]
    print(f"\n=== seed sweep ({len(seeds)} seeds, same data and configuration) ===")
    print(f"{'seed':>6} {'mrr':>10} {'recall@1':>10} {'recall@5':>10} {'ndcg@10':>10}")
    for run in seed_runs:
        marker = "  <- released seed" if run["seed"] == config.model_seed else ""
        m = run["metrics"]
        print(f"{run['seed']:>6} {m['mrr']:>10.6f} {m['recall@1']:>10.4f} {m['recall@5']:>10.4f} {m['ndcg@10']:>10.6f}{marker}")
    print()
    for name, stats_ in seed_summary.items():
        print(
            f"  {name:10} mean {stats_['mean']:.6f}  min {stats_['min']:.6f}  max {stats_['max']:.6f}"
            f"  spread {stats_['max'] - stats_['min']:.6f}  stdev {stats_['stdev']:.6f}"
        )

    print(f"\n=== training-set size sweep (seed {config.model_seed}) ===")
    print(f"{'train queries':>14} {'triples':>8} {'mrr':>10} {'recall@5':>10}")
    for run in size_runs:
        m = run["metrics"]
        print(f"{run['trainQueries']:>14} {run['triples']:>8} {m['mrr']:>10.6f} {m['recall@5']:>10.4f}")
    if size_runs:
        print(f"\n  mrr falls {report['trainingSizeSweep']['mrrDropFromFull']:.6f} from {size_runs[0]['trainQueries']}"
              f" to {size_runs[-1]['trainQueries']} training queries")

    for entry in paired:
        summary = entry["summary"]
        print(f"\n=== paired comparison, overlap={entry['condition']} (BM25 recall@5 {entry['bm25']['recall@5']:.4f}) ===")
        print(f"{'seed':>5} {'dense mrr':>10} {'dense r@5':>10} | {'hybrid mrr':>11} {'hybrid r@5':>11}")
        for run in entry["runs"]:
            d, h = run["dense"], run["hybrid"]
            print(f"{run['seed']:>5} {d['mrr']:>10.4f} {d['recall@5']:>10.4f} | {h['mrr']:>11.4f} {h['recall@5']:>11.4f}")
        print()
        print(f"  recall@5 never below dense   : {summary['recallAt5NeverBelowDense']}"
              f"   (min paired gain {summary['minPairedRecallAt5Gain']:+.4f}, mean {summary['meanPairedRecallAt5Gain']:+.4f})")
        print(f"  mean paired mrr gain         : {summary['meanPairedMrrGain']:+.4f}")
        print(f"  dense mrr seed stdev         : {summary['denseMrrSeedStdev']:.4f}")
        print(f"  mrr gain exceeds seed spread : {summary['mrrGainExceedsSeedSpread']}")
        print(f"  mrr gain positive every seed : {summary['mrrGainPositiveOnEverySeed']}"
              f"   (negative on {summary['seedsWhereMrrGainIsNegative']}/{summary['seedCount']} seeds)")
        print(f"  recall@5 vs BM25 — dense regressed on {summary['denseRecallRegressedVsBm25']}/{summary['seedCount']},"
              f" hybrid on {summary['hybridRecallRegressedVsBm25']}/{summary['seedCount']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
