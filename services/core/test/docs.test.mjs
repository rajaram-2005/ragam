/**
 * "Docs match implementation" is an acceptance criterion, so it gets a test rather
 * than a promise. Documentation drifts silently; these assertions fail the build
 * when a documented number stops being the real one.
 *
 * Two rules kept these honest while writing them:
 *
 *  - Prose assertions run against whitespace-squashed text. Markdown wraps lines at
 *    ~80 columns, so an exact substring match fails on a phrase that is present but
 *    split across a line break. Three assertions failed for exactly that reason.
 *  - A sentence that *denies* a claim is not a claim. The README says "This is not a
 *    claim that Aetheris beats Mistral…", and a naive forbidden-phrase scan flags the
 *    disclaimer itself. `withoutDisclaimers()` strips negated sentences first.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG, loadConfig } from '../src/config.mjs'
import { ELEVATED_SCOPES, FORBIDDEN_SCOPES } from '../src/plugins/manifest.mjs'
import { LIFECYCLE, DEFAULT_BUDGET } from '../src/godcore/lifecycle.mjs'
import { DEFAULT_ROUTING_WEIGHTS } from '../src/router/registry.mjs'

// HERE is services/core/test, so the repo root is three levels up. Getting this
// wrong made every doc lookup fail at once — which is the argument for comparing
// against the filesystem rather than against a remembered path.
const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = resolve(HERE, '..')
const REPO = resolve(CORE, '../..')

const read = (path) => readFileSync(resolve(REPO, path), 'utf8')
const exists = (path) => { try { statSync(path); return true } catch { return false } }

/** Collapse whitespace so line-wrapped prose can be matched as a phrase. */
const squash = (text) => text.replace(/\s+/g, ' ')

/** Drop sentences that deny something, leaving only affirmative claims to scan. */
function withoutDisclaimers(text) {
  return squash(text)
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/\b(not|never|no|neither|nor|without|cannot|isn't|doesn't|nothing)\b/i.test(sentence))
    .join(' ')
}

const doc = {
  architecture: () => read('docs/02-architecture.md'),
  security: () => read('docs/05-security.md'),
  setup: () => read('docs/04-setup.md'),
  status: () => read('docs/03-status.md'),
  benchmarks: () => read('docs/06-benchmarks.md'),
  cycle: () => read('docs/07-improvement-cycle.md'),
  readme: () => read('README.md'),
  env: () => read('.env.example'),
  notices: () => read('third-party/NOTICES.md'),
}

/** Environment variable names read anywhere in core or the web build config. */
function varsReadByCode() {
  const found = new Set()
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') scan(path)
        continue
      }
      if (!/\.(mjs|js)$/.test(entry.name)) continue
      const text = readFileSync(path, 'utf8')
      for (const match of text.matchAll(/(?:process\.)?env\.([A-Z][A-Z0-9_]*)/g)) found.add(match[1])
      for (const match of text.matchAll(/env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) found.add(match[1])
      // readSecret(env, 'FREELLMAPI_API_KEY', 'FREELLMAPI_API_KEY_FILE') passes the
      // names as plain string arguments, so neither pattern above sees them. Without
      // this the suite would report a complete inventory while missing every secret.
      for (const match of text.matchAll(/readSecret\(\s*env\s*,\s*'([A-Z][A-Z0-9_]*)'\s*,\s*'([A-Z][A-Z0-9_]*)'/g)) {
        found.add(match[1])
        found.add(match[2])
      }
    }
  }
  scan(resolve(CORE, 'src'))
  scan(resolve(REPO, 'apps/web'))
  return found
}

/**
 * Dependency counts derived from the COMMITTED lockfile.
 *
 * The first version of this counted directories under apps/web/node_modules and
 * asserted 62. That broke CI for two separate reasons, and both were real defects
 * in the test rather than in the code:
 *
 *  1. The `core` job has no install step — services/core has zero npm dependencies
 *     and asserting that property is the point of the job — so node_modules did not
 *     exist and readdirSync threw ENOENT. A test of the core service must not
 *     require the web app to be installed.
 *  2. The installed count is host-specific anyway. 50 lockfile entries are
 *     per-platform native binaries; four match linux/x64, and the lockfile carries
 *     `os` and `cpu` but NO `libc` field, so npm resolves glibc-vs-musl by probing
 *     the system. A glibc host installs 62, another may install 63.
 *
 * So the portable facts are the lockfile's own, and those are what is asserted.
 */
function lockfileEntries() {
  const lock = JSON.parse(readFileSync(resolve(REPO, 'apps/web/package-lock.json'), 'utf8'))
  return Object.entries(lock.packages).filter(([key]) => key !== '')
}

// ---------------------------------------------------------------------------
// .env.example must describe the real configuration surface
// ---------------------------------------------------------------------------

test('.env.example documents exactly the variables the code reads', () => {
  // '# NAME=' counts as documented: an optional secret is deliberately shipped
  // commented out so copying the file never activates it.
  const documented = new Set([...doc.env().matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]))
  const real = varsReadByCode()

  const invented = [...documented].filter((name) => !real.has(name))
  assert.deepEqual(invented, [], `.env.example documents variables nothing reads: ${invented.join(', ')}`)

  const missing = [...real].filter((name) => !documented.has(name))
  assert.deepEqual(missing, [], `.env.example omits variables the code reads: ${missing.join(', ')}`)
})

test('.env.example states the real defaults, not plausible ones', async () => {
  // A config loaded from an empty environment IS the default configuration.
  const loaded = await loadConfig({})
  const text = doc.env()
  const documented = (name) => {
    const match = text.match(new RegExp(`^#?\\s*${name}=(.*)$`, 'm'))
    assert.ok(match, `.env.example must state a value for ${name}`)
    return match[1].trim()
  }

  assert.equal(documented('AETHERIS_CORE_PORT'), String(loaded.port))
  assert.equal(documented('AETHERIS_CORE_HOST'), loaded.host)
  assert.equal(documented('AETHERIS_RUNTIME_POLICY'), loaded.policy)
  assert.equal(documented('AETHERIS_EXTERNAL_DATA_CEILING'), loaded.externalCeiling)
  assert.equal(documented('OLLAMA_BASE_URL'), loaded.ollama.baseUrl)
  assert.equal(documented('LLAMACPP_BASE_URL'), loaded.llamaCpp.baseUrl)
  assert.equal(documented('AETHERIS_FABRIC_URL'), loaded.fabric.baseUrl)
  assert.equal(documented('AETHERIS_MEDIA_CONCURRENCY'), String(loaded.media.concurrency))
  // The video timeout is read from the provider-namespaced variable, not an
  // AETHERIS_MEDIA_* one: config.mjs:128 reads FREELLMAPI_VIDEO_TIMEOUT_MS.
  assert.equal(documented('FREELLMAPI_VIDEO_TIMEOUT_MS'), String(loaded.media.videoTimeoutMs))
  assert.equal(documented('AETHERIS_IMAGE_TIMEOUT_MS'), String(loaded.media.imageTimeoutMs))
  assert.equal(documented('AETHERIS_CHUNK_TARGET'), String(loaded.knowledge.chunkTargetChars))
  assert.equal(documented('AETHERIS_CHUNK_MAX'), String(loaded.knowledge.chunkMaxChars))
  assert.equal(documented('AETHERIS_CHUNK_OVERLAP'), String(loaded.knowledge.chunkOverlapChars))
  assert.equal(documented('AETHERIS_GODMODE_MAX_STEPS'), String(loaded.godMode.maxSteps))
  // The variable is *_MAX_MS even though the config field is maxDurationMs.
  assert.equal(documented('AETHERIS_GODMODE_MAX_MS'), String(loaded.godMode.maxDurationMs))

  const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
  assert.equal(truthy(documented('OLLAMA_ENABLED')), loaded.ollama.enabled)
  assert.equal(truthy(documented('LLAMACPP_ENABLED')), loaded.llamaCpp.enabled)
  assert.equal(truthy(documented('FREELLMAPI_ENABLED')), loaded.freellmapi.enabled)
  assert.equal(truthy(documented('AETHERIS_FABRIC_ENABLED')), loaded.fabric.enabled)
  assert.equal(truthy(documented('AETHERIS_GODMODE_ENABLED')), loaded.godMode.enabled)

  // Nothing that looks like a credential may carry a sample value, and the *_FILE
  // form must be offered so a secret need not sit in the process environment.
  for (const name of ['FREELLMAPI_API_KEY', 'LLAMACPP_API_KEY']) {
    assert.equal(documented(name), '', `${name} must be documented empty, never with a sample secret`)
    assert.equal(documented(`${name}_FILE`).length > 0, true, `${name}_FILE must show a usable path`)
    assert.ok(new RegExp(`^#\\s*${name}=$`, 'm').test(text),
      `${name} must ship commented out, so copying .env.example never activates a credential`)
  }
  assert.ok(!/^(?!#).*(_API_KEY|_SECRET|_PASSWORD|_TOKEN)=(?!\s*$)\S/m.test(text),
    '.env.example must not contain an uncommented credential with a value')
})

test('DEFAULT_CONFIG still holds the security-relevant defaults', () => {
  // Guards the other direction: if DEFAULT_CONFIG were edited, the test above would
  // follow it silently, so the defaults that matter are pinned here.
  assert.equal(DEFAULT_CONFIG.port, 8790)
  assert.equal(DEFAULT_CONFIG.policy, 'strict_offline', 'default policy must be the most restrictive one')
  assert.equal(DEFAULT_CONFIG.externalCeiling, 'internal')
  assert.equal(DEFAULT_CONFIG.allowedOrigin, null, 'cross-origin must be an explicit choice')
  assert.equal(DEFAULT_CONFIG.freellmapi.enabled, false, 'the online gateway must default to off')
  assert.equal(DEFAULT_CONFIG.llamaCpp.enabled, false)
  assert.equal(DEFAULT_CONFIG.fabric.enabled, false)
  assert.equal(DEFAULT_CONFIG.ollama.baseUrl, 'http://127.0.0.1:11434')
})

// ---------------------------------------------------------------------------
// Architecture doc
// ---------------------------------------------------------------------------

test('the documented lifecycle is the real lifecycle', () => {
  assert.deepEqual(
    [...LIFECYCLE],
    ['understand', 'plan', 'retrieve', 'route', 'execute', 'observe', 'verify', 'synthesize'],
  )
  assert.ok(squash(doc.architecture()).includes('Understand → Plan → Retrieve → Route → Execute → Observe → Verify → Synthesize'))
})

test('the documented budgets are the real budgets', () => {
  assert.equal(DEFAULT_BUDGET.maxSteps, 12)
  assert.equal(DEFAULT_BUDGET.maxDurationMs, 300_000)
  const security = squash(doc.security())
  assert.ok(security.includes('`maxSteps`, default 12'), 'docs must state the real maxSteps')
  assert.ok(security.includes('`maxDurationMs`, default 300 s'), 'docs must state the real maxDurationMs')
})

test('the documented scope tables are the real scope tables', () => {
  assert.deepEqual([...ELEVATED_SCOPES].sort(), [
    'credentials.read', 'device.access', 'fs.write', 'knowledge.write',
    'network.external', 'service.external', 'terminal.exec',
  ])
  assert.deepEqual([...FORBIDDEN_SCOPES].sort(), [
    'audit.erase', 'credentials.write', 'godcore.bypass', 'policy.override',
  ])
  assert.equal(ELEVATED_SCOPES.length, 7)
  assert.equal(FORBIDDEN_SCOPES.length, 4)

  const architecture = squash(doc.architecture())
  for (const scope of [...ELEVATED_SCOPES, ...FORBIDDEN_SCOPES]) {
    assert.ok(architecture.includes(scope), `docs/02 must name the scope '${scope}'`)
  }
  assert.ok(architecture.includes('can never be granted'))
})

test('the documented routing weights are the real weights', () => {
  assert.deepEqual(DEFAULT_ROUTING_WEIGHTS, {
    capabilityFit: 0.4, privacy: 0.25, latency: 0.15, resourceFit: 0.1, quality: 0.1,
  })
  const total = Object.values(DEFAULT_ROUTING_WEIGHTS).reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(total - 1) < 1e-9, 'routing weights must sum to 1')

  const table = squash(doc.architecture())
  for (const [name, weight] of Object.entries(DEFAULT_ROUTING_WEIGHTS)) {
    const row = new RegExp('\\| `' + name + '` \\| ' + weight.toFixed(2) + ' \\|')
    assert.ok(row.test(table), `docs/02 must document ${name} = ${weight}`)
  }
  assert.ok(table.includes('The privacy weight of 0.25 is what makes local win ties'))
})

test('the documented route surface is the real route surface', () => {
  const source = readFileSync(resolve(CORE, 'src/app.mjs'), 'utf8')
  const literal = new Set([...source.matchAll(/'(\/api\/[A-Za-z0-9/:._-]+)'/g)].map((m) => m[1]))
  assert.equal(literal.size, 31, `literal /api routes changed: ${literal.size}`)
  assert.ok(squash(doc.architecture()).includes('31 literal routes'))

  for (const route of ['/api/health', '/api/ready', '/api/config', '/api/chat', '/api/chat/stream',
    '/api/models', '/api/models/probe', '/api/knowledge/search', '/api/plugins/validate',
    '/api/mcp/preflight', '/api/mcp/call', '/api/audit', '/api/hardware']) {
    assert.ok(literal.has(route), `${route} is documented but no longer routed`)
  }

  // These are matched on path segments, not as literals — asserting them as strings
  // was a bug in the first version of this test.
  const segments = new Set([...source.matchAll(/segments\[1\] === '([a-z]+)'/g)].map((m) => m[1]))
  assert.deepEqual([...segments].sort(), ['knowledge', 'mcp', 'media', 'plugins', 'tasks'])
  assert.ok(/segments\[2\] === 'artifact'/.test(source), 'the artifact route must stay segment-matched')
  const architecture = squash(doc.architecture())
  for (const prefix of ['tasks', 'plugins', 'mcp', 'media', 'knowledge']) {
    assert.ok(architecture.includes(`/api/${prefix}`), `docs/02 must mention segment routes under /api/${prefix}`)
  }

  // Routing is shown inside Chat, never promoted to its own area.
  assert.ok(!literal.has('/api/routes'))
  assert.ok(![...literal].some((route) => /policy|training|benchmark|memory|safety/.test(route)),
    'no internal service may get its own top-level route group')
})

test('the documented module line counts match the filesystem', () => {
  const table = doc.architecture()
  const rows = [...table.matchAll(/^\| `([a-z/.]+\.mjs)` \| ([\d,]+) \|/gm)]
  assert.ok(rows.length >= 20, `expected the full module table, found ${rows.length} rows`)

  const countLines = (path) => readFileSync(resolve(CORE, 'src', path), 'utf8').split('\n').length - 1
  for (const [, file, claimed] of rows) {
    const actual = countLines(file)
    assert.equal(actual, Number(claimed.replace(/,/g, '')), `${file} is ${actual} lines, docs claim ${claimed}`)
  }

  const claimedTotal = table.match(/\| ([\d,]+) total \|/)
  if (claimedTotal) {
    const sum = rows.reduce((acc, [, file]) => acc + countLines(file), 0)
    assert.equal(sum, Number(claimedTotal[1].replace(/,/g, '')), 'the documented total must equal the sum of its rows')
  }
})

// ---------------------------------------------------------------------------
// Security doc
// ---------------------------------------------------------------------------

test('the documented secret-pattern count is the real count', () => {
  const source = readFileSync(resolve(CORE, 'src/policy/classify.mjs'), 'utf8')
  const block = source.slice(source.indexOf('SECRET_PATTERNS'), source.indexOf('RESTRICTED_FINDINGS'))
  const names = [...block.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1])
  assert.equal(names.length, 16, `secret patterns changed: ${names.join(', ')}`)
  assert.ok(squash(doc.security()).includes('Sixteen patterns'))

  // The env-var pattern exists because \b cannot match inside AWS_SECRET_ACCESS_KEY.
  assert.ok(names.includes('env_style_secret'), 'the whole-identifier credential pattern must stay')
  assert.ok(source.includes('AWS_SECRET_ACCESS_KEY'), 'the reason for that pattern must stay in the source')

  const restricted = source.slice(source.indexOf('RESTRICTED_FINDINGS'))
  for (const finding of ['private_key_block', 'aws_access_key_id', 'env_style_secret', 'azure_account_key', 'url_basic_auth']) {
    assert.ok(restricted.includes(`'${finding}'`), `${finding} must escalate to restricted`)
    assert.ok(doc.security().includes(finding), `docs/05 must name ${finding}`)
  }
})

test('the Fabric service binds loopback by default, as documented', () => {
  // The service performs no authentication, so this default is the whole mitigation.
  // It was originally 0.0.0.0, contradicting the advice /status gives.
  const source = readFileSync(resolve(REPO, 'services/fabric/fabric/server.py'), 'utf8')
  assert.ok(/DEFAULT_HOST = "127\.0\.0\.1"/.test(source), 'Fabric must default to loopback')
  assert.ok(!/AETHERIS_FABRIC_HOST", "0\.0\.0\.0"/.test(source), 'the 0.0.0.0 default must not come back')
  assert.ok(/acceptsCredentials.*False/.test(source.replace(/\n\s*/g, ' ')))

  const security = squash(doc.security())
  assert.ok(security.includes('binds to **`127.0.0.1`**') || security.includes('the bind default is **`127.0.0.1`**'),
    'docs/05 must state the loopback default')
  const setup = squash(doc.setup())
  assert.ok(setup.includes('**`127.0.0.1`**'), 'docs/04 must state the loopback default')
})

// ---------------------------------------------------------------------------
// Dependency and licence facts
// ---------------------------------------------------------------------------

test('the documented dependency counts match the committed lockfile', () => {
  const entries = lockfileEntries()
  const platformSpecific = entries.filter(([, entry]) => entry.os || entry.cpu)

  // Vite 8 replaced Rollup/esbuild/Babel with rolldown/oxc/lightningcss, which cut
  // the tree by more than half. These are the measured figures for that tree.
  assert.equal(entries.length, 46, 'lockfile entries changed')
  assert.equal(platformSpecific.length, 27, 'platform-specific binaries changed')
  assert.equal(entries.length - platformSpecific.length, 19, 'platform-independent count changed')

  const manifest = JSON.parse(readFileSync(resolve(REPO, 'apps/web/package.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['react', 'react-dom'],
    'only react and react-dom may be runtime dependencies')

  // NOTICES must present the portable numbers as fact and the installed number as a
  // property of one machine, or a reader on another host gets a wrong inventory.
  const notices = squash(doc.notices())
  for (const claim of ['| **46** | yes |', '19 | yes', '27 | yes', '**no** |']) {
    assert.ok(notices.includes(claim), `NOTICES must state ${claim}`)
  }
  assert.ok(notices.includes('no `libc` field'),
    'NOTICES must explain why the installed count is host-specific')
  assert.ok(notices.includes('**No GPL, AGPL or LGPL code is present anywhere in the dependency tree.**'))
})

test('no dependency carries strong copyleft, and weak copyleft is dev-only', () => {
  // Scans every lockfile entry, including other-platform binaries that are not
  // installed here: a licence obligation follows the dependency tree, and a Windows
  // or macOS build would install them.
  const entries = lockfileEntries()
  // 23 install on a linux/x64 glibc host; the lockfile must list more than any one
  // host installs, or the scan is silently narrower than the tree it claims to cover.
  assert.ok(entries.length > 23, 'the lockfile should list more entries than any one host installs')

  // STRONG copyleft would be incompatible with relicensing this MIT project.
  const strong = entries
    .filter(([, entry]) => /GPL|AGPL|LGPL|SSPL|BUSL|Commons Clause/i.test(String(entry.license || '')))
    .map(([key, entry]) => `${key}: ${entry.license}`)
  assert.deepEqual(strong, [], `strong-copyleft dependencies would break MIT compatibility: ${strong.join(', ')}`)

  // WEAK (file-level) copyleft is present: lightningcss, pulled in by Vite 8. It is
  // acceptable only while it stays out of the distributed artifact, so pin that.
  // This replaces a test that claimed "no copyleft anywhere" — which passed only
  // because its regex happened not to include MPL. A claim true by omission is not
  // a claim worth making.
  const weak = entries.filter(([, entry]) => /MPL|EPL|CDDL/i.test(String(entry.license || '')))
  assert.ok(weak.length > 0, 'lightningcss is MPL-2.0; if this is empty the scan has stopped matching')
  const weakNonDev = weak
    .filter(([, entry]) => entry.dev !== true)
    .map(([key, entry]) => `${key}: ${entry.license}`)
  assert.deepEqual(weakNonDev, [],
    `weak-copyleft packages must be development-only, never redistributed: ${weakNonDev.join(', ')}`)

  // And it must be disclosed in the notices, not merely tolerated by a test.
  const notices = squash(doc.notices())
  assert.ok(notices.includes('MPL-2.0'), 'NOTICES must disclose the MPL-2.0 dependency')
  assert.ok(notices.includes('### MPL-2.0 in the build toolchain'),
    'NOTICES must explain why weak copyleft in build tooling is acceptable')

  // Every production dependency must be permissive, since those are what ship.
  const production = entries.filter(([, entry]) => entry.dev !== true)
  assert.ok(production.length >= 5, `expected the runtime tree, found ${production.length}`)
  for (const [key, entry] of production) {
    assert.match(String(entry.license), /^(MIT|BSD-\d+-Clause|ISC|Apache-2\.0|Unlicense|0BSD)$/,
      `${key} ships to users and must carry a permissive licence, got ${entry.license}`)
  }

  const unlicensed = entries.filter(([, entry]) => !entry.license).map(([key]) => key)
  assert.deepEqual(unlicensed, [], `every dependency must declare a licence: ${unlicensed.join(', ')}`)
})

test('the quoted licence texts are byte-identical to the checked-in copies', () => {
  const notices = doc.notices()
  const quoted = (heading) => {
    const match = notices.match(new RegExp('### ' + heading + '[\\s\\S]*?\\n```\\n([\\s\\S]*?)\\n```'))
    assert.ok(match, `NOTICES must quote the ${heading} licence text`)
    return match[1]
  }

  // A hand-transcribed licence is how attribution silently breaks. Compare exactly.
  assert.equal(quoted('MIT — Aetheris-'), read('third-party/licenses/aetheris-MIT.txt').trim())
  assert.equal(quoted('MIT — freellmapi'), read('third-party/licenses/freellmapi-MIT.txt').trim())
  assert.equal(quoted('Unlicense — sparsiz'), read('third-party/licenses/sparsiz-Unlicense.txt').trim())

  // NumPy's LICENSE.txt bundles component licences; only its own terms are quoted
  // inline, but the whole file must be preserved.
  const numpy = read('third-party/licenses/numpy-BSD-3-Clause.txt')
  assert.equal(quoted('BSD-3-Clause — NumPy'), numpy.split('\n----\n')[0].trim())
  assert.ok(numpy.length > 40_000, 'the full bundled NumPy licence must be preserved, not truncated')
  assert.ok(squash(notices).includes('bundles the licences of its individual components'))

  // MIT texts must really be MIT, and the Unlicense really the Unlicense.
  for (const file of ['aetheris-MIT.txt', 'freellmapi-MIT.txt']) {
    const text = read(`third-party/licenses/${file}`)
    assert.ok(text.includes('Permission is hereby granted, free of charge'), `${file} must be the MIT licence`)
    assert.ok(text.includes('THE SOFTWARE IS PROVIDED "AS IS"'), `${file} must carry the MIT disclaimer`)
  }
  assert.ok(read('third-party/licenses/sparsiz-Unlicense.txt').includes('released into the public domain'))
})

// ---------------------------------------------------------------------------
// Claims: the honesty rules, enforced
// ---------------------------------------------------------------------------

test('the docs never claim a comparison that was not run', () => {
  const forbidden = [
    /outperforms? (every|all) (local )?models?/i,
    /beats (Mistral|Qwen|Llama|Gemma|DeepSeek)/i,
    /better than (Mistral|Qwen|Llama|Gemma|DeepSeek)/i,
    /state[- ]of[- ]the[- ]art/i,
    /beats? (every|all) (other|competing)/i,
  ]

  for (const [name, text] of Object.entries({
    'docs/06': doc.benchmarks(), 'docs/03': doc.status(), 'README': doc.readme(),
    'docs/02': doc.architecture(), 'docs/05': doc.security(), 'docs/07': doc.cycle(),
  })) {
    const claims = withoutDisclaimers(text)
    for (const pattern of forbidden) {
      const match = claims.match(pattern)
      assert.equal(match, null, `${name} makes an unsupported superiority claim: ${match?.[0] ?? ''}`)
    }
  }

  // And the disclaimers themselves must still be there.
  assert.ok(squash(doc.benchmarks()).includes('no claim of superiority over them is made or implied'))
  assert.ok(squash(doc.status()).includes('no superiority claim over'))
  assert.ok(squash(doc.readme()).includes('This is not a claim that Aetheris beats Mistral'))
})

test('the negative benchmark results stay visible', () => {
  const benchmarks = squash(doc.benchmarks())
  // The held-out-topic loss and the high-overlap rejection are the two results that
  // a flattering summary would quietly drop.
  assert.ok(benchmarks.includes('The dense model loses badly on entirely unseen topic vocabularies'))
  assert.ok(benchmarks.includes('**Experiment ledger verdict: `reject`.**'))
  assert.ok(benchmarks.includes('recall@5 regressed: 1.0000 -> 0.9167'))
  assert.ok(benchmarks.includes('These differences are not meaningful and no performance claim is made'))
  assert.ok(benchmarks.includes('0.0937'), 'the losing MRR must stay in the table')
})

test('the docs record limitations instead of implying completeness', () => {
  const status = squash(doc.status())
  assert.ok(status.includes('no GPU'), 'the host must be described honestly')
  assert.ok(status.includes('`huggingface.co`'), 'the blocked host must be named')
  assert.ok(status.includes('Blocked — requires weights'), 'blocked stages must be labelled, not omitted')
  assert.ok(status.includes('degraded'), 'readiness must be reported as degraded, not healthy')

  const setup = squash(doc.setup())
  assert.ok(setup.includes('**is the correct output**'), 'a degraded startup must be explained as expected')
  assert.ok(setup.includes('Do not `pip install torch`'), 'the torch trap must stay documented')

  const security = squash(doc.security())
  assert.ok(security.includes('## 16. Open items'), 'unstated security gaps are worse than stated ones')
  assert.ok(security.includes('No authentication or multi-tenancy'))
  assert.ok(security.includes('No transport encryption'))
})

test('the status doc reports the real test totals', () => {
  // Recomputed from the filesystem: one test file per suite.
  const count = (dir, pattern) => readdirSync(resolve(REPO, dir)).filter((f) => pattern.test(f)).length
  // 11 includes this file. If a suite file is added or removed, the counts in
  // docs/03-status.md and README.md have to move with it.
  assert.equal(count('services/core/test', /\.test\.mjs$/), 11)
  assert.equal(count('apps/web/test', /\.test\.mjs$/), 4)
  assert.equal(count('services/fabric/tests', /^test_.*\.py$/), 19)

  const status = squash(doc.status())
  assert.ok(status.includes('**266 / 266**'), 'core total must be stated')
  assert.ok(status.includes('**440 / 440**'), 'fabric total must be stated')
  assert.ok(status.includes('**56 / 56**'), 'web total must be stated')
  assert.ok(status.includes('762 passing'), 'the grand total must equal the sum of the suites')
  assert.ok(squash(doc.readme()).includes('762 tests: core 266, web 56, fabric 440'),
    'README must state the same totals')
  assert.ok(status.includes('(11 files'), 'the file count must move with the suite')

  // The component headings each state a count too, and they drifted from the table
  // in the same document without this: fabric's heading read 256 while the table
  // said 342. A number stated twice is a number that can disagree with itself, so
  // every occurrence is checked rather than just the one the table happens to hold.
  // Anchored to the component-heading form ("### `services/core` — ... (265 tests)")
  // so subsection counts like "(23 tests)" are not mistaken for components.
  const perComponent = [...doc.status().matchAll(/^### `[^`]+` [^(]*\((\d+) tests?\)/gm)].map((m) => Number(m[1]))
  assert.equal(perComponent.length, 3, `expected three component headings, found ${JSON.stringify(perComponent)}`)
  const fromHeadings = perComponent
  assert.ok(fromHeadings.includes(266), `core heading must say 266, found ${JSON.stringify(fromHeadings)}`)
  assert.ok(fromHeadings.includes(440), `fabric heading must say 440, found ${JSON.stringify(fromHeadings)}`)
  assert.ok(fromHeadings.includes(56), `web heading must say 56, found ${JSON.stringify(fromHeadings)}`)
  // And the headings must sum to the stated grand total, not merely contain it.
  assert.equal(
    fromHeadings.reduce((a, b) => a + b, 0),
    762,
    `component headings sum to ${fromHeadings.reduce((a, b) => a + b, 0)}, grand total says 762`,
  )
})

test('the documented fabric line counts match the filesystem', () => {
  // The core module table was checked; the fabric header was not, and it drifted
  // silently from 5,592/3,583 while the numbers in this file kept passing. A number
  // a document states twice can disagree with itself, so both are checked now.
  const countLines = (dir, filter) => {
    let total = 0
    const walk = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = resolve(current, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== '__pycache__') walk(full)
        } else if (entry.name.endsWith('.py') && (!filter || filter(entry.name))) {
          total += readFileSync(full, 'utf8').split('\n').length - 1
        }
      }
    }
    walk(dir)
    return total
  }
  const source = countLines(resolve(REPO, 'services/fabric/fabric'))
  const tests = countLines(resolve(REPO, 'services/fabric/tests'))
  const header = doc.architecture().match(/### `services\/fabric` — ([\d,]+) source lines, ([\d,]+) test lines/)
  assert.ok(header, 'services/fabric must state its source and test line counts')
  assert.equal(Number(header[1].replace(/,/g, '')), source, `fabric source is ${source} lines`)
  assert.equal(Number(header[2].replace(/,/g, '')), tests, `fabric tests are ${tests} lines`)
})

test('every documented file actually exists', () => {
  // Catches the docs-only failure mode: a guide that points at a file nobody wrote.
  const referenced = new Set()
  for (const text of [doc.architecture(), doc.security(), doc.setup(), doc.status(), doc.readme(), doc.benchmarks()]) {
    for (const match of text.matchAll(/\]\((?:\.\.?\/)*([A-Za-z0-9._/-]+\.(?:md|json|mjs|js|py|txt|css|example))\)/g)) {
      referenced.add(match[1])
    }
  }
  assert.ok(referenced.size >= 15, `expected the docs to cross-reference each other, found ${referenced.size}`)

  // Links are written relative to docs/, to the repo root, or to third-party/.
  const missing = [...referenced].filter((path) => ![
    resolve(REPO, path), resolve(REPO, 'docs', path), resolve(REPO, 'third-party', path),
    resolve(REPO, 'docs/model-cards', path),
  ].some(exists))
  assert.deepEqual(missing, [], `docs link to files that do not exist: ${missing.join(', ')}`)

  // The specific artefacts the docs promise by name.
  for (const path of [
    'docs/01-audit.md', 'docs/02-architecture.md', 'docs/03-status.md', 'docs/04-setup.md',
    'docs/05-security.md', 'docs/06-benchmarks.md', '.env.example', 'LICENSE', 'README.md',
    'third-party/NOTICES.md', 'third-party/licenses/aetheris-MIT.txt',
    'third-party/licenses/freellmapi-MIT.txt', 'third-party/licenses/sparsiz-Unlicense.txt',
    'third-party/licenses/numpy-BSD-3-Clause.txt', 'services/fabric/README.md',
    'docs/model-cards/aetheris-lite-retriever-0.1.0.md',
    'docs/model-cards/aetheris-lite-retriever-0.1.0.json',
    'apps/web/src/areas.js',
  ]) {
    assert.ok(exists(resolve(REPO, path)), `${path} is referenced by the docs but does not exist`)
  }
})

test('the model card JSON is machine-readable and self-consistent', () => {
  // The file is a wrapper: { format, generatedBy, reproduce, runId, runStatus, card }.
  const wrapper = JSON.parse(read('docs/model-cards/aetheris-lite-retriever-0.1.0.json'))
  assert.equal(wrapper.format, 'aetheris-model-card/1')
  assert.equal(wrapper.runStatus, 'partial', 'the run was partial: 3 of 8 stages could not execute')
  assert.ok(wrapper.reproduce.includes('PipelineConfig(epochs=25)'), 'the card must carry its own reproduction command')

  const card = wrapper.card
  assert.equal(card.name, 'aetheris-lite-retriever')
  assert.equal(card.version, '0.1.0')
  assert.equal(card.identifier, 'aetheris-lite-retriever@0.1.0')
  assert.equal(card.status, 'released')
  assert.equal(card.baseCheckpoint, null, 'trained from scratch, not a fine-tune — must stay explicit')
  assert.equal(card.licence, 'MIT')
  assert.equal(card.parentVersion, null)

  // Provenance is what makes the run reproducible rather than merely reported.
  const provenance = card.provenance
  assert.equal(provenance.seed, 7, 'the model seed must be recorded')
  assert.equal(provenance.corpusSize, 96)
  assert.equal(provenance.hardware.gpuDetected, false, 'the absence of a GPU must be recorded')
  assert.equal(provenance.hardware.cpuCount, 2)
  assert.equal(provenance.quantization, null, 'no quantization was applied; must stay explicit')
  assert.ok(/^[0-9a-f]{40}$/.test(provenance.codeRevision), 'codeRevision must be a real git SHA')
  assert.ok(/^[0-9a-f]{64}$/.test(provenance.datasetDigest), 'the dataset must be digest-stamped')
  assert.ok(Array.isArray(provenance.prompts) && provenance.prompts.length > 0,
    'the exact prompts must be recorded, not described')
  // The evaluation stage completed even though the RUN was partial: release() refuses
  // a card whose provenance.status is blocked, so this distinction is load-bearing.
  assert.equal(provenance.status, 'completed')
  assert.equal(wrapper.runStatus, 'partial')
  for (const digest of ['weightsDigest', 'configDigest', 'datasetDigest']) {
    assert.ok(/^[0-9a-f]{16,64}$/.test(card[digest]), `${digest} must be a real digest, got ${card[digest]}`)
  }

  // A released model must have passed every hard requirement.
  const hard = card.requirements.filter((requirement) => requirement.hard)
  assert.equal(hard.length, 2, 'both hard requirements must be recorded')
  assert.deepEqual(card.validation.hardFailures, [], 'a released model cannot carry a hard failure')
  assert.ok(card.metrics.mrr >= 0.6, 'the release floor must hold')
  assert.ok(card.metrics.latencyMs <= 25, 'the latency ceiling must hold')

  // The card was generated at an older revision than HEAD, so the re-verification is
  // what makes it current rather than stale. Pin the claim so it cannot drift.
  const reverified = wrapper.reverifiedAt
  assert.ok(reverified, 'the card must record that it was re-verified at a later revision')
  assert.equal(reverified.result, 'identical')
  assert.ok(/^[0-9a-f]{40}$/.test(reverified.codeRevision), 'the re-verification revision must be a real git SHA')
  assert.notEqual(reverified.codeRevision, card.provenance.codeRevision,
    're-verification is only meaningful at a different revision than generation')
  for (const field of ['weightsDigest', 'datasetDigest', 'configDigest', 'metrics.mrr']) {
    assert.ok(reverified.fieldsCompared.includes(field), `${field} must be among the compared fields`)
  }
  assert.deepEqual(reverified.excluded, ['metrics.latencyMs'],
    'only the wall-clock measurement may be excluded, and it must be named')

  // The card's own limitations are the properties of the ARTIFACT (3). The run's
  // limitations (12) are a different list, and the Markdown card must keep them
  // distinct rather than presenting one as the other.
  assert.equal(card.limitations.length, 3)
  assert.ok(card.limitations.some((text) => /trained from scratch/.test(text)))
  assert.ok(card.limitations.some((text) => /does not generate text/.test(text)))
  assert.ok(card.validation.softFailures.some((text) => /historicalFailures/.test(text)))
})

test('the Markdown model card keeps the two limitation lists distinct', () => {
  const text = squash(read('docs/model-cards/aetheris-lite-retriever-0.1.0.md'))
  // It previously presented ten items as "recorded by the pipeline, reproduced
  // verbatim" — a list that was neither the card's three nor the run's twelve.
  assert.ok(text.includes('There are **two** limitation lists, and they are not the same thing'))
  assert.ok(text.includes('`card.limitations` (3)'))
  assert.ok(text.includes('`run.limitations` (12)'))
  assert.ok(!/reproduced verbatim:\s*\n\s*1\. The corpus is a generated/i.test(text),
    'the mixed list must not come back')

  assert.ok(text.includes('## Reproducibility across revisions'))
  assert.ok(text.includes('This card is therefore **not stale**: it reproduces bit-for-bit at `HEAD`.'))
  assert.ok(text.includes('`6be52b98dfdc6c4d741ff7d521541758ef512175`'),
    'the Markdown card must name the revision it was re-verified at')

  // The competitor-comparison limitation belongs to the RUN record, verbatim.
  assert.ok(text.includes('no comparison against Mistral, Qwen, Llama, Gemma or DeepSeek was possible'))
  // And so does the losing condition, with the exact measured numbers.
  assert.ok(text.includes('under a held-out-TOPIC split'))
  assert.ok(text.includes('MRR 0.093673 against BM25 0.382011'))
})

// ---------------------------------------------------------------------------
// CI: the gate that keeps every number above honest
// ---------------------------------------------------------------------------

test('CI exists, covers all three components, and is documented', () => {
  const workflow = read('.github/workflows/ci.yml')

  // Four jobs, one per independently-failable property. A single job would report
  // one red check without naming the component that broke.
  for (const job of ['core:', 'fabric:', 'web:', 'docs:']) {
    assert.ok(new RegExp(`^  ${job}$`, 'm').test(workflow), `CI must define a ${job.replace(':', '')} job`)
  }

  // The zero-dependency property of services/core is asserted in CI, not just here.
  assert.ok(workflow.includes('services/core declares zero dependencies'))
  assert.ok(workflow.includes('services/core/node_modules'), 'CI must reject an install step appearing in core')

  // Nothing may install torch: services/fabric is NumPy-only by design, and on a
  // GPU-less runner pip resolves torch to the CUDA build.
  assert.ok(!/pip(3)? install[^\n]*\btorch\b/.test(workflow), 'CI must never install torch')
  assert.ok(workflow.includes('import torch'), 'CI must fail if torch becomes importable')

  // The release gate is asserted in BOTH directions. Only testing the positive case
  // would pass even if the gate stopped refusing junk.
  assert.ok(workflow.includes('assert record.status == "partial"'), 'CI must pin the honest partial status')
  assert.ok(workflow.includes('assert weak_record.status == "failed"'), 'CI must pin the undertrained failure')
  assert.ok(workflow.includes('weak.registry.current() is None'),
    'CI must assert an undertrained run cannot become the released model')

  // Least privilege, and superseded runs are cancelled.
  assert.ok(workflow.includes('contents: read'))
  assert.ok(workflow.includes('cancel-in-progress: true'))

  // The docs job needs history: the model card asserts a real SHA re-verified at a
  // different revision, which a depth-1 checkout cannot support.
  assert.ok(workflow.includes('fetch-depth: 0'))

  // Dependency scanning is enforced, not merely run once by hand. Two gates with
  // different bars: anything vulnerable in the shipped artifact blocks at any
  // severity, while build-tooling advisories (mostly dev-server issues) block only
  // when high or critical.
  assert.ok(workflow.includes('npm audit --omit=dev --audit-level=low'),
    'CI must fail on ANY known vulnerability in the production dependencies')
  assert.ok(workflow.includes('npm audit --audit-level=high'),
    'CI must fail on high/critical vulnerabilities anywhere in the tree')
  // The full report is printed even when it does not fail the build, so moderate
  // findings stay visible in the log rather than being silently tolerated.
  assert.ok(workflow.includes('npm audit || true'),
    'CI must print the full audit report even when it is not a blocking failure')

  // The Python tree is covered symmetrically. pip has no audit command, so CI runs a
  // script that queries the GitHub Advisory Database directly. Without this the web
  // tree would be gated and the training service would not be.
  assert.ok(workflow.includes('python scripts/audit_python_deps.py'),
    'CI must audit the Python dependencies against the advisory database')
  assert.ok(workflow.includes('GITHUB_TOKEN'),
    'the advisory query must be authenticated so a shared runner IP cannot exhaust the limit')

  // And the workflow must be reachable from the documentation.
  assert.ok(doc.readme().includes('.github/workflows/ci.yml'), 'README must link the workflow')
  assert.ok(doc.status().includes('.github/workflows/ci.yml'), 'docs/03 must link the workflow')
  assert.ok(squash(doc.setup()).includes('## 5. Continuous integration'), 'docs/04 must document CI')
})

test('the CI workflow is valid YAML with the structure it claims', () => {
  const workflow = read('.github/workflows/ci.yml')

  // No YAML parser is available to the core service (zero dependencies), so check the
  // structural invariants that would break a run: tabs, duplicate job keys, and the
  // trigger configuration.
  assert.ok(!workflow.includes('\t'), 'YAML must not contain tabs')
  assert.ok(workflow.startsWith('name: CI'), 'the workflow must be named')
  assert.ok(/^on:/m.test(workflow), 'the workflow must declare triggers')
  assert.ok(workflow.includes('pull_request'), 'CI must run on pull requests')
  assert.ok(workflow.includes('jobs:'), 'the workflow must declare jobs')

  // The audit gates must also run on a schedule. Push and pull-request triggers only
  // re-run them when something changes, so an advisory published against code that is
  // already merged would otherwise wait for the next unrelated build.
  assert.ok(workflow.includes('schedule:'), 'CI must run on a schedule')
  const cron = workflow.match(/- cron: '([^']+)'/)
  assert.ok(cron, 'the schedule trigger must declare a cron expression')
  assert.equal(cron[1].split(/\s+/).length, 5, `cron must have five fields, got ${cron[1]}`)

  // Scope to the jobs: block. The on: trigger block is indented the same way, so an
  // unscoped /^  ([a-z]+):$/ also matched 'push:' and reported five jobs.
  const jobsBlock = workflow.slice(workflow.indexOf('\njobs:'))
  const jobs = [...jobsBlock.matchAll(/^  ([a-z]+):$/gm)].map((m) => m[1])
  assert.deepEqual(jobs, ['core', 'fabric', 'web', 'docs'], `unexpected job list: ${jobs.join(', ')}`)

  // Every job must check the code out before doing anything with it.
  const perJob = jobsBlock.split(/^  [a-z]+:$/m).slice(1)
  assert.equal(perJob.length, 4)
  for (const [index, body] of perJob.entries()) {
    assert.ok(body.includes('actions/checkout@'), `job ${jobs[index]} must check out the repository`)
    assert.ok(body.includes('run:'), `job ${jobs[index]} must actually run something`)
  }
})
