#!/usr/bin/env python3
"""Run the real LoRA smoke job from an ordinary Python machine.

The notebook remains useful on Kaggle and Colab, but it is not a requirement. This
entry point installs the pinned Hugging Face dependencies when they are missing,
uses CUDA when PyTorch can see it and otherwise uses the CPU, moves all writable
paths under ``--workdir``, and drives the same tested ``run_smoke`` orchestration.

No credential, prepared dataset, paid GPU or Drive mount is required. The base model
is public and the starter data is generated locally. The first invocation downloads
roughly one gigabyte of model weights. Re-running the same command resumes from the
newest valid checkpoint in the work directory.
"""

from __future__ import annotations

import argparse
import copy
import importlib
import json
import subprocess
import sys
from importlib import metadata
from pathlib import Path
from typing import Callable, Sequence

HERE = Path(__file__).resolve().parent
FABRIC_ROOT = HERE.parent
REPO_ROOT = FABRIC_ROOT.parents[1]
JOB_FILE = HERE / "jobs" / "klyvaron-chat-lora-experiment.json"

# Keep these equal to the reviewed notebook pins. Torch is intentionally left at an
# already installed version (Kaggle does the same); when absent, pip chooses the wheel
# compatible with this interpreter and operating system.
PINNED_PACKAGES = {
    "transformers": "5.19.0",
    "peft": "0.21.2",
    "accelerate": "1.15.0",
    "huggingface_hub": "2.2.0",
    "safetensors": "0.8.0",
}

if str(FABRIC_ROOT) not in sys.path:
    sys.path.insert(0, str(FABRIC_ROOT))


def dependency_requirements(version: Callable[[str], str] = metadata.version) -> list[str]:
    """Return only distributions that are absent or differ from a reviewed pin."""
    requirements: list[str] = []
    try:
        version("torch")
    except metadata.PackageNotFoundError:
        requirements.append("torch")
    for name, wanted in PINNED_PACKAGES.items():
        try:
            installed = version(name)
        except metadata.PackageNotFoundError:
            installed = None
        if installed != wanted:
            requirements.append(f"{name}=={wanted}")
    return requirements


def pip_command(requirements: Sequence[str]) -> list[str]:
    """Build the install command without assuming that ``pip`` is on PATH."""
    command = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input"]
    # A system interpreter should not need root just to run this repository. Virtual
    # environments disable the user site, so install into the environment there.
    if sys.prefix == sys.base_prefix:
        command.append("--user")
    command.extend(requirements)
    return command


def _externally_managed(message: str) -> bool:
    lowered = message.lower()
    return ("externally-managed-environment" in lowered
            or "externally managed" in lowered
            or ("pep 668" in lowered and "break-system-packages" in lowered))


def _pip_result(command: Sequence[str], runner: Callable[..., subprocess.CompletedProcess]):
    # Keep normal download progress visible on stdout, but retain stderr long enough to
    # recognise PEP 668. pip writes the externally-managed diagnosis to stderr.
    result = runner(list(command), text=True, stderr=subprocess.PIPE)
    message = result.stderr or ""
    if message:
        print(message, file=sys.stderr, end="" if message.endswith("\n") else "\n")
    return result, message


def install_requirements(requirements: Sequence[str], *,
                         runner: Callable[..., subprocess.CompletedProcess] = subprocess.run) -> None:
    """Install requirements, retrying only pip's explicit PEP 668 refusal.

    Debian/Ubuntu system Python installations (including a stock Codespace) can be marked
    externally managed even for a ``--user`` install. First honour that protection. If pip
    itself refuses and names PEP 668, retry the identical user-site install with the escape
    hatch it requested. Network, resolver and disk failures are never disguised by a retry.
    """
    command = pip_command(requirements)
    print("Installing smoke-run dependencies:", " ".join(requirements), flush=True)
    result, message = _pip_result(command, runner)
    if result.returncode and _externally_managed(message):
        retry = list(command)
        retry.insert(retry.index("install") + 1, "--break-system-packages")
        print("pip reports an externally managed Python; retrying the same user-site install "
              "with --break-system-packages.", flush=True)
        result, message = _pip_result(retry, runner)
    if result.returncode:
        tail = message.strip()[-1200:]
        detail = f": {tail}" if tail else ""
        raise RuntimeError(f"pip install failed with exit {result.returncode}{detail}")


def ensure_dependencies() -> None:
    requirements = dependency_requirements()
    if not requirements:
        print("Smoke-run dependencies already satisfy the reviewed pins.", flush=True)
        return
    install_requirements(requirements)
    importlib.invalidate_caches()
    remaining = dependency_requirements()
    if remaining:
        raise RuntimeError("pip returned success but these requirements are still unavailable: "
                           + ", ".join(remaining))


def local_job(template: dict, workdir: Path, *, cuda: bool) -> dict:
    """Move the committed job onto durable local paths without changing training inputs."""
    job = copy.deepcopy(template)
    job["resources"]["accelerator"] = "gpu" if cuda else "cpu"
    if not cuda:
        job["resources"].pop("minGpuMemoryGb", None)
    job["resources"]["note"] = (
        "Selected by remote/run_smoke_local.py from torch.cuda.is_available(). Runtime and peak memory "
        "must be read from this run; the committed notebook estimates do not apply."
    )
    job["checkpoint"].update(
        storageKind="local_disk",
        path=str(workdir / "checkpoints"),
        resumeFrom=[],
    )
    job["logs"].update(storageKind="local_disk", path=str(workdir / "logs"))
    job["resume"]["instructions"] = (
        "Run services/fabric/remote/run_smoke_local.py again with the same --workdir. "
        "The newest checksum-valid checkpoint for this exact training configuration is resumed."
    )
    return job


def repository_commit() -> str:
    """Return the exact checkout when available, without making a source archive unusable."""
    result = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else "unknown (not a Git checkout)"


def run(workdir: Path, *, persistence_adapter: Path | None = None) -> int:
    if sys.version_info < (3, 11):
        raise RuntimeError(f"Python 3.11 or newer is required; found {sys.version.split()[0]}")

    workdir = workdir.expanduser().resolve()
    workdir.mkdir(parents=True, exist_ok=True)
    ensure_dependencies()

    # Imports are deliberately after bootstrap: a stock Codespace need not have any
    # machine-learning packages before this one command is run.
    import torch

    from fabric.training.hf_peft import HFPeftBackend
    from fabric.training.jobspec import validate_job
    from fabric.training.smoke import STAGES, run_smoke

    cuda = bool(torch.cuda.is_available())
    template = json.loads(JOB_FILE.read_text(encoding="utf-8"))
    job = local_job(template, workdir, cuda=cuda)
    problems = validate_job(job)
    if problems:
        raise RuntimeError("the local job is invalid: " + "; ".join(problems))

    device = torch.cuda.get_device_name(0) if cuda else "CPU"
    print(f"device: {device}", flush=True)
    print(f"work directory: {workdir}", flush=True)
    print("The stage ledger is written after every exit path; final file:",
          workdir / "status.json", flush=True)

    ledger = run_smoke(
        job,
        HFPeftBackend(work_dir=workdir),
        out_dir=workdir,
        platform="local",
        persistence_adapter=persistence_adapter.expanduser().resolve() if persistence_adapter else None,
        context={
            "repoCommit": repository_commit(),
            "jobFile": str(JOB_FILE.relative_to(REPO_ROOT)),
            "runner": str(Path(__file__).resolve().relative_to(REPO_ROOT)),
            "device": device,
        },
    )

    print("VERDICT:", ledger.verdict)
    for name in STAGES:
        print(f"  {name:<20} {ledger.stages[name]['status']}")
    for note in ledger.notes:
        print("note:", note)
    print("status file:", workdir / "status.json")
    return 0 if ledger.verdict == "PASSED" else 1


def parser() -> argparse.ArgumentParser:
    out = argparse.ArgumentParser(description=__doc__)
    out.add_argument(
        "--workdir",
        type=Path,
        required=True,
        help="durable directory for downloads, checkpoints, the adapter and status.json",
    )
    out.add_argument(
        "--persistence-adapter",
        type=Path,
        help="adapter directory from an earlier run to read back for the persistence stage",
    )
    return out


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    return run(args.workdir, persistence_adapter=args.persistence_adapter)


if __name__ == "__main__":
    raise SystemExit(main())
