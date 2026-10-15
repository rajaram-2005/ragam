"""Checkpoints that survive a dead session, and refuse to resume into the wrong run.

Layout, one directory per saved step under the job's persistent root::

    step-00000100/
        manifest.json     format, step, config digest, per-file SHA-256, metadata
        trainer.npz       whatever the trainer serialised (the framework decides)

Three properties matter, and each has a test:

* **Atomic.** A checkpoint is written into a temporary directory and renamed into
  place. A crash mid-write leaves nothing that looks like a checkpoint.
* **Verified.** Every file is re-hashed on load. A truncated or altered file is
  skipped, and the next older checkpoint is used instead, with the reason recorded.
* **Bound to one run.** Every manifest carries the config digest. A checkpoint
  written under a different learning rate, base revision or dataset is a different
  run, and resuming it would silently produce a model no one configured. The store
  refuses instead.

The store knows nothing about frameworks. It takes bytes, so the same code serves
the NumPy fixture and a PEFT adapter saved with ``torch.save`` into a buffer.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import uuid
from dataclasses import dataclass, field
from pathlib import Path

FORMAT = "aetheris-checkpoint/1"
MANIFEST = "manifest.json"
_STEP_DIR = re.compile(r"^step-(\d{8})$")


class CheckpointError(RuntimeError):
    """A checkpoint could not be written."""


class ResumeMismatch(RuntimeError):
    """The directory holds checkpoints from a different configuration."""


@dataclass(frozen=True)
class Checkpoint:
    step: int
    files: dict
    meta: dict
    config_digest: str
    path: Path
    #: Newer checkpoints that were rejected on the way to this one, and why.
    skipped: tuple = field(default_factory=tuple)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _check_name(name: str) -> None:
    if not name or name in (".", "..") or "/" in name or "\\" in name or name == MANIFEST:
        raise CheckpointError(f"illegal checkpoint file name {name!r}")


class CheckpointStore:
    def __init__(self, root: str | Path):
        self.root = Path(root)

    # --- writing ---------------------------------------------------------

    def save(self, step: int, files: dict, *, config_digest: str, meta: dict | None = None) -> Path:
        if not isinstance(step, int) or step < 0:
            raise CheckpointError(f"step must be a non-negative integer, found {step!r}")
        for name, data in files.items():
            _check_name(name)
            if not isinstance(data, (bytes, bytearray)):
                raise CheckpointError(f"file {name!r} must be bytes")

        final = self._directory(step)
        self.root.mkdir(parents=True, exist_ok=True)
        if final.exists():
            manifest, problem = self._read_manifest(final)
            existing = None if manifest is None else self._read_files(final, manifest)[0]
            if existing is not None:
                # A verified checkpoint is never overwritten, whoever asks.
                raise CheckpointError(f"a verified checkpoint for step {step} already exists at {final}")
            # Only a directory that fails verification is moved aside, never deleted, so
            # the evidence of the corruption is kept.
            final.rename(self.root / f"quarantine-step-{step:08d}-{uuid.uuid4().hex[:8]}")
        staging = self.root / f".staging-{step:08d}-{uuid.uuid4().hex}"
        try:
            staging.mkdir()
            entries = {}
            for name, data in files.items():
                (staging / name).write_bytes(bytes(data))
                entries[name] = {"sha256": _sha256(bytes(data)), "bytes": len(data)}
            manifest = {
                "format": FORMAT,
                "step": step,
                "configDigest": config_digest,
                "files": entries,
                "meta": meta or {},
            }
            # json.dumps is here, before the rename, so unserialisable metadata fails
            # while the staging directory is still disposable.
            (staging / MANIFEST).write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
            os.replace(staging, final)  # the commit point
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        return final

    # --- reading ---------------------------------------------------------

    def _directory(self, step: int) -> Path:
        return self.root / f"step-{step:08d}"

    def steps(self) -> list[int]:
        if not self.root.exists():
            return []
        found = []
        for entry in self.root.iterdir():
            match = _STEP_DIR.match(entry.name)
            if match and entry.is_dir():
                found.append(int(match.group(1)))
        return sorted(found)

    def _read_manifest(self, directory: Path) -> tuple[dict | None, str | None]:
        path = directory / MANIFEST
        if not path.exists():
            return None, "no manifest (the save did not complete)"
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            return None, f"manifest unreadable: {error}"
        if manifest.get("format") != FORMAT:
            return None, f"unsupported format {manifest.get('format')!r}"
        return manifest, None

    def _read_files(self, directory: Path, manifest: dict) -> tuple[dict | None, str | None]:
        files = {}
        for name, expected in manifest.get("files", {}).items():
            path = directory / name
            if not path.exists():
                return None, f"file {name!r} is missing"
            data = path.read_bytes()
            if len(data) != expected.get("bytes") or _sha256(data) != expected.get("sha256"):
                return None, f"file {name!r} fails its checksum"
            files[name] = data
        return files, None

    def load_latest(self, config_digest: str) -> Checkpoint | None:
        """The newest verified checkpoint for this config, or None to start fresh.

        Raises ``ResumeMismatch`` if *any* checkpoint in the directory belongs to a
        different config. Mixing runs in one directory is refused, not sorted out.
        """
        manifests = {}
        for step in self.steps():
            manifest, problem = self._read_manifest(self._directory(step))
            if manifest is not None:
                manifests[step] = manifest
                if manifest.get("configDigest") != config_digest:
                    raise ResumeMismatch(
                        f"checkpoint step {step} was written under a different configuration "
                        f"({str(manifest.get('configDigest'))[:12]}; this run is {config_digest[:12]}); "
                        "use a separate checkpoint directory for a changed configuration"
                    )

        skipped: list[str] = []
        for step in reversed(self.steps()):
            directory = self._directory(step)
            if step not in manifests:
                skipped.append(f"step {step}: {self._read_manifest(directory)[1]}")
                continue
            files, problem = self._read_files(directory, manifests[step])
            if problem:
                skipped.append(f"step {step}: {problem}")
                continue
            manifest = manifests[step]
            return Checkpoint(
                step=manifest["step"],
                files=files,
                meta=manifest.get("meta", {}),
                config_digest=config_digest,
                path=directory,
                skipped=tuple(skipped),
            )
        return None

    def prune(self, keep_last: int) -> list[int]:
        """Delete all but the newest ``keep_last`` checkpoints. Returns deleted steps."""
        if keep_last < 1:
            raise CheckpointError("keep_last must be at least 1; zero would delete every resume point")
        steps = self.steps()
        doomed = steps[:-keep_last] if len(steps) > keep_last else []
        for step in doomed:
            shutil.rmtree(self._directory(step), ignore_errors=True)
        return doomed
