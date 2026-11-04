import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Button } from './ui.jsx'

// Klyvaron Lite / Pro / Max are model-independent deterministic processing profiles.
// Optional BYOK provider presets and legacy local model artifacts remain separate integrations;
// neither is required by the built-in processor.

const MODALITIES = ['chat', 'image', 'video']

export default function KlyvaronTiers({ providers, owner = false, onChanged }) {
  const [view, setView] = useState(null)
  const [workerPlan, setWorkerPlan] = useState(null)
  const [workerPreset, setWorkerPreset] = useState('pro')
  const [workerMode, setWorkerMode] = useState('foundation_training')
  const [corpusDir, setCorpusDir] = useState('/tmp/klyvaron-corpus')
  const [consentCompute, setConsentCompute] = useState(false)
  const [consentStorage, setConsentStorage] = useState(false)
  const [consentLicense, setConsentLicense] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState({})
  const connections = providers?.connections ?? []

  const load = () => {
    api.klyvaron().then(setView).catch((e) => setError(e.message))
  }
  useEffect(() => { load() }, [])

  const readyFirstPartyChat = (view?.firstPartyModels?.models ?? []).filter((m) => m.status === 'ready' && m.selectorEnabled)
  const mmModelsMap = view?.firstPartyMultimodal?.models ?? {}

  const eligible = (modality) => {
    const ext = connections.filter((connection) => {
      if (modality === 'chat') return !connection.modality && connection.configured
      return connection.modality === modality && connection.configured
    })
    const readyNativeForMod = modality === 'chat'
      ? readyFirstPartyChat.map((m) => m.id)
      : Object.values(mmModelsMap).filter((m) => m.modality === modality && m.verified).map((m) => m.id)
    const nativeConn = readyNativeForMod.length
      ? [{ id: 'klyvaron-native', label: 'Klyvaron Native (first-party)', configured: true, models: readyNativeForMod }]
      : []
    return [...nativeConn, ...ext]
  }

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
  if (!view) return <p className="small" role="status">Klyvaron product tiers — not loaded yet.</p>

  const firstPartyList = view.firstPartyModels?.models ?? []
  const assistantReleasePlan = Object.values(view.modelReleaseRegistry ?? {})
    .filter((entry) => entry.ownership === 'first_party_fine_tuned_assistant')
  const workerJobs = view.trainingWorker?.jobs ?? []

  return <details className="klyvaron-tiers" style={{ marginTop: 20 }} open>
    <summary>Klyvaron capability tiers</summary>
    <p className="small">
      {view.note} The built-in processor runs locally with deterministic rules and account-local retrieval. Lite, Pro and Max change bounded context and workflow limits; they are not separate AI models. Provider presets below are optional external integrations and are not required for Klyvaron processing.
    </p>
    {error ? <p className="small" role="alert">{error}</p> : null}
    {view.modelIndependentProcessor?.profiles ? <section className="klyvaron-processing-profiles" style={{ marginTop: 12 }}>
      <h3>Built-in deterministic processing profiles</h3>
      <ul className="small">{Object.values(view.modelIndependentProcessor.profiles).map((profile) => <li key={profile.id}>
        <strong>{profile.label}</strong> — up to {profile.contextChars.toLocaleString()} input characters, {profile.maxTasks} tasks, {profile.retrievalTopK} retrieval results, {profile.parallelTasks} parallel slots. These are resource limits, not reasoning-quality claims.
      </li>)}</ul>
    </section> : null}
    {view.tiers.map((tier) => <section key={tier.id} style={{ marginTop: 12 }}>
      <h3>{tier.label}</h3>
      <p className="small">{tier.intent}</p>
      {MODALITIES.map((modality) => {
        const preset = tier.presets[modality]
        const draftKey = draft[tier.id]?.[modality] ?? {}
        const options = eligible(modality)
        const presetStillOffered = options.some((option) => option.id === preset.connectionId)
        const connectionId = draftKey.connectionId ?? (presetStillOffered ? preset.connectionId : options[0]?.id ?? '')
        const connection = options.find((entry) => entry.id === connectionId) ?? null
        const models = connection?.models ?? []
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

    {firstPartyList.length ? <section className="first-party-klyvaron" style={{ marginTop: 16 }}>
      <h3>Optional legacy model artifacts (not required by the processor)</h3>
      <ul className="small">
        {firstPartyList.map((entry) => <li key={entry.id}>
          <strong>{entry.label}</strong> ({entry.id} · {entry.expectedParameters.toLocaleString('en-US')} params):{' '}
          <span>{entry.status}</span>
          {entry.weightsSha256 ? <span> · SHA-256 {entry.weightsSha256.slice(0, 16)}…</span> : null}
          {entry.verification ? <span> · {entry.verification.tokensPerSecond} tok/s</span> : null}
          {entry.error ? <span> · {entry.error.message}</span> : null}
        </li>)}
      </ul>
      {owner ? <span className="row" style={{ gap: 8 }}>
        <Button type="button" busy={busy} onClick={async () => {
          setBusy(true); setError(null)
          try { await api.verifyKlyvaronModels(); load(); await onChanged?.() } catch (e) { setError(e.message) } finally { setBusy(false) }
        }}>Re-verify first-party weights</Button>
        <Button type="button" busy={busy} onClick={async () => {
          setBusy(true); setError(null)
          try { await api.runKlyvaronQualification({}); load(); await onChanged?.() } catch (e) { setError(e.message) } finally { setBusy(false) }
        }}>Qualify CPU &amp; accelerator runtimes</Button>
      </span> : null}
      {view.capabilityManifests ? (
        <div className="capability-manifests small" style={{ marginTop: 10 }}>
          <h4>Derived Capability Manifests (Pro vs Max — separate from subscription plan)</h4>
          {(['pro', 'max']).map((tk) => {
            const mf = view.capabilityManifests[tk]
            if (!mf) return null
            return (
              <div key={tk} style={{ marginTop: 6 }}>
                <strong>Klyvaron {tk.toUpperCase()} Manifest</strong> — overall readiness: <code>{mf.overallReadinessStatus}</code>
                <ul>
                  {Object.entries(mf.modalities ?? {}).map(([mod, mInfo]) => (
                    <li key={mod}>
                      <strong>{mod}</strong>: <code>{mInfo.modelId}</code> ({mInfo.architecture}) — readiness: <code>{mInfo.readinessStatus}</code>
                      {mInfo.parameterCount ? ` · ${mInfo.parameterCount.toLocaleString('en-US')} params` : ''}
                      {mInfo.artifactSha256 ? ` · sha256 ${mInfo.artifactSha256.slice(0, 12)}…` : ''}
                      {mInfo.backendQualification ? ` · backends: cpu=${mInfo.backendQualification.cpu}, cuda=${mInfo.backendQualification.cuda}, rocm=${mInfo.backendQualification.rocm}, metal=${mInfo.backendQualification.metal}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      ) : null}
    </section> : null}

    {assistantReleasePlan.length ? <section className="model-release-plan" style={{ marginTop: 16 }} aria-label="Klyvaron assistant release plan">
      <h3>Legacy trained-model release records (not required for model-independent Klyvaron)</h3>
      <p className="small">
        These are separate model lifecycle records. The built-in Klyvaron processor does not require a foundation model, training run, weights or model release. Keep any legacy model claims behind their independent evidence gates.
      </p>
      <ul className="small">
        {assistantReleasePlan.map((entry) => <li key={entry.id}>
          <strong>{entry.displayName}</strong> ({entry.id} · v{entry.version}) — release status: <code>{entry.status}</code> ·
          {' '}sizing: {entry.targetParameterClass} · foundation: {entry.foundationModel?.id ?? 'not selected'} ·
          {' '}available: {entry.available ? 'yes' : 'no'}.
        </li>)}
      </ul>
    </section> : null}

    {owner ? <section className="training-worker-setup" style={{ marginTop: 16 }}>
      <h3>Optional legacy model research (not required by Klyvaron processing)</h3>
      <p className="small">
        The built-in Lite/Pro/Max processor requires no model training. This separate research worker is opt-in and remains subject to its own hardware, consent, dataset licensing, time and release gates.
      </p>
      <div className="row small" style={{ gap: 8, marginTop: 6 }}>
        <select aria-label="Training preset" className="select" value={workerPreset} disabled={busy} onChange={(e) => { setWorkerPreset(e.target.value); setWorkerPlan(null) }}>
          <option value="pro">klyvaron-pro-lm (27.6M)</option>
          <option value="max">klyvaron-max-lm (92.1M)</option>
        </select>
        <select aria-label="Training session mode" className="select" value={workerMode} disabled={busy} onChange={(e) => { setWorkerMode(e.target.value); setWorkerPlan(null) }}>
          <option value="foundation_training">Foundation training (operator-budgeted)</option>
          <option value="interactive_adaptation">Interactive adaptation (120s ceiling)</option>
        </select>
        <input aria-label="Training corpus path" className="input" value={corpusDir} disabled={busy} onChange={(e) => { setCorpusDir(e.target.value); setWorkerPlan(null) }} />
        <Button type="button" busy={busy} onClick={async () => {
          setBusy(true); setError(null)
          try {
            const plan = await api.planTrainingWorker({ preset: workerPreset, mode: workerMode, corpusDir })
            setWorkerPlan(plan)
            setConsentCompute(false); setConsentStorage(false); setConsentLicense(false)
          } catch (e) { setError(e.message) } finally { setBusy(false) }
        }}>Inspect host & prepare setup plan</Button>
      </div>
      {workerPlan ? <div className="small" style={{ marginTop: 8 }}>
        <p>
          Plan digest {workerPlan.disclosureDigest.slice(0, 16)}… · {workerPlan.plan.disclosures.compute.estimatedWallSeconds}s est. ·{' '}
          {workerPlan.plan.disclosures.energyAndThermal.estimatedEnergyWattHours} Wh ·{' '}
          Eligible: {workerPlan.blockers.length === 0 ? 'yes' : `no (${workerPlan.blockers.join('; ')})`}
        </p>
        <label className="checkbox"><input type="checkbox" checked={consentCompute} onChange={(e) => setConsentCompute(e.target.checked)} />Acknowledge compute & energy budget</label>
        <label className="checkbox"><input type="checkbox" checked={consentStorage} onChange={(e) => setConsentStorage(e.target.checked)} />Acknowledge checkpoint & artifact disk usage</label>
        <label className="checkbox"><input type="checkbox" checked={consentLicense} onChange={(e) => setConsentLicense(e.target.checked)} />Acknowledge permissive corpus license policy ({workerPlan.plan.disclosures.dataAndLicensing.approvedSpdxLicences.join(', ')})</label>
        <Button type="button" variant="primary" busy={busy} disabled={workerPlan.blockers.length > 0 || !consentCompute || !consentStorage || !consentLicense} onClick={async () => {
          setBusy(true); setError(null)
          try {
            await api.startTrainingWorker({
              plan: { preset: workerPreset, mode: workerMode, corpusDir },
              consent: {
                confirmed: true,
                disclosureDigest: workerPlan.disclosureDigest,
              },
            })
            load()
          } catch (e) { setError(e.message) } finally { setBusy(false) }
        }}>Authorize & start training worker</Button>
      </div> : null}
      {workerJobs.length ? <ul className="small" style={{ marginTop: 8 }}>
        {workerJobs.map((job) => <li key={job.id}>
          {job.artifactId} ({job.mode}) — <strong>{job.state}</strong> (step {job.progress?.step ?? 0}/{job.progress?.totalSteps ?? 0})
          {job.state === 'running' ? <Button type="button" variant="danger" disabled={busy} onClick={async () => {
            setBusy(true); try { await api.cancelTrainingWorker(job.id); load() } catch (e) { setError(e.message) } finally { setBusy(false) }
          }}>Cancel & checkpoint</Button> : null}
          {job.checkpointVerified && job.state !== 'running' && workerPlan ? <Button type="button" disabled={busy} onClick={async () => {
            setBusy(true)
            try {
              await api.resumeTrainingWorker(job.id, {
                plan: { preset: job.preset, mode: job.mode, corpusDir },
                consent: {
                  confirmed: true,
                  disclosureDigest: workerPlan.disclosureDigest,
                },
              })
              load()
            } catch (e) { setError(e.message) } finally { setBusy(false) }
          }}>Resume from checkpoint</Button> : null}
        </li>)}
      </ul> : null}
    </section> : null}
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
