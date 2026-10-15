import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { Banner, Button, Field } from './ui.jsx'
// `account` decides what this dialog offers. The gateway connection and its key belong to
// the installation, so only the owner account may change them: with an open sign-up page,
// letting any member re-point the connection or delete the stored key would hand a
// stranger the owner's provider credentials. A member still sees the connection and can
// use it, and is told why the controls are disabled rather than finding them inert.
export default function ProviderSettings({ account, onClose, onChanged }) {
  const owner = account?.role === 'owner'
  const dialog = useRef(null)
  const [provider, setProvider] = useState(null), [url, setUrl] = useState(''), [key, setKey] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [notice, setNotice] = useState('')
  useEffect(() => {
    dialog.current?.showModal()
    api.provider().then((s) => { setProvider(s); setUrl(s.baseUrl) }).catch(setError)
    return () => { dialog.current?.close() }
  }, [])
  const act = async (action) => {
    setBusy(true); setError(null); setNotice('')
    try {
      const result = await action(); setProvider(result); setUrl(result.baseUrl); setKey(''); await onChanged?.()
      return result
    } catch (e) { setError(e); return null } finally { setBusy(false) }
  }
  return <dialog className="provider-dialog" ref={dialog} onCancel={(e) => { e.preventDefault(); if (!busy) onClose() }} aria-labelledby="provider-settings-title">
    <div className="row between"><h2 id="provider-settings-title">Provider Settings</h2><Button disabled={busy} onClick={onClose}>Close</Button></div>
    <p>Connect a LiteLLM gateway. Its configured provider credentials and model permissions determine which upstream services you can use.</p>
    {owner ? null : <Banner tone="info" title="Read-only for this account"><p>Only the owner account of this installation can change its gateway connection or key. You can still choose a model and chat through the connection that is configured.</p></Banner>}
    {error ? <Banner tone="bad" title={error.message} /> : null}
    {notice ? <Banner tone="info" title={notice} /> : null}
    <form onSubmit={async (e) => { e.preventDefault(); if (await act(() => api.saveProvider({ baseUrl: url, ...(key ? { apiKey: key } : {}) }))) setNotice('Connection saved. Test it to fetch models; no prompt is sent by that test.') }}>
      <Field label="LiteLLM API base URL" hint="Use the gateway API base, including /v1 if required by your deployment."><input autoFocus className="input" type="url" required value={url} placeholder="https://your-gateway.example/v1" onChange={(e) => setUrl(e.target.value)} disabled={busy || !provider || !owner} /></Field>
      <Field label="Gateway API key" hint={provider?.keyConfigured ? 'A key is stored securely on the server. Leave blank to keep it for the same endpoint.' : 'Stored encrypted on the server; never saved in browser storage or returned by the API.'}><input className="input" type="password" autoComplete="new-password" value={key} maxLength={8192} onChange={(e) => setKey(e.target.value)} disabled={busy || !provider || !owner} /></Field>
      <Button type="submit" variant="primary" busy={busy} disabled={!provider || !url || !owner}>Save connection</Button>
    </form>
    <div className="row" style={{ marginTop: 16 }}>
      <Button busy={busy} disabled={!owner || !provider?.keyConfigured || url !== provider?.baseUrl || Boolean(key)} onClick={async () => { const s = await act(api.testProvider); if (s) setNotice(`Connection checked: ${s.models.length} listed models. Inference and modality support are not yet verified.`) }}>Test connection & refresh models</Button>
      <Button variant="danger" disabled={busy || !owner || !provider?.keyConfigured} onClick={async () => { if (window.confirm('Remove the gateway connection and stored key? Your conversations are kept.')) { if (await act(api.removeProvider)) setNotice('Connection and stored credential removed.') } }}>Remove connection</Button>
    </div>
    <p className="small">Model selection lives in Chat. No automatic fallback. Requests may incur provider charges; gateway budgets and quotas still apply. Image and Video require separate qualified adapters.</p>
  </dialog>
}
