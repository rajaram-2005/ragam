import React from 'react'
import { toneFor, formatValue } from '../format.js'

export { toneFor, formatValue }

// ---------------------------------------------------------------------------
// Shared UI primitives.
//
// One rule runs through all of them: nothing in the interface may claim more
// than the backend reported. Chips render a tone the server decided, banners
// print the server's own limitation strings verbatim, and ErrorNote shows the
// machine-readable code so "no model installed" is never flattened into the
// same red box as "the backend is unreachable".
// ---------------------------------------------------------------------------

export function Chip({ children, tone, title, dot = true }) {
  const resolved = tone ?? toneFor(children)
  return (
    <span className="chip" data-tone={resolved} title={title}>
      {dot ? <i className="dot" /> : null}
      {children}
    </span>
  )
}

export function Panel({ eyebrow, title, actions, footer, tight, children, className = '' }) {
  return (
    <section className={`panel ${className}`.trim()}>
      {(title || actions) && (
        <header className="panel-header">
          <div>
            {eyebrow ? <span className="panel-eyebrow">{eyebrow}</span> : null}
            {title ? <h2>{title}</h2> : null}
          </div>
          {actions ? <div className="actions">{actions}</div> : null}
        </header>
      )}
      <div className={`panel-body${tight ? ' tight' : ''}`}>{children}</div>
      {footer ? <footer className="panel-footer">{footer}</footer> : null}
    </section>
  )
}

export function Button({ children, variant = 'default', busy, disabled, ...rest }) {
  return (
    <button className="btn" data-variant={variant} disabled={disabled || busy} {...rest}>
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  )
}

/**
 * Server-supplied limitations, rendered as-is. The strings come from the core
 * service (e.g. "video generation requires an approved online provider"), so the
 * UI adds no interpretation of its own.
 */
export function Banner({ tone, title, children, items }) {
  const list = items?.filter(Boolean) ?? []
  if (!title && !children && list.length === 0) return null
  return (
    <div className="banner" data-tone={tone} role="status">
      <div className="grow">
        {title ? <strong>{title}</strong> : null}
        {children}
        {list.length > 0 && (
          <ul>
            {list.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export function ErrorNote({ error, title = 'Request failed' }) {
  if (!error) return null
  const code = error.code ?? 'error'
  const limitation = error.limitation ?? null
  const detail = error.detail
  return (
    <Banner tone={error.unavailable ? 'warn' : 'bad'} title={title}>
      <span>{error.message}</span>
      <div className="row" style={{ marginTop: 7 }}>
        <Chip tone={error.unavailable ? 'warn' : 'bad'}>{code}</Chip>
        {error.status ? <Chip tone="info">HTTP {error.status}</Chip> : null}
        {error.route ? <Chip tone="violet" dot={false}>{error.route}</Chip> : null}
      </div>
      {limitation ? <p className="small soft" style={{ margin: '8px 0 0' }}>Limitation: {limitation}</p> : null}
      {detail ? (
        <pre className="code" style={{ marginTop: 8 }}>
          {typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}
        </pre>
      ) : null}
    </Banner>
  )
}

export function EmptyState({ title, children, action }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {children ? <div>{children}</div> : null}
      {action ? <div className="row" style={{ justifyContent: 'center', marginTop: 6 }}>{action}</div> : null}
    </div>
  )
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  )
}

export function Stat({ label, value, note, small }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value${small ? ' small' : ''}`}>{value ?? '—'}</span>
      {note ? <span className="stat-note">{note}</span> : null}
    </div>
  )
}

export function Stats({ children }) {
  return <div className="stats">{children}</div>
}

export function Kv({ entries }) {
  const rows = Object.entries(entries ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== '')
  if (rows.length === 0) return <span className="muted small">nothing reported</span>
  return (
    <dl className="kv">
      {rows.map(([key, value]) => (
        <React.Fragment key={key}>
          <dt>{key}</dt>
          <dd>{formatValue(value)}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

export function Code({ value, label }) {
  if (value === null || value === undefined) return null
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return (
    <div className="grid" style={{ gap: 6 }}>
      {label ? <span className="panel-eyebrow">{label}</span> : null}
      <pre className="code">{text}</pre>
    </div>
  )
}

/** The eight God Core phases, in execution order. */
const PHASES = ['understand', 'plan', 'retrieve', 'route', 'execute', 'observe', 'verify', 'synthesize']

export function Lifecycle({ task }) {
  const steps = task?.steps ?? []
  // A phase can appear more than once (a bounded retry pushes a second entry), so
  // keep the last one — that is the phase's current disposition.
  const byPhase = new Map(steps.map((step) => [step.phase, step]))
  const currentIndex = Number.isInteger(task?.phaseIndex) ? task.phaseIndex : steps.length - 1
  const active = ['running', 'awaiting_approval', 'paused'].includes(task?.state)

  return (
    <div className="lifecycle">
      {PHASES.map((phase, index) => {
        const step = byPhase.get(phase)
        let state = 'idle'
        if (step) {
          if (step.status === 'failed' || step.status === 'budget_exceeded') state = 'failed'
          else if (step.status === 'complete') state = step.evidence === 'skipped' ? 'skipped' : 'passed'
          else state = 'current' // 'retrying' or an in-flight phase
        } else if (active && index === currentIndex) {
          state = 'current'
        }
        const detail = step?.detail
        return (
          <span
            key={phase}
            className="phase"
            data-state={state}
            title={[phase, step?.status ? `status: ${step.status}` : null, step?.evidence ? `evidence: ${step.evidence}` : null, typeof detail === 'string' ? detail : null]
              .filter(Boolean)
              .join(' · ')}
          >
            {phase}
            {step?.evidence && step.evidence !== 'observed' && step.evidence !== 'verified' ? (
              <span title={`evidence: ${step.evidence}`}> ·{String(step.evidence).slice(0, 4)}</span>
            ) : null}
          </span>
        )
      })}
    </div>
  )
}

export function Checks({ checks }) {
  const list = checks ?? []
  if (list.length === 0) return <span className="muted small">no verification checks were run</span>
  return (
    <div className="checks">
      {list.map((check, index) => (
        <div className="check" key={`${check.name ?? index}-${index}`} data-pass={String(Boolean(check.passed))}>
          <span className="mark">{check.passed ? '✓' : '✕'}</span>
          <span>
            <strong>{check.name ?? `check ${index + 1}`}</strong>
            {check.detail ? <span className="muted small"> — {formatValue(check.detail)}</span> : null}
          </span>
        </div>
      ))}
    </div>
  )
}

export function Progress({ value }) {
  const percent = Math.max(0, Math.min(100, Math.round((value ?? 0) * 100)))
  return (
    <div className="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${percent}%` }} />
    </div>
  )
}

/**
 * Anything that is not real output — a preview, a canned response, a sample —
 * carries this tag in the interface itself, per the standing rule that mock data
 * must be marked and kept out of production success paths.
 */
export function FixtureTag({ children = 'development fixture' }) {
  return <span className="fixture-tag">⚠ {children}</span>
}

export function Table({ columns, rows, empty }) {
  if (!rows || rows.length === 0) return <EmptyState title={empty ?? 'Nothing here yet'} />
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.key ?? index}>
              {columns.map((column) => (
                <td key={column.key}>{column.render ? column.render(row, index) : formatValue(row[column.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
