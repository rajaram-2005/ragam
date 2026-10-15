"""Prove the suite still catches the removal of each rule that docs/21 §11 names.

A test suite is only evidence while it can still fail. This script removes one rule at a
time from a scratch copy of the checkout and requires the suite to notice:

    1. copy the repository to a temporary directory,
    2. delete exactly one rule by literal text replacement (the count must be 1, or the
       script stops: an anchor that no longer matches means this check has gone stale and
       must not report success),
    3. run the whole fabric suite in the copy,
    4. require a failure.

An anchor that has moved exits 1 with ``STALE`` and a rule whose removal leaves the suite
green exits 1 with ``ESCAPED``. Exit code is 0 only when every rule was still caught.

Run it after changing any of the rules below, and after editing docs/21 §11::

    python services/fabric/scripts/mutation_check.py

Why it is not wired into CI: it is correct but expensive -- the suite runs once per rule,
about four minutes in total -- and nothing it guards changes without a human editing one of
these files. The suite itself remains the gate that runs on every push.

The rules, and the module that owns each one, are listed in ``MUTATIONS``. They are the
same nine rules docs/21 §11 claims were checked; the doc names the test that caught each.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
FABRIC = REPO / "services" / "fabric"
IGNORE = shutil.ignore_patterns(
    ".git", "node_modules", "__pycache__", ".pytest_cache", "artifacts", "dist", "*.egg-info"
)

#: (label, file relative to services/fabric, text to remove, replacement)
MUTATIONS: list[tuple[str, str, str, str]] = [
    (
        "model-verification gate",
        "fabric/training/hf_peft.py",
        "        if resolved != revision:\n            problems.append(",
        "        if False:  # MUTATION\n            problems.append(",
    ),
    (
        "dataset-pin gate",
        "fabric/training/smoke.py",
        '        if got.get("sha256") != section.get("sha256") or got.get("examples") != section.get("examples"):\n',
        "        if False:  # MUTATION\n",
    ),
    (
        "kaggle_output path rule",
        "fabric/training/policy.py",
        '        if not normal.startswith(KAGGLE_OUTPUT_PREFIX) or normal == KAGGLE_OUTPUT_PREFIX.rstrip("/"):\n',
        "        if False:  # MUTATION\n",
    ),
    (
        "synthetic label check",
        "fabric/training/jobspec.py",
        '        if "SYNTHETIC" not in str(dataset.get("contentsDescription", "")):\n',
        "        if False:  # MUTATION\n",
    ),
    (
        "Colab acknowledgement",
        "fabric/training/policy.py",
        '    if section.get("storageKind") in EPHEMERAL_KINDS and section.get("ephemeralAcknowledged") is not True:\n',
        "    if False:  # MUTATION\n",
    ),
    (
        "persistence rule",
        "fabric/training/smoke.py",
        '                "verified": self.stages["persistence"]["status"] == PASSED,\n',
        '                "verified": True,  # MUTATION\n',
    ),
    (
        "resume-source rule",
        "fabric/training/policy.py",
        "        if not normal.startswith(KAGGLE_INPUT_PREFIX):\n",
        "        if False:  # MUTATION\n",
    ),
    (
        "import overwrite guard",
        "fabric/training/checkpoint.py",
        "    if local is not None and local.step >= found.step:\n",
        "    if False:  # MUTATION\n",
    ),
    (
        "the verdict's quality rule",
        "fabric/training/smoke.py",
        '        if self.stages["quality"]["status"] == FAILED:\n            return "NOT ACCEPTED"\n',
        '        if False:  # MUTATION\n            return "NOT ACCEPTED"\n',
    ),
]


def check_one(scratch: Path, label: str, relative: str, old: str, new: str) -> dict:
    """Mutate a fresh copy, run the suite, and report whether the suite noticed."""
    tree = scratch / re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
    shutil.copytree(REPO, tree, ignore=IGNORE)

    target = tree / "services" / "fabric" / relative
    text = target.read_text(encoding="utf-8")
    if text.count(old) != 1:
        return {"label": label, "outcome": "STALE", "detail": f"anchor found {text.count(old)} times in {relative}"}
    target.write_text(text.replace(old, new), encoding="utf-8")

    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "--tb=no", "-rf", "-p", "no:cacheprovider"],
        cwd=tree / "services" / "fabric", capture_output=True, text=True, timeout=1800,
    )
    output = proc.stdout + proc.stderr
    failed = re.findall(r"^(?:FAILED|ERROR) (\S+)", output, re.M)
    if proc.returncode == 0:
        return {"label": label, "outcome": "ESCAPED", "detail": "the suite passed with the rule removed"}
    if not failed:
        return {"label": label, "outcome": "STALE", "detail": "the suite failed for no named test: " + output[-300:]}
    shutil.rmtree(tree, ignore_errors=True)
    return {"label": label, "outcome": "CAUGHT", "detail": failed[0]}


def main() -> int:
    scratch = Path(tempfile.mkdtemp(prefix="aetheris-mutation-"))
    print(f"scratch: {scratch}\nsuite:   {FABRIC}\n")
    results = []
    for label, relative, old, new in MUTATIONS:
        print(f"... removing {label}")
        result = check_one(scratch, label, relative, old, new)
        results.append(result)
        detail = result["detail"].split("::")[-1]
        print(f"    {result['outcome']}: {detail}", flush=True)

    print("\n| rule removed | outcome | caught by |")
    print("| --- | --- | --- |")
    for r in results:
        print(f"| {r['label']} | {r['outcome']} | {r['detail'].split('::')[-1]} |")

    bad = [r for r in results if r["outcome"] != "CAUGHT"]
    if bad:
        kept = [r["label"] for r in bad]
        print(f"\n{len(bad)} rule(s) not caught: {kept}. Scratch copy kept at {scratch}")
        return 1
    shutil.rmtree(scratch, ignore_errors=True)
    print(f"\nall {len(results)} rules are caught by a named test")
    return 0


if __name__ == "__main__":
    sys.exit(main())
