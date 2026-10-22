import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Button } from './ui.jsx'

// Klyvaron Lite / Pro / Max are product tiers, not model weights.
//
// This panel exists to keep that sentence true on screen. Every row names the saved connection
// and the exact model a tier will use, plus the provenance sentence the server returns; a tier
// with no preset says so instead of showing the active connection's model as if it were the
// tier's. No control here can create a provider, spend a key or invent a model: the connection
// select is the list the server already saved, and the model select is that connection's own
// listed models.
//
// Assigning is owner-only because it changes where a shared product tier sends requests. The
// server enforces the same rule, so hiding the form is a courtesy, not the control.

const MODALITIES = ['chat', 'image', 'video']

export default function KlyvaronTiers({ providers, owner = false, onChanged }) {
  const [view, setView] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState({})
  const connections = providers?.connections ?? []

  const load = () => {
    api.klyvaron().then(setView).catch((e) => setError(e.message))
  }
  useEffect(() => { load() }, [])

  const eligible = (modality) => connections.filter((connection) => {
    if (modality === 'chat') return !connection.modality && connection.configured
    return connection.modality === modality && connection.configured
  })

  const patch = (tier, modality, change) => {
    setDraft((current) => ({
      ...current,
      [tier]: {
        ...(current[tier] ?? {}),
        [modality]: { ...(current[tier]?.[modality] ?? {}), ...change },
      },
    }))
  }

  const act = async (action) => {
    setBusy(true); setError(null)
    try {
      const next = await action()
      setView(next); await onChanged?.()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  if (error && !view) return <p className="small" role="status">Klyvaron tiers: {error}</p>
  // Before the read resolves there is nothing true to say about a tier, so the panel says that
  // rather than rendering an empty shell that looks configured.
  if (!view) return <p className="small" role="status">Klyvaron product tiers — not loaded yet.</p>

  return <details className="klyvaron-tiers" style={{ marginTop: 20 }} open>
    <summary>Klyvaron product tiers</summary>
    <p className="small">
      {view.note} Each row names the provider and model that will serve it; a tier with no
      preset refuses the request rather than picking a model on your behalf.
    </p>
    {error ? <p className="small" role="alert">{error}</p> : null}
    {view.tiers.map((tier) => <section key={tier.id} style={{ marginTop: 12 }}>
      <h3>{tier.label}</h3>
      <p className="small">{tier.intent}</p>
      {MODALITIES.map((modality) => {
        const preset = tier.presets[modality]
        const draftKey = draft[tier.id]?.[modality] ?? {}
        const options = eligible(modality)
        const presetStillOffered = options.some((option) => option.id === preset.connectionId)
        const connectionId = draftKey.connectionId ?? (presetStillOffered ? preset.connectionId : options[0]?.id ?? '')
        const connection = connections.find((entry) => entry.id === connectionId) ?? null
        const models = connection?.models ?? []
        // A draft model only survives while its connection is the selected one; otherwise the
        // select shows that connection's first listed model, which is what Save will send.
        const model = draftKey.model || (preset.connectionId === connectionId ? preset.model : '') || models[0] || ''
        return <div className="klyvaron-row small" key={modality} style={{ marginTop: 8 }}>
          <strong>{modality}</strong>{' '}
          {preset.configured
            ? <span>{preset.provider} · {preset.model}
                {preset.provenance?.statement ? <span className="small"> — {preset.provenance.statement}</span> : null}
              </span>
            : <span>not configured</span>}
          {owner ? <Form
            tier={tier.id} modality={modality} options={options} connectionId={connectionId} model={model}
            models={models} busy={busy} configured={preset.configured}
            onConnection={(id) => patch(tier.id, modality, { connectionId: id, model: '' })}
            onModel={(id) => patch(tier.id, modality, { model: id })}
            onSave={(body) => act(() => api.setKlyvaronPreset(tier.id, { modality, ...body }))}
            onClear={() => act(() => api.clearKlyvaronPreset(tier.id, modality))}
          /> : null}
        </div>
      })}
    </section>)}
  </details>
}

function Form({ tier, modality, options, connectionId, model, models, busy, configured, onConnection, onModel, onSave, onClear }) {
  if (!options.length) {
    return <span className="small"> Add and test a saved {modality} connection above first.</span>
  }
  return <form onSubmit={(event) => { event.preventDefault(); onSave({ connectionId, model }) }} style={{ marginTop: 4 }}>
    <select className="select" aria-label={`${tier} ${modality} connection`} value={connectionId} disabled={busy} onChange={(e) => onConnection(e.target.value)}>
      {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>{' '}
    <select className="select" aria-label={`${tier} ${modality} model`} value={model} disabled={busy || !models.length} onChange={(e) => onModel(e.target.value)}>
      {models.length
        ? models.map((id) => <option key={id} value={id}>{id}</option>)
        : <option value="">no models listed — test the connection</option>}
    </select>{' '}
    <Button type="submit" busy={busy} disabled={!connectionId || !model}>Save preset</Button>{' '}
    {configured ? <Button variant="danger" type="button" disabled={busy} onClick={onClear}>Clear</Button> : null}
  </form>
}
