"""The one-command CPU/GPU entry point, without downloading a model in CI."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from importlib import metadata
from pathlib import Path

import pytest

from fabric.training.jobspec import validate_job

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "services" / "fabric" / "remote" / "run_smoke_local.py"
JOB = SCRIPT.parent / "jobs" / "klyvaron-chat-lora-experiment.json"


def load_runner():
    spec = importlib.util.spec_from_file_location("run_smoke_local", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def versions(values):
    def get(name):
        if name not in values:
            raise metadata.PackageNotFoundError(name)
        return values[name]
    return get


def reviewed_versions(runner, **changes):
    values = {"torch": "2.14.1", **runner.PINNED_PACKAGES}
    values.update(changes)
    return values


def template():
    return json.loads(JOB.read_text(encoding="utf-8"))


def test_a_stock_python_requests_torch_and_every_reviewed_pin():
    runner = load_runner()
    missing = runner.dependency_requirements(versions({}))
    assert missing == ["torch", *[f"{name}=={version}" for name, version in runner.PINNED_PACKAGES.items()]]


def test_an_existing_torch_is_kept_while_a_wrong_hugging_face_version_is_replaced():
    runner = load_runner()
    values = reviewed_versions(runner, transformers="0.0.1")
    assert runner.dependency_requirements(versions(values)) == ["transformers==5.19.0"]


def test_reviewed_dependencies_do_not_invoke_pip(monkeypatch):
    runner = load_runner()
    monkeypatch.setattr(runner, "dependency_requirements", lambda: [])
    monkeypatch.setattr(runner, "install_requirements",
                        lambda requirements: pytest.fail(f"unexpected install: {requirements}"))
    runner.ensure_dependencies()


def test_pip_runs_through_the_current_interpreter_and_not_a_path_command():
    runner = load_runner()
    command = runner.pip_command(["torch", "peft==0.21.2"])
    assert command[:4] == [sys.executable, "-m", "pip", "install"]
    assert command[-2:] == ["torch", "peft==0.21.2"]
    assert "--no-input" in command


def test_a_pip_failure_is_not_reported_as_an_installed_environment():
    runner = load_runner()
    calls = []

    def failed(command, **kwargs):
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(command, 2)

    with pytest.raises(RuntimeError, match="pip install failed with exit 2"):
        runner.install_requirements(["torch"], runner=failed)
    assert len(calls) == 1


def test_an_externally_managed_interpreter_retries_with_pips_requested_escape_hatch():
    runner = load_runner()
    calls = []

    def pep668(command, **kwargs):
        calls.append((command, kwargs))
        if len(calls) == 1:
            return subprocess.CompletedProcess(
                command,
                1,
                stderr="error: externally-managed-environment\nhint: pass --break-system-packages\n",
            )
        return subprocess.CompletedProcess(command, 0, stderr="")

    runner.install_requirements(["torch"], runner=pep668)
    assert len(calls) == 2
    assert "--break-system-packages" not in calls[0][0]
    assert calls[1][0][calls[1][0].index("install") + 1] == "--break-system-packages"
    assert calls[1][0][-1] == "torch"


def test_a_network_failure_is_not_retried_as_permission_to_change_python():
    runner = load_runner()
    calls = []

    def offline(command, **kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 1, stderr="No matching distribution found\n")

    with pytest.raises(RuntimeError, match="No matching distribution found"):
        runner.install_requirements(["torch"], runner=offline)
    assert len(calls) == 1
    assert "--break-system-packages" not in calls[0]


def test_the_cpu_job_uses_only_paths_below_the_requested_workdir(tmp_path):
    runner = load_runner()
    work = (tmp_path / "smoke").resolve()
    job = runner.local_job(template(), work, cuda=False)
    assert job["resources"]["accelerator"] == "cpu"
    assert "minGpuMemoryGb" not in job["resources"]
    assert job["checkpoint"]["storageKind"] == "local_disk"
    assert job["checkpoint"]["path"] == str(work / "checkpoints")
    assert job["checkpoint"]["resumeFrom"] == []
    assert job["logs"] == {"storageKind": "local_disk", "path": str(work / "logs")}
    assert validate_job(job) == []


def test_the_gpu_job_keeps_the_committed_minimum_memory_gate(tmp_path):
    runner = load_runner()
    job = runner.local_job(template(), tmp_path.resolve(), cuda=True)
    assert job["resources"]["accelerator"] == "gpu"
    assert job["resources"]["minGpuMemoryGb"] == 8
    assert validate_job(job) == []


def test_localising_a_job_does_not_change_its_training_inputs_or_thresholds(tmp_path):
    runner = load_runner()
    original = template()
    job = runner.local_job(original, tmp_path.resolve(), cuda=False)
    for section in ("base", "dataset", "training", "validation", "output"):
        assert job[section] == original[section]


def test_the_cli_requires_an_explicit_work_directory():
    runner = load_runner()
    with pytest.raises(SystemExit):
        runner.parser().parse_args([])
    args = runner.parser().parse_args(["--workdir", "aetheris-smoke"])
    assert args.workdir == Path("aetheris-smoke")
    assert args.persistence_adapter is None


def test_the_local_status_explains_how_persistence_can_be_verified():
    from fabric.training.smoke import Ledger

    payload = Ledger(platform="local").to_dict()
    assert payload["persistence"]["verified"] is False
    assert "--persistence-adapter" in payload["persistence"]["statement"]
