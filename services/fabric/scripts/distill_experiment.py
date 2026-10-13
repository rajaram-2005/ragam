#!/usr/bin/env python3
"""Does logit distillation help? A controlled experiment, not a demonstration.

    python scripts/distill_experiment.py --teacher artifacts/<run>.npz --seeds 3

Both arms train the **same student architecture, the same initial weights, the same
data in the same order, for the same number of steps**. The only difference is the
objective: plain cross-entropy, or the combined hard-label plus temperature-scaled KL
objective. `alpha = 1.0` is what selects the baseline, so the two arms are one code
path with one setting changed.

That pairing matters more than it looks. Training two models and comparing their
perplexities compares seed noise as much as method; the paired design means the seed
cancels, and what is left is the effect of the teacher signal.

The verdict follows the convention already used by the Sparsiz improvement cycle:
"accept" needs the same sign on every seed *and* a mean that clears the spread across
seeds. "reject" needs exactly the same evidence in the other direction. Anything else
is recorded as inconclusive -- a result that did not replicate, which is a finding
rather than a failure, and which is reported as neither a win nor a loss.

Nothing here is believed: the numbers come out of the run, and the summary is
computed from them.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

from fabric.lm.data import build_manifest, read_corpus  # noqa: E402
from fabric.lm.train import load_corpus_snapshot  # noqa: E402
from fabric.lm.distill import DistillConfig, teacher_identity, train_student  # noqa: E402
from fabric.lm.model import TransformerConfig, TransformerLM, artifact_digest  # noqa: E402
from fabric.lm.tokenizer import CharacterTokenizer  # noqa: E402


def summarise(pairs) -> dict:
    """The verdict, computed from the paired per-seed results.

    `pairs` is a list of (seed, baseline_nll, distilled_nll). Lower is better, so a
    positive gain means the distilled arm was better.
    """
    if not pairs:
        raise ValueError("no results to summarise")
    gains = [baseline - distilled for _, baseline, distilled in pairs]
    mean = statistics.fmean(gains)
    spread = statistics.stdev(gains) if len(gains) > 1 else 0.0
    return {
        "seedCount": len(pairs),
        "gainsNatsPerToken": gains,
        "meanGain": mean,
        "stdevGain": spread,
        # The two conditions are the same question asked at every seed, so the sign of
        # the per-seed difference is the honest measure of consistency. A mean gain
        # carried by one large seed and reversed on the others is not an improvement.
        "seedsImproved": sum(1 for g in gains if g > 0),
        "seedsReversed": sum(1 for g in gains if g < 0),
        "gainExceedsSeedSpread": abs(mean) > spread if len(gains) > 1 else False,
        "improvedOnEverySeed": all(g > 0 for g in gains),
        "reversedOnEverySeed": all(g < 0 for g in gains),
        "maxGain": max(gains),
        "minGain": min(gains),
    }


def verdict_for(summary: dict) -> tuple[str, str]:
    """Accept or reject only on replicated evidence; otherwise say so.

    Both conclusive verdicts require the same two things: the same sign on *every*
    seed, and a mean that is larger than the spread across seeds. This is deliberately
    symmetric. An earlier version rejected whenever most seeds got worse, which turned
    one large gain and two small losses into "distillation hurts" -- a claim the data
    does not support. When the seeds disagree, or the effect is smaller than the noise,
    the honest answer is that this experiment cannot tell.
    """
    if summary["seedCount"] < 2:
        return "inconclusive", "a single seed cannot separate the method from the seed"
    if summary["improvedOnEverySeed"] and summary["gainExceedsSeedSpread"]:
        return "accept", (
            f"distillation helped on every one of {summary['seedCount']} seeds and the mean "
            f"gain clears the spread across seeds"
        )
    if summary["reversedOnEverySeed"] and summary["gainExceedsSeedSpread"]:
        return "reject", (
            f"distillation was worse on every one of {summary['seedCount']} seeds and the mean "
            f"loss clears the spread across seeds"
        )
    if summary["improvedOnEverySeed"]:
        return "inconclusive", (
            "better on every seed, but the mean gain is smaller than the spread across seeds"
        )
    if summary["reversedOnEverySeed"]:
        return "inconclusive", (
            "worse on every seed, but the mean loss is smaller than the spread across seeds"
        )
    return "inconclusive", (
        f"the seeds disagree ({summary['seedsImproved']} better, {summary['seedsReversed']} "
        f"worse): the effect does not replicate, so neither direction is supported"
    )


def read_teacher_config(teacher_path: Path, override_heads: int | None):
    """Recover the teacher's architecture, refusing to invent any part of it.

    Shapes give vocab, d_model, d_ff, layer count and context length, and those are
    cross-checked against the run report beside the checkpoint. `n_heads` cannot be
    recovered from shapes at all -- it is only in the report -- so it is either read
    from there or supplied explicitly. A wrong head count does not raise; it produces
    a teacher whose logits are quietly wrong, which is the one failure this whole
    experiment exists to measure.
    """
    with np.load(teacher_path) as data:
        vocab = int(data["emb"].shape[0])
        d_model = int(data["emb"].shape[1])
        layer_names = sorted({name.split(".")[0] for name in data.files if re.fullmatch(r"L\d+.*", name)})
        layers = len(layer_names)
        ff_names = [n for n in data.files if n.endswith(".w1")]
        if not ff_names:
            raise KeyError(f"{teacher_path.name} has no layer-1 projections; is this a checkpoint?")
        d_ff = int(data[ff_names[0]].shape[1])
        seq_len = int(data["pos"].shape[0])

    source = "shapes in the checkpoint"
    heads = override_heads
    reports = sorted(teacher_path.parent.glob("*.report.json"))
    reported = None
    for candidate in reports:
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        model_config = payload.get("model_config") or {}
        if model_config.get("vocab_size") == vocab and model_config.get("d_model") == d_model:
            reported = model_config
            break
    if reported:
        for field, measured in (("vocab_size", vocab), ("d_model", d_model), ("d_ff", d_ff),
                                ("n_layers", layers), ("seq_len", seq_len)):
            if field in reported and int(reported[field]) != measured:
                raise RuntimeError(
                    f"the checkpoint and its report disagree on {field}: shapes say {measured}, "
                    f"the report says {reported[field]}. One of them describes a different model."
                )
        if heads is None and reported.get("n_heads"):
            heads = int(reported["n_heads"])
            source = f"model_config in {reported.get('runName', 'the run report')}"
    if heads is None:
        raise SystemExit(
            "error: cannot determine the teacher's head count -- the checkpoint stores parameters "
            "only. Put the run report beside the checkpoint, or pass --teacher-heads explicitly."
        )
    return TransformerConfig(
        vocab_size=vocab, d_model=d_model, n_layers=layers,
        n_heads=heads, d_ff=d_ff, seq_len=seq_len,
    ), source


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--teacher", required=True, help="path to the teacher .npz checkpoint")
    parser.add_argument(
        "--teacher-heads", type=int, default=None,
        help="override the teacher's head count; read from the run report beside the checkpoint when absent",
    )
    parser.add_argument("--corpus-root", default=None)
    parser.add_argument(
        "--corpus-snapshot", default=None,
        help=(
            "run against the exact text a training run recorded, instead of the repository as it "
            "is now. Use the teacher's own snapshot: the vocabulary must match the teacher's."
        ),
    )
    parser.add_argument("--steps", type=int, default=300)
    parser.add_argument("--seeds", type=int, default=3, help="how many model seeds to run both arms at")
    parser.add_argument("--temperature", type=float, default=2.0)
    parser.add_argument("--alpha", type=float, default=0.5)
    parser.add_argument("--d-model", type=int, default=48)
    parser.add_argument("--n-layers", type=int, default=2)
    parser.add_argument("--n-heads", type=int, default=4)
    parser.add_argument("--d-ff", type=int, default=192)
    parser.add_argument("--seq-len", type=int, default=96)
    parser.add_argument("--batch-size", type=int, default=12)
    parser.add_argument("--learning-rate", type=float, default=3e-3)
    parser.add_argument("--warmup-steps", type=int, default=40)
    parser.add_argument("--data-seed", type=int, default=0)
    parser.add_argument("--split-seed", type=int, default=20251012)
    parser.add_argument("--validation-fraction", type=float, default=0.10)
    parser.add_argument("--json", dest="json_out", default=None)
    parser.add_argument("--quiet", action="store_true")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    here = Path(__file__).resolve().parent.parent
    corpus_root = Path(args.corpus_root).resolve() if args.corpus_root else here.parent.parent
    teacher_path = Path(args.teacher).resolve()
    if not teacher_path.exists():
        print(f"error: teacher checkpoint not found: {teacher_path}", file=sys.stderr)
        return 2

    started = time.time()
    if args.corpus_snapshot:
        # The teacher's own text, byte for byte. The corpus is this repository, so it
        # changes whenever the repository does -- and a student distilled against a
        # teacher whose tokenizer saw different characters is not a distillation at
        # all. Using the snapshot makes the experiment independent of whatever has been
        # edited since the teacher was trained. This is not hypothetical: the first
        # attempt at this experiment was refused because eight characters had entered
        # the corpus between training the teacher and running it.
        train_text, validation_text, snapshot_manifest = load_corpus_snapshot(args.corpus_snapshot)
        manifest = None
        corpus_label = f"snapshot {Path(args.corpus_snapshot).name}"
        manifest_digest = snapshot_manifest["digest"]
        counts = (snapshot_manifest["trainFiles"], snapshot_manifest["validationFiles"])
    else:
        manifest = build_manifest(
            corpus_root, validation_fraction=args.validation_fraction, split_seed=args.split_seed
        )
        if manifest.overlap():
            raise RuntimeError("the corpus split leaked files across both sides")
        train_text = read_corpus(corpus_root, manifest.train)
        validation_text = read_corpus(corpus_root, manifest.validation)
        manifest_digest = manifest.digest
        corpus_label = str(corpus_root)
        counts = (len(manifest.train), len(manifest.validation))
    tokenizer = CharacterTokenizer.fit([train_text])
    train_ids = tokenizer.encode(train_text)
    validation_ids = tokenizer.encode(validation_text)

    # The teacher's architecture has to be exact: n_heads is not stored in the
    # checkpoint (only the parameters are), and loading a model with the wrong head
    # count silently produces a different forward pass -- a teacher that is not the
    # model that was trained. So it is read from the run report, never guessed.
    teacher_config, config_source = read_teacher_config(teacher_path, args.teacher_heads)
    if teacher_config.vocab_size != tokenizer.size:
        print(
            f"error: the teacher was trained with {teacher_config.vocab_size} characters but this "
            f"corpus has {tokenizer.size}. Distillation needs a shared vocabulary: the student "
            "predicts the teacher's distribution over the same symbols. Pass the corpus the teacher "
            "was trained on (its run report records the manifest digest).",
            file=sys.stderr,
        )
        return 2

    teacher = TransformerLM.load(teacher_path, teacher_config)
    student_config = TransformerConfig(
        vocab_size=tokenizer.size, d_model=args.d_model, n_layers=args.n_layers,
        n_heads=args.n_heads, d_ff=args.d_ff, seq_len=args.seq_len,
    )
    distill = DistillConfig(temperature=args.temperature, alpha=args.alpha)

    print("aetheris-lite distillation experiment")
    print(f"  teacher      {teacher_path.name}")
    print(f"               {teacher.parameter_count:,} parameters, digest {teacher_identity(teacher)['weightsDigest'][:16]}…")
    print(f"               architecture {teacher_config.d_model}d × {teacher_config.n_layers}L × "
          f"{teacher_config.n_heads}h, from {config_source}")
    print(f"  student      {student_config.parameter_count():,} parameters "
          f"(d_model {args.d_model}, {args.n_layers} layers, d_ff {args.d_ff})")
    print(f"  corpus       {corpus_label}")
    print(f"               {manifest_digest[:16]}…  {counts[0]} train / {counts[1]} validation files")
    print(f"  objective    temperature {args.temperature}, alpha {args.alpha} "
          f"(baseline is alpha = 1.0, same code path)")
    print(f"  budget       {args.steps} steps, batch {args.batch_size}, seq {args.seq_len}, "
          f"{args.seeds} seeds × 2 arms = {args.seeds * 2} runs")
    print()

    runs = []
    for seed in range(args.seeds):
        for label, arm in (("baseline", DistillConfig(temperature=args.temperature, alpha=1.0)), ("distilled", distill)):
            if not args.quiet:
                print(f"  [{seed}] {label}…", flush=True)
            result = train_student(
                student_config, teacher, train_ids, validation_ids,
                vocab_size=tokenizer.size, distill=arm, steps=args.steps,
                batch_size=args.batch_size, seq_len=args.seq_len,
                learning_rate=args.learning_rate, warmup_steps=args.warmup_steps,
                model_seed=seed, data_seed=args.data_seed,
            )
            runs.append({
                "seed": seed,
                "arm": label,
                "alpha": arm.alpha,
                "temperature": arm.temperature,
                "nllNatsPerToken": result["evaluation"]["nllNatsPerToken"],
                "perplexity": result["evaluation"]["perplexity"],
                "bitsPerCharacter": result["evaluation"]["bitsPerCharacter"],
                "finalLoss": result["finalLoss"],
                "weightDigest": result["weightDigest"],
                "parameterCount": result["parameterCount"],
                "teacherForwards": result["teacherForwards"],
                "baselines": result["evaluation"]["baselines"],
            })
            if not args.quiet:
                print(f"           nll {result['evaluation']['nllNatsPerToken']:.6f}  "
                      f"ppl {result['evaluation']['perplexity']:.4f}")

    by_seed = {}
    for run in runs:
        by_seed.setdefault(run["seed"], {})[run["arm"]] = run["nllNatsPerToken"]
    pairs = [(seed, arms["baseline"], arms["distilled"]) for seed, arms in sorted(by_seed.items())]
    summary = summarise(pairs)
    verdict, rationale = verdict_for(summary)

    report = {
        "experiment": "logit-distillation-vs-baseline",
        "teacher": teacher_identity(teacher),
        "teacherConfig": teacher_config.to_dict(),
        "teacherConfigSource": config_source,
        "teacherFile": {"filename": teacher_path.name, "digest": artifact_digest(teacher_path)},
        "studentConfig": student_config.to_dict(),
        "distillConfig": distill.to_dict(),
        "budget": {
            "steps": args.steps, "batchSize": args.batch_size, "seqLen": args.seq_len,
            "seeds": args.seeds, "dataSeed": args.data_seed, "splitSeed": args.split_seed,
        },
        "corpus": {
            "manifestDigest": manifest_digest,
            "root": str(corpus_root),
            "snapshot": str(args.corpus_snapshot) if args.corpus_snapshot else None,
            "trainFiles": counts[0],
            "validationFiles": counts[1],
            "trainTokens": int(train_ids.size), "validationTokens": int(validation_ids.size),
        },
        "tokenizer": {"size": tokenizer.size, "vocabularyDigest": tokenizer.digest},
        "runs": runs,
        "summary": summary,
        "verdict": verdict,
        "rationale": rationale,
        "wallSeconds": round(time.time() - started, 3),
    }
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")

    print()
    print("  paired results (lower nll is better):")
    print("    seed   baseline      distilled   gain")
    for seed, baseline, distilled in pairs:
        print(f"    {seed:>4}   {baseline:.6f}    {distilled:.6f}   {baseline - distilled:+.6f}")
    print()
    print(f"  mean gain          {summary['meanGain']:+.6f} nats/token")
    print(f"  spread across seeds {summary['stdevGain']:.6f}")
    print(f"  seeds improved      {summary['seedsImproved']} of {summary['seedCount']}")
    print(f"  seeds reversed      {summary['seedsReversed']} of {summary['seedCount']}")
    print(f"  clears the spread   {summary['gainExceedsSeedSpread']}")
    print(f"  VERDICT             {verdict.upper()}: {rationale}")
    print(f"  wall                {report['wallSeconds']}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
