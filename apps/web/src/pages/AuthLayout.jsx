import React from 'react'
import { AUTH_PAGES } from '../auth.js'
import { Banner } from '../components/ui.jsx'

// Shared frame for the three sign-in pages.
//
// One card, the product's own mark, a title, the form, and links to the other two pages.
// Keeping the frame in one component is what makes them read as one sign-in surface
// instead of three unrelated forms — and it means an honest note about this
// installation ("no third-party sign-in, no password recovery by email") is stated in
// exactly one place and cannot be dropped from one page by accident.

export function AuthLink({ page, children, className = '' }) {
  const target = AUTH_PAGES.find((entry) => entry.id === page)
  if (!target) return null
  return <a className={`auth-link ${className}`.trim()} href={target.hash}>{children}</a>
}

export default function AuthLayout({ active, title, subtitle, error, notice, noticeTone = 'ok', children, footer }) {
  return (
    <main className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true">
            <i className="mark-orbit" /><i className="mark-orbit orbit-two" /><i className="mark-core" />
          </span>
          <span className="brand-type">AETHERIS<span className="brand-caret">_</span></span>
        </div>
        <h1>{title}</h1>
        {subtitle ? <p className="auth-subtitle">{subtitle}</p> : null}
        {error ? <Banner tone="bad" title={error.message ?? String(error)} /> : null}
        {notice ? <Banner tone={noticeTone} title={notice} /> : null}
        {children}
        <nav className="auth-nav" aria-label="Sign-in pages">
          {AUTH_PAGES.map((page) => (
            page.id === active
              ? <span key={page.id} className="auth-nav-current" aria-current="page">{page.label}</span>
              : <AuthLink key={page.id} page={page.id}>{page.label}</AuthLink>
          ))}
        </nav>
        <p className="small auth-footer">
          {footer ?? 'Accounts belong to this installation. There is no third-party sign-in, and no password recovery by email.'}
        </p>
      </div>
    </main>
  )
}
