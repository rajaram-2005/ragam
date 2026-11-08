#!/usr/bin/env node
// Reproducible security and operational checks for the release gate.
//
//   node scripts/release/security-scan.mjs --out docs/release/evidence/security-scan.json
//
// This is a repository-level scan, not a claim of a full commercial SAST
// product. It covers: tracked-secret exposure, static syntax across every JS
// module, deployment binding defaults, and the privacy invariants of the
// telemetry module. Dependency advisories (npm audit / Python advisory audit)
// and the authenticated authorization/input-validation suites are run as
// separate recorded commands because they need installed dependencies.

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { REPO_ROOT, atRoot, writeJson } from './lib.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const out = atRoot(flag('out', 'docs/release/evidence/security-scan.json'))
const checks = []
const add = (id, ok, detail) => checks.push({ id, status: ok ? 'PASS' : 'FAIL', detail })

function tracked() {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return result.stdout.split('\0').filter(Boolean)
}
const files = tracked()

// 1. Tracked secrets and model payloads.
const forbiddenNames = files.filter((path) =>
  /(^|\/)\.env(\..+)?$/.test(path) && path !== '.env.example'
  || /\.(pem|key|p12|pfx)$/.test(path)
  || /(^|\/)credentials\.json$/.test(path)
  || /\.(safetensors|bin|pt|pth|onnx|gguf|npz|ckpt|lora)$/.test(path))
add('no_tracked_secret_or_weight_files', forbiddenNames.length === 0, forbiddenNames.length ? forbiddenNames.join(', ') : `${files.length} tracked files inspected; no credentials, private keys or weight payloads`)

// 2. High-confidence credential patterns in tracked text (documentation examples excluded).
const patterns = [
  { id: 'private_key_block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'aws_access_key_id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'openai_style_key', re: /\bsk-[A-Za-z0-9]{24,}\b/ },
  { id: 'vite_secret_literal', re: /^VITE_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)=\S+/m },
]
const scanned = files.filter((path) => ['.md', '.mjs', '.js', '.jsx', '.json', '.yml', '.yaml', '.py', '.toml', '.css', '.html', '.sql', '.txt'].includes(extname(path)) && !path.startsWith('docs/release/') && !path.startsWith('release-evidence/'))
// A redaction test must contain a fake key, and a PEM validator must name the PEM
// marker. Those are reviewed synthetic inputs, not credentials. The allowlist is
// path-based AND purpose-based: a production module outside this list that ever
// contains one of these literals still fails the gate.
const REVIEWED_SYNTHETIC = [
  { re: /^services\/core\/src\/providers\/wires\/vertex\.mjs$/, why: 'PEM marker used to validate a service-account document; no key material' },
  { re: /^services\/core\/test\/.*\.test\.mjs$/, why: 'deterministic redaction/auth test fixture' },
  { re: /^services\/fabric\/tests\//, why: 'redaction parity fixture or Python test' },
  { re: /^services\/fabric\/scripts\/generate-.*fixture\.mjs$/, why: 'generator for synthetic redaction fixtures' },
]
const hits = []
const reviewed = []
for (const path of scanned) {
  const text = readFileSync(join(REPO_ROOT, path), 'utf8')
  for (const pattern of patterns) {
    if (!pattern.re.test(text)) continue
    const allowance = REVIEWED_SYNTHETIC.find((entry) => entry.re.test(path))
    if (allowance) reviewed.push({ file: path, pattern: pattern.id, why: allowance.why })
    else hits.push(`${path}:${pattern.id}`)
  }
}
add('no_hardcoded_credential_literals', hits.length === 0,
  hits.length ? `UNREVIEWED: ${hits.join(', ')}` : `${scanned.length} text files scanned for ${patterns.length} patterns; ${reviewed.length} reviewed synthetic fixture occurrences, 0 unreviewed`)

// 3. Static syntax of every Node module.
const nodeFiles = files.filter((path) => /\.(mjs|js)$/.test(path) && !path.startsWith('apps/web/src/'))
const syntaxFailures = []
for (const path of nodeFiles) {
  const result = spawnSync(process.execPath, ['--check', join(REPO_ROOT, path)], { cwd: REPO_ROOT, encoding: 'utf8' })
  if (result.status !== 0) syntaxFailures.push(`${path}: ${(result.stderr ?? '').trim().split('\n')[0]}`)
}
add('node_syntax_all_modules', syntaxFailures.length === 0, syntaxFailures.length ? syntaxFailures.slice(0, 5).join(' | ') : `${nodeFiles.length} .mjs/.js files pass node --check`)

// 4. Deployment configuration invariants.
const compose = readFileSync(atRoot('compose.yaml'), 'utf8')
const lan = readFileSync(atRoot('compose.lan.yaml'), 'utf8')
const lanCaddy = readFileSync(atRoot('deploy/Caddyfile.lan'), 'utf8')
const fabricServer = readFileSync(atRoot('services/fabric/fabric/server.py'), 'utf8')
add('compose_defaults_loopback', /RAGAM_BIND_ADDRESS:-127\.0\.0\.1/.test(compose) && /AETHERIS_LOCAL_SINGLE_USER:\s*'true'/.test(compose), 'single-user Docker mode binds 127.0.0.1 by default')
add('lan_requires_explicit_bind_and_auth', /RAGAM_BIND_ADDRESS:\?/.test(lan) && lanCaddy.includes('basic_auth') && lanCaddy.includes('tls internal'), 'LAN overlay requires explicit private bind, Basic Auth and internal TLS')
add('fabric_defaults_loopback', /DEFAULT_HOST = "127\.0\.0\.1"/.test(fabricServer), 'unauthenticated Fabric service defaults to loopback')

// 5. Telemetry privacy invariants are structural, not promises.
const monitor = readFileSync(atRoot('services/core/src/telemetry/monitor.mjs'), 'utf8')
const privacy = /rawPrompts: false/.test(monitor)
  && /privateDatasets: false/.test(monitor)
  && /apiKeys: false/.test(monitor)
  && /accountIdentifiers: false/.test(monitor)
  && /transmission: 'none'/.test(monitor)
  && /fieldAllowlist:/.test(monitor)
add('telemetry_privacy_invariants', privacy, 'no transmission, no prompts/datasets/keys/account ids, allowlisted fields')
add('telemetry_disable_switch', /AETHERIS_TELEMETRY_ENABLED/.test(monitor) && /AETHERIS_TELEMETRY_ENABLED=true/.test(readFileSync(atRoot('.env.example'), 'utf8')), 'AETHERIS_TELEMETRY_ENABLED=false documented and implemented')

// 6. Pinned dependency inputs exist.
add('pinned_dependency_inputs', ['apps/web/package-lock.json', 'apps/desktop/package-lock.json', 'services/fabric/requirements.lock'].every((p) => existsSync(atRoot(p))), 'two npm lockfiles and one Python lock')

const summary = {
  schema: 'ragam-security-scan/1',
  repository: 'rajaram-2005/ragam',
  scannedAt: new Date().toISOString(),
  trackedFiles: files.length,
  textFilesScanned: scanned.length,
  nodeModulesChecked: nodeFiles.length,
  pass: checks.filter((c) => c.status === 'PASS').length,
  fail: checks.filter((c) => c.status === 'FAIL').length,
  reviewedSynthetic: reviewed,
  outOfScope: [
    'Commercial SAST/DAST product scan: NOT TESTED (no tool or license configured)',
    'Live third-party penetration testing: BLOCKED (no authorized test/staging credentials)',
    'Production database RLS verification: BLOCKED (no staging environment)',
  ],
  checks,
}
writeJson(out, summary)
for (const check of checks) console.log(`${check.status}  ${check.id} — ${check.detail}`)
console.log(`\n${summary.pass} PASS, ${summary.fail} FAIL — ${out}`)
if (summary.fail) process.exit(1)
