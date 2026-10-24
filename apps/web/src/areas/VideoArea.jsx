import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Banner, Button, CopyButton, EmptyState, ErrorNote, Field, Panel, Progress, Stat, Stats } from '../components/ui.jsx'

// The Video area is a job surface, not a placeholder.
//
// A video is a long-running provider operation: the POST returns a record, the area polls it, and
// the bytes are served by the Core after it has checked the container. A failed or cancelled job
// never becomes a <video>; there is no sample clip and no simulated output.

const ASPECT_RATIOS = ['16:9', '9:16']
const RESOLUTIONS = ['720p', '1080p']
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out'])

const bytesOf = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}
const seconds = (value) => (Number.isFinite(value) ? `${value.toFixed(1)} s` : 'not measured')
const when = (value) => {
  const time = Number(value)
  return Number.isFinite(time) && time > 0 ? new Date(time).toLocaleString() : '—'
}

export default function VideoArea({ provider, readiness, refreshReadiness, onSettings }) {
  const [jobs, setJobs] = useState([])
  const [prompt, setPrompt] = useState('')
  const [aspectRatio, setAspectRatio] = useState(ASPECT_RATIOS[0])
  const [resolution, setResolution] = useState(RESOLUTIONS[0])
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState('')

  // Same rule as the Image area: the server names the connection a request will use and the
  // controls that wire documents. An empty list means the adapter has no such input, so the
  // field is not rendered and no guessed value is sent.
  const [videoAnalysisByJob, setVideoAnalysisByJob] = useState({})

  const connection = useMemo(() => {
    const mediaVideo = readiness?.media?.video
    const preferred = mediaVideo?.connectionId
    if (preferred === 'klyvaron-native' && mediaVideo?.models?.length) {
      return {
        id: 'klyvaron-native',
        label: 'Klyvaron Native (first-party short-clip H.264 MP4)',
        firstParty: true,
        configured: true,
        models: mediaVideo.models,
        aspectRatios: mediaVideo.aspectRatios ?? ['16:9', '9:16', '1:1'],
        resolutions: mediaVideo.resolutions ?? ['480p', '720p'],
      }
    }
    const candidates = provider?.connections ?? []
    return candidates.find((entry) => entry.id === preferred)
      ?? candidates.find((entry) => entry.modality === 'video' && entry.configured)
      ?? null
  }, [provider, readiness])
  const models = connection?.models ?? []
  const aspectOptions = connection?.aspectRatios ?? []
  const resolutionOptions = connection?.resolutions ?? []

  useEffect(() => {
    if (models.length && !models.includes(model)) setModel(models[0])
    if (!models.length && model) setModel('')
  }, [models, model])

  useEffect(() => {
    if (aspectOptions.length && !aspectOptions.includes(aspectRatio)) setAspectRatio(aspectOptions[0])
  }, [aspectOptions, aspectRatio])

  useEffect(() => {
    if (resolutionOptions.length && !resolutionOptions.includes(resolution)) setResolution(resolutionOptions[0])
  }, [resolutionOptions, resolution])

  useEffect(() => {
    let alive = true
    const load = async () => {
      try { const data = await api.videoJobs(); if (alive) setJobs(data.jobs ?? []) } catch (e) { if (alive) setError(e) }
    }
    load()
    return () => { alive = false }
  }, [])

  // A video renders for minutes. Poll while any visible job is live, then stop: a finished clip
  // is not re-requested in the background.
  const pending = jobs.some((job) => !TERMINAL.has(job.state))
  useEffect(() => {
    if (!pending) return
    let alive = true
    const id = setInterval(async () => {
      try { const data = await api.videoJobs(); if (alive) setJobs(data.jobs ?? []) } catch { /* the next tick retries */ }
    }, 2000)
    return () => { alive = false; clearInterval(id) }
  }, [pending])

  const generate = async (event) => {
    event.preventDefault()
    if (!connection || !model || !prompt.trim()) return
    setBusy(true); setError(null); setNotice('')
    try {
      const job = await api.generateVideo({ prompt, aspectRatio, resolution, model })
      setJobs((current) => [job, ...current.filter((entry) => entry.id !== job.id)])
      setPrompt('')
      setNotice('Generation queued. A provider renders this for minutes; the clip appears here only when its bytes pass validation.')
    } catch (e) { setError(e) } finally { setBusy(false) }
  }

  const cancel = async (id) => {
    setError(null)
    try {
      await api.cancelVideoJob(id)
      const job = await api.videoJob(id)
      setJobs((current) => current.map((entry) => (entry.id === id ? job : entry)))
      setNotice('Cancellation requested. A running provider request is aborted; no partial clip is shown.')
    } catch (e) { setError(e) }
  }

  const remove = async (id) => {
    setError(null)
    try {
      await api.deleteVideoJob(id)
      setJobs((current) => current.filter((job) => job.id !== id))
      setNotice('Video and its job record deleted.')
      await refreshReadiness?.()
    } catch (e) { setError(e) }
  }

  const succeeded = jobs.filter((job) => job.state === 'succeeded')
  const failed = jobs.filter((job) => ['failed', 'cancelled', 'timed_out'].includes(job.state))

  return <Panel title="Online video generation" actions={<Button onClick={onSettings}>Provider Settings</Button>}>
    {!connection
      ? <Banner tone="warn" title="No video provider is configured">
          <p>Add a video-capable connection in Provider Settings (Google Veo, Runway, Luma, fal.ai video or Replicate video) and test it. A chat or image connection is not reused for video: a model name in another list does not prove video generation.</p>
          <p>No simulated output or local fallback is ever shown here.</p>
        </Banner>
      : null}
    {connection && !models.length
      ? <Banner tone="warn" title="This video connection has no models yet">
          <p>Use <strong>Test connection</strong> in Provider Settings to read the video-model list. A generation without a listed model is refused rather than guessed.</p>
        </Banner>
      : null}

    {connection && models.length
      ? <form onSubmit={generate}>
          <Field label="Video prompt" hint="Sent only to the configured video provider. This product caps prompts at 4,000 characters.">
            <textarea className="textarea" value={prompt} maxLength={4000} rows={3} required placeholder="Describe the shot, motion and camera…" onChange={(e) => setPrompt(e.target.value)} disabled={busy} />
          </Field>
          <div className="row">
            <Field label="Model" hint={connection.label}>
              <select className="select" value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
                {models.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </Field>
            {aspectOptions.length
              ? <Field label="Aspect ratio" hint="What the provider is asked for; the artifact records what arrived.">
                  <select className="select" value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)} disabled={busy}>
                    {aspectOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </Field>
              : null}
            {resolutionOptions.length
              ? <Field label="Resolution" hint="The resolutions this adapter documents for the selected provider.">
                  <select className="select" value={resolution} onChange={(e) => setResolution(e.target.value)} disabled={busy}>
                    {resolutionOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </Field>
              : null}
            <Button type="submit" variant="primary" busy={busy} disabled={busy || !prompt.trim() || !model}>Generate video</Button>
          </div>
        </form>
      : null}

    {error ? <ErrorNote error={error} /> : null}
    {notice ? <Banner tone="ok" title="Queued"><p>{notice}</p></Banner> : null}

    {jobs.length ? <Stats>
      <Stat label="Videos stored" value={succeeded.length} note="Validated containers only" />
      <Stat label="Failed or cancelled" value={failed.length} note="No substitute output" />
      <Stat label="Jobs shown" value={jobs.length} note="Newest first" />
    </Stats> : null}

    {jobs.length ? (
      <div className="video-jobs">
        {jobs.map((job) => <article className="video-job panel" key={job.id} data-state={job.state}>
          <div className="row between">
            <strong>{job.state === 'succeeded' ? 'Generated video' : `Job ${job.state}`}</strong>
            <small>{when(job.createdAt)}</small>
          </div>
          <p className="small"><strong>Prompt:</strong> {job.params?.prompt}</p>
          <p className="small">
            {job.params?.provider} · {job.result?.model ?? job.params?.model}
            {job.result?.durationSeconds != null ? ` · ${seconds(job.result.durationSeconds)}` : ''}
            {job.result?.aspectRatio ? ` · ${job.result.aspectRatio}` : ''}
            {job.result?.resolution ? ` · ${job.result.resolution}` : ''}
            {job.artifact ? ` · ${job.artifact.format?.toUpperCase()} · ${bytesOf(job.artifact.byteLength)} · sha256 ${job.artifact.sha256?.slice(0, 12)}…` : ''}
          </p>
          {job.state === 'succeeded' && job.artifact
            ? <div className="video-player-wrapper">
                <video controls playsInline preload="metadata" src={api.videoArtifactUrl(job.id)}>
                  Your browser cannot play this video. <a href={api.videoArtifactUrl(job.id)}>Download it</a>.
                </video>
              </div>
            : null}
          {job.state === 'failed' || job.state === 'cancelled' || job.state === 'timed_out'
            ? <Banner tone={job.state === 'cancelled' ? 'warn' : 'bad'} title="No video was produced"><p>{job.error ?? 'The job ended without an artifact.'}</p></Banner>
            : null}
          {!TERMINAL.has(job.state)
            ? <div className="job-progress">
                <div className="job-progress-header">
                  <span className="small">Provider rendering… {job.stage ?? job.state}</span>
                  <span className="small">{job.progress ?? 0}%</span>
                </div>
                <Progress value={(job.progress ?? 0) / 100} />
                <p className="small muted">The clip is not shown until its bytes pass validation.</p>
              </div>
            : null}
          {videoAnalysisByJob[job.id]
            ? <p className="small"><strong>Video temporal analysis ({videoAnalysisByJob[job.id].modelId}):</strong> {videoAnalysisByJob[job.id].description ?? videoAnalysisByJob[job.id].summary}{videoAnalysisByJob[job.id].motion ? ` · motion: ${videoAnalysisByJob[job.id].motion} (${(Number(videoAnalysisByJob[job.id].motionConfidence ?? 0) * 100).toFixed(1)}%) · env: ${videoAnalysisByJob[job.id].environment}` : ''}</p>
            : null}
          <div className="row">
            {job.state === 'succeeded' && job.artifact && readiness?.capabilities?.videoUnderstanding ? (
              <Button disabled={busy} onClick={async () => {
                setBusy(true); setError(null)
                try {
                  const res = await api.understandVideo({
                    model: model.startsWith('klyvaron-') ? model : undefined,
                    sourceJobId: job.id,
                  })
                  setVideoAnalysisByJob((prev) => ({ ...prev, [job.id]: res }))
                } catch (e) { setError(e) } finally { setBusy(false) }
              }}>Understand video</Button>
            ) : null}
            {job.artifact ? <a className="button" href={api.videoArtifactUrl(job.id)} download={`video-${job.id.slice(0, 8)}.${job.artifact.format === 'mp4' ? 'mp4' : job.artifact.format}`}>Download</a> : null}
            {job.artifact ? <CopyButton text={JSON.stringify(job, null, 2)} label="Copy JSON" className="ghost small" /> : null}
            {!TERMINAL.has(job.state) ? <Button onClick={() => cancel(job.id)}>Cancel</Button> : null}
            <Button variant="danger" onClick={() => remove(job.id)}>Delete video and record</Button>
          </div>
        </article>)}
      </div>
    ) : (
      <EmptyState title="No video jobs yet">Generate a clip to create the first job. A job that fails stays visible with its reason and never becomes a video element.</EmptyState>
    )}
  </Panel>
}
