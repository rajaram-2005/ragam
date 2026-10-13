// Regenerate tests/fixtures/redaction-parity.json from the Node implementation.
//
// fabric/lm/privacy.py re-implements secret redaction for the distillation corpus
// builder, which is Python and cannot import the Node classifier. A second
// implementation of a security control is a liability unless it is pinned, so this
// fixture records exactly what the Node implementation finds on a probe set, and
// tests/test_lm_privacy.py asserts the Python side agrees.
//
//   node scripts/generate-redaction-parity-fixture.mjs > tests/fixtures/redaction-parity.json
//
// The coverage check below is the point of the exercise. A probe set that happens to
// trip 9 of the 16 patterns would let the Python port quietly omit the other 7 while
// the parity test still passed -- the "passes by omission" failure already found once
// in this project. So generation FAILS if any pattern is not exercised by at least one
// probe, which means a pattern added to classify.mjs cannot go unported in silence.
import { readFileSync } from 'node:fs'
import { redactSecrets } from '../../core/src/policy/classify.mjs'

// Every entry is either a known-bad string (the comment names the pattern it must
// trip) or a known-clean one (which must trip nothing -- over-redaction is also a
// defect, it destroys the training signal the corpus exists to carry).
const PROBES = [
  // --- one per pattern, so coverage is complete ---------------------------------
  ['openai_style_key', 'export const KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123"'],
  ['anthropic_style_key', 'ANTHROPIC_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwx'],
  ['github_token', 'git remote set-url origin https://ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@github.com'],
  ['aws_access_key_id', 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE'],
  ['google_api_key', 'maps key AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'],
  ['slack_token', 'slack bot token xoxb-1234567890-abcdefghijkl'],
  ['stripe_key', 'const stripe = require("stripe")("sk_live_51H8xYzAbCdEfGhIjKlMn")'],
  ['private_key_block', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'],
  ['jwt', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
  ['bearer_header', 'authorization = bearer abcdefghijklmnop'],
  ['generic_assignment_secret', 'password: "hunter2correcthorsebattery"'],
  ['env_style_secret', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  ['azure_account_key', 'AccountKey=abcdefghijklmnopqrstuvwxyz1234567890ABCD=='],
  ['npm_token', '//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['connection_string', 'postgres://admin:s3cr3tpassword@db.internal:5432/production'],
  ['url_basic_auth', 'https://user:letmeinplease@internal.example.com/api/v1'],
  // --- known-clean: must trip nothing -------------------------------------------
  ['', 'The contactor must open within 250 milliseconds when any cell exceeds 68 degrees Celsius.'],
  ['', 'This document describes the retention policy and how the audit ledger is queried.'],
  ['', 'password policy: at least twelve characters, rotated every ninety days'],
  ['', 'the token bucket refills at eight requests per second'],
  ['', 'See services/core/src/policy/egress.mjs for the allowlist implementation.'],
  ['', 'A short key like sk-abc is not a credential and must not be redacted.'],
  ['', 'The function returns { status: 200, body: null } on success.'],
]

const results = PROBES.map(([expected, text]) => {
  const { text: redacted, findings } = redactSecrets(text)
  return { expectedPattern: expected || null, text, findings, redacted, changed: redacted !== text }
})

// Coverage: every pattern in classify.mjs must be exercised by some probe.
const source = readFileSync(new URL('../../core/src/policy/classify.mjs', import.meta.url), 'utf8')
const block = source.slice(source.indexOf('const SECRET_PATTERNS'), source.indexOf('export function redactSecrets'))
const declared = [...block.matchAll(/\{\s*name:\s*'([a-z_]+)'/g)].map((m) => m[1])
const exercised = new Set(results.flatMap((r) => r.findings))
const unexercised = declared.filter((name) => !exercised.has(name))
if (unexercised.length) {
  console.error(
    `FIXTURE IS INCOMPLETE: ${unexercised.length} pattern(s) declared but never exercised by any probe: ${unexercised.join(', ')}`,
  )
  process.exit(1)
}
const undeclared = [...exercised].filter((name) => !declared.includes(name))
if (undeclared.length) {
  console.error(`a probe tripped pattern(s) that are not declared in classify.mjs: ${undeclared.join(', ')}`)
  process.exit(1)
}

const cleanLabelled = results.filter((r) => !r.expectedPattern)
const overRedacted = cleanLabelled.filter((r) => r.findings.length > 0)
if (overRedacted.length) {
  console.error(
    `A probe marked clean was redacted: ${JSON.stringify(overRedacted.map((r) => ({ text: r.text, findings: r.findings })), null, 2)}`,
  )
  process.exit(1)
}

const mismatch = results.filter((r) => r.expectedPattern && !r.findings.includes(r.expectedPattern))
if (mismatch.length) {
  console.error(
    `A probe did not trip the pattern it names: ${JSON.stringify(mismatch.map((r) => ({ expected: r.expectedPattern, found: r.findings })), null, 2)}`,
  )
  process.exit(1)
}

console.log(JSON.stringify({
  note: 'Generated by scripts/generate-redaction-parity-fixture.mjs from services/core/src/policy/classify.mjs. Do not edit by hand.',
  generatedFrom: 'services/core/src/policy/classify.mjs',
  declaredPatterns: declared,
  probes: results,
}, null, 2))
