#!/usr/bin/env python3
"""Train an Aetheris Lite language model from scratch in pure NumPy.

    python scripts/train_lm.py --steps 2600 --d-model 96 --n-layers 3

Everything is deterministic: the same arguments, the same corpus and the same seeds
produce a bit-identical artifact, and the report records enough to prove it. The
artifact lands in `artifacts/` (gitignored by policy -- weights are referenced by
hash from a model card, never redistributed through this repository).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fabric.lm.train import TrainConfig, train  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--corpus-root", default=None, help="repository root to read text from")
    parser.add_argument("--output-dir", default=None, help="where the artifact and report are written")
    parser.add_argument("--run-name", default="aetheris-lite-lm")
    parser.add_argument("--steps", type=int, default=2600)
    parser.add_argument("--d-model", type=int, default=96)
    parser.add_argument("--n-layers", type=int, default=3)
    parser.add_argument("--n-heads", type=int, default=4)
    parser.add_argument("--d-ff", type=int, default=384)
    parser.add_argument("--seq-len", type=int, default=128)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=3e-3)
    parser.add_argument("--warmup-steps", type=int, default=200)
    parser.add_argument("--model-seed", type=int, default=0)
    parser.add_argument("--data-seed", type=int, default=0)
    parser.add_argument("--split-seed", type=int, default=20251012)
    parser.add_argument("--validation-fraction", type=float, default=0.10)
    parser.add_argument("--dtype", default="float32", choices=("float32", "float64"))
    parser.add_argument("--overwrite", action="store_true", help="replace an existing artifact with the same hash")
    parser.add_argument("--json", dest="json_out", default=None, help="write the report JSON here as well")
    parser.add_argument("--quiet", action="store_true")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    here = Path(__file__).resolve().parent.parent
    corpus_root = Path(args.corpus_root).resolve() if args.corpus_root else here.parent.parent
    output_dir = Path(args.output_dir).resolve() if args.output_dir else here / "artifacts"

    config = TrainConfig(
        d_model=args.d_model, n_layers=args.n_layers, n_heads=args.n_heads, d_ff=args.d_ff,
        seq_len=args.seq_len, batch_size=args.batch_size, steps=args.steps,
        learning_rate=args.learning_rate, warmup_steps=args.warmup_steps,
        model_seed=args.model_seed, data_seed=args.data_seed, split_seed=args.split_seed,
        validation_fraction=args.validation_fraction, dtype=args.dtype,
        corpus_root=str(corpus_root),
    )

    def progress(step, total, loss):
        if not args.quiet:
            print(f"  step {step + 1:>5}/{total}  loss {loss:7.4f}", flush=True)

    print(f"aetheris-lite: training {args.run_name}")
    print(f"  corpus   {corpus_root}")
    print(f"  output   {output_dir}")
    started = time.time()
    report = train(config, output_dir=output_dir, corpus_root=corpus_root,
                   run_name=args.run_name, overwrite=args.overwrite, progress=progress)
    payload = report.to_dict()

    if args.json_out:
        Path(args.json_out).write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")

    ev = payload["evaluation"]
    print()
    print(f"  parameters   {payload['provenance']['parameterCount']:,}")
    print(f"  vocab        {payload['tokenizer']['size']} characters "
          f"(validation unknown rate {payload['tokenizer']['validationUnknownRate']:.6f})")
    print(f"  corpus       {payload['corpus']['trainFiles']} train / "
          f"{payload['corpus']['validationFiles']} validation files, no overlap")
    print(f"  loss         {payload['loss_curve'][0]['loss']:.4f} -> {payload['final_loss']:.4f}")
    print(f"  validation   perplexity {ev['perplexity']:.4f}  "
          f"({ev['bitsPerCharacter']:.4f} bits/char over {ev['tokensEvaluated']:,} tokens)")
    for baseline in ev["baselines"]:
        marker = " <-- best baseline" if baseline["name"] == ev["bestBaseline"] else ""
        print(f"     baseline {baseline['name']:8} perplexity {baseline['perplexity']:9.4f}{marker}")
    verdict = "BEATS" if ev["beatsAllBaselines"] else "DOES NOT BEAT"
    print(f"  verdict      {verdict} the best baseline "
          f"(ratio {ev['perplexityVsBestBaseline']:.4f})")
    print(f"  wall         {payload['resource']['wallSeconds']}s, "
          f"peak memory {payload['resource']['peakMemoryMb']} MB")
    print(f"  artifact     {payload['artifact']['filename']} "
          f"({payload['artifact']['bytes']:,} bytes)")
    print(f"  weights      {payload['artifact']['weightsDigest']}")
    print(f"  revision     {payload['provenance']['codeRevision']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
