import React from 'react'
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
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="sidebar-top"><span className="brand-mark" aria-hidden="true"><i className="mark-orbit" /><i className="mark-orbit orbit-two" /><i className="mark-core" /></span><span className="brand-type">AETHERIS<span className="brand-caret">_</span></span></div>
      <p className="nav-label">WORKSPACE</p>
      <nav className="primary-nav" aria-label="Product areas">{AREAS.map((area) => <button key={area.id} type="button" className={`nav-item${active === area.id ? ' active' : ''}`} onClick={() => onSelect(area.id)} aria-current={active === area.id ? 'page' : undefined}><span className="nav-glyph" aria-hidden="true">{area.glyph}</span><span className="nav-text"><strong>{area.label}</strong><small>{area.hint}</small></span></button>)}</nav>
      <div className="sidebar-spacer" /><StatusCard readiness={readiness} error={readinessError} />
      <button className="btn" type="button" onClick={onSettings}>Provider Settings</button>
      {/* Who is signed in, and what that person can do about it. Not a sixth area: an
          account menu is chrome, and the five areas stay the whole product surface. */}
      <AccountCard account={account} onSignOut={onSignOut} />
    </aside>
    <main className="main-shell"><header className="topbar"><div className="topbar-title"><h1>{title}</h1><p>{subtitle}</p></div><div className="topbar-spacer" /><span className="chip">ONLINE</span></header><div className="scroll-area">{children}</div></main>
  </div>
}
