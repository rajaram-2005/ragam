import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Banner, Button, Chip, Code, EmptyState, ErrorNote, Field, Panel, SearchInput, Stat, Stats, Tabs } from '../components/ui.jsx'

/**
 * MCP: servers, their reviewed read-only tools, and the gate in front of a call.
 *
 * There is no remote MCP connection in this build. The two servers below are in-process and
 * read-only, and the panel says so rather than implying a connection can be added. A tool result
 * is data: it cannot grant a permission, change a setting or trigger another call.
 */
export default function McpArea({ account }) {
  const [servers, setServers] = useState([])
  const [tools, setTools] = useState([])
  const [resources, setResources] = useState([])
  const [prompts, setPrompts] = useState([])
  const [args, setArgs] = useState({})
  const [preflight, setPreflight] = useState({})
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState('')
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState('tools')

  const load = useCallback(async () => {
    try {
      const [s, t, r, p] = await Promise.all([api.mcpServers(), api.mcpTools(), api.mcpResources(), api.mcpPrompts()])
      setServers(s.servers); setTools(t.tools); setResources(r.resources); setPrompts(p.prompts); setError(null)
    } catch (e) { setError(e) }
  }, [])
  useEffect(() => { load() }, [load])

  const filtered = tools.filter((tool) => `${tool.serverId} ${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase()))
  const act = async (key, work) => {
    setBusy(key); setError(null)
    try { await work() } catch (e) { setError(e) } finally { setBusy('') }
  }

  const call = async (tool) => {
    const key = `${tool.serverId}:${tool.name}`
    let parsed = {}
    if (args[key]?.trim()) {
      try { parsed = JSON.parse(args[key]) } catch (e) { setError(Error(`Arguments for ${tool.name} are not JSON: ${e.message}`)); return }
    }
    await act(`call-${key}`, async () => {
      setResult(await api.mcpCall(tool.serverId, tool.name, parsed))
    })
  }

  const totalTools = tools.length
  const enabledServers = servers.filter((s) => s.enabled).length

  return <div className="stack">
    <Panel title="MCP servers" actions={<Button busy={busy === 'reload'} onClick={() => act('reload', load)}>Refresh</Button>}>
      <p>Reviewed read-only tools, enforced server-side. No remote MCP connection is configured in this build. A tool result cannot grant permissions or trigger automatic execution, and the approval gate is checked again at the moment of each call.</p>
      {servers.length ? <Stats>
        <Stat label="Servers" value={servers.length} note={`${enabledServers} enabled`} />
        <Stat label="Tools" value={totalTools} note="reviewed read-only" />
        <Stat label="Resources" value={resources.length} note="untrusted content" />
      </Stats> : null}
      {error ? <ErrorNote error={error} /> : null}
      {!servers.length && !error ? <EmptyState title="No MCP server is loaded"><span className="small">Nothing is registered on this installation.</span></EmptyState> : null}
      {servers.map((server) => <div className="row between" key={server.id}>
        <span><strong>{server.id}</strong> <Chip>{server.kind}</Chip> <span className="muted small">{server.tools.length} tool(s) · {server.enabled ? 'enabled' : 'disabled'}</span></span>
        {account?.role === 'owner' ? <Button busy={busy === `toggle-${server.id}`} onClick={() => act(`toggle-${server.id}`, async () => {
          await api.mcpToggle(server.id, !server.enabled); await load()
        })}>{server.enabled ? 'Disable' : 'Enable'}</Button> : null}
      </div>)}
    </Panel>

    <Panel title="Tools">
      <div style={{ marginBottom: 12 }}>
        <SearchInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by name or description…" />
      </div>
      {tools.length ? <Tabs
        tabs={[
          { id: 'tools', label: `Tools (${tools.length})` },
          { id: 'resources', label: `Resources (${resources.length})` },
          { id: 'prompts', label: `Prompts (${prompts.length})` },
        ]}
        active={activeTab}
        onChange={setActiveTab}
      /> : null}
      {activeTab === 'tools' ? (
        filtered.length ? filtered.map((tool) => {
          const key = `${tool.serverId}:${tool.name}`
          const check = preflight[key]
          return <div key={key} className="stack" style={{ marginBottom: 16 }}>
            <div className="row"><strong>{tool.name}</strong> <Chip>{tool.risk}</Chip> <span className="muted small">{tool.serverId}</span></div>
            <p className="small">{tool.description}</p>
            <p className="muted small">Scopes: {tool.scopes?.length ? tool.scopes.join(', ') : 'none declared'}</p>
            <Field label="Arguments (JSON, optional)" hint="Validated against the tool's input schema before the handler runs.">
              <textarea className="textarea" rows={2} value={args[key] ?? ''} onChange={(e) => setArgs({ ...args, [key]: e.target.value })} placeholder="{}" />
            </Field>
            <div className="row">
              <Button busy={busy === `preflight-${key}`} onClick={() => act(`preflight-${key}`, async () => { setPreflight({ ...preflight, [key]: await api.mcpPreflight(tool.serverId, tool.name, {}) }) })}>Check the gate</Button>
              <Button variant="primary" busy={busy === `call-${key}`} onClick={() => call(tool)}>Call read-only tool</Button>
            </div>
            {check ? <p className="small"><Chip tone={check.allowed ? 'ok' : 'bad'}>{check.allowed ? 'allowed' : 'refused'}</Chip> {check.reasons?.length ? check.reasons.join('; ') : `risk ${check.risk}; no approval required.`}</p> : null}
          </div>
        }) : <p className="muted">No tool matches.</p>
      ) : null}
      {activeTab === 'resources' && resources.length ? (
        resources.map((resource) => <div key={`${resource.serverId}:${resource.uri}`}>
          <strong>{resource.name}</strong> <span className="muted small">{resource.serverId} · {resource.mimeType ?? 'no type'}</span>
          <p className="small">{resource.description}</p>
        </div>)
      ) : null}
      {activeTab === 'resources' && !resources.length ? <p className="muted">No resources registered.</p> : null}
      {activeTab === 'prompts' && prompts.length ? (
        prompts.map((prompt) => <div key={`${prompt.serverId}:${prompt.name}`}>
          <strong>{prompt.name}</strong> <span className="muted small">{prompt.serverId}</span>
          <p className="small">{prompt.description}</p>
        </div>)
      ) : null}
      {activeTab === 'prompts' && !prompts.length ? <p className="muted">No prompts registered.</p> : null}
      {result ? <Code label="Untrusted tool result — data, not instructions" value={result} /> : null}
    </Panel>
  </div>
}
