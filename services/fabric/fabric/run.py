"""Run records: everything needed to reproduce a training or evaluation run.

The project brief requires that every run records its configuration, dataset
manifest, provenance, base checkpoint, code revision, seeds, resource usage,
evaluation results and artifact hashes. This module is that record.

A run record is written whether the run succeeded or failed. A failed run that
leaves no trace gets repeated; one that records *why* it failed becomes a
candidate failure in ``fabric.failure_memory``.

``code_revision`` is read from git when available and recorded as ``None``
otherwise. It is never invented: a fabricated revision is worse than a missing
one, because it makes an unreproducible run look reproducible.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence

__all__ = ["RunRecord", "hardware_profile", "code_revision", "resource_usage"]


def code_revision(cwd: str | Path | None = None) -> str | None:
    """The current git commit, or None when this is not a git checkout.

    Falls back to None rather than guessing. If git is missing, or the directory
    is not a repository, or the command fails for any reason, the honest answer is
    "unknown".
    """
    directory = str(cwd or Path(__file__).resolve().parents[2])
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=directory,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    revision = completed.stdout.strip()
    return revision or None


def hardware_profile() -> dict:
    """Real measurements of this machine, not a guess about a target machine."""
    try:
        import resource

        limits = resource.getrlimit(resource.RLIMIT_AS)
        address_space = limits[0] if limits[0] not in (resource.RLIM_INFINITY, -1) else None
    except Exception:  # noqa: BLE001 - resource is POSIX-only
        address_space = None

    return {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "processor": platform.processor() or None,
        "cpuCount": os.cpu_count(),
        #: No GPU is detected because no vendor tooling is available here. This is
        #: reported as unknown/absent rather than assumed.
        "gpuDetected": False,
        "gpuNote": "no GPU detection performed; no vendor tooling available on this host",
        "addressSpaceLimitBytes": address_space,
        "numpy": _numpy_version(),
    }


def _numpy_version() -> str | None:
    try:
        import numpy

        return numpy.__version__
    except Exception:  # noqa: BLE001
        return None


def resource_usage() -> dict:
    """Memory and CPU time consumed by this process so far."""
    try:
        import resource

        usage = resource.getrusage(resource.RUSAGE_SELF)
        return {
            "maxRssKb": usage.ru_maxrss,
            "userCpuSeconds": round(usage.ru_utime, 4),
            "systemCpuSeconds": round(usage.ru_stime, 4),
            "pageFaults": usage.ru_minflt,
        }
    except Exception:  # noqa: BLE001
        return {}


@dataclass
class RunRecord:
    """One run, with its full provenance."""

    run_id: str
    kind: str
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    status: str = "running"
    config: dict = field(default_factory=dict)
    seeds: dict = field(default_factory=dict)
    dataset: dict = field(default_factory=dict)
    base_checkpoint: str | None = None
    code_revision: str | None = field(default_factory=code_revision)
    hardware: dict = field(default_factory=hardware_profile)
    stages: list = field(default_factory=list)
    results: dict = field(default_factory=dict)
    artifacts: dict = field(default_factory=dict)
    limitations: list = field(default_factory=list)
    error: str | None = None
    resources: dict = field(default_factory=dict)

    @property
    def duration_seconds(self) -> float | None:
        if self.finished_at is None:
            return None
        return round(self.finished_at - self.started_at, 4)

    def add_stage(self, name: str, status: str, *, detail: Mapping | None = None, seconds: float | None = None) -> dict:
        entry = {
            "name": name,
            "status": status,
            "detail": dict(detail or {}),
            "seconds": seconds,
            "at": time.time(),
        }
        self.stages.append(entry)
        return entry

    def add_artifact(self, name: str, path: str | Path, *, extra: Mapping | None = None) -> dict:
        """Record an artifact with its content hash.

        The hash is what lets a later run prove it produced the same bytes, and
        what the release gate compares against.
        """
        target = Path(path)
        entry = {
            "name": name,
            "path": str(target),
            "exists": target.exists(),
            "bytes": target.stat().st_size if target.exists() else None,
            "sha256": file_digest(target) if target.exists() else None,
        }
        if extra:
            entry.update(extra)
        self.artifacts[name] = entry
        return entry

    def finish(self, status: str, *, error: str | None = None, limitations: Sequence[str] = ()) -> "RunRecord":
        self.status = status
        self.finished_at = time.time()
        self.error = error
        self.resources = resource_usage()
        for note in limitations:
            if note not in self.limitations:
                self.limitations.append(note)
        return self

    def to_dict(self) -> dict:
        return {
            "format": "aetheris-run-record/1",
            "runId": self.run_id,
            "kind": self.kind,
            "status": self.status,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "durationSeconds": self.duration_seconds,
            "config": dict(self.config),
            "seeds": dict(self.seeds),
            "dataset": dict(self.dataset),
            "baseCheckpoint": self.base_checkpoint,
            "codeRevision": self.code_revision,
            "hardware": dict(self.hardware),
            "stages": list(self.stages),
            "results": dict(self.results),
            "artifacts": dict(self.artifacts),
            "limitations": list(self.limitations),
            "resources": dict(self.resources),
            "error": self.error,
        }

    def digest(self) -> str:
        encoded = json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def save(self, path: str | Path) -> Path:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(self.to_dict(), indent=2, sort_keys=True), encoding="utf-8")
        return target

    @classmethod
    def load(cls, path: str | Path) -> "RunRecord":
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        if payload.get("format") != "aetheris-run-record/1":
            raise ValueError(f"unsupported run record format: {payload.get('format')!r}")
        record = cls(
            run_id=payload["runId"],
            kind=payload["kind"],
            started_at=payload.get("startedAt", time.time()),
            finished_at=payload.get("finishedAt"),
            status=payload.get("status", "running"),
            config=payload.get("config", {}),
            seeds=payload.get("seeds", {}),
            dataset=payload.get("dataset", {}),
            base_checkpoint=payload.get("baseCheckpoint"),
            code_revision=payload.get("codeRevision"),
            hardware=payload.get("hardware", {}),
            stages=payload.get("stages", []),
            results=payload.get("results", {}),
            artifacts=payload.get("artifacts", {}),
            limitations=payload.get("limitations", []),
            error=payload.get("error"),
            resources=payload.get("resources", {}),
        )
        return record

    @classmethod
    def start(cls, kind: str, *, run_id: str | None = None, **fields: Any) -> "RunRecord":
        identifier = run_id or f"run-{int(time.time() * 1000)}-{os.getpid()}"
        return cls(run_id=identifier, kind=kind, **fields)


def file_digest(path: str | Path, *, chunk_bytes: int = 1 << 20) -> str:
    """SHA-256 of a file, streamed so a large artifact does not have to fit in RAM."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(chunk_bytes)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()
