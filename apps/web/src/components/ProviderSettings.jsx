import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { Banner, Button, Field } from './ui.jsx'
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
const runtimeOf = (id) => RUNTIME_OPTIONS.find((r) => r.id === id) ?? RUNTIME_OPTIONS[0]

export default function ProviderSettings({ account, onClose, onChanged }) {
  const owner = account?.role === 'owner'
  const dialog = useRef(null)
  const [provider, setProvider] = useState(null), [kind, setKind] = useState('litellm'), [url, setUrl] = useState(''), [key, setKey] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [notice, setNotice] = useState('')
  const runtime = runtimeOf(kind)
  // The saved connection, when it is for the runtime on screen. Test and remove act on that.
  const saved = provider && provider.kind === kind ? provider : null
  useEffect(() => {
    dialog.current?.showModal()
    api.provider().then((s) => { setProvider(s); setKind(s.kind ?? 'litellm'); setUrl(s.baseUrl) }).catch(setError)
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
    setUrl(provider && provider.kind === id ? provider.baseUrl : '')
  }
  return <dialog className="provider-dialog" ref={dialog} onCancel={(e) => { e.preventDefault(); if (!busy) onClose() }} aria-labelledby="provider-settings-title">
    <div className="row between"><h2 id="provider-settings-title">Provider Settings</h2><Button disabled={busy} onClick={onClose}>Close</Button></div>
    <p>Connect an online gateway. Chat requests are sent to the endpoint you save here, and that recipient’s permissions, quota and retention decide what happens to them. A local Ollama or llama.cpp server on the Core host is also an online endpoint, and its exact origin must be listed in AETHERIS_TRUSTED_ORIGINS on that host.</p>
    {owner ? null : <Banner tone="info" title="Read-only for this account"><p>Only the owner account of this installation can change its gateway connection or key. You can still choose a model and chat through the connection that is configured.</p></Banner>}
    {error ? <Banner tone="bad" title={error.message} /> : null}
    {notice ? <Banner tone="info" title={notice} /> : null}
    <form onSubmit={async (e) => { e.preventDefault(); if (await act(() => api.saveProvider(kind, { baseUrl: url, ...(key ? { apiKey: key } : {}) }))) setNotice('Connection saved. Test it to fetch models; no prompt is sent by that test.') }}>
      <Field label="Runtime" hint="Choosing a runtime clears the saved connection on save. Its key is never sent to a different runtime or endpoint.">
        <select aria-label="Runtime" className="select" value={kind} onChange={(e) => chooseRuntime(e.target.value)} disabled={busy || !provider || !owner}>
          {RUNTIME_OPTIONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </Field>
      <Field label={`${runtime.label} API base URL`} hint={runtime.hint}><input autoFocus className="input" type="url" required value={url} placeholder={runtime.placeholder} onChange={(e) => setUrl(e.target.value)} disabled={busy || !provider || !owner} /></Field>
      <Field label={runtime.keyRequired ? 'Gateway API key' : 'API key (optional)'} hint={saved?.keyConfigured ? 'A key is stored securely on the server. Leave blank to keep it for the same runtime and endpoint.' : 'Stored encrypted on the server; never saved in browser storage or returned by the API.'}><input className="input" type="password" autoComplete="new-password" value={key} maxLength={8192} onChange={(e) => setKey(e.target.value)} disabled={busy || !provider || !owner} /></Field>
      <Button type="submit" variant="primary" busy={busy} disabled={!provider || !url || !owner}>Save connection</Button>
    </form>
    <div className="row" style={{ marginTop: 16 }}>
      <Button busy={busy} disabled={!owner || !saved?.configured || url !== saved?.baseUrl || Boolean(key)} onClick={async () => { const s = await act(() => api.testProvider(kind)); if (s) setNotice(`Connection checked: ${s.models.length} listed models. Inference and modality support are not yet verified.`) }}>Test connection & refresh models</Button>
      <Button variant="danger" disabled={busy || !owner || !saved} onClick={async () => { if (window.confirm('Remove the connection and any stored key? Your conversations are kept.')) { if (await act(() => api.removeProvider(kind))) setNotice('Connection and stored credential removed.') } }}>Remove connection</Button>
    </div>
    <p className="small">Model selection lives in Chat. No automatic fallback. Requests may incur provider charges; gateway budgets and quotas still apply. Image and Video require separate qualified adapters.</p>
  </dialog>
}
