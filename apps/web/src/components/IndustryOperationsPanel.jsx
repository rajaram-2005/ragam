import React from 'react'
import { INDUSTRY_TASKS } from '../industry-operations.js'

export default function IndustryOperationsPanel({ enabled, onEnabledChange, onStartTask, mediaAvailable = true, localOnly = false, onLocalOnlyChange }) {
  return <section className="industry-ops-card" aria-label="Industry operations copilot">
    <div className="industry-ops-heading">
      <div>
        <strong>Operations Copilot</strong>
        <small>Manufacturing</small>
      </div>
      <label className="industry-ops-toggle">
        <input
          type="checkbox"
          aria-label="Enable manufacturing operations mode"
          checked={Boolean(enabled)}
          onChange={(event) => onEnabledChange?.(event.target.checked)}
        />
        <span>{enabled ? 'On' : 'Off'}</span>
      </label>
    </div>
    <div className="industry-ops-local-policy">
      <label className="industry-ops-toggle">
        <input
          type="checkbox"
          aria-label="Local-only mode; block remote model providers"
          checked={Boolean(localOnly)}
          onChange={(event) => onLocalOnlyChange?.(event.target.checked)}
        />
        <span>Local-only · no vendor API billing</span>
      </label>
      <small>{localOnly ? 'Remote inference and hosted BYOK are blocked. Manual Provider Settings tests may still contact a provider; local hardware, electricity, storage and model licences can still cost.' : 'Remote providers may charge; use only after checking terms and approving each request.'}</small>
    </div>
    {enabled ? <div className="industry-ops-actions">
      {INDUSTRY_TASKS.map((task) => <button key={task.id} className="btn block" type="button" onClick={() => onStartTask?.(task.prompt)}>{task.label}</button>)}
    </div> : <p className="small">Turn on to apply advisory guidance to supported text, image and video requests.</p>}
    <p className="industry-ops-note">Advice only · verify against approved site procedures. {mediaAvailable ? 'Generated media is illustrative, not site evidence. ' : ''}Company Knowledge is used only when available and explicitly approved per Chat request.</p>
  </section>
}
