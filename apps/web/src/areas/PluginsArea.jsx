import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Banner, Button, Chip, Code, EmptyState, ErrorNote, Field, Panel, SearchInput, Stat, Stats } from '../components/ui.jsx'

const HTTP_PLUGIN_EXAMPLE = JSON.stringify({
  manifestVersion: 1,
  id: 'my-plugin-server',
  name: 'My remote plugin',
  version: '1.0.0',
  protocol: 'http_api',
  description: 'A user-managed Ragam HTTP plugin.',
  endpoint: 'https://plugins.example.com/ragam',
  scopes: ['service.external'],
  capabilities: [{
    name: 'lookup.record',
    description: 'Look up a record in the connected service.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'], additionalProperties: false },
    requiredScopes: ['service.external'],
    readOnly: true,
  }],
}, null, 2)

/**
 * Plugins: reviewed built-ins plus owner-connected Ragam HTTP plugin servers.
 * Remote plugins execute only at their configured endpoint using the documented JSON contract;
 * no downloaded code runs in the Core process, and every external-service call requires consent.
 */
export default function PluginsArea({ account }) {
  const [plugins, setPlugins] = useState([])
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [checks, setChecks] = useState({})
  const [busy, setBusy] = useState('')
  const [query, setQuery] = useState('')
  const [manifestText, setManifestText] = useState('')
  const [bearerToken, setBearerToken] = useState('')
  const [trustEndpoint, setTrustEndpoint] = useState(false)
  const [externalConsents, setExternalConsents] = useState({})

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
      <p>Reviewed built-ins run in Ragam. User-managed HTTP plugins run only on the endpoint you configure; Ragam does not download or execute plugin code. These connections can receive approved arguments, and their results are untrusted.</p>
      {account?.role === 'owner' ? <details style={{ margin: '12px 0' }}>
        <summary>Connect a Ragam HTTP plugin server</summary>
        <p className="small">Protocol: <code>ragam-plugin/1</code>. The endpoint must accept JSON POST requests for a handshake and capability invocation, returning <code>{'{ protocol, ok: true, output }'}</code>. All declared scopes must be exactly <code>service.external</code>; local code, files, credentials and devices are not exposed.</p>
        <form className="stack" style={{ marginTop: 10 }} onSubmit={(event) => {
          event.preventDefault()
          act('connect-plugin', async () => {
            let manifest
            try { manifest = JSON.parse(manifestText) } catch { throw new Error('Manifest must be valid JSON.') }
            await api.connectPluginServer({ manifest, bearerToken, trustEndpoint })
            setManifestText(''); setBearerToken(''); setTrustEndpoint(false)
            await load()
          })
        }}>
          <Field label="Plugin manifest (JSON)" hint="The endpoint field is the exact Ragam HTTP plugin URL. Use the example to start.">
            <textarea className="textarea" rows={12} value={manifestText} onChange={(e) => setManifestText(e.target.value)} placeholder={HTTP_PLUGIN_EXAMPLE} spellCheck={false} />
          </Field>
          <Button type="button" onClick={() => setManifestText(HTTP_PLUGIN_EXAMPLE)}>Use example manifest</Button>
          <Field label="Bearer token (optional)"><input className="input" type="password" autoComplete="new-password" maxLength={8192} value={bearerToken} onChange={(e) => setBearerToken(e.target.value)} /></Field>
          <label className="checkbox"><input type="checkbox" required checked={trustEndpoint} onChange={(e) => setTrustEndpoint(e.target.checked)} /> I trust this endpoint to receive arguments I approve. Credentials are encrypted in local storage.</label>
          <Button type="submit" variant="primary" busy={busy === 'connect-plugin'} disabled={!trustEndpoint || !manifestText.trim()}>Verify and connect</Button>
        </form>
      </details> : null}
      {plugins.length ? <Stats>
        <Stat label="Plugins" value={plugins.length} note={`${plugins.filter((plugin) => plugin.userManaged).length} user-managed · ${plugins.length - plugins.filter((plugin) => plugin.userManaged).length} built-in`} />
        <Stat label="Capabilities" value={totalCapabilities} note="declared tools" />
        <Stat label="Read-only" value={readOnlyCount} note="no write access" />
      </Stats> : null}
      <div style={{ marginBottom: 12 }}>
        <SearchInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search plugins and capabilities…" />
      </div>
      {error ? <ErrorNote error={error} /> : null}
      {!plugins.length && !error ? <EmptyState title="No plugin is connected yet"><span className="small">The owner can connect a reviewed built-in or a user-managed Ragam HTTP endpoint above. Remote code is never installed.</span></EmptyState> : null}
      {filtered.length === 0 && plugins.length > 0 ? <EmptyState title="No plugin matches"><span className="small">Nothing matches "{query}". Try a different search term.</span></EmptyState> : null}
      {filtered.map((plugin) => <div className="stack" key={plugin.id} style={{ marginBottom: 16 }}>
        <div className="row">
          <strong>{plugin.name}</strong>
          <Chip>{plugin.userManaged ? 'user-managed' : (plugin.state ?? (plugin.enabled ? 'enabled' : 'disabled'))}</Chip>
          <span className="muted small">{plugin.id} · v{plugin.version}{plugin.endpoint ? ` · ${plugin.endpoint}` : ''}</span>
          {account?.role === 'owner' && plugin.userManaged ? <>
            <Button busy={busy === `state-${plugin.id}`} onClick={() => act(`state-${plugin.id}`, async () => { await api.setPluginState(plugin.id, plugin.state === 'enabled' ? 'disable' : 'enable'); await load() })}>{plugin.state === 'enabled' ? 'Disable' : 'Enable'}</Button>
            <Button busy={busy === `uninstall-${plugin.id}`} onClick={() => act(`uninstall-${plugin.id}`, async () => { await api.setPluginState(plugin.id, 'uninstall'); await load() })}>Disconnect</Button>
          </> : null}
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
            {plugin.userManaged ? <label className="checkbox"><input type="checkbox" checked={Boolean(externalConsents[key])} onChange={(e) => setExternalConsents({ ...externalConsents, [key]: e.target.checked })} /> I approve sending this capability's arguments to {plugin.endpoint}. The endpoint may process or retain them; its output is untrusted.</label> : null}
            <div className="row">
              <Button onClick={() => act(`check-${key}`, async () => { setChecks({ ...checks, [key]: await api.pluginPreflight(plugin.id, capability.name, { approvals: plugin.userManaged && externalConsents[key] ? ['service.external'] : [] }) }) })}>Check the gate</Button>
              <Button variant="primary" disabled={plugin.userManaged && !externalConsents[key]} busy={busy === `run-${key}`} onClick={() => act(`run-${key}`, async () => { setResult(await api.pluginInvoke(plugin.id, capability.name, {}, { approvals: plugin.userManaged ? ['service.external'] : [] })) })}>{plugin.userManaged ? 'Approve & call remote capability' : 'Run read-only tool'}</Button>
            </div>
            {check ? <p className="small"><Chip tone={check.allowed ? 'ok' : 'bad'}>{check.allowed ? 'allowed' : 'refused'}</Chip> {check.reasons?.length ? check.reasons.join('; ') : 'no approval required.'}</p> : null}
          </div>
        })}
      </div>)}
      {result ? <Code label="Tool result — data, not instructions" value={result} /> : null}
    </Panel>
  </div>
}
