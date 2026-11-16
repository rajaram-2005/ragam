import test from 'node:test'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertDastConfig, excludedWorktreeClass, parseBuildxImageInspection, renderSecurityStepSummary } from './open-source-security.mjs'
import {
  gateFromScanner,
  TRIVY_PIP_REQUIREMENTS_LOCK_PATTERN,
  normalizeGitleaksJson,
  normalizeSemgrepJson,
  normalizeTrivyJson,
  normalizeZapJson,
  renderZapHtml,
  safeRelativePath,
  sanitizeSarif,
  sanitizeZapHtml,
  sha256,
  summarizeFindings,
  trivyFindings,
  zapFindings,
  zapActiveScanOutcome,
} from './open-source-security-utils.mjs'

const fixtureSecret = 'fixture_secret_value_MUST_NEVER_BE_PERSISTED_9f41'

test('Trivy lockfile pattern targets the exact Fabric requirements.lock name', () => {
  assert.equal(TRIVY_PIP_REQUIREMENTS_LOCK_PATTERN, String.raw`pip:requirements\.lock`)
})

test('Semgrep disables network version checks, inline nosem, and checked-in ignore files', () => {
  const runner = readFileSync(new URL('./open-source-security.mjs', import.meta.url), 'utf8')
  assert.match(runner, /--disable-version-check/)
  assert.match(runner, /--disable-nosem/)
  assert.match(runner, /function semgrepSuppressionReason/)
  assert.match(runner, /suppressions: false/)
})

test('the local .aetheris-data store has separate classification and exclusion-only reporting', () => {
  assert.equal(excludedWorktreeClass('.aetheris-data/accounts/store.sqlite'), 'user-data')
  assert.equal(excludedWorktreeClass('services/core/.aetheris-data/private.json'), 'user-data')
  assert.equal(excludedWorktreeClass('services/core/src/store.mjs'), null)
  const runner = readFileSync(new URL('./open-source-security.mjs', import.meta.url), 'utf8')
  assert.match(runner, /status', '--porcelain=v1', '--untracked-files=all'.*USER_DATA_GIT_PATHSPECS/)
  assert.match(runner, /diff', '--binary', 'HEAD'.*USER_DATA_GIT_PATHSPECS/)
  assert.match(runner, /contentRead: false/)
  assert.match(runner, /historicalUserDataPathInventory/)
  assert.match(runner, /historyUserDataContentsRead: false/)
})

function passingEvidence(overrides = {}) {
  return gateFromScanner({
    executed: true,
    complete: true,
    validated: true,
    cleanCheckout: true,
    findings: [],
    ...overrides,
  })
}

test('the OSS workflow covers PRs, release pushes, manual dispatch, full qualification, and external evidence upload', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/open-source-security.yml', import.meta.url), 'utf8')
  assert.match(workflow, /^on:/m)
  assert.match(workflow, /pull_request:/)
  assert.match(workflow, /push:/)
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /pull_request:\s*\n\s+branches: \[main, 'release\/\*\*'\]/)
  assert.match(workflow, /push:\s*\n\s+branches: \[main, 'release\/\*\*', 'arena\/\*\*'\]/)
  assert.match(workflow, /runs-on: ubuntu-latest/)
  assert.match(workflow, /npm run release:security:full/)
  assert.match(workflow, /if: always\(\)/)
  assert.match(workflow, /source-inventory\.json/)
  assert.match(workflow, /retention-days: 30/)
})

test('ZAP registry inspection parser requires the locked digest and platform descriptor', () => {
  const digest = `sha256:${'a'.repeat(64)}`
  const amd64Digest = `sha256:${'b'.repeat(64)}`
  const arm64Digest = `sha256:${'c'.repeat(64)}`
  const inspection = [
    'Name: ghcr.io/zaproxy/zaproxy:2.17.0',
    'MediaType: application/vnd.oci.image.index.v1+json',
    `Digest: ${digest}`,
    'Manifests:',
    `  Name: ghcr.io/zaproxy/zaproxy:2.17.0@${amd64Digest}`,
    '  MediaType: application/vnd.oci.image.manifest.v1+json',
    '  Platform: linux/amd64',
    `  Name: ghcr.io/zaproxy/zaproxy:2.17.0@${arm64Digest}`,
    '  Platform: linux/arm64',
  ].join('\n')
  const parsed = parseBuildxImageInspection(inspection, 'linux/amd64')
  assert.equal(parsed.digest, digest)
  assert.deepEqual(parsed.platforms, ['linux/amd64', 'linux/arm64'])
  assert.equal(parsed.observedPlatform, 'linux/amd64')
  assert.equal(parsed.platformManifestDigest, amd64Digest)
  assert.equal(parseBuildxImageInspection(inspection, 'linux/arm/v7').observedPlatform, null)
  assert.equal(parseBuildxImageInspection('Digest: invalid\n  Platform: linux/amd64', 'linux/amd64').digest, null)
})

test('GitHub step summary exposes only sanitized findings, locked identity and report hashes', () => {
  const evidence = {
    run: { id: 'fixture-run', mode: 'full', status: 'BLOCKED' },
    source: { branch: 'arena/947d8745-ragam', commit: 'a'.repeat(40) },
    qualification: { ossSecurity: { status: 'NOT QUALIFIED' } },
    scanners: {
      sast: {
        name: 'Semgrep Community Edition', version: '1.185.0', status: 'COMPLETED',
        findingSummary: { total: 1 },
        findings: [{ id: 'b'.repeat(24), ruleId: 'test.rule', severity: 'HIGH', path: 'services/core/app.mjs', start: { line: 17 }, reviewState: 'UNREVIEWED', message: fixtureSecret, source: fixtureSecret }],
      },
      dast: {
        scope: { imageDigestVerification: {
          status: 'VERIFIED', tag: 'ghcr.io/zaproxy/zaproxy:2.17.0', indexDigest: `sha256:${'c'.repeat(64)}`,
          platform: 'linux/amd64', platformManifestDigest: `sha256:${'d'.repeat(64)}`,
        } },
      },
    },
    releaseGates: [{ id: 'SAST', status: 'FAIL' }],
    reportHashVerification: { verified: true, count: 1, method: 'sha256sum -c' },
    reports: [{ path: 'reports/semgrep.json', format: 'json', bytes: 100, sha256: 'e'.repeat(64), validated: true, sanitized: true }],
  }
  const summary = renderSecurityStepSummary(evidence)
  assert.match(summary, /arena\/947d8745-ragam/)
  assert.match(summary, /services\/core\/app\.mjs:17/)
  assert.match(summary, /NOT TESTED/)
  assert.match(summary, /Platform manifest digest/)
  assert.match(summary, /1\.185\.0 \/ 1\.185\.0/)
  assert.match(summary, /e{64}/)
  assert.match(summary, /sha256sum -c/)
  assert.equal(summary.includes(fixtureSecret), false)
  assert.equal(summary.includes('source:'), false)
})

test('production and isolated DAST Web containers enforce non-root, read-only runtime controls', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  assert.doesNotThrow(() => assertDastConfig(root))

  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ragam-web-hardening-'))
  try {
    for (const relativePath of [
      'Dockerfile.web',
      'compose.yaml',
      'security/dast/compose.yaml',
      'security/dast/Caddyfile',
      'security/dast/openapi.yaml',
    ]) {
      const target = join(fixtureRoot, relativePath)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(join(root, relativePath), target)
    }

    const regressions = [
      ['Dockerfile.web', 'USER 10001:10001', 'USER root', 'Web image must run as non-root UID/GID 10001'],
      ['compose.yaml', '    init: true\n    read_only: true\n', '    init: true\n    read_only: false\n', 'compose.yaml Web root filesystem must be read-only'],
      ['compose.yaml', '      - no-new-privileges:true\n    cap_drop:\n      - ALL\n    expose:\n      - "8080"', '      - no-new-privileges:false\n    cap_drop:\n      - ALL\n    expose:\n      - "8080"', 'compose.yaml Web must enable no-new-privileges'],
      ['compose.yaml', '    cap_drop:\n      - ALL\n    expose:\n      - "8080"', '    cap_drop:\n      - NET_BIND_SERVICE\n    expose:\n      - "8080"', 'compose.yaml Web must drop all Linux capabilities'],
      ['compose.yaml', '      - /data:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=10001,gid=10001', '      - /data:rw', 'compose.yaml Web is missing its restricted ephemeral /data mount'],
      ['security/dast/compose.yaml', '          - edge\n    security_opt:\n      - no-new-privileges:true\n    cap_drop:\n      - ALL\n    healthcheck:', '          - edge\n    security_opt:\n      - no-new-privileges:false\n    cap_drop:\n      - ALL\n    healthcheck:', 'security/dast/compose.yaml Web must enable no-new-privileges'],
      ['security/dast/compose.yaml', '    platform: ${RAGAM_DAST_PLATFORM:?set by the security runner}\n', '', 'ZAP platform must be set only from the scanner lock by the security runner'],
    ]

    for (const [relativePath, before, after, expectedError] of regressions) {
      const target = join(fixtureRoot, relativePath)
      const original = readFileSync(target, 'utf8')
      assert.ok(original.includes(before), `regression fixture must contain ${before}`)
      writeFileSync(target, original.replace(before, after))
      try {
        assert.throws(() => assertDastConfig(fixtureRoot), (error) => error.message.includes(expectedError), `${relativePath} must fail closed: ${expectedError}`)
      } finally {
        writeFileSync(target, original)
      }
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('release verifier reports unsigned staging bundles honestly and blocks a required missing signature', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const verifier = fileURLToPath(new URL('./verify-release.mjs', import.meta.url))
  const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.match(workflow, /Verify signed bundle against the owner-pinned public key/)
  assert.match(workflow, /RAGAM_RELEASE_VERIFY_PUBLIC_KEY_ASCII/)
  assert.match(workflow, /RAGAM_RELEASE_VERIFY_FINGERPRINT/)
  assert.match(workflow, /--require-signature/)
  assert.match(workflow, /secrets\.RAGAM_RELEASE_SIGNING_PRIVATE_KEY_ASCII/)
  assert.match(workflow, /only the repository owner may request signing/)
  assert.match(workflow, /GITHUB_ACTOR.*GITHUB_REPOSITORY_OWNER/)
  assert.match(workflow, /umask 077/)
  assert.match(workflow, /chmod 600 "\$key_file"/)
  assert.match(workflow, /unset RAGAM_RELEASE_SIGNING_PRIVATE_KEY_ASCII/)
  assert.match(workflow, /trap 'rm -f -- "\$key_file"' EXIT/)
  assert.doesNotMatch(workflow, /secrets\.RAGAM_RELEASE_SIGNING_KEY_FILE/)
  const bundle = join(root, 'docs/release/artifacts')
  const signature = join(bundle, 'SHA256SUMS.asc')
  assert.equal(existsSync(signature), false, 'the committed reproducible bundle remains unsigned')

  const runVerifier = (extra = []) => spawnSync(process.execPath,
    [verifier, '--dir', bundle, ...extra], { cwd: root, encoding: 'utf8', timeout: 30_000 })
  const optional = runVerifier()
  assert.match(optional.stdout, /NOT TESTED\s+detached signature verification/)
  assert.doesNotMatch(optional.stdout, /FAIL\s+detached signature verification/)

  const required = runVerifier(['--require-signature'])
  assert.equal(required.status, 1, `${required.stdout}\n${required.stderr}`)
  assert.match(required.stdout, /BLOCKED\s+detached signature verification/)
  assert.match(required.stdout, /SHA256SUMS\.asc is missing/)
  assert.equal(existsSync(signature), false, 'verification must not manufacture a signature')
})

test('release verifier refuses manifest paths that escape the bundle even when the outside digest matches', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const verifier = fileURLToPath(new URL('./verify-release.mjs', import.meta.url))
  const scratch = mkdtempSync(join(tmpdir(), 'ragam-release-path-'))
  const bundle = join(scratch, 'bundle')
  const outside = join(scratch, 'outside.txt')
  mkdirSync(bundle)
  const outsideBytes = Buffer.from('outside fixture content')
  writeFileSync(outside, outsideBytes)
  try {
    writeFileSync(join(bundle, 'SHA256SUMS'), `${sha256(outsideBytes)}  ../outside.txt\n`)
    const checksumDigest = sha256(readFileSync(join(bundle, 'SHA256SUMS')))
    writeFileSync(join(bundle, 'manifest.json'), `${JSON.stringify({
      version: '0.2.0', signed: false, unsigned: true, published: false,
      artifacts: [{ name: '../outside.txt', bytes: outsideBytes.length, sha256: sha256(outsideBytes) }],
      checksumFile: { name: 'SHA256SUMS', sha256: checksumDigest },
      sbom: { name: 'sbom.cdx.json', sha256: '0'.repeat(64) },
      provenance: { name: 'provenance.json', sha256: '0'.repeat(64) },
    }, null, 2)}\n`)
    const result = spawnSync(process.execPath, [verifier, '--dir', bundle], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
    })
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /FAIL\s+manifest artifact set is exact/)
    assert.match(result.stdout, /FAIL\s+artifact \[unsafe manifest filename\]/)
    assert.doesNotMatch(result.stdout, /PASS\s+artifact \[unsafe manifest filename\]/)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('runner scans one recorded external source snapshot and emits independent release-control gates', () => {
  const runner = readFileSync(new URL('./open-source-security.mjs', import.meta.url), 'utf8')
  assert.match(runner, /RAGAM_SECURITY_OUTPUT_DIR/)
  assert.match(runner, /createScanSnapshot\(context, runDir\)/)
  for (const scanner of ['runSemgrep', 'runGitleaks', 'runDependencies', 'runDAST']) {
    assert.match(runner, new RegExp(`${scanner}\\(\\{ context, reportsDir, runDir`))
    assert.match(runner, new RegExp(`${scanner}\\(\\{[^}]*sourceRoot`))
  }
  for (const gate of ['findingReview', 'authz', 'checksums', 'sourceIntegrity']) {
    assert.match(runner, new RegExp(`gates\\.${gate}\\s*=`))
  }
  assert.match(runner, /sha256sum/)
  assert.equal((runner.match(/RAGAM_DAST_PLATFORM:\s*LOCK\.platform/g) ?? []).length, 2, 'Trivy Compose config and ZAP scans must receive the same locked platform')
  assert.match(runner, /writeEvidence\(evidencePath, evidence\)/)
  assert.doesNotMatch(runner, /EVIDENCE_PATH/)
})

test('Semgrep JSON and SARIF retain rule locations but discard source snippets and interpolated messages', () => {
  const normalized = normalizeSemgrepJson({
    version: '1.185.0',
    paths: { scanned: ['/workspace/ragam/services/core/app.mjs'], skipped: [] },
    results: [{
      check_id: 'fixture.command-injection',
      path: '/workspace/ragam/services/core/app.mjs',
      start: { line: 14, col: 3 },
      end: { line: 14, col: 26 },
      extra: {
        severity: 'ERROR',
        message: `unsafe value ${fixtureSecret}`,
        lines: `const password = '${fixtureSecret}'`,
        metadata: { cwe: ['CWE-78'], confidence: 'HIGH', impact: 'HIGH', source: fixtureSecret },
      },
    }],
    errors: [{ path: '/workspace/ragam/services/core/app.mjs', message: fixtureSecret, type: ['PartialParsing'] }],
  }, { basePath: '/workspace/ragam' })
  assert.equal(normalized.results[0].path, 'services/core/app.mjs')
  assert.equal(normalized.results[0].severity, 'HIGH')
  assert.equal(normalized.results[0].message.includes(fixtureSecret), false)
  assert.deepEqual(normalized.results[0].metadata, { cwe: ['CWE-78'], confidence: 'HIGH', impact: 'HIGH' })
  assert.equal(normalized.errors[0].message.includes(fixtureSecret), false)
  assert.equal(JSON.stringify(normalized).includes(fixtureSecret), false)

  const sarif = sanitizeSarif({ unsafe: fixtureSecret }, {
    toolName: 'Semgrep Community Edition', version: '1.185.0', findings: normalized.results,
  })
  assert.equal(sarif.version, '2.1.0')
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, 'services/core/app.mjs')
  assert.equal(JSON.stringify(sarif).includes(fixtureSecret), false)
})

test('Gitleaks machine reports retain affected location and rotation guidance, never secret matches', () => {
  const findings = normalizeGitleaksJson([{
    RuleID: 'fixture-api-token',
    Description: `Fixture token ${fixtureSecret}`,
    File: '/tmp/working-tree/config/local.env',
    StartLine: 7,
    EndLine: 7,
    Secret: fixtureSecret,
    Match: `TOKEN=${fixtureSecret}`,
    Commit: 'a'.repeat(40),
    Fingerprint: 'safe-fingerprint',
  }], { basePath: '/tmp/working-tree' })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].file, 'config/local.env')
  assert.equal(findings[0].startLine, 7)
  assert.match(findings[0].remediation, /revoke and rotate/i)
  assert.equal(JSON.stringify(findings).includes(fixtureSecret), false)
})

test('Trivy JSON projection strips source, secret values and rendered configuration while preserving remediation data', () => {
  const normalized = normalizeTrivyJson({
    SchemaVersion: 2,
    ArtifactName: 'ragam-fixture',
    ArtifactType: 'filesystem',
    Metadata: { unexpectedSecret: fixtureSecret },
    Results: [{
      Target: '/workspace/ragam/apps/web/package-lock.json',
      Class: 'lang-pkgs',
      Type: 'npm',
      Vulnerabilities: [{
        VulnerabilityID: 'CVE-2099-0001', PkgName: 'fixture-package',
        InstalledVersion: '1.0.0', FixedVersion: '1.0.1', Severity: 'HIGH',
        Title: 'Fixture advisory', Description: fixtureSecret,
        PrimaryURL: `https://advisory.example/CVE-2099-0001?api_key=${fixtureSecret}`,
        References: [`https://refs.example/advisory?token=${fixtureSecret}`],
      }],
      Misconfigurations: [{
        ID: 'AVD-TEST-0001', Title: 'Fixture configuration finding', Severity: 'HIGH',
        Message: fixtureSecret, Resolution: fixtureSecret,
        CauseMetadata: { StartLine: 19, Code: { Lines: [{ Content: fixtureSecret }] } },
      }],
      Secrets: [{
        RuleID: 'fixture-token', Category: 'Generic', Severity: 'CRITICAL',
        Title: 'Fixture token detected', Secret: fixtureSecret, Match: fixtureSecret,
        StartLine: 27,
      }],
    }],
  }, { basePath: '/workspace/ragam' })
  const findings = trivyFindings(normalized)
  assert.equal(normalized.Results[0].Target, 'apps/web/package-lock.json')
  assert.equal(findings.length, 3)
  assert.equal(findings[0].installedVersion, '1.0.0')
  assert.equal(findings[0].fixedVersion, '1.0.1')
  assert.equal(normalized.Results[0].Vulnerabilities[0].PrimaryURL, 'https://advisory.example/CVE-2099-0001')
  assert.deepEqual(normalized.Results[0].Vulnerabilities[0].References, ['https://refs.example/advisory'])
  assert.match(findings[0].remediation, /compatibility/i)
  assert.equal(findings[1].line, 19)
  assert.equal(findings[2].line, 27)
  assert.equal(JSON.stringify(normalized).includes(fixtureSecret), false)
  assert.equal(JSON.stringify(findings).includes(fixtureSecret), false)
})

test('ZAP JSON and HTML retain alert location without query values, cookies, or credential-bearing fields', () => {
  const normalized = normalizeZapJson({
    '@version': '2.17.0',
    site: [{
      '@name': `http://scanner:${fixtureSecret}@edge:8080/api/private?access_token=${fixtureSecret}`,
      alerts: [{
        pluginid: '10001', alertRef: '10001', alert: 'Fixture alert', riskcode: '3',
        confidence: 'High', count: '1', cweid: '79', solution: 'Review the affected route.',
        instances: [{
          uri: `http://edge:8080/api/private/${fixtureSecret}?access_token=${fixtureSecret}#fragment`,
          method: 'GET', param: 'q', attack: fixtureSecret, evidence: fixtureSecret,
        }],
        requestBody: fixtureSecret,
      }],
    }],
  })
  const findings = zapFindings(normalized)
  assert.equal(normalized.site[0].name, 'http://edge:8080/api/private')
  assert.equal(findings[0].url, 'http://edge:8080/api/private/[REDACTED]')
  assert.equal(findings[0].severity, 'HIGH')
  assert.equal(JSON.stringify(normalized).includes(fixtureSecret), false)
  assert.equal(JSON.stringify(findings).includes(fixtureSecret), false)

  const html = `<html><body>aetheris_session=${fixtureSecret}; Authorization: Bearer ${fixtureSecret}; api_key="${fixtureSecret}"</body></html>`
  const sanitized = sanitizeZapHtml(html)
  assert.equal(sanitized.includes(fixtureSecret), false)

  const projectedHtml = renderZapHtml({ findings: [{
    severity: 'HIGH', title: `<script>${fixtureSecret}</script>`, url: findings[0].url,
    method: 'GET', parameter: 'q', cweId: '79', confidence: 'High',
    solution: `Rotate ${fixtureSecret}`, reference: `https://example.test/?token=${fixtureSecret}`,
  }], version: '2.17.0', generatedAt: '2026-10-17T00:00:00.000Z' })
  assert.equal(projectedHtml.includes(fixtureSecret), false)
  assert.equal(projectedHtml.includes('<script>'), false)
  assert.match(projectedHtml, /sanitized scan report/i)
})

test('DAST active scan is blocked on every nonzero ZAP exit even when sanitized reports exist', () => {
  assert.deepEqual(zapActiveScanOutcome(0, true), { complete: true, reason: null })
  for (const exitCode of [1, 2, 3, null]) {
    const outcome = zapActiveScanOutcome(exitCode, true)
    assert.equal(outcome.complete, false, `exit code ${exitCode} must not qualify the active scan`)
    assert.match(outcome.reason, /nonzero exit code/)
    assert.match(outcome.reason, /reports and findings are retained/)
  }
  assert.deepEqual(zapActiveScanOutcome(0, false), {
    complete: false,
    reason: 'ZAP active scan did not produce validated sanitized reports.',
  })
})

test('report paths never expose absolute paths outside the scanned repository', () => {
  assert.equal(safeRelativePath('/workspace/ragam/apps/web/App.jsx', '/workspace/ragam'), 'apps/web/App.jsx')
  assert.equal(safeRelativePath('/home/private/.env', '/workspace/ragam'), '[outside-scope]')
  assert.equal(safeRelativePath('../../outside/token.txt', '/workspace/ragam'), '[outside-scope]')
})

test('release gates fail closed on missing, dirty, incomplete, unvalidated, active-scan-missing, and high findings', () => {
  assert.equal(passingEvidence().status, 'PASS', 'clean-checkout gate regeneration fixture is eligible only with validated scanner evidence')
  assert.equal(gateFromScanner({ executed: false, complete: false, validated: false, cleanCheckout: true }).status, 'BLOCKED')
  assert.equal(gateFromScanner({ executed: false, complete: false, validated: false, cleanCheckout: true, blocked: true }).status, 'BLOCKED')
  assert.equal(gateFromScanner({ executed: false, complete: false, validated: false, cleanCheckout: true, notTested: true }).status, 'NOT TESTED')
  assert.equal(passingEvidence({ cleanCheckout: false }).status, 'FAIL')
  assert.equal(passingEvidence({ complete: false }).status, 'FAIL')
  assert.equal(passingEvidence({ validated: false }).status, 'FAIL')
  assert.equal(passingEvidence({ activeScanRequired: true, activeScanPerformed: false }).status, 'FAIL')
  assert.equal(passingEvidence({ findings: [{ severity: 'CRITICAL' }] }).status, 'FAIL')
  assert.equal(passingEvidence({ findings: [{ severity: 'HIGH' }] }).status, 'FAIL')
  assert.equal(passingEvidence({ findings: [{ severity: 'MEDIUM' }] }).status, 'PASS')
  assert.equal(passingEvidence({ findings: [{ severity: 'LOW' }], blockOnAnyFinding: true }).status, 'FAIL')
})

test('finding summaries and report checksums are deterministic for sanitized evidence', () => {
  const findings = [{ severity: 'HIGH' }, { severity: 'low' }, { severity: 'unexpected' }]
  assert.deepEqual(summarizeFindings(findings), {
    total: 3,
    bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 1, INFO: 0, UNKNOWN: 1 },
  })
  assert.match(sha256('safe fixture'), /^[a-f0-9]{64}$/)
})
