"""Licence, provenance and storage rules for remote training jobs.

These are this repository's conservative defaults, written so that a job which
breaks one of them is refused before any compute is spent. They are not legal
advice. Whoever runs a job is responsible for reading the licence of the base
model and of the dataset at the pinned revision, and for recording that they did
(see ``licenceCheckedBy`` in the job contract).

Three questions are answered here and nowhere else:

* May this licence be used for training and for a shipped product?
* May this data leave the machine, and under whose authority?
* Where may checkpoints go, and does that location survive the session?
"""

from __future__ import annotations

import posixpath

#: Licences accepted for a base model or a dataset. Anything else is refused,
#: including non-commercial and share-alike terms, which would restrict a shipped
#: product, and "unknown", which cannot be checked at all.
LICENCES_ALLOWED = frozenset(
    {
        "Apache-2.0",
        "MIT",
        "BSD-2-Clause",
        "BSD-3-Clause",
        "CC0-1.0",
        "CC-BY-4.0",
    }
)

#: Data the user created or owns. Sending it to a third-party GPU service needs no
#: separate upload authorization beyond the job record itself.
PROVENANCE_OWNED = frozenset({"generated_locally", "public_domain", "owner_authored"})

#: Data that is someone else's, or derived from conversations. Sending it to a
#: third-party service needs a named authorization, and experience data also needs
#: consent and both reviews.
PROVENANCE_NEEDS_AUTHORIZATION = frozenset({"licensed", "consented_experience"})

PROVENANCE_ALLOWED = PROVENANCE_OWNED | PROVENANCE_NEEDS_AUTHORIZATION

#: Where checkpoints and logs may be written.
#:
#: * ``google_drive``, ``object_store``, ``local_disk``: persist beyond the session.
#: * ``kaggle_output``: ``/kaggle/working`` is kept as the output of a *committed*
#:   notebook version (Save Version, Save & Run All). An interactive session that
#:   is not committed can lose it. Persistence is only claimed once a later run
#:   reads the files back through ``/kaggle/input``.
#: * ``colab_session``: the Colab runtime disk. Lost when the runtime ends. Allowed
#:   only with an explicit acknowledgement in the job, recorded in the run.
STORAGE_KINDS = frozenset({"google_drive", "object_store", "local_disk", "kaggle_output", "colab_session"})

#: Storage kinds whose files survive the notebook session at all.
PERSISTENT_KINDS = frozenset({"google_drive", "object_store", "local_disk", "kaggle_output"})

EPHEMERAL_KINDS = frozenset({"colab_session"})

KAGGLE_OUTPUT_PREFIX = "/kaggle/working/"
KAGGLE_INPUT_PREFIX = "/kaggle/input/"
KAGGLE_TEMP_PREFIX = "/kaggle/temp/"
COLAB_SESSION_PREFIX = "/content/"
DRIVE_PREFIX = "/content/drive/"

_OBJECT_STORE_PREFIXES = ("s3://", "gs://", "az://")


def licence_problems(licence: object, where: str) -> list[str]:
    if not isinstance(licence, str) or not licence.strip():
        return [f"{where}: licence is missing"]
    if licence not in LICENCES_ALLOWED:
        return [f"{where}: licence {licence!r} is not on the allowlist {sorted(LICENCES_ALLOWED)}"]
    return []


def _normal(path: str) -> str:
    """Normalise a filesystem path so ``..`` cannot hide a notebook path. URIs are left alone:
    normalising ``s3://bucket`` would collapse its double slash and break the check."""
    raw = path.replace("\\", "/").strip()
    if "://" in raw:
        return raw
    return posixpath.normpath(raw)


def storage_problems(kind: object, path: object, where: str) -> list[str]:
    """Refuse a storage location unless its kind matches where the path really is."""
    if kind not in STORAGE_KINDS:
        return [f"{where}: storage kind {kind!r} is not allowed (allowed: {sorted(STORAGE_KINDS)})"]
    if not isinstance(path, str) or not path.strip():
        return [f"{where}: path is missing"]
    normal = _normal(path)
    problems: list[str] = []

    # A path on Drive is only ever stored as Drive, and Drive is only used for Drive paths.
    if normal.startswith(DRIVE_PREFIX):
        if kind != "google_drive":
            problems.append(f"{where}: path is on Google Drive but storage kind is {kind!r}")
        return problems
    if kind == "google_drive":
        return [f"{where}: a google_drive path must begin with {DRIVE_PREFIX!r}"]

    if kind == "kaggle_output":
        if not normal.startswith(KAGGLE_OUTPUT_PREFIX) or normal == KAGGLE_OUTPUT_PREFIX.rstrip("/"):
            problems.append(f"{where}: a kaggle_output path must be inside {KAGGLE_OUTPUT_PREFIX!r}")
        return problems
    if normal.startswith(("/kaggle/working", KAGGLE_INPUT_PREFIX.rstrip("/"), KAGGLE_TEMP_PREFIX.rstrip("/"))):
        problems.append(f"{where}: {normal!r} is a Kaggle notebook path; use storage kind kaggle_output "
                        "(/kaggle/input is read-only, /kaggle/temp is not kept)")
        return problems

    if kind == "colab_session":
        if not normal.startswith(COLAB_SESSION_PREFIX):
            problems.append(f"{where}: a colab_session path must be inside {COLAB_SESSION_PREFIX!r}")
        return problems
    if normal.startswith(COLAB_SESSION_PREFIX):
        problems.append(f"{where}: {normal!r} is the Colab session disk; use storage kind colab_session "
                        "(acknowledged as ephemeral) or google_drive")
        return problems

    if kind == "object_store":
        if not normal.startswith(_OBJECT_STORE_PREFIXES) or len(normal.split("/", 3)) < 4:
            problems.append(f"{where}: an object_store path must be a bucket URI such as s3://bucket/prefix")
    elif normal.startswith(_OBJECT_STORE_PREFIXES):
        problems.append(f"{where}: an object-store URI needs storage kind object_store")
    return problems


def ephemeral_problems(section: dict, where: str) -> list[str]:
    """A session-only location must be acknowledged, so nobody mistakes it for persistent."""
    if section.get("storageKind") in EPHEMERAL_KINDS and section.get("ephemeralAcknowledged") is not True:
        return [f"{where}.ephemeralAcknowledged: {section.get('storageKind')} is lost when the runtime ends; "
                "set it to true to accept that"]
    return []


def resume_source_problems(paths: object, where: str) -> list[str]:
    """Resume sources are read-only attached outputs, never a place to write."""
    if not isinstance(paths, list):
        return [f"{where}: must be a list of paths"]
    problems = []
    for index, raw in enumerate(paths):
        if not isinstance(raw, str) or not raw.strip():
            problems.append(f"{where}[{index}]: must be a non-empty path")
            continue
        normal = _normal(raw)
        if not normal.startswith(KAGGLE_INPUT_PREFIX):
            problems.append(f"{where}[{index}]: {normal!r} must be inside {KAGGLE_INPUT_PREFIX!r} "
                            "(an attached output of an earlier committed run)")
    return problems


def authorization_problems(section: dict, where: str) -> list[str]:
    auth = section.get("authorization") if isinstance(section, dict) else None
    if not isinstance(auth, dict):
        return [f"{where}: a named authorization is required to send this data to a third-party service"]
    problems = []
    if not str(auth.get("authorizedBy", "")).strip():
        problems.append(f"{where}.authorization.authorizedBy names nobody")
    if not str(auth.get("reason", "")).strip():
        problems.append(f"{where}.authorization.reason is empty")
    return problems
