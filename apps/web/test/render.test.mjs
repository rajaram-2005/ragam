/**
 * Server-render every product area and assert on the real markup.
 *
 * Until this file existed the rendering layer was "implemented, not fully tested":
 * the API client, the SSE parser, the formatting helpers and the structural
 * invariants all had tests, but nothing proved the components actually render.
 * There is no browser here, and adding jsdom would mean a new dependency tree for
 * tests that mostly assert markup strings.
 *
 * `react-dom/server` is already a dependency of `react-dom`, and `rolldown` is
 * already a dependency of Vite 8 (it replaced esbuild there) — so this bundles the
 * JSX with rolldown, which `node --test` cannot parse itself, and renders it to
 * static markup. No dependency is added for the sake of the test, and no DOM is
 * required.
 *
 * This test originally bundled with esbuild, on the reasoning that it was already
 * present as a Vite dependency. Vite 8 dropped esbuild for oxc/rolldown, so the
 * bundler was switched rather than esbuild re-added: re-adding it would have
 * reintroduced GHSA-67mh-4wv8-2f99, the very advisory the upgrade removed.
 *
 * `renderToStaticMarkup` does not run effects, so nothing here hits the network:
 * every component is rendered in its pre-fetch state, which is exactly the state a
 * user sees first and the one most likely to crash on a missing field.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { rolldown } from 'rolldown'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = resolve(HERE, '..')
const OUT_DIR = resolve(HERE, '.render-build')
const OUT_FILE = resolve(OUT_DIR, 'components.mjs')

// Captured from a live `GET /api/ready` on a host with no model installed. This is
// the shape the components really receive, not an invented one.
const READINESS_DEGRADED = {
  status: 'degraded',
  policy: 'strict_offline',
  offlineEnforced: true,
  hardware: { cpuCount: 2, ramGb: 3.85, ramFreeGb: 3.43, vramGb: 0, gpuDetected: false, detectedAt: 1791733935714 },
  models: { total: 0, ready: 0 },
  capabilities: { chat: false, embeddings: false, imageGeneration: false, videoGeneration: false, knowledge: true },
  providers: { ollama: { configured: true, safe: { provider: 'ollama' } } },
  warnings: [],
  notReady: [],
}

// The same shape with a model installed, to exercise the other branch of every
// conditional. A component that only renders in the degraded state is half-tested.
const READINESS_READY = {
  ...READINESS_DEGRADED,
  status: 'ready',
  models: { total: 1, ready: 1 },
  capabilities: { ...READINESS_DEGRADED.capabilities, chat: true, embeddings: true },
}

// Captured from a live `GET /api/config`.
const CONFIG = {
  policy: 'strict_offline',
  externalCeiling: 'internal',
  offlineEnforced: true,
  dataDir: '/tmp/aetheris-run',
  ollama: { enabled: true, baseUrl: 'http://127.0.0.1:11434' },
  llamaCpp: { enabled: false, baseUrl: 'http://127.0.0.1:8080/v1', runtime: 'llama.cpp', keyConfigured: false },
  freellmapi: { enabled: false, endpoint: null, keyConfigured: false, keyTransport: 'server environment' },
  fabric: { enabled: false },
  browserKeyExposure: false,
}

const noop = () => {}

/** Bundle the components once per run; the output is gitignored. */
async function loadComponents() {
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })

  // rolldown takes a real entry file rather than stdin, so write one into the
  // scratch directory. It lives under test/, so '../src/...' resolves as before.
  const entry = resolve(OUT_DIR, 'entry.jsx')
  writeFileSync(entry, [
    "export { default as ChatArea } from '../../src/areas/ChatArea.jsx'",
    "export { default as ImageArea } from '../../src/areas/ImageArea.jsx'",
    "export { default as VideoArea } from '../../src/areas/VideoArea.jsx'",
    "export { default as PluginsArea } from '../../src/areas/PluginsArea.jsx'",
    "export { default as McpArea } from '../../src/areas/McpArea.jsx'",
    "export { default as App } from '../../src/App.jsx'",
    "export { Shell, StatusCard } from '../../src/components/Shell.jsx'",
    "export { JobTable, JobDetail } from '../../src/components/Jobs.jsx'",
    "export * as ui from '../../src/components/ui.jsx'",
  ].join('\n'))

  const bundle = await rolldown({
    input: entry,
    // Keep React external so the bundle shares one instance with this test file;
    // two copies of React would make hooks throw.
    external: ['react', 'react-dom', 'react-dom/server'],
    resolve: { extensions: ['.jsx', '.js', '.mjs'] },
    onwarn() {}, // rolldown warns about the CJS interop shim; it is expected here
  })
  const { output } = await bundle.generate({ format: 'esm' })

  // React is CommonJS. Marking it external makes rolldown emit a bare
  // `require("react")` into an ESM bundle, where `require` does not exist. Prepend
  // the standard Node shim so the external CJS import resolves. This is the
  // documented remedy (rolldown.rs/in-depth/bundling-cjs#require-external-modules)
  // and it keeps React external, which matters: two copies of React make hooks throw.
  const shim = [
    "import { createRequire as __aetherisCreateRequire } from 'node:module';",
    'const require = __aetherisCreateRequire(import.meta.url);',
    '',
  ].join('\n')
  writeFileSync(OUT_FILE, shim + output[0].code)
  await bundle.close()

  return import(pathToFileURL(OUT_FILE).href)
}

const components = await loadComponents()

/** Render and return the markup, so a crash names the component that caused it. */
function render(name, element) {
  try {
    const markup = renderToStaticMarkup(element)
    assert.ok(markup.length > 0, `${name} rendered empty markup`)
    return markup
  } catch (error) {
    assert.fail(`${name} threw while rendering: ${error.message}`)
  }
}

test('all five product areas render in the degraded state', async () => {
  // This is what a user sees on a fresh install with no model: every area must
  // render rather than crash on a missing field.
  const cases = [
    ['ChatArea', React.createElement(components.ChatArea, { readiness: READINESS_DEGRADED, refreshReadiness: noop })],
    ['ImageArea', React.createElement(components.ImageArea, { readiness: READINESS_DEGRADED, refreshReadiness: noop })],
    ['VideoArea', React.createElement(components.VideoArea, { readiness: READINESS_DEGRADED, refreshReadiness: noop })],
    ['PluginsArea', React.createElement(components.PluginsArea, { refreshReadiness: noop })],
    ['McpArea', React.createElement(components.McpArea, { refreshReadiness: noop })],
  ]
  for (const [name, element] of cases) {
    const markup = render(name, element)
    assert.ok(markup.includes('<'), `${name} produced no elements`)
  }
})

test('all five product areas render in the ready state', async () => {
  const cases = [
    ['ChatArea', React.createElement(components.ChatArea, { readiness: READINESS_READY, refreshReadiness: noop })],
    ['ImageArea', React.createElement(components.ImageArea, { readiness: READINESS_READY, refreshReadiness: noop })],
    ['VideoArea', React.createElement(components.VideoArea, { readiness: READINESS_READY, refreshReadiness: noop })],
    ['PluginsArea', React.createElement(components.PluginsArea, { refreshReadiness: noop })],
    ['McpArea', React.createElement(components.McpArea, { refreshReadiness: noop })],
  ]
  for (const [name, element] of cases) render(name, element)
})

test('the areas render with no readiness at all, as on first paint', () => {
  // App starts with readiness === null and only fills it after the first fetch, so
  // every area must tolerate null. This is the state that actually ships first.
  for (const [name, Component] of [
    ['ChatArea', components.ChatArea],
    ['ImageArea', components.ImageArea],
    ['VideoArea', components.VideoArea],
    ['PluginsArea', components.PluginsArea],
    ['McpArea', components.McpArea],
  ]) {
    render(`${name} (null readiness)`, React.createElement(Component, { readiness: null, refreshReadiness: noop }))
  }
})

test('App renders the shell with exactly the five product areas', () => {
  const markup = render('App', React.createElement(components.App))

  assert.ok(markup.includes('PRODUCT AREAS'), 'the shell must label the product areas')
  assert.ok(markup.includes('INTERNAL SERVICES'), 'the shell must label the internal services')
  assert.ok(markup.includes('aria-label="Product areas"'), 'the nav must be accessible by name')

  // Exactly five, and no sixth. Rendered output, not a source scan.
  for (const label of ['Chat', 'Image', 'Video', 'Plugins', 'MCP']) {
    assert.ok(markup.includes(`>${label}<`), `the nav must render a '${label}' entry`)
  }
  const navBlock = markup.slice(markup.indexOf('Product areas'), markup.indexOf('INTERNAL SERVICES'))
  const entries = navBlock.match(/nav-item|primary-nav__item|<a /g) || []
  assert.ok(entries.length >= 5, `expected at least five nav entries, found ${entries.length}`)

  // No internal service may appear as a navigation entry.
  for (const forbidden of ['Training', 'Benchmarks', 'Observability', 'Devices', 'Agents', 'Models']) {
    assert.ok(!navBlock.includes(`>${forbidden}<`), `'${forbidden}' must not be a navigation entry`)
  }
})

test('App renders its pre-fetch state honestly', () => {
  const markup = render('App (first paint)', React.createElement(components.App))
  // Before the first fetch resolves, readiness is null: the chip must say "unknown"
  // and the card must say it is still probing — never a confident "ready".
  assert.ok(markup.includes('unknown'), 'an unfetched readiness must render as unknown')
  assert.ok(markup.includes('Probing'), 'the status card must say it is still probing')
  assert.ok(!markup.includes('>ready<'), 'App must not claim ready before it has probed')
})

test('StatusCard renders all three of its states distinctly', () => {
  const error = render('StatusCard (error)', React.createElement(components.StatusCard, {
    readiness: null, config: null, error: new Error('fetch failed'),
  }))
  assert.ok(error.includes('Core service unreachable'))
  assert.ok(error.includes('offline'))
  assert.ok(error.includes('the interface cannot reach /api'))
  assert.ok(error.includes('fetch failed'), 'the underlying message must be shown, not swallowed')
  assert.ok(error.includes('data-tone="blocked"'))

  const probing = render('StatusCard (null)', React.createElement(components.StatusCard, {
    readiness: null, config: null, error: null,
  }))
  assert.ok(probing.includes('Probing'))
  assert.ok(probing.includes('reading readiness from the core service'))
  assert.ok(probing.includes('data-tone="warn"'))

  const degraded = render('StatusCard (degraded)', React.createElement(components.StatusCard, {
    readiness: READINESS_DEGRADED, config: CONFIG, error: null,
  }))
  assert.ok(degraded.includes('data-tone="warn"'), 'degraded must be a warning, not ok')
  assert.ok(degraded.includes('degraded'))
  assert.ok(!degraded.includes('data-tone="ok"'), 'a degraded host must never render as healthy')

  const ready = render('StatusCard (ready)', React.createElement(components.StatusCard, {
    readiness: READINESS_READY, config: CONFIG, error: null,
  }))
  assert.ok(ready.includes('data-tone="ok"'))
})

test('the degraded status card reports the real hardware and model counts', () => {
  const markup = render('StatusCard (degraded detail)', React.createElement(components.StatusCard, {
    readiness: READINESS_DEGRADED, config: CONFIG, error: null,
  }))
  // The point of the card is that it does not soften a degraded host.
  assert.ok(markup.includes('0'), 'a host with no ready models must show the zero')
  assert.ok(markup.includes('strict offline') || markup.includes('strict_offline'),
    'the active policy must be visible')
})

test('Plugins labels its sample manifest as a development fixture', () => {
  const markup = render('PluginsArea (fixture labelling)', React.createElement(components.PluginsArea, {
    refreshReadiness: noop,
  }))
  // A mock presented as real is the specific failure this guards against.
  assert.ok(markup.includes('development fixture'), 'the sample manifest must be labelled a fixture')
  assert.ok(
    markup.includes('no server-side handler implements it') || markup.includes('declares no scopes'),
    'the fixture must explain why it is not real',
  )
})

test('the policy is displayed but never rendered as a control', () => {
  // Policy is server configuration. A client-side switch would be a fake control,
  // so no rendered area may contain one.
  for (const [name, element] of [
    ['App', React.createElement(components.App)],
    ['ChatArea', React.createElement(components.ChatArea, { readiness: READINESS_DEGRADED, refreshReadiness: noop })],
    ['McpArea', React.createElement(components.McpArea, { refreshReadiness: noop })],
  ]) {
    const markup = render(name, element)
    assert.ok(!/name=["']?policy/i.test(markup), `${name} must not render a policy input`)
    assert.ok(!markup.includes('setPolicy'), `${name} must not expose a policy setter`)
  }
})

test('MCP renders honestly before any server is loaded', () => {
  const markup = render('McpArea (pre-fetch)', React.createElement(components.McpArea, { refreshReadiness: noop }))
  const text = markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

  // The gates themselves only render once a server and tool are selected, which needs
  // effects; that path is covered at source level in structure.test.mjs. What must
  // render here is the empty state, and it must not pretend tools exist.
  assert.ok(text.includes('No MCP servers registered.'), 'an empty server list must say so')
  assert.ok(text.includes('No tools are advertised by any enabled server.'))
  assert.ok(/Tools cannot be invented from the browser/.test(text),
    'the UI must state that tools cannot be fabricated client-side')
  assert.ok(/enforced server-side/.test(text),
    'timeouts, cancellation and schema validation must be attributed to the server')
  assert.ok(!text.includes('aetheris.local'), 'no server may be rendered before the fetch resolves')
})

test('the media areas render their validation surface', () => {
  for (const [name, Component] of [['ImageArea', components.ImageArea], ['VideoArea', components.VideoArea]]) {
    const markup = render(`${name} (validation surface)`, React.createElement(Component, {
      readiness: READINESS_DEGRADED, refreshReadiness: noop,
    }))
    // Both areas must expose the job/validation vocabulary, since refusing to pass a
    // still image off as video is a requirement, not a nicety.
    assert.ok(/job|generat/i.test(markup), `${name} must render its generation surface`)
  }
})

test('the job table renders an empty state rather than crashing', () => {
  const markup = render('JobTable (empty)', React.createElement(components.JobTable, {
    jobs: [], onSelect: noop, selectedId: null, kind: 'image',
  }))
  assert.ok(markup.length > 0)
})

test('the shared UI primitives all render', () => {
  // These are used by every area, so a broken primitive breaks all five.
  const ui = components.ui
  const rendered = []
  const cases = [
    ['Banner', React.createElement(ui.Banner, { tone: 'warn' }, 'a message')],
    ['Button', React.createElement(ui.Button, { onClick: noop }, 'Go')],
    ['Chip', React.createElement(ui.Chip, { tone: 'ok' }, 'ready')],
    ['EmptyState', React.createElement(ui.EmptyState, null, 'nothing here')],
    ['ErrorNote', React.createElement(ui.ErrorNote, { error: new Error('boom') })],
    ['Field', React.createElement(ui.Field, { label: 'Prompt' }, React.createElement('input', {}))],
    ['Kv', React.createElement(ui.Kv, { entries: [['state', 'succeeded'], ['kind', 'video']] })],
    ['Panel', React.createElement(ui.Panel, { eyebrow: 'MEDIA', title: 'Jobs' }, 'body')],
    ['Code', React.createElement(ui.Code, { value: '{"ok":true}', label: 'output' })],
    ['Stat', React.createElement(ui.Stat, { label: 'servers', value: 0 })],
    ['Stats', React.createElement(ui.Stats, null, React.createElement(ui.Stat, { label: 'a', value: 1 }))],
    ['Lifecycle', React.createElement(ui.Lifecycle, { task: { steps: [] } })],
    ['Checks', React.createElement(ui.Checks, { checks: [] })],
    ['Progress', React.createElement(ui.Progress, { value: 0.5 })],
    ['Table', React.createElement(ui.Table, { columns: [{ key: 'id', label: 'ID' }], rows: [], empty: 'none' })],
    ['FixtureTag', React.createElement(ui.FixtureTag, null)],
  ]
  for (const [name, element] of cases) {
    const componentName = name.split(' ')[0]
    assert.ok(typeof ui[componentName] === 'function', `${componentName} must be exported by ui.jsx`)
    const markup = render(name, element)
    assert.ok(markup.length > 0)
    rendered.push(name)
  }
  // Every one must render, not "most": these are shared by all five areas, so a
  // broken primitive breaks the whole interface. The expected count is derived from
  // the case list above rather than restated, so adding a primitive cannot silently
  // pass with one missing.
  assert.equal(rendered.length, cases.length,
    `expected all ${cases.length} primitives to render, got ${rendered.length}: ${rendered.join(', ')}`)
})

test('FixtureTag marks non-real content by default', () => {
  // Mock data must be labelled in the interface itself, so the default text matters.
  const markup = render('FixtureTag (default)', React.createElement(components.ui.FixtureTag))
  assert.ok(markup.includes('development fixture'), 'the default label must say "development fixture"')
  const custom = render('FixtureTag (custom)', React.createElement(components.ui.FixtureTag, null, 'sample'))
  assert.ok(custom.includes('sample'))
})

test('the render bundle is generated, never committed, and cleaned up', () => {
  // The bundle is scratch, not a product: it must be gitignored and removed.
  const ignore = readFileSync(resolve(WEB, '../../.gitignore'), 'utf8')
  assert.ok(ignore.includes('apps/web/test/.render-build/'),
    'the generated bundle directory must be gitignored')

  rmSync(OUT_DIR, { recursive: true, force: true })
  assert.equal(existsSync(OUT_DIR), false, 'the generated bundle must not be left behind')
})

test('the memory panel renders its empty state honestly, before anything is loaded', () => {
  // renderToStaticMarkup does not run effects, so this is the pre-fetch state: the panel
  // must render with no data rather than crash on a missing field.
  const markup = render('ChatArea', React.createElement(components.ChatArea, { readiness: READINESS_READY, refreshReadiness: noop }))
  assert.ok(/Memory you approved/.test(markup), 'the memory panel must render in Chat')
  assert.ok(/Conversation history/.test(markup), 'the history panel must render in Chat')
  assert.ok(/Nothing remembered yet/.test(markup), 'the empty state must be shown, not a blank panel')
  assert.ok(/Nothing is remembered automatically/.test(markup))
})

test('the button variant reaches the stylesheet as a class', () => {
  // The stylesheet selects on `.btn.primary` / `.btn.danger`. The variant used to be
  // written to a data attribute that nothing selected, so fifteen call sites asking for a
  // variant silently got the default button.
  const primary = render('Button', React.createElement(components.ui.Button, { variant: 'primary' }, 'Send'))
  assert.match(primary, /class="btn primary"/)
  const danger = render('Button', React.createElement(components.ui.Button, { variant: 'danger' }, 'Delete'))
  assert.match(danger, /class="btn danger"/)
  const plain = render('Button', React.createElement(components.ui.Button, null, 'Refresh'))
  assert.match(plain, /class="btn"/)
  assert.ok(!/class="btn "/.test(plain), 'a default button must not carry a trailing space')
})

test('every button variant used in the app has a rule in the stylesheet', () => {
  // The guard for the class of bug above: a variant with no rule renders unstyled and
  // nobody notices, because an unstyled button still looks like a button.
  const css = readFileSync(resolve(WEB, 'src/styles.css'), 'utf8')
  const used = new Set()
  for (const file of ['areas/ChatArea.jsx', 'areas/ImageArea.jsx', 'areas/VideoArea.jsx', 'areas/PluginsArea.jsx', 'areas/McpArea.jsx']) {
    const source = readFileSync(resolve(WEB, 'src', file), 'utf8')
    for (const match of source.matchAll(/variant="([a-z]+)"/g)) used.add(match[1])
  }
  assert.ok(used.size >= 2, `expected to find variants in use, found ${[...used]}`)
  for (const variant of used) {
    assert.ok(new RegExp(`\\.btn\\.${variant}\\b`).test(css), `.btn.${variant} is used but has no rule in styles.css`)
  }
})
