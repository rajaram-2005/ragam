#!/usr/bin/env python3
"""Export a trained checkpoint as a loadable Klyvaron artifact, or write a parity fixture.

    # export a finished run (artifacts/ holds a *.report.json and its corpus snapshot)
    python scripts/export_lm.py --from-run services/fabric/artifacts \\
        --output services/fabric/artifacts/klyvaron-lite --id aetheris-lite-lm --version 0.1.0

    # write the fixture that pins services/core's JavaScript forward pass to this one
    python scripts/export_lm.py --parity-fixture services/core/test/fixtures/klyvaron-lite-parity.json

    # re-check an exported directory without loading it into the runtime
    python scripts/export_lm.py --verify services/fabric/artifacts/klyvaron-lite

The artifact written here is what `services/core/src/klyvaron/format.mjs` loads: a
manifest next to an `.npz`. Nothing in this script invents a measurement -- the
parameter count, the digests and the corpus digest all come out of the run's own report
and the bytes on disk, and the export refuses when the two disagree.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fabric.lm.export import (  # noqa: E402
    ARTIFACT_FORMAT,
    load_tokenizer_manifest,
    parity_fixture as build_parity_fixture,
    export_artifact,
    write_json,
)
from fabric.lm.model import TransformerConfig  # noqa: E402

#: The limitations a base completion model ships with. They are stated on the artifact
#: rather than in a document, because a document is not what a loader reads.
BASE_LIMITATIONS = [
    "It does not follow instructions. It continues text, and a question looks to it like more text to continue.",
    "Its output is not fluent and must not be presented as a chat answer.",
    "It was trained on this repository's own text, so it reproduces that distribution and nothing else.",
    "It is far below the capability targets of the Klyvaron Lite tier; it is a real model, not a competent assistant.",
]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from-run", default=None, help="directory holding a *.report.json and its corpus snapshot")
    parser.add_argument("--report", default=None, help="an explicit report JSON path")
    parser.add_argument("--artifact", default=None, help="an explicit .npz path")
    parser.add_argument("--corpus-snapshot", default=None, help="an explicit *.corpus.json path")
    parser.add_argument("--output", default=None, help="directory the artifact is written to")
    parser.add_argument("--id", default="aetheris-lite-lm", help="artifact id, e.g. aetheris-lite-lm")
    parser.add_argument("--version", default="0.1.0")
    parser.add_argument("--tier", default="lite", choices=("lite", "pro", "max"))
    parser.add_argument("--max-new-tokens", type=int, default=64, help="generation ceiling recorded in the manifest")
    parser.add_argument("--limitations", default=None, help="JSON file holding a list of limitation strings")
    parser.add_argument("--parity-fixture", default=None, help="write the cross-language parity fixture here")
    parser.add_argument("--verify", default=None, help="re-check an exported artifact directory")
    parser.add_argument("--json", dest="json_out", default=None, help="write a summary JSON here as well")
    parser.add_argument("--quiet", action="store_true")
    return parser


def resolve_run_paths(args) -> tuple[Path, Path, Path]:
    """Find the report, the checkpoint and the corpus snapshot for a run."""
    if args.report:
        report_path = Path(args.report).resolve()
        artifact_path = Path(args.artifact).resolve() if args.artifact else None
        snapshot_path = Path(args.corpus_snapshot).resolve() if args.corpus_snapshot else None
        if artifact_path is None or snapshot_path is None:
            raise SystemExit("--report requires --artifact and --corpus-snapshot")
        return report_path, artifact_path, snapshot_path

    if not args.from_run:
        raise SystemExit("pass --from-run, or --report/--artifact/--corpus-snapshot, or --parity-fixture, or --verify")
    run_dir = Path(args.from_run).resolve()
    reports = sorted(run_dir.glob("*.report.json"))
    if not reports:
        raise SystemExit(f"no *.report.json in {run_dir}; run scripts/train_lm.py first")
    if len(reports) > 1:
        # Ambiguity is refused rather than resolved by recency: guessing which run to
        # release is how a stale checkpoint acquires a fresh model card.
        raise SystemExit(f"{len(reports)} reports in {run_dir}: {[p.name for p in reports]}; pass --report explicitly")
    report_path = reports[0]
    payload = json.loads(report_path.read_text(encoding="utf-8"))
    artifact_path = run_dir / payload["artifact"]["filename"]
    snapshot_path = run_dir / payload["artifact"]["corpusSnapshot"]
    for path in (artifact_path, snapshot_path):
        if not path.exists():
            raise SystemExit(f"{path} is missing; the report references files that are not next to it")
    return report_path, artifact_path, snapshot_path


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify(directory: Path) -> int:
    """Re-check an exported artifact directory the way a loader would, then report."""
    directory = Path(directory).resolve()
    manifests = sorted(directory.glob("*.klyvaron.json"))
    if len(manifests) != 1:
        print(f"klyvaron-export: expected exactly one manifest in {directory}, found {len(manifests)}", file=sys.stderr)
        return 2
    manifest = json.loads(manifests[0].read_text(encoding="utf-8"))
    problems = []
    from fabric.lm.quantize import QUANTIZED_ARTIFACT_FORMAT, load_quantized_reference, load_source
    if manifest.get("format") == QUANTIZED_ARTIFACT_FORMAT:
        try:
            load_quantized_reference(directory)
        except (ValueError, KeyError, OSError) as error:
            problems.append(str(error))
    elif manifest.get("format") == ARTIFACT_FORMAT:
        try:
            load_source(directory)
        except (ValueError, KeyError, OSError) as error:
            problems.append(str(error))
    else:
        problems.append(f"format is {manifest.get('format')!r}, expected {ARTIFACT_FORMAT!r}")
    weights = directory / str(manifest.get("weights", {}).get("file"))
    if not weights.exists():
        problems.append(f"{weights.name} is not present")
    else:
        digest = _sha256_file(weights)
        if digest != manifest["weights"]["sha256"]:
            problems.append(f"weights hash to {digest}, the manifest says {manifest['weights']['sha256']}")
        if weights.stat().st_size != manifest["weights"]["bytes"]:
            problems.append(f"weights are {weights.stat().st_size} bytes, the manifest says {manifest['weights']['bytes']}")
    tokenizer_size = 0
    try:
        tok = load_tokenizer_manifest(manifest["tokenizer"])
        tokenizer_size = tok.size
    except (ValueError, KeyError, TypeError) as error:
        problems.append(str(error))
    if not manifest.get("limitations"):
        problems.append("the manifest declares no limitations")

    if problems:
        print(f"klyvaron-export: {directory} FAILED verification", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    tok_kind = manifest["tokenizer"].get("kind", "character")
    print(f"klyvaron-export: {manifest['id']} {manifest['version']} verified")
    print(f"  tier          {manifest['tier']}")
    print(f"  parameters    {manifest['provenance'].get('parameterCount')}")
    print(f"  architecture  {manifest['architecture']}")
    print(f"  vocabulary    {tokenizer_size} tokens ({tok_kind}), digest {manifest['tokenizer']['digest'][:16]}...")
    print(f"  weights       {manifest['weights']['file']} {manifest['weights']['bytes']:,} bytes")
    return 0


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    quiet = args.quiet

    if args.verify:
        result = verify(Path(args.verify))
        return result

    if args.parity_fixture:
        fixture = build_parity_fixture(
            config=TransformerConfig(vocab_size=64, d_model=24, n_layers=1, n_heads=4, d_ff=48, seq_len=32),
        )
        digest = write_json(Path(args.parity_fixture), fixture)
        if not quiet:
            manifest = fixture["manifest"]
            print("klyvaron-export: wrote the cross-language parity fixture")
            print(f"  path          {args.parity_fixture}")
            print(f"  parameters    {manifest['provenance']['parameterCount']:,}")
            print(f"  vocabulary    {len(manifest['tokenizer']['characters'])} characters, digest {manifest['tokenizer']['digest'][:16]}...")
            print(f"  cases         {len(fixture['cases'])} prompts, {len(fixture['greedy'])} greedy continuations")
            print(f"  fixture sha256 {digest}")
        return 0

    report_path, artifact_path, snapshot_path = resolve_run_paths(args)
    output_dir = Path(args.output).resolve() if args.output else artifact_path.parent / f"{args.id}-{args.version}"
    report = json.loads(report_path.read_text(encoding="utf-8"))

    limitations = BASE_LIMITATIONS
    if args.limitations:
        limitations = json.loads(Path(args.limitations).read_text(encoding="utf-8"))
        if not isinstance(limitations, list) or not all(isinstance(line, str) for line in limitations):
            raise SystemExit("--limitations must point at a JSON array of strings")

    evaluation = report.get("evaluation", {})
    baselines = {entry["name"]: entry["perplexity"] for entry in evaluation.get("baselines", [])}
    best = min(baselines, key=baselines.get) if baselines else None
    benchmarks = [{
        "name": "held-out next-token perplexity vs computed baselines",
        "protocol": (
            f"character-level, whole-file split, {report['corpus'].get('validationTokens')} validation tokens, "
            f"seeds {report['provenance']['seed']['model']}/{report['provenance']['seed']['data']}/"
            f"{report['provenance']['seed']['split']}"
        ),
        "result": (
            f"{evaluation.get('perplexity')} against {baselines[best]} ({best})"
            if best else "no baselines recorded in this report"
        ),
    }]

    if not quiet:
        print(f"klyvaron-export: {report_path.name}")
        print(f"  checkpoint    {artifact_path.name}")
        print(f"  snapshot      {snapshot_path.name}")
        print(f"  output        {output_dir}")

    try:
        result = export_artifact(
            report=report,
            artifact_path=artifact_path,
            corpus_snapshot=snapshot_path,
            output_dir=output_dir,
            artifact_id=args.id,
            version=args.version,
            tier=args.tier,
            generation={"maxNewTokens": args.max_new_tokens},
            limitations=limitations,
            benchmarks=benchmarks,
            report_path=report_path,
        )
    except (ValueError, KeyError) as error:
        print(f"\nklyvaron-export: refusing to export\n  {error}", file=sys.stderr)
        return 2

    manifest = result["manifest"]
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(result, indent=2), encoding="utf-8")
    if not quiet:
        print()
        print(f"  manifest      {result['manifestPath']}")
        print(f"  weights       {result['weightsPath']}")
        print(f"  weights sha256 {manifest['weights']['sha256']}")
        print(f"  vocabulary    {len(manifest['tokenizer']['characters'])} characters, digest {manifest['tokenizer']['digest'][:16]}...")
        print(f"  limitations   {len(manifest['limitations'])} declared on the artifact")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
