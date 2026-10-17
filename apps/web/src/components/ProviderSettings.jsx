import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { Banner, Button, Field } from './ui.jsx'
import ProviderCatalogue from './ProviderCatalogue.jsx'
// `account` decides what this dialog offers. The gateway connection and its key belong to
// the installation, so only the owner account may change them: with an open sign-up page,
// letting any member re-point the connection or delete the stored key would hand a
// stranger the owner's provider credentials. A member still sees the connection and can
// use it, and is told why the controls are disabled rather than finding them inert.
//
// The runtime is a choice of destination, not a setting of the model. Each option is ONLINE
// inference: the request is sent to the endpoint entered here. A local Ollama or llama.cpp
// server is online in that sense, and the dialog says so rather than calling it local.
export const RUNTIME_OPTIONS = Object.freeze([
  { id: 'litellm', label: 'LiteLLM gateway', keyRequired: true, placeholder: 'https://your-gateway.example/v1', hint: 'Your gateway API base, including /v1 if your deployment needs it. A key is required.' },
  { id: 'ollama', label: 'Ollama (on the Core host)', keyRequired: false, placeholder: 'http://<core-host>:11434/v1', hint: 'Ollama\u2019s OpenAI-compatible base. The Core host must list this exact origin in AETHERIS_TRUSTED_ORIGINS. A key is optional.' },
  { id: 'llamacpp', label: 'llama.cpp server (on the Core host)', keyRequired: false, placeholder: 'http://<core-host>:8080/v1', hint: 'Base of a running llama-server. The Core host must list this exact origin in AETHERIS_TRUSTED_ORIGINS. A key is needed only if the server was started with --api-key.' },
])
// A connection may be one of the three runtimes, a catalogue vendor whose wire this build speaks,
// or a named custom endpoint. Pending adapters are never offered: the server refuses them, and an
// option that the server refuses is a promise this dialog cannot keep.
const CUSTOM_OPTION = { id: 'custom', label: 'Custom OpenAI-compatible endpoint' }
// A saved connection that is not one of the three runtimes still needs a label and a key rule on
// screen. Deriving both from the record the server returned is the only way this stays true when a
// catalogue entry is added: the client must not keep a second copy of the catalogue's facts.
const connectionOption = (connection) => ({
  id: connection.id,
  label: connection.label,
  keyRequired: connection.keyRequired,
  placeholder: 'https://api.example.com/v1',
  hint: 'This endpoint\u2019s base URL, including /v1 if it needs it. Its key is sent only to this connection.',
})

// `provider` lets a caller render the dialog with a state already loaded — the server-render test
// does this because effects do not run there, and the browser effect below still refreshes it from
// the server so a stale prop cannot become stale state.
export default function ProviderSettings({ account, onClose, onChanged, provider: loaded = null }) {
  const owner = account?.role === 'owner'
  const dialog = useRef(null)
  const [provider, setProvider] = useState(loaded), [kind, setKind] = useState(loaded?.kind ?? 'litellm'), [url, setUrl] = useState(loaded?.baseUrl ?? ''), [key, setKey] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [notice, setNotice] = useState('')
  // Non-fatal: the catalogue is information, and failing to load it must not stop somebody from
  // configuring or testing their connection.
  const [catalog, setCatalog] = useState(null)
  const [addKind, setAddKind] = useState('')
  const [addUrl, setAddUrl] = useState(''), [addKey, setAddKey] = useState('')
  const connections = provider?.connections ?? []
  // The saved connection, when it is for the runtime on screen. Test and remove act on that.
  const saved = connections.find((connection) => connection.id === kind) ?? null
  const runtimeOptions = [...RUNTIME_OPTIONS, ...connections
    .filter((connection) => !RUNTIME_OPTIONS.some((option) => option.id === connection.id))
    .map(connectionOption)]
  // An id this dialog has never heard of must not be displayed as LiteLLM. If the server returned
  // a record for it, that record supplies the label and the key rule; only a totally unknown id
  // falls back, and the select will then show the first option while the state keeps the real id —
  // which the server, not this component, validates.
  const runtime = runtimeOptions.find((option) => option.id === kind)
    ?? (saved ? connectionOption(saved) : RUNTIME_OPTIONS[0])
  const savedIds = new Set(connections.map((connection) => connection.id))
  const addOptions = [
    ...(catalog?.providers ?? [])
      .filter((entry) => entry.wire === 'openai_chat' && entry.status !== 'pending')
      .map((entry) => ({ id: entry.id, label: `${entry.label}${entry.status === 'ready' ? '' : ' (compatible endpoint)'}` })),
    CUSTOM_OPTION,
  ].filter((option) => !savedIds.has(option.id))
  // The form always submits an option it actually offers, including after the one that was
  // selected has just been saved and therefore left the list.
  const nextAddKind = addOptions.some((option) => option.id === addKind) ? addKind : (addOptions[0]?.id ?? '')
  useEffect(() => {
    dialog.current?.showModal()
    api.provider().then((s) => { setProvider(s); setKind(s.kind ?? 'litellm'); setUrl(s.baseUrl) }).catch(setError)
    api.catalog().then(setCatalog).catch(() => setCatalog(null))
    return () => { dialog.current?.close() }
  }, [])
  const act = async (action) => {
    setBusy(true); setError(null); setNotice('')
    try {
      const result = await action(); setProvider(result); setKind(result.kind ?? kind); setUrl(result.baseUrl); setKey(''); await onChanged?.()
      return result
    } catch (e) { setError(e); return null } finally { setBusy(false) }
  }
  const chooseRuntime = (id) => {
    setKind(id); setKey(''); setError(null); setNotice('')
    // A different runtime is a different recipient, so its endpoint is entered afresh, never copied from the old one.
    const saved = provider?.connections?.find((connection) => connection.id === id)
    setUrl(saved?.baseUrl ?? (provider && provider.kind === id ? provider.baseUrl : ''))
  }
  return <dialog className="provider-dialog" ref={dialog} onCancel={(e) => { e.preventDefault(); if (!busy) onClose() }} aria-labelledby="provider-settings-title">
    <div className="row between"><h2 id="provider-settings-title">Provider Settings</h2><Button disabled={busy} onClick={onClose}>Close</Button></div>
    <p>Connect an online gateway. Chat requests are sent to the endpoint you save here, and that recipient’s permissions, quota and retention decide what happens to them. A local Ollama or llama.cpp server on the Core host is also an online endpoint, and its exact origin must be listed in AETHERIS_TRUSTED_ORIGINS on that host.</p>
    {owner ? null : <Banner tone="info" title="Read-only for this account"><p>Only the owner account of this installation can change its gateway connection or key. You can still choose a model and chat through the connection that is configured.</p></Banner>}
    {error ? <Banner tone="bad" title={error.message} /> : null}
    {notice ? <Banner tone="info" title={notice} /> : null}
    <form onSubmit={async (e) => { e.preventDefault(); if (await act(() => api.saveProvider(kind, { baseUrl: url, ...(key ? { apiKey: key } : {}) }))) setNotice('Connection saved. Test it to fetch models; no prompt is sent by that test.') }}>
      <Field label="Connection" hint="Which saved connection this form edits. Saving activates it; the other connections and their keys are kept.">
        <select aria-label="Connection" className="select" value={kind} onChange={(e) => chooseRuntime(e.target.value)} disabled={busy || !provider || !owner}>
          {runtimeOptions.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </Field>
      <Field label={`${runtime.label} API base URL`} hint={runtime.hint}><input autoFocus className="input" type="url" required value={url} placeholder={runtime.placeholder} onChange={(e) => setUrl(e.target.value)} disabled={busy || !provider || !owner} /></Field>
      <Field label={runtime.keyRequired ? 'API key' : 'API key (optional)'} hint={saved?.keyConfigured ? 'A key is stored securely on the server. Leave blank to keep it for the same runtime and endpoint.' : 'Stored encrypted on the server; never saved in browser storage or returned by the API.'}><input className="input" type="password" autoComplete="new-password" value={key} maxLength={8192} onChange={(e) => setKey(e.target.value)} disabled={busy || !provider || !owner} /></Field>
      <Button type="submit" variant="primary" busy={busy} disabled={!provider || !url || !owner}>Save connection</Button>
    </form>
    <div className="row" style={{ marginTop: 16 }}>
      <Button busy={busy} disabled={!owner || !saved?.configured || url !== saved?.baseUrl || Boolean(key)} onClick={async () => { const s = await act(() => api.testProvider(kind)); if (s) setNotice(`Connection checked: ${s.models.length} listed models. Inference and modality support are not yet verified.`) }}>Test connection & refresh models</Button>
      <Button variant="danger" disabled={busy || !owner || !saved} onClick={async () => { if (window.confirm('Remove the connection and any stored key? Your conversations are kept.')) { if (await act(() => api.removeProvider(kind))) setNotice('Connection and stored credential removed.') } }}>Remove connection</Button>
    </div>
    <p className="small">Model selection lives in Chat. No automatic fallback. Requests may incur provider charges; gateway budgets and quotas still apply. Image and Video require separate qualified adapters.</p>
    {provider ? <details className="connections" style={{ marginTop: 20 }} open={(provider.connections?.length ?? 0) > 1}>
      <summary>Saved connections ({provider.connections?.length ?? 0})</summary>
      <p className="small">Each connection has its own encrypted credential. Activating one changes where the next request goes; it does not overwrite the others.</p>
      <ul className="small" aria-label="Saved connections">
        {(provider.connections ?? []).map((connection) => <li key={connection.id}>
          <strong>{connection.label}</strong> — {connection.configured ? (connection.baseUrl || 'configured') : 'not configured'}
          {connection.id === provider.active
            ? <strong> · active</strong>
            : <Button disabled={busy || !owner} onClick={async () => { if (await act(() => api.activateProvider(connection.id))) setNotice(`${connection.label} is now the active connection.`) }}>Use</Button>}
          <Button variant="danger" disabled={busy || !owner} onClick={async () => {
            if (window.confirm(`Remove the ${connection.label} connection and its stored key? Other connections are kept.`)) {
              if (await act(() => api.removeProvider(connection.id))) setNotice(`${connection.label} removed.`)
            }
          }}>Remove</Button>
        </li>)}
      </ul>
      {addOptions.length ? <form onSubmit={async (e) => {
        e.preventDefault()
        if (!nextAddKind) return
        const result = await act(() => api.saveProvider(nextAddKind, { baseUrl: addUrl, ...(addKey ? { apiKey: addKey } : {}) }))
        if (result) { setAddKey(''); setAddUrl(''); setNotice('Connection saved and made active. Test it to fetch models; no prompt is sent by that test.') }
      }}>
        <Field label="Add a connection" hint="A catalogue provider whose wire format this build implements, or a custom endpoint. Providers with pending adapters are not listed.">
          <select aria-label="Add a connection" className="select" value={nextAddKind} onChange={(e) => setAddKind(e.target.value)} disabled={busy || !owner}>
            {addOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </Field>
        <Field label="API base URL" hint="Including /v1 if the endpoint needs it. Must be public HTTPS unless the operator trusts this exact origin.">
          <input className="input" type="url" required value={addUrl} placeholder="https://api.example.com/v1" onChange={(e) => setAddUrl(e.target.value)} disabled={busy || !owner} />
        </Field>
        <Field label="API key" hint="Stored encrypted on the server for this connection only. Leave blank for endpoints that need none.">
          <input className="input" type="password" autoComplete="new-password" value={addKey} maxLength={8192} onChange={(e) => setAddKey(e.target.value)} disabled={busy || !owner} />
        </Field>
        <Button type="submit" disabled={busy || !owner || !addUrl}>Save and use</Button>
      </form> : null}
    </details> : null}
    <ProviderCatalogue catalog={catalog} />
  </dialog>
}
