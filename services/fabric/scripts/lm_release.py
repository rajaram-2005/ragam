#!/usr/bin/env python3
"""Run a training report through the Aetheris Lite release gate and emit its card.

    python scripts/lm_release.py --report artifacts/<run>.report.json --version 0.1.0

The gate is `fabric/modelcards.py`, the same one the retrieval pipeline uses. This
script only supplies the policy and writes the card. A candidate that fails is
written out as REJECTED, with its reasons, rather than being quietly dropped --
a rejection is a result and belongs in the record.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fabric.lm.card import candidate_from_report  # noqa: E402
from fabric.modelcards import ModelReleaseManager  # noqa: E402


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--report", required=True, help="a report JSON written by scripts/train_lm.py")
    parser.add_argument("--version", required=True, help="version to register, e.g. 0.1.0")
    parser.add_argument("--out", default=None, help="write the card JSON here")
    parser.add_argument("--json", dest="json_out", default=None, help="write a machine-readable verdict here")
    args = parser.parse_args(argv)

    report = json.loads(Path(args.report).read_text(encoding="utf-8"))
    manager = ModelReleaseManager()
    card, released = candidate_from_report(report, manager, version=args.version)

    payload = card.to_dict()
    if args.out:
        Path(args.out).write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")

    print(f"aetheris-lite release gate: {card.identifier}")
    print(f"  status        {card.status}")
    print(f"  weightsDigest {card.weights_digest[:16]}…")
    print(f"  parameters    {card.parameter_count:,}")
    for name, value in sorted(card.metrics.items()):
        print(f"  metric        {name:24} {value:.6f}")
    validation = card.validation or {}
    for kind in ("hardFailures", "softFailures"):
        entries = validation.get(kind) or []
        print(f"  {kind:14} {len(entries)}")
        for entry in entries:
            print(f"     - {json.dumps(entry, default=str)}")
    print(f"  verdict       {'RELEASED' if released else 'NOT RELEASED'}")
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    return 0 if released else 1


if __name__ == "__main__":
    raise SystemExit(main())
