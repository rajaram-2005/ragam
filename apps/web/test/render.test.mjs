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
import { SESSION_ENDED_NOTICE } from '../src/auth.js'

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
    "export { default as ProviderSettings } from '../../src/components/ProviderSettings.jsx'",
    "export { default as App } from '../../src/App.jsx'",
    "export { default as SignInPage } from '../../src/pages/SignInPage.jsx'",
    "export { default as SignUpPage } from '../../src/pages/SignUpPage.jsx'",
    "export { default as ForgotPasswordPage } from '../../src/pages/ForgotPasswordPage.jsx'",
    "export { ResetRequestForm, ResetConfirmForm } from '../../src/pages/ForgotPasswordPage.jsx'",
    "export { default as AccountCard } from '../../src/components/AccountCard.jsx'",
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
    if (['ChatArea', 'ImageArea', 'VideoArea'].includes(name)) {
      assert.doesNotMatch(markup, /value="local"|value="hybrid"|Execution mode/)
    }
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

test('authenticated shell keeps five areas and provides settings outside navigation', () => {
  const markup = render('Shell', React.createElement(components.Shell, { active: 'chat', onSelect: noop }))
  assert.equal((markup.match(/class="nav-item/g) ?? []).length, 5)
  for (const label of ['Chat','Image','Video','Plugins','MCP']) assert.ok(markup.includes(`>${label}<`))
  assert.match(markup, /Provider Settings/)
  assert.doesNotMatch(markup, /INTERNAL SERVICES|God Core|training fabric/)

})

test('App renders the sign-in page before loading protected data', () => {
  // Signed out is the first state anybody sees, and it must not be a wall around a
  // half-loaded workspace: no area chrome, no thread, no navigation.
  const markup = render('App', React.createElement(components.App))
  assert.match(markup, /Sign in/)
  assert.match(markup, /type="email"/)
  assert.match(markup, /type="password"/)
  assert.doesNotMatch(markup, /class="thread"|class="nav-item/)
  // The removed mechanism must not survive in the signed-out view.
  assert.doesNotMatch(markup, /access token|installation access|Sign in to this installation/i)
})

test('the sign-in page is a traditional address-and-password form', () => {
  const markup = render('SignInPage', React.createElement(components.SignInPage))
  assert.match(markup, /<h1>Sign in<\/h1>/)
  // Named fields and the right autoComplete values: this is what lets a password manager
  // recognise the form, which is most of why a traditional sign-in page is worth having.
  assert.match(markup, /name="email"/)
  assert.match(markup, /autoComplete="username"/)
  assert.match(markup, /name="password"/)
  assert.match(markup, /autoComplete="current-password"/)
  assert.match(markup, /type="submit"[^>]*>.*Sign in|Sign in<\/button>/s)
  // The other two sign-in pages are reachable from it, and no area chrome leaks in.
  assert.match(markup, /href="#\/signup"/)
  assert.match(markup, /href="#\/forgot-password"/)
  assert.doesNotMatch(markup, /class="nav-item|class="thread|Provider Settings/)
})

test('a session the server no longer recognises is reported, not swallowed', () => {
  // Ending a session silently is what turns a cookie problem into "I signed in and can't
  // see anything": the workspace disappears, the sign-in page comes back, and nothing on
  // screen says the session was dropped rather than never established.
  const plain = render('SignInPage', React.createElement(components.SignInPage))
  assert.doesNotMatch(plain, /Your session ended/, 'an ordinary visit is not told its session ended')

  const ended = render('SignInPage (session ended)', React.createElement(components.SignInPage, { notice: SESSION_ENDED_NOTICE }))
  assert.match(ended, /Your session ended/)
  assert.match(ended, /data-tone="info"/, 'reported as information about this installation, not as a failed sign-in')
  assert.match(ended, /AETHERIS_COOKIE_SAMESITE=none/, 'the non-obvious cause is named where somebody can act on it')

  // A dropped session and a wrong password can happen to the same person in the same
  // minute; both must be able to appear at once.
  const both = render('SignInPage (ended and refused)', React.createElement(components.SignInPage, {
    notice: SESSION_ENDED_NOTICE, error: new Error('That address and password do not match an account here.'),
  }))
  assert.match(both, /Your session ended/)
  assert.match(both, /data-tone="bad"/)
  assert.equal((both.match(/class="banner"/g) ?? []).length, 2)
})

test('the create-account page states the rules before the form is submitted', () => {
  const markup = render('SignUpPage', React.createElement(components.SignUpPage))
  assert.match(markup, /Create your account/)
  assert.match(markup, /At least 12 characters/)
  assert.match(markup, /autoComplete="new-password"/)
  assert.equal((markup.match(/type="password"/g) ?? []).length, 2, 'a password and its confirmation')
  assert.match(markup, /Confirm password/)
  assert.match(markup, /first account created on an installation becomes its/, 'who owns the installation is stated where the account is made')
  assert.match(markup, /href="#\/signin"/)
})

test('the reset page promises a host-delivered code and never an email', () => {
  const markup = render('ForgotPasswordPage', React.createElement(components.ForgotPasswordPage))
  assert.match(markup, /Reset your password/)
  assert.match(markup, /Request a reset code/)
  assert.match(markup, /password-resets\.json/, 'where the code actually is')
  assert.match(markup, /sends no email/)
  // The one thing this page must never do is claim a message is on its way.
  assert.doesNotMatch(markup, /check your (?:email|inbox)|we(?:'ve| have) sent|sent you an (?:email|code)|reset link/i)
  assert.match(markup, /href="#\/signin"/)
})

test('both steps of the reset page render, not only the first one', () => {
  // The page starts on step one and only reaches step two after a successful request, so
  // rendering the page alone leaves the password-setting form unseen by every test. Each
  // step is exported for exactly this reason.
  const request = render('ResetRequestForm', React.createElement(components.ResetRequestForm, {
    email: '', onEmail: noop, busy: false, onSubmit: noop,
  }))
  assert.match(request, /Request a reset code/)
  assert.match(request, /type="email"/)
  assert.match(request, /autoComplete="username"/)
  assert.doesNotMatch(request, /name="code"|Set new password/, 'step one must not show step two')

  const confirm = render('ResetConfirmForm', React.createElement(components.ResetConfirmForm, {
    code: '', onCode: noop, password: '', onPassword: noop, confirm: '', onConfirm: noop, busy: false, onSubmit: noop,
  }))
  assert.match(confirm, /Set new password/)
  assert.match(confirm, /name="code"/)
  assert.match(confirm, /autoComplete="one-time-code"/)
  assert.match(confirm, /Single use/, 'the code is single-use and short-lived; say so where it is typed')
  assert.equal((confirm.match(/type="password"/g) ?? []).length, 2, 'a password and its confirmation')
  // autoComplete is what lets a password manager store it; name is what the browser posts.
  assert.equal((confirm.match(/autoComplete="new-password"/g) ?? []).length, 2)
  assert.match(confirm, /name="password"/)
  assert.match(confirm, /name="confirm-password"/)
  assert.match(confirm, /minLength="12"/, 'the server is authoritative, but the form states the same floor')
  assert.doesNotMatch(confirm, /not the same|aria-invalid/, 'no error before anything is typed')

  // The mismatch state is the one validation this page owns outright — the server never
  // sees the confirmation field, so nothing downstream catches a typo in it.
  const mismatched = render('ResetConfirmForm (mismatch)', React.createElement(components.ResetConfirmForm, {
    code: 'a-single-use-code', onCode: noop, password: 'a-brand-new-password', onPassword: noop,
    confirm: 'a-different-password', onConfirm: noop, busy: false, onSubmit: noop,
  }))
  assert.match(mismatched, /not the same/)
  assert.match(mismatched, /aria-invalid="true"/)
  assert.match(mismatched, /disabled/, 'the form must not submit a pair that cannot both be right')
})

test('the sidebar names the signed-in account without becoming a sixth area', () => {
  const owner = render('Shell (owner)', React.createElement(components.Shell, { active: 'chat', onSelect: noop, account: { id: 'a1', email: 'owner@example.test', role: 'owner' }, onSignOut: noop }))
  assert.match(owner, /owner@example\.test/)
  assert.match(owner, /OWNER/)
  assert.match(owner, /Change password/)
  assert.match(owner, /Sign out/)
  assert.equal((owner.match(/class="nav-item/g) ?? []).length, 5, 'the account card must not add a navigation entry')
  const member = render('Shell (member)', React.createElement(components.Shell, { active: 'chat', onSelect: noop, account: { id: 'a2', email: 'member@example.test', role: 'member' }, onSignOut: noop }))
  assert.match(member, /MEMBER/)
  assert.doesNotMatch(member, /OWNER/)
  // With no account there is no card at all: the shell must not invent an identity.
  const anonymous = render('Shell (anonymous)', React.createElement(components.Shell, { active: 'chat', onSelect: noop }))
  assert.doesNotMatch(anonymous, /Change password|Sign out|MEMBER|OWNER/)
})

test('the change-password dialog asks for the current password and warns about other sessions', () => {
  // The dialog is in the card's markup from the start (a <dialog> is closed, not absent),
  // so it can be rendered without clicking anything. It is worth pinning because this is
  // the only form in the signed-in app that changes a credential, and because what it
  // promises is a server behaviour: a successful change revokes the account's other
  // sessions, which feels like a bug unless the form says it is about to happen.
  const owner = { id: 'a1', email: 'owner@example.test', role: 'owner' }
  const markup = render('AccountCard', React.createElement(components.AccountCard, { account: owner, onSignOut: noop }))
  assert.equal((markup.match(/type="password"/g) ?? []).length, 3, 'current, new, and confirm')
  assert.equal((markup.match(/autoComplete="current-password"/g) ?? []).length, 1, 'exactly one field is the current password')
  assert.equal((markup.match(/autoComplete="new-password"/g) ?? []).length, 2)
  assert.match(markup, /name="current-password"[^>]*required/, 'the current password is not optional')
  assert.match(markup, /minLength="12"/, 'the same floor the server enforces, stated on the form')
  assert.match(markup, /signs out every other session/, 'say what the server does before it does it')
  assert.match(markup, /owner@example\.test/)
  assert.doesNotMatch(markup, /not the same|aria-invalid/, 'no validation error before anything is typed')

  // Three labels read "Change password": the sidebar trigger, the dialog heading, and the
  // submit button. All three must be present, or the trigger points at nothing.
  assert.equal((markup.match(/Change password/g) ?? []).length, 3, 'trigger, heading, and submit')
  assert.match(markup, /aria-labelledby="change-password-title"/)
  assert.match(markup, /id="change-password-title"/)

  // Without an account there is no card at all: the sidebar must not invent an identity.
  // `render()` rejects empty markup by design, so this one goes straight to the renderer.
  assert.equal(renderToStaticMarkup(React.createElement(components.AccountCard, { onSignOut: noop })), '')
})

test('provider settings are read-only for a member account', () => {
  const member = render('ProviderSettings (member)', React.createElement(components.ProviderSettings, { account: { id: 'a2', email: 'member@example.test', role: 'member' }, onClose: noop }))
  assert.match(member, /Only the owner account/)
  const owner = render('ProviderSettings (owner)', React.createElement(components.ProviderSettings, { account: { id: 'a1', email: 'owner@example.test', role: 'owner' }, onClose: noop }))
  assert.doesNotMatch(owner, /Only the owner account/)
  assert.match(owner, /Save connection/)
})

test('StatusCard distinguishes loading, errors, listings and observed inference', () => {
  const card = (props) => render('StatusCard', React.createElement(components.StatusCard, props))
  assert.match(card({}), /Checking connection/)
  assert.match(card({error: Error('failed')}), /Connection unavailable/)
  assert.match(card({readiness: {models:{total:5,ready:1}}}), /5 models listed · 1 inference observed/)
  assert.doesNotMatch(card({readiness: READINESS_READY}), /gpu|ram|strict offline/)

})

test('online status removes device tiers and shows zero models honestly', () => {
  const markup=render('StatusCard',React.createElement(components.StatusCard,{readiness:READINESS_DEGRADED}))
  assert.match(markup,/0 models listed/)
  assert.match(markup,/Online only/)
  assert.doesNotMatch(markup,/hardware|Klyvaron|training fabric/)

})

test('Plugins does not offer executable unreviewed sample installations', () => {
  const markup=render('PluginsArea',React.createElement(components.PluginsArea))
  assert.match(markup,/Arbitrary extension installation and execution are disabled/)
  assert.match(markup,/No reviewed plugins loaded yet/)
  assert.doesNotMatch(markup,/Demo Text Tools|Install plugin/)

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
  const markup=render('McpArea',React.createElement(components.McpArea))
  assert.match(markup,/No tools loaded yet/)
  assert.match(markup,/Remote MCP connections are not configured/)
  assert.match(markup,/enforced server-side/)

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

test('Chat removes research panels but retains optional user context', () => {
  const markup=render('ChatArea',React.createElement(components.ChatArea))
  assert.doesNotMatch(markup,/Procedures Aetheris learned|God Core task lifecycle|Model routing decision|Registered models/)
  assert.match(markup,/Optional files/)
  assert.match(markup,/Optional approved memory/)

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

test('Chat renders the saved exact model and identifies the online recipient', () => {
  const provider={keyConfigured:true,baseUrl:'https://gateway.example/v1',models:['model-a','model-b'],selectedModel:'model-b',revision:1}
  const markup=render('ChatArea',React.createElement(components.ChatArea,{provider}))
  assert.match(markup,/value="model-b" selected=""/)
  assert.match(markup,/No silent substitution/)
  assert.match(markup,/not inference-verified/)
  assert.match(markup,/gateway.example/)

})


test('Provider Settings uses a password input and separates save from connection testing', () => {
  const markup=render('ProviderSettings',React.createElement(components.ProviderSettings,{onClose:noop}))
  assert.match(markup,/Provider Settings/)
  assert.match(markup,/type="password"/)
  assert.match(markup,/Save connection/)
  assert.match(markup,/Test connection/)
  assert.match(markup,/Remove connection/)
  assert.doesNotMatch(markup,/value="sk-/)
})
