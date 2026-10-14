import React from 'react'
import { Field } from './ui.jsx'

export default function ExecutionMode({ value, onChange }) {
  return (
    <Field label="Execution mode" hint="Local uses the device running Aetheris Core, not necessarily this browser. Strict Offline blocks remote services in every mode.">
      <select className="select" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="local">Local — no remote fallback</option>
        <option value="hybrid">Hybrid — allow policy-approved remote tasks</option>
        <option value="online">Online — configured remote provider only</option>
      </select>
    </Field>
  )
}
