import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { Banner, Button, Chip, ErrorNote, Field, Kv, Panel, Stat, Stats } from '../components/ui.jsx'
import { JobDetail, JobTable } from '../components/Jobs.jsx'

// ---------------------------------------------------------------------------
// Video.
//
// Two things make this area different from Image, and both come from verified
// facts rather than assumption:
//
//  1. The upstream gateway supports video on only two platforms (pollinations,
//     huggingface) while it supports eight for images, and its own key table marks
//     video as unsupported on custom endpoints. Chat support therefore does NOT
//     imply video support, and the UI says so.
//  2. Video responses come back as a raw binary MP4, not JSON — so cancellation
//     means aborting the request, and validation has to sniff the container rather
//     than read a field.
//
// A still image is never shown as a generated video: the backend rejects it, and
// MediaPreview refuses to embed anything whose sniffed kind is not video.
// ---------------------------------------------------------------------------

const RATIOS = ['', '16:9', '9:16', '1:1', '4:3']
const DURATIONS = ['', '3', '5', '8', '10']

export default function VideoArea({ readiness, refreshReadiness }) {
  const [jobs, setJobs] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [prompt, setPrompt] = useState('')
  const [duration, setDuration] = useState('')
  const [aspectRatio, setAspectRatio] = useState('')
  const [seed, setSeed] = useState('')
  const [audio, setAudio] = useState(false)
  const [principal, setPrincipal] = useState('')
  const [authorize, setAuthorize] = useState(false)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [created, setCreated] = useState(null)

  const available = Boolean(readiness?.capabilities?.videoGeneration)
  const gpu = Boolean(readiness?.hardware?.gpuDetected)

  const load = useCallback(async () => {
    try {
      const payload = await api.videoJobs(25)
      setJobs(payload.jobs ?? [])
      setError(null)
    } catch (caught) {
      setError(caught)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!jobs.some((job) => !job.terminal)) return undefined
    const timer = setInterval(load, 3000)
    return () => clearInterval(timer)
  }, [jobs, load])

  const generate = async (event) => {
    event?.preventDefault()
    if (!prompt.trim()) return
    setBusy('generate')
    setError(null)
    setCreated(null)
    try {
      const job = await api.generateVideo({
        prompt: prompt.trim(),
        duration: duration ? Number(duration) : null,
        aspectRatio: aspectRatio || null,
        seed: seed.trim() ? Number(seed) : null,
        audio: audio || null,
        principal: principal.trim() || null,
        externalAuthorization: authorize ? { granted: true, reason: 'operator authorised this video request from the interface' } : null,
      })
      setCreated(job)
      setSelectedId(job.id ?? null)
      setPrompt('')
      await load()
    } catch (caught) {
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
  const succeeded = jobs.filter((job) => job.state === 'succeeded')

  return (
    <div className="split">
      <div className="grid" style={{ gap: 16 }}>
        <Panel
          eyebrow="PRODUCT AREA"
          title="Generate a video"
          actions={<Chip tone={available ? 'ok' : 'bad'}>{available ? 'video capability ready' : 'no video provider'}</Chip>}
          footer="Validated by container sniffing plus a genuineness check: wrong kind, or a payload too small to be a real clip, is rejected."
        >
          <form onSubmit={generate}>
            <Field label="Prompt" hint="Text-to-video. Image-to-video requires an image the backend can already reach.">
              <textarea className="textarea" value={prompt} placeholder="Describe the motion, subject and camera…" onChange={(event) => setPrompt(event.target.value)} />
            </Field>
            <div className="grid cols-3" style={{ gap: 11 }}>
              <Field label="Duration (s)">
                <select className="select" value={duration} onChange={(event) => setDuration(event.target.value)}>
                  {DURATIONS.map((entry) => (
                    <option key={entry || 'auto'} value={entry}>{entry || 'provider default'}</option>
                  ))}
                </select>
              </Field>
              <Field label="Aspect ratio">
                <select className="select" value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>
                  {RATIOS.map((entry) => (
                    <option key={entry || 'auto'} value={entry}>{entry || 'provider default'}</option>
                  ))}
                </select>
              </Field>
              <Field label="Seed">
                <input className="input" type="number" value={seed} placeholder="optional" onChange={(event) => setSeed(event.target.value)} />
              </Field>
            </div>
            <Field label="Principal">
              <input className="input" value={principal} placeholder="who is asking" onChange={(event) => setPrincipal(event.target.value)} />
            </Field>

            <div className="row between" style={{ marginTop: 4 }}>
              <label className="checkbox">
                <input type="checkbox" checked={audio} onChange={(event) => setAudio(event.target.checked)} />
                Request audio track
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={authorize} onChange={(event) => setAuthorize(event.target.checked)} />
                Authorise an approved online provider
              </label>
            </div>

            <div className="row end" style={{ marginTop: 13 }}>
              <Button type="submit" variant="primary" busy={busy === 'generate'} disabled={!prompt.trim()}>
                Generate video
              </Button>
            </div>
          </form>
        </Panel>

        <Banner tone={available ? 'info' : 'warn'} title="What this host can and cannot do for video">
          <ul>
            <li>
              Local video generation is <strong>{gpu ? 'potentially feasible (GPU detected)' : 'not feasible here'}</strong>:{' '}
              {readiness?.hardware?.cpuCount ?? '?'} CPU cores, {readiness?.hardware?.ramGb ?? '?'} GB RAM,{' '}
              {gpu ? 'GPU present' : 'no GPU'}. No local video runtime is installed, and none is claimed.
            </li>
            <li>
              The optional online gateway supports video on a narrower set of platforms than it supports images, and marks video unsupported on
              custom endpoints. Chat working does not mean video works.
            </li>
            <li>
              When no video-capable provider is reachable, the request is refused and recorded. The interface does <strong>not</strong> offer a
              still image as a substitute, and does not quietly route the prompt online.
            </li>
          </ul>
        </Banner>

        {error ? <ErrorNote error={error} title="Video request refused or failed" /> : null}

        {created && !error ? (
          <Banner tone="info" title={`Job ${String(created.id ?? '').slice(0, 8)} accepted`}>
            <span className="small">
              Queued as {created.kind ?? 'video'} · state {created.state ?? 'queued'}. Video responses arrive as a raw binary container, so
              cancellation aborts the request rather than polling a status field.
            </span>
          </Banner>
        ) : null}

        <Panel eyebrow="QUEUE" title="Recent video jobs" actions={<Button onClick={load}>Refresh</Button>} tight>
          <JobTable
            jobs={jobs}
            onSelect={setSelectedId}
            empty="No video jobs yet."
          />
        </Panel>
      </div>

      <div className="grid" style={{ gap: 16 }}>
        <Panel eyebrow="INSPECTION" title="Job detail">
          <JobDetail job={selected} kind="video" onCancel={cancel} busy={busy} />
        </Panel>

        <Panel eyebrow="INTERNAL SERVICE" title="Provenance and validation">
          <div className="grid" style={{ gap: 12 }}>
            <Stats>
              <Stat label="jobs" value={jobs.length} />
              <Stat label="genuine videos" value={succeeded.length} note="passed container + genuineness checks" />
              <Stat label="rejected" value={jobs.filter((job) => job.state === 'failed').length} note="invalid or not really video" />
              <Stat label="capability" value={available ? 'ready' : 'none'} small />
            </Stats>
            <Kv
              entries={{
                policy: readiness?.policy,
                'egress blocked': readiness?.offlineEnforced,
                gpu: gpu ? 'detected' : 'not detected',
                'video capability': available ? 'ready' : 'unavailable',
              }}
            />
            <span className="small muted">
              Every accepted artifact is stored with a sha256, a sniffed format and a byte length. Those three values are what make the claim
              “this is a generated video” checkable rather than asserted.
            </span>
          </div>
        </Panel>
      </div>
    </div>
  )
}
