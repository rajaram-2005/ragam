"""Assemble a licence-checked corpus from pinned public sources.

The family's own models train on text this repository has the right to train on, and this script is
where that right is *checked* rather than asserted. For each source it:

1. resolves the default branch head to a **commit SHA** and refuses to continue without one -- a
   moving ref is not a base, whether it is a model checkpoint or a corpus;
2. asks GitHub for the repository's **licence at that SHA** and refuses the source unless the SPDX
   id is on the allowlist in `klyvaron/composition.mjs` (and repeats the allowlist here, so a change
   in either place is a deliberate change in both);
3. downloads the tarball **at that SHA**, keeps only text files of the declared extensions, applies a
   per-source byte cap, and writes them under the corpus root preserving their relative paths;
4. records every refusal, the licence, the SHA, per-source bytes and the total, in a JSON record.

Nothing is written for a source that fails step 1 or 2: the point of the order is that an
unlicensed byte never reaches the disk.

Run it, then train:

    python3 services/fabric/scripts/assemble_corpus.py
    python3 services/fabric/scripts/train_lm.py --corpus-root artifacts/corpus \
        --extensions .py,.pyi,.md,.rst,.txt,.ts,.js,.json --run-name klyvaron-base ...
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

#: Mirrors `LICENCES_ALLOWED` in `services/core/src/klyvaron/composition.mjs`. Two copies, on
#: purpose: the core refuses to *compose* a tier from a base under any other licence, and this
#: script refuses to *train* on text under any other licence, and neither should change silently
#: because the other did. `--check-core-allowlist` fails if the two lists ever diverge.
LICENCES_ALLOWED = ("Apache-2.0", "MIT", "BSD-2-Clause", "BSD-3-Clause", "CC0-1.0", "CC-BY-4.0")

#: The sources, each with the licence it is expected to carry. A repository whose licence is not the
#: one named here is refused rather than adapted to: "it looked permissive" is not a licence review.
SOURCES = (
    # --- the first corpus's sources, kept -------------------------------------------------
    {
        "repo": "numpy/numpy",
        "expected": "BSD-3-Clause",
        "extensions": (".py", ".pyi", ".md", ".rst", ".txt"),
        "capBytes": 6_000_000,
        "why": "Numerical Python: BSD-3-Clause, and its prose is dense technical English rather than generated text.",
    },
    {
        "repo": "pallets/flask",
        "expected": "BSD-3-Clause",
        "extensions": (".py", ".md", ".rst", ".txt"),
        "capBytes": 4_000_000,
        "why": "A small, readable application framework: BSD-3-Clause, and small enough to be read in full.",
    },
    {
        "repo": "expressjs/express",
        "expected": "MIT",
        "extensions": (".js", ".mjs", ".md", ".json"),
        "capBytes": 2_000_000,
        "why": "A second language and a second licence shape (MIT), so the corpus is not one project's idiom.",
    },
    {
        "repo": "psf/requests",
        "expected": "Apache-2.0",
        "extensions": (".py", ".md", ".rst", ".txt"),
        "capBytes": 1_500_000,
        "why": "Apache-2.0 is the licence the composed path would have allowed; the corpus allowlist is the same list, so the two paths agree about what may be used.",
    },
    {
        "repo": "microsoft/TypeScript",
        "expected": "Apache-2.0",
        "extensions": (".ts", ".md"),
        "capBytes": 14_000_000,
        "why": "A second language at real scale. The cap was 4 MB while the corpus was 13.65 MB; a subword corpus needs orders of magnitude more text than that, so it is raised rather than kept as a souvenir of the smaller run.",
    },
    {
        "repo": "pytest-dev/pytest",
        "expected": "MIT",
        "extensions": (".py", ".md", ".rst", ".txt"),
        "capBytes": 8_000_000,
        "why": "MIT again, and test code: a different register from library code, which is most of what the other sources contribute.",
    },
    {
        "repo": "pallets/click",
        "expected": "BSD-3-Clause",
        "extensions": (".py", ".md", ".rst", ".txt"),
        "capBytes": 1_500_000,
        "why": "Documentation-heavy Python: mostly prose, which balances source code in the corpus.",
    },

    # --- added for the subword corpus -----------------------------------------------------
    {
        "repo": "kubernetes/kubernetes",
        "expected": "Apache-2.0",
        "extensions": (".go", ".md", ".yaml", ".yml"),
        "capBytes": 25_000_000,
        "why": "The largest Apache-2.0 Go codebase in wide use, and its API reference is configuration documentation rather than prose about a library.",
    },
    {
        "repo": "golang/go",
        "expected": "BSD-3-Clause",
        "extensions": (".go", ".md", ".txt", ".html"),
        "capBytes": 25_000_000,
        "why": "The Go standard library and its documentation: a third licence shape (BSD-3-Clause) at scale, and one of the most widely read bodies of tutorial prose in software.",
    },
    {
        "repo": "django/django",
        "expected": "BSD-3-Clause",
        "extensions": (".py", ".md", ".rst", ".txt"),
        "capBytes": 18_000_000,
        "why": "Django's source and its reference documentation: `.rst` prose written for humans, which is the register a language model needs to learn to produce.",
    },
    {
        "repo": "pandas-dev/pandas",
        "expected": "BSD-3-Clause",
        "extensions": (".py", ".pyx", ".md", ".rst"),
        "capBytes": 18_000_000,
        "why": "A second large BSD-3-Clause project, with Cython as well as Python, so the corpus is not one authoring style.",
    },
    {
        "repo": "scikit-learn/scikit-learn",
        "expected": "BSD-3-Clause",
        "extensions": (".py", ".pyx", ".md", ".rst", ".txt"),
        "capBytes": 15_000_000,
        "why": "Documentation-heavy numeric Python; its user guide is long-form explanation rather than API listing.",
    },
    {
        "repo": "microsoft/vscode",
        "expected": "MIT",
        "extensions": (".ts", ".js", ".mjs", ".md", ".json", ".css"),
        "capBytes": 20_000_000,
        "why": "A large MIT TypeScript application: event-driven, message-passing code, which is structurally different from library code.",
    },
    {
        "repo": "facebook/react",
        "expected": "MIT",
        "extensions": (".js", ".mjs", ".md", ".json", ".css"),
        "capBytes": 12_000_000,
        "why": "MIT, and front-end code with a documentation site in the same repository.",
    },
    {
        "repo": "vuejs/core",
        "expected": "MIT",
        "extensions": (".ts", ".mjs", ".js", ".md", ".json"),
        "capBytes": 12_000_000,
        "why": "A second TypeScript application of a different shape from vscode's, under MIT rather than Apache-2.0.",
    },
    {
        "repo": "sveltejs/svelte",
        "expected": "MIT",
        "extensions": (".js", ".mjs", ".ts", ".md", ".json", ".svelte", ".css"),
        "capBytes": 10_000_000,
        "why": "A compiler rather than an application: code that generates code, which the corpus had none of.",
    },
    {
        "repo": "rust-lang/rust",
        "expected": "Apache-2.0",
        "extensions": (".rs", ".md", ".toml"),
        "capBytes": 25_000_000,
        "why": "The largest Rust codebase, and licensed Apache-2.0 by the API despite the dual-licence file: the check reads the API answer at a pinned commit, not the repository's prose about itself.",
    },
    {
        "repo": "laravel/framework",
        "expected": "MIT",
        "extensions": (".php", ".md", ".json"),
        "capBytes": 12_000_000,
        "why": "PHP: a language the corpus would otherwise have none of, and one whose idioms differ sharply from the rest.",
    },
    {
        "repo": "godotengine/godot",
        "expected": "MIT",
        "extensions": (".cpp", ".h", ".hpp", ".c", ".md", ".py"),
        "capBytes": 15_000_000,
        "why": "C++ at scale under MIT: systems code with manual memory management, a different distribution of tokens from application code.",
    },
    {
        "repo": "github/docs",
        "expected": "CC-BY-4.0",
        "extensions": (".md",),
        "capBytes": 12_000_000,
        "why": "CC-BY-4.0 documentation: long-form instruction written for people, and the first source under a content licence rather than a software one.",
    },
    {
        "repo": "microsoft/ML-For-Beginners",
        "expected": "MIT",
        "extensions": (".md", ".ipynb", ".py", ".json"),
        "capBytes": 8_000_000,
        "why": "A taught curriculum: notebooks mix explanation with code, which is closer to the register of an assistant than any other source here.",
    },
    {
        "repo": "freeCodeCamp/freeCodeCamp",
        "expected": "BSD-3-Clause",
        "extensions": (".md", ".js", ".jsx", ".json", ".css"),
        "capBytes": 20_000_000,
        "why": "The largest BSD-3-Clause teaching corpus: instructional English in `blockquote` and challenge text, which is natural language rather than API reference.",
    },

    # --- sources the check is expected to refuse, kept so the refusal is in the record -----
    {
        "repo": "nodejs/node",
        "expected": "MIT",
        "extensions": (".js", ".mjs", ".md", ".json"),
        "capBytes": 0,
        "why": "Expected to be refused: GitHub reports no SPDX id for it despite an MIT LICENSE file. Kept in the list because a check that has never refused a large, popular, apparently-permissive repository has not been observed to work.",
    },
    {
        "repo": "python/cpython",
        "expected": "PSF-2.0",
        "extensions": (".py", ".md", ".rst", ".txt"),
        "capBytes": 0,
        "why": "Expected to be refused for a second reason: PSF-2.0 is a real open-source licence, and it is not on this corpus's allowlist. The allowlist is a decision, not a filter for bad licences.",
    },
    {
        "repo": "rust-lang/book",
        "expected": "Apache-2.0",
        "extensions": (".md",),
        "capBytes": 0,
        "why": "Expected to be refused: the API reports no SPDX id for the Rust Book, which was the one natural-language prose source on the wish list. Its absence is why the prose here is documentation and curriculum text instead.",
    },
)

#: Text extensions the training run declares. Kept here so the record and the command agree.
CORPUS_EXTENSIONS = (
    ".py", ".pyi", ".md", ".rst", ".txt", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
    ".json", ".go", ".rs", ".c", ".h", ".hpp", ".cpp", ".java", ".rb", ".php",
    ".sh", ".yml", ".yaml", ".toml", ".css", ".html", ".svelte", ".pyx", ".ipynb",
)

USER_AGENT = "klyvaron-corpus-assembler/1.0 (+https://github.com/rajaram-2005/ragam)"


def api(url: str, *, retries: int = 3) -> bytes:
    request = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/vnd.github+json",
    })
    last = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except urllib.error.HTTPError as error:  # 404 is a refusal, not a retry
            if error.code == 404:
                raise
            last = error
        except (urllib.error.URLError, TimeoutError) as error:
            last = error
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"could not fetch {url}: {last}")


def head_sha(repo: str) -> str:
    payload = json.loads(api(f"https://api.github.com/repos/{repo}/commits?per_page=1"))
    if not isinstance(payload, list) or not payload:
        raise RuntimeError(f"{repo}: no commits returned, so there is no revision to pin")
    return payload[0]["sha"]


def licence_at(repo: str, sha: str | None) -> tuple[str, str]:
    """(spdx id, path) for the repository's licence at that exact commit, or at the default branch."""
    url = f"https://api.github.com/repos/{repo}/license"
    payload = json.loads(api(url if sha is None else f"{url}?ref={sha}"))
    licence = payload.get("license") or {}
    return licence.get("spdx_id") or "NOASSERTION", payload.get("path") or ""


def tarball(repo: str, sha: str) -> tarfile.TarFile:
    raw = api(f"https://codeload.github.com/{repo}/tar.gz/{sha}")
    return tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz")


def keep(member: tarfile.TarInfo, extensions) -> bool:
    if not member.isfile():
        return False
    name = member.name.lower()
    return any(name.endswith(extension) for extension in extensions)


def licence_at_default_branch(repo: str) -> str | None:
    """What the API says about the licence without a ref, or None if it cannot say.

    Recorded only to explain a refusal, never to overturn one. GitHub's licence detector answers
    differently when it is scoped to a commit: `golang/go`, `rust-lang/rust` and `github/docs` all
    report an SPDX id for the default branch and `NOASSERTION` for the very same commit named
    explicitly. The refusal happens regardless -- the corpus is built at pinned commits, and a
    licence that is only known at a moving ref is not a licence for those bytes -- but "refused
    because the API could not identify the licence at this commit" and "refused because the
    project is not open source" are different facts, and a record that does not distinguish them
    tells a reader something false about somebody else's project.
    """
    try:
        return licence_at(repo, None)[0]
    except Exception:  # a refusal must not fail because its explanation failed
        return None


def assemble_source(source: dict, out_root: Path) -> dict:
    repo = source["repo"]
    sha = head_sha(repo)
    spdx, licence_path = licence_at(repo, sha)
    if spdx not in LICENCES_ALLOWED:
        elsewhere = licence_at_default_branch(repo)
        detail = (
            f" (the API reports {elsewhere} for the default branch, so this is the SHA-scoped answer "
            f"disagreeing with the ref-less one rather than a licence review of the project)"
            if elsewhere and elsewhere != spdx else ""
        )
        raise RuntimeError(
            f"{repo}@{sha[:12]} carries {spdx}, which is not on the allowlist; nothing was written{detail}"
        )
    if spdx != source["expected"]:
        raise RuntimeError(f"{repo}@{sha[:12]} carries {spdx}, not the expected {source['expected']}; refusing rather than adapting")

    destination = out_root / repo.replace("/", "__")
    written, total = [], 0
    with tarball(repo, sha) as archive:
        members = sorted((m for m in archive.getmembers() if keep(m, source["extensions"])), key=lambda m: m.name)
        for member in members:
            if total >= source["capBytes"]:
                break
            handle = archive.extractfile(member)
            if handle is None:
                continue
            data = handle.read()
            if not data or b"\x00" in data[:1024]:
                continue
            relative = Path(*Path(member.name).parts[1:])  # drop the "<repo>-<sha>/" prefix
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            total += len(data)
            written.append(str(target.relative_to(out_root)))
    return {
        "repo": repo,
        "commit": sha,
        "licence": spdx,
        "licencePath": licence_path,
        "expectedLicence": source["expected"],
        "why": source["why"],
        "extensions": list(source["extensions"]),
        "capBytes": source["capBytes"],
        "bytes": total,
        "files": len(written),
        "capped": total >= source["capBytes"],
    }


def git_state(root: Path) -> dict:
    """The revision of `root` and whether its working tree matches that revision.

    Every other source in this corpus comes from a tarball at a pinned SHA, so its revision
    *is* its bytes. This repository's own text is copied off disk, which means the revision
    alone does not say what was read: an edited, staged or newly written file changes the
    corpus while `rev-parse HEAD` still names the same commit.

    So the state is reported with the same `-dirty` suffix `train.code_revision()` writes for
    the code revision -- a corpus copied from a dirty tree is a record of what was read, not a
    recipe that can be replayed from the commit it names. `clean` is `None` when the question
    cannot be answered at all (not a git working tree, or git is unavailable).
    """
    import subprocess

    def run(*args: str):
        try:
            return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, timeout=10)
        except (subprocess.SubprocessError, OSError):
            # No git, or no directory. `None` is the answer: this is reported, not assumed.
            return None

    revision = run("rev-parse", "HEAD")
    if revision is None or revision.returncode != 0 or not revision.stdout.strip():
        return {"commit": None, "clean": None}
    sha = revision.stdout.strip()
    # `--untracked-files=all` because an untracked file is part of the copy: it is on disk,
    # so it is in the corpus, and a record that called the tree clean would be wrong.
    status = run("status", "--porcelain", "--untracked-files=all")
    if status is None or status.returncode != 0:
        return {"commit": f"{sha}-dirty", "clean": None}
    dirty = bool(status.stdout.strip())
    return {"commit": f"{sha}{'-dirty' if dirty else ''}", "clean": not dirty}


def copy_own_text(out_root: Path, cap_bytes: int = 12_000_000, *, root: Path | None = None,
                  extensions=None) -> dict:
    """This repository's own text, at the revision being read.

    Included because the family trains on what it can account for, and its own text is the one
    source whose provenance needs no licence check -- it is ours.

    The revision is recorded, and **whether the tree matched it**, because this is the one
    source copied off disk rather than fetched at a pinned SHA. `treeDigest` covers the files
    actually copied, path and content, so the copy can be checked against the record even when
    the revision cannot reproduce it.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from fabric.lm.data import DEFAULT_EXCLUDE_DIRS, DEFAULT_EXTENSIONS

    root = Path(REPO_ROOT if root is None else root)
    # The same extension set as the fetched sources by default, not the trainer's own default:
    # a corpus whose own-text copy uses a narrower list than its sources is a corpus with a
    # hole in it that nothing reports. (The first corpus had exactly that: `services/core` is
    # `.mjs`, and `.mjs` was copied but never read.)
    extensions = tuple(CORPUS_EXTENSIONS if extensions is None else extensions)
    destination = out_root / "rajaram-2005__ragam"
    total, files, hashes = 0, [], []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if any(part in DEFAULT_EXCLUDE_DIRS for part in relative.parts):
            continue
        if path.suffix not in extensions:
            continue
        if total >= cap_bytes:
            break
        data = path.read_bytes()
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        total += len(data)
        files.append(str(target.relative_to(out_root)))
        hashes.append((relative.as_posix(), hashlib.sha256(data).hexdigest()))

    tree = hashlib.sha256()
    for name, sha in sorted(hashes):
        tree.update(name.encode("utf-8") + b"\0" + sha.encode("ascii") + b"\n")

    state = git_state(root)
    return {
        "repo": "rajaram-2005/ragam",
        "commit": state["commit"],
        "licence": "first-party",
        "expectedLicence": "first-party",
        "why": "This repository's own text: the one corpus source whose right to be trained on is not in question.",
        "extensions": list(extensions),
        "capBytes": cap_bytes,
        "bytes": total,
        "files": len(files),
        "capped": total >= cap_bytes,
        # What makes the copy checkable: the revision it was read at, whether the tree matched
        # that revision, and a digest over the path and content of every file copied.
        "clean": state["clean"],
        "treeDigest": tree.hexdigest(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=str(REPO_ROOT / "artifacts" / "corpus"))
    parser.add_argument("--record", default=str(REPO_ROOT / "docs" / "experiments" / "corpus-sources.json"))
    parser.add_argument("--check-core-allowlist", action="store_true",
                        help="fail if this script's allowlist has drifted from the core's")
    args = parser.parse_args()

    if args.check_core_allowlist:
        core = (REPO_ROOT / "services/core/src/klyvaron/composition.mjs").read_text(encoding="utf-8")
        for licence in LICENCES_ALLOWED:
            if f"'{licence}'" not in core:
                print(f"allowlist drift: the core does not list {licence}", file=sys.stderr)
                return 2

    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)
    sources, failures = [], []
    own = copy_own_text(out_root)
    sources.append(own)
    print(f"  {own['repo']} @ {own['commit'][:12]} first-party {own['files']} files, {own['bytes'] / 1e6:.2f} MB")
    for source in SOURCES:
        try:
            record = assemble_source(source, out_root)
            sources.append(record)
            print(f"  {record['repo']} @ {record['commit'][:12]} {record['licence']} "
                  f"{record['files']} files, {record['bytes'] / 1e6:.2f} MB{' (capped)' if record['capped'] else ''}")
        except Exception as error:  # a refused source is recorded, never silently skipped
            failures.append({"repo": source["repo"], "error": str(error)})
            print(f"  {source['repo']}: REFUSED — {error}", file=sys.stderr)

    record = {
        "format": "klyvaron-corpus-sources/v1",
        "purpose": "The licence-checked public sources an assembled corpus is built from.",
        "licencesAllowed": list(LICENCES_ALLOWED),
        "corpusExtensions": list(CORPUS_EXTENSIONS),
        "sources": sources,
        "refused": failures,
        "totalBytes": sum(source["bytes"] for source in sources),
        "note": (
            "Each source is pinned to the commit whose licence was read, and the licence was read "
            "from that commit rather than from the default branch. A refused source contributed no "
            "bytes. The repository's own text is the one source copied off disk rather than fetched at "
            "a pinned SHA: its entry records the revision it was read at, whether the working tree "
            "matched that revision (`clean`) and a digest over the path and content of every file "
            "copied (`treeDigest`), because a copy of a dirty tree is a record of what was read rather "
            "than a recipe that can be replayed from the commit it names."
        ),
    }
    Path(args.record).parent.mkdir(parents=True, exist_ok=True)
    Path(args.record).write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {args.record}: {len(sources)} sources, {record['totalBytes'] / 1e6:.2f} MB, "
          f"{len(failures)} refused")
    return 1 if failures and not sources else 0


if __name__ == "__main__":
    raise SystemExit(main())
