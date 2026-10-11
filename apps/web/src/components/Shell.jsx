import React from 'react'
import { Chip } from './ui.jsx'
// The area list lives in a plain .js module so the structural tests can import it
// (Node cannot parse JSX); re-exported here because the shell owns the navigation.
export { AREAS, AREA_IDS } from '../areas.js'

// ---------------------------------------------------------------------------
// Application shell.
//
// Exactly five navigation entries. Upstream Aetheris exposed twelve sections
// (observability, architecture, workflows, agents, models, devices, command,
// coding, knowledge, two studios, plugins, mcp); every one of those that is not
// a product area is now an internal service surfaced inside an area or in the
// status card below the navigation — never as a sixth tab.
//
//   command + coding + knowledge  -> Chat
//   studio-image                  -> Image
//   studio-video                  -> Video
//   plugins                       -> Plugins
//   mcp                           -> MCP
//   observability / architecture / workflows / agents / models / devices
//                                 -> internal, no navigation entry
// ---------------------------------------------------------------------------


const POLICY_LABELS = {
  strict_offline: 'strict offline',
  hybrid: 'hybrid',
  online_enabled: 'online enabled',
}

/**
 * Runtime status card. This is where model management, resource management and
 * the runtime policy live — visible as state, not as sections.
 */
export function StatusCard({ readiness, config, error }) {
  if (error) {
    return (
      <div className="fabric-status" data-tone="blocked">
        <div className="fabric-status-head">
          <strong>Core service unreachable</strong>
          <Chip tone="bad">offline</Chip>
        </div>
        <div className="fabric-status-meta">
          <span>the interface cannot reach /api</span>
          <span>{error.message}</span>
        </div>
      </div>
    )
  }

  if (!readiness) {
    return (
      <div className="fabric-status" data-tone="warn">
        <div className="fabric-status-head">
          <strong>Probing…</strong>
          <span className="spinner" />
        </div>
        <div className="fabric-status-meta">
          <span>reading readiness from the core service</span>
        </div>
      </div>
    )
  }

  const tone = readiness.status === 'ready' ? 'ok' : readiness.status === 'degraded' ? 'warn' : 'blocked'
  const caps = readiness.capabilities ?? {}
  const capTone = (available) => (available ? 'ok' : 'bad')
  const hardware = readiness.hardware ?? {}
  const warnings = readiness.warnings ?? []
  const notReady = readiness.notReady ?? []

  return (
    <div className="fabric-status" data-tone={tone}>
      <div className="fabric-status-head">
        <strong>{readiness.status ?? 'unknown'}</strong>
        <Chip tone={tone}>{POLICY_LABELS[readiness.policy] ?? readiness.policy}</Chip>
      </div>
      <div className="fabric-status-meta">
        <span>
          network egress <b>{readiness.offlineEnforced ? 'blocked' : 'allowlisted'}</b>
        </span>
        <span>
          models <b>{readiness.models?.ready ?? 0}/{readiness.models?.total ?? 0} ready</b>
        </span>
        <span>
          chat <b data-tone={capTone(caps.chat)}>{caps.chat ? 'yes' : 'no'}</b> · embed{' '}
          <b>{caps.embeddings ? 'yes' : 'no'}</b> · image <b>{caps.imageGeneration ? 'yes' : 'no'}</b> · video{' '}
          <b>{caps.videoGeneration ? 'yes' : 'no'}</b>
        </span>
        <span>
          hardware <b>{hardware.cpuCount ?? '?'} cpu</b> · <b>{hardware.ramGb ?? '?'} gb</b> ·{' '}
          <b>{hardware.gpuDetected ? 'gpu' : 'no gpu'}</b>
        </span>
        {config?.fabric?.enabled !== undefined ? (
          <span>
            training fabric <b>{config.fabric.baseUrl ? 'configured' : 'disabled'}</b>
          </span>
        ) : null}
        {warnings.length > 0 ? (
          <span title={warnings.join('\n')}>
            warnings <b>{warnings.length}</b>
          </span>
        ) : null}
        {notReady.length > 0 ? (
          <span title={notReady.join('\n')}>
            not ready <b>{notReady.length}</b>
          </span>
        ) : null}
      </div>
    </div>
  )
}

export function Shell({ active, onSelect, readiness, config, readinessError, onRefresh, children, title, subtitle, topActions }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <span className="brand-mark" aria-hidden="true">
            <i className="mark-orbit" />
            <i className="mark-orbit orbit-two" />
            <i className="mark-core" />
          </span>
          <span className="brand-type">
            AETHERIS<span className="brand-caret">_</span>
          </span>
        </div>

        <p className="nav-label">PRODUCT AREAS</p>
        <nav className="primary-nav" aria-label="Product areas">
          {AREAS.map((area) => (
            <button
              key={area.id}
              type="button"
              className={`nav-item${active === area.id ? ' active' : ''}`}
              onClick={() => onSelect(area.id)}
              aria-current={active === area.id ? 'page' : undefined}
            >
              <span className="nav-glyph" aria-hidden="true">
                {area.glyph}
              </span>
              <span className="nav-text">
                <strong>{area.label}</strong>
                <small>{area.hint}</small>
              </span>
              {active === area.id ? <i className="nav-active-line" aria-hidden="true" /> : null}
            </button>
          ))}
        </nav>

        <div className="sidebar-spacer" />

        <StatusCard readiness={readiness} config={config} error={readinessError} />

        <p className="nav-label">INTERNAL SERVICES</p>
        <div className="fabric-status-meta" style={{ margin: '0 5px 8px' }}>
          <span>routing · memory · safety · training</span>
          <span>god core · benchmarks · resources</span>
          <span>
            surfaced <b>inside</b> the five areas
          </span>
        </div>

        <div className="row" style={{ margin: '0 5px' }}>
          <button type="button" className="btn" onClick={onRefresh} style={{ width: '100%', justifyContent: 'center' }}>
            Re-probe status
          </button>
        </div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
          <div className="topbar-spacer" />
          {topActions ? <div className="row">{topActions}</div> : null}
        </header>
        <div className="scroll-area">{children}</div>
      </main>
    </div>
  )
}
