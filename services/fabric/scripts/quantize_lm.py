#!/usr/bin/env python3
"""Evaluate and export a CPU weight-only int8 candidate; no training or downloads.

python scripts/quantize_lm.py --source artifacts/lite --output artifacts/lite-int8 \
    --version 0.1.1-int8 --validation-text /path/to/held-out.txt \
    --max-nll-increase 0.02 --max-disagreement 0.05 --report artifacts/int8-evaluation.json

Use held-out representative text. Thresholds are an explicit operator decision,
not universal quality minima. A rejected conversion writes a report, not a model.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fabric.lm.quantize import quantize_artifact  # noqa: E402
from fabric.lm.export import write_json  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--validation-text", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--max-nll-increase", type=float, required=True)
    parser.add_argument("--max-disagreement", type=float, required=True)
    parser.add_argument("--max-unknown-rate", type=float, default=0.01)
    parser.add_argument("--max-tokens", type=int, default=4096)
    args = parser.parse_args(argv)
    if args.report.exists() or args.report.resolve().is_relative_to(args.output.resolve()) or args.report.resolve().is_relative_to(args.source.resolve()):
        parser.error("report must be a new file outside the source and output artifact directories")
    try:
        report = quantize_artifact(args.source, args.output, version=args.version,
            validation_text=args.validation_text.read_text(encoding="utf-8"),
            max_nll_increase=args.max_nll_increase, max_disagreement=args.max_disagreement,
            max_unknown_rate=args.max_unknown_rate, max_tokens=args.max_tokens)
        write_json(args.report, report)
    except (ValueError, OSError, KeyError) as error:
        print(f"quantization refused: {error}", file=sys.stderr)
        return 2
    print(json.dumps(report, indent=2))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
