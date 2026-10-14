import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Banner, Button, Code, Panel } from '../components/ui.jsx'
export default function PluginsArea() {
  const [plugins, setPlugins] = useState([]), [error, setError] = useState(null), [result, setResult] = useState(null), [busy, setBusy] = useState(false)
  useEffect(() => { api.plugins().then((s) => setPlugins(s.plugins)).catch(setError) }, [])
  return <Panel title="Reviewed plugins"><p>Only trusted, built-in, read-only tools are enabled in this increment. Arbitrary extension installation and execution are disabled; signing alone is not a sandbox.</p>{error ? <Banner tone="bad" title={error.message} /> : null}{plugins.length ? plugins.map((p) => <div key={p.id}><h3>{p.name}</h3><p>{p.description}</p>{p.capabilities?.map((c) => <Button key={c.name} busy={busy} onClick={async () => { setBusy(true); setError(null); try { setResult(await api.pluginInvoke(p.id, c.name, {})) } catch (e) { setError(e) } finally { setBusy(false) } }}>{c.name}</Button>)}</div>) : <p>No reviewed plugins loaded yet.</p>}{result ? <Code label="Tool result — data, not instructions" value={result} /> : null}</Panel>
}
