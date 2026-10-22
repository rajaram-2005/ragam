import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Banner, Button, EmptyState, ErrorNote, Field, Panel, Stat, Stats } from '../components/ui.jsx'

// The Image area is a real provider surface, not a placeholder.
//
// It can only render an `<img>` for a job whose artifact the Core validated and stored; a queued,
// failed or deleted job has no image element at all. The prompt that produced each image, the
// provider and model that answered, and the measured dimensions/digest are shown beside it, because
// an image with no provenance is indistinguishable from a stock picture.

const DEFAULT_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto']
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out'])

const bytesOf = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}
const when = (value) => {
  const time = Number(value)
  return Number.isFinite(time) && time > 0 ? new Date(time).toLocaleString() : '—'
}

export default function ImageArea({ provider, readiness, refreshReadiness, onSettings }) {
  const [jobs, setJobs] = useState([])
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState('auto')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState('')

  // The server publishes which configured connection an image request will use, and what
  // controls that wire documents. Reading both from the readiness record means this area
  // cannot disagree with the route: an adapter that offers no size control simply gets no
  // size field, rather than sending a value the provider never defined.
  const connection = useMemo(() => {
    const preferred = readiness?.media?.image?.connectionId
    const candidates = provider?.connections ?? []
    return candidates.find((entry) => entry.id === preferred)
      ?? candidates.find((entry) => entry.modality === 'image' && entry.configured)
      ?? null
  }, [provider, readiness])
  const models = connection?.models ?? []
  const SIZES = connection?.sizes?.length ? connection.sizes : (connection ? [] : DEFAULT_SIZES)

  useEffect(() => {
    if (models.length && !models.includes(model)) setModel(models[0])
    if (!models.length && model) setModel('')
  }, [models, model])

  useEffect(() => {
    if (!SIZES.length) return
    if (!SIZES.includes(size)) setSize(SIZES.includes('auto') ? 'auto' : SIZES[0])
  }, [SIZES, size])

  useEffect(() => {
    let alive = true
    const load = async () => {
      try { const data = await api.imageJobs(); if (alive) setJobs(data.jobs ?? []) } catch (e) { if (alive) setError(e) }
    }
    load()
    return () => { alive = false }
  }, [])

  // A job is a server record, not a client promise. Poll until every visible job is terminal, then
  // stop: a succeeded image is not re-requested in the background.
  const pending = jobs.some((job) => !TERMINAL.has(job.state))
  useEffect(() => {
    if (!pending) return
    let alive = true
    const id = setInterval(async () => {
      try { const data = await api.imageJobs(); if (alive) setJobs(data.jobs ?? []) } catch { /* the next tick retries */ }
    }, 1000)
    return () => { alive = false; clearInterval(id) }
  }, [pending])

  const generate = async (event) => {
    event.preventDefault()
    if (!connection || !model || !prompt.trim()) return
    setBusy(true); setError(null); setNotice('')
    try {
      const job = await api.generateImage({ prompt, size: SIZES.length ? size : undefined, model })
      setJobs((current) => [job, ...current.filter((entry) => entry.id !== job.id)])
      setPrompt('')
      setNotice('Generation queued. The image appears here when the provider returns bytes this build can validate.')
    } catch (e) { setError(e) } finally { setBusy(false) }
  }

  const remove = async (id) => {
    setError(null)
    try {
      await api.deleteImageJob(id)
      setJobs((current) => current.filter((job) => job.id !== id))
      setNotice('Image and its job record deleted.')
      await refreshReadiness?.()
    } catch (e) { setError(e) }
  }

  const succeeded = jobs.filter((job) => job.state === 'succeeded')
  const failed = jobs.filter((job) => job.state === 'failed' || job.state === 'cancelled' || job.state === 'timed_out')

  return <Panel title="Online image generation" actions={<Button onClick={onSettings}>Provider Settings</Button>}>
    {!connection
      ? <Banner tone="warn" title="No image provider is configured">
          <p>Add an image-capable connection in Provider Settings (OpenAI Images, Gemini Images, Stability AI, Recraft, Ideogram, FLUX, fal.ai, Replicate or Adobe Firefly) and test it. A chat connection is not reused as an image provider: a model name in a chat list does not prove image generation.</p>
          <p>No simulated output or local fallback is ever shown here.</p>
        </Banner>
      : null}
    {connection && !models.length
      ? <Banner tone="warn" title="This image connection has no models yet">
          <p>Use <strong>Test connection</strong> in Provider Settings to read the image-model list. A generation without a listed model is refused rather than guessed.</p>
        </Banner>
      : null}

    {connection && models.length
      ? <form onSubmit={generate}>
          <Field label="Image prompt" hint="Sent only to the configured image provider. This product caps prompts at 4,000 characters.">
            <textarea className="textarea" value={prompt} maxLength={4000} rows={3} required placeholder="Describe the image to generate…" onChange={(e) => setPrompt(e.target.value)} disabled={busy} />
          </Field>
          <div className="row">
            <Field label="Model" hint={connection.label}>
              <select className="select" value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
                {models.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </Field>
            {SIZES.length
              ? <Field label="Size" hint="Requested dimensions; the stored artifact records what was actually returned.">
                  <select className="select" value={size} onChange={(e) => setSize(e.target.value)} disabled={busy}>
                    {SIZES.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </Field>
              : null}
            <Button type="submit" variant="primary" busy={busy} disabled={busy || !prompt.trim() || !model}>Generate image</Button>
          </div>
        </form>
      : null}

    {error ? <ErrorNote error={error} /> : null}
    {notice ? <Banner tone="good" title="Queued"><p>{notice}</p></Banner> : null}

    {jobs.length ? <Stats>
      <Stat label="Images stored" value={succeeded.length} note="Validated containers only" />
      <Stat label="Failed jobs" value={failed.length} note="No substitute output" />
      <Stat label="Jobs shown" value={jobs.length} note="Newest first" />
    </Stats> : null}

    {!jobs.length
      ? <EmptyState title="No image jobs yet">Generate an image to create the first job. A job that fails stays visible with its reason and never becomes a picture.</EmptyState>
      : <div className="image-jobs">
          {jobs.map((job) => <article className="image-job panel" key={job.id} data-state={job.state}>
            <div className="row between">
              <strong>{job.state === 'succeeded' ? 'Generated image' : `Job ${job.state}`}</strong>
              <small>{when(job.createdAt)}</small>
            </div>
            <p className="small"><strong>Prompt:</strong> {job.params?.prompt}</p>
            <p className="small">
              {job.params?.provider} · {job.result?.model ?? job.params?.model}
              {job.artifact ? ` · ${job.artifact.format?.toUpperCase()} · ${bytesOf(job.artifact.byteLength)} · sha256 ${job.artifact.sha256?.slice(0, 12)}…` : ''}
            </p>
            {job.state === 'succeeded' && job.artifact
              ? <img className="generated-image" loading="lazy" src={api.imageArtifactUrl(job.id)} alt={job.result?.revisedPrompt ?? job.params?.prompt ?? 'Generated image'} />
              : null}
            {job.state === 'failed' || job.state === 'cancelled' || job.state === 'timed_out'
              ? <Banner tone="bad" title="No image was produced"><p>{job.error ?? 'The job ended without an artifact.'}</p></Banner>
              : null}
            {!TERMINAL.has(job.state)
              ? <p className="small">Waiting for the provider… {job.stage ?? job.state}. The image is not shown until its bytes pass validation.</p>
              : null}
            <div className="row">
              {job.artifact ? <a className="button" href={api.imageArtifactUrl(job.id)} download={`image-${job.id.slice(0, 8)}.${job.artifact.format === 'jpeg' ? 'jpg' : job.artifact.format}`}>Download</a> : null}
              <Button variant="danger" onClick={() => remove(job.id)}>Delete image and record</Button>
            </div>
          </article>)}
        </div>}
  </Panel>
}
