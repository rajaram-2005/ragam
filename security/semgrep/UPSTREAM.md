# Semgrep CE rule provenance

The vendored rule files in `rules/` are selected from the public
[`trailofbits/semgrep-rules`](https://github.com/trailofbits/semgrep-rules)
repository at commit `31390b3a99c04c81522d1b37c8d1900aa2dd4094`. The selection
contains 72 rules from its `generic/`, `javascript/`, `python/`, and `yaml/`
directories; upstream test fixtures are not copied as production rules. The
codeload source archive SHA-256 is recorded in `security/scanner-versions.json`.

Trail of Bits is the upstream rule author/maintainer; this rule set is not a
Semgrep commercial registry pack. The upstream `LICENSE` is preserved verbatim
as `UPSTREAM-LICENSE.txt` (AGPL-3.0). These files are distributed with their
upstream license, separate from Ragam's MIT-licensed application. The Semgrep CE
engine is independently pinned to version `1.185.0` and is run locally against
these checked-in rules. No Semgrep account, paid feature, cloud registry, source
upload, or usage metrics are used.

The selected sources include JavaScript/TypeScript checks, Python security
checks, generic security checks, and YAML checks for infrastructure and
GitHub Actions. Where upstream metadata supplies CWE/OWASP mappings, the
sanitized evidence retains those identifiers. Additional upstream rules are
not fetched at runtime. Updating the rules requires changing the pinned commit,
refreshing the selected files and license, reviewing the complete diff, then
rerunning the qualification.

No `nosemgrep`, `--exclude-rule`, baseline, finding allowlist, `.semgrepignore`,
or other suppression is applied. The runner refuses a root `.semgrepignore`
file and reports parser errors as an incomplete SAST run rather than passing.
