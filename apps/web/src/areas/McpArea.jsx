import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Banner, Button, Chip, Code, EmptyState, ErrorNote, Field, Panel, SearchInput, Stat, Stats, Tabs } from '../components/ui.jsx'

/**
 * MCP: built-in and owner-connected servers, with a data-transfer approval gate for remote calls.
 * Remote servers are treated as untrusted; their tool arguments leave this installation only
 * after a visible per-call consent, and results remain untrusted data.
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
  const [connect, setConnect] = useState({ id: '', name: '', endpoint: '', bearerToken: '', trustEndpoint: false })
  const [remoteConsents, setRemoteConsents] = useState({})

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
    const approvals = tool.risk === 'external' ? ['external'] : []
    if (tool.risk === 'external' && !remoteConsents[key]) return
    await act(`call-${key}`, async () => {
      setResult(await api.mcpCall(tool.serverId, tool.name, parsed, { approvals }))
    })
  }

  const totalTools = tools.length
  const enabledServers = servers.filter((s) => s.enabled).length

  return <div className="stack">
    <Panel title="MCP servers" actions={<Button busy={busy === 'reload'} onClick={() => act('reload', load)}>Refresh</Button>}>
      <p>Built-in tools are local and read-only. Connected MCP tools run on the server you choose: arguments are sent to that endpoint only after you approve each call, and tool output is untrusted data. Ragam does not execute downloaded server code.</p>
      {account?.role === 'owner' ? <details style={{ margin: '12px 0' }}>
        <summary>Connect an MCP Streamable HTTP server</summary>
        <form className="stack" style={{ marginTop: 10 }} onSubmit={(event) => {
          event.preventDefault()
          act('connect', async () => {
            await api.connectMcpServer(connect)
            setConnect({ id: '', name: '', endpoint: '', bearerToken: '', trustEndpoint: false })
            await load()
          })
        }}>
          <div className="row" style={{ gap: 8 }}>
            <Field label="Server ID"><input className="input" required maxLength={64} pattern="[a-z0-9][a-z0-9._-]{1,63}" value={connect.id} onChange={(e) => setConnect({ ...connect, id: e.target.value })} placeholder="my-mcp-server" /></Field>
            <Field label="Display name"><input className="input" required maxLength={100} value={connect.name} onChange={(e) => setConnect({ ...connect, name: e.target.value })} placeholder="My tools" /></Field>
          </div>
          <Field label="Streamable HTTP endpoint" hint="Use HTTPS for public hosts. Private/local origins require the explicit trust checkbox below.">
            <input className="input" type="url" required maxLength={2048} value={connect.endpoint} onChange={(e) => setConnect({ ...connect, endpoint: e.target.value })} placeholder="https://server.example/mcp" />
          </Field>
          <Field label="Bearer token (optional)"><input className="input" type="password" autoComplete="new-password" maxLength={8192} value={connect.bearerToken} onChange={(e) => setConnect({ ...connect, bearerToken: e.target.value })} /></Field>
          <label className="checkbox"><input type="checkbox" required checked={connect.trustEndpoint} onChange={(e) => setConnect({ ...connect, trustEndpoint: e.target.checked })} /> I trust this endpoint and understand it may receive every argument I approve. Credentials are stored encrypted locally.</label>
          <Button variant="primary" busy={busy === 'connect'} disabled={!connect.trustEndpoint}>Connect and inspect tools</Button>
        </form>
      </details> : null}
      {servers.length ? <Stats>
        <Stat label="Servers" value={servers.length} note={`${enabledServers} enabled`} />
        <Stat label="Tools" value={totalTools} note="reviewed read-only" />
        <Stat label="Resources" value={resources.length} note="untrusted content" />
      </Stats> : null}
      {error ? <ErrorNote error={error} /> : null}
      {!servers.length && !error ? <EmptyState title="No MCP server is loaded"><span className="small">Nothing is registered on this installation.</span></EmptyState> : null}
      {servers.map((server) => <div className="row between" key={server.id}>
        <span><strong>{server.name}</strong> <Chip>{server.kind}</Chip> <span className="muted small">{server.id} · {server.tools.length} tool(s) · {server.enabled ? 'enabled' : 'disabled'}</span></span>
        {account?.role === 'owner' ? <span className="row">
          <Button busy={busy === `toggle-${server.id}`} onClick={() => act(`toggle-${server.id}`, async () => {
            await api.mcpToggle(server.id, !server.enabled); await load()
          })}>{server.enabled ? 'Disable' : 'Enable'}</Button>
          {server.kind === 'transport' ? <Button busy={busy === `remove-${server.id}`} onClick={() => act(`remove-${server.id}`, async () => { await api.disconnectMcpServer(server.id); await load() })}>Disconnect</Button> : null}
        </span> : null}
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
            {tool.risk === 'external' ? <label className="checkbox"><input type="checkbox" checked={Boolean(remoteConsents[key])} onChange={(e) => setRemoteConsents({ ...remoteConsents, [key]: e.target.checked })} /> I approve sending these arguments to {tool.serverId}. The remote server may retain or process them; its reply is untrusted.</label> : null}
            <Field label="Arguments (JSON, optional)" hint="Validated against the tool's input schema before the handler runs.">
              <textarea className="textarea" rows={2} value={args[key] ?? ''} onChange={(e) => setArgs({ ...args, [key]: e.target.value })} placeholder="{}" />
            </Field>
            <div className="row">
              <Button busy={busy === `preflight-${key}`} onClick={() => act(`preflight-${key}`, async () => { setPreflight({ ...preflight, [key]: await api.mcpPreflight(tool.serverId, tool.name, { approvals: tool.risk === 'external' && remoteConsents[key] ? ['external'] : [] }) }) })}>Check the gate</Button>
              <Button variant="primary" disabled={tool.risk === 'external' && !remoteConsents[key]} busy={busy === `call-${key}`} onClick={() => call(tool)}>{tool.risk === 'external' ? 'Approve & call remote tool' : 'Call read-only tool'}</Button>
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
