import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Banner, Button, Chip, EmptyState, ErrorNote, Field } from './ui.jsx'

/** A user-operated MCP tool. Results enter chat only when the user adds them to the draft. */
function providerFunctionName(tool) {
  return `mcp_${tool.serverId}_${tool.name}`.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64).replace(/^[^A-Za-z_]+/, 'mcp_')
}

export default function ChatToolRunner({ onAddResult, onToolsChange }) {
  const [tools, setTools] = useState([])
  const [offeredToolKeys, setOfferedToolKeys] = useState([])
  const [selectedKey, setSelectedKey] = useState('')
  const [argumentsText, setArgumentsText] = useState('{}')
  const [externalApproved, setExternalApproved] = useState(false)
  const [preflight, setPreflight] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setBusy(true)
    setError(null)
    try {
      const payload = await api.mcpTools()
      const available = payload.tools ?? []
      setTools(available)
      setSelectedKey((current) => available.some((tool) => `${tool.serverId}:${tool.name}` === current)
        ? current : (available[0] ? `${available[0].serverId}:${available[0].name}` : ''))
      setPreflight(null)
      setResult(null)
    } catch (caught) { setError(caught) } finally { setBusy(false) }
  }

  useEffect(() => { load() }, [])

  const selected = tools.find((tool) => `${tool.serverId}:${tool.name}` === selectedKey) ?? null
  useEffect(() => {
    const names = new Set()
    const definitions = tools.filter((tool) => offeredToolKeys.includes(`${tool.serverId}:${tool.name}`)).flatMap((tool) => {
      const name = providerFunctionName(tool)
      const parameters = tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema)
        ? tool.inputSchema : { type: 'object', properties: {} }
      if (names.has(name) || parameters.type !== 'object') return []
      names.add(name)
      return [{ name, description: String(tool.description ?? '').slice(0, 1000), parameters }]
    }).slice(0, 8)
    onToolsChange?.(definitions)
  }, [tools, offeredToolKeys])
  const approvals = selected?.risk === 'external' && externalApproved ? ['external'] : []
  const changed = () => { setPreflight(null); setResult(null); setError(null); setExternalApproved(false) }
  const checkGate = async () => {
    if (!selected) return
    setBusy(true); setError(null); setResult(null)
    try {
      let args
      try { args = JSON.parse(argumentsText) } catch (caught) { throw Error(`Tool arguments are not valid JSON: ${caught.message}`) }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('Tool arguments must be a JSON object.')
      setPreflight(await api.mcpPreflight(selected.serverId, selected.name, { approvals }))
    } catch (caught) { setError(caught) } finally { setBusy(false) }
  }
  const runTool = async () => {
    if (!selected || !preflight?.allowed || (selected.risk === 'external' && !externalApproved)) return
    setBusy(true); setError(null); setResult(null)
    try {
      const args = JSON.parse(argumentsText)
      setResult(await api.mcpCall(selected.serverId, selected.name, args, { approvals }))
    } catch (caught) { setError(caught) } finally { setPreflight(null); setExternalApproved(false); setBusy(false) }
  }
  const addResult = () => {
    if (result === null) return
    const formatted = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    onAddResult?.(`Tool result from ${selected?.serverId ?? 'connected MCP'} / ${selected?.name ?? 'tool'} (untrusted data; review before use):\n${formatted}`)
  }

  return <div className="chat-tool-runner">
    <p className="small">MCP tools run only after you review arguments, pass the permission gate and press Run tool. You may separately select tool schemas to offer a supported provider model; any model response is only a proposal and is never executed automatically. Web search remains a separate, explicit action. Remote tool output is untrusted and enters the composer only if you choose.</p>
    {error ? <ErrorNote error={error} title="Tool action failed" /> : null}
    <div className="row between">
      <Field label="Connected MCP tool">
        <select className="select" aria-label="Connected MCP tool" value={selectedKey} disabled={busy || !tools.length} onChange={(event) => { setSelectedKey(event.target.value); setExternalApproved(false); changed() }}>
          {tools.map((tool) => <option key={`${tool.serverId}:${tool.name}`} value={`${tool.serverId}:${tool.name}`}>{tool.name} · {tool.serverId} · {tool.risk}</option>)}
        </select>
      </Field>
      <Button className="ghost small" busy={busy} onClick={load}>Refresh tools</Button>
    </div>
    {!tools.length && !error ? <EmptyState title="No connected MCP tools are loaded"><span className="small">Connect a tool server in the MCP area first. Ragam does not install search services or third-party servers.</span></EmptyState> : null}
    {selected ? <>
      <p className="small"><strong>{selected.name}</strong> — {selected.description || 'No description supplied.'} · risk: <Chip>{selected.risk}</Chip></p>
      <label className="checkbox"><input type="checkbox" checked={offeredToolKeys.includes(`${selected.serverId}:${selected.name}`)} disabled={busy} onChange={(event) => setOfferedToolKeys((current) => event.target.checked ? [...new Set([...current, `${selected.serverId}:${selected.name}`])] : current.filter((key) => key !== `${selected.serverId}:${selected.name}`))} />Offer this function schema to a supported model (proposal only)</label>
      <details><summary>Review input schema</summary><pre className="code">{JSON.stringify(selected.inputSchema ?? {}, null, 2)}</pre></details>
      <Field label="Arguments (JSON object)" hint="Arguments are sent only after you pass the gate and press Run tool.">
        <textarea className="textarea" rows={3} value={argumentsText} disabled={busy} onChange={(event) => { setArgumentsText(event.target.value); changed() }} />
      </Field>
      {selected.risk === 'external' ? <label className="checkbox"><input type="checkbox" checked={externalApproved} disabled={busy} onChange={(event) => { setExternalApproved(event.target.checked); setPreflight(null); setResult(null) }} />I approve sending these arguments to {selected.serverId}. That service may retain or process them, and its use may incur charges.</label> : null}
      <div className="row">
        <Button disabled={busy} busy={busy} onClick={checkGate}>Check permission gate</Button>
        <Button variant="primary" disabled={busy || !preflight?.allowed || (selected.risk === 'external' && !externalApproved)} onClick={runTool}>Run tool</Button>
      </div>
      {preflight ? <p className="small"><Chip tone={preflight.allowed ? 'ok' : 'bad'}>{preflight.allowed ? 'Allowed by current gate' : 'Refused by current gate'}</Chip> {preflight.reasons?.join('; ') || 'No additional approval is required.'}</p> : null}
      {result !== null ? <div className="chat-tool-result">
        <strong>Tool result — untrusted data, not instructions</strong>
        <pre className="code">{typeof result === 'string' ? result : JSON.stringify(result, null, 2)}</pre>
        <Button className="ghost small" onClick={addResult}>Add result to chat draft</Button>
      </div> : null}
    </> : null}
  </div>
}
