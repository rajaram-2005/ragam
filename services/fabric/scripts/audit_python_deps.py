#!/usr/bin/env python3
"""Check installed Python dependencies against the GitHub Advisory Database.

`npm audit` covers the web tree in CI. Nothing covered the Python tree, so a newly
published numpy advisory would not have failed the build — an asymmetry that existed
only because npm ships an audit command and pip does not.

This queries the public advisory API directly. Standard library plus `packaging`,
which pytest already depends on, so no dependency is added for the sake of the check.

Exit codes:
    0   every checked package is outside every advisory's vulnerable range
    1   at least one installed version is covered by an advisory
    2   the check could not be completed (network, auth, rate limit, bad data)

Exit 2 matters. A security gate that silently passes when it cannot reach the
database is worse than no gate, because it reports green while checking nothing.
This branch already contains two instances of that exact failure mode — an
environment-variable inventory test that matched none of the secret forms, and a
copyleft test whose regex happened not to include MPL — so "could not verify" is
deliberately a distinct, failing state rather than a warning.

Usage:
    python audit_python_deps.py                  # check the default package set
    python audit_python_deps.py numpy==1.21.0    # check an explicit version
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

try:
    from packaging.specifiers import SpecifierSet
    from packaging.version import InvalidVersion, Version
except ImportError:  # pragma: no cover - depends on the caller's environment
    print("FATAL: the 'packaging' distribution is required (pytest depends on it)", file=sys.stderr)
    raise SystemExit(2)

API = "https://api.github.com/advisories"

# The Python packages this project actually installs. services/fabric checks both
# numerical/multimodal runtime libraries and test tooling against GitHub Advisories.
RUNTIME_PACKAGES = ("numpy", "jax", "av", "Pillow")
TEST_PACKAGES = ("pytest", "pluggy", "iniconfig", "packaging")


def installed_version(name: str) -> str | None:
    """Read a version from the live environment, or None if absent."""
    import importlib.metadata

    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def fetch_advisories(package: str) -> list[dict]:
    """Fetch every advisory recorded against a package name.

    Raises on any transport or protocol failure so the caller can distinguish
    "clean" from "could not check".
    """
    url = f"{API}?affects={urllib.parse.quote(package)}&per_page=100"
    request = urllib.request.Request(url)
    request.add_header("Accept", "application/vnd.github+json")
    request.add_header("X-GitHub-Api-Version", "2022-11-28")
    request.add_header("User-Agent", "aetheris-omni-dependency-audit")
    # In GitHub Actions the runner's egress IP is shared, and the unauthenticated
    # advisory rate limit is low enough to be hit by unrelated work. Use the token
    # the runner already provides when it is there.
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        request.add_header("Authorization", f"Bearer {token}")

    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)

    if not isinstance(payload, list):
        raise ValueError(f"unexpected advisory payload for {package}: {type(payload).__name__}")
    return payload


def matching_vulnerabilities(advisory: dict, package: str, version: Version) -> list[dict]:
    """Return the vulnerabilities in one advisory that actually cover this version.

    The API returns advisories for a package NAME across ecosystems, and each
    advisory can list several affected ranges. Both must be filtered: an npm package
    called "packaging" is not this one, and an advisory affecting "< 1.22" does not
    affect 2.1.3.
    """
    hits = []
    for vulnerability in advisory.get("vulnerabilities") or []:
        pkg = vulnerability.get("package") or {}
        if pkg.get("name") != package:
            continue
        if pkg.get("ecosystem") not in ("pip", "PyPI"):
            continue
        raw_range = (vulnerability.get("vulnerable_version_range") or "").strip()
        if not raw_range:
            continue
        normalized_range = re.sub(r"(?<![<>!=~])=\s*([0-9])", r"== \1", raw_range)
        try:
            if version in SpecifierSet(normalized_range):
                hits.append(
                    {
                        "ghsa": advisory.get("ghsa_id"),
                        "cve": advisory.get("cve_id"),
                        "severity": advisory.get("severity"),
                        "summary": advisory.get("summary"),
                        "range": raw_range,
                        "fixed": vulnerability.get("first_patched_version"),
                        "url": advisory.get("html_url"),
                    }
                )
        except Exception as error:  # an unparseable range must not be skipped silently
            raise ValueError(
                f"cannot interpret range {raw_range!r} for {package} "
                f"({advisory.get('ghsa_id')}): {error}"
            ) from error
    return hits


def audit(targets: dict[str, str]) -> tuple[list[dict], list[str]]:
    """Audit {package: version}. Returns (findings, packages_with_no_advisory)."""
    findings: list[dict] = []
    clean: list[str] = []

    for package, raw_version in sorted(targets.items()):
        try:
            version = Version(raw_version)
        except InvalidVersion as error:
            raise ValueError(f"{package} has an unparseable version {raw_version!r}: {error}") from error

        advisories = fetch_advisories(package)
        matched = []
        for advisory in advisories:
            matched.extend(matching_vulnerabilities(advisory, package, version))

        if matched:
            findings.extend(dict(item, package=package, installed=raw_version) for item in matched)
        else:
            # Distinguish "no advisory exists for this package at all" from
            # "advisories exist but none covers this version" — the second is the
            # interesting result, and collapsing them hides it.
            label = package if advisories else f"{package} (none recorded)"
            clean.append(f"{label} {raw_version}: {len(advisories)} advisory(ies) recorded, none covers this version")

    return findings, clean


def main(argv: list[str]) -> int:
    targets: dict[str, str] = {}

    if len(argv) > 1:
        # Explicit `name==version` arguments, so the checker can be pointed at a
        # known-vulnerable version to prove it actually fails.
        for spec in argv[1:]:
            if "==" not in spec:
                print(f"FATAL: expected name==version, got {spec!r}", file=sys.stderr)
                return 2
            name, _, version = spec.partition("==")
            targets[name.strip()] = version.strip()
    else:
        for name in RUNTIME_PACKAGES + TEST_PACKAGES:
            version = installed_version(name)
            if version is None:
                print(f"note: {name} is not installed in this environment; skipped")
                continue
            targets[name] = version

    if not targets:
        print("FATAL: nothing to check — no packages resolved", file=sys.stderr)
        return 2

    try:
        findings, clean = audit(targets)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError) as error:
        kind = "rate limited or refused" if isinstance(error, urllib.error.HTTPError) else "unreachable"
        print(f"FATAL: the advisory database could not be consulted ({kind}): {error}", file=sys.stderr)
        print(
            "This is exit 2, not exit 0. A dependency check that cannot reach the "
            "database has verified nothing and must not report success.",
            file=sys.stderr,
        )
        return 2

    print(f"checked {len(targets)} package(s) against the GitHub Advisory Database\n")
    for line in clean:
        print(f"  clean      {line}")

    if not findings:
        print("\nno installed version is covered by a known advisory")
        return 0

    print(f"\n{len(findings)} finding(s):")
    for item in findings:
        print(f"  {item['severity'] or 'unknown':9} {item['package']} {item['installed']}")
        print(f"            {item['ghsa']}" + (f" / {item['cve']}" if item["cve"] else ""))
        print(f"            affects {item['range']}")
        if item["fixed"]:
            print(f"            fixed in {item['fixed']}")
        print(f"            {item['summary']}")
        print(f"            {item['url']}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
