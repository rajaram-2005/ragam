import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AREAS, AREA_IDS } from '../areas.js'
import AccountCard from './AccountCard.jsx'
import IndustryOperationsPanel from './IndustryOperationsPanel.jsx'
export { AREAS, AREA_IDS }
export function StatusCard({ readiness, error }) {
  return <div className="fabric-status" data-tone={error ? 'blocked' : 'warn'}>
    <strong>{error ? 'Connection unavailable' : 'Online only'}</strong>
    <div className="fabric-status-meta"><span>{readiness ? `${readiness.models?.total ?? 0} models listed · ${readiness.models?.ready ?? 0} inference observed` : 'Checking connection…'}</span><span>No local inference or fallback</span></div>
  </div>
}

function AreaGlyph({ id }) {
  const face = `glyph-face-${id}`
  const rim = `glyph-rim-${id}`
  const shadow = `glyph-shadow-${id}`
  const details = {
    chat: <>
      <path d="M6 8.5c0-2 1.6-3.6 3.6-3.6h12.8c2 0 3.6 1.6 3.6 3.6v9.2c0 2-1.6 3.6-3.6 3.6h-6.6l-5.2 4v-4.2C7.8 20.7 6 19.2 6 17z" fill={`url(#${face})`} stroke={`url(#${rim})`} strokeWidth="1.5" />
      <path d="M11 12.4c1.3-2.4 3-2.4 4.3 0 1.2-2.4 3-2.4 4.3 0" fill="none" stroke="#e8ffbc" strokeWidth="1.35" strokeLinecap="round" />
      <circle cx="13.2" cy="14.3" r="1.15" fill="#b8ff4b" /><circle cx="18.1" cy="14.3" r="1.15" fill="#b8ff4b" />
    </>,
    image: <>
      <path d="M8 4.8h16a3 3 0 0 1 3 3v16a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-16a3 3 0 0 1 3-3z" fill={`url(#${face})`} stroke={`url(#${rim})`} strokeWidth="1.5" />
      <circle cx="20.5" cy="10" r="2.2" fill="#d6ff79" stroke="#f0ffcb" strokeWidth=".8" />
      <path d="m7.5 21 5.1-5.3 3.2 3 2.4-2.1 6.2 5.5H8.2z" fill="#9a62df" stroke="#e0b8ff" strokeWidth=".85" strokeLinejoin="round" />
      <path d="m8 7 8-1.5" stroke="#fff" strokeOpacity=".7" strokeWidth="1" strokeLinecap="round" />
    </>,
    video: <>
      <path d="M7.2 5.2h13.5a3 3 0 0 1 3 3v15a3 3 0 0 1-3 3H7.2a3 3 0 0 1-3-3v-15a3 3 0 0 1 3-3z" fill={`url(#${face})`} stroke={`url(#${rim})`} strokeWidth="1.5" />
      <path d="m13 10 8 5-8 5z" fill="#c3ff59" stroke="#f2ffc9" strokeWidth="1" strokeLinejoin="round" />
      <path d="m23.7 11 4.3-2.4v12.8l-4.3-2.5z" fill="#8b55d6" stroke="#deb6ff" strokeWidth="1" strokeLinejoin="round" />
      <path d="M8 7.5h7" stroke="#fff" strokeOpacity=".72" strokeWidth="1" strokeLinecap="round" />
    </>,
    plugins: <>
      <path d="m16 3.7 10.4 6v12L16 27.7 5.6 21.7v-12z" fill={`url(#${face})`} stroke={`url(#${rim})`} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M16 9.2v13.6M10.1 12.6l11.8 6.8M21.9 12.6l-11.8 6.8" stroke="#e8d8ff" strokeOpacity=".86" strokeWidth="1.4" />
      <circle cx="16" cy="9.2" r="2.5" fill="#c0ff58" stroke="#f3ffc9" strokeWidth="1" />
      <circle cx="10.1" cy="19.4" r="2.2" fill="#9a62df" stroke="#e1c3ff" strokeWidth="1" />
      <circle cx="21.9" cy="19.4" r="2.2" fill="#55dfc2" stroke="#c8fff1" strokeWidth="1" />
    </>,
    mcp: <>
      <path d="M8 8.2a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm16 7.6a4 4 0 1 1 0 8 4 4 0 0 1 0-8z" fill={`url(#${face})`} stroke={`url(#${rim})`} strokeWidth="1.5" />
      <path d="M11.3 11.4h6a4 4 0 0 1 4 4v1.5M20.7 20.3h-6a4 4 0 0 1-4-4v-1.5" fill="none" stroke="#d8ff83" strokeWidth="2" strokeLinecap="round" />
      <circle cx="8" cy="12.2" r="1.35" fill="#eeffc7" /><circle cx="24" cy="19.8" r="1.35" fill="#eeffc7" />
      <path d="m18.4 14.8 3.1 2.1-3.1 2.1M13.6 17.2l-3.1-2.1 3.1-2.1" fill="none" stroke="#c48aff" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </>,
  }[id]

  return <span className={`nav-glyph nav-glyph-${id}`} aria-hidden="true">
    <svg viewBox="0 0 32 32" focusable="false">
      <defs>
        <linearGradient id={face} x1="4" y1="3" x2="27" y2="29" gradientUnits="userSpaceOnUse">
          <stop stopColor="#d4ff81" /><stop offset=".45" stopColor="#65d5b5" /><stop offset="1" stopColor="#6f3eae" />
        </linearGradient>
        <linearGradient id={rim} x1="8" y1="2" x2="24" y2="29" gradientUnits="userSpaceOnUse">
          <stop stopColor="#f3ffc9" /><stop offset=".5" stopColor="#a7f5d3" /><stop offset="1" stopColor="#a66fe8" />
        </linearGradient>
        <filter id={shadow} x="-35%" y="-35%" width="170%" height="180%">
          <feDropShadow dx="0" dy="2" stdDeviation="1.4" floodColor="#04020a" floodOpacity=".8" />
        </filter>
      </defs>
      <g filter={`url(#${shadow})`}>{details}</g>
    </svg>
  </span>
}

function BrandMonster() {
  return <svg className="brand-monster" viewBox="0 0 48 48" focusable="false">
    <defs>
      <linearGradient id="brand-hide" x1="8" y1="4" x2="40" y2="45" gradientUnits="userSpaceOnUse">
        <stop stopColor="#d7ff83" /><stop offset=".44" stopColor="#69d6b5" /><stop offset="1" stopColor="#7138ad" />
      </linearGradient>
      <linearGradient id="brand-horn" x1="9" y1="2" x2="21" y2="26" gradientUnits="userSpaceOnUse">
        <stop stopColor="#f4ffc8" /><stop offset="1" stopColor="#70d9b5" />
      </linearGradient>
      <radialGradient id="brand-eye" cx="0" cy="0" r="1" gradientTransform="matrix(0 8 -8 0 24 24)" gradientUnits="userSpaceOnUse">
        <stop stopColor="#efffbc" /><stop offset=".37" stopColor="#baff42" /><stop offset="1" stopColor="#4b8d49" />
      </radialGradient>
      <filter id="brand-depth" x="-25%" y="-25%" width="150%" height="165%">
        <feDropShadow dx="0" dy="3" stdDeviation="2" floodColor="#030107" floodOpacity=".85" />
      </filter>
    </defs>
    <g filter="url(#brand-depth)">
      <path d="m9 21 2-14 11 9M39 21 37 7 26 16" fill="url(#brand-horn)" stroke="#e9ffc2" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 25c0-10 7-17 16-17s16 7 16 17v5c0 7-7 12-16 12S8 37 8 30z" fill="url(#brand-hide)" stroke="#d9ffc0" strokeWidth="1.4" />
      <path d="M12 22c2-6 6-8 12-8s10 2 12 8" fill="none" stroke="#f0ffd8" strokeOpacity=".72" strokeWidth="1.2" strokeLinecap="round" />
      <ellipse cx="24" cy="26" rx="9.5" ry="7" fill="#20152d" stroke="#e2b9ff" strokeWidth="1.2" />
      <ellipse cx="24" cy="26" rx="5.3" ry="5.8" fill="url(#brand-eye)" />
      <ellipse cx="24" cy="25.7" rx="1.4" ry="4" fill="#20152d" />
      <circle cx="22.1" cy="23.6" r="1.1" fill="#fff" />
      <path d="m18 34 2.5 4 3.5-3.1 3.5 3.1L30 34" fill="#f0e6ff" stroke="#633b81" strokeWidth="1" strokeLinejoin="round" />
    </g>
  </svg>
}

export function Shell({ active, onSelect, readiness, readinessError, children, title, subtitle, account, onSettings, onProfile, onSignOut, industryMode, onIndustryModeChange, onStartIndustryTask, localOnlyMode, onLocalOnlyModeChange }) {
  const [collapsed, setCollapsed] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const navRef = useRef(null)

  const handleNav = useCallback((id) => {
    setDrawerOpen(false)
    onSelect(id)
  }, [onSelect])

  // Keyboard navigation: ArrowUp/ArrowDown move between nav items, Home/End jump to first/last
  useEffect(() => {
    const handler = (event) => {
      if (event.target.closest('.sidebar') !== navRef.current && !event.target.closest('.sidebar')) return
      const items = Array.from(navRef.current?.querySelectorAll('.nav-item') ?? [])
      if (items.length === 0) return
      const current = items.findIndex((el) => el === document.activeElement)
      let next = current
      if (event.key === 'ArrowDown') next = current < 0 ? 0 : Math.min(items.length - 1, current + 1)
      else if (event.key === 'ArrowUp') next = current <= 0 ? 0 : current - 1
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = items.length - 1
      else return
      event.preventDefault()
      items[next]?.focus()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Close drawer on Escape
  useEffect(() => {
    if (!drawerOpen) return
    const handler = (event) => { if (event.key === 'Escape') setDrawerOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [drawerOpen])

  return <div className="app-shell">
    <button
      className="sidebar-toggle"
      type="button"
      onClick={() => setDrawerOpen(true)}
      aria-label="Open navigation"
      aria-expanded={drawerOpen}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path d="M2 4.5H16M2 9H16M2 13.5H16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
    </button>
    <div className={`drawer-backdrop${drawerOpen ? ' open' : ''}`} onClick={() => setDrawerOpen(false)} aria-hidden="true" />
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}${drawerOpen ? ' open' : ''}`} ref={navRef}>
      <div className="sidebar-top">
        <button
          className="btn icon ghost"
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand' : 'Collapse'}
          style={{ padding: 0, border: 0, background: 'transparent' }}
        >
          <span className="brand-mark" aria-hidden="true"><BrandMonster /></span>
        </button>
        <span className="brand-type">AETHERIS<span className="brand-caret">_</span></span>
      </div>
      <p className="nav-label">WORKSPACE</p>
      <nav className="primary-nav" aria-label="Product areas">{AREAS.map((area) => <button key={area.id} type="button" className={`nav-item${active === area.id ? ' active' : ''}`} onClick={() => handleNav(area.id)} aria-current={active === area.id ? 'page' : undefined}><AreaGlyph id={area.id} /><span className="nav-text"><strong>{area.label}</strong><small>{area.hint}</small></span></button>)}</nav>
      <IndustryOperationsPanel enabled={industryMode} onEnabledChange={onIndustryModeChange} onStartTask={onStartIndustryTask} localOnly={localOnlyMode} onLocalOnlyChange={onLocalOnlyModeChange} />
      <div className="sidebar-spacer" />
      <StatusCard readiness={readiness} error={readinessError} />
      <div className="sidebar-footer">
        <button className="btn block" type="button" onClick={onSettings}>Provider Settings</button>
        <button className="btn block" type="button" onClick={onProfile}>Name &amp; profession</button>
        {/* Who is signed in, and what that person can do about it. Not a sixth area: an
            account menu is chrome, and the five areas stay the whole product surface. */}
        <AccountCard account={account} onSignOut={onSignOut} />
      </div>
    </aside>
    <main className="main-shell"><header className="topbar"><div className="topbar-title"><h1>{title}</h1><p>{subtitle}</p></div><div className="topbar-spacer" /><span className="chip">ONLINE</span></header><div className="scroll-area"><div className="scroll-area-inner">{children}</div></div></main>
  </div>
}
