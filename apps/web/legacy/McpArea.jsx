import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { Banner, Button, Chip, Code, EmptyState, ErrorNote, Field, Kv, Panel, Stat, Stats, Table } from '../components/ui.jsx'

// ---------------------------------------------------------------------------
// MCP.
//
// Every tool result is treated as untrusted: the backend neutralises output before
// it can reach a model prompt, and the interface repeats that framing rather than
// rendering returned text as instruction. Destructive, external and system risk
// tiers always need an explicit approval, which is a checkbox the operator has to
// tick per call — never a default.
// ---------------------------------------------------------------------------

const RISK_TONES = { read_only: 'ok', write: 'info', destructive: 'bad', external: 'warn', system: 'warn' }
const ALWAYS_APPROVED = new Set(['destructive', 'external', 'system'])

// Mirrors ELEVATED_SCOPES in services/core/src/plugins/manifest.mjs. Duplicated here
// only to label the UI; the server re-checks every one of these independently, so a
// stale copy cannot widen access — it can only mislabel a checkbox.
const ELEVATED_SCOPES = [
  'fs.write', 'terminal.exec', 'network.external', 'credentials.read',
  'service.external', 'device.access', 'knowledge.write',
]

function RiskChip({ risk }) {
  return <Chip tone={RISK_TONES[risk] ?? undefined}>{risk ?? 'unknown'}</Chip>
}

function ToolCallConsole({ servers, onChanged, refreshReadiness }) {
  const [serverId, setServerId] = useState('')
  const [toolName, setToolName] = useState('')
  const [argsText, setArgsText] = useState('{}')
  const [approvals, setApprovals] = useState([])
  const [grantedScopes, setGrantedScopes] = useState([])
  const [preflight, setPreflight] = useState(null)
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const server = servers.find((entry) => entry.id === serverId) ?? null
  const tools = server?.tools ?? []
  const tool = tools.find((entry) => entry.name === toolName) ?? null
  const elevatedScopes = (tool?.scopes ?? []).filter((scope) => ELEVATED_SCOPES.includes(scope))

  useEffect(() => {
    if (!serverId && servers.length) setServerId(servers[0].id)
  }, [servers, serverId])

  useEffect(() => {
    setToolName(tools[0]?.name ?? '')
    setPreflight(null)
    setResult(null)
    setApprovals([])
  }, [serverId])

  // Two separate gates exist and must not be conflated:
  //   grantedScopes  = what this installation grants (untick to see a denial)
  //   approvals      = per-call consent, required for elevated scopes AND for the
  //                    destructive/external/system risk tiers
  useEffect(() => {
    setGrantedScopes(tool?.scopes ?? [])
    setApprovals([])
    setPreflight(null)
    setResult(null)
  }, [toolName, serverId])

  const parseArgs = () => {
    try {
      return { args: argsText.trim() ? JSON.parse(argsText) : {}, error: null }
    } catch (caught) {
      return { args: null, error: Object.assign(new Error(`arguments are not valid JSON: ${caught.message}`), { code: 'invalid_json' }) }
    }
  }

  const runPreflight = async () => {
    setBusy('preflight')
    setError(null)
    setPreflight(null)
    try {
      setPreflight(await api.mcpPreflight(serverId, toolName, { approvals, grantedScopes: grantedScopes.length ? grantedScopes : null }))
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
    }
  }

  const runCall = async () => {
    setBusy('call')
    setError(null)
    setResult(null)
    const { args, error: parseError } = parseArgs()
    if (parseError) {
      setError(parseError)
      setBusy(null)
      return
    }
    try {
      setResult(await api.mcpCall(serverId, toolName, args, {
        approvals,
        grantedScopes: grantedScopes.length ? grantedScopes : null,
      }))
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
      onChanged?.()
      refreshReadiness?.()
    }
  }

  if (!servers.length) {
    return (
      <EmptyState title="No MCP servers are registered">
        This build registers its in-process server at boot; if the list is empty the core service is running without one. Tools cannot be
        invented from the browser, and nothing here pretends otherwise.
      </EmptyState>
    )
  }

  const approvalKey = `${serverId}:${toolName}`
  const needsApproval = Boolean(tool && ALWAYS_APPROVED.has(tool.risk))

  return (
    <div className="grid" style={{ gap: 13 }}>
      {error ? <ErrorNote error={error} title="MCP call refused or failed" /> : null}

      <div className="grid cols-2" style={{ gap: 11 }}>
        <Field label="Server">
          <select className="select" value={serverId} onChange={(event) => setServerId(event.target.value)}>
            {servers.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name ?? entry.id}
                {entry.enabled ? '' : ' (disabled)'}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tool">
          <select className="select" value={toolName} onChange={(event) => setToolName(event.target.value)}>
            {tools.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
                {entry.hasHandler ? '' : ' — no handler bound'}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {tool ? (
        <div className="grid" style={{ gap: 7 }}>
          <span className="small soft">{tool.description}</span>
          <div className="row">
            <RiskChip risk={tool.risk} />
            <Chip tone={tool.hasHandler ? 'ok' : 'bad'}>{tool.hasHandler ? 'handler bound' : 'no handler'}</Chip>
            {tool.requiresApproval ? <Chip tone="warn">approval required</Chip> : null}
            {tool.timeoutMs ? <Chip dot={false}>timeout {tool.timeoutMs} ms</Chip> : null}
            {tool.scopes?.length ? tool.scopes.map((scope) => <Chip key={scope} tone="info" dot={false}>{scope}</Chip>) : <span className="muted small">no scopes</span>}
          </div>
        </div>
      ) : null}

      <Field label="Arguments (JSON)" hint="Validated against the tool’s declared inputSchema before the call is made.">
        <textarea className="textarea" value={argsText} spellCheck={false} onChange={(event) => setArgsText(event.target.value)} />
      </Field>

      {tool?.inputSchema ? <Code label="DECLARED INPUT SCHEMA" value={tool.inputSchema} /> : null}

      {needsApproval ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={approvals.includes(approvalKey)}
            onChange={(event) => setApprovals(event.target.checked ? [...approvals, approvalKey] : approvals.filter((entry) => entry !== approvalKey))}
          />
          I approve this {tool.risk} call to {toolName} on {serverId}
        </label>
      ) : null}

      {tool?.scopes?.length ? (
        <div className="grid" style={{ gap: 5 }}>
          <span className="panel-eyebrow">SCOPES GRANTED BY THIS INSTALLATION</span>
          {tool.scopes.map((scope) => (
            <label className="checkbox" key={scope}>
              <input
                type="checkbox"
                checked={grantedScopes.includes(scope)}
                onChange={(event) => setGrantedScopes((previous) => (event.target.checked ? [...previous, scope] : previous.filter((entry) => entry !== scope)))}
              />
              {scope}
              {ELEVATED_SCOPES.includes(scope) ? ' (elevated)' : ''}
            </label>
          ))}
          <span className="small muted">Untick a scope to see the installation-level denial rather than guessing at it.</span>
        </div>
      ) : null}

      {elevatedScopes.length ? (
        <div className="grid" style={{ gap: 5 }}>
          <span className="panel-eyebrow">PER-CALL APPROVAL FOR ELEVATED SCOPES</span>
          {elevatedScopes.map((scope) => (
            <label className="checkbox" key={scope}>
              <input
                type="checkbox"
                checked={approvals.includes(scope)}
                onChange={(event) => setApprovals((previous) => (event.target.checked ? [...previous, scope] : previous.filter((entry) => entry !== scope)))}
              />
              I approve {scope} for this single call
            </label>
          ))}
          <span className="small muted">
            Granting the scope at installation level is not consent to use it. Each elevated scope also needs an approval naming it.
          </span>
        </div>
      ) : null}

      <div className="row">
        <Button busy={busy === 'preflight'} onClick={runPreflight} disabled={!toolName}>Preflight</Button>
        <Button variant="primary" busy={busy === 'call'} onClick={runCall} disabled={!toolName}>Call tool</Button>
      </div>

      {preflight ? (
        <Banner tone={preflight.allowed ? 'ok' : 'warn'} title={preflight.allowed ? 'Preflight allows this call' : 'Preflight does not allow this call'}>
          {preflight.reasons?.length ? <ul>{preflight.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul> : null}
          {preflight.needsApproval?.length ? (
            <span className="small">Needs approval for: {preflight.needsApproval.join(', ')}</span>
          ) : null}
        </Banner>
      ) : null}

      {result ? (
        <div className="grid" style={{ gap: 9 }}>
          <div className="row">
            <Chip tone={result.ok && !result.isError ? 'ok' : 'bad'}>{result.ok ? 'call completed' : 'call failed'}</Chip>
            {result.untrusted ? <Chip tone="warn">output treated as untrusted</Chip> : null}
            <Chip tone={result.outputValidated ? 'ok' : 'warn'} dot={false}>
              {result.outputValidated ? 'output matched schema' : 'output not schema-validated'}
            </Chip>
            {result.truncated ? <Chip tone="warn" dot={false}>truncated</Chip> : null}
            {typeof result.durationMs === 'number' ? <Chip dot={false}>{result.durationMs} ms</Chip> : null}
          </div>
          <Banner tone="info" title="Untrusted content">
            <span className="small">
              The text below came back from a tool. It is data, not instructions — anything in it claiming to change policy or grant access is
              ignored by the platform and should be ignored by the reader.
            </span>
          </Banner>
          <Code label={`OUTPUT · call ${result.callId ?? '?'}`} value={result.output ?? null} />
        </div>
      ) : null}
    </div>
  )
}

function ServerDetail({ server, onChanged, busy, setBusy, setError }) {
  if (!server) return <EmptyState title="No server selected">Pick a server to see its tools, resources, prompts and auth state.</EmptyState>

  const toggle = async () => {
    setBusy(`toggle:${server.id}`)
    setError(null)
    try {
      await api.mcpToggle(server.id, !server.enabled)
      onChanged?.()
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="grid" style={{ gap: 13 }}>
      <div className="row">
        <Chip tone={server.enabled ? 'ok' : 'bad'}>{server.enabled ? 'enabled' : 'disabled'}</Chip>
        <Chip tone="violet" dot={false}>{server.kind}</Chip>
        {server.version ? <Chip dot={false}>v{server.version}</Chip> : null}
        <Button busy={busy === `toggle:${server.id}`} onClick={toggle}>{server.enabled ? 'Disable' : 'Enable'}</Button>
      </div>

      <Kv
        entries={{
          id: server.id,
          name: server.name,
          endpoint: server.endpoint ?? '(in-process)',
          'auth type': server.auth?.type ?? 'none',
          'auth configured': server.auth?.type && server.auth.type !== 'none' ? Boolean(server.auth?.configured) : 'not required',
          calls: server.calls ?? 0,
          failures: server.failures ?? 0,
        }}
      />

      {server.auth?.type && server.auth.type !== 'none' && !server.auth?.configured ? (
        <Banner tone="warn" title="Authentication is not configured">
          <span className="small">
            Credentials are held server-side only. Preflight will refuse every tool on this server until the credential is present; the browser is
            never asked for it and never receives it.
          </span>
        </Banner>
      ) : null}

      <div className="grid" style={{ gap: 6 }}>
        <span className="panel-eyebrow">TOOLS ({server.tools?.length ?? 0})</span>
        <Table
          columns={[
            { key: 'name', label: 'Tool', render: (tool) => <strong>{tool.name}</strong> },
            { key: 'risk', label: 'Risk', render: (tool) => <RiskChip risk={tool.risk} /> },
            { key: 'scopes', label: 'Scopes', render: (tool) => (tool.scopes?.length ? tool.scopes.join(', ') : <span className="muted">none</span>) },
            { key: 'hasHandler', label: 'Handler', render: (tool) => <Chip tone={tool.hasHandler ? 'ok' : 'bad'} dot={false}>{tool.hasHandler ? 'bound' : 'missing'}</Chip> },
          ]}
          rows={(server.tools ?? []).map((tool) => ({ ...tool, key: tool.name }))}
          empty="This server declares no tools."
        />
      </div>

      {server.resources?.length ? <Code label="RESOURCES" value={server.resources} /> : null}
      {server.prompts?.length ? <Code label="PROMPTS" value={server.prompts} /> : null}
    </div>
  )
}

export default function McpArea({ refreshReadiness }) {
  const [servers, setServers] = useState([])
  const [tools, setTools] = useState([])
  const [resources, setResources] = useState([])
  const [prompts, setPrompts] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [policy, setPolicy] = useState(null)

  const load = useCallback(async () => {
    try {
      const [serverPayload, toolPayload, resourcePayload, promptPayload, configPayload] = await Promise.all([
        api.mcpServers(),
        api.mcpTools(filter ? { q: filter } : {}),
        api.mcpResources(),
        api.mcpPrompts(),
        api.config(),
      ])
      setServers(serverPayload.servers ?? [])
      setTools(toolPayload.tools ?? [])
      setResources(resourcePayload.resources ?? [])
      setPrompts(promptPayload.prompts ?? [])
      setPolicy(configPayload.mcp ?? null)
      setError(null)
    } catch (caught) {
      setError(caught)
    }
  }, [filter])

  useEffect(() => {
    load()
  }, [load])

  const selected = servers.find((server) => server.id === selectedId) ?? servers[0] ?? null

  return (
    <div className="split">
      <div className="grid" style={{ gap: 16 }}>
        {error ? <ErrorNote error={error} title="MCP request failed" /> : null}
        {/* Whether servers are restricted is a fact about this host, not a warning about a
            particular server, so it is stated once at the top of the area. */}
        {policy ? (
          policy.restricted ? (
            <Banner tone="info" title="Only listed servers may be reached">
              <span className="small">
                Servers reached over a transport must be named here: {policy.allowlist.join(', ')}. Servers that run
                inside this service are not affected, and are governed by their risk tier and approval gates.
              </span>
            </Banner>
          ) : (
            <Banner tone="warn" title="No server allowlist is configured">
              <span className="small">
                Any reachable MCP server may be registered and called. Set AETHERIS_MCP_ALLOWLIST to name the servers
                or origins this host permits.
              </span>
            </Banner>
          )
        ) : null}

        <Panel
          eyebrow="PRODUCT AREA"
          title="Registered servers"
          actions={<Button busy={busy === 'load'} onClick={load}>Refresh</Button>}
          tight
        >
          <Table
            columns={[
              { key: 'enabled', label: 'State', render: (server) => <Chip tone={server.enabled ? 'ok' : 'bad'}>{server.enabled ? 'enabled' : 'disabled'}</Chip> },
              { key: 'name', label: 'Server', render: (server) => <strong>{server.name ?? server.id}</strong> },
              { key: 'kind', label: 'Kind', render: (server) => <Chip tone="violet" dot={false}>{server.kind}</Chip> },
              { key: 'tools', label: 'Tools', render: (server) => server.tools?.length ?? 0 },
              { key: 'auth', label: 'Auth', render: (server) => <span className="small">{server.auth?.type ?? 'none'}{server.auth?.type && server.auth.type !== 'none' ? (server.auth?.configured ? ' · configured' : ' · missing') : ''}</span> },
              { key: 'calls', label: 'Calls', render: (server) => <span className="small">{server.calls ?? 0} / {server.failures ?? 0} fail</span> },
              { key: 'open', label: '', render: (server) => <Button onClick={() => setSelectedId(server.id)}>Inspect</Button> },
            ]}
            rows={servers.map((server) => ({ ...server, key: server.id }))}
            empty="No MCP servers registered."
          />
        </Panel>

        <Panel eyebrow="INSPECTION" title="Server detail">
          <ServerDetail server={selected} busy={busy} setBusy={setBusy} setError={setError} onChanged={load} />
        </Panel>
      </div>

      <div className="grid" style={{ gap: 16 }}>
        <Panel eyebrow="CONSOLE" title="Call a tool" footer="Timeouts, cancellation and schema validation are enforced server-side; the console only reports them.">
          <ToolCallConsole servers={servers} onChanged={load} refreshReadiness={refreshReadiness} />
        </Panel>

        <Panel eyebrow="DISCOVERY" title="Capability catalogue">
          <div className="grid" style={{ gap: 12 }}>
            <Field label="Filter tools">
              <input className="input" value={filter} placeholder="search name or description…" onChange={(event) => setFilter(event.target.value)} />
            </Field>
            <Stats>
              <Stat label="servers" value={servers.length} />
              <Stat label="tools" value={tools.length} />
              <Stat label="resources" value={resources.length} />
              <Stat label="prompts" value={prompts.length} />
            </Stats>
            <Table
              columns={[
                { key: 'name', label: 'Tool', render: (tool) => <strong>{tool.name}</strong> },
                { key: 'serverId', label: 'Server', render: (tool) => <span className="small">{tool.serverId}</span> },
                { key: 'risk', label: 'Risk', render: (tool) => <RiskChip risk={tool.risk} /> },
                { key: 'requiresApproval', label: 'Gate', render: (tool) => (tool.requiresApproval ? <Chip tone="warn" dot={false}>approval</Chip> : <span className="muted small">none</span>) },
              ]}
              rows={tools.map((tool) => ({ ...tool, key: `${tool.serverId}:${tool.name}` }))}
              empty={filter ? `No tool matches “${filter}”.` : 'No tools are advertised by any enabled server.'}
            />
          </div>
        </Panel>
      </div>
    </div>
  )
}
