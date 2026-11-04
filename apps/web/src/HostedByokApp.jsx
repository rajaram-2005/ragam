import React, { useCallback, useEffect, useMemo, useState } from 'react'
import IndustryOperationsPanel from './components/IndustryOperationsPanel.jsx'
import { readIndustryMode, writeIndustryMode } from './industry-operations.js'

async function hostedRequest(path, { method = 'GET', body, signal } = {}) {
  let response
  try {
    response = await fetch(`/api/hosted${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-aetheris-request': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new Error('Cannot reach the hosted Ragam service. Try again in a moment.')
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload.message ?? `Request failed (${response.status}).`)
    error.code = payload.error
    error.status = response.status
    throw error
  }
  return payload
}

function ErrorNote({ error }) {
  return error ? <div className="hosted-error" role="alert">{error.message ?? String(error)}</div> : null
}

function AuthPanel({ onAuthenticated, initialNotice = '' }) {
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(initialNotice)

  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError(null); setNotice('')
    try {
      if (mode === 'recover') {
        const result = await hostedRequest('/auth/password-reset/request', { method: 'POST', body: { email: email.trim() } })
        setNotice(result.message ?? 'If an account uses that address, a password recovery link will be sent.')
        return
      }
      const result = await hostedRequest(`/auth/${mode === 'signup' ? 'signup' : 'login'}`, {
        method: 'POST', body: { email: email.trim(), password },
      })
      setPassword('')
      if (result.authenticated && result.account) onAuthenticated(result.account)
      else if (result.confirmationRequired) setNotice('Check your email to confirm your account, then return here and sign in. If no confirmation email arrives, site email delivery has not been configured yet.')
      else setNotice('The account request completed. Sign in to continue.')
    } catch (failure) { setError(failure) } finally { setBusy(false) }
  }

  return <main className="hosted-auth-page">
    <section className="hosted-auth-card" aria-labelledby="hosted-auth-title">
      <div className="hosted-brand-mark" aria-hidden="true">R</div>
      <p className="hosted-eyebrow">RAGAM · HOSTED BYOK</p>
      <h1 id="hosted-auth-title">{mode === 'signup' ? 'Create your account' : mode === 'recover' ? 'Reset your password' : 'Welcome back'}</h1>
      <p className="hosted-muted">Use your own provider key. Ragam encrypts it for your account; AI usage is billed by your chosen provider.</p>
      <ErrorNote error={error} />
      {notice ? <div className="hosted-notice" role="status">{notice}</div> : null}
      <form className="hosted-auth-form" onSubmit={submit}>
        <label>Email address<input type="email" autoComplete="username" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} /></label>
        {mode !== 'recover' ? <label>Password<input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={mode === 'signup' ? 12 : 1} maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} /></label> : null}
        {mode === 'signup' ? <p className="hosted-hint">Use at least 12 characters. Your password is managed by Supabase Auth and is never used as an AI provider key.</p> : null}
        <button className="hosted-primary-button" type="submit" disabled={busy || !email || (mode !== 'recover' && !password)}>{busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : mode === 'recover' ? 'Send recovery link' : 'Sign in'}</button>
      </form>
      {mode === 'signin' ? <button className="hosted-link-button" onClick={() => { setMode('recover'); setError(null); setNotice('') }}>Forgot your password?</button> : null}
      <button className="hosted-link-button" onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setError(null); setNotice('') }}>
        {mode === 'signup' ? 'Already have an account? Sign in' : 'Back to sign in'}
      </button>
      <p className="hosted-hint">AI requests are sent only to your selected provider after you approve each turn. No provider fallback is performed.</p>
    </section>
  </main>
}

function ProviderSettings({ providerList, current, onClose, onChanged }) {
  const [providerId, setProviderId] = useState(current?.provider ?? '')
  const selectedProvider = providerList.find((entry) => entry.id === providerId) ?? null
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState('')
  const [models, setModels] = useState(current?.models ?? [])
  const [model, setModel] = useState(current?.model ?? '')

  const loadModels = async () => {
    setBusy(true); setError(null); setNotice('')
    try {
      const result = await hostedRequest('/provider/models', { method: 'POST', body: {} })
      setModels(result.models ?? []); setModel(result.model ?? '')
      setNotice(`Loaded ${result.models?.length ?? 0} models from ${selectedProvider?.label ?? 'your provider'}.`)
      onChanged({ ...current, configured: true, models: result.models ?? [], model: result.model ?? '' })
    } catch (failure) { setError(failure) } finally { setBusy(false) }
  }

  const saveProvider = async (event) => {
    event.preventDefault(); setBusy(true); setError(null); setNotice('')
    try {
      const saved = await hostedRequest('/provider', { method: 'PUT', body: { provider: providerId, apiKey, ...(selectedProvider?.defaultBaseUrl ? {} : { baseUrl }) } })
      setApiKey(''); setModels([]); setModel(''); onChanged(saved)
      setNotice('Encrypted provider settings saved. Load its model list before chatting.')
    } catch (failure) { setError(failure) } finally { setBusy(false) }
  }

  const saveModel = async (event) => {
    const next = event.target.value
    setModel(next)
    if (!next) return
    try {
      await hostedRequest('/provider/model', { method: 'PUT', body: { model: next } })
      onChanged({ ...current, configured: true, model: next, models })
    } catch (failure) { setError(failure) }
  }

  const removeProvider = async () => {
    setBusy(true); setError(null)
    try { await hostedRequest('/provider', { method: 'DELETE', body: {} }); setModels([]); setModel(''); setApiKey(''); onChanged({ configured: false }); setNotice('Your saved provider connection was removed.') }
    catch (failure) { setError(failure) } finally { setBusy(false) }
  }

  return <div className="hosted-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="hosted-settings-card" role="dialog" aria-modal="true" aria-labelledby="hosted-settings-title">
      <div className="hosted-panel-heading"><div><p className="hosted-eyebrow">YOUR ACCOUNT</p><h2 id="hosted-settings-title">Provider settings</h2></div><button className="hosted-icon-button" onClick={onClose} aria-label="Close settings">×</button></div>
      <p className="hosted-muted">Your key is encrypted before it is stored. It is never returned to the browser, and requests use only the connection saved to your account.</p>
      <ErrorNote error={error} />{notice ? <div className="hosted-notice" role="status">{notice}</div> : null}
      <form className="hosted-provider-form" onSubmit={saveProvider}>
        <label>Provider<select value={providerId} onChange={(event) => { setProviderId(event.target.value); setBaseUrl(''); setApiKey(''); setModels([]); setModel('') }} required>
          <option value="">Choose a provider</option>{providerList.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select></label>
        {selectedProvider && !selectedProvider.defaultBaseUrl ? <label>Provider HTTPS endpoint<input type="url" required placeholder="https://your-resource.openai.azure.com" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label> : null}
        <label>Provider API key<input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={current?.configured && providerId === current.provider ? 'Paste a new key to replace the saved key' : 'Paste your own provider key'} required /></label>
        <div className="hosted-inline-actions"><button className="hosted-primary-button" type="submit" disabled={busy || !providerId || !apiKey}>{busy ? 'Saving…' : 'Save encrypted key'}</button>
          {current?.configured && providerId === current.provider ? <button type="button" className="hosted-quiet-button" disabled={busy} onClick={loadModels}>Load models</button> : null}
        </div>
      </form>
      {current?.configured && providerId === current.provider ? <div className="hosted-provider-model">
        <label>Selected model<select value={model} onChange={saveModel} disabled={!models.length || busy}>
          <option value="">{models.length ? 'Choose a listed model' : 'Load models first'}</option>{models.map((id) => <option key={id} value={id}>{id}</option>)}
        </select></label>
        <p className="hosted-hint">A model is used only after it appears in your provider’s model list. Ragam does not substitute another model.</p>
        <button type="button" className="hosted-danger-link" disabled={busy} onClick={removeProvider}>Remove saved provider key</button>
      </div> : null}
      <div className="hosted-settings-footer"><button className="hosted-quiet-button" onClick={onClose}>Done</button></div>
    </section>
  </div>
}

function HostedWorkspace({ account, onSignOut }) {
  const [providerList, setProviderList] = useState([])
  const [provider, setProvider] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [industryMode, setIndustryMode] = useState(readIndustryMode)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [consent, setConsent] = useState(false)
  const [search, setSearch] = useState(false)
  const [sensitiveConsent, setSensitiveConsent] = useState(false)

  const selected = useMemo(() => providerList.find((entry) => entry.id === provider?.provider) ?? null, [providerList, provider?.provider])
  const refresh = useCallback(async () => {
    try {
      const [catalogue, saved] = await Promise.all([hostedRequest('/providers'), hostedRequest('/provider')])
      setProviderList(catalogue.providers ?? []); setProvider(saved); setError(null)
    } catch (failure) { setError(failure) }
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const send = async (event) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || busy || !consent) return
    const prior = messages
    const next = [...prior, { role: 'user', content: text }]
    setMessages(next); setDraft(''); setBusy(true); setError(null)
    try {
      const result = await hostedRequest('/chat', {
        method: 'POST',
        body: {
          messages: next,
          model: provider?.model,
          ...(industryMode ? { industryMode: 'manufacturing' } : {}),
          nativeSearch: search,
          authorization: { confirmed: consent, nativeSearchConfirmed: search, allowSensitive: sensitiveConsent },
        },
      })
      setMessages([...next, { role: 'assistant', content: result.text, model: result.model, provider: result.provider, grounding: result.grounding, industryMode: result.industryMode }])
    } catch (failure) {
      setMessages(prior)
      setDraft(text)
      setError(failure)
    } finally { setBusy(false); setConsent(false); setSearch(false); setSensitiveConsent(false) }
  }

  return <main className="hosted-workspace">
    <header className="hosted-topbar"><a className="hosted-wordmark" href="#/chat"><span className="hosted-brand-mark">R</span><span>ragam</span></a>
      <div className="hosted-account"><span title={account.email}>{account.email}</span><button className="hosted-quiet-button" onClick={() => setSettingsOpen(true)}>Provider settings</button><button className="hosted-link-button" onClick={onSignOut}>Sign out</button></div>
    </header>
    <section className="hosted-chat-shell" aria-label="Hosted chat">
      <div className="hosted-chat-heading"><div><p className="hosted-eyebrow">YOUR PROVIDER, YOUR BILL</p><h1>Chat</h1><p className="hosted-muted">{provider?.configured ? `${selected?.label ?? provider.provider}${provider.model ? ` · ${provider.model}` : ' · choose a model in settings'}` : 'Add your provider key to start chatting.'}</p></div>
        <button className="hosted-quiet-button" onClick={() => setMessages([])} disabled={!messages.length}>New chat</button></div>
      <IndustryOperationsPanel
        enabled={industryMode}
        mediaAvailable={false}
        onEnabledChange={(enabled) => setIndustryMode(writeIndustryMode(enabled))}
        onStartTask={(taskPrompt) => { setIndustryMode(writeIndustryMode(true)); setDraft((current) => current.trim() ? `${current.trim()}\n\n${taskPrompt}` : taskPrompt) }}
      />
      <ErrorNote error={error} />
      {!provider?.configured || !provider?.model ? <div className="hosted-empty-state"><div className="hosted-empty-icon">✦</div><h2>Bring your own AI key</h2><p>Save an API key from a supported provider. Ragam encrypts it for your account and sends requests only to the provider you choose.</p><button className="hosted-primary-button" onClick={() => setSettingsOpen(true)}>Configure provider</button></div> : null}
      {messages.length ? <div className="hosted-messages" aria-live="polite">{messages.map((message, index) => <article key={`${index}-${message.role}`} className={`hosted-message hosted-message-${message.role}`}>
        <div className="hosted-message-label">{message.role === 'user' ? 'You' : message.provider ?? selected?.label ?? 'Assistant'}</div>
        <div className="hosted-message-content">{message.content}</div>
        {message.industryMode === 'manufacturing' ? <small className="hosted-hint">Manufacturing Operations guidance was applied. Verify every answer against approved procedures.</small> : null}
        {message.grounding?.sources?.length ? <div className="hosted-sources"><strong>Sources from provider Search</strong>{message.grounding.sources.map((source, sourceIndex) => <a key={`${source.url}-${sourceIndex}`} href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a>)}</div> : null}
      </article>)}</div> : null}
      <form className="hosted-composer" onSubmit={send}>
        <label className="hosted-sr-only" htmlFor="hosted-prompt">Message</label>
        <textarea id="hosted-prompt" rows="3" maxLength={12000} placeholder={provider?.model ? 'Ask your selected model…' : 'Configure a provider and listed model first'} value={draft} onChange={(event) => setDraft(event.target.value)} disabled={!provider?.configured || !provider?.model || busy} />
        <div className="hosted-composer-options">
          <label className="hosted-check"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={!provider?.model || busy} />I approve sending this message to {selected?.label ?? 'my provider'} for this turn.</label>
          {selected?.nativeSearch ? <label className="hosted-check"><input type="checkbox" checked={search} onChange={(event) => setSearch(event.target.checked)} disabled={!provider?.model || busy} />Use provider-native Search for this turn (provider Search terms and results may be processed).</label> : null}
          <label className="hosted-check"><input type="checkbox" checked={sensitiveConsent} onChange={(event) => setSensitiveConsent(event.target.checked)} disabled={!provider?.model || busy} />I authorize sending any sensitive text in this message to my provider.</label>
        </div>
        <div className="hosted-composer-bottom"><span className="hosted-hint">Requests go only to the selected provider. No fallback. Provider charges apply to your account.</span><button className="hosted-primary-button" type="submit" disabled={!draft.trim() || !provider?.model || !consent || busy}>{busy ? 'Sending…' : 'Send'}</button></div>
      </form>
    </section>
    {settingsOpen ? <ProviderSettings providerList={providerList} current={provider} onClose={() => setSettingsOpen(false)} onChanged={(next) => { setProvider(next); refresh() }} /> : null}
  </main>
}

function PasswordReset({ account, onChanged }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const mismatch = confirm.length > 0 && password !== confirm
  return <main className="hosted-auth-page"><section className="hosted-auth-card">
    <div className="hosted-brand-mark" aria-hidden="true">R</div><p className="hosted-eyebrow">ACCOUNT RECOVERY</p>
    <h1>Choose a new password</h1><p className="hosted-muted">Resetting the password for {account.email}.</p><ErrorNote error={error} />
    <form className="hosted-auth-form" onSubmit={async (event) => {
      event.preventDefault(); setBusy(true); setError(null)
      try { await hostedRequest('/auth/password', { method: 'POST', body: { password } }); onChanged() }
      catch (failure) { setError(failure) } finally { setBusy(false) }
    }}>
      <label>New password<input type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <label>Confirm new password<input type="password" autoComplete="new-password" required maxLength={256} value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>
      {mismatch ? <p className="hosted-error">The passwords do not match.</p> : null}
      <button className="hosted-primary-button" type="submit" disabled={busy || !password || mismatch}>{busy ? 'Updating…' : 'Change password'}</button>
    </form>
  </section></main>
}

export default function HostedByokApp() {
  const [account, setAccount] = useState(null)
  const [checking, setChecking] = useState(true)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState('')
  const [recoveryMode, setRecoveryMode] = useState(false)
  useEffect(() => {
    const params = new URLSearchParams((globalThis.location?.hash ?? '').replace(/^#/, ''))
    const accessToken = params.get('access_token')
    const refreshToken = params.get('refresh_token')
    if (params.get('type') === 'recovery' && accessToken && refreshToken) {
      hostedRequest('/auth/recovery-session', { method: 'POST', body: { accessToken, refreshToken } })
        .then((result) => { setAccount(result.account); setRecoveryMode(true) })
        .catch(setError)
        .finally(() => { globalThis.history?.replaceState(null, '', `${globalThis.location?.pathname ?? '/'}${globalThis.location?.search ?? ''}`); setChecking(false) })
      return
    }
    hostedRequest('/auth').then((status) => setAccount(status.account ?? null)).catch(setError).finally(() => setChecking(false))
  }, [])
  const signOut = async () => {
    try { await hostedRequest('/auth/logout', { method: 'POST', body: {} }); setAccount(null) } catch (failure) { setError(failure) }
  }
  if (checking) return <main className="hosted-auth-page"><p className="hosted-muted">Opening your hosted workspace…</p></main>
  if (error && !account) return <main className="hosted-auth-page"><section className="hosted-auth-card"><h1>Ragam is temporarily unavailable</h1><ErrorNote error={error} /><p className="hosted-hint">The hosted service may still be setting up. Please try again later.</p></section></main>
  if (recoveryMode && account) return <PasswordReset account={account} onChanged={() => { setAccount(null); setRecoveryMode(false); setNotice('Password updated. Sign in with your new password.') }} />
  return account ? <HostedWorkspace account={account} onSignOut={signOut} /> : <AuthPanel initialNotice={notice} onAuthenticated={setAccount} />
}
