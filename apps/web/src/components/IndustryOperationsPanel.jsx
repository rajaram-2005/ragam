import React from 'react'
import { INDUSTRY_TASKS } from '../industry-operations.js'

export default function IndustryOperationsPanel({ enabled, onEnabledChange, onStartTask }) {
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
    {enabled ? <div className="industry-ops-actions">
      {INDUSTRY_TASKS.map((task) => <button key={task.id} className="btn block" type="button" onClick={() => onStartTask?.(task.prompt)}>{task.label}</button>)}
    </div> : <p className="small">Turn on to apply safety-first manufacturing guidance to supported text Chat models.</p>}
    <p className="industry-ops-note">Advice only · verify against approved site procedures. Company Knowledge is used only when available and explicitly approved per Chat request.</p>
  </section>
}
