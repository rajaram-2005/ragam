import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Banner, Button, Code, Panel } from '../components/ui.jsx'
export default function McpArea() {
  const [tools, setTools] = useState([]), [error, setError] = useState(null), [result, setResult] = useState(null), [busy, setBusy] = useState(false)
  useEffect(() => { api.mcpTools().then((s) => setTools(s.tools)).catch(setError) }, [])
  return <Panel title="MCP tools"><p>Reviewed read-only tools, enforced server-side. Remote MCP connections are not configured in this increment. Tool results cannot grant permissions or trigger automatic execution.</p>{error ? <Banner tone="bad" title={error.message} /> : null}{tools.length ? tools.map((tool) => <div key={`${tool.server}:${tool.name}`}><h3>{tool.name}</h3><p>{tool.description}</p><Button busy={busy} onClick={async () => { setBusy(true); setError(null); try { setResult(await api.mcpCall(tool.server ?? tool.serverId, tool.name, {})) } catch (e) { setError(e) } finally { setBusy(false) } }}>Run read-only tool</Button></div>) : <p>No tools loaded yet.</p>}{result ? <Code label="Untrusted tool result" value={result} /> : null}</Panel>
}
