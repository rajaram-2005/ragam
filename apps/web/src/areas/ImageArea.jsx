import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { Banner, Button, Chip, ErrorNote, Field, Kv, Panel, Stats, Stat } from '../components/ui.jsx'
import { JobDetail, JobTable } from '../components/Jobs.jsx'

// ---------------------------------------------------------------------------
// Image.
//
// Internal services surfaced here: the media job queue (progress, cancellation,
// retry-after, state history) and output validation (magic-byte sniffing, so a
// JSON error page from a provider can never be shown as a generated image).
//
// No image provider is configured in this build: no local runtime and no online
// gateway, so the expected outcome of a generate call is an audited refusal. That
// refusal is displayed with its code and the router's explanation instead of a
// stock image.
// ---------------------------------------------------------------------------

const SIZES = ['', '512x512', '768x768', '1024x1024', '1280x720']

export default function ImageArea({ readiness, refreshReadiness }) {
  const [jobs, setJobs] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [prompt, setPrompt] = useState('')
  const [count, setCount] = useState('1')
  const [size, setSize] = useState('')
  const [principal, setPrincipal] = useState('')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [created, setCreated] = useState(null)

  const available = Boolean(readiness?.capabilities?.imageGeneration)

  const load = useCallback(async () => {
    try {
      const payload = await api.imageJobs(25)
      setJobs(payload.jobs ?? [])
      setError(null)
    } catch (caught) {
      setError(caught)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Poll while something is in flight; stop polling once every job is terminal so
  // the interface is not chattering at an idle backend.
  useEffect(() => {
    const inFlight = jobs.some((job) => !job.terminal)
    if (!inFlight) return undefined
    const timer = setInterval(load, 2500)
    return () => clearInterval(timer)
  }, [jobs, load])

  const generate = async (event) => {
    event?.preventDefault()
    if (!prompt.trim()) return
    setBusy('generate')
    setError(null)
    setCreated(null)
    try {
      const job = await api.generateImage({
        prompt: prompt.trim(),
        n: Math.max(1, Number(count) || 1),
        size: size || null,
        principal: principal.trim() || null,
      })
      setCreated(job)
      setSelectedId(job.id ?? null)
      setPrompt('')
      await load()
    } catch (caught) {
      // A refusal is a normal, audited outcome — show it as information, and keep
      // the prompt so the operator can adjust the policy or authorisation.
      setError(caught)
    } finally {
      setBusy(null)
      refreshReadiness?.()
    }
  }

  const cancel = async (jobId) => {
    setBusy(jobId)
    try {
      await api.cancelMediaJob(jobId)
      await load()
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
    }
  }

  const selected = jobs.find((job) => job.id === selectedId) ?? null

  return (
    <div className="split">
      <div className="grid" style={{ gap: 16 }}>
        <Panel
          eyebrow="PRODUCT AREA"
          title="Generate an image"
          actions={<Chip tone={available ? 'ok' : 'bad'}>{available ? 'image capability ready' : 'no image provider'}</Chip>}
          footer="Output is validated by magic bytes before it is stored; a provider error page is rejected, not displayed."
        >
          <form onSubmit={generate}>
            <Field label="Prompt" hint="Truncated to 500 characters server-side.">
              <textarea className="textarea" value={prompt} placeholder="Describe the image…" onChange={(event) => setPrompt(event.target.value)} />
            </Field>
            <div className="grid cols-3" style={{ gap: 11 }}>
              <Field label="Count">
                <input className="input" type="number" min="1" max="4" value={count} onChange={(event) => setCount(event.target.value)} />
              </Field>
              <Field label="Size">
                <select className="select" value={size} onChange={(event) => setSize(event.target.value)}>
                  {SIZES.map((entry) => (
                    <option key={entry || 'auto'} value={entry}>{entry || 'provider default'}</option>
                  ))}
                </select>
              </Field>
              <Field label="Principal">
                <input className="input" value={principal} placeholder="who is asking" onChange={(event) => setPrincipal(event.target.value)} />
              </Field>
            </div>

            <div className="row end" style={{ marginTop: 13 }}>
              <Button type="submit" variant="primary" busy={busy === 'generate'} disabled={!prompt.trim()}>
                Generate
              </Button>
            </div>
          </form>
        </Panel>

        {error ? <ErrorNote error={error} title="Image request refused or failed" /> : null}

        {created && !error ? (
          <Banner tone="info" title={`Job ${String(created.id ?? '').slice(0, 8)} accepted`}>
            <span className="small">
              Queued as {created.kind ?? 'image'} · state {created.state ?? 'queued'}. The artifact appears only after validation passes.
            </span>
          </Banner>
        ) : null}

        {!available ? (
          <Banner tone="warn" title="No image-capable provider is available on this host">
            <span className="small">
              Neither a local image runtime nor an online provider is configured in this build. Submitting a prompt produces an audited refusal
              with the router’s explanation — it does not produce a stock image and it does not silently send the prompt anywhere.
            </span>
          </Banner>
        ) : null}

        <Panel eyebrow="QUEUE" title="Recent image jobs" actions={<Button busy={busy === 'load'} onClick={load}>Refresh</Button>} tight>
          <JobTable
            jobs={jobs}
            onSelect={setSelectedId}
            empty="No image jobs yet. A refused request is recorded in the audit ledger, not in this queue."
          />
        </Panel>
      </div>

      <div className="grid" style={{ gap: 16 }}>
        <Panel eyebrow="INSPECTION" title="Job detail">
          <JobDetail job={selected} kind="image" onCancel={cancel} busy={busy} />
        </Panel>

        <Panel eyebrow="INTERNAL SERVICE" title="Media pipeline state">
          <div className="grid" style={{ gap: 12 }}>
            <Stats>
              <Stat label="jobs" value={jobs.length} />
              <Stat label="succeeded" value={jobs.filter((job) => job.state === 'succeeded').length} />
              <Stat label="failed" value={jobs.filter((job) => job.state === 'failed').length} />
              <Stat label="in flight" value={jobs.filter((job) => !job.terminal).length} />
            </Stats>
            <Kv
              entries={{
                capability: readiness?.capabilities?.imageGeneration ? 'ready' : 'unavailable',
                policy: readiness?.policy,
                'egress blocked': readiness?.offlineEnforced,
                'media dir': readiness?.config?.media?.directory ?? '(server-side, not exposed)',
              }}
            />
            <span className="small muted">
              Artifacts are written to the server’s media directory and served through /api/media/artifact/:id. Absolute paths are never sent to
              the browser.
            </span>
          </div>
        </Panel>
      </div>
    </div>
  )
}
