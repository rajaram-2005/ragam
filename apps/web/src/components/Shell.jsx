import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AREAS, AREA_IDS } from '../areas.js'
import AccountCard from './AccountCard.jsx'
export { AREAS, AREA_IDS }
export function StatusCard({ readiness, error }) {
  return <div className="fabric-status" data-tone={error ? 'blocked' : 'warn'}>
    <strong>{error ? 'Connection unavailable' : 'Online only'}</strong>
    <div className="fabric-status-meta"><span>{readiness ? `${readiness.models?.total ?? 0} models listed · ${readiness.models?.ready ?? 0} inference observed` : 'Checking connection…'}</span><span>No local inference or fallback</span></div>
  </div>
}
export function Shell({ active, onSelect, readiness, readinessError, children, title, subtitle, account, onSettings, onSignOut }) {
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
          <span className="brand-mark" aria-hidden="true">
            <i className="mark-orbit" /><i className="mark-orbit orbit-two" /><i className="mark-core" />
          </span>
        </button>
        <span className="brand-type">AETHERIS<span className="brand-caret">_</span></span>
      </div>
      <p className="nav-label">WORKSPACE</p>
      <nav className="primary-nav" aria-label="Product areas">{AREAS.map((area) => <button key={area.id} type="button" className={`nav-item${active === area.id ? ' active' : ''}`} onClick={() => handleNav(area.id)} aria-current={active === area.id ? 'page' : undefined}><span className="nav-glyph" aria-hidden="true">{area.glyph}</span><span className="nav-text"><strong>{area.label}</strong><small>{area.hint}</small></span></button>)}</nav>
      <div className="sidebar-spacer" />
      <StatusCard readiness={readiness} error={readinessError} />
      <div className="sidebar-footer">
        <button className="btn block" type="button" onClick={onSettings}>Provider Settings</button>
        {/* Who is signed in, and what that person can do about it. Not a sixth area: an
            account menu is chrome, and the five areas stay the whole product surface. */}
        <AccountCard account={account} onSignOut={onSignOut} />
      </div>
    </aside>
    <main className="main-shell"><header className="topbar"><div className="topbar-title"><h1>{title}</h1><p>{subtitle}</p></div><div className="topbar-spacer" /><span className="chip">ONLINE</span></header><div className="scroll-area"><div className="scroll-area-inner">{children}</div></div></main>
  </div>
}
