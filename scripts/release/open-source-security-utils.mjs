// Sanitizers and policy helpers shared by the OSS security runner and its tests.
// Scanner-native reports are reduced before they are persisted: source snippets,
// request/response bodies, credentials and secret matches are never evidence.
import { createHash } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'

export const OSS_SECURITY_SCHEMA = 'ragam-open-source-security-qualification/1'
export const TRIVY_PIP_REQUIREMENTS_LOCK_PATTERN = String.raw`pip:requirements\.lock`

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function posixPath(value) {
  return String(value ?? '').split(sep).join('/')
}

export function safeRelativePath(value, base = process.cwd()) {
  const text = String(value ?? '')
  if (!text) return ''
  const normalized = text.replaceAll('\\', '/')
  const isWindowsAbsolute = /^[A-Za-z]:\//.test(normalized)
  if (isAbsolute(text) || isWindowsAbsolute) {
    if (isWindowsAbsolute && process.platform !== 'win32') return '[outside-scope]'
    const candidate = relative(base, text)
    if (!candidate || candidate === '.') return '.'
    if (candidate === '..' || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) return '[outside-scope]'
    return posixPath(candidate).replace(/^\.\//, '')
  }
  if (normalized.split('/').includes('..')) return '[outside-scope]'
  return normalized.replace(/^\.\//, '')
}

function metadataSubset(metadata = {}) {
  const allowed = ['category', 'cwe', 'owasp', 'technology', 'confidence', 'impact', 'likelihood', 'subcategory', 'asvs']
  return Object.fromEntries(allowed.filter((key) => metadata[key] !== undefined).map((key) => [key, metadata[key]]))
}

function normalizedSemgrepSeverity(value) {
  const severity = String(value ?? 'INFO').toUpperCase()
  if (severity === 'ERROR' || severity === 'BLOCKER') return 'HIGH'
  if (severity === 'WARNING') return 'MEDIUM'
  return 'LOW'
}

export function normalizeSemgrepJson(raw, { basePath = process.cwd() } = {}) {
  const results = (Array.isArray(raw?.results) ? raw.results : []).map((result) => {
    const extra = result.extra ?? {}
    const metadata = metadataSubset(extra.metadata ?? {})
    const path = safeRelativePath(result.path, basePath)
    const line = Number.isInteger(result.start?.line) ? result.start.line : null
    const endLine = Number.isInteger(result.end?.line) ? result.end.line : line
    const ruleId = String(result.check_id ?? 'unknown')
    const id = sha256(`${ruleId}\0${path}\0${line ?? ''}\0${result.start?.col ?? ''}`).slice(0, 24)
    return {
      id,
      check_id: ruleId,
      path,
      start: { line, column: Number.isInteger(result.start?.col) ? result.start.col : null },
      end: { line: endLine, column: Number.isInteger(result.end?.col) ? result.end.col : null },
      severity: normalizedSemgrepSeverity(extra.severity),
      scannerSeverity: String(extra.severity ?? 'INFO').toUpperCase(),
      confidence: String(metadata.confidence ?? 'UNKNOWN').toUpperCase(),
      impact: String(metadata.impact ?? 'UNKNOWN').toUpperCase(),
      likelihood: String(metadata.likelihood ?? 'UNKNOWN').toUpperCase(),
      metadata,
      // The rule's original message may interpolate source values; keep only a safe marker.
      message: 'Semgrep rule matched; inspect the sanitized finding and source location.',
      reviewState: 'UNREVIEWED',
    }
  })
  const errors = (Array.isArray(raw?.errors) ? raw.errors : []).map((error) => ({
    code: Number.isInteger(error.code) ? error.code : null,
    type: Array.isArray(error.type) ? String(error.type[0]) : String(error.type ?? 'scanner_error'),
    path: error.path ? safeRelativePath(error.path, basePath) : null,
    ruleId: error.rule_id ? String(error.rule_id) : null,
    // Semgrep parser diagnostics can echo shell/source text; do not retain them verbatim.
    message: 'Semgrep diagnostic; raw source text removed.',
  }))
  const scanned = Array.isArray(raw?.paths?.scanned) ? raw.paths.scanned.map((path) => safeRelativePath(path, basePath)) : []
  const skipped = Array.isArray(raw?.paths?.skipped) ? raw.paths.skipped.map((entry) => ({
    path: safeRelativePath(entry.path, basePath), reason: String(entry.reason ?? 'not_scanned'),
  })) : []
  return {
    version: String(raw?.version ?? ''),
    results,
    errors,
    paths: { scanned, skipped },
  }
}

function sarifSeverity(value) {
  const raw = String(value ?? '').toUpperCase()
  if (raw === 'ERROR' || raw === 'BLOCKER' || raw === 'HIGH' || raw === 'CRITICAL') return 'error'
  if (raw === 'WARNING' || raw === 'MEDIUM') return 'warning'
  return 'note'
}

function makeSarif({ toolName, version, findings }) {
  const rules = new Map()
  const results = findings.map((finding) => {
    const ruleId = String(finding.check_id ?? finding.ruleId ?? finding.id ?? 'unknown')
    if (!rules.has(ruleId)) {
      rules.set(ruleId, {
        id: ruleId,
        name: ruleId,
        shortDescription: { text: `${toolName} rule` },
        properties: { tags: ['security'] },
      })
    }
    const path = posixPath(finding.path ?? finding.file ?? finding.location ?? '')
    const line = Number.isInteger(finding.start?.line) ? finding.start.line
      : Number.isInteger(finding.line) ? finding.line
        : Number.isInteger(finding.startLine) ? finding.startLine : 1
    const endLine = Number.isInteger(finding.end?.line) ? finding.end.line
      : Number.isInteger(finding.endLine) ? finding.endLine : line
    const level = sarifSeverity(finding.scannerSeverity ?? finding.severity ?? finding.risk)
    return {
      ruleId,
      ruleIndex: [...rules.keys()].indexOf(ruleId),
      level,
      message: { text: `${toolName} finding retained; source snippets and secret values are omitted.` },
      locations: [{ physicalLocation: {
        artifactLocation: { uri: path },
        region: { startLine: line, endLine: Math.max(line, endLine) },
      } }],
      properties: {
        severity: String(finding.severity ?? finding.risk ?? 'UNKNOWN'),
        confidence: String(finding.confidence ?? 'UNKNOWN'),
        reviewState: String(finding.reviewState ?? 'UNREVIEWED'),
        metadata: metadataSubset(finding.metadata ?? {}),
      },
    }
  })
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: toolName, version: String(version ?? ''), rules: [...rules.values()] } },
      results,
    }],
  }
}

export function sanitizeSarif(_raw, { toolName, version, findings }) {
  // Rebuild a minimal SARIF projection from parsed scanner findings rather than
  // retaining arbitrary SARIF properties which may embed code or a secret value.
  return makeSarif({ toolName, version, findings })
}

function gitleaksRelativePath(file, basePath) {
  return safeRelativePath(String(file ?? ''), basePath || process.cwd())
}

export function normalizeGitleaksJson(raw, { basePath = '' } = {}) {
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.findings) ? raw.findings : []
  return rows.map((entry) => ({
    id: sha256(`${entry.RuleID ?? ''}\0${entry.File ?? ''}\0${entry.StartLine ?? ''}\0${entry.Commit ?? ''}`).slice(0, 24),
    ruleId: String(entry.RuleID ?? 'unknown'),
    description: 'Potential secret detected by Gitleaks; value withheld.',
    file: gitleaksRelativePath(entry.File, basePath),
    startLine: Number.isInteger(entry.StartLine) ? entry.StartLine : null,
    endLine: Number.isInteger(entry.EndLine) ? entry.EndLine : null,
    commit: entry.Commit ? String(entry.Commit) : null,
    fingerprint: entry.Fingerprint ? String(entry.Fingerprint) : null,
    severity: 'HIGH',
    reviewState: 'UNREVIEWED',
    remediation: 'Review the affected location without copying the secret into logs; revoke and rotate any exposed credential, then assess related access and history retention.',
  }))
}

const SECRET_VALUE_KEYS = /^(?:secret|match|code|sourcecode|linecontent|snippet|evidence|requestbody|responsebody|requestheader|responseheader|authorization|cookie|password|token|privatekey|rawvalue|payload)$/i
const OMITTED_VALUE = '[REDACTED]'

function redactSensitiveText(value, maxLength = 4000) {
  return String(value ?? '').slice(0, maxLength)
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [REDACTED]')
    .replace(/\b((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|secret|authorization|cookie|private[_ -]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^,\s;<>&]+)/gi, '$1[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[REDACTED]')
}

export function stripSensitiveFields(value) {
  if (Array.isArray(value)) return value.map(stripSensitiveFields)
  if (!value || typeof value !== 'object') return value
  const clean = {}
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_VALUE_KEYS.test(key)) continue
    clean[key] = stripSensitiveFields(child)
  }
  return clean
}

function normalizeTrivySecret(secret) {
  return {
    RuleID: String(secret.RuleID ?? secret.ruleId ?? 'unknown'),
    Category: secret.Category ?? secret.category ?? null,
    Severity: String(secret.Severity ?? secret.severity ?? 'UNKNOWN').toUpperCase(),
    Title: String(secret.Title ?? secret.title ?? 'Potential secret detected'),
    StartLine: Number.isInteger(secret.StartLine) ? secret.StartLine : Number.isInteger(secret.startLine) ? secret.startLine : null,
    EndLine: Number.isInteger(secret.EndLine) ? secret.EndLine : Number.isInteger(secret.endLine) ? secret.endLine : null,
    Remediation: 'Review the affected location without copying the value into logs; revoke and rotate any exposed credential, then assess related access and history retention.',
  }
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value ?? ''))
    if (!['http:', 'https:'].includes(parsed.protocol)) return ''
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    const pathname = parsed.pathname.split('/').map((part) => /^[A-Za-z0-9_-]{24,}$/.test(part) ? '[REDACTED]' : part).join('/')
    return `${parsed.origin}${pathname}`.slice(0, 500)
  } catch { return '' }
}

function trivyReferenceList(value) {
  if (!Array.isArray(value)) return []
  return value.map(safeHttpUrl).filter(Boolean)
}

export function normalizeTrivyJson(raw, { basePath = process.cwd() } = {}) {
  const results = (Array.isArray(raw?.Results) ? raw.Results : []).map((result) => ({
    Target: safeRelativePath(result.Target ?? result.target ?? '', basePath),
    Class: String(result.Class ?? result.class ?? ''),
    Type: String(result.Type ?? result.type ?? ''),
    Vulnerabilities: (Array.isArray(result.Vulnerabilities) ? result.Vulnerabilities : []).map((vuln) => ({
      VulnerabilityID: String(vuln.VulnerabilityID ?? vuln.vulnerabilityID ?? 'unknown'),
      PkgName: String(vuln.PkgName ?? vuln.pkgName ?? ''),
      PkgIdentifier: typeof vuln.PkgIdentifier?.PURL === 'string' ? { PURL: vuln.PkgIdentifier.PURL } : undefined,
      InstalledVersion: String(vuln.InstalledVersion ?? vuln.installedVersion ?? ''),
      FixedVersion: String(vuln.FixedVersion ?? vuln.fixedVersion ?? ''),
      Severity: String(vuln.Severity ?? vuln.severity ?? 'UNKNOWN').toUpperCase(),
      Title: String(vuln.Title ?? vuln.title ?? vuln.VulnerabilityID ?? 'Known vulnerability'),
      PrimaryURL: safeHttpUrl(vuln.PrimaryURL),
      References: trivyReferenceList(vuln.References),
    })),
    Misconfigurations: (Array.isArray(result.Misconfigurations) ? result.Misconfigurations : []).map((finding) => ({
      Type: String(finding.Type ?? ''),
      ID: String(finding.ID ?? finding.AVDID ?? 'unknown'),
      AVDID: String(finding.AVDID ?? ''),
      Title: String(finding.Title ?? 'Configuration finding'),
      Severity: String(finding.Severity ?? 'UNKNOWN').toUpperCase(),
      References: trivyReferenceList(finding.References),
      CauseMetadata: {
        StartLine: Number.isInteger(finding.CauseMetadata?.StartLine) ? finding.CauseMetadata.StartLine : null,
      },
      Message: 'Trivy misconfiguration finding; source text and rendered configuration values removed.',
      Resolution: 'Review the affected configuration and apply a compatible remediation; no automatic fix was applied.',
    })),
    Secrets: (Array.isArray(result.Secrets) ? result.Secrets : []).map(normalizeTrivySecret),
  }))
  return {
    SchemaVersion: Number.isInteger(raw?.SchemaVersion) ? raw.SchemaVersion : null,
    ArtifactName: safeRelativePath(raw?.ArtifactName ?? '', basePath),
    ArtifactType: String(raw?.ArtifactType ?? ''),
    Results: results,
  }
}

function severityFromTrivy(value) {
  const severity = String(value ?? 'UNKNOWN').toUpperCase()
  return ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'].includes(severity) ? severity : 'UNKNOWN'
}

export function trivyFindings(normalized) {
  const findings = []
  for (const result of normalized?.Results ?? []) {
    const path = posixPath(result.Target ?? result.target ?? '')
    for (const vuln of result.Vulnerabilities ?? []) {
      findings.push({
        id: sha256(`${vuln.VulnerabilityID ?? ''}\0${vuln.PkgName ?? ''}\0${path}`).slice(0, 24),
        ruleId: String(vuln.VulnerabilityID ?? 'vulnerability'),
        path,
        package: String(vuln.PkgName ?? ''),
        installedVersion: String(vuln.InstalledVersion ?? ''),
        fixedVersion: String(vuln.FixedVersion ?? ''),
        severity: severityFromTrivy(vuln.Severity),
        title: String(vuln.Title ?? vuln.VulnerabilityID ?? 'Known vulnerability'),
        primaryUrl: String(vuln.PrimaryURL ?? ''),
        references: trivyReferenceList(vuln.References),
        remediation: vuln.FixedVersion
          ? `Test compatibility and upgrade ${String(vuln.PkgName ?? 'the affected package')} to ${String(vuln.FixedVersion)}; no automatic upgrade was applied.`
          : 'Review the vendor advisory and plan a compatibility-tested upgrade; Trivy reports no fixed version.',
        reviewState: 'UNREVIEWED',
      })
    }
    for (const misconfig of result.Misconfigurations ?? []) {
      findings.push({
        id: sha256(`${misconfig.ID ?? ''}\0${path}\0${misconfig.CauseMetadata?.StartLine ?? ''}`).slice(0, 24),
        ruleId: String(misconfig.ID ?? 'misconfiguration'),
        path,
        severity: severityFromTrivy(misconfig.Severity),
        title: String(misconfig.Title ?? 'Configuration finding'),
        remediation: String(misconfig.Resolution ?? ''),
        line: Number.isInteger(misconfig.CauseMetadata?.StartLine) ? misconfig.CauseMetadata.StartLine : null,
        reviewState: 'UNREVIEWED',
      })
    }
    for (const secret of result.Secrets ?? []) {
      findings.push({
        id: sha256(`${secret.RuleID ?? ''}\0${path}\0${secret.StartLine ?? ''}`).slice(0, 24),
        ruleId: String(secret.RuleID ?? 'secret'),
        path,
        severity: 'HIGH',
        title: String(secret.Title ?? 'Potential secret detected'),
        line: Number.isInteger(secret.StartLine) ? secret.StartLine : null,
        reviewState: 'UNREVIEWED',
        remediation: secret.Remediation,
      })
    }
  }
  return findings
}

function safeZapUri(value) {
  const text = String(value ?? '').slice(0, 8192)
  try {
    const parsed = new URL(text)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    const pathname = parsed.pathname.split('/').map((part) => {
      if (/^[A-Fa-f0-9]{8}-[A-Fa-f0-9-]{27,}$/.test(part) || /^[A-Za-z0-9_-]{16,}$/.test(part)) return '[REDACTED]'
      return part
    }).join('/')
    return `${parsed.protocol}//${parsed.host}${pathname}`.slice(0, 2048)
  } catch {
    return '[unparseable-uri]'
  }
}

function zapRisk(code) {
  const raw = String(code ?? '').trim()
  if (raw === '3') return 'HIGH'
  if (raw === '2') return 'MEDIUM'
  if (raw === '1') return 'LOW'
  if (raw === '0') return 'INFO'
  return 'UNKNOWN'
}

export function zapActiveScanOutcome(exitCode, reportsValidated) {
  if (!reportsValidated) {
    return { complete: false, reason: 'ZAP active scan did not produce validated sanitized reports.' }
  }
  if (exitCode !== 0) {
    const code = Number.isInteger(exitCode) ? String(exitCode) : 'unknown'
    return { complete: false, reason: `ZAP active scan returned nonzero exit code ${code}; sanitized reports and findings are retained, but DAST qualification is blocked.` }
  }
  return { complete: true, reason: null }
}

export function normalizeZapJson(raw) {
  const sites = Array.isArray(raw?.site) ? raw.site : []
  const safeSites = sites.map((site) => ({
    name: safeZapUri(site['@name'] ?? site.name ?? ''),
    alerts: (Array.isArray(site.alerts) ? site.alerts : []).map((alert) => ({
      pluginId: String(alert.pluginid ?? alert.pluginId ?? ''),
      alertRef: String(alert.alertRef ?? ''),
      name: redactSensitiveText(alert.alert ?? alert.name ?? 'ZAP alert', 1000),
      riskCode: String(alert.riskcode ?? ''),
      risk: zapRisk(alert.riskcode),
      confidence: String(alert.confidence ?? '').slice(0, 80),
      count: Number.parseInt(alert.count ?? '0', 10) || (Array.isArray(alert.instances) ? alert.instances.length : 0),
      cweId: String(alert.cweid ?? ''),
      wascId: String(alert.wascid ?? ''),
      solution: redactSensitiveText(alert.solution ?? '', 4000),
      reference: redactSensitiveText(alert.reference ?? '', 4000),
      instances: (Array.isArray(alert.instances) ? alert.instances : []).map((instance) => ({
        uri: safeZapUri(instance.uri),
        method: /^[A-Z]{3,10}$/i.test(String(instance.method ?? '')) ? String(instance.method).toUpperCase() : 'UNKNOWN',
        parameter: /^[A-Za-z0-9_.:[\]-]{1,128}$/.test(String(instance.param ?? '')) ? String(instance.param) : '[OMITTED]',
      })),
      reviewState: 'UNREVIEWED',
    })),
  }))
  return { '@version': String(raw?.['@version'] ?? ''), site: safeSites }
}

export function zapFindings(normalized) {
  const findings = []
  for (const site of normalized?.site ?? []) {
    for (const alert of site.alerts ?? []) {
      for (const instance of alert.instances?.length ? alert.instances : [{ uri: site.name, method: '', parameter: '' }]) {
        findings.push({
          id: sha256(`${alert.pluginId}\0${instance.uri}\0${instance.method}\0${instance.parameter}`).slice(0, 24),
          ruleId: alert.alertRef || alert.pluginId || alert.name,
          title: alert.name,
          url: instance.uri,
          method: instance.method,
          parameter: instance.parameter,
          severity: alert.risk,
          confidence: alert.confidence,
          cweId: alert.cweId,
          solution: alert.solution,
          reference: alert.reference,
          reviewState: 'UNREVIEWED',
        })
      }
    }
  }
  return findings
}

function escapeHtml(value) {
  return redactSensitiveText(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char])
}

export function renderZapHtml({ findings = [], version = '', generatedAt = '' } = {}) {
  const rows = findings.map((finding) => `<tr><td>${escapeHtml(finding.severity)}</td><td>${escapeHtml(finding.title)}</td><td>${escapeHtml(finding.url)}</td><td>${escapeHtml(finding.method)}</td><td>${escapeHtml(finding.parameter)}</td><td>${escapeHtml(finding.cweId)}</td><td>${escapeHtml(finding.confidence)}</td><td>${escapeHtml(finding.solution)}</td><td>${escapeHtml(finding.reference)}</td></tr>`).join('')
  const content = rows || '<tr><td colspan="9">No alerts were reported by this scan.</td></tr>'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OWASP ZAP sanitized scan report</title><style>body{font:14px system-ui,sans-serif;margin:2rem;color:#17212b}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd3da;padding:.5rem;text-align:left;vertical-align:top}th{background:#edf1f5}td{overflow-wrap:anywhere}</style></head><body><h1>OWASP ZAP sanitized scan report</h1><p>Scanner version: ${escapeHtml(version)}</p><p>Generated: ${escapeHtml(generatedAt)}</p><p>Only sanitized alert metadata and request locations are included. Request/response bodies, headers, cookies, attack values, and evidence are omitted.</p><table><thead><tr><th>Risk</th><th>Alert</th><th>Location</th><th>Method</th><th>Parameter</th><th>CWE</th><th>Confidence</th><th>Solution</th><th>Reference</th></tr></thead><tbody>${content}</tbody></table></body></html>`
}

export function sanitizeZapHtml(html) {
  return redactSensitiveText(String(html ?? ''), 64 * 1024 * 1024)
    .replace(/(aetheris_session=)[^;\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|proxy-authorization)(?:&nbsp;|\s|:|&colon;)+(?:bearer|basic)\s+)[^<\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|proxy-authorization)(?:&nbsp;|\s|:|&colon;)+)[^<\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_ -]?key|password|secret|token|access[_ -]?token)(?:&quot;|["']|:|=|\s)+)[^<\s"']{8,}/gi, '$1[REDACTED]')
}

export function summarizeFindings(findings = []) {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0, UNKNOWN: 0 }
  for (const finding of findings) {
    const severity = String(finding.severity ?? 'UNKNOWN').toUpperCase()
    counts[counts[severity] === undefined ? 'UNKNOWN' : severity] += 1
  }
  return { total: findings.length, bySeverity: counts }
}

export function gateFromScanner({ executed, complete, validated, cleanCheckout, blocked = false, notTested = false, executionFailed = false, activeScanRequired = false, activeScanPerformed = false, findings = [], blockOnAnyFinding = false }) {
  if (notTested) return { status: 'NOT TESTED', reason: 'No valid scanner execution was requested for this gate.' }
  if (blocked) return { status: 'BLOCKED', reason: 'A required scanner prerequisite is unavailable; no pass may be inferred.' }
  if (executionFailed || (executed && !complete)) return { status: 'FAIL', reason: 'A scanner was attempted but did not complete successfully.' }
  if (!executed) return { status: 'BLOCKED', reason: 'Scanner did not execute; no evidence may be inferred.' }
  if (!validated) return { status: 'FAIL', reason: 'Scanner reports or their independent checksums failed validation.' }
  if (!cleanCheckout) return { status: 'FAIL', reason: 'Source integrity failed: the scanned working tree was dirty or did not match an exact immutable commit.' }
  if (activeScanRequired && !activeScanPerformed) return { status: 'FAIL', reason: 'A controlled active scan was not completed; passive-only evidence is insufficient.' }
  const counts = summarizeFindings(findings).bySeverity
  if (blockOnAnyFinding && findings.length > 0) return { status: 'FAIL', reason: 'Potential secret finding requires review and, if confirmed, revocation/rotation.' }
  if (counts.CRITICAL + counts.HIGH > 0) return { status: 'FAIL', reason: 'Unreviewed critical/high scanner findings require confirmation or remediation; no findings are suppressed.' }
  return { status: 'PASS', reason: 'Required scanner execution completed on an exact clean commit; reports and checksums validated; no unreviewed critical/high findings.' }
}
