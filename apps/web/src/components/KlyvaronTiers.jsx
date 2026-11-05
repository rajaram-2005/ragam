import React, { useEffect, useState } from 'react'
import { api } from '../api.js'

// Lite, Pro and Max are capability/resource profiles of the same deterministic engine.
// They do not select, download, train, or require model weights.
export default function KlyvaronTiers() {
  const [view, setView] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let active = true
    api.klyvaron()
      .then((result) => { if (active) setView(result) })
      .catch((cause) => { if (active) setError(cause.message) })
    return () => { active = false }
  }, [])

  if (error && !view) return <p className="small" role="status">Klyvaron profiles: {error}</p>
  if (!view) return <p className="small" role="status">Klyvaron capability profiles — loading.</p>

  const profiles = view.modelIndependentProcessor?.profiles ?? {}
  return <details className="klyvaron-tiers" style={{ marginTop: 20 }} open>
    <summary>Klyvaron capability profiles</summary>
    <p className="small">
      {view.note} All tiers use the same model-independent processing engine. They change bounded
      context, processing depth, authorized-memory retrieval, orchestration and resource budgets;
      none requires a separate model, weights, download or training run.
    </p>
    {error ? <p className="small" role="alert">{error}</p> : null}
    <p className="small">
      Engine: <code>{view.modelIndependentProcessor?.engine ?? 'klyvaron-deterministic-v1'}</code> ·
      {' '}model used: no · weights used: no · network used: no.
    </p>
    <div className="table-wrap">
      <table className="small" aria-label="Klyvaron tier capability profiles">
        <thead><tr>
          <th scope="col">Tier</th><th scope="col">Context capacity</th>
          <th scope="col">Processing depth</th><th scope="col">Memory budget</th>
          <th scope="col">Task orchestration</th><th scope="col">Resource class</th>
        </tr></thead>
        <tbody>{['lite', 'pro', 'max'].map((id) => {
          const profile = profiles[id]
          if (!profile) return null
          const depth = profile.processingDepth ?? profile.maxTasks
          return <tr key={id}>
            <th scope="row">{profile.label ?? id}</th>
            <td>{Number(profile.contextChars).toLocaleString()} characters</td>
            <td>up to {depth} named deterministic task(s)</td>
            <td>up to {profile.maxMemoryItems} items / {Number(profile.maxMemoryChars).toLocaleString()} characters</td>
            <td>{profile.parallelTasks} parallel task slot(s)</td>
            <td>{profile.resourceClass}</td>
          </tr>
        })}</tbody>
      </table>
    </div>
    <p className="small">
      These limits control resource use, not reasoning quality. Processing is deterministic
      extraction, ranking, retrieval and arithmetic; summaries are extractive, and answers return
      cited local evidence rather than open-ended model reasoning. User information is added to knowledge or persistent memory only through the corresponding explicit save/remember action.
      Image, audio and video generation or understanding are not claimed by this text processor.
    </p>
  </details>
}
