// Structural guarantees about the product surface.
//
// The hard constraint on this app is not aesthetic: there must be EXACTLY five
// user-facing areas — Chat, Image, Video, Plugins, MCP — and every other
// subsystem (routing, memory, safety, model management, God Core, training,
// benchmarking, resources, execution control) must be internal, surfaced inside
// those areas rather than as a sixth tab.
//
// Upstream Aetheris shipped twelve navigation entries, so this is a real regression
// risk rather than a hypothetical one: adding a dashboard is the easy way to make a
// status visible, and it is the wrong way here. These tests read the source and
// fail if the surface grows.
//
// They also pin two things that are easy to lose silently:
//   - browser-facing code never contains an absolute host (the browser is not the
//     sandbox, so a hard-coded loopback URL breaks behind any preview proxy)
//   - the upstream visual identity survives the restructuring

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { AREAS, AREA_IDS } from '../src/areas.js'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', 'src')
const read = (relative) => readFileSync(join(srcDir, relative), 'utf8')

// ---------------------------------------------------------------------------
// Exactly five product areas
// ---------------------------------------------------------------------------

test('there are exactly five product areas, with the required ids', () => {
  assert.equal(AREAS.length, 5, `expected 5 product areas, found ${AREAS.length}: ${AREAS.map((area) => area.id).join(', ')}`)
  assert.deepEqual(AREAS.map((area) => area.id), ['chat', 'image', 'video', 'plugins', 'mcp'])
  assert.deepEqual(AREAS.map((area) => area.label), ['Chat', 'Image', 'Video', 'Plugins', 'MCP'])
  for (const area of AREAS) {
    assert.ok(area.hint && area.hint.length > 0, `${area.id} needs a hint describing what it covers`)
    assert.ok(area.glyph, `${area.id} needs a nav glyph`)
  }
})

test('no internal service is exposed as a navigation entry', () => {
  // These were all top-level sections upstream. They are internal now, so none of
  // them may be an area LABEL. (Hints are allowed to name them: a hint saying
  // "reasoning · knowledge · tasks" is how an internal service is advertised inside
  // Chat, which is exactly what the requirement asks for.)
  const forbidden = [
    'observability', 'architecture', 'workflows', 'agents', 'models', 'devices',
    'command', 'coding', 'knowledge', 'studio', 'training', 'benchmark',
    'god core', 'godcore', 'memory', 'safety', 'routing', 'resources', 'fabric',
    'dashboard', 'monitor', 'settings', 'admin', 'console',
  ]
  for (const area of AREAS) {
    const label = area.label.toLowerCase()
    for (const word of forbidden) {
      assert.ok(!label.includes(word), `navigation label "${area.label}" exposes internal service '${word}' as a product area`)
    }
  }
})

test('area hints advertise the internal services that live inside each area', () => {
  const byId = Object.fromEntries(AREAS.map((area) => [area.id, area.hint.toLowerCase()]))
  assert.match(byId.chat, /knowledge/, 'Chat is where the private knowledge pipeline is surfaced')
  assert.match(byId.chat, /history/, 'Chat retains conversation history')
  assert.match(byId.image, /validation/, 'Image is where output validation is surfaced')
  assert.match(byId.video, /provenance/, 'Video is where provenance checking is surfaced')
  assert.match(byId.plugins, /permission/, 'Plugins is where the permission model is surfaced')
  assert.match(byId.mcp, /gate/, 'MCP is where approval gates are surfaced')
})

test('the navigation renders AREAS and nothing else', () => {
  const shell = read('components/Shell.jsx')
  // One nav-item button, driven by the AREAS map.
  assert.equal(shell.match(/className=\{`nav-item/g)?.length ?? 0, 1, 'the sidebar must build nav items from AREAS only')
  assert.ok(shell.includes('AREAS.map'), 'navigation must be generated from the AREAS list')
  assert.ok(shell.includes("from '../areas.js'"), 'the area list must come from areas.js, not be redeclared')
  // No second navigation array hiding in the shell.
  assert.ok(!/label:\s*'[A-Z]/.test(shell), 'Shell.jsx must not declare its own nav entries')
  assert.ok(!/\{\s*id:\s*'[a-z]+',\s*label:/.test(shell), 'Shell.jsx must not declare an area list literal')
})

test('the area list is frozen so it cannot grow at runtime', async () => {
  assert.ok(Object.isFrozen(AREAS), 'AREAS must be frozen')
  assert.ok(Object.isFrozen(AREA_IDS))
  for (const area of AREAS) assert.ok(Object.isFrozen(area), `${area.id} must be frozen`)
  assert.throws(() => {
    'use strict'
    AREAS.push({ id: 'dashboard', label: 'Dashboard', hint: 'nope', glyph: 'x' })
  }, TypeError)
})

test('exactly one area component exists per product area', () => {
  const files = readdirSync(join(srcDir, 'areas')).filter((name) => name.endsWith('.jsx')).sort()
  assert.deepEqual(files, ['ChatArea.jsx', 'ImageArea.jsx', 'McpArea.jsx', 'PluginsArea.jsx', 'VideoArea.jsx'])
})

test('App renders the five areas and imports no sixth', () => {
  const app = read('App.jsx')
  const imports = app.match(/from '\.\/areas\/([A-Za-z]+)\.jsx'/g) ?? []
  assert.equal(imports.length, 5, `App.jsx imports ${imports.length} areas: ${imports.join(', ')}`)
  for (const area of AREAS) {
    assert.ok(app.includes(`area.id === '${area.id}'`), `App.jsx does not render the '${area.id}' area`)
  }
  // Internal services appear as panels inside areas, never as routes.
  assert.ok(!/Route|createBrowserRouter|<Router/.test(app), 'the app must not grow a router with extra pages')
  assert.ok(app.includes('ChatArea') && app.includes('McpArea'))
})

test('online areas remove offline and research surfaces without removing optional context', () => {
  const chat=read('areas/ChatArea.jsx')
  assert.match(chat, /KnowledgePanel/)
  assert.match(chat, /MemoryPanel/)
  assert.match(chat, /HistoryPanel/)
  assert.doesNotMatch(chat, /TaskPanel|SkillsPanel|ModelCatalog|ExecutionMode/)
  for (const area of ['Image','Video']) assert.match(read(`areas/${area}Area.jsx`), /no simulated output/i)

})

test('the runtime policy is displayed, never toggled from the browser', () => {
  const shell = read('components/Shell.jsx')
  assert.match(shell, /Online only/, 'the sidebar names the online-only policy')
  // Policy comes from server config; a client-side switch would be a fake control.
  for (const file of ['App.jsx', 'components/Shell.jsx', 'api.js']) {
    const source = read(file)
    assert.ok(!/setPolicy|changePolicy|policy:\s*'hybrid'|AETHERIS_POLICY\s*=/.test(source), `${file} must not offer a way to change the runtime policy`)
  }
})

// ---------------------------------------------------------------------------
// Browser-facing code never hard-codes a host
// ---------------------------------------------------------------------------

function walk(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, base))
    else if (/\.(jsx?|css|html)$/.test(entry.name)) out.push(full)
  }
  return out
}

test('no browser-facing source contains an absolute host', () => {
  const offenders = []
  for (const file of walk(srcDir)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      const trimmed = line.trim()
      // Comments may explain why a loopback URL must NOT be used; code may not use one.
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
      if (/https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(line)) {
        offenders.push(`${file.replace(basePrefix(), '')}:${index + 1}: ${trimmed}`)
      }
    })
  }
  assert.deepEqual(offenders, [], `browser-facing code must use relative /api paths:\n${offenders.join('\n')}`)
})

function basePrefix() {
  return join(here, '..') + '/'
}

test('the dev-server proxy target is the only place a loopback host appears', () => {
  const config = readFileSync(join(here, '..', 'vite.config.js'), 'utf8')
  assert.match(config, /AETHERIS_CORE_URL/, 'the backend URL must be configurable')
  assert.match(config, /'\/api'/, 'the proxy must cover /api')
  assert.match(config, /host: '0\.0\.0\.0'/, 'the dev server must bind all interfaces to work behind a preview proxy')
  assert.match(config, /allowedHosts: true/, 'the dev server must accept a proxied preview host')

  const html = readFileSync(join(here, '..', 'index.html'), 'utf8')
  assert.ok(!/https?:\/\/(localhost|127\.0\.0\.1)/.test(html), 'index.html must not embed an absolute backend URL')
})

// ---------------------------------------------------------------------------
// Upstream visual identity is preserved
// ---------------------------------------------------------------------------

test('the upstream design tokens are carried over unchanged', () => {
  const css = read('styles.css')
  const required = [
    ['--bg: #090c0e', /--bg:\s*#090c0e/],
    ['surface', /--surface:\s*#0e1316/],
    ['line', /--line:\s*rgba\(222,\s*244,\s*239/],
    ['text', /--text:\s*#ecf5f2/],
    ['mint accent', /#b5f5d8/],
    ['mint strong', /#73dfb4/],
    ['violet accent', /#c9c0ff/],
    ['violet strong', /#9484ff/],
    ['gold accent', /#e7cc8e/],
    ['gold strong', /#c9a756/],
    ['blue accent', /#99d7f4/],
    ['blue strong', /#62bde8/],
    ['coral accent', /#f2a58f/],
    ['coral strong', /#e98066/],
    ['radius', /--radius:\s*13px/],
    ['Manrope', /Manrope/],
    ['DM Mono', /DM Mono/],
  ]
  const missing = required.filter(([, pattern]) => !pattern.test(css)).map(([name]) => name)
  assert.deepEqual(missing, [], `visual identity tokens lost: ${missing.join(', ')}`)
})

test('the upstream shell structure survives the restructuring', () => {
  const css = read('styles.css')
  for (const selector of ['.app-shell', '.sidebar', '.brand-mark', '.nav-item', '.fabric-status', '.main-shell', '.topbar', '.scroll-area']) {
    assert.ok(css.includes(selector), `${selector} is part of the upstream identity and must remain`)
  }
  assert.match(css, /width:\s*250px/, 'the sidebar keeps its upstream width')
  // The fixed grid overlay and the two radial gradients are the signature backdrop.
  assert.match(css, /background-size:\s*52px 52px/, 'the 52px grid overlay must remain')
  assert.equal(css.match(/radial-gradient/g)?.length ?? 0, 2, 'both radial gradients must remain')
  assert.match(css, /\.nav-item\.active/, 'the active nav treatment must remain')
})

test('development fixtures are labelled in the interface itself', () => {
  const css = read('styles.css')
  assert.match(css, /\.fixture-tag/, 'the fixture tag style must exist')
  const ui = read('components/ui.jsx')
  assert.match(ui, /FixtureTag/, 'a FixtureTag component must exist')
  const plugins = read('areas/PluginsArea.jsx')
  assert.doesNotMatch(plugins, /SAMPLE_MANIFEST|demo.texttools/, 'sample installers are absent from the active UI')
})

// ---------------------------------------------------------------------------
// Dependency discipline
// ---------------------------------------------------------------------------

test('the app has no runtime dependency beyond React', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), ['react', 'react-dom'])
  // Build tooling only, and pinned exactly so a surprise major cannot slip in.
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}).sort(), ['@vitejs/plugin-react', 'vite'])
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must be pinned to an exact version, got ${version}`)
  }
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.license, 'MIT')
})

test('the built bundle stays small enough that a hidden dependency would show', () => {
  const dist = join(here, '..', 'dist', 'assets')
  if (!existsSync(dist)) return // build output is not committed; run `npm run build` first
  const scripts = readdirSync(dist).filter((name) => name.endsWith('.js'))
  assert.equal(scripts.length, 1, `expected a single bundle, found ${scripts.join(', ')}`)
  const bytes = readFileSync(join(dist, scripts[0])).byteLength
  assert.ok(bytes < 400 * 1024, `bundle grew to ${(bytes / 1024).toFixed(0)} KB — an unplanned dependency is likely`)
})

// ---------------------------------------------------------------------------
// A re-export is not an import.
//
// `export { X } from './x.js'` forwards a binding to IMPORTERS; it does not create
// one in this module's scope. Shell.jsx did exactly that and then called
// AREAS.map(...), so the whole interface threw "AREAS is not defined" on render.
//
// The test above ("the navigation renders AREAS and nothing else") passed while the
// app was broken, because it asserted shell.includes("from '../areas.js'") — and a
// re-export line contains that string too. Compile-time and source-text checks
// cannot see this class of bug; only rendering can. render.test.mjs catches the
// instance, and this catches the class, so a new one cannot be introduced silently.
// ---------------------------------------------------------------------------

function sourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(path))
    else if (/\.(js|jsx|mjs)$/.test(entry.name)) out.push(path)
  }
  return out
}

test('no module re-exports a name it also uses locally', () => {
  const offenders = []

  for (const path of sourceFiles(srcDir)) {
    const text = readFileSync(path, 'utf8')

    // Names forwarded by `export { A, B as C } from '...'` — these have no local binding.
    const forwarded = new Set()
    for (const match of text.matchAll(/^export \{([^}]*)\} from/gm)) {
      for (const part of match[1].split(',')) {
        const name = part.trim()
        if (name) forwarded.add(name.split(/\s+as\s+/).pop().trim())
      }
    }
    if (forwarded.size === 0) continue

    // Everything except the re-export lines: this is where a local use would appear.
    const body = text.replace(/^export \{[^}]*\} from.*$/gm, '')

    for (const name of forwarded) {
      // A local import of the same name makes the use legal, so only flag names that
      // are forwarded and referenced but never imported or declared.
      const imported = new RegExp(`^import\\s[^\\n]*\\b${name}\\b`, 'm').test(body)
      const declared = new RegExp(`^(?:const|let|var|function|class)\\s+${name}\\b`, 'm').test(body)
      const used = new RegExp(`\\b${name}\\b`).test(body)
      if (used && !imported && !declared) {
        offenders.push(`${path.replace(srcDir + '/', '')} re-exports '${name}' but also uses it locally`)
      }
    }
  }

  assert.deepEqual(offenders, [], offenders.join('\n'))
})

test('Shell.jsx imports the area list, not only re-exports it', () => {
  // The specific regression, pinned directly: the navigation calls AREAS.map, so
  // AREAS must be bound in this module's own scope.
  const shell = read('components/Shell.jsx')
  assert.ok(
    /^import \{[^}]*\bAREAS\b[^}]*\} from '\.\.\/areas\.js'/m.test(shell),
    'Shell.jsx must IMPORT AREAS; a re-export alone leaves AREAS.map() unbound at render time',
  )
  assert.ok(shell.includes('AREAS.map'), 'the navigation must still be generated from AREAS')
})

// --- memory and history in Chat -----------------------------------------------------

test('Chat surfaces memory and history as internal services inside the area', () => {
  const chat=read('areas/ChatArea.jsx'), panels=read('components/ContextPanels.jsx')
  assert.match(chat, /<details className="context-section"/)
  assert.match(chat, /<MemoryPanel/);assert.match(chat, /<HistoryPanel/)
  assert.match(panels, /title="Memory you approved"/)
  assert.match(panels, /title="Conversation history"/)

})

test('memory is offered as a switch, off by default, and described in ordinary words', () => {
  const chat=read('areas/ChatArea.jsx')
  assert.match(chat,/\[useMemory, setUseMemory\] = useState\(false\)/)
  assert.match(chat,/Send matching approved memories to this gateway/)
  assert.match(chat,/includeContext: useKnowledge \|\| useMemory/)

})

test('the history panel reports an empty search rather than filling it in', () => {
  const chat = read('components/ContextPanels.jsx')
  assert.match(chat, /Nothing was\s+invented to fill the result/)
  assert.match(chat, /Searched \{hits\.searchedTurns\}/)
})

test('a session is created lazily, so a visit with no question stores nothing', () => {
  const chat=read('areas/ChatArea.jsx')
  assert.match(chat,/if \(!id\)/)
  assert.match(chat,/api\.startSession\(content\.slice/)
  assert.match(chat,/signal: controller\.signal/)
  assert.match(chat,/setSessionId\(null\)/)

})

test('the memory panel confirms what the server actually reported', () => {
  const chat = read('components/ContextPanels.jsx')
  // The store distinguishes a stored memory from a duplicate and says how many rows a wipe
  // removed. A confirmation that is true either way throws that away.
  assert.match(chat, /result\?\.duplicate \? 'That is already remembered/)
  assert.match(chat, /Removed \$\{result\?\.deletedMemories \?\? 0\} memories and \$\{result\?\.deletedCandidates \?\? 0\} proposals/)
})

test('memory can be exported, not only deleted', () => {
  const chat = read('components/ContextPanels.jsx')
  assert.match(chat, /api\.exportMemory\(\)/)
  assert.match(chat, /Download a copy/)
  // The export states its own terms, and the confirmation repeats them rather than
  // claiming the copy is unrestricted.
  assert.match(chat, /marked \$\{envelope\.consent\} and training use \$\{envelope\.trainingUse\}/)
})

test('the security controls the product added are visible in their areas', () => {
  assert.match(read('areas/PluginsArea.jsx'),/signing alone is not a sandbox/)
  assert.match(read('areas/McpArea.jsx'),/cannot grant permissions/)
  assert.match(read('App.jsx'),/api\.login\(token/)
  const settings=read('components/ProviderSettings.jsx')
  assert.match(settings,/type="password"/)
  assert.doesNotMatch(settings,/localStorage|sessionStorage/)

})

test('ordinary generation has a Stop control, unmount cleanup, and preserves partial text and drafts', () => {
  const chat=read('areas/ChatArea.jsx')
  assert.match(chat,/Stop generation/)
  assert.match(chat,/useEffect\(\(\) => \(\) => abort\.current\?\.abort\(\), \[\]\)/)
  assert.match(chat,/signal: controller\.signal/)
  assert.match(chat,/draft is retained/)
  assert.match(chat,/if \(!completed\) throw/)
  assert.match(chat,/setPrompt\(\(draft\) => draft\.trim\(\) === content/)
  assert.match(chat,/filter\(\(m\) => !m\.failed\)/)

})

test('gateway models are selected explicitly and remote refresh requires an action', () => {
  const chat=read('areas/ChatArea.jsx'), settings=read('components/ProviderSettings.jsx')
  assert.match(chat,/api\.selectModel\(next\)/)
  assert.match(chat,/provider\?\.selectedModel/)
  assert.match(settings,/Test connection & refresh models/)
  assert.match(settings,/api\.testProvider/)
  assert.doesNotMatch(chat,/router decides|ModelCatalog|ExecutionMode/)

})
