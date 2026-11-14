# Semgrep finding triage notes

Historical Semgrep CE 1.185.0 runs `e376c524`, `b890b26a`, and `80b60063` reported
seven, six, and six MEDIUM findings respectively. Those scans used the same base
commit but a dirty worktree; their reports are historical context only. The earlier
six-finding report included a `compose.lan.yaml:13` `port-all-interfaces` finding that
was later remediated by removing the tracked port mapping.

The initial finding-origin Semgrep CE 1.185.0 scan is `4bd031ad` at base commit
`b676af68c646f3e5260e77bdfd38244c64666caa`. It scanned 353 paths, completed with
exit code 0, and reported five MEDIUM, zero HIGH, and zero CRITICAL findings. The
sanitized report hashes are JSON
`f9ca9de06640c9f7755c7e98a2aea895f8643043c374fc6ebd3e3f642ad3070e` and SARIF
`4b03dc2dc711a976c969df6d8d72c1dc21bc1155d5c966e6025d3beb78ea6048`; the independent
`sha256sum -c` report-checksum gate passed. The external run directory is
`/tmp/ragam-security-sast-final/b676af68c646-2026-11-14T07-42-03-416Z-4bd031ad/`.

The finding-origin scan was performed on the preserved dirty working tree, not a
clean commit, so its SAST and source-integrity gates **FAIL**. After adding the
location-specific review catalog, Semgrep was rerun as `b3686d55` against the same
base commit and 353-path scope. It again completed with five MEDIUM findings, exit
code 0, and independently verified report hashes: JSON
`f8c4188d8ab5c3947e03f03558b1b0823c07fdcb5e6ed83047508edfce04713d` and SARIF
`70f0b7796a309e50d60048e671acc30098069d721023e20e67d2a0f3b9ac7236`. All five
findings were annotated `REVIEWED`; the finding-review gate and report-checksum gate
**PASS**. The SAST gate and source-integrity gate **FAIL** because the checkout is
dirty, so this is not release qualification. The external reviewed run directory is
`/tmp/ragam-security-sast-reviewed/b676af68c646-2026-11-14T07-45-41-749Z-b3686d55/`.
Its isolated snapshot SHA-256 is `6af4b0bc2ffc99bac94f7ac2d7229c1a32fd77d9fadf8a8dc6b98c34dd46dede`;
the dirty-worktree fingerprint is `e656e043fd16b61806fd090735dc3cd87496765d0e8149cf32a0b6040a90d76b`.
The recorded `.aetheris-data` exclusion counts were zero in the working tree and
snapshot; the inventory stores no individual user-data paths or contents. The
historical port-binding finding is reviewed below as a remediation, not dismissed
as a false positive. No rule or finding is suppressed or downgraded.

| Location / rule | Source-to-sink path and exploitability | Root cause | Disposition and evidence |
| --- | --- | --- | --- |
| `Dockerfile.web:16` — `security.semgrep.rules.generic.wget-unencrypted-url` | The image HEALTHCHECK invokes `wget --spider` to fixed `http://127.0.0.1:8080/healthz` inside the Web container. The URL is container-loopback, the service is not host-published, and the target returns a body-free 200. An off-container observer cannot intercept it; no credentials or application data are sent. | Generic `wget ... http://` pattern does not distinguish loopback healthchecks from remote cleartext transmission. | **FALSE_POSITIVE**; no CWE-319 data-exposure path and no residual risk identified. Reviewed in `security/reviews/semgrep-findings.json`; evidence: `Dockerfile.web:16`, `deploy/Web.Caddyfile:2-3`, and reviewed Semgrep rerun `b3686d55`. |
| `compose.yaml:52` — same rule | Compose's Web healthcheck sends the same fixed loopback request from inside Web. Port 8080 is only exposed to the private Compose network, not published to the host; the health endpoint returns only a static status. No remote attacker can observe this hop absent prior host/container compromise. | Same generic scheme-only match; it does not model service namespace or network exposure. | **FALSE_POSITIVE**; same catalog and scan evidence. The finding remains in Semgrep JSON/SARIF with an individual review annotation; it is not suppressed. |
| `compose.yaml:78` — same rule | Caddy's healthcheck probes `http://127.0.0.1:2019/config/` from inside Caddy. The repository publishes the edge only on `127.0.0.1:80:80`; it does not publish admin port 2019. No credentials or application request data are sent, and the loopback hop is not remotely observable. | Generic scheme-only match does not distinguish a local, unpublished admin health probe. | **FALSE_POSITIVE**; the Caddy admin endpoint is not exposed through this mapping and the reported CWE-319 transmission is absent. Evidence: `compose.yaml:77-83` and reviewed run `b3686d55`; no residual risk identified. |
| `scripts/release/open-source-security.mjs:1720` — same rule | The DAST runner uses `docker compose exec web` to probe the fixed Web-container loopback health URL before launching ZAP. This is an internal readiness check, not a scan target or external request; no credentials or application data are sent. | Generic pattern does not account for `docker compose exec` running in the container's network namespace. | **FALSE_POSITIVE**; evidence: runner line 1720, `security/dast/compose.yaml` (internal network, no published ports), `security/dast/Caddyfile:4-5`, and reviewed run `b3686d55`; no residual risk identified. |
| `security/dast/compose.yaml:64` — same rule | The disposable DAST Web container probes its own `127.0.0.1:8080/healthz`. The DAST network is marked `internal: true`, no host port is published, and the endpoint returns a static status. | Generic rule does not model loopback or the isolated test network. | **FALSE_POSITIVE**; evidence: `security/dast/compose.yaml:63-70`, `security/dast/Caddyfile:4-5`, and reviewed run `b3686d55`; no residual risk identified. |
| Historical `compose.lan.yaml:13` — `port-all-interfaces` | The old tracked Compose `ports` shorthand fed a container port to Docker without an explicit host IP, which can bind on all host interfaces. Direct Compose invocation could bypass the launcher's private-address validation and widen access to the LAN. This was an actionable configuration exposure, not a false positive. | A tracked wildcard-capable port mapping was present in the overlay rather than generated only after validated operator input. | **REMEDIATED**: the tracked overlay now has no `ports` mapping. `scripts/Start-Lan-Ragam.ps1` validates an RFC1918 IPv4 then writes a temporary Compose override outside the repository with that exact address and removes it in `finally`; the base profile remains hard-bound to loopback. Current Semgrep run has no matching finding. Evidence: current `compose.lan.yaml`, `scripts/Start-Lan-Ragam.ps1`, and `docs/22-self-hosted-deployment.md`. The PowerShell launcher has not been executed here because `pwsh` is unavailable, so launcher runtime validation remains outstanding. |

A separate earlier base-profile binding issue was also actionable: an environment-
driven `RAGAM_BIND_ADDRESS` could expose the account-free profile beyond loopback.
That override was removed; `compose.yaml` is now hard-bound to `127.0.0.1:80:80`, and
current Semgrep no longer reports it. The LAN overlay is separate and has no tracked
port mapping.

The five current findings are annotated individually as `FALSE_POSITIVE` in
`security/reviews/semgrep-findings.json`; the catalog records each source-to-sink path,
exploitability assessment, root cause, technical rationale, evidence, residual-risk
assessment, and reviewer. No owner approval is asserted because the reviewed loopback
requests have no identified residual CWE-319 risk. The historical all-interface port
finding is documented as **REMEDIATED**, not as a false positive; the launcher still
needs runtime validation on a PowerShell-capable host.

Semgrep runs with inline `nosem` disabled, rejects `.semgrepignore` files, and retains
all scanner findings in JSON/SARIF with review annotations. No rule, finding, or
severity is suppressed or downgraded. These technical reviews do not qualify the
working tree: the current scan used a dirty snapshot, so the SAST and source-integrity
gates remain failed until a fresh full qualification runs on the eventual immutable,
clean source commit.
