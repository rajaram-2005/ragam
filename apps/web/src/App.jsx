import React, { useCallback, useEffect, useState } from 'react'
import { api } from './api.js'
import { Shell } from './components/Shell.jsx'
import { AREAS } from './areas.js'
import { Banner, Button, Field } from './components/ui.jsx'
import ProviderSettings from './components/ProviderSettings.jsx'
import ChatArea from './areas/ChatArea.jsx'
import ImageArea from './areas/ImageArea.jsx'
import VideoArea from './areas/VideoArea.jsx'
import PluginsArea from './areas/PluginsArea.jsx'
import McpArea from './areas/McpArea.jsx'
const currentArea = () => AREAS.find((a) => `#/${a.id}` === globalThis.location?.hash)?.id ?? 'chat'
export default function App() {
  const [authenticated, setAuthenticated] = useState(false), [checking, setChecking] = useState(true)
  const [token, setToken] = useState(''), [authError, setAuthError] = useState(null), [busy, setBusy] = useState(false)
  const [active, setActive] = useState(currentArea), [settings, setSettings] = useState(false)
  const [readiness, setReadiness] = useState(null), [provider, setProvider] = useState(null), [error, setError] = useState(null)
  const refresh = useCallback(async () => {
    try { const [r, p] = await Promise.all([api.ready(), api.provider()]); setReadiness(r); setProvider(p); setError(null) }
    catch (e) { setError(e); if (e.status === 401) setAuthenticated(false) }
  }, [])
  useEffect(() => { api.auth().then((s) => setAuthenticated(s.authenticated)).catch(setAuthError).finally(() => setChecking(false)); const change = () => setActive(currentArea()); window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change) }, [])
  useEffect(() => { if (!authenticated) return; refresh(); const id = setInterval(refresh, 20000); return () => clearInterval(id) }, [authenticated, refresh])
  if (!authenticated) return <main className="login-card"><div className="brand-type">AETHERIS_</div><h1>Your online AI workspace</h1><p>Chat, Image, Video, Plugins and MCP. Connect through your LiteLLM gateway.</p><h2>Sign in to this installation</h2><p className="small">The operator access token is in the Core host’s online data directory, in <code>access-token</code>. It is not your provider key. Paste it here, never in chat.</p>{authError ? <Banner tone="bad" title={authError.message} /> : null}<form onSubmit={async (e) => { e.preventDefault(); setBusy(true); setAuthError(null); try { await api.login(token.trim()); setToken(''); setAuthenticated(true) } catch (err) { setAuthError(err) } finally { setBusy(false) } }}><Field label="Installation access token"><input className="input" type="password" autoComplete="current-password" value={token} onChange={(e) => setToken(e.target.value)} required /></Field><Button type="submit" variant="primary" busy={busy || checking} disabled={!token}>Sign in</Button></form></main>
  const area = AREAS.find((a) => a.id === active) ?? AREAS[0]
  const shared = { provider, readiness, refreshReadiness: refresh, onSettings: () => setSettings(true) }
  return <Shell active={area.id} onSelect={(id) => { setActive(id); window.location.hash = `#/${id}` }} readiness={readiness} readinessError={error} title={area.label} subtitle="Your gateway. Your models. Online inference only." onSettings={() => setSettings(true)} onLogout={async () => { try { await api.logout(); setAuthenticated(false); setProvider(null); setSettings(false) } catch (e) { setError(e) } }}>
    {error ? <Banner tone="bad" title={error.message} /> : null}
    {area.id === 'chat' ? <ChatArea {...shared} /> : null}
    {area.id === 'image' ? <ImageArea {...shared} /> : null}
    {area.id === 'video' ? <VideoArea {...shared} /> : null}
    {area.id === 'plugins' ? <PluginsArea {...shared} /> : null}
    {area.id === 'mcp' ? <McpArea {...shared} /> : null}
    {settings ? <ProviderSettings onClose={() => setSettings(false)} onChanged={refresh} /> : null}
  </Shell>
}
