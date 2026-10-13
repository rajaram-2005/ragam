#!/usr/bin/env python3
"""Run the L4 transfer experiment: does a retrieval strategy generalise across tasks?

The protocol lives in ``fabric/transfer.py`` and its thresholds are fixed there, before
this script produces a number. This file only produces the measurements the protocol
consumes, and writes them out.

What is measured
----------------
For each seed and each lexical-overlap condition:

* the corpus is generated (``build_dataset``), the dual encoder is trained on the
  training queries, and a BM25 index is built over every document -- exactly as the
  pipeline does;
* every candidate strategy ranks the same queries using the same two rankings, so the
  only difference between strategies is the fusion policy;
* each strategy is scored separately over the **development** topics and the
  **held-out** topics, and over both conditions, giving four cells:

  ==================  ======================  ==================================
  cell                topics                  overlap condition
  ==================  ======================  ==================================
  ``development-low``  every second topic      lexically hard (deployment case)
  ``held-out-low``     the other half          lexically hard
  ``development-high`` every second topic      lexically easy (query reuses words)
  ``held-out-high``    the other half          lexically easy
  ==================  ======================  ==================================

Selection runs on ``development-low`` alone -- the deployment condition, half the
topics. The other three cells are where the lesson either transfers or does not, and
no step of the selection looks at them.

Every strategy on a cell is evaluated on the *same* trained encoder, so the paired
difference between two strategies cannot be explained by one of them drawing a better
model.

Exit status: ``0`` when the report was produced, whatever it says, and ``2`` when the
experiment could not run. A runner that failed on a negative result would teach people
to hide negative results, which is the opposite of what this experiment is for.

Usage::

    cd services/fabric
    python scripts/l4_transfer.py                    # print the report
    python scripts/l4_transfer.py --json out.json    # and write the machine-readable form
    python scripts/l4_transfer.py --quick            # 3 seeds, 8 epochs (smoke only)
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402

from fabric.dataset import TOPICS, build_dataset  # noqa: E402
from fabric.dual_encoder import DualEncoder, Vocabulary  # noqa: E402
from fabric.metrics import evaluate_ranker  # noqa: E402
from fabric.pipeline import PipelineConfig  # noqa: E402
from fabric.text import stem_tokens  # noqa: E402
from fabric.transfer import (  # noqa: E402
    MIN_SEEDS,
    PRIMARY_METRIC,
    STRATEGIES,
    TransferReport,
    run_transfer,
    split_families,
)

#: Eight seeds, not three. A run costs about a fifth of a second, and the recorded
#: failure mode in this repository is a difference that reverses across seeds -- so
#: spending the extra compute on seeds is the cheapest available defence against
#: reporting a seed artefact as a finding.
DEFAULT_SEEDS: tuple[int, ...] = (11, 22, 33, 44, 55, 66, 77, 88)
QUICK_SEEDS: tuple[int, ...] = (11, 22, 33)
CONDITIONS: tuple[str, ...] = ("low", "high")
DEVELOPMENT_CELL = "development-low"


def _family_key(group: str, condition: str) -> str:
    return f"{group}-{condition}"


def _measure_seed(seed: int, condition: str, *, epochs: int | None) -> dict:
    """One (seed, condition): train once, then score every strategy on both topic groups."""
    dataset = build_dataset(overlap=condition, seed=seed)
    groups = split_families([topic.key for topic in TOPICS])
    vocabulary = sorted({term for document in dataset.documents for term in stem_tokens(document.text)})
    vocabulary_set = set(vocabulary)

    config = PipelineConfig()
    encoder_config = config.encoder_config(d_model=config.d_model, epochs=epochs)
    encoder_config.seed = seed
    training = Vocabulary().build(
        [document.text for document in dataset.documents] + [query.text for query in dataset.train_queries]
    )
    model = DualEncoder(training, encoder_config)
    model.train(dataset.triples())

    index = dataset.index()
    corpus = [document.doc_id for document in dataset.documents]
    vectors = model.encode_texts([document.text for document in dataset.documents], side="document")

    def lexical_ranking(text: str) -> list[str]:
        return [hit["docId"] for hit in index.search(text, top_k=10)]

    def dense_ranking(text: str) -> list[str]:
        query_vector = model.encode_texts([text], side="query")[0]
        order = np.argsort(-(vectors @ query_vector), kind="stable")[:10]
        return [corpus[position] for position in order]

    # The two component rankings are computed once per query and handed to every
    # strategy. Recomputing them per strategy would be slower and, worse, would let a
    # strategy's score depend on when it ran.
    rankings: dict[str, tuple[list[str], list[str]]] = {}
    for query in dataset.evaluation_queries:
        rankings.setdefault(query.text, (lexical_ranking(query.text), dense_ranking(query.text)))

    measurements: dict = {}
    for group in ("development", "held-out"):
        members = set(groups[group])
        queries = [
            {"id": query.query_id, "text": query.text, "relevant": query.relevant, "topic": query.topic}
            for query in dataset.evaluation_queries
            if query.topic in members
        ]
        if not queries:
            raise SystemExit(f"no evaluation queries for {group} on seed {seed}/{condition}")
        for strategy in STRATEGIES:
            def rank(text: str, strategy=strategy) -> list[str]:
                lexical, dense = rankings[text]
                return strategy.rank(text, lexical=lexical, dense=dense, vocabulary=vocabulary_set, top_k=10)

            report = evaluate_ranker(queries, rank)
            metrics = dict(report["metrics"])
            measurements[(_family_key(group, condition), seed, strategy.name)] = {
                "mrr": float(metrics[PRIMARY_METRIC]),
                "recall@5": float(metrics["recall@5"]),
                "queries": len(queries),
            }
    return measurements


def _hardware() -> dict:
    return {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "processor": platform.processor() or None,
        "cpuCount": os.cpu_count(),
        "python": platform.python_version(),
        "numpy": np.__version__,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--json", dest="json_out", default=None, help="write the report here")
    parser.add_argument("--seeds", default=None, help="comma-separated seeds (default: 11,22,33,44,55,66,77,88)")
    parser.add_argument("--quick", action="store_true", help="3 seeds and 8 epochs; for smoke runs only")
    args = parser.parse_args()

    if args.seeds:
        seeds = tuple(int(part) for part in args.seeds.split(",") if part.strip())
    elif args.quick:
        seeds = QUICK_SEEDS
    else:
        seeds = DEFAULT_SEEDS
    epochs = 8 if args.quick else None

    # Refused here rather than deep inside the protocol, so the message names the flag
    # the caller passed instead of surfacing a traceback from a decision rule.
    if len(seeds) < MIN_SEEDS:
        parser.error(f"the protocol needs at least {MIN_SEEDS} seeds; --seeds got {len(seeds)}")

    started = time.time()
    measurements: dict = {}
    for seed in seeds:
        for condition in CONDITIONS:
            measurements.update(_measure_seed(seed, condition, epochs=epochs))
        print(f"seed {seed}: measured {len(CONDITIONS)} conditions", flush=True)

    groups = split_families([topic.key for topic in TOPICS])
    conditions = list(CONDITIONS)
    families = {
        _family_key(group, condition): {
            "topics": groups[group],
            "topicCount": len(groups[group]),
            "condition": condition,
            "role": "development" if _family_key(group, condition) == DEVELOPMENT_CELL else "target",
        }
        for group in groups
        for condition in conditions
    }
    targets = [key for key in families if key != DEVELOPMENT_CELL]

    report: TransferReport = run_transfer(
        measurements,
        development_family=DEVELOPMENT_CELL,
        target_families=targets,
        seeds=seeds,
        families=families,
    )

    payload = {
        "experiment": "l4-transfer",
        "what": (
            "whether a retrieval strategy selected on one task family (half the topics, "
            "lexically hard queries) transfers to held-out topics and to the lexically easy condition"
        ),
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "durationSeconds": round(time.time() - started, 3),
        "config": {
            "dataSeedPerRun": "the seed itself, so each seed is an independent corpus",
            "conditions": conditions,
            "encoder": {
                "dModel": PipelineConfig().d_model,
                "epochs": epochs if epochs is not None else PipelineConfig().epochs,
                "note": "the pipeline's own serving configuration; not tuned for this experiment",
            },
            "corpus": {
                "topics": len(TOPICS),
                "documentsPerTopic": 4,
                "queriesPerTopic": 3,
                "evaluationFraction": 0.25,
            },
        },
        "hardware": _hardware(),
        "report": report.to_dict(),
        "rawMetrics": [
            {"family": family, "seed": seed, "strategy": name, **values}
            for (family, seed, name), values in sorted(measurements.items())
        ],
    }

    print()
    print(report.summary())
    print()
    for family in [DEVELOPMENT_CELL, *targets]:
        ranking = next(
            (block["ranking"] for block in [report.development, *report.targets]
             if block["family"] == family and "ranking" in block),
            [],
        )
        if not ranking:
            continue
        cells = "  ".join(f"{row['rank']}. {row['strategy']} {row['mean']:.4f}" for row in ranking)
        print(f"{family:>17}: {cells}")
    print()
    print(f"duration {payload['durationSeconds']}s over {len(seeds)} seeds")

    if args.json_out:
        Path(args.json_out).write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
        print(f"report written to {args.json_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
