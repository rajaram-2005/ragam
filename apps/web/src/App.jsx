import React, { useCallback, useEffect, useState } from 'react'
import { api } from './api.js'
import { Shell } from './components/Shell.jsx'
import { AREAS } from './areas.js'
import { AUTH_PAGES, DEFAULT_AUTH_PAGE, SESSION_ENDED_NOTICE, authPageFromHash, isAuthHash } from './auth.js'
import { Banner } from './components/ui.jsx'
import ProviderSettings from './components/ProviderSettings.jsx'
import SignInPage from './pages/SignInPage.jsx'
import SignUpPage from './pages/SignUpPage.jsx'
import ForgotPasswordPage from './pages/ForgotPasswordPage.jsx'
import ChatArea from './areas/ChatArea.jsx'
import ImageArea from './areas/ImageArea.jsx'
import VideoArea from './areas/VideoArea.jsx'
import PluginsArea from './areas/PluginsArea.jsx'
import McpArea from './areas/McpArea.jsx'

// What the address bar can say, and what the app shows for each of them.
//
// Five product areas plus three sign-in pages, all addressed by hash. There is no
// routing library and no route table to extend: `App` reads the hash, decides whether
// the person is signed in, and renders either one area or one sign-in page. Being signed
// out is a fact about the session, not a place in the app, so an area hash while signed
// out simply shows the sign-in page rather than a wall that has to be dismissed.
const hash = () => globalThis.location?.hash ?? ''
const currentArea = () => AREAS.find((area) => `#/${area.id}` === hash())?.id ?? 'chat'
const currentPage = () => authPageFromHash(hash())
const goTo = (target) => { if (globalThis.location) globalThis.location.hash = target }

export default function App() {
  const [account, setAccount] = useState(null), [checking, setChecking] = useState(true)
  const [authError, setAuthError] = useState(null), [notice, setNotice] = useState('')
  const [active, setActive] = useState(currentArea), [page, setPage] = useState(currentPage), [settings, setSettings] = useState(false)
  const [readiness, setReadiness] = useState(null), [provider, setProvider] = useState(null), [error, setError] = useState(null)

  // Both are `useCallback` with no dependencies because they touch only state setters,
  // and `refresh` depends on `signedOut`: a new identity for either would tear down and
  // rebuild the polling interval on every render.
  // Signing in lands on Chat: the workspace, not the page you were standing on.
  const signedIn = useCallback((next) => { setAccount(next); setAuthError(null); setNotice(''); setActive('chat'); goTo('#/chat') }, [])
  const signedOut = useCallback((ended = '') => {
    setAccount(null); setProvider(null); setReadiness(null); setSettings(false); setError(null); setNotice(ended)
    setPage(DEFAULT_AUTH_PAGE); goTo(AUTH_PAGES.find((entry) => entry.id === DEFAULT_AUTH_PAGE).hash)
  }, [])

  const refresh = useCallback(async () => {
    try { const [r, p] = await Promise.all([api.ready(), api.provider()]); setReadiness(r); setProvider(p); setError(null) }
    // A 401 in the middle of using the app means the browser has stopped sending the
    // session cookie. Ending the session without saying so leaves a person staring at a
    // sign-in page they did not ask for, with no idea that the cause may be the frame
    // this app is served in rather than their password.
    catch (e) { setError(e); if (e.status === 401) signedOut(SESSION_ENDED_NOTICE) }
  }, [signedOut])

  useEffect(() => {
    api.auth()
      // An already-valid session goes straight to the workspace; a signed-out visitor
      // stays on whichever sign-in page the address bar asked for.
      .then((status) => { if (status.account) { setAccount(status.account); setActive('chat'); goTo('#/chat') } })
      .catch(setAuthError)
      .finally(() => setChecking(false))
  }, [])

  // Re-registered when the session changes, because the answer to "where does this hash
  // go?" depends on it: signed out, a sign-in hash picks a page and an area hash shows
  // the sign-in page; signed in, a sign-in hash goes back to the workspace instead of
  // leaving a stale address on screen.
  useEffect(() => {
    const change = () => {
      if (account && isAuthHash(hash())) { setActive('chat'); goTo('#/chat'); return }
      setActive(currentArea()); setPage(currentPage())
    }
    window.addEventListener('hashchange', change)
    return () => window.removeEventListener('hashchange', change)
  }, [account])

  useEffect(() => { if (!account) return; refresh(); const id = setInterval(refresh, 20000); return () => clearInterval(id) }, [account, refresh])

  if (!account) {
    const shared = { checking, error: authError, onError: setAuthError }
    if (page === 'signup') return <SignUpPage {...shared} onSignedIn={signedIn} />
    if (page === 'forgot-password') return <ForgotPasswordPage error={authError} onError={setAuthError} />
    return <SignInPage {...shared} notice={notice} onSignedIn={signedIn} />
  }

  const area = AREAS.find((a) => a.id === active) ?? AREAS[0]
  const shared = { provider, readiness, refreshReadiness: refresh, onSettings: () => setSettings(true), account }
  return <Shell
    active={area.id}
    onSelect={(id) => { setActive(id); goTo(`#/${id}`) }}
    readiness={readiness}
    readinessError={error}
    title={area.label}
    subtitle="Your gateway. Your models. Online inference only."
    account={account}
    onSettings={() => setSettings(true)}
    onSignOut={async () => { try { await api.logout(); signedOut() } catch (e) { setError(e) } }}
  >
    {error ? <Banner tone="bad" title={error.message} /> : null}
    {area.id === 'chat' ? <ChatArea {...shared} /> : null}
    {area.id === 'image' ? <ImageArea {...shared} /> : null}
    {area.id === 'video' ? <VideoArea {...shared} /> : null}
    {area.id === 'plugins' ? <PluginsArea {...shared} /> : null}
    {area.id === 'mcp' ? <McpArea {...shared} /> : null}
    {settings ? <ProviderSettings account={account} onClose={() => setSettings(false)} onChanged={refresh} /> : null}
  </Shell>
}
