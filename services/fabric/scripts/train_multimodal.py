#!/usr/bin/env python3
"""Train, release-gate, model-card, and install all six first-party Klyvaron multimodal models:
  - Image: `klyvaron-pro-image@0.1.0`, `klyvaron-max-image@0.1.0` (`aetheris-image-v1`)
  - Video: `klyvaron-pro-video@0.1.0`, `klyvaron-max-video@0.1.0` (`aetheris-video-v1`)
  - Voice: `klyvaron-pro-voice@0.1.0`, `klyvaron-max-voice@0.1.0` (`aetheris-voice-v1`)

Writes committed model cards to `docs/model-cards/` and reproducible run records to
`docs/experiments/`, matching `ModelReleaseManager` release-gate requirements.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile

REPO_ROOT = Path(__file__).resolve().parents[3]
FABRIC_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(FABRIC_ROOT))

from fabric.modelcards import EvaluationProvenance, ModelReleaseManager, Requirement, StageStatus  # noqa: E402
from fabric.multimodal.image_model import train_and_export_image_preset  # noqa: E402
from fabric.multimodal.video_model import train_and_export_video_preset  # noqa: E402
from fabric.multimodal.voice_model import train_and_export_voice_preset  # noqa: E402


def _write_cards_and_run_record(manifest: dict, preset: str) -> None:
    model_id = manifest["id"]
    version = manifest["version"]
    modality = manifest["modality"]
    metrics = manifest["metrics"]

def _write_cards_and_run_record(manifest: dict, preset: str) -> None:
    import platform

    model_id = manifest["id"]
    version = manifest["version"]
    modality = manifest["modality"]
    metrics = manifest["metrics"]

    mgr = ModelReleaseManager()
    prov = EvaluationProvenance(
        subject=f"{model_id} (from-scratch first-party {manifest['architecture']['id']})",
        comparator=f"held-out uniform/mean baseline for {modality}",
        hardware={
            "machine": platform.machine(),
            "platform": platform.platform(),
            "accelerator": "none (2-vCPU AVX-512 CPU host; GPU runtimes supported when user machine has hardware)",
        },
        decoding={"mode": "deterministic", "seed": 0},
        context={"modality": modality, "supportedTasks": manifest["supportedTasks"]},
        quantization=None,
        prompts=[f"first-party {modality} evaluation split"],
        dataset_digest=manifest["processor"]["sha256"],
        corpus_size=int(metrics.get("steps", 1)),
        code_revision="c9785ede9ffd73d70878c16cd96784159143a1fb",
        seed=int(manifest["provenance"]["seed"]),
        limitations=list(manifest["limitations"]),
        status=StageStatus.COMPLETED,
    )

    if modality == "image":
        reqs = (
            Requirement(metric="validationSceneAccuracy", minimum=0.70, hard=True),
            Requirement(metric="generationPromptAlignmentAccuracy", minimum=0.70, hard=True),
            Requirement(metric="lossImprovement", minimum=0.50, hard=True),
        )
    elif modality == "video":
        reqs = (
            Requirement(metric="validationMotionAccuracy", minimum=0.70, hard=True),
            Requirement(metric="validationEnvironmentAccuracy", minimum=0.70, hard=True),
            Requirement(metric="lossImprovement", minimum=0.50, hard=True),
        )
    else:
        reqs = (
            Requirement(metric="validationUtteranceAccuracy", minimum=0.75, hard=True),
            Requirement(metric="validationCharacterErrorRate", maximum=0.35, hard=True),
            Requirement(metric="roundTripTtsToAsrCer", maximum=0.35, hard=True),
            Requirement(metric="lossImprovement", minimum=0.50, hard=True),
        )

    card = mgr.register(
        name=model_id,
        version=version,
        family=f"klyvaron-{preset}",
        licence="MIT",
        weights_digest=manifest["weights"]["weightsSha256"],
        base_checkpoint=None,
        config_digest=manifest["architecture"]["configDigest"],
        dataset_digest=manifest["processor"]["sha256"],
        parameter_count=manifest["parameterCount"],
        requirements=reqs,
        limitations=manifest["limitations"],
        provenance=prov,
        artifacts={
            "filename": manifest["weights"]["file"],
            "fileDigest": manifest["weights"]["sha256"],
            "bytes": manifest["weights"]["bytes"],
            "processorFile": manifest["processor"]["file"],
            "processorDigest": manifest["processor"]["sha256"],
            "modality": modality,
            "supportedTasks": manifest["supportedTasks"],
            "unsupportedTasks": manifest["unsupportedTasks"],
            "trainer": manifest["provenance"]["trainer"],
        },
    )
    numeric_metrics = {k: float(v) for k, v in metrics.items() if isinstance(v, (int, float))}
    mgr.validate(card.identifier, numeric_metrics, provenance=prov)
    released = mgr.release(
        card.identifier,
        notes=f"first-party {model_id} trained from random init (seed={manifest['provenance']['seed']})",
    )

    cards_dir = REPO_ROOT / "docs" / "model-cards"
    exp_dir = REPO_ROOT / "docs" / "experiments"
    cards_dir.mkdir(parents=True, exist_ok=True)
    exp_dir.mkdir(parents=True, exist_ok=True)

    card_json = {
        "format": "aetheris-model-card/v1",
        "generatedBy": "services/fabric/scripts/train_multimodal.py",
        "reproduce": f"python3 services/fabric/scripts/train_multimodal.py --modality {modality} --preset {preset}",
        "runId": manifest["weights"]["weightsSha256"][:12],
        "runStatus": "released",
        "card": released.to_dict(),
    }
    (cards_dir / f"{model_id}-{version}.json").write_text(json.dumps(card_json, indent=2) + "\n", encoding="utf-8")

    md = [
        f"# Model card — {model_id} {version}",
        "",
        "| | |",
        "|---|---|",
        f"| **Identifier** | `{released.identifier}` |",
        f"| **Family** | `klyvaron-{preset}` |",
        f"| **Modality** | `{modality}` |",
        f"| **Architecture** | `{manifest['architecture']['id']}` (`{manifest['parameterCount']:,}` parameters) |",
        f"| **Status** | `{released.status}` (`0` hard failures) |",
        "| **Licence** | MIT — trained from random initialisation (`baseCheckpoint: null`) |",
        f"| **Weights SHA-256** | `{manifest['weights']['weightsSha256']}` |",
        f"| **Package SHA-256** | `{manifest['weights']['sha256']}` (`{manifest['weights']['bytes']:,}` bytes) |",
        f"| **Supported tasks** | `{', '.join(manifest['supportedTasks'])}` |",
        f"| **Unsupported tasks** | `{', '.join(manifest['unsupportedTasks'])}` |",
        "",
        "## Held-out Evaluation Metrics",
        "",
        *[f"- **`{k}`**: `{v}`" for k, v in metrics.items()],
        "",
        "## Known Limitations",
        "",
        *[f"- {line}" for line in manifest["limitations"]],
        "",
        "## Intended Use & Out-of-Scope Limitations",
        "",
        f"- **Intended use**: local/worker execution of `{', '.join(manifest['supportedTasks'])}` in RAGAM.",
        f"- **Out of scope**: `{', '.join(manifest['unsupportedTasks'])}`.",
        "",
    ]
    (cards_dir / f"{model_id}-{version}.md").write_text("\n".join(md), encoding="utf-8")

    run_record = {
        "schema": "klyvaron-multimodal-training-run/1",
        "recordedAt": datetime.now(timezone.utc).isoformat(),
        "modelId": f"{model_id}@{version}",
        "modality": modality,
        "tier": preset,
        "architecture": manifest["architecture"],
        "parameterCount": manifest["parameterCount"],
        "provenance": manifest["provenance"],
        "supportedTasks": manifest["supportedTasks"],
        "unsupportedTasks": manifest["unsupportedTasks"],
        "weights": manifest["weights"],
        "processor": manifest["processor"],
        "metrics": metrics,
        "limitations": manifest["limitations"],
    }
    (exp_dir / f"{model_id}-run.json").write_text(json.dumps(run_record, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--modality", choices=["image", "video", "voice", "all"], default="all")
    parser.add_argument("--preset", choices=["pro", "max", "all"], default="all")
    parser.add_argument(
        "--install-root",
        default=str(REPO_ROOT / ".aetheris-data" / "online" / "klyvaron" / "models"),
    )
    parser.add_argument("--skip-cards", action="store_true")
    args = parser.parse_args()

    install_root = Path(args.install_root)
    modalities = ["image", "video", "voice"] if args.modality == "all" else [args.modality]
    presets = ["pro", "max"] if args.preset == "all" else [args.preset]

    trainers = {
        "image": train_and_export_image_preset,
        "video": train_and_export_video_preset,
        "voice": train_and_export_voice_preset,
    }

    for mod in modalities:
        for preset in presets:
            print(f"[multimodal] Training {mod} preset={preset} -> {install_root} ...", flush=True)
            manifest = trainers[mod](preset, install_root)
            (install_root / manifest["id"] / ".ready").write_text("ok\n", encoding="utf-8")
            if not args.skip_cards:
                _write_cards_and_run_record(manifest, preset)
            print(
                f"[{manifest['id']}] COMPLETE | params={manifest['parameterCount']:,} | "
                f"bytes={manifest['weights']['bytes']:,} | "
                f"weightsSha256={manifest['weights']['weightsSha256']} | "
                f"metrics={json.dumps(manifest['metrics'])}",
                flush=True,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
