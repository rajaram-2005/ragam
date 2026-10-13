"""The Aetheris Lite pipeline:

    Data Validation -> Base Selection -> Domain Training -> SFT
      -> Preference Optimization -> Distillation -> Evaluation -> Release

Every stage reports its own status honestly. On this host — two CPU cores, no GPU,
no route to any model weights — stages 4, 5 and 6 cannot run, and they say so with
``blocked_needs_weights`` rather than producing a number that looks like a result.
Stages 1, 2, 3, 7 and 8 run for real against the NumPy dual encoder.

The distinction that matters
----------------------------
``StageStatus.COMPLETED`` means the stage ran and produced output that was checked.
``StageStatus.BLOCKED_*`` means it could not run here and says exactly what is
missing. A blocked stage is never reported as a success, and a run containing one
is never eligible for release of the artifact that stage would have produced.

Nothing here claims the result generalises. The corpus is a generated fixture, the
model is a 19k-parameter retriever, and the comparison is against BM25 over the
same corpus with the same tokeniser. That is a real, reproducible measurement of a
real mechanism; it is not a claim about Mistral, Qwen, Llama, Gemma or DeepSeek,
none of which can be installed here to compare against.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Mapping, Sequence

import numpy as np

from .bm25 import Bm25Index
from .dataforge import DatasetManifest, DataSample, check_contamination
from .dataset import Query, RetrievalDataset, build_dataset, split_fit_validation
from .dual_encoder import DualEncoder, DualEncoderConfig, Vocabulary
from .experiments import (
    RETRIEVAL_METRICS,
    ControlMismatchError,
    ExperimentLedger,
    Hypothesis,
    MetricSpec,
)
from .metrics import evaluate_ranker
from .modelcards import EvaluationProvenance, ModelReleaseManager, ModelStatus, Requirement
from .run import RunRecord, code_revision, hardware_profile
from .taxonomy import BenchmarkCategory, ExperimentVerdict, RootCause, StageStatus

__all__ = ["StageResult", "PipelineConfig", "Pipeline", "STAGE_NAMES"]

STAGE_NAMES: tuple[str, ...] = (
    "data_validation",
    "base_selection",
    "domain_training",
    "sft",
    "preference_optimization",
    "distillation",
    "evaluation",
    "release",
)


@dataclass
class StageResult:
    name: str
    status: StageStatus
    detail: dict = field(default_factory=dict)
    seconds: float = 0.0
    limitations: list = field(default_factory=list)

    @property
    def ran(self) -> bool:
        return self.status.ran

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "status": self.status.value,
            "ran": self.ran,
            "seconds": self.seconds,
            "detail": dict(self.detail),
            "limitations": list(self.limitations),
        }


@dataclass
class PipelineConfig:
    """Everything that varies between runs. Recorded verbatim in the run record."""

    #: Dataset construction.
    data_seed: int = 1
    overlap: str = "low"
    split_by: str = "query"
    evaluation_fraction: float = 0.25
    #: Model and optimisation.
    model_seed: int = 7
    d_model: int = 48
    d_emb: int = 32
    batch_size: int = 8
    epochs: int = 25
    learning_rate: float = 0.03
    scale: float = 10.0
    #: Base selection: candidate widths tried, chosen by held-out score.
    candidate_dims: tuple[int, ...] = (24, 48)
    candidate_epochs: int = 8
    #: Fraction of the *training* queries held out to choose between candidates.
    #: The evaluation split is never used for this: choosing on the split you then
    #: report as held-out turns the reported score into a maximum over candidates.
    validation_fraction: float = 0.25
    validation_seed: int = 20251012
    #: Release gate.
    model_name: str = "aetheris-lite-retriever"
    model_version: str = "0.1.0"
    licence: str = "MIT"
    #: Minimum MRR for the trained model to be considered releasable.
    min_mrr: float = 0.60
    #: Latency ceiling in milliseconds per query, over the fixture corpus.
    max_latency_ms: float = 25.0
    #: Also evaluate the harder held-out-topic condition, reported as a limitation.
    evaluate_topic_split: bool = True

    def as_dict(self) -> dict:
        return {
            "dataSeed": self.data_seed,
            "overlap": self.overlap,
            "splitBy": self.split_by,
            "evaluationFraction": self.evaluation_fraction,
            "modelSeed": self.model_seed,
            "dModel": self.d_model,
            "dEmb": self.d_emb,
            "batchSize": self.batch_size,
            "epochs": self.epochs,
            "learningRate": self.learning_rate,
            "scale": self.scale,
            "candidateDims": list(self.candidate_dims),
            "candidateEpochs": self.candidate_epochs,
            "validationFraction": self.validation_fraction,
            "validationSeed": self.validation_seed,
            "modelName": self.model_name,
            "modelVersion": self.model_version,
            "licence": self.licence,
            "minMrr": self.min_mrr,
            "maxLatencyMs": self.max_latency_ms,
            "evaluateTopicSplit": self.evaluate_topic_split,
        }

    def encoder_config(self, d_model: int | None = None, epochs: int | None = None) -> DualEncoderConfig:
        return DualEncoderConfig(
            d_model=d_model if d_model is not None else self.d_model,
            d_emb=self.d_emb,
            batch_size=self.batch_size,
            epochs=epochs if epochs is not None else self.epochs,
            learning_rate=self.learning_rate,
            scale=self.scale,
            seed=self.model_seed,
        )


class Pipeline:
    """Runs the eight stages and records what each one actually did."""

    def __init__(self, config: PipelineConfig | None = None, *, output_dir: str | Path | None = None) -> None:
        self.config = config or PipelineConfig()
        self.output_dir = Path(output_dir) if output_dir else None
        self.stages: dict[str, StageResult] = {}
        self.ledger = ExperimentLedger()
        self.registry = ModelReleaseManager()
        self.dataset: RetrievalDataset | None = None
        self.manifest: DatasetManifest | None = None
        self.model: DualEncoder | None = None
        self.vocabulary: Vocabulary | None = None
        self.results: dict = {}

    # --- helpers ----------------------------------------------------------

    def _stage(self, name: str, body: Callable[[], StageResult]) -> StageResult:
        started = time.perf_counter()
        try:
            result = body()
        except Exception as error:  # noqa: BLE001 - a stage failure is recorded, not raised
            result = StageResult(
                name=name,
                status=StageStatus.FAILED,
                detail={"error": f"{type(error).__name__}: {error}"},
                limitations=[f"stage '{name}' failed; later stages that depend on it cannot be trusted"],
            )
        result.seconds = round(time.perf_counter() - started, 4)
        self.stages[name] = result
        return result

    def _blocked(self, name: str, status: StageStatus, reason: str, *, what_is_needed: str) -> StageResult:
        """A stage that cannot run here. Says so, and says what would be needed."""
        return StageResult(
            name=name,
            status=status,
            detail={"reason": reason, "whatIsNeeded": what_is_needed},
            limitations=[f"{name}: {reason}"],
        )

    def _encoder_for(
        self,
        dataset: RetrievalDataset,
        config: PipelineConfig,
        d_model: int,
        epochs: int,
        *,
        queries: Sequence[Query] | None = None,
    ) -> DualEncoder:
        """A candidate model.

        ``queries`` restricts both the vocabulary and the training triples to a
        subset of the training queries, which is what lets candidate selection run
        on the fit split alone. The default is every training query, which is what
        the final model uses.
        """
        training_queries = dataset.train_queries if queries is None else list(queries)
        vocabulary = Vocabulary().build(
            [document.text for document in dataset.documents] + [query.text for query in training_queries]
        )
        model = DualEncoder(vocabulary, config.encoder_config(d_model=d_model, epochs=epochs))
        model.train(dataset.triples(training_queries))
        model.vocabulary = vocabulary  # carried alongside for evaluation
        return model

    def _rank_with(self, model: DualEncoder, dataset: RetrievalDataset) -> Callable[[str], list[str]]:
        corpus = [document.doc_id for document in dataset.documents]
        vectors = model.encode_texts([document.text for document in dataset.documents], side="document")

        def rank(text: str) -> list[str]:
            query = model.encode_texts([text], side="query")[0]
            order = np.argsort(-(vectors @ query), kind="stable")[:10]
            return [corpus[index] for index in order]

        return rank

    # --- stage 1 ----------------------------------------------------------

    def data_validation(self) -> StageResult:
        def body() -> StageResult:
            config = self.config
            dataset = build_dataset(
                seed=config.data_seed,
                overlap=config.overlap,
                split_by=config.split_by,
                evaluation_fraction=config.evaluation_fraction,
            )
            manifest = DatasetManifest()
            accepted = manifest.add_all(
                DataSample(content=document.text, source="synthetic", modality="text", metadata={"topic": document.topic})
                for document in dataset.documents
            )
            rejected = manifest.quality_summary()["rejected"]

            parts = manifest.split(evaluation_fraction=config.evaluation_fraction, seed=config.data_seed)
            train_samples = [DataSample(content=entry["sha256"]) for entry in parts["train"]]
            eval_samples = [DataSample(content=entry["sha256"]) for entry in parts["evaluation"]]
            contamination = check_contamination(train_samples, eval_samples)

            self.dataset = dataset
            self.manifest = manifest

            detail = {
                "documents": len(dataset.documents),
                "queries": len(dataset.queries),
                "trainQueries": len(dataset.train_queries),
                "evaluationQueries": len(dataset.evaluation_queries),
                "splitBy": config.split_by,
                "acceptedSamples": accepted,
                "rejectedSamples": rejected,
                "manifestDigest": manifest.digest(),
                "datasetDigest": dataset.digest(),
                "meanQuality": manifest.quality_summary()["meanQuality"],
                "contamination": {"contaminated": contamination.contaminated, "exact": len(contamination.exactDuplicates), "near": len(contamination.nearDuplicates)},
                "corpusStats": dataset.index().stats(),
            }
            limitations = [
                "the corpus is a generated engineering-documentation fixture, not a real company corpus",
            ]
            if contamination.contaminated:
                limitations.append(
                    f"contamination detected between splits: {len(contamination.exactDuplicates)} exact, "
                    f"{len(contamination.nearDuplicates)} near-duplicate"
                )
            return StageResult(
                name="data_validation",
                status=StageStatus.COMPLETED if not contamination.contaminated else StageStatus.FAILED,
                detail=detail,
                limitations=limitations,
            )

        return self._stage("data_validation", body)

    # --- stage 2 ----------------------------------------------------------

    def base_selection(self) -> StageResult:
        """Choose the model width by held-out score, not by preference.

        For a language-model base this stage is blocked: selecting between
        Mistral, Qwen, Llama, Gemma and DeepSeek requires those weights, and none
        can be downloaded here. What *can* be selected is the retriever's own
        configuration, and that is done by measurement.

        The measurement is taken on a validation split carved out of the
        *training* queries, never on the evaluation split. Selecting a width
        because it scored best on the evaluation queries would make the reported
        evaluation score a maximum over the candidates rather than an estimate of
        unseen performance — the candidates would be fitted to the very number
        used to describe them. Each candidate's evaluation score is still computed
        and recorded, for transparency and so the selection/evaluation gap is
        visible, but the choice is made on the validation score alone.
        """
        def body() -> StageResult:
            dataset = self.dataset
            if dataset is None:
                raise RuntimeError("data_validation must run first")

            # Selection data comes from the training side. See split_fit_validation.
            fit, validation = split_fit_validation(
                dataset.train_queries,
                fraction=self.config.validation_fraction,
                seed=self.config.validation_seed,
            )

            def judgements_for(queries) -> list[dict]:
                return [{"id": q.query_id, "text": q.text, "relevant": q.relevant} for q in queries]

            judgements = judgements_for(dataset.evaluation_queries)
            validation_judgements = judgements_for(validation)
            bm25 = dataset.index()

            def bm25_rank(text: str) -> list[str]:
                return [hit["docId"] for hit in bm25.search(text, top_k=10)]

            baseline = evaluate_ranker(judgements, bm25_rank)

            candidates = []
            for width in self.config.candidate_dims:
                model = self._encoder_for(
                    dataset, self.config, width, self.config.candidate_epochs, queries=fit
                )
                rank = self._rank_with(model, dataset)
                validation_report = evaluate_ranker(validation_judgements, rank)
                # Recorded, deliberately not used to choose.
                evaluation_report = evaluate_ranker(judgements, rank)
                candidates.append({
                    "dModel": width,
                    "epochs": self.config.candidate_epochs,
                    "parameters": model.parameter_count(),
                    "validationMrr": round(validation_report.metrics["mrr"], 6),
                    "evaluationMrr": round(evaluation_report.metrics["mrr"], 6),
                })

            if len({entry["validationMrr"] for entry in candidates}) == 1 and len(candidates) > 1:
                raise RuntimeError(
                    "every candidate scored identically on the validation split, so the "
                    "selection carries no information; widen candidate_dims or the split"
                )

            best = max(candidates, key=lambda entry: entry["validationMrr"])

            # Latency is measured BEFORE the baseline is frozen, because a baseline
            # missing any judged metric is refused — and mutating one afterwards
            # would make every verdict already recorded against it unverifiable.
            bm25_latency = self._measure_latency(bm25_rank, judgements)
            self.ledger.record_baseline(
                "bm25",
                {
                    **{name: baseline.metrics.get(name, 0.0) for name in ("mrr", "recall@1", "recall@5", "ndcg@10")},
                    "latencyMs": bm25_latency,
                },
                dataset_digest=dataset.digest(),
                corpus_size=len(dataset.documents),
                hardware=hardware_profile(),
                config={"k1": 1.5, "b": 0.75, "tokeniser": "fabric.text (mirrors services/core)"},
                notes="unmodified BM25 over the fixture corpus, same tokeniser as the dense model",
            )

            return StageResult(
                name="base_selection",
                status=StageStatus.COMPLETED,
                detail={
                    "selected": best,
                    "candidates": candidates,
                    "selectedBy": "MRR on a validation split carved from the training queries",
                    "validationSplit": {
                        "queries": [query.query_id for query in validation],
                        "count": len(validation),
                        "fraction": self.config.validation_fraction,
                        "seed": self.config.validation_seed,
                        "fitCount": len(fit),
                        "disjointFromEvaluation": not (
                            {query.query_id for query in validation}
                            & {query.query_id for query in dataset.evaluation_queries}
                        ),
                    },
                    "bm25Baseline": {name: round(baseline.metrics[name], 6) for name in ("mrr", "recall@1", "recall@5", "ndcg@10")},
                    "languageModelBase": "not selected: no weights available on this host",
                },
                limitations=[
                    "base selection covers the retriever configuration only; choosing between "
                    "Mistral, Qwen, Llama, Gemma and DeepSeek needs weights that cannot be downloaded here",
                    "the validation split is small (12 of 48 training queries), so candidate scores "
                    "carry a wide error bar; the selection is reproducible but not precise",
                ],
            )

        return self._stage("base_selection", body)

    def _measure_latency(self, rank: Callable[[str], Sequence[str]], judgements: Sequence[Mapping], *, repeats: int = 3) -> float:
        """Milliseconds per query, best of ``repeats`` passes to reduce noise."""
        best = float("inf")
        for _ in range(repeats):
            started = time.perf_counter()
            for judgement in judgements:
                rank(judgement["text"])
            elapsed = (time.perf_counter() - started) * 1000 / max(len(judgements), 1)
            best = min(best, elapsed)
        return round(best, 4)

    # --- stage 3 ----------------------------------------------------------

    def domain_training(self) -> StageResult:
        def body() -> StageResult:
            dataset = self.dataset
            if dataset is None:
                raise RuntimeError("data_validation must run first")
            selected = self.stages["base_selection"].detail.get("selected", {"dModel": self.config.d_model})

            vocabulary = Vocabulary().build(
                [document.text for document in dataset.documents] + [query.text for query in dataset.train_queries]
            )
            model = DualEncoder(vocabulary, self.config.encoder_config(d_model=selected["dModel"]))
            triples = dataset.triples()
            history = model.train(triples)

            self.model = model
            self.vocabulary = vocabulary

            return StageResult(
                name="domain_training",
                status=StageStatus.COMPLETED,
                detail={
                    "triples": len(triples),
                    "vocabulary": len(vocabulary),
                    "parameters": model.parameter_count(),
                    "epochs": len(history),
                    "firstLoss": round(history[0].loss, 6),
                    "finalLoss": round(history[-1].loss, 6),
                    "firstInBatchAccuracy": round(history[0].accuracy, 4),
                    "finalInBatchAccuracy": round(history[-1].accuracy, 4),
                    "weightsDigest": model.weights_digest(),
                    "configDigest": model.config.digest(),
                    "seed": self.config.model_seed,
                },
                limitations=[
                    "trained from scratch on a fixture corpus; this is not fine-tuning of a pretrained model",
                ],
            )

        return self._stage("domain_training", body)

    # --- stages 4-6: blocked here, and honest about it ---------------------

    def sft(self) -> StageResult:
        return self._stage(
            "sft",
            lambda: self._blocked(
                "sft",
                StageStatus.BLOCKED_NEEDS_WEIGHTS,
                "supervised fine-tuning needs a base language model and its weights",
                what_is_needed=(
                    "a downloadable base checkpoint (huggingface.co and download.pytorch.org are both "
                    "unreachable from this host), a LoRA/QLoRA runtime, and a GPU or enough CPU time for "
                    "the corpus size. The interface exists: fabric.pipeline.Pipeline.sft is the seam."
                ),
            ),
        )

    def preference_optimization(self) -> StageResult:
        return self._stage(
            "preference_optimization",
            lambda: self._blocked(
                "preference_optimization",
                StageStatus.BLOCKED_NEEDS_WEIGHTS,
                "no preference data, no reward signal and no compute to justify it",
                what_is_needed=(
                    "paired preference judgements over outputs from an SFT model, plus a reward model or "
                    "human labels. The brief permits this stage only when data, reward signals, evaluation "
                    "and compute justify it; on this host none of the four are present."
                ),
            ),
        )

    def distillation(self) -> StageResult:
        return self._stage(
            "distillation",
            lambda: self._blocked(
                "distillation",
                StageStatus.BLOCKED_NEEDS_WEIGHTS,
                "distillation needs a teacher model, and no teacher is installed",
                what_is_needed=(
                    "a larger teacher able to generate soft targets over the training corpus, and the "
                    "compute to run it. Upstream sparsiz/distillation.py simulated this step with "
                    "random values; simulating it here would produce a number that looks like a result."
                ),
            ),
        )

    # --- stage 7 ----------------------------------------------------------

    def evaluation(self) -> StageResult:
        def body() -> StageResult:
            dataset, model = self.dataset, self.model
            if dataset is None or model is None:
                raise RuntimeError("data_validation and domain_training must run first")

            judgements = [{"id": q.query_id, "text": q.text, "relevant": q.relevant} for q in dataset.evaluation_queries]
            bm25 = dataset.index()
            bm25_rank = lambda text: [hit["docId"] for hit in bm25.search(text, top_k=10)]  # noqa: E731
            dense_rank = self._rank_with(model, dataset)

            baseline = evaluate_ranker(judgements, bm25_rank, corpus_size=len(dataset.documents), index_stats=bm25.stats())
            trained = evaluate_ranker(judgements, dense_rank, corpus_size=len(dataset.documents))

            # The control: same architecture, same seed, no training. Without it a
            # good score could be an accident of the initialisation.
            control = DualEncoder(self.vocabulary, self.config.encoder_config())
            control_report = evaluate_ranker(judgements, self._rank_with(control, dataset))

            bm25_latency = self._measure_latency(bm25_rank, judgements)
            dense_latency = self._measure_latency(dense_rank, judgements)

            variant_metrics = {
                "mrr": trained.metrics["mrr"],
                "recall@1": trained.metrics["recall@1"],
                "recall@5": trained.metrics["recall@5"],
                "ndcg@10": trained.metrics["ndcg@10"],
                "latencyMs": dense_latency,
            }
            hypothesis = Hypothesis(
                statement=(
                    f"a from-scratch dual encoder trained on {len(dataset.triples())} BM25-mined triples "
                    f"ranks the held-out queries better than unmodified BM25 on the same corpus and tokeniser"
                ),
                root_cause=RootCause.RETRIEVAL,
                target_metric="mrr",
                min_improvement=0.05,
                change="replace BM25 scoring with dense cosine similarity over trained embeddings",
            )
            record = self.ledger.run_experiment(
                hypothesis,
                "bm25",
                lambda: variant_metrics,
                dataset_digest=dataset.digest(),
                corpus_size=len(dataset.documents),
                hardware=hardware_profile(),
                config={**self.config.as_dict(), "weightsDigest": model.weights_digest()},
                resource_usage={"parameterCount": model.parameter_count()},
            )

            detail = {
                "conditions": {
                    "overlap": self.config.overlap,
                    "splitBy": self.config.split_by,
                    "evaluationQueries": len(judgements),
                    "corpusSize": len(dataset.documents),
                },
                "bm25": {name: round(baseline.metrics[name], 6) for name in ("mrr", "recall@1", "recall@5", "ndcg@10")},
                "trained": {name: round(trained.metrics[name], 6) for name in ("mrr", "recall@1", "recall@5", "ndcg@10")},
                "untrainedControl": {name: round(control_report.metrics[name], 6) for name in ("mrr", "recall@1", "recall@5", "ndcg@10")},
                "latencyMs": {"bm25": bm25_latency, "dense": dense_latency},
                "experimentId": record.experiment_id,
                "verdict": record.verdict.value,
                "verdictReasons": record.reasons,
                "weightsDigest": model.weights_digest(),
            }

            limitations = [
                "evaluated on a generated fixture corpus; this says nothing about quality on real documents",
                "the dense model encodes the whole corpus in memory and scores by dense matrix product, "
                "so its latency is not comparable to a production ANN index",
                "no comparison against Mistral, Qwen, Llama, Gemma or DeepSeek was possible: none can be "
                "installed on this host, so no superiority claim over them is made or implied",
            ]
            if record.verdict is not ExperimentVerdict.ACCEPT:
                limitations.append(
                    f"the improvement cycle did NOT accept this variant: {'; '.join(record.reasons)}"
                )
            if control_report.metrics["mrr"] >= trained.metrics["mrr"]:
                limitations.append("the untrained control scored as well as the trained model; the gain is not attributable to training")

            if self.config.evaluate_topic_split:
                detail["heldOutTopicCondition"] = self._topic_split_condition()
                limitations.append(
                    "under a held-out-TOPIC split (unseen vocabulary, not the deployment condition) the "
                    f"dense model scores MRR {detail['heldOutTopicCondition']['trained']['mrr']} against BM25 "
                    f"{detail['heldOutTopicCondition']['bm25']['mrr']} — it does not generalise to entirely "
                    "unseen topic vocabularies at this data volume"
                )

            self.results["evaluation"] = detail
            return StageResult(name="evaluation", status=StageStatus.COMPLETED, detail=detail, limitations=limitations)

        return self._stage("evaluation", body)

    def _topic_split_condition(self) -> dict:
        """The harder generalisation check, reported as a limitation rather than hidden."""
        dataset = build_dataset(seed=self.config.data_seed, overlap=self.config.overlap, split_by="topic")
        bm25 = dataset.index()
        judgements = [{"id": q.query_id, "text": q.text, "relevant": q.relevant} for q in dataset.evaluation_queries]
        bm25_report = evaluate_ranker(judgements, lambda text: [hit["docId"] for hit in bm25.search(text, top_k=10)])

        vocabulary = Vocabulary().build(
            [document.text for document in dataset.documents] + [query.text for query in dataset.train_queries]
        )
        model = DualEncoder(vocabulary, self.config.encoder_config())
        model.train(dataset.triples())
        trained_report = evaluate_ranker(judgements, self._rank_with(model, dataset))

        return {
            "splitBy": "topic",
            "evaluationQueries": len(judgements),
            "bm25": {name: round(bm25_report.metrics[name], 6) for name in ("mrr", "recall@1", "recall@5")},
            "trained": {name: round(trained_report.metrics[name], 6) for name in ("mrr", "recall@1", "recall@5")},
            "note": "documents AND queries for held-out topics are unseen; vocabularies barely overlap",
        }

    # --- stage 8 ----------------------------------------------------------

    def release(self) -> StageResult:
        def body() -> StageResult:
            model, dataset = self.model, self.dataset
            if model is None or dataset is None:
                raise RuntimeError("domain_training must run first")
            evaluation = self.stages.get("evaluation")
            if evaluation is None or not evaluation.ran:
                raise RuntimeError("evaluation must complete before release")

            config = self.config
            metrics = {
                "mrr": evaluation.detail["trained"]["mrr"],
                "recall@1": evaluation.detail["trained"]["recall@1"],
                "latencyMs": evaluation.detail["latencyMs"]["dense"],
            }
            requirements = (
                Requirement("mrr", minimum=config.min_mrr, category=BenchmarkCategory.RETRIEVAL),
                Requirement("latencyMs", maximum=config.max_latency_ms, category=BenchmarkCategory.LATENCY),
                # A previously fixed retrieval failure may not break again.
                Requirement("historicalFailures", minimum=1.0, category=BenchmarkCategory.HISTORICAL_FAILURES, hard=False),
            )
            provenance = EvaluationProvenance(
                subject=f"{config.model_name}@{config.model_version}",
                comparator="BM25 (k1=1.5, b=0.75) over the same corpus with the same tokeniser",
                hardware=hardware_profile(),
                decoding={"topK": 10},
                context={"maxTokens": model.config.max_tokens, "pooling": "mean"},
                quantization=None,
                prompts=[query.text for query in dataset.evaluation_queries[:8]],
                dataset_digest=dataset.digest(),
                corpus_size=len(dataset.documents),
                queries=len(dataset.evaluation_queries),
                code_revision=code_revision(),
                seed=config.model_seed,
                limitations=list(evaluation.limitations),
                status=StageStatus.COMPLETED,
            )

            card = self.registry.register(
                name=config.model_name,
                version=config.model_version,
                family="aetheris-lite-dual-encoder",
                licence=config.licence,
                weights_digest=model.weights_digest(),
                requirements=requirements,
                dataset_digest=dataset.digest(),
                config_digest=model.config.digest(),
                parameter_count=model.parameter_count(),
                base_checkpoint=None,
                limitations=[
                    "trained from scratch; not derived from any pretrained base model",
                    "retriever only: it does not generate text",
                ],
                artifacts={"vocabularyDigest": self.vocabulary.digest()},
            )

            validated = self.registry.validate(card.identifier, metrics, provenance=provenance)
            released = None
            release_error = None
            # A variant the improvement cycle rejected is not validated, whatever its
            # individual metrics look like. Releasing it anyway would make the ledger
            # advisory rather than a gate.
            verdict = evaluation.detail.get("verdict")
            if verdict is not None and verdict != ExperimentVerdict.ACCEPT.value and validated.status == ModelStatus.VALIDATED:
                validated.status = ModelStatus.REJECTED
                validated.validation.setdefault("hardFailures", []).append(
                    f"the improvement cycle returned '{verdict}': {'; '.join(evaluation.detail.get('verdictReasons', []))}"
                )
                validated.history.append({"at": time.time(), "event": "release_blocked_by_ledger", "verdict": verdict})
            if validated.status == ModelStatus.VALIDATED:
                try:
                    released = self.registry.release(card.identifier, notes="first Aetheris Lite retriever")
                except Exception as error:  # noqa: BLE001
                    release_error = f"{type(error).__name__}: {error}"

            artifact = None
            if self.output_dir and released is not None:
                path = self.output_dir / f"{config.model_name}-{config.model_version}.json"
                model.save(path)
                artifact = str(path)

            detail = {
                "identifier": card.identifier,
                "statusAfterValidation": validated.status,
                "validation": validated.validation,
                "released": released.identifier if released else None,
                "releaseError": release_error,
                "artifact": artifact,
                "weightsDigest": model.weights_digest(),
                "metrics": metrics,
                "requirements": [requirement.to_dict() for requirement in requirements],
            }
            limitations = []
            if released is None:
                limitations.append(
                    f"the model was NOT released: validation status '{validated.status}'"
                    + (f"; {release_error}" if release_error else "")
                )
            if artifact is None:
                limitations.append("no weights artifact was written; configure output_dir to persist one")

            self.results["release"] = detail
            return StageResult(
                name="release",
                status=StageStatus.COMPLETED if released is not None else StageStatus.FAILED,
                detail=detail,
                limitations=limitations,
            )

        return self._stage("release", body)

    # --- the whole run ----------------------------------------------------

    def run(self, *, run_id: str | None = None, stages: Sequence[str] = STAGE_NAMES) -> RunRecord:
        """Execute the pipeline and return its run record.

        Stages run in order. A stage that fails does not stop the run: later stages
        report that they cannot be trusted, which is more useful than a traceback,
        and the record still shows exactly where it broke.
        """
        record = RunRecord.start(
            "aetheris-lite-pipeline",
            run_id=run_id,
            config=self.config.as_dict(),
            seeds={"data": self.config.data_seed, "model": self.config.model_seed},
            hardware=hardware_profile(),
            code_revision=code_revision(),
        )

        bodies = {
            "data_validation": self.data_validation,
            "base_selection": self.base_selection,
            "domain_training": self.domain_training,
            "sft": self.sft,
            "preference_optimization": self.preference_optimization,
            "distillation": self.distillation,
            "evaluation": self.evaluation,
            "release": self.release,
        }
        unknown = [name for name in stages if name not in bodies]
        if unknown:
            raise ValueError(f"unknown stage(s): {', '.join(unknown)}")

        for name in STAGE_NAMES:
            if name not in stages:
                record.add_stage(name, StageStatus.SKIPPED.value, detail={"reason": "not requested"})
                continue
            result = bodies[name]()
            record.add_stage(name, result.status.value, detail=result.detail, seconds=result.seconds)
            for note in result.limitations:
                if note not in record.limitations:
                    record.limitations.append(note)

        if self.dataset is not None:
            record.dataset = {
                "digest": self.dataset.digest(),
                "documents": len(self.dataset.documents),
                "queries": len(self.dataset.queries),
                "overlap": self.dataset.overlap,
                "splitBy": self.config.split_by,
                "generated": True,
            }
        if self.manifest is not None:
            record.dataset["manifestDigest"] = self.manifest.digest()
        if self.model is not None:
            record.base_checkpoint = None
            record.results["model"] = {
                "weightsDigest": self.model.weights_digest(),
                "parameters": self.model.parameter_count(),
                "configDigest": self.model.config.digest(),
            }
        record.results["experimentLedger"] = self.ledger.summary()
        record.results["modelRegistry"] = self.registry.summary()
        record.results["evaluation"] = self.results.get("evaluation", {})
        record.results["release"] = self.results.get("release", {})

        blocked = [name for name, result in self.stages.items() if result.status.blocked]
        failed = [name for name, result in self.stages.items() if result.status is StageStatus.FAILED]
        if failed:
            status = "failed"
            error = f"stage(s) failed: {', '.join(failed)}"
        elif blocked:
            status = "partial"
            error = None
        else:
            status = "completed"
            error = None

        if blocked:
            record.limitations.append(
                f"{len(blocked)} of {len(STAGE_NAMES)} pipeline stages could not run on this host: "
                f"{', '.join(blocked)}"
            )
        return record.finish(status, error=error, limitations=record.limitations)
