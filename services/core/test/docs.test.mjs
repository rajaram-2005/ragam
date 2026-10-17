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
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG, loadConfig } from '../src/config.mjs'
import { ELEVATED_SCOPES, FORBIDDEN_SCOPES } from '../src/plugins/manifest.mjs'
import { LIFECYCLE, DEFAULT_BUDGET } from '../src/godcore/lifecycle.mjs'
import { DEFAULT_ROUTING_WEIGHTS } from '../src/router/registry.mjs'
import { COMPETITOR_MARKERS, FAMILY_STANCE, KLYVARON, TIERS, familyReport, ownedArtifacts, tierClaimFor, tierClaimForArtifact } from '../src/klyvaron/tiers.mjs'
import { ACCELERATORS, ACCELERATOR_IDS } from '../src/hardware/accelerators.mjs'
import { MODALITY_MODELS, presetReport } from '../src/klyvaron/architecture.mjs'

const idMapOf = (plan) => Object.fromEntries(plan.tiers.map((t) => [t.id, t]))
const gateIn = (tier, id) => tier.gates.find((g) => g.id === id)
import { developmentPlan, GATES, GATE_STATES } from '../src/klyvaron/plan.mjs'

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
  lite: () => read('docs/08-aetheris-lite.md'),
  lmCard: () => read('docs/model-cards/aetheris-lite-lm-0.1.1.json'),
  lmSupersededCard: () => read('docs/model-cards/aetheris-lite-lm-0.1.0.json'),
  cycle: () => read('docs/07-improvement-cycle.md'),
  hermes: () => read('docs/10-hermes-audit.md'),
  klyvaron: () => read('docs/11-klyvaron-family.md'),
  differentiation: () => read('docs/22-klyvaron-differentiation.md'),
  trainingFree: () => read('docs/23-training-free-tiers.md'),
  ownModels: () => read('docs/24-own-models.md'),
  adaptive: () => read('docs/25-adaptive-intelligence.md'),
  matrix: () => read('docs/12-feature-matrix.md'),
  distillation: () => read('docs/09-distillation.md'),
  distillVerdict: () => read('docs/experiments/distillation-logit-vs-baseline.json'),
  l4Transfer: () => read('docs/experiments/l4-transfer.json'),
  lmVerification: () => read('docs/experiments/lm-verification-run-67cdd58.json'),
  lmCleanRun: () => read('docs/experiments/lm-verification-run-8d9cdf8.json'),
  readme: () => read('README.md'),
  env: () => read('.env.example'),
  notices: () => read('third-party/NOTICES.md'),
  accounts: () => read('docs/20-accounts-and-sign-in.md'),
  phase2: () => read('docs/19-online-only-phase-2.md'),
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
      // readSecret(env, 'LLAMACPP_API_KEY', 'LLAMACPP_API_KEY_FILE') passes the
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
  assert.equal(documented('AETHERIS_VIDEO_TIMEOUT_MS'), String(loaded.media.videoTimeoutMs))
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
  assert.equal(truthy(documented('AETHERIS_FABRIC_ENABLED')), loaded.fabric.enabled)
  assert.equal(truthy(documented('AETHERIS_GODMODE_ENABLED')), loaded.godMode.enabled)

  // Nothing that looks like a credential may carry a sample value, and the *_FILE
  // form must be offered so a secret need not sit in the process environment.
  for (const name of ['LLAMACPP_API_KEY']) {
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
  assert.equal(literal.size, 40, `literal /api routes changed: ${literal.size}`)
  assert.ok(squash(doc.architecture()).includes('40 literal routes'))

  for (const route of ['/api/health', '/api/ready', '/api/config', '/api/chat', '/api/chat/stream',
    '/api/models', '/api/models/probe', '/api/knowledge/search', '/api/plugins/validate',
    '/api/mcp/preflight', '/api/mcp/call', '/api/audit', '/api/hardware',
    '/api/memory', '/api/sessions', '/api/storage']) {
    assert.ok(literal.has(route), `${route} is documented but no longer routed`)
  }

  // These are matched on path segments, not as literals — asserting them as strings
  // was a bug in the first version of this test.
  const segments = new Set([...source.matchAll(/segments\[1\] === '([a-z]+)'/g)].map((m) => m[1]))
  assert.deepEqual([...segments].sort(),
    ['knowledge', 'mcp', 'media', 'memory', 'plugins', 'sessions', 'skills', 'tasks'])
  assert.ok(/segments\[2\] === 'artifact'/.test(source), 'the artifact route must stay segment-matched')
  const architecture = squash(doc.architecture())
  for (const prefix of ['tasks', 'plugins', 'mcp', 'media', 'knowledge', 'memory', 'sessions', 'skills']) {
    assert.ok(architecture.includes(`/api/${prefix}`), `docs/02 must mention segment routes under /api/${prefix}`)
  }

  // Routing is shown inside Chat, never promoted to its own area.
  assert.ok(!literal.has('/api/routes'))

  // Two different kinds of thing, and the distinction is the point.
  //
  // The first is user-owned data: documents, memories, conversations. Each gets a route
  // group because the person needs to list, edit and delete it -- and each of those is a
  // deliberate addition to this list, so a new one cannot appear by accident.
  const userDataGroups = new Set(['/api/knowledge', '/api/memory', '/api/sessions', '/api/skills'])
  for (const group of userDataGroups) {
    // A group can be expressed either way: /api/knowledge is routed by segments and
    // /api/memory by literals. Checking only the literals reported knowledge as unrouted,
    // which is an assertion about the mechanism rather than about the surface.
    const name = group.replace('/api/', '')
    assert.ok(literal.has(group) || segments.has(name),
      `${group} is an allowed user-data group but is no longer routed`)
  }
  // The second is internal services. These may be surfaced *inside* the five areas but
  // must never grow their own route group, because a route group is how a sixth area
  // starts. The list is a blocklist rather than a count, so adding one fails here whether
  // or not the total happens to stay the same.
  for (const route of literal) {
    if ([...userDataGroups].some((group) => route.startsWith(group))) continue
    assert.ok(!/policy|training|benchmark|safety|godcore|admin|research/.test(route),
      `${route} gives an internal service its own route group`)
  }
})

test('the docs-suite count in docs/04 matches the tests in this file', () => {
  // docs/04 describes this suite by size, and that number was the one count in the
  // repository with no guard on it: it read 28 while the file held 34 tests. A count a
  // document states is a claim like any other, so it is counted rather than trusted.
  const own = readFileSync(resolve(REPO, 'services/core/test/docs.test.mjs'), 'utf8')
  const tests = own.split('\n').filter((line) => line.startsWith('test(')).length
  assert.ok(squash(doc.setup()).includes(`${tests}-test documentation-accuracy suite`),
    `docs/04 must describe this suite as the ${tests}-test suite it is`)
})

test('every document that restates a suite total agrees with docs/03', () => {
  // docs/04 and docs/05 restate the suite totals in prose and in a CI table, and none
  // of it was checked: docs/04 read 765 / 267 / 442 / 260 / 256 and docs/05 read 256
  // while the suites were 853 / 269 / 528. A figure stated in three documents will
  // disagree with itself unless every copy is checked, so docs/03 -- which is pinned
  // to the filesystem above -- is the single source of truth here.
  const status = doc.status()
  const numberFor = (suite) => {
    const match = new RegExp(`\\| \`${suite}\` \\| [^|]+ \\| \\*\\*(\\d+) / \\d+\\*\\*`).exec(status)
    assert.ok(match, `docs/03 must state a total for ${suite}`)
    return Number(match[1])
  }
  const core = numberFor('services/core')
  const fabric = numberFor('services/fabric')
  const web = numberFor('apps/web')
  const total = core + web + fabric
  assert.ok(status.includes(`${total} passing`), `docs/03 must state the grand total ${total}`)

  // Each claim, with the figure it must carry. The wording is free; the number is not.
  const claims = [
    [doc.setup, `all three suites (${total} tests)`, `docs/04 must state the grand total ${total}`],
    [doc.setup, `# ${core}\n`, `docs/04 must state the core total ${core}`],
    [doc.setup, `# ${fabric} —`, `docs/04 must state the fabric total ${fabric}`],
    [doc.setup, `| **Core service** | ${core} tests pass`, `docs/04 CI table: core ${core}`],
    [doc.setup, `| **Fabric** | ${fabric} tests pass`, `docs/04 CI table: fabric ${fabric}`],
    [doc.setup, `| **Web app** | \`npm ci\`, ${web} tests`, `docs/04 CI table: web ${web}`],
    [doc.security, `${fabric} Fabric tests`, `docs/05 must state the fabric total ${fabric}`],
  ]
  for (const [read, phrase, message] of claims) {
    assert.ok(squash(read()).includes(squash(phrase)), message)
  }

  // The figures these lines used to carry. Kept as an explicit regression list: if a
  // suite total is restated here in one of the old forms, it is stale by construction.
  for (const [read, stale] of [
    [doc.setup, 'all three suites (765 tests)'], [doc.setup, '# 442 —'],
    [doc.setup, '| **Fabric** | 256 tests pass'], [doc.security, '256 Fabric tests'],
    [doc.setup, 'all three suites (854 tests)'], [doc.setup, 'npm run test:core         # 270'],
    [doc.status, '**270 / 270**'], [doc.status, '### `services/core` — Implemented and tested (270 tests)'],
    [doc.setup, 'all three suites (930 tests)'], [doc.status, '**346 / 346**'],
    [doc.setup, 'all three suites (932 tests)'], [doc.status, '**348 / 348**'],
    [doc.setup, 'all three suites (934 tests)'], [doc.status, '**350 / 350**'],
    [doc.setup, 'all three suites (1074 tests)'], [doc.status, '**445 / 445**'],
    [doc.setup, 'all three suites (1075 tests)'], [doc.status, '**562 / 562**'],
    [doc.setup, '| **Fabric** | 562 tests pass'], [doc.security, '562 Fabric tests'],
    [doc.setup, '| **Core service** | 445 tests pass'],
    [doc.setup, 'all three suites (1179 tests)'], [doc.status, '**528 / 528**'],
    // The Phase 2 total, kept so a document restating 722 in any of its forms fails here.
    [doc.status, '**722 / 722**'], [doc.status, 'Implemented and tested (722 tests)'],
    [doc.setup, 'npm run test:core         # 722'], [doc.setup, '| **Core service** | 722 tests pass'],
    [doc.readme, '1628 tests: core 722, web 92, fabric 814'], [doc.readme, 'All 1628 run in CI'],
    [doc.status, '**Test totals: 1628 passing'],
    [doc.status, '**76 / 76**'], [doc.setup, 'npm run test:core         # 528'],
    [doc.setup, '| **Web app** | `npm ci`, 76 tests'],
    [doc.status, '**84 / 84**'], [doc.status, '**Test totals: 1204 passing'],
    [doc.status, 'Implemented and tested (84 tests)'], [doc.status, '`apps/web`; 84 tests including'],
    [doc.status, '199.25 kB'], [doc.status, '61.46 kB gzip'],
    [doc.setup, 'npm test             # 84 tests'], [doc.setup, 'npm run test:web          # 84'],
    [doc.setup, 'all three suites (1204 tests)'], [doc.setup, '| **Web app** | `npm ci`, 84 tests'],
    [doc.readme, '1204 tests: core 545, web 84, fabric 575'], [doc.readme, 'All 1204 run in CI'],
    [doc.readme, '| 2,622 | 1,490 |'], [doc.architecture, '2,622 source lines, 1,490 test lines'],
    [doc.phase2, '84 Web + 575 Fabric = 1,204 tests'], [doc.phase2, '17 Core and 8 Web tests'],
    [doc.accounts, '**8 new tests** across `render.test.mjs` and `structure.test.mjs`'],
    [doc.architecture, '14,555 source lines, 11,712 test lines'],
    [doc.readme, '| 14,555 | 11,712 |'],
    [doc.status, '**545 / 545**'], [doc.status, '**89 / 89**'], [doc.status, '**Test totals: 1209 passing'],
    [doc.status, 'Implemented and tested (545 tests)'], [doc.status, 'Implemented and tested (89 tests)'],
    [doc.status, '`apps/web`; 89 tests including'], [doc.status, '`accounts.test.mjs` (16 tests)'],
    [doc.status, '199.64 kB'], [doc.status, '61.59 kB gzip'], [doc.status, '`test/render.test.mjs` (28 tests)'],
    [doc.setup, 'all three suites (1209 tests)'], [doc.setup, 'npm run test:core         # 545'],
    [doc.setup, 'npm run test:web          # 89'], [doc.setup, '| **Core service** | 545 tests pass'],
    [doc.setup, '| **Web app** | `npm ci`, 89 tests'], [doc.setup, 'npm test             # 89 tests'],
    [doc.readme, '1209 tests: core 545, web 89, fabric 575'], [doc.readme, 'All 1209 run in CI'],
    [doc.phase2, '545 Core + 89 Web + 575 Fabric = 1,209 tests'], [doc.phase2, '17 Core and 13 Web tests'],
    [doc.status, '**547 / 547**'], [doc.status, '**Test totals: 1213 passing'],
    [doc.status, 'Implemented and tested (547 tests)'], [doc.setup, 'all three suites (1213 tests)'],
    [doc.setup, 'npm run test:core         # 547'], [doc.setup, '| **Core service** | 547 tests pass'],
    [doc.readme, '1213 tests: core 547, web 91, fabric 575'], [doc.readme, 'All 1213 run in CI'],
    [doc.phase2, '547 Core + 91 Web + 575 Fabric = 1,213 tests'], [doc.phase2, '19 Core and 15 Web tests'],
    [doc.accounts, 'its 19 tests pass'], [doc.setup, '38-test documentation-accuracy suite'],
    [doc.status, '**617 / 617**'], [doc.status, 'Implemented and tested (617 tests)'],
    [doc.status, '**644 / 644**'], [doc.status, 'Implemented and tested (644 tests)'],
    [doc.status, '**647 / 647**'], [doc.status, 'Implemented and tested (647 tests)'],
    [doc.status, '**684 / 684**'], [doc.status, 'Implemented and tested (684 tests)'],
    [doc.setup, 'npm run test:core         # 684'], [doc.setup, '| **Core service** | 684 tests pass'],
    [doc.readme, '1590 tests: core 684, web 92, fabric 814'], [doc.readme, 'All 1590 run in CI'],
    [doc.status, '**Test totals: 1590 passing'],
    [doc.setup, 'npm run test:core         # 647'], [doc.setup, '| **Core service** | 647 tests pass'],
    [doc.readme, '1553 tests: core 647, web 92, fabric 814'], [doc.readme, 'All 1553 run in CI'],
    [doc.status, '**Test totals: 1553 passing'],
    [doc.setup, 'npm run test:core         # 644'], [doc.setup, '| **Core service** | 644 tests pass'],
    [doc.setup, 'npm run test:core         # 617'], [doc.setup, '| **Core service** | 617 tests pass'],
    [doc.readme, '1523 tests: core 617, web 92, fabric 814'], [doc.readme, 'All 1523 run in CI'],
    [doc.status, '**Test totals: 1523 passing'],
    // The Phase 5 total, and the README forms it was stated in while the component table had
    // already moved on: both documents are checked for each superseded shape.
    [doc.status, '**738 / 738**'], [doc.status, 'Implemented and tested (738 tests)'],
    [doc.status, '**Test totals: 1644 passing'],
    [doc.setup, 'all three suites (1644 tests)'], [doc.setup, 'npm run test:core         # 738'],
    [doc.setup, '| **Core service** | 738 tests pass'],
    [doc.readme, '1615 tests: core 709, web 92, fabric 814'], [doc.readme, 'All 1615 run in CI'],
    [doc.readme, '1644 tests: core 738, web 92, fabric 814'], [doc.readme, 'All 1644 run in CI'],
    // The Phase 6 total.
    [doc.status, '**753 / 753**'], [doc.status, 'Implemented and tested (753 tests)'],
    [doc.status, '**Test totals: 1659 passing'],
    [doc.setup, 'all three suites (1659 tests)'], [doc.setup, 'npm run test:core         # 753'],
    [doc.setup, '| **Core service** | 753 tests pass'],
    [doc.readme, '1659 tests: core 753, web 92, fabric 814'], [doc.readme, 'All 1659 run in CI'],
    // The Phase 7 total, superseded when the two regression tests above were added.
    [doc.status, '**762 / 762**'], [doc.status, 'Implemented and tested (762 tests)'],
    [doc.status, '**Test totals: 1668 passing'],
    [doc.setup, 'all three suites (1668 tests)'], [doc.setup, 'npm run test:core         # 762'],
    [doc.setup, '| **Core service** | 762 tests pass'],
    [doc.readme, '1668 tests: core 762, web 92, fabric 814'], [doc.readme, 'All 1668 run in CI'],
  ]) {
    assert.ok(!read().includes(stale), `stale suite total resurrected: ${stale}`)
  }
})

test('the documented module line counts match the filesystem', () => {
  const table = doc.architecture()
  // `[a-z/.]` silently excluded every module with a digit in its name, so
  // `knowledge/bm25.mjs` was never checked -- and its row set drifted unnoticed.
  const rows = [...table.matchAll(/^\| `([\w/.-]+\.mjs)` \| ([\d,]+) \|/gm)]
  assert.ok(rows.length >= 20, `expected the full module table, found ${rows.length} rows`)

  const countLines = (path) => readFileSync(resolve(CORE, 'src', path), 'utf8').split('\n').length - 1

  // Compare the documented set against the filesystem rather than trusting a count:
  // "at least 20 rows" passes when a module is missing, and a pattern that cannot see
  // a file is indistinguishable from a file that is not there.
  const onDisk = []
  const walkModules = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) walkModules(full)
      else if (entry.name.endsWith('.mjs')) onDisk.push(relative(resolve(CORE, 'src'), full))
    }
  }
  walkModules(resolve(CORE, 'src'))
  const documented = new Set(rows.map(([, file]) => file))

  const missing = onDisk.filter((file) => !documented.has(file)).sort()
  assert.deepEqual(missing, [],
    `every module must have a row; ${missing.join(', ')} is on disk but missing from the table`)
  assert.equal(rows.length, onDisk.length,
    `the table has ${rows.length} rows for ${onDisk.length} modules on disk`)

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
  assert.equal(quoted('Unlicense — sparsiz'), read('third-party/licenses/sparsiz-Unlicense.txt').trim())

  // NumPy's LICENSE.txt bundles component licences; only its own terms are quoted
  // inline, but the whole file must be preserved.
  const numpy = read('third-party/licenses/numpy-BSD-3-Clause.txt')
  assert.equal(quoted('BSD-3-Clause — NumPy'), numpy.split('\n----\n')[0].trim())
  assert.ok(numpy.length > 40_000, 'the full bundled NumPy licence must be preserved, not truncated')
  assert.ok(squash(notices).includes('bundles the licences of its individual components'))

  // MIT texts must really be MIT, and the Unlicense really the Unlicense.
  for (const file of ['aetheris-MIT.txt']) {
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
  // 35 includes the accounts suite (traditional sign-in), the online runtimes suite
  // (Ollama and llama.cpp on the online entry), the Klyvaron plan suite, the suites added
  // with the family's differentiation (tier stance and modality rules, the dated-source
  // ledger, the evidence-linked affect reader, the composition path with its accelerator
  // arithmetic), the suite covering the family's own architecture, and the adaptive
  // suites: routing/refusals, the loop that carries the first milestone, the skills
  // evaluation and permission suites, the emotional-states suite, and the provider fabric.
  // If a suite file is added or removed, the counts in docs/03-status.md and README.md have
  // to move with it.
  assert.equal(count('services/core/test', /\.test\.mjs$/), 43)
  assert.equal(count('apps/web/test', /\.test\.mjs$/), 4)
  assert.equal(count('services/fabric/tests', /^test_.*\.py$/), 39)

  const status = squash(doc.status())
  assert.ok(status.includes('**764 / 764**'), 'core total must be stated')
  assert.ok(status.includes('**814 / 814**'), 'fabric total must be stated')
  assert.ok(status.includes('**92 / 92**'), 'web total must be stated')
  assert.ok(status.includes('1670 passing'), 'the grand total must equal the sum of the suites')
  // README and docs/03 must state the *same* total. They disagreed for two phases: README said
  // 709/1615 in its setup snippet while its own component table said 738, and this assertion
  // pinned the stale form, so the contradiction passed every check. A total is stated in both
  // documents or it is stated in neither.
  assert.ok(squash(doc.readme()).includes('1670 tests: core 764, web 92, fabric 814'),
    'README must state the same totals as docs/03')
  assert.ok(squash(doc.readme()).includes('All 1670 run in CI'),
    'README must state the same totals where it describes CI')
  assert.ok(status.includes('(39 files'), 'the file count must move with the suite')

  // The component headings each state a count too, and they drifted from the table
  // in the same document without this: fabric's heading read 256 while the table
  // said 342. A number stated twice is a number that can disagree with itself, so
  // every occurrence is checked rather than just the one the table happens to hold.
  // Anchored to the component-heading form ("### `services/core` — ... (265 tests)")
  // so subsection counts like "(23 tests)" are not mistaken for components.
  const perComponent = [...doc.status().matchAll(/^### `[^`]+` [^(]*\((\d+) tests?\)/gm)].map((m) => Number(m[1]))
  assert.equal(perComponent.length, 3, `expected three component headings, found ${JSON.stringify(perComponent)}`)
  const fromHeadings = perComponent
  assert.ok(fromHeadings.includes(764), `core heading must say 764, found ${JSON.stringify(fromHeadings)}`)
  assert.ok(fromHeadings.includes(814), `fabric heading must say 814, found ${JSON.stringify(fromHeadings)}`)
  assert.ok(fromHeadings.includes(92), `web heading must say 92, found ${JSON.stringify(fromHeadings)}`)
  // And the headings must sum to the stated grand total, not merely contain it.
  assert.equal(
    fromHeadings.reduce((a, b) => a + b, 0),
    1670,
    `component headings sum to ${fromHeadings.reduce((a, b) => a + b, 0)}, grand total says 1234`,
  )
})

test('the setup guide describes the product that actually runs', () => {
  // §2 and §7 showed the legacy service's startup banner and told readers to install
  // Ollama and start the core with LLAMACPP_ENABLED=true. `npm run core` is the online
  // entry: it never reads that variable, has no local runtime, and answers an unconfigured
  // installation with setup_required. A setup guide for a different product is worse than
  // none -- it sends somebody to install a runtime that cannot be reached, and the report
  // that follows is "I signed in and cannot see the models or chat".
  const setup = squash(doc.setup())
  const raw = doc.setup()
  for (const claim of [
    'performs **no local inference and downloads no models**',
    'AETHERIS_LITELLM_TRUSTED_ORIGINS=http://127.0.0.1:4000 npm run core',
    '**exact origin**',
    'endpoint_blocked',
    'Aetheris online-only API listening',
    'AETHERIS_COOKIE_SAMESITE=none',
  ]) {
    assert.ok(setup.includes(squash(claim)), `docs/04 must state ${claim}`)
  }
  // The legacy instructions must not come back in either form: as a way to start the
  // active entry, or as an error the active entry can produce.
  assert.ok(!/LLAMACPP_ENABLED=true\s*\\\s*LLAMACPP_BASE_URL/.test(raw),
    'docs/04 must not present legacy runtime variables as a way to start the active entry')
  assert.ok(!setup.includes('no_model_available'),
    'that error belongs to the legacy router; the active entry reports setup_required')
  assert.ok(!setup.includes('aetheris-core listening'),
    'the legacy startup banner is not what npm run core prints')
  // And the local-gateway path must be reachable in the real code, not only on the page:
  // the trusted origin is compared exactly, and a private URL is refused without one.
  const gateway = readFileSync(resolve(CORE, 'src', 'online', 'gateway.mjs'), 'utf8')
  assert.match(gateway, /trustedOrigins\.includes\(url\.origin\)/,
    'the guide documents an exact-origin comparison; the code must still do that')
  assert.match(gateway, /endpoint_blocked/)
})

test('the account and sign-in document describes the code that implements it', () => {
  // Sign-in changed shape entirely: an operator token in a file became accounts with
  // passwords. Every number in that description is a claim about code, so each one is
  // read out of the module rather than trusted -- a documented "12 characters" next to an
  // enforced 8 is the kind of drift this suite exists to catch.
  const text = squash(doc.accounts())
  const accounts = read('services/core/src/online/accounts.mjs')
  const online = read('services/core/src/online/app.mjs')
  const number = (source, name) => Number(new RegExp(`export const ${name} = ([\\d_]+)`).exec(source)[1])

  assert.equal(number(accounts, 'PASSWORD_MIN_LENGTH'), 12, 'the enforced password minimum moved; docs/20 states 12')
  assert.ok(text.includes('Minimum length | 12 characters'), 'docs/20 must state the minimum it enforces')
  assert.equal(number(accounts, 'PASSWORD_MAX_LENGTH'), 256)
  assert.equal(number(accounts, 'MAX_FAILED_LOGINS'), 8)
  assert.ok(text.includes('Eight consecutive failures lock'), 'docs/20 must state the lockout rule')
  // Written as expressions in the module, so the expressions are what is compared: a
  // regex over digits alone would read `15 * 60_000` as 15 and pass against anything.
  assert.match(accounts, /export const LOCKOUT_MS = 15 \* 60_000/)
  assert.match(accounts, /export const RESET_CODE_TTL_MS = 15 \* 60_000/)
  assert.ok(text.includes('fifteen minutes'), 'docs/20 states the reset lifetime in the words the page uses')
  assert.equal(number(accounts, 'DEFAULT_MAX_ACCOUNTS'), 64)
  assert.ok(new RegExp('^AETHERIS_MAX_ACCOUNTS=64$', 'm').test(doc.env()), '.env.example must state the real default')
  assert.ok(new RegExp('^AETHERIS_PRINT_RESET_CODES=false$', 'm').test(doc.env()), '.env.example must ship the console-printing switch off')

  // The cookie policy an embedded deployment needs, and the refusal that keeps the
  // unusable combination from being served. Both are claims about code, so both are read
  // out of it: a documented `none` next to a service that only accepts `strict` would send
  // an operator chasing a variable that does nothing.
  assert.match(online, /export const COOKIE_SAME_SITE = Object\.freeze\(\['strict', 'lax', 'none'\]\)/)
  assert.ok(new RegExp('^AETHERIS_COOKIE_SAMESITE=strict$', 'm').test(doc.env()), '.env.example must ship the strict cookie default')
  assert.ok(text.includes('`SameSite=Strict` by default'), 'docs/20 must state the default cookie policy')
  assert.ok(text.includes('AETHERIS_COOKIE_SAMESITE=none'), 'docs/20 must state how an embedded deployment opts in')
  assert.ok(text.includes('refuses to start'), 'docs/20 must say the unusable combination is refused, not served')

  // scrypt work factors are stated in prose and stored in every hash, so the two agree.
  assert.match(accounts, /N: 16384, r: 8, p: 1, keyLength: 64, saltBytes: 16/)
  assert.ok(text.includes('scrypt, N=16384, r=8, p=1, 64-byte derived key'), 'docs/20 must state the work factors')

  // Session bounds, read from the module the routes actually use.
  assert.match(online, /ttlMs: 8 \* 3600_000, perAccount: 8, installation: 64/)
  for (const claim of ['Lifetime | 8 hours', 'Per account | 8', 'Per installation | 64']) {
    assert.ok(text.includes(claim), `docs/20 must state the session bound: ${claim}`)
  }

  // The removed mechanism must stay removed in the prose too: a guide that still tells
  // somebody to paste a token is a guide for a product that no longer exists.
  // The README may name the removed mechanism to say it is removed; what it must not do
  // is instruct anybody to use it. So the instruction is forbidden and the statement of
  // removal is required -- the distinction a bare keyword scan cannot make.
  const readme = squash(doc.readme())
  assert.doesNotMatch(readme, /Sign in using the Core host|paste it (?:here|into)/i,
    'the README must not instruct the removed token sign-in')
  assert.ok(readme.includes('access-token file and its login route have been removed'),
    'the README must state that the token sign-in is gone')
  assert.ok(readme.includes('create an account'), 'the README must tell the reader how to get in now')
  assert.doesNotMatch(squash(doc.phase2()), /paste it into the \*\*installation sign-in form\*\*/)
  assert.ok(squash(doc.phase2()).includes('Sign-in is an account, not a token'), 'docs/19 must point at the change')
  assert.ok(text.includes('Sign-up is open'), 'the account model states that registration is open')
  assert.ok(text.includes('first account created is the owner'), 'the owner rule is documented')

  // Reset delivery is the part most likely to be over-claimed, so the denial is checked
  // as carefully as the claim: no mail transport means no "check your inbox".
  assert.ok(text.includes('no mail transport'), 'docs/20 must say why a code cannot be emailed')
  assert.ok(text.includes('password-resets.json'), 'docs/20 must say where the code actually goes')
  // `withoutDisclaimers` matters here: the guide says it CANNOT email a reset link, and a
  // naive scan flags the denial as the claim.
  assert.doesNotMatch(withoutDisclaimers(doc.accounts()), /emails? (?:a|the) reset link|check your inbox/i)
  assert.ok(text.includes('can reset any password on this installation'),
    'the host-access consequence must be stated, not implied away')

  // And the guide must carry a limitations list, like every other document here.
  assert.ok(text.includes('## Not delivered'), 'docs/20 must state what it does not do')
  for (const gap of ['second factors', 'self-service account deletion', 'Email delivery']) {
    assert.ok(text.includes(gap), `docs/20 must list ${gap} as not delivered`)
  }
})

test('the documented language-model results match its committed model card', () => {
  // docs/08 states a perplexity, a baseline and a weights digest. The card JSON is
  // the artifact of record, generated from the run report. If the two disagree, one
  // of them is wrong and there is no way to tell which from reading either alone.
  //
  // The released card is 0.1.1; 0.1.0 stays committed as the superseded record and its
  // own guards follow below, because superseding an artifact is a status change and not
  // a licence to edit what it published.
  const card = JSON.parse(doc.lmCard())
  const text = squash(doc.lite())
  assert.equal(card.format, 'aetheris-model-card/v1')
  assert.equal(card.card.identifier, 'aetheris-lite-lm@0.1.1')
  assert.equal(card.card.status, 'released')
  assert.equal(card.card.supersededAt, null, 'a released card is not itself superseded')

  const metrics = card.card.metrics
  // Written out at the full precision the card records, not rounded for display.
  // (An earlier version of this line read `text.includes(metrics.weightsDigest ?? '')`,
  // which is vacuously true because the field does not exist and `?? ''` matches
  // everything. A guard that cannot fail is worse than no guard, because it looks
  // like one.)
  assert.ok(
    text.includes(card.card.weightsDigest),
    `docs/08 must state the card's weights digest ${card.card.weightsDigest.slice(0, 16)}`,
  )
  assert.ok(
    text.includes(metrics.validationPerplexity.toFixed(4)),
    `docs/08 must state the validation perplexity ${metrics.validationPerplexity.toFixed(4)}`,
  )
  assert.ok(
    text.includes(metrics.bestBaselinePerplexity.toFixed(4)),
    `docs/08 must state the baseline perplexity ${metrics.bestBaselinePerplexity.toFixed(4)}`,
  )
  assert.ok(
    text.includes(metrics.perplexityVsBigram.toFixed(6)),
    `docs/08 must state the gate ratio ${metrics.perplexityVsBigram.toFixed(6)}`,
  )
  assert.ok(
    text.includes(metrics.parameterCount.toLocaleString('en-US')),
    `docs/08 must state the parameter count ${metrics.parameterCount.toLocaleString('en-US')}`,
  )

  // The gate must actually have passed, not merely be described as if it did.
  assert.equal(card.runStatus, 'partial', 'the Aetheris Lite family pipeline is still incomplete')
  assert.ok(!card.card.validation.hardFailures || card.card.validation.hardFailures.length === 0)
  assert.ok(card.card.limitations.length >= 4, 'the card must list its own limitations')
  assert.ok(
    card.card.limitations.some((l) => l.includes('/api/chat')),
    'the card must say the model is not served as a chat assistant',
  )
  // docs/08 has to say the same thing, or the document and the card disagree about
  // the one claim most likely to be misread.
  assert.ok(text.includes('/api/chat'), 'docs/08 must state how the model behaves on /api/chat')
  // Tolerant on phrasing, strict on substance: the card's exact sentence and the
  // document's shorter phrasing both have to mean "this does not follow instructions".
  assert.ok(
    /follows no instructions|no instruction-following|does not follow instructions/.test(text),
    'docs/08 must say the model does not follow instructions',
  )

  assert.ok(
    card.card.limitations.some((l) => l.includes('model_not_instruction_tuned')),
    'the card must state the behaviour the route actually has',
  )
  assert.equal(card.corrections, undefined, 'the released card has nothing to correct')

  // The superseded card is still an artifact of record. One sentence in it was false: it
  // said the model was "deliberately not wired into /api/chat" while the route had been
  // resolving and refusing it with 501. Correcting a record silently is worse than leaving
  // it wrong, so the correction is on the card itself and every part of it is checked here
  // -- including that no measured value moved with it, and that the artifact it describes
  // is now labelled superseded in the document rather than deleted from it.
  const previous = JSON.parse(doc.lmSupersededCard())
  assert.equal(previous.card.identifier, 'aetheris-lite-lm@0.1.0')
  assert.equal(previous.corrections.length, 1, 'the one correction must be recorded, not implied')
  const [correction] = previous.corrections
  assert.ok(correction.was.includes('not wired into'), 'the correction must quote what it replaced')
  assert.ok(correction.now.includes('/api/chat') && correction.now.includes('model_not_instruction_tuned'))
  assert.equal(correction.measuredValuesChanged, false)
  assert.ok(!JSON.stringify(previous.card).includes('not wired into'),
    'the false sentence must be gone from the card body itself')
  // The Markdown card carries the same sentence twice and the same correction once.
  const markdown = squash(read('docs/model-cards/aetheris-lite-lm-0.1.0.md'))
  assert.ok(!markdown.includes('not wired into'))
  assert.ok(markdown.includes('model_not_instruction_tuned'))
  assert.ok(markdown.includes('Corrections'), 'the Markdown card must show the correction')

  // And the document has to say which artifact is which: the superseded figures stay, with
  // the reason, and the released card's figures are the headline.
  assert.ok(text.includes('superseded'), 'docs/08 must record the supersession')
  assert.ok(text.includes(previous.card.weightsDigest),
    'docs/08 must keep the superseded artifact\'s published digest')
  assert.ok(squash(read('docs/model-cards/aetheris-lite-lm-0.1.1.md')).includes('Supersedes'),
    'the released Markdown card must name what it supersedes')
})

test('the documented verification run matches the committed record', () => {
  // A second, independent training run of the released configuration. Its numbers are
  // quoted in docs/08, docs/11 and docs/03, so they are checked against the record the run
  // produced rather than against the prose that repeats them -- and the record is checked
  // for the two things that would make the quotes misleading: being presented as an
  // improvement, or being confused with the released model.
  const record = JSON.parse(doc.lmVerification())
  assert.equal(record.experiment, 'lm-release-configuration-reproduction')
  assert.equal(record.gate.verdict, 'released')
  assert.deepEqual(record.gate.hardFailures, [], 'the verification run must have passed the gate')
  assert.deepEqual(record.gate.softFailures, [])

  const text = squash(doc.lite())
  const runId = record.run.weightsDigest.slice(0, 12)
  assert.ok(text.includes(runId), `docs/08 must quote the verification digest ${runId}`)
  assert.ok(
    text.includes(record.run.parameterCount.toLocaleString('en-US')),
    `docs/08 must state the verification parameter count ${record.run.parameterCount}`,
  )
  assert.ok(
    text.includes(record.run.evaluation.perplexity.toFixed(4)),
    `docs/08 must state the verification perplexity ${record.run.evaluation.perplexity.toFixed(4)}`,
  )
  const best = record.run.evaluation.baselines.find((entry) => entry.name === record.run.evaluation.bestBaseline)
  assert.ok(
    text.includes(best.perplexity.toFixed(4)),
    `docs/08 must state the verification baseline ${best.perplexity.toFixed(4)}`,
  )
  assert.ok(
    text.includes(record.run.evaluation.perplexityVsBestBaseline.toFixed(6)),
    'docs/08 must state the verification ratio to the best baseline',
  )
  assert.ok(
    squash(doc.klyvaron()).includes(record.run.evaluation.perplexity.toFixed(4)),
    'docs/11 must carry the same verification perplexity',
  )

  // It must not be confused with the released model: a different corpus gave different
  // weights, and the cards are the records of the weights they describe.
  const released = JSON.parse(doc.lmCard()).card
  const superseded = JSON.parse(doc.lmSupersededCard()).card
  assert.notEqual(record.run.weightsDigest, released.weightsDigest)
  assert.notEqual(record.run.weightsDigest, superseded.weightsDigest)
  assert.notEqual(record.corpus.manifestDigest, released.artifacts.corpusManifest)
  assert.notEqual(record.releaseRun.weightsDigest, record.run.weightsDigest)

  assert.equal(record.releaseRun.weightsDigest, superseded.weightsDigest,
    'this record names the artifact that has since been superseded')

  // The serving evidence is the measured one: a base model loadable and reachable, and
  // refused where it would be misread as an assistant.
  assert.equal(record.serving.ready.capabilities.chat, false)
  assert.equal(record.serving.ready.capabilities.textCompletion, true)
  assert.equal(record.serving.chatUnpinned.status, 501)
  assert.equal(record.serving.chatUnpinned.error, 'model_not_instruction_tuned')
  assert.equal(record.serving.chatPinned.status, 200)
  assert.equal(record.serving.chatPinned.sentExternally, false)
  assert.equal(record.serving.crossImplementation.greedy_identical, true, 'the two implementations must agree')
  assert.ok(record.serving.crossImplementation.maxAbsLogitDelta < 1e-3)

  // The run's corpus was read from a working tree that was clean *at read time*, and the
  // report says -dirty because the revision used to be read after training. That reading
  // was checked rather than explained away: the revision's own text reproduces the digest.
  const reverified = record.corpusReverification
  assert.equal(reverified.matches, true)
  assert.equal(reverified.recomputedManifestDigest, record.corpus.manifestDigest)
  assert.ok(record.revision.startsWith(reverified.revision),
    'the record must still name the revision whose text the corpus came from')
  assert.ok(squash(doc.lite()).includes(reverified.recomputedManifestDigest.slice(0, 8)),
    'docs/08 must state the re-derived corpus digest')
  assert.ok(squash(doc.klyvaron()).includes('not a version bump'),
    'docs/11 must say the verification run is not a release')
})

test('the clean-revision run matches its committed record', () => {
  // The second verification run, and the first whose corpus can be rebuilt from a commit.
  // It is quoted in docs/08, docs/11 and docs/03, so the quotes are checked against the
  // record -- and the record is checked for the two things that would make them misleading:
  // presenting a different corpus as an improvement, and calling a verification run a release.
  const record = JSON.parse(doc.lmCleanRun())
  assert.equal(record.experiment, 'lm-release-configuration-reproduction')
  assert.equal(record.gate.verdict, 'released')
  assert.deepEqual(record.gate.hardFailures, [])
  assert.deepEqual(record.gate.softFailures, [])

  // Revision and corpus were read together, and the digest was re-derived from the commit.
  assert.ok(!record.revision.endsWith('-dirty'), 'this is the run without the uncommitted-tree caveat')
  assert.equal(record.corpusReverification.matches, true)
  assert.equal(record.corpusReverification.recomputedManifestDigest, record.corpus.manifestDigest)
  assert.equal(record.corpusReverification.revision, record.revision)

  const text = squash(doc.lite())
  assert.ok(text.includes(record.run.weightsDigest.slice(0, 12)),
    `docs/08 must quote the clean run's digest ${record.run.weightsDigest.slice(0, 12)}`)
  assert.ok(text.includes(record.corpus.manifestDigest.slice(0, 8)),
    'docs/08 must state the re-derived corpus digest')
  assert.ok(text.includes(record.run.parameterCount.toLocaleString('en-US')),
    `docs/08 must state ${record.run.parameterCount} parameters`)
  assert.ok(text.includes(record.run.evaluation.perplexity.toFixed(4)),
    `docs/08 must state the perplexity ${record.run.evaluation.perplexity.toFixed(4)}`)
  const best = record.run.evaluation.baselines.find((entry) => entry.name === record.run.evaluation.bestBaseline)
  assert.ok(text.includes(best.perplexity.toFixed(4)),
    `docs/08 must state the baseline ${best.perplexity.toFixed(4)}`)
  assert.ok(text.includes(record.run.evaluation.perplexityVsBestBaseline.toFixed(6)),
    'docs/08 must state the ratio to the best baseline')

  // Numbers that came from the neighbouring run's paragraph when this table was written:
  // the corpus total is arithmetic over the record's own byte counts, and the two throughput
  // figures are measurements. Both are pinned so a copy-paste cannot pass.
  const corpusTotal = (record.corpus.trainBytes + record.corpus.validationBytes).toLocaleString('en-US')
  assert.ok(text.includes(corpusTotal), `docs/08 must state the corpus total ${corpusTotal}`)
  assert.ok(text.includes(record.serving.deviceThroughput.tokensPerSecond.toFixed(1)),
    'docs/08 must state the measured device throughput')
  assert.ok(text.includes(record.serving.chatPinned.tokensPerSecond.toFixed(1)),
    'docs/08 must state the measured pinned-chat throughput')

  // Three artifacts, three corpora, three weight digests: none may be confused with another.
  // This run's artifact is the released one, and the artifact it superseded is the one the
  // record calls `releaseRun` -- so the released card and this record must agree, and the
  // superseded card and `releaseRun` must agree.
  const card = JSON.parse(doc.lmCard()).card
  const previous = JSON.parse(doc.lmVerification())
  const superseded = JSON.parse(doc.lmSupersededCard()).card
  const digests = new Set([record.run.weightsDigest, previous.run.weightsDigest, superseded.weightsDigest])
  assert.equal(digests.size, 3)
  const corpora = new Set([record.corpus.manifestDigest, previous.corpus.manifestDigest, superseded.artifacts.corpusManifest])
  assert.equal(corpora.size, 3)
  assert.equal(record.comparison.comparable, false, 'a different corpus is not a comparable measurement')
  assert.equal(record.run.weightsDigest, card.weightsDigest,
    'this run is the released artifact, and the released card is its record')
  assert.equal(record.run.fileDigest, card.artifacts.fileDigest)
  assert.equal(record.run.bytes, card.artifacts.bytes)
  assert.equal(record.corpus.manifestDigest, card.artifacts.corpusManifest)
  assert.equal(record.releaseRun.weightsDigest, superseded.weightsDigest,
    'the artifact this one superseded is the one the record calls the release run')
  assert.ok(squash(doc.klyvaron()).includes(record.run.evaluation.perplexity.toFixed(4)),
    'docs/11 must carry the same perplexity')

  // The tier record names this artifact too, and says what it is. Two records describing one
  // artifact drift apart unless something compares them, and this is the comparison: the run
  // digest, the file digest, the file size and the parameter count all have to agree, and the
  // status has to be the one a non-release carries.
  const backing = KLYVARON.lite.capabilities['text.completion'].backing
  assert.equal(backing.weightsDigest, record.run.weightsDigest,
    'the tier record and the run record must name the same weights')
  assert.equal(backing.artifactSha256, record.run.fileDigest,
    'the tier record and the run record must name the same file')
  assert.equal(backing.artifactBytes, record.run.bytes)
  assert.equal(backing.parameters, record.run.parameterCount)
  assert.equal(backing.artifact, `aetheris-lite-lm-${card.version}`,
    'the released artifact string must be the released card, id and version')
  assert.equal(backing.measurementsRecord ?? 'docs/experiments/lm-verification-run-8d9cdf8.json',
    'docs/experiments/lm-verification-run-8d9cdf8.json',
    'the tier record must point at the file the evidence lives in')
  // The superseded artifact's own record, checked against its own card.
  assert.equal(backing.supersededArtifact.weightsDigest, superseded.weightsDigest)
  assert.equal(backing.supersededArtifact.parameters, superseded.parameterCount)
  assert.equal(backing.supersededArtifact.card, 'docs/model-cards/aetheris-lite-lm-0.1.0.json')
  // And the tier may label all three names, because all three are Lite artifacts: the label
  // follows the backing record, while `supersededArtifact` says which one is not current.
  assert.equal(tierClaimForArtifact('aetheris-lite-lm', card.version), TIERS.LITE)
  assert.equal(tierClaimForArtifact('aetheris-lite-lm', '0.1.1-verify'), TIERS.LITE)
  assert.equal(tierClaimForArtifact('aetheris-lite-lm', '0.1.0'), TIERS.LITE)

  // The serving evidence is measured, and the update/rollback exercise must be recorded with
  // the defect it found rather than only with the numbers that now look right.
  assert.equal(record.serving.ready.capabilities.chat, false)
  assert.equal(record.serving.chatUnpinned.status, 501)
  assert.equal(record.serving.chatPinned.status, 200)
  assert.equal(record.serving.chatPinned.sentExternally, false)
  assert.equal(record.serving.crossImplementation.greedy_identical, true)
  assert.ok(record.serving.crossImplementation.maxAbsLogitDelta < 1e-3)
  assert.equal(record.serving.deviceThroughput.requestedTokens > record.serving.deviceThroughput.generatedTokens,
    true, 'the manifest’s generation ceiling must be visible in the measurement')
  const update = record.serving.storeUpdateAndRollback
  const installs = update.steps.filter((step) => step.weightsSha256 && !step.error)
  assert.deepEqual(installs.map((step) => step.version), ['0.1.0-verify', '0.1.1-verify', '0.1.0-verify'])
  assert.equal(installs[0].weightsSha256, installs[2].weightsSha256, 'the rollback restores the digest')
  assert.notEqual(installs[0].weightsSha256, installs[1].weightsSha256, 'the update changed the weights')
  assert.ok(update.steps.some((step) => step.error === 'already_installed'))
  assert.ok(update.steps.some((step) => step.error === 'digest_mismatch'))
  // The record must not disagree with itself about its own arithmetic: the growth factor and
  // the pass count are printed in prose, so they are recomputed from the record's own fields.
  const expectedGrowth = Number(((record.corpus.trainBytes + record.corpus.validationBytes)
    / record.releaseRun.corpusSize).toFixed(3))
  assert.equal(record.comparison.corpusGrowth, expectedGrowth)
  assert.ok(record.comparison.explanation.includes(`${expectedGrowth}x`),
    `the prose must carry the same growth factor, ${expectedGrowth}x`)
  assert.equal(record.comparison.trainCorpusPasses,
    Number((record.run.tokensSeen / record.corpus.trainTokens).toFixed(3)))

  assert.ok(update.finding.includes('2,898,235'), 'the defect the exercise found must be stated')
  assert.ok(squash(doc.lite()).includes('2,898,235'), 'docs/08 must state what the defect cost')

  // The same artifact was installed and served again *after* the version was promoted -- with
  // the export the model card describes, no `-verify` qualifier. Two captures of one weight file
  // under two version strings are what makes the difference between them checkable, and the
  // second capture has to agree with the card the family publishes.
  const released = record.servingReleased
  assert.equal(released.installedAs, `aetheris-lite-lm@${card.version}`)
  assert.equal(released.weightsSha256, card.artifacts.fileDigest,
    'the released export must be the file the card describes')
  assert.equal(released.sameWeightsAsDrill, true,
    'the drill and the released export must be the same bytes')
  assert.equal(released.installedBytes, record.serving.installedBytes - 14,
    'the only difference between the two captures is the shorter version string')
  assert.equal(released.models.tier, TIERS.LITE)
  assert.equal(released.models.aetherisLite, true)
  assert.equal(released.models.measured.probeDetail.tierClaim, TIERS.LITE)
  assert.equal(released.ready.loaded[0].tierClaim, TIERS.LITE)
  assert.equal(released.chatUnpinned.status, 501)
  assert.equal(released.chatPinned.status, 200)
  assert.equal(released.chatPinned.sentExternally, false)
  assert.equal(released.crossImplementation.greedy_identical, true)
  assert.ok(released.crossImplementation.maxAbsLogitDelta < 1e-3)
})

test('the documented distillation result matches the committed experiment record', () => {
  // A negative result is the easiest kind to soften in prose and the easiest to get
  // wrong in transcription, so the numbers are read from the record and required to
  // appear. Phrasing is free; the measurements are not.
  const record = JSON.parse(doc.distillVerdict())
  // U+2212 (typographic minus) is what a document *should* use in prose, and it is not
  // the ASCII '-' that toFixed produces. Normalising here keeps the check strict about
  // the number while leaving the document free to be typeset properly.
  const text = squash(doc.distillation()).replace(/\u2212/g, '-')

  assert.equal(record.experiment, 'logit-distillation-vs-baseline')
  assert.equal(record.runs.length, 6, 'three seeds, two arms')
  assert.equal(record.budget.steps, 300)

  // The verdict, spelled as the record computed it. Tolerant on phrasing, strict on
  // substance: the document may write it as a sentence, but it has to say it, and it
  // has to say the word the record computed rather than a softer synonym.
  assert.ok(
    new RegExp(`Verdict[^.]*${record.verdict}`, 'i').test(text),
    `docs/09 must state the computed verdict ${record.verdict.toUpperCase()}`,
  )

  // Every paired measurement, to the precision the document claims.
  for (const run of record.runs) {
    const value = run.nllNatsPerToken.toFixed(6)
    assert.ok(text.includes(value), `docs/09 must state the measured nll ${value} (seed ${run.seed}, ${run.arm})`)
  }

  // The summary: the mean gain, and the counts that decided the verdict.
  assert.ok(text.includes(record.summary.meanGain.toFixed(6)),
    `docs/09 must state the mean gain ${record.summary.meanGain.toFixed(6)}`)
  assert.ok(text.includes(`${record.summary.seedsReversed} of ${record.summary.seedCount}`),
    'docs/09 must state how many seeds reversed')

  // The teacher is identified by digest, and the record must agree with it.
  assert.ok(text.includes(record.teacher.weightsDigest.slice(0, 12)),
    'docs/09 must identify the teacher by its weights digest')

  // The baseline must be described as not forwarding the teacher at all, because that
  // is what makes the two arms' costs comparable.
  const baseline = record.runs.filter((run) => run.arm === 'baseline')
  assert.equal(baseline.length, 3)
  assert.ok(baseline.every((run) => run.teacherForwards === 0))
  const distilled = record.runs.filter((run) => run.arm === 'distilled')
  assert.ok(distilled.every((run) => run.teacherForwards === record.budget.steps))
  assert.ok(/0 teacher forwards|never forwards the teacher|does not forward the teacher/.test(text),
    'docs/09 must record that the baseline never runs the teacher')

  // And the credentialed path must still be declared unrun. This is the claim that
  // would be easiest to lose: nothing in the repository can test a provider.
  assert.ok(/never been run against a (real |live )?provider/.test(text),
    'docs/09 must state that the external path has never run against a provider')
  assert.ok(/requires external credentials/i.test(text),
    "docs/09 must label the external path 'requires external credentials'")
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
  // Every component states its line counts in the same prose header, and each one
  // has drifted at least once: fabric said 5,592/3,583 while the filesystem said
  // 7,113/4,903, and web's test count said 1,100 while the filesystem said 1,185.
  // Checking all of them is the only way the class of drift stops recurring.
  const expect = (label, claimedSource, claimedTests, actualSource, actualTests) => {
    assert.equal(claimedSource, actualSource, `${label} source is ${actualSource} lines, docs claim ${claimedSource}`)
    assert.equal(claimedTests, actualTests, `${label} tests are ${actualTests} lines, docs claim ${claimedTests}`)
  }
  // Parsed by splitting the header rather than by building a RegExp from the name:
  // escaping a path into a pattern is how the previous version of this test broke.
  const headers = new Map()
  for (const line of doc.architecture().split('\n')) {
    const match = line.match(/^### `([^`]+)` — ([\d,]+) source lines, ([\d,]+) test lines/)
    if (match) headers.set(match[1], [Number(match[2].replace(/,/g, '')), Number(match[3].replace(/,/g, ''))])
  }
  const headerFor = (name) => {
    const found = headers.get(name)
    assert.ok(found, `${name} must state its source and test line counts, found: ${[...headers.keys()]}`)
    return found
  }

  const [fabricSource, fabricTests] = headerFor('services/fabric')
  expect('fabric', fabricSource, fabricTests,
    countLines(resolve(REPO, 'services/fabric/fabric')),
    countLines(resolve(REPO, 'services/fabric/tests')))

  const [webSource, webTests] = headerFor('apps/web')
  const countFiles = (dir, extensions) => {
    let total = 0
    const walk = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = resolve(current, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== '.render-build' && entry.name !== 'node_modules') walk(full)
        } else if (extensions.some((e) => entry.name.endsWith(e))) {
          total += readFileSync(full, 'utf8').split('\n').length - 1
        }
      }
    }
    walk(dir)
    return total
  }
  const [coreSource, coreTests] = headerFor('services/core')
  // Counted with the same helper as web: countLines above is Python-only, so using it
  // here measured 0 lines of a 7,432-line directory and the guard passed anyway.
  expect('core', coreSource, coreTests,
    countFiles(resolve(REPO, 'services/core/src'), ['.mjs']),
    countFiles(resolve(REPO, 'services/core/test'), ['.mjs']))

  expect('web', webSource, webTests,
    countFiles(resolve(REPO, 'apps/web/src'), ['.jsx', '.js', '.css']),
    countFiles(resolve(REPO, 'apps/web/test'), ['.mjs']))
})

test('the README component table matches the filesystem and docs/02', () => {
  // The whole README table was stale -- core read 7,380/5,237/260 while the filesystem
  // said 7,432/5,620/268 -- because nothing read it. docs/02 was checked and README was
  // not, so the same figures were right in one document and wrong in the other.
  const count = (dir, extensions) => {
    let total = 0
    const walk = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = resolve(current, entry.name)
        if (entry.isDirectory()) {
          if (!['node_modules', '__pycache__', '.render-build'].includes(entry.name)) walk(full)
        } else if (extensions.some((e) => entry.name.endsWith(e))) {
          total += readFileSync(full, 'utf8').split('\n').length - 1
        }
      }
    }
    walk(dir)
    return total
  }

  const rows = [...doc.readme().matchAll(
    /^\| `([\w/-]+)` \| [^|]+ \| ([\d,]+) \| ([\d,]+) \| [^|]+ \| (\d+) \|/gm)]
  assert.equal(rows.length, 3, `expected three component rows, found ${rows.length}`)

  const truth = {
    'services/core': [count(resolve(REPO, 'services/core/src'), ['.mjs']),
                      count(resolve(REPO, 'services/core/test'), ['.mjs'])],
    'services/fabric': [count(resolve(REPO, 'services/fabric/fabric'), ['.py']),
                        count(resolve(REPO, 'services/fabric/tests'), ['.py'])],
    'apps/web': [count(resolve(REPO, 'apps/web/src'), ['.jsx', '.js', '.css']),
                 count(resolve(REPO, 'apps/web/test'), ['.mjs'])],
  }

  for (const [, name, claimedSource, claimedTests, claimedCount] of rows) {
    const actual = truth[name]
    assert.ok(actual, `README lists an unknown component: ${name}`)
    assert.equal(Number(claimedSource.replace(/,/g, '')), actual[0],
      `README says ${name} has ${claimedSource} source lines, the filesystem says ${actual[0]}`)
    assert.equal(Number(claimedTests.replace(/,/g, '')), actual[1],
      `README says ${name} has ${claimedTests} test lines, the filesystem says ${actual[1]}`)

    // The test count must agree with docs/03, which counts test files itself. Two
    // documents stating the same figure is how a figure drifts apart.
    const status = squash(doc.status())
    const heading = new RegExp(`### \`${name}\` [^(]*\\((\\d+) tests?\\)`).exec(doc.status())
    assert.ok(heading, `docs/03 must state a test count for ${name}`)
    assert.equal(claimedCount, heading[1],
      `README says ${name} has ${claimedCount} tests, docs/03 says ${heading[1]}`)
    assert.ok(status.includes(claimedCount), `docs/03 must also state ${claimedCount}`)
  }
})

test('every documented file actually exists', () => {
  // Catches the docs-only failure mode: a guide that points at a file nobody wrote.
  const referenced = new Set()
  for (const text of [doc.architecture(), doc.security(), doc.setup(), doc.status(), doc.readme(), doc.benchmarks(), doc.lite()]) {
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
    'third-party/licenses/sparsiz-Unlicense.txt',
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

test('the Klyvaron document matches the family it describes', () => {
  // The document states a tier table and a set of model measurements. Both are read
  // from the module and the card rather than trusted, because a document describing a
  // model family is exactly where a capability claim starts drifting from the code.
  const report = familyReport()
  assert.equal(report.valid, true, 'docs/11 describes an invalid family')
  const text = squash(doc.klyvaron())

  // Parsed as a table rather than matched as a phrase. The first version of this check
  // used `${displayName}[^|]*${status}`, which cannot cross a cell boundary, so it
  // failed on a document that states the status correctly one cell to the right.
  const tierRows = new Map()
  for (const line of doc.klyvaron().split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 6) continue
    const name = cells[1].replace(/[*`]/g, '')
    if (report.tiers.some((t) => t.displayName === name)) tierRows.set(name, cells)
  }
  assert.equal(tierRows.size, report.tiers.length,
    `docs/11 must table every tier; found ${[...tierRows.keys()]}`)

  for (const tier of report.tiers) {
    const cells = tierRows.get(tier.displayName)
    assert.ok(cells[2], `${tier.displayName} must state its hardware class`)
    // The status word is the whole point of the document: a tier presented without its
    // status is a tier presented as a product.
    assert.equal(cells[3].replace(/[*`]/g, '').toLowerCase(), tier.status,
      `${tier.displayName} row says '${cells[3]}'; the module says '${tier.status}'`)
    assert.equal(cells[4], `${tier.availableCapabilities.length} of ${tier.capabilityCount}`,
      `${tier.displayName} availability cell disagrees with the module`)
  }

  // The storage numbers in the document are the numbers the code enforces.
  assert.ok(text.includes('5 GB total, strictly below'), 'docs/11 must state the mobile budget')
  assert.ok(text.includes('500 MB reserve'))
  assert.ok(text.includes('1.5 GB per-primary-model'))

  // The one claim the document most needs to keep: that Lite does not chat.
  const chat = KLYVARON.lite.capabilities.chat
  assert.equal(chat.state, 'unavailable')
  // The phrasing changed with the code: the model is now reachable over /api/chat and
  // refused there, so the claim to guard is the refusal, not an absence of wiring.
  assert.ok(text.includes('It does not chat.'), 'docs/11 must state that Lite does not chat')
  assert.ok(text.includes('an unpinned chat request is refused with `model_not_instruction_tuned` (501)'),
    'docs/11 must describe the refusal rather than claiming the model is unreachable')

  // A tier label is a lookup, and the second artifact is evidence rather than a release.
  // Both sentences are pinned here because both are the kind of claim a document relaxes
  // first when it starts describing what it wishes were true.
  assert.ok(text.includes('lookup by artifact'), 'docs/11 must say a tier label is looked up')
  assert.ok(text.includes('`tier: null`'), 'docs/11 must state what an unbacked declaration gets')
  // The hierarchy is a hierarchy: the released artifact and the superseded one are both
  // named, and both may carry the label -- a device that has not updated is still running
  // a Klyvaron Lite model, and a rolled-back device is running one on purpose.
  const backing = KLYVARON.lite.capabilities['text.completion'].backing
  assert.equal(tierClaimForArtifact('aetheris-lite-lm', '0.1.1'), TIERS.LITE)
  assert.equal(tierClaimForArtifact('aetheris-lite-lm', '0.1.0'), TIERS.LITE, 'the superseded artifact')
  assert.equal(tierClaimForArtifact('aetheris-lite-lm', backing.alsoKnownAs[0].replace('aetheris-lite-lm-', '')),
    TIERS.LITE, 'the same bytes under the label the drill installed them with')
  assert.ok(text.includes('superseded'), 'docs/11 must say which artifact was superseded')

  // And its measurements come from the card, so the two cannot disagree. Field paths are
  // taken from the card's real shape (`card.metrics.*`, `card.weightsDigest`), which the
  // first version of this check guessed at -- `card.evaluation` does not exist.
  const card = JSON.parse(doc.lmCard()).card
  assert.equal(backing.measured.validationPerplexity, card.metrics.validationPerplexity,
    'the family record and the model card must agree on perplexity')
  assert.equal(backing.measured.perplexityVsBestBaseline, card.metrics.perplexityVsBigram,
    'the family record and the model card must agree on the ratio to baseline')
  assert.equal(backing.parameters, card.parameterCount)
  assert.equal(backing.weightsDigest, card.weightsDigest,
    'the family record and the model card must agree on the weights digest')
  assert.ok(text.includes(card.weightsDigest), 'docs/11 must quote the real weights digest')
  // The document quotes the rounded figures; check the rounding rather than the full float.
  assert.ok(text.includes(card.metrics.validationPerplexity.toFixed(4)),
    `docs/11 must state the perplexity ${card.metrics.validationPerplexity.toFixed(4)}`)
  assert.ok(text.includes(card.metrics.bestBaselinePerplexity.toFixed(4)),
    'docs/11 must state the baseline perplexity')
})

test('the feature matrix uses the four statuses and claims no parity', () => {
  const text = squash(doc.matrix())
  // The four statuses, each defined. A matrix with undefined words is decoration.
  // Every status is pinned by its DEFINITION, not by its name. A control run showed the
  // difference: deleting the Unsupported definition still passed, because the word
  // "**Unsupported**" appears in a dozen table cells. A term used without a definition is
  // exactly the decoration this section exists to prevent.
  for (const definition of [
    '**Completed** means implemented in this repository and exercised by a test',
    '**Partial** means implemented with a named limitation',
    '**Planned** means designed, no code',
    '**Unsupported** means no implementation and no accepted design',
  ]) {
    assert.ok(text.includes(definition), `the matrix must define every status: missing '${definition}'`)
  }
  // The tier-label row names the enforcement that exists. The earlier wording credited a
  // function that compared an unversioned id and therefore returned null for every loaded
  // artifact; the row now has to name the versioned lookup and the refusal to label an
  // unbacked declaration.
  assert.ok(text.includes('tierClaimForArtifact()'),
    'docs/12 must name the versioned lookup the core actually uses')
  assert.ok(text.includes("declares `tier: 'pro'`"),
    'docs/12 must name the test that proves an unbacked declaration gets no label')

  // The five areas, named.
  for (const area of ['## 1. Conversation (the Chat area)', '## 2. Image', '## 3. Video',
    '## 4. Plugins', '## 5. MCP']) {
    assert.ok(text.includes(squash(area)), `the matrix must cover ${area}`)
  }
  // A sixth top-level area would contradict the directive's five-area rule.
  assert.ok(!/^## \d+\. (Training|Memory|Model Management|Agents|Admin|Benchmarking) /m.test(doc.matrix()),
    'the matrix must not introduce a sixth top-level area')
  // And the honesty clauses that keep the matrix from becoming a sales table.
  assert.ok(/no row claims parity with a named competitor/i.test(text))
  assert.ok(/No (image|video) provider is configured/.test(text),
    'a capability with no provider must say so rather than imply one is available')
})

test('the learning-level tables match the modules that implement them', () => {
  // docs/11 states a status for each of the six levels. Three of them name a module in
  // this repository, so the document and the code can be checked against each other: a
  // level marked implemented whose module is gone is the exact drift this catches.
  const text = squash(doc.klyvaron())
  const levels = new Map()
  for (const line of doc.klyvaron().split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 7) continue
    const id = /^\*\*(L\d)\*\*/.exec(cells[1])
    if (id) {
      // The status cell may carry an explanation after an em dash, and it SHOULD when the
      // status is Partial: a partial level with no reason is the thing worth refusing.
      // Comparing the whole cell rejected a correct row, so the status word is extracted
      // and the explanation is required separately, below.
      const cell = cells[5].replace(/[*`]/g, '')
      const [status, ...rest] = cell.split('—')
      levels.set(id[1], { status: status.trim(), note: rest.join('—').trim() })
    }
  }
  assert.equal(levels.size, 6, `docs/11 must table all six levels; found ${[...levels.keys()]}`)

  // The levels this repository actually implements, each tied to its file.
  const implemented = {
    L1: 'services/core/src/app.mjs',
    L2: 'services/core/src/memory/store.mjs',
    L3: 'services/core/src/skills/lifecycle.mjs',
    L6: 'services/fabric/fabric/modelcards.py',
  }
  for (const [level, file] of Object.entries(implemented)) {
    assert.equal(levels.get(level).status, 'Implemented and tested',
      `docs/11 marks ${level} as '${levels.get(level).status}' while ${file} exists`)
    assert.ok(exists(resolve(REPO, file)), `${level} names ${file}, which is not present`)
  }
  // The two partial levels say Partial rather than claiming completion, and each states
  // what the gap is: L4's transfer testing and L5's three blocked stages.
  for (const level of ['L4', 'L5']) {
    assert.equal(levels.get(level).status, 'Partial', `docs/11 must mark ${level} Partial`)
    assert.ok(levels.get(level).note.length > 20,
      `${level} is Partial and must say why; the note is '${levels.get(level).note}'`)
  }

  // And the memory claims in the document match the store's actual behaviour.
  assert.ok(text.includes("CHECK (approved_by = 'user')"),
    'docs/11 must state how an agent-approved memory is prevented')
  assert.ok(text.includes("CHECK (training_use = 'prohibited')"))
})

test('the memory interface the documents claim is the one that is in the app', () => {
  // docs/11 §2.2b and docs/12 both state that Level 2 is reachable from Chat rather than
  // API-only: that proposals can be approved in the interface, that memory can be listed,
  // edited, deleted, searched and exported, and that using it is a switch that starts off.
  // Documentation claiming an interface is the same failure mode as documentation claiming
  // a capability, so the claims are checked against the component that has to contain them.
  const chat = readFileSync(resolve(REPO, 'apps/web/src/areas/ChatArea.jsx'), 'utf8') + '\n' + readFileSync(resolve(REPO, 'apps/web/src/components/ContextPanels.jsx'), 'utf8')
  const affordances = {
    'list memories': /\{memories\.length \? \(/,
    'add a memory': /api\.remember\(/,
    'edit a memory': /api\.updateMemory\(/,
    'delete a memory': /api\.forgetMemory\(/,
    'delete everything': /api\.forgetAllMemory\(/,
    'search memory': /api\.searchMemory\(/,
    'export memory': /api\.exportMemory\(/,
    'approve a proposal': /api\.decideMemory\(candidate\.id, true\)/,
    'reject a proposal': /api\.decideMemory\(candidate\.id, false\)/,
    'a switch that starts off': /\[useMemory, setUseMemory\] = useState\(false\)/,
    'search your own turns': /api\.recall\(/,
    'delete a session': /api\.deleteSession\(/,
  }
  const missing = Object.entries(affordances).filter(([, pattern]) => !pattern.test(chat))
  assert.deepEqual(missing.map(([name]) => name), [],
    `the documents claim a memory interface; Chat is missing: ${missing.map(([name]) => name).join(', ')}`)

  // docs/12 marks memory Completed and history Partial. Completed is only allowed while the
  // affordances above exist, and the history row's stated reason has to be true: the search
  // is lexical, which is what "not semantic" means, so the store must actually use BM25.
  const rows = new Map()
  for (const line of doc.matrix().split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim())
    if (cells.length < 4) continue
    rows.set(cells[1], { status: cells[2].replace(/[*`]/g, ''), note: cells[3] })
  }
  const memory = rows.get('Memory the user can inspect and delete')
  assert.equal(memory.status, 'Completed', `memory row says '${memory.status}'`)
  const history = rows.get('Conversation history + search')
  assert.equal(history.status, 'Partial', 'history is partial: its search is lexical')
  assert.match(history.note, /lexical/i, 'the partial reason must be the search, and must say so')
  assert.match(readFileSync(resolve(CORE, 'src/memory/store.mjs'), 'utf8'), /Bm25Index/,
    'docs/12 calls the history search lexical; the store must actually be a lexical index')
  // docs/11 names the two panels. Both titles are strings in the component above, so the
  // document cannot describe a panel that was never built.
  const klyvaron = squash(doc.klyvaron())
  for (const title of ['Memory you approved', 'Conversation history']) {
    assert.ok(klyvaron.includes(`**${title}**`), `docs/11 must name the '${title}' panel`)
    assert.ok(chat.includes(`title="${title}"`), `docs/11 names a '${title}' panel the app does not render`)
  }
})

test('the memory interface the documents describe is the one in the app', () => {
  // docs/11 §2.2b and docs/12 both tell a reader that the approval gate is reachable from
  // Chat, that the panel lists, edits, deletes, searches and exports, and that the
  // composer's memory switch starts off. Every one of those is a sentence a reader will
  // act on, and until this test existed none of them was connected to any code: the panel
  // could have been deleted and the documents would still have claimed it.
  const chat = readFileSync(resolve(REPO, 'apps/web/src/areas/ChatArea.jsx'), 'utf8') + '\n' + readFileSync(resolve(REPO, 'apps/web/src/components/ContextPanels.jsx'), 'utf8')
  const matrix = squash(doc.matrix())
  const store = readFileSync(resolve(REPO, 'services/core/src/memory/store.mjs'), 'utf8')

  const affordances = [
    ['the decision route Chat calls for approve and reject', () => chat.includes('decideMemory(candidate.id, true)') && chat.includes('decideMemory(candidate.id, false)')],
    ['editing a memory in the panel', () => chat.includes('api.updateMemory(')],
    ['deleting one memory', () => chat.includes('api.forgetMemory(')],
    ['deleting all of them', () => chat.includes('api.forgetAllMemory(')],
    ['searching memories', () => chat.includes('api.searchMemory(')],
    ['searching past turns', () => chat.includes('api.recall(')],
    ['exporting a copy', () => chat.includes('api.exportMemory()')],
    ['the memory switch in the composer, off by default', () => /useState\(false\)/.test(chat) && /useMemory/.test(chat)],
  ]
  for (const [what, present] of affordances) {
    assert.ok(present(), `docs describe ${what}, and apps/web/src/areas/ChatArea.jsx does not have it`)
  }

  // The rows that make claims about this surface must still say what is true of it.
  assert.match(matrix, /L2 user-approved memory \| \*\*Implemented and tested\*\*/, 'the L2 row must stay honest about what it is')
  assert.match(matrix, /Learned procedures visible and controllable \| \*\*Archived\*\*/,
    'the skills surface is in the same panel area and must be stated in the matrix')
  assert.doesNotMatch(chat, /SkillsPanel/, 'research skills are not in the active online product')

  // And the history row: the note says the search is lexical rather than semantic, which
  // is a claim about the implementation, so the implementation is what is checked.
  assert.match(matrix, /Conversation history \+ search \| \*\*Partial\*\*/, 'the history row must stay Partial until its search is semantic')
  assert.match(matrix, /search is lexical \(BM25 over your own turns\), not semantic/,
    'the history note must name the method a reader is relying on')
  assert.match(store, /this\.turnIndex = new Bm25Index\(\)/,
    'the note says the search is BM25 over your own turns, so it has to be')

  // The composer default is a safety property, not a style choice, so it is named here
  // rather than left to the web suite alone.
  assert.match(chat, /\[useMemory, setUseMemory\] = useState\(false\)/,
    'memory must not reach a prompt unless the person switches it on')
})

test('the L4 transfer numbers quoted in the documents are the recorded ones', () => {
  // docs/03, docs/06, docs/07, docs/11 and docs/12 all state what the transfer
  // experiment found. Five documents quoting one result is five chances for the
  // result to drift, and a drifted benchmark number is worse than a missing one
  // because it reads as measured. The recorded artifact is the source, so the
  // documents are checked against it rather than against each other.
  const recorded = JSON.parse(doc.l4Transfer())
  const report = recorded.report
  assert.ok(report, 'the recorded artifact must carry a report block')

  // The verdict vocabulary, not just the word: "no_lesson" here means nothing cleared
  // the pre-registered bar, and every held-out family is an observation.
  assert.equal(report.verdicts['development-low'], 'no_lesson',
    'the recorded verdict is what the documents must describe')
  for (const family of ['held-out-low', 'held-out-high', 'development-high']) {
    assert.equal(report.verdicts[family], 'observed',
      `${family} was never a transfer and must stay recorded as an observation`)
  }
  assert.equal(report.development['lesson'], null, 'no lesson qualified, so none may be recorded')

  // The protocol the documents quote as "registered in advance".
  assert.equal(report.protocol.minGain, 0.01)
  assert.equal(report.protocol.baseline, 'equal-trust')
  assert.equal(report.protocol.seeds.length, 8)

  const benchmark = squash(doc.benchmarks())
  const cycle = squash(doc.cycle())
  for (const [label, text] of [['docs/06', benchmark], ['docs/07', cycle]]) {
    assert.ok(text.includes('no_lesson'), `${label} must state the recorded verdict`)
    assert.ok(text.includes('equal-trust'), `${label} must name the baseline`)
  }

  // The figures the documents print, taken from the artifact rather than typed here.
  const ranking = report.development.ranking
  const top = ranking[0]
  assert.equal(top.strategy, 'equal-trust')
  for (const row of ranking) {
    const shown = row.mean.toFixed(4)
    assert.ok(benchmark.includes(shown) || cycle.includes(shown),
      `the recorded mean ${shown} for ${row.strategy} is not stated in docs/06 or docs/07`)
  }
  // And the two held-out families whose order changed: the honest reading is that the
  // margin is below the bar, so the document must print the delta and the bar together.
  for (const family of ['held-out-low', 'held-out-high']) {
    const target = report.targets.find((entry) => entry.family === family)
    const winner = target.ranking[0]
    const row = target.versusBaseline.find((entry) => entry.strategy === winner.strategy)
    assert.ok(row.meanDelta < report.protocol.minGain,
      `${family}: the winner must be below the registered bar for the document to say so`)
    const shown = `+${row.meanDelta.toFixed(4)}`
    assert.ok(benchmark.includes(shown) || cycle.includes(shown),
      `${family}: the quoted delta ${shown} does not match the recorded ${row.meanDelta}`)
  }

  // The pre-registration claim is only true if the rules live in code that runs before
  // the measurements, so the thresholds are read from the module rather than the prose.
  const protocol = read('services/fabric/fabric/transfer.py')
  assert.ok(protocol.includes('MIN_GAIN = 0.01'), 'the registered threshold must be in the module')
  assert.ok(protocol.includes('MIN_SEEDS = 3'), 'the registered seed floor must be in the module')
  assert.ok(exists(resolve(REPO, 'services/fabric/scripts/l4_transfer.py')),
    'the documents claim a runner; the runner must exist')
})

// ---------------------------------------------------------------------------
// The family's purpose: the stance, the two differentiators, and the modalities
// ---------------------------------------------------------------------------

test('docs/22 states the stance and the two differentiators the family record defines', () => {
  const text = squash(doc.differentiation())
  const report = familyReport()

  // The stance is stated as a refusal, not as an aspiration.
  assert.ok(text.includes('this family does not compete'), 'the stance must be stated')
  assert.equal(FAMILY_STANCE.competitive, false)
  for (const phrase of ['No benchmark win over a named or unnamed competitor is claimed',
                        'No feeling or diagnosis the user did not express']) {
    assert.ok(text.includes(phrase), `docs/22 must carry the forbidden claim: ${phrase}`)
  }
  // And the document never names a competitor, which is the rule it is describing.
  for (const marker of COMPETITOR_MARKERS) {
    assert.ok(!text.toLowerCase().includes(marker), `docs/22 names ${marker}, which its own stance forbids`)
  }

  // Both differentiators are named, and described as unbacked rather than as delivered.
  for (const name of FAMILY_STANCE.differentiators) {
    assert.ok(text.includes(`\`${name}\``), `docs/22 must name ${name}`)
  }
  assert.ok(text.includes('A mechanism is not a model'), 'the mechanism-versus-artifact distinction must be stated')
  assert.ok(text.includes('stale-source answer counts as wrong'), 'the trend acceptance rule must be stated')
  assert.ok(text.includes('abstention'), 'the affect acceptance rule must include abstention')

  // The tier table in docs/22 agrees with the module, cell by cell, exactly as docs/11 does.
  for (const tier of report.tiers) {
    const row = new RegExp(`\\| \\*\\*${tier.displayName}\\*\\* \\|[^|]+\\|[^|]+\\| ${tier.availableCapabilities.length} of ${tier.capabilityCount} \\|`).exec(text)
    assert.ok(row, `docs/22 must table ${tier.displayName} with ${tier.availableCapabilities.length} of ${tier.capabilityCount}`)
  }
  // The gates the plan derives are the gates the document lists.
  const plan = developmentPlan()
  for (const gate of plan.tiers[0].gates) {
    if (![GATES.DIFFERENTIATION, GATES.TREND_AWARENESS, GATES.AFFECT_HISTORY, GATES.MODALITY_SEPARATION].includes(gate.id)) continue
    assert.equal(gate.status, gate.id === GATES.DIFFERENTIATION ? GATE_STATES.MET : GATE_STATES.OPEN,
      `${gate.id} status changed; docs/22 describes it as ${gate.status}`)
  }
})

test('docs/22 keeps image and video as separate models, with no artifact claimed anywhere', () => {
  const text = squash(doc.differentiation())
  assert.ok(text.includes('Image and video are different models, not different prompts'))
  assert.ok(text.includes('refuses rather than substituting a text answer'),
    'the refusal that stands in for an image model must be stated')

  // No tier has an image or video artifact, and the document says so in those words.
  for (const tier of familyReport().tiers) {
    for (const modality of ['image', 'video']) {
      const role = tier.modalityArtifacts[modality]
      if (role) assert.equal(role.artifact, null, `${tier.id}.${modality} must have no artifact`)
    }
  }
  const noArtifact = (text.match(/no artifact/g) ?? []).length
  assert.ok(noArtifact >= 4, `docs/22 must say "no artifact" for each empty cell, found ${noArtifact}`)
  assert.ok(!/image generation is (?:available|released)/i.test(text))
})

test('docs/23 keeps the composed path as a technique this family refused, and says why', () => {
  const text = squash(doc.trainingFree())

  // The page is honest about its own status first: implemented, and not taken by any tier.
  assert.ok(text.includes('No tier of this family takes it'), 'the status must be stated first')
  assert.ok(text.includes('rejected'), 'the decision must be recorded, not implied')
  for (const phrase of ['A candidate is not a placement', 'Unknown memory is a refusal, not a zero',
                        'CPU is not a GPU tier', 'a plan is not a measurement']) {
    assert.ok(text.includes(phrase), `docs/23 must state: ${phrase}`)
  }

  // The rule it was refused by is the rule the plan derives, and no tier is composed.
  for (const tier of familyReport().tiers) {
    assert.equal(tier.backingPath.path, 'trained_from_scratch', `${tier.id} must not be composed`)
    assert.equal(tier.backingPath.bases.length, 0)
  }
  const plan = idMapOf(developmentPlan())
  for (const id of ['pro', 'max']) {
    assert.equal(gateIn(plan[id], 'own_weights').status, 'open')
    assert.equal(gateIn(plan[id], 'accelerated_runtime').status, 'open')
  }
  assert.ok(text.includes('own_weights'), 'the checked form of the refusal must be named')
  assert.ok(text.includes('composed tier can never satisfy it') || text.includes('can never satisfy it'),
    'the page must state that a composed tier cannot satisfy it')

  // The accelerator table names the accelerators the registry implements, and no others.
  for (const id of ACCELERATOR_IDS) {
    if (id === 'cpu') continue
    assert.ok(text.toLowerCase().includes(ACCELERATORS[id].vendor.toLowerCase().split(' ')[0]),
      `docs/23 must describe ${id}`)
  }
  assert.ok(text.includes('OpenVINO NPU'), 'the NPU path is the "any other" answer and must be named')
  // And it names no competitor to compare against. `llama.cpp` is an inference runtime this
  // repository would drive, not a model it measures itself against, so the runtime is masked
  // before the scan rather than added to the allowlist of vendor names.
  const withoutRuntime = text.toLowerCase().replaceAll('llama.cpp', 'the runtime')
  for (const marker of COMPETITOR_MARKERS) {
    assert.ok(!withoutRuntime.includes(marker), `docs/23 names ${marker}`)
  }
  // The composed base still cannot wear a tier label: the lookup is the enforcement.
  assert.equal(tierClaimFor('third-party/small-instruct'), null)
})

test('docs/24 states what the own models of this family are, and quotes the prototype it measured', () => {
  const text = squash(doc.ownModels())
  const report = familyReport()

  // Whose models these are, and the consequence stated rather than softened.
  assert.ok(text.includes('`aetheris-core-v1`'), 'the architecture must be named')
  assert.ok(text.includes('trained from random initialisation'))
  assert.ok(text.includes('there is no technique that avoids it'), 'the honest consequence must be stated')
  assert.ok(text.includes('no base checkpoint'), 'the rule that makes it ours must be stated')
  assert.ok(text.includes('own_weights'), 'the derived gate must be named')

  // The parameters the page states are the parameters the module computes.
  for (const id of ['pro', 'max']) {
    const parameters = presetReport(id).parameters.toLocaleString('en-US')
    assert.ok(text.includes(parameters), `docs/24 must state ${id}'s ${parameters} parameters`)
  }
  assert.equal(presetReport('pro').parameters, 27_559_946)
  assert.equal(presetReport('max').parameters, 92_077_066)
  assert.ok(text.includes('assumptions, not measurements'), 'the training arithmetic must be labelled')

  // The parts are named as parts of the model, and the prototype numbers in the page are the
  // numbers in the record it points at.
  for (const part of ['age_buckets', 'verdict_head', 'state_emb', 'state_head']) {
    assert.ok(text.includes(part), `docs/24 must name the ${part} part`)
  }
  const prototype = JSON.parse(read('docs/experiments/differentiator-prototype.json'))
  assert.equal(prototype.isArtifact, false)
  const heldOut = prototype.metrics.heldOut
  for (const score of [heldOut.verdict.accuracy, heldOut.state.accuracy,
                       heldOut.verdict.majorityClassBaseline, heldOut.state.majorityClassBaseline]) {
    assert.ok(text.includes(score.toFixed(4)), `docs/24 must quote the measured ${score.toFixed(4)}`)
  }
  assert.ok(text.includes('mechanism prototype'), 'the prototype must be labelled as one')
  assert.ok(text.includes('not a model artifact'))

  // Image and video are separate designs, and no tier has one.
  for (const modality of ['image', 'video']) {
    assert.ok(text.includes(MODALITY_MODELS[modality].modelId), `docs/24 must name the ${modality} model`)
    assert.equal(MODALITY_MODELS[modality].implemented, false)
  }
  for (const tier of report.tiers) assert.equal(tier.availability, undefined, 'no phantom field')
  for (const marker of COMPETITOR_MARKERS) {
    assert.ok(!text.toLowerCase().replaceAll('llama.cpp', 'the runtime').includes(marker), `docs/24 names ${marker}`)
  }
})

test('the direction change is recorded, and the Sparsiz audit keeps its findings', () => {
  const text = squash(doc.adaptive())

  // The withdrawn requirement, and the one that is NOT reinstated by withdrawing it. A page that
  // dropped either half would leave the family's rule ambiguous, which is how a refused path gets
  // quietly re-used.
  assert.ok(text.includes('withdrawn for the product tiers'),
    'docs/25 must state which requirement was withdrawn')
  assert.ok(text.includes('capability profiles over one shared adaptive core'))
  assert.ok(text.includes('not') && text.includes('the composed path that `23` records as refused'),
    'docs/25 must say the change does not reinstate the composed path')
  assert.ok(squash(doc.ownModels()).includes('25-adaptive-intelligence.md'),
    'docs/24, which the change affects, must point at docs/25')

  // The phase-1 inspection: pinned commit, and the four findings that decided what may be inherited.
  // These are the load-bearing sentences -- a later edit that deletes one while keeping the reuse
  // decision would be inheriting a module on the strength of its name, which is what the audit exists
  // to prevent.
  assert.ok(text.includes('76ec6f0f0f501ea9fbf99f0769ef224d3dbc0d69'), 'the exact commit must be named')
  assert.ok(text.includes('passed = random.random() > 0.2'), 'the coin-flip validation must be quoted')
  assert.ok(text.includes('# Baselines simulated'), 'the invented baselines must be quoted')
  assert.ok(text.includes('# Mock scoring'), 'the random quality score must be quoted')
  assert.ok(text.includes('assert non-emptiness, not correctness'), 'the test weakness must be stated')
  assert.ok(text.includes('Unlicense'), 'the licence that makes reuse possible must be recorded')

  // And the boundary. Phase 2 demonstrated one capability, so the page may not claim general
  // competence, and it may not claim a phase is done without its tests -- the sentence this
  // assertion used to require ("does not claim that any adaptive capability works") became false
  // the moment the milestone test passed, and updating the assertion is the point: a page whose
  // disclaimers outlive their truth is a page nobody can trust.
  assert.ok(/one capability, demonstrated end to end/i.test(text), 'the page must scope what was demonstrated')
  assert.ok(/does not claim general task competence/i.test(text), 'the page must state what it does not claim')
  assert.ok(text.includes('no phase is complete before its acceptance tests pass'), 'the page must state what it does not claim')
  assert.ok(text.includes('consciousness, sentience or human-equivalent'))

  // A "see the Phase N record above" that points at nothing is how a sixty-line record vanished
  // without a single check failing: a scripted edit replaced the backlog line with a summary that
  // referenced a record it had not inserted, and every existing assertion still passed. The
  // reference is now checked against the document it lives in.
  const raw = doc.adaptive()
  const records = new Map()
  for (const line of raw.split('\n')) {
    const record = /^\*\*Phase (\d+)(?:, second half)? — /.exec(line)
    // A backlog line is a pointer, not a record: it says "see above" and must not count itself.
    if (record && !/record above/.test(line)) records.set(record[1], (records.get(record[1]) ?? 0) + 1)
    const pointer = /See the Phase (\d+) record above/.exec(line)
    if (pointer) {
      assert.ok((records.get(pointer[1]) ?? 0) > 0,
        `docs/25 says "see the Phase ${pointer[1]} record above" and no Phase ${pointer[1]} record is above it`)
    }
  }
  assert.ok(records.size >= 5, `expected records for the delivered phases, found ${[...records.keys()].join(', ')}`)

  // The durability lesson is a fact about this project, not a mood: state it with the evidence.
  assert.ok(text.includes('Only what is committed to Git survives'))
  assert.ok(text.includes('parked, not abandoned'), 'the training run must be recorded, not dropped')
})

test('no third-party base ever wears a tier label, and no tier claims an artifact it does not have', () => {
  // The enforcement is a lookup, not a paragraph: a label is only assigned by finding an artifact
  // in the backings of *available* capabilities, and the family has no artifact for Pro or Max.
  assert.ok(squash(doc.trainingFree()).includes('tierClaimForArtifact()'),
    'the enforcement must be named in docs/23, where the composed base is described')
  assert.equal(tierClaimFor('third-party/small-instruct'), null)
  assert.equal(tierClaimForArtifact('third-party/small-instruct', '7ae5576'), null)
  for (const id of [TIERS.PRO, TIERS.MAX]) {
    assert.deepEqual(ownedArtifacts(id), [], `${id} owns no artifact yet`)
    assert.deepEqual(KLYVARON[id].backingPath.bases, [], 'a from-scratch tier records no base')
    assert.equal(KLYVARON[id].backingPath.verified, false)
  }
  // And the released Lite artifact keeps its label: the rule is not "no labels at all".
  assert.equal(tierClaimFor('aetheris-lite-lm-0.1.1'), TIERS.LITE)
})
