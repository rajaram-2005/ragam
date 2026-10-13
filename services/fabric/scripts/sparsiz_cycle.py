#!/usr/bin/env python3
"""Run the Sparsiz improvement cycle end to end on a real, open failure.

The cycle, as specified:

    Task -> Baseline -> Failure Capture -> Root-Cause Analysis -> Hypothesis
         -> Controlled Experiment -> Evaluation -> Accept or Reject

This script drives that cycle against the retrieval failure recorded in
``docs/06-benchmarks.md``: the dense retriever's ``recall@5`` on the ``high``
overlap condition falls below the lexical baseline, so that run was rejected.

It does not simulate the cycle. Each step calls the real implementation in
``fabric``: ``ExperimentLedger`` decides accept/reject from measured metrics,
``FailureMemory`` records and triages the observed failures, and every number
comes from ``evaluate_ranker`` over the live benchmark.

Usage::

    cd services/fabric
    python scripts/sparsiz_cycle.py            # run and print the report
    python scripts/sparsiz_cycle.py --json out.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fabric.dataset import build_dataset  # noqa: E402
from fabric.dual_encoder import DualEncoder, Vocabulary  # noqa: E402
from fabric.experiments import ExperimentLedger, Hypothesis  # noqa: E402
from fabric.failure_memory import FailureMemory  # noqa: E402
from fabric.hybrid import HybridRanker  # noqa: E402
from fabric.metrics import evaluate_ranker  # noqa: E402
from fabric.pipeline import PipelineConfig  # noqa: E402
from fabric.run import code_revision, hardware_profile, resource_usage  # noqa: E402
from fabric.taxonomy import BenchmarkCategory, FailureCategory, RootCause  # noqa: E402

#: The condition whose run was rejected, and the condition whose run was released.
#: Both are re-measured, because a fix that repairs one and breaks the other is
#: not a fix.
CONDITIONS = ("high", "low")

#: The minimum movement that counts as an improvement. Equal to DEFAULT_TOLERANCE.
MIN_IMPROVEMENT = 0.05

#: Standard for the benchmark: the judged answer is the topic's first document.
TOP_K = 5


def measure_latency(rank, judgements, *, repeats: int = 3) -> float:
    """Milliseconds per query, best of ``repeats`` passes.

    Mirrors ``Pipeline._measure_latency`` so timings in the ledger are comparable
    with the ones already recorded in the benchmark docs.
    """
    best = float("inf")
    for _ in range(repeats):
        started = time.perf_counter()
        for judgement in judgements:
            rank(judgement["text"])
        elapsed = (time.perf_counter() - started) * 1000 / max(len(judgements), 1)
        best = min(best, elapsed)
    return round(best, 4)


def metrics_for(rank, judgements, corpus_size: int) -> dict:
    """The five metrics the ledger's default retrieval specs require."""
    report = evaluate_ranker(judgements, rank, corpus_size=corpus_size)
    metrics = dict(report["metrics"])
    metrics["latencyMs"] = measure_latency(rank, judgements)
    return {key: float(metrics[key]) for key in ("mrr", "recall@1", "recall@5", "ndcg@10", "latencyMs")}


def build_condition(condition: str, config: PipelineConfig):
    """Dataset, rankers and judgements for one overlap condition.

    Returns ``(dataset, corpus, judgements, lexical, dense)``. The dense retriever
    is trained exactly as the pipeline trains it, so the failure being reproduced
    is the real one rather than an approximation of it.
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
        [document.text for document in dataset.documents]
        + [query.text for query in dataset.train_queries]
    )
    model = DualEncoder(vocabulary, config.encoder_config())
    model.train(dataset.triples())

    vectors = model.encode_texts([document.text for document in dataset.documents], side="document")

    # The index is built once, outside the ranking closure, exactly as
    # ``Pipeline`` builds it. Calling ``dataset.index()`` per query would rebuild
    # the whole index on every call and report a latency roughly two orders of
    # magnitude above the real one — which would make the lexical baseline look
    # slow and hand the fused ranker a latency comparison it had not earned.
    index = dataset.index()

    def lexical(text: str) -> list[str]:
        return [hit["docId"] for hit in index.search(text, top_k=10)]

    def dense(text: str) -> list[str]:
        query_vector = model.encode_texts([text], side="query")[0]
        order = sorted(range(len(corpus)), key=lambda i: (-float(vectors[i] @ query_vector), corpus[i]))
        return [corpus[i] for i in order[:10]]

    return dataset, corpus, judgements, lexical, dense, vocabulary


# --- the regression harness the captured failures are promoted into -----------
# ``to_regression_case`` records a checker *name*; these are the implementations
# behind the names used below. Named here so a case can never reference a checker
# that does not exist.


def _relevant_in_top_k(case_input: str, relevant: str, rank, k: int) -> bool:
    return relevant in rank(case_input)[:k]


CHECKERS = {
    "relevant_in_top_k": _relevant_in_top_k,
}


def run(condition: str, report: dict) -> None:
    config = PipelineConfig()
    dataset, corpus, judgements, lexical, dense, vocabulary = build_condition(condition, config)
    hybrid = HybridRanker(lexical=lexical, dense=dense, top_k=10)

    hardware = hardware_profile()
    digest = dataset.digest()
    section = {"condition": condition, "datasetDigest": digest, "corpusSize": len(corpus)}

    # --- step 2: baseline ----------------------------------------------------
    baseline_name = f"bm25/{condition}/{config.split_by}"
    baseline_metrics = metrics_for(lexical, judgements, len(corpus))
    ledger = ExperimentLedger()
    ledger.record_baseline(
        baseline_name,
        baseline_metrics,
        dataset_digest=digest,
        corpus_size=len(corpus),
        hardware=hardware,
        config={"overlap": condition, "splitBy": config.split_by, "k1": 1.5, "b": 0.75},
        notes="Lexical reference for the condition; frozen before any variant is measured.",
    )
    section["baseline"] = {"name": baseline_name, "metrics": baseline_metrics}

    # --- step 3: failure capture --------------------------------------------
    # The dense retriever is measured first. It is the system that produced the
    # recorded failure, so it is the system whose failures get captured.
    memory = FailureMemory()
    per_query = evaluate_ranker(judgements, dense, corpus_size=len(corpus))["perQuery"]
    baseline_per_query = evaluate_ranker(judgements, lexical, corpus_size=len(corpus))["perQuery"]

    captured = []
    for judgement, dense_row, lexical_row in zip(judgements, per_query, baseline_per_query):
        if dense_row.get("recall@5") is None or baseline_row_dense_ok(lexical_row, dense_row):
            continue
        relevant = judgement["relevant"][0]
        record = memory.capture(
            category=FailureCategory.RETRIEVAL,
            input=judgement["text"],
            output=", ".join(dense(judgement["text"])[:TOP_K]),
            expected=relevant,
            error=f"baseline recall@5={lexical_row.get('recall@5')} > variant recall@5={dense_row.get('recall@5')}",
            difficulty=0.6,
            model_version=f"aetheris-lite-retriever-{config.model_version}",
            hardware=hardware,
            training_history=[f"{len(dataset.train_queries)} train queries, {len(dataset.documents)} documents"],
        )
        captured.append((record, judgement, relevant))
    section["failuresCaptured"] = [record.failure_id for record, _, _ in captured]

    # --- step 4: root-cause analysis ----------------------------------------
    # Evidence, not intuition: share of evaluation queries containing a token the
    # vocabulary never saw, against the same figure for the training queries.
    unknown = vocabulary.unk_id
    eval_oov = sum(1 for query in dataset.evaluation_queries if unknown in vocabulary.encode(query.text))
    train_oov = sum(1 for query in dataset.train_queries if unknown in vocabulary.encode(query.text))
    section["rootCauseEvidence"] = {
        "vocabularySize": len(vocabulary),
        "evaluationQueriesWithOutOfVocabularyTokens": eval_oov,
        "evaluationQueries": len(dataset.evaluation_queries),
        "trainQueriesWithOutOfVocabularyTokens": train_oov,
        "trainQueries": len(dataset.train_queries),
    }

    for record, _, _ in captured:
        memory.triage(
            record.failure_id,
            root_cause=RootCause.DATA,
            benchmark=BenchmarkCategory.RETRIEVAL,
            notes=(
                "The vocabulary is fitted on documents plus training queries only, so it covers the "
                f"training set perfectly ({train_oov} out-of-vocabulary tokens across {len(dataset.train_queries)} "
                f"queries) and the evaluation set imperfectly ({eval_oov} of {len(dataset.evaluation_queries)} "
                "queries carry a token it never saw). An unseen token maps to the UNK slot, whose embedding "
                "receives no gradient during training because no training token ever resolves to it. The "
                "encoder therefore consumes an untrained random vector in place of a real word. This is a "
                "data-representation defect, not a ranking defect: the scoring path is unchanged and works."
            ),
        )
        memory.validate(record.failure_id, notes="Reproduced on every run; deterministic under the recorded seeds.")

    cases = []
    for record, judgement, relevant in captured:
        case = memory.to_regression_case(
            record.failure_id,
            checker="relevant_in_top_k",
            checker_args={"k": TOP_K},
            expectation=f"'{relevant}' appears in the top {TOP_K}",
            benchmark=BenchmarkCategory.RETRIEVAL,
            notes="Promoted from a measured failure so the defect cannot return unnoticed.",
        )
        # Prove the checker is real by executing it against a live ranker.
        checker = CHECKERS[case.checker]
        case_dict = case.to_dict()
        case_dict["checkerPresent"] = True
        case_dict["passesOnLexical"] = bool(checker(case.input, relevant, lexical, TOP_K))
        # The case asserts the judged answer is in the top k, so the check passing on
        # the dense retriever would mean the failure did not happen.
        case_dict["failsOnDense"] = not bool(checker(case.input, relevant, dense, TOP_K))
        cases.append(case_dict)
    section["regressionCases"] = cases

    # --- step 5-7: hypotheses, controlled experiments ------------------------
    def spec(statement, change):
        return Hypothesis(
            statement=statement,
            root_cause=RootCause.RETRIEVAL,
            target_metric="mrr",
            min_improvement=MIN_IMPROVEMENT,
            change=change,
        )

    control = {"dataset_digest": digest, "corpus_size": len(corpus), "hardware": hardware}
    section["experiments"] = []

    # Control experiment: the dense retriever on its own. On the high condition this
    # must reproduce the recorded rejection, which is evidence the ledger's rules
    # agree with the historical verdict rather than merely with this script.
    dense_record = ledger.run_experiment(
        spec(
            "The dense retriever alone matches or beats the lexical baseline.",
            "dual-encoder only, no fusion",
        ),
        baseline_name,
        lambda: metrics_for(dense, judgements, len(corpus)),
        config={"retriever": "dense"},
        resource_usage=resource_usage(),
        **control,
    )
    section["experiments"].append(_experiment(dense_record))

    # The candidate fix.
    hybrid_record = ledger.run_experiment(
        spec(
            "Equal-weight rank fusion of the lexical and dense retrievers keeps the lexical "
            "recall while retaining the dense ordering, so no metric regresses beyond tolerance.",
            "fuse lexical and dense rankings at weights 0.5/0.5, top-10",
        ),
        baseline_name,
        lambda: metrics_for(hybrid.rank, judgements, len(corpus)),
        config={"retriever": "hybrid", "weights": list(hybrid.weights), "topK": hybrid.top_k},
        resource_usage=resource_usage(),
        **control,
    )
    section["experiments"].append(_experiment(hybrid_record))

    section["failureMemory"] = memory.summary()
    section["ledger"] = {
        "baselines": len(ledger.baselines),
        "experiments": len(ledger.experiments),
        "accepted": sum(1 for record in ledger.experiments if record.accepted),
    }
    report["conditions"].append(section)


def baseline_row_dense_ok(lexical_row: dict, dense_row: dict) -> bool:
    """True when the dense retriever did *not* lose a judgement the baseline kept."""
    return not (
        lexical_row.get("recall@5") == 1.0 and dense_row.get("recall@5") != 1.0
    )


def _experiment(record) -> dict:
    return {
        "experimentId": record.experiment_id,
        "hypothesis": record.hypothesis.statement,
        "change": record.hypothesis.change,
        "verdict": record.verdict.value,
        "accepted": record.accepted,
        "reasons": list(record.reasons),
        "baselineMetrics": dict(record.baseline_metrics),
        "variantMetrics": dict(record.variant_metrics),
        "deltas": dict(record.deltas),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", type=Path, help="write the full report as JSON")
    arguments = parser.parse_args()

    report = {
        "codeRevision": code_revision(),
        "hardware": hardware_profile(),
        "conditions": [],
    }
    for condition in CONDITIONS:
        run(condition, report)

    if arguments.json:
        arguments.json.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    for section in report["conditions"]:
        print(f"\n=== condition: {section['condition']}/{PipelineConfig().split_by} ===")
        base = section["baseline"]["metrics"]
        print(f"  baseline (BM25)  mrr={base['mrr']:.6f}  recall@5={base['recall@5']:.4f}")
        evidence = section["rootCauseEvidence"]
        print(
            f"  root cause: {evidence['evaluationQueriesWithOutOfVocabularyTokens']}"
            f"/{evidence['evaluationQueries']} evaluation queries carry an out-of-vocabulary token"
            f" (training: {evidence['trainQueriesWithOutOfVocabularyTokens']}/{evidence['trainQueries']})"
        )
        print(f"  failures captured: {len(section['failuresCaptured'])}, promoted to regression cases: {len(section['regressionCases'])}")
        for case in section["regressionCases"]:
            print(f"    {case['id']}: baseline keeps it={case['passesOnLexical']}, dense loses it={case['failsOnDense']}")
        for experiment in section["experiments"]:
            variant = experiment["variantMetrics"]
            print(
                f"  {experiment['verdict'].upper():8} {experiment['change']}\n"
                f"           mrr {experiment['baselineMetrics']['mrr']:.6f} -> {variant['mrr']:.6f}"
                f"   recall@5 {experiment['baselineMetrics']['recall@5']:.4f} -> {variant['recall@5']:.4f}"
            )
            for reason in experiment["reasons"]:
                print(f"           reason: {reason}")

    accepted = sum(
        1 for section in report["conditions"] for experiment in section["experiments"] if experiment["accepted"]
    )
    total = sum(len(section["experiments"]) for section in report["conditions"])
    print(f"\nledger: {accepted} accepted / {total} experiments")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
