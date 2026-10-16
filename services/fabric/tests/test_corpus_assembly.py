"""The corpus assembler's own-text copy, and the provenance it records.

There were no tests here at all, and the gap had a cost worth naming: `copy_own_text()` reads
this repository's own files **off disk**, while the sources record it wrote named only
`git rev-parse HEAD`. On a dirty working tree those disagree -- the bytes are the tree's, the
record says the commit's -- and the corpus the second artifact was trained on was assembled
from a tree with 45 uncommitted paths in it. So the record now says `-dirty` when that is the
case, and carries a digest over the files actually copied.

Every test here builds its own git repository in a temporary directory. None of them reads
this repository's working tree, because a test whose result depends on what is currently
uncommitted is a test that will pass for the wrong reason.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from assemble_corpus import copy_own_text, git_state  # noqa: E402


def git(root: Path, *args: str) -> str:
    """Run git in `root` with an identity, so the tests do not depend on global config."""
    result = subprocess.run(
        ["git", "-c", "user.email=tests@example.invalid", "-c", "user.name=corpus test", *args],
        cwd=root, capture_output=True, text=True, check=True,
    )
    return result.stdout.strip()


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    """A git repository with one commit and one clean tracked file per extension."""
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "--quiet")
    (root / "code.py").write_text("value = 1\n", encoding="utf-8")
    (root / "notes.md").write_text("# Notes\n", encoding="utf-8")
    git(root, "add", ".")
    git(root, "commit", "--quiet", "-m", "the corpus as committed")
    return root


# ---------------------------------------------------------------------------
# The revision, and whether it describes what is on disk
# ---------------------------------------------------------------------------


def test_a_clean_tree_reports_its_commit_without_a_suffix(repo: Path):
    state = git_state(repo)
    assert state == {"commit": git(repo, "rev-parse", "HEAD"), "clean": True}


def test_an_edited_file_makes_the_revision_dirty(repo: Path):
    (repo / "code.py").write_text("value = 2\n", encoding="utf-8")
    state = git_state(repo)
    assert state["clean"] is False
    assert state["commit"].endswith("-dirty")
    # The commit is still named, because a reader needs to know *what* it was dirty against.
    assert state["commit"].removesuffix("-dirty") == git(repo, "rev-parse", "HEAD")


def test_an_untracked_file_makes_the_revision_dirty(repo: Path):
    """An untracked file is copied -- it is on disk -- so a clean verdict would be wrong.

    `git status --porcelain` alone reports untracked files, but `--untracked-files=all` is what
    makes that true of files inside untracked *directories* too, which is how a new module
    usually arrives.
    """
    (repo / "new_module.md").write_text("# New\n", encoding="utf-8")
    assert git_state(repo)["clean"] is False
    nested = repo / "services" / "core"
    nested.mkdir(parents=True)
    (nested / "fresh.md").write_text("# Fresh\n", encoding="utf-8")
    assert git_state(repo)["clean"] is False


def test_a_directory_that_is_not_a_git_tree_is_reported_as_unknown(tmp_path: Path):
    """Absence of evidence is reported as absence, not as cleanliness.

    A corpus assembled from a tarball or a copy has no revision to name. `None` says that;
    an empty string or an assumed clean verdict would be a provenance claim with nothing
    behind it.
    """
    existing = tmp_path / "not-a-repo"
    existing.mkdir()
    assert git_state(existing) == {"commit": None, "clean": None}
    # A path that does not exist at all is the same answer rather than an exception: the
    # record is written by a script that may be pointed at a corpus root that is not there.
    assert git_state(tmp_path / "missing") == {"commit": None, "clean": None}


def test_the_assembler_and_the_trainer_agree_on_what_a_dirty_revision_is(repo: Path):
    """Two definitions of the same string drift apart, so they are compared here.

    `train.code_revision()` writes the code revision onto every report; this module writes the
    revision of the corpus's first-party source. A card that quotes one and a corpus that
    records the other must not disagree about whether the tree was dirty.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from fabric.lm.train import code_revision

    assert git_state(repo)["commit"] == code_revision(repo)
    (repo / "code.py").write_text("value = 3\n", encoding="utf-8")
    assert git_state(repo)["commit"] == code_revision(repo)
    assert code_revision(repo).endswith("-dirty")


# ---------------------------------------------------------------------------
# The copy
# ---------------------------------------------------------------------------


def test_the_copy_records_the_dirty_revision_and_the_files_it_read(repo: Path, tmp_path: Path):
    (repo / "code.py").write_text("value = 4\n", encoding="utf-8")
    out = tmp_path / "corpus"
    entry = copy_own_text(out, root=repo)

    assert entry["files"] == 2, "both extensions are read"
    assert entry["bytes"] == len("value = 4\n") + len("# Notes\n")
    assert entry["clean"] is False
    assert entry["commit"].endswith("-dirty")
    assert (out / "rajaram-2005__ragam" / "code.py").read_text(encoding="utf-8") == "value = 4\n"


def test_the_tree_digest_covers_paths_and_contents(repo: Path, tmp_path: Path):
    """The digest is what makes the copy checkable when the commit cannot reproduce it."""
    import hashlib

    out = tmp_path / "corpus"
    entry = copy_own_text(out, root=repo)
    expected = hashlib.sha256()
    for name, content in sorted([("code.py", "value = 1\n"), ("notes.md", "# Notes\n")]):
        expected.update(
            name.encode("utf-8") + b"\0" + hashlib.sha256(content.encode("utf-8")).hexdigest().encode("ascii") + b"\n"
        )
    assert entry["treeDigest"] == expected.hexdigest()

    # Same content, different directory: the digest is over the copy, not over where it sat.
    other = tmp_path / "elsewhere" / "repo"
    other.parent.mkdir()
    subprocess.run(["git", "clone", "--quiet", str(repo), str(other)], check=True)
    second = copy_own_text(tmp_path / "corpus2", root=other)
    assert second["treeDigest"] == entry["treeDigest"]

    # And a change of content moves it -- otherwise it would not be covering contents.
    (repo / "code.py").write_text("value = 5\n", encoding="utf-8")
    changed = copy_own_text(tmp_path / "corpus3", root=repo)
    assert changed["treeDigest"] != entry["treeDigest"]


def test_the_cap_is_recorded_when_it_binds(repo: Path, tmp_path: Path):
    """A truncated source that does not say it was truncated reads as a complete one."""
    entry = copy_own_text(tmp_path / "corpus", cap_bytes=4, root=repo)
    assert entry["files"] == 1, "the cap stops the walk"
    assert entry["capped"] is True
    assert entry["bytes"] >= 4

    full = copy_own_text(tmp_path / "corpus_full", root=repo)
    assert full["capped"] is False


def test_the_excluded_directories_and_extensions_are_the_trainers(tmp_path: Path):
    """The copy's rule must be the manifest's rule, or the corpus contains what it cannot read.

    `artifacts/` is excluded by both: a training run must never see a previous run's output,
    and it lives inside this repository when a run is launched from it.
    """
    root = tmp_path / "repo"
    (root / "artifacts").mkdir(parents=True)
    (root / "artifacts" / "previous.md").write_text("# A previous run\n", encoding="utf-8")
    (root / "kept.md").write_text("# Kept\n", encoding="utf-8")
    (root / "ignored.bin").write_bytes(b"\x00\x01")
    out = tmp_path / "corpus"
    entry = copy_own_text(out, root=root)

    assert entry["files"] == 1
    assert (out / "rajaram-2005__ragam" / "kept.md").exists()
    assert not (out / "rajaram-2005__ragam" / "artifacts").exists()
    assert not (out / "rajaram-2005__ragam" / "ignored.bin").exists()
