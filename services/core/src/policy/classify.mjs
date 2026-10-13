// Data classification and secret redaction.
//
// Used before any request leaves the machine: classify the payload, then minimise
// it by redacting credentials. Directive §5 requires that unnecessary secrets are
// redacted and transmitted data minimised.

import { DATA_CLASSES } from './egress.mjs'

// Deliberately conservative patterns. Each carries the label used in audit events
// so an operator can see *what kind* of thing was removed without seeing it.
const SECRET_PATTERNS = [
  // Order matters within this list. Patterns are applied in sequence and the first
  // match consumes the text, so a general pattern placed before a specific one makes
  // the specific one unreachable. `sk-ant-...` also satisfies `sk-...`, so the
  // Anthropic pattern has to come first or every Anthropic key is reported as an
  // OpenAI key. The credential was still redacted either way; what was wrong was the
  // name an operator reads in the audit trail.
  { name: 'anthropic_style_key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'openai_style_key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'aws_access_key_id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'stripe_key', re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'private_key_block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: 'bearer_header', re: /\bauthorization\s*[:=]\s*bearer\s+\S+/gi },
  { name: 'generic_assignment_secret', re: /\b(?:api[_-]?key|secret|passwd|password|token)\b\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/gi },
  // Environment-variable style credentials, as they appear in pasted CI logs and
  // .env dumps. A word boundary cannot be used here: in AWS_SECRET_ACCESS_KEY the
  // '_' is a word character, so \bsecret\b never matches. The whole identifier has
  // to be matched instead.
  {
    name: 'env_style_secret',
    re: /(?:^|[^A-Za-z0-9_])([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[:=]\s*['"]?[^\s'";,}]{8,}/g,
  },
  { name: 'azure_account_key', re: /\bAccountKey=[A-Za-z0-9+\/=]{20,}/gi },
  { name: 'npm_token', re: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { name: 'connection_string', re: /\b(?:postgres|postgresql|mysql|mongodb|redis|amqp):\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/gi },
  // Credentials embedded in an ordinary http(s) URL, not only a database one.
  { name: 'url_basic_auth', re: /\bhttps?:\/\/[^\s/:@'"]+:[^\s@'"]+@[^\s'"/]+/gi },
]

// Findings serious enough that the payload is treated as restricted rather than
// merely confidential: this is live credential material, not a document that
// happens to mention a secret.
const RESTRICTED_FINDINGS = new Set(['private_key_block', 'aws_access_key_id', 'env_style_secret', 'azure_account_key', 'url_basic_auth'])

// Markers that indicate proprietary engineering material.
const CONFIDENTIAL_MARKERS = [
  'confidential', 'proprietary', 'trade secret', 'internal only', 'do not distribute',
  'nda', 'salary', 'ssn', 'social security',
]

/**
 * Redact secrets from a string. Returns the redacted text plus the list of
 * finding *names* only — never the matched values, so the audit trail cannot
 * become a secret leak itself.
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return { text: text ?? '', findings: [] }
  const findings = []
  let out = text
  for (const { name, re } of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      findings.push(name)
      return `[REDACTED:${name}]`
    })
  }
  return { text: out, findings: [...new Set(findings)] }
}

/** Recursively redact every string in a JSON-ish structure. */
export function redactDeep(value, depth = 0) {
  if (depth > 12) return value
  const findings = []
  const walk = (node) => {
    if (typeof node === 'string') {
      const r = redactSecrets(node)
      findings.push(...r.findings)
      return r.text
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(node)) out[k] = walk(v)
      return out
    }
    return node
  }
  return { value: walk(value), findings: [...new Set(findings)] }
}

/**
 * Classify a payload. The highest-severity signal wins.
 * Explicit classification always overrides inference.
 */
export function classifyText(text, explicit = null) {
  if (explicit) {
    if (!Object.values(DATA_CLASSES).includes(explicit)) {
      throw new TypeError(`unknown data class: ${explicit}`)
    }
    return { dataClass: explicit, reason: 'explicitly declared', signals: [] }
  }
  const lower = String(text ?? '').toLowerCase()
  const signals = []

  const { findings } = redactSecrets(String(text ?? ''))
  if (findings.length) signals.push(`secrets:${findings.join(',')}`)

  for (const marker of CONFIDENTIAL_MARKERS) {
    if (lower.includes(marker)) signals.push(`marker:${marker}`)
  }

  if (findings.some((finding) => RESTRICTED_FINDINGS.has(finding))) {
    return { dataClass: DATA_CLASSES.RESTRICTED, reason: 'credential material present', signals }
  }
  if (findings.length) {
    return { dataClass: DATA_CLASSES.CONFIDENTIAL, reason: 'secret-like material present', signals }
  }
  if (signals.length) {
    return { dataClass: DATA_CLASSES.CONFIDENTIAL, reason: 'confidentiality marker present', signals }
  }
  // Source code and repository material is company-private by default (directive §5).
  if (looksLikeSourceCode(String(text ?? ''))) {
    return { dataClass: DATA_CLASSES.INTERNAL, reason: 'source-code-like content defaults to internal', signals }
  }
  return { dataClass: DATA_CLASSES.PUBLIC, reason: 'no sensitive signals detected', signals }
}

const CODE_HINTS = [
  /^\s*(import|export|from)\s+[\w'".\/-]+/m,
  /^\s*(def|class|function|const|let|var)\s+\w+/m,
  /^\s*(public|private|protected)\s+(static\s+)?[\w<>\[\]]+\s+\w+\s*\(/m,
  /[{};]\s*$/m,
]

export function looksLikeSourceCode(text) {
  if (!text) return false
  let hits = 0
  for (const re of CODE_HINTS) if (re.test(text)) hits += 1
  return hits >= 2
}
