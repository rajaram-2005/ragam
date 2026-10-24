import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Banner, Button, Chip, Code, EmptyState, ErrorNote, Panel, SearchInput, Stat, Stats } from '../components/ui.jsx'

/**
 * Plugins: the reviewed built-ins only.
 *
 * Installation of custom code is disabled, and the page says so before listing anything. Each
 * capability is a read-only tool with a declared scope; the gate is checked by the server before
 * the handler runs, and a result is data rather than an instruction or a permission.
 */
export default function PluginsArea() {
  const [plugins, setPlugins] = useState([])
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [checks, setChecks] = useState({})
  const [busy, setBusy] = useState('')
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    try { setPlugins((await api.plugins()).plugins); setError(null) } catch (e) { setError(e) }
  }, [])
  useEffect(() => { load() }, [load])

  const act = async (key, work) => {
    setBusy(key); setError(null)
    try { await work() } catch (e) { setError(e) } finally { setBusy('') }
  }

  const filtered = useMemo(() => {
    if (!query.trim()) return plugins
    const q = query.toLowerCase()
    return plugins.filter((p) => `${p.name} ${p.id} ${p.description}`.toLowerCase().includes(q))
  }, [plugins, query])

  const totalCapabilities = plugins.reduce((sum, p) => sum + (p.capabilities?.length ?? 0), 0)
  const readOnlyCount = plugins.reduce((sum, p) => sum + (p.capabilities?.filter((c) => c.readOnly).length ?? 0), 0)

  return <div className="stack">
    <Panel title="Reviewed plugins" actions={<Button busy={busy === 'reload'} onClick={() => act('reload', load)}>Refresh</Button>}>
      <p>Only trusted, built-in, read-only tools are enabled in this build. Arbitrary extension installation and execution are disabled; signing alone is not a sandbox. Every capability declares its scopes, and the server checks them again at call time.</p>
      {plugins.length ? <Stats>
        <Stat label="Plugins" value={plugins.length} note="reviewed built-ins" />
        <Stat label="Capabilities" value={totalCapabilities} note="declared tools" />
        <Stat label="Read-only" value={readOnlyCount} note="no write access" />
      </Stats> : null}
      <div style={{ marginBottom: 12 }}>
        <SearchInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search plugins and capabilities…" />
      </div>
      {error ? <ErrorNote error={error} /> : null}
      {!plugins.length && !error ? <EmptyState title="No reviewed plugin is loaded"><span className="small">Installation of custom extensions is disabled, so this list stays empty unless a built-in ships with the build.</span></EmptyState> : null}
      {filtered.length === 0 && plugins.length > 0 ? <EmptyState title="No plugin matches"><span className="small">Nothing matches "{query}". Try a different search term.</span></EmptyState> : null}
      {filtered.map((plugin) => <div className="stack" key={plugin.id} style={{ marginBottom: 16 }}>
        <div className="row">
          <strong>{plugin.name}</strong>
          <Chip>{plugin.state ?? (plugin.enabled ? 'enabled' : 'disabled')}</Chip>
          <span className="muted small">{plugin.id} · v{plugin.version}</span>
        </div>
        <p className="small">{plugin.description}</p>
        <p className="muted small">Scopes: {plugin.scopes?.length ? plugin.scopes.join(', ') : 'none declared'}</p>
        {(plugin.capabilities ?? []).map((capability) => {
          const key = `${plugin.id}:${capability.name}`
          const check = checks[key]
          return <div className="stack" key={capability.name} style={{ marginBottom: 8 }}>
            <div className="row">
              <strong>{capability.name}</strong>
              <Chip tone={capability.readOnly ? 'ok' : 'bad'}>{capability.readOnly ? 'read-only' : 'writes'}</Chip>
            </div>
            <p className="small">{capability.description}</p>
            <div className="row">
              <Button onClick={() => act(`check-${key}`, async () => { setChecks({ ...checks, [key]: await api.pluginPreflight(plugin.id, capability.name, {}) }) })}>Check the gate</Button>
              <Button variant="primary" busy={busy === `run-${key}`} onClick={() => act(`run-${key}`, async () => { setResult(await api.pluginInvoke(plugin.id, capability.name, {})) })}>Run read-only tool</Button>
            </div>
            {check ? <p className="small"><Chip tone={check.allowed ? 'ok' : 'bad'}>{check.allowed ? 'allowed' : 'refused'}</Chip> {check.reasons?.length ? check.reasons.join('; ') : 'no approval required.'}</p> : null}
          </div>
        })}
      </div>)}
      {result ? <Code label="Tool result — data, not instructions" value={result} /> : null}
    </Panel>
  </div>
}
