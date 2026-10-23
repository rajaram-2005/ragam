import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Banner, Button, Field, Panel } from './ui.jsx'

const MODE_LABELS = Object.freeze([
  ['', 'Auto-select from request & worker resources'],
  ['context_only', 'Context-only adaptation (no weight updates)'],
  ['memory_or_retrieval', 'Authorized memory / retrieval update (preferred for single corrections)'],
  ['lightweight_adapter', 'Lightweight LoRA adapter (max 120s including finalization)'],
  ['full_fine_tune', 'Full-model checkpoint fine-tuning'],
  ['foundation_pretrain', 'Foundation-model pretraining (separate session, not 120s-capped)'],
])

export default function UserTrainingPanel({ readiness, refreshReadiness, initialStatus = null, initialPlan = null, initialJob = null }) {
  const [status, setStatus] = useState(initialStatus)
  const [pairingOffer, setPairingOffer] = useState(null)
  const [workerOrigin, setWorkerOrigin] = useState('')
  const [pairingSecret, setPairingSecret] = useState('')
  const [modelId, setModelId] = useState('klyvaron-pro-lm')
  const [requestedMode, setRequestedMode] = useState('')
  const [intendedBehavior, setIntendedBehavior] = useState('')
  const [exampleInput, setExampleInput] = useState('')
  const [exampleTarget, setExampleTarget] = useState('')
  const [maxSteps, setMaxSteps] = useState('4')
  const [plan, setPlan] = useState(initialPlan)
  const [approveDowngrade, setApproveDowngrade] = useState(false)
  const [confirmConsent, setConfirmConsent] = useState(false)
  const [activeJob, setActiveJob] = useState(initialJob)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const reload = async () => {
    try {
      const next = await api.trainingWorker()
      setStatus(next)
    } catch {
      // Unauthenticated or initial render keeps clean empty state.
    }
  }

  useEffect(() => { reload() }, [readiness?.models?.ready])

  const connected = Boolean(status?.localWorkerConnected)
  const caps = status?.worker?.capabilities ?? null
  const gatesByModel = status?.releaseGates ?? {}

  const requestPair = async () => {
    setBusy(true); setError(null)
    try {
      const offer = await api.requestWorkerPairing('User Local Computer')
      setPairingOffer(offer)
      setPairingSecret(offer.pairingSecret)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  const completePair = async () => {
    setBusy(true); setError(null)
    try {
      const next = await api.completeWorkerPairing({
        pairingId: pairingOffer?.pairingId ?? null,
        pairingSecret: pairingSecret.trim(),
        workerEndpoint: workerOrigin.trim(),
      })
      setStatus(next)
      setPairingOffer(null)
      await refreshReadiness?.()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  const disconnect = async () => {
    setBusy(true); setError(null)
    try {
      const next = await api.disconnectWorker()
      setStatus(next)
      await refreshReadiness?.()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  const evaluate = async () => {
    setBusy(true); setError(null); setConfirmConsent(false)
    try {
      const examples = exampleInput.trim() && exampleTarget.trim()
        ? [{ input: exampleInput.trim(), target: exampleTarget.trim() }]
        : []
      const evaluated = await api.evaluateTrainingRequest({
        modelId,
        requestedMode: requestedMode || null,
        intendedBehavior: intendedBehavior.trim(),
        examples,
        dataAuthorization: { authorized: true, origin: 'user_ui_input' },
        stoppingCriteria: { maxSteps: Number(maxSteps) || 4 },
        modeChangeApproval: approveDowngrade && requestedMode
          ? { fromMode: requestedMode, toMode: 'lightweight_adapter', approved: true }
          : null,
        allowSingleExampleAdapter: requestedMode === 'lightweight_adapter',
      })
      setPlan(evaluated)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  const execute = async () => {
    if (!plan || !confirmConsent) return
    setBusy(true); setError(null)
    try {
      const examples = exampleInput.trim() && exampleTarget.trim()
        ? [{ input: exampleInput.trim(), target: exampleTarget.trim() }]
        : []
      const started = await api.executeTrainingRequest({
        request: {
          modelId,
          requestedMode: requestedMode || null,
          intendedBehavior: intendedBehavior.trim(),
          examples,
          dataAuthorization: { authorized: true, origin: 'user_ui_input' },
          stoppingCriteria: { maxSteps: Number(maxSteps) || 4 },
          modeChangeApproval: approveDowngrade && requestedMode
            ? { fromMode: requestedMode, toMode: 'lightweight_adapter', approved: true }
            : null,
          allowSingleExampleAdapter: requestedMode === 'lightweight_adapter',
        },
        consent: { confirmed: true, disclosureDigest: plan.disclosureDigest },
      })
      setActiveJob(started)
      await reload()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Panel title="User-computer local worker & explicit learning">
      <p className="small">
        {connected
          ? `Connected to authenticated local worker ${status.worker.workerId} (${caps?.platform}/${caps?.arch}, ${caps?.cpu?.logicalCores} CPU cores, ${Math.round((caps?.memory?.availableRamBytes ?? 0) / 1e6)} MB available RAM, GPU: ${caps?.gpu?.available ? 'yes' : 'none'}).`
          : 'No local worker is paired. Your computer is not connected, and RAGAM never runs neural weight training silently from ordinary chat messages or on an unauthenticated host.'}
      </p>

      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        {!connected ? (
          <>
            <Button disabled={busy} onClick={requestPair}>Generate pairing code</Button>
            <Field label="Local worker loopback origin">
              <input className="input" value={workerOrigin} onChange={(e) => setWorkerOrigin(e.target.value)} placeholder="Loopback worker origin" />
            </Field>
            <Field label="Pairing secret">
              <input className="input" value={pairingSecret} onChange={(e) => setPairingSecret(e.target.value)} placeholder="Single-use pairing secret" />
            </Field>
            <Button variant="primary" disabled={busy || !workerOrigin.trim() || !pairingSecret.trim()} onClick={completePair}>Pair worker</Button>
          </>
        ) : (
          <Button disabled={busy} onClick={disconnect}>Disconnect local worker</Button>
        )}
      </div>

      {pairingOffer ? (
        <pre className="small" style={{ overflowX: 'auto' }}>{pairingOffer.launchCommands.linuxOrMac}</pre>
      ) : null}

      <div className="row" style={{ gap: 8 }}>
        <Field label="Target Klyvaron model">
          <select aria-label="Target Klyvaron model" className="select" value={modelId} onChange={(e) => setModelId(e.target.value)}>
            <option value="klyvaron-pro-lm">Klyvaron Pro Chat (klyvaron-pro-lm · 27.6M)</option>
            <option value="klyvaron-max-lm">Klyvaron Max Chat (klyvaron-max-lm · 92.1M)</option>
            <option value="klyvaron-pro-image">Klyvaron Pro Image (klyvaron-pro-image)</option>
            <option value="klyvaron-max-image">Klyvaron Max Image (klyvaron-max-image)</option>
            <option value="klyvaron-pro-video">Klyvaron Pro Video (klyvaron-pro-video)</option>
            <option value="klyvaron-max-video">Klyvaron Max Video (klyvaron-max-video)</option>
            <option value="klyvaron-pro-voice">Klyvaron Pro Voice (klyvaron-pro-voice)</option>
            <option value="klyvaron-max-voice">Klyvaron Max Voice (klyvaron-max-voice)</option>
          </select>
        </Field>
        <Field label="Training / adaptation mode">
          <select aria-label="Training or adaptation mode" className="select" value={requestedMode} onChange={(e) => setRequestedMode(e.target.value)}>
            {MODE_LABELS.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
          </select>
        </Field>
        <Field label="Max optimizer steps">
          <input className="input" type="number" min="1" max="100000" value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)} />
        </Field>
      </div>

      <Field label="Intended behavior to improve">
        <input className="input" value={intendedBehavior} onChange={(e) => setIntendedBehavior(e.target.value)} placeholder="Describe the concrete behavior change to validate…" />
      </Field>
      <div className="row" style={{ gap: 8 }}>
        <Field label="Authorized input prompt">
          <textarea className="textarea" rows={2} value={exampleInput} onChange={(e) => setExampleInput(e.target.value)} placeholder="Explicit user-authorized prompt…" />
        </Field>
        <Field label="Authorized target completion">
          <textarea className="textarea" rows={2} value={exampleTarget} onChange={(e) => setExampleTarget(e.target.value)} placeholder="Verified target completion…" />
        </Field>
      </div>

      {plan ? (
        <div style={{ marginTop: 8 }}>
          <p className="small">
            Selected mode: <strong>{plan.spec.selectedMode}</strong> · Backend: <strong>{plan.spec.resourceEstimate?.selectedBackend ?? 'pending'}</strong> ·
            Required RAM: {Math.round((plan.spec.resourceEstimate?.requiredRamBytes ?? plan.spec.resourceEstimate?.estimatedRamBytes ?? 0) / 1e6)} MB ·
            Stopping ceiling: {plan.spec.stoppingCriteria?.maxDurationMs ? `${Math.round(plan.spec.stoppingCriteria.maxDurationMs / 1000)}s` : 'uncapped (foundation session)'} ·
            Dataset SHA-256: {(plan.spec.dataProvenance?.datasetSha256 ?? 'pending').slice(0, 12)}…
          </p>
          {plan.spec.modeDowngradeProposal && !plan.spec.modeDowngradeProposal.approvedByUser ? (
            <label className="checkbox">
              <input type="checkbox" checked={approveDowngrade} onChange={(e) => setApproveDowngrade(e.target.checked)} />
              Approve switching from {plan.spec.modeDowngradeProposal.requestedMode} to {plan.spec.modeDowngradeProposal.proposedMode} ({plan.spec.modeDowngradeProposal.differenceExplanation})
            </label>
          ) : null}
          {plan.blockers.length ? <Banner tone="bad" title={plan.blockers.join(' ')} /> : (
            <label className="checkbox">
              <input type="checkbox" checked={confirmConsent} onChange={(e) => setConfirmConsent(e.target.checked)} />
              {plan.consentStatement}
            </label>
          )}
        </div>
      ) : null}

      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <Button disabled={busy} onClick={evaluate}>Inspect resources & plan</Button>
        <Button variant="primary" disabled={busy || !plan?.readyToExecute || !confirmConsent} onClick={execute}>Execute authorized job</Button>
        {activeJob?.jobId ? (
          <>
            <Button disabled={busy} onClick={async () => { const synced = await api.workerJob(activeJob.jobId); setActiveJob(synced); await refreshReadiness?.() }}>Refresh progress</Button>
            <Button variant="danger" disabled={busy} onClick={async () => { const c = await api.cancelWorkerJob(activeJob.jobId); setActiveJob(c) }}>Cancel job</Button>
            <Button disabled={busy} onClick={async () => { const rb = await api.rollbackWorkerJob(activeJob.jobId); setActiveJob((old) => ({ ...old, state: rb.jobState })); await refreshReadiness?.() }}>Roll back weights</Button>
          </>
        ) : null}
      </div>

      {activeJob ? (
        <p className="small" style={{ marginTop: 8 }}>
          Job {activeJob.jobId} · state: <strong>{activeJob.state}</strong>
          {activeJob.workerJob?.progress ? ` · step ${activeJob.workerJob.progress.step}/${activeJob.workerJob.progress.totalSteps}` : ''}
        </p>
      ) : null}

      {Object.keys(gatesByModel).length ? (
        <details style={{ marginTop: 8 }}>
          <summary className="small">Klyvaron Pro & Max release gate matrix (9 separate checks)</summary>
          {Object.values(gatesByModel).map((entry) => (
            <p className="small" key={entry.modelId}>
              <strong>{entry.modelId}</strong>: {Object.entries(entry.gates).map(([k, v]) => `${k}=${v ? 'yes' : 'no'}`).join(' · ')}
            </p>
          ))}
        </details>
      ) : null}

      {error ? <Banner tone="bad" title={error.message} /> : null}
    </Panel>
  )
}
