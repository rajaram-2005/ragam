"""Licence, provenance and storage rules for remote training jobs.

These are this repository's conservative defaults, written so that a job which
breaks one of them is refused before any compute is spent. They are not legal
advice. Whoever runs a job is responsible for reading the licence of the base
model and of the dataset at the pinned revision, and for recording that they did
(see ``licenceCheckedBy`` in the job contract).

Three questions are answered here and nowhere else:

* May this licence be used for training and for a shipped product?
* May this data leave the machine, and under whose authority?
* Is this storage location one that survives the session?
"""

from __future__ import annotations

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

#: Where checkpoints and logs may be written. Each one survives the notebook session.
STORAGE_KINDS = frozenset({"google_drive", "object_store", "local_disk"})

#: Paths that belong to a notebook session and are discarded when it ends. A
#: checkpoint written here is a checkpoint that is lost.
NOTEBOOK_TEMPORARY_PREFIXES = ("/kaggle/working", "/kaggle/temp", "/kaggle/input", "/content/")

DRIVE_PREFIX = "/content/drive/"

_OBJECT_STORE_PREFIXES = ("s3://", "gs://", "az://")


def licence_problems(licence: object, where: str) -> list[str]:
    if not isinstance(licence, str) or not licence.strip():
        return [f"{where}: licence is missing"]
    if licence not in LICENCES_ALLOWED:
        return [f"{where}: licence {licence!r} is not on the allowlist {sorted(LICENCES_ALLOWED)}"]
    return []


def storage_problems(kind: object, path: object, where: str) -> list[str]:
    """Refuse any location that is not both authorized and persistent."""
    if kind not in STORAGE_KINDS:
        return [f"{where}: storage kind {kind!r} is not an authorized persistent store "
                f"(allowed: {sorted(STORAGE_KINDS)})"]
    if not isinstance(path, str) or not path.strip():
        return [f"{where}: path is missing"]
    normal = path.replace("\\", "/").strip()

    if normal.startswith(DRIVE_PREFIX):
        if kind != "google_drive":
            return [f"{where}: path is on Google Drive but storage kind is {kind!r}"]
        return []
    if kind == "google_drive":
        return [f"{where}: a google_drive path must begin with {DRIVE_PREFIX!r}"]

    for prefix in NOTEBOOK_TEMPORARY_PREFIXES:
        if normal == prefix.rstrip("/") or normal.startswith(prefix):
            return [f"{where}: {normal!r} is a notebook session filesystem and is discarded when the "
                    "session ends; use persistent storage"]

    if kind == "object_store":
        if not normal.startswith(_OBJECT_STORE_PREFIXES) or len(normal.split("/", 3)) < 4:
            return [f"{where}: an object_store path must be a bucket URI such as s3://bucket/prefix"]
    return []


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
