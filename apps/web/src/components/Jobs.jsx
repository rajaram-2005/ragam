import React from 'react'
import { Banner, Button, Chip, Code, EmptyState, Progress, Table, formatValue } from './ui.jsx'
import { api } from '../api.js'

// ---------------------------------------------------------------------------
// Media job rendering, shared by the Image and Video areas.
//
// The honesty rule lives here: an artifact is only put in front of the user when
// the backend's own validation passed AND, for video, the genuineness check
// accepted it. A failed job shows the rejection reasons verbatim — including the
// "received a still image, not a video" case — rather than a placeholder frame.
// ---------------------------------------------------------------------------

function jobTone(job) {
  switch (job?.state) {
    case 'succeeded': return 'ok'
    case 'failed': return 'bad'
    case 'cancelled':
    case 'timed_out': return 'warn'
    case 'running':
    case 'queued':
    case 'pending': return 'info'
    default: return undefined
  }
}

export function MediaPreview({ job, kind }) {
  if (!job) return null

  if (job.state !== 'succeeded' || !job.artifact) {
    return (
      <div className="media-frame">
        <div className="media-placeholder">
          <strong>no artifact</strong>
          <span>
            {job.state === 'failed'
              ? 'This job failed validation and produced nothing to display.'
              : `Job is ${job.state}. Nothing is rendered until the artifact exists and passes validation.`}
          </span>
          {job.error ? <span className="error-text small">{job.error}</span> : null}
        </div>
      </div>
    )
  }

  const validation = job.validation ?? {}
  // A video job whose validation sniffed an image kind was already rejected by the
  // backend; this second check stops the UI from ever embedding a still as video.
  const mismatch = kind === 'video' && validation.kind && validation.kind !== 'video'

  if (mismatch) {
    return (
      <div className="media-frame">
        <div className="media-placeholder">
          <strong>not a genuine video</strong>
          <span>
            The stored bytes are {validation.format ?? 'unknown'}, not a video container. It is not presented as generated video.
          </span>
        </div>
      </div>
    )
  }

  const url = api.artifactUrl(job.id)
  return (
    <div className="media-frame">
      {kind === 'video' ? (
        <video src={url} controls playsInline preload="metadata" />
      ) : (
        <img src={url} alt={job.params?.prompt ? String(job.params.prompt).slice(0, 120) : 'generated image'} />
      )}
    </div>
  )
}

function ValidationPanel({ job }) {
  const validation = job?.validation
  if (!validation) {
    return <span className="muted small">No validation record — the job produced no bytes to inspect.</span>
  }
  return (
    <div className="grid" style={{ gap: 10 }}>
      <div className="row">
        <Chip tone={validation.valid ? 'ok' : 'bad'}>{validation.valid ? 'validation passed' : 'validation failed'}</Chip>
        {validation.format ? <Chip dot={false}>{validation.format}</Chip> : null}
        {validation.mime ? <Chip tone="info" dot={false}>{validation.mime}</Chip> : null}
        {typeof validation.byteLength === 'number' ? <Chip dot={false}>{(validation.byteLength / 1024).toFixed(1)} KB</Chip> : null}
        <Chip tone={validation.contentTypeMatches ? 'ok' : 'warn'} dot={false}>
          content-type {validation.contentTypeMatches ? 'matches' : 'mismatch'}
        </Chip>
      </div>
      {validation.reasons?.length ? <Banner tone="bad" title="Rejection reasons" items={validation.reasons} /> : null}
    </div>
  )
}

export function JobDetail({ job, kind, onCancel, busy }) {
  if (!job) return <EmptyState title="Select a job">Pick a job from the list to see its validation record and artifact.</EmptyState>
  return (
    <div className="grid" style={{ gap: 13 }}>
      <div className="row">
        <Chip tone={jobTone(job)}>{job.state}</Chip>
        <Chip dot={false}>{job.id.slice(0, 8)}</Chip>
        {job.stage ? <Chip tone="info" dot={false}>{job.stage}</Chip> : null}
        {!job.terminal ? <Button busy={busy === job.id} onClick={() => onCancel(job.id)}>Cancel</Button> : null}
      </div>

      {!job.terminal ? <Progress value={(job.progress ?? 0) / 100} /> : null}

      <MediaPreview job={job} kind={kind} />

      <ValidationPanel job={job} />

      {job.error ? (
        <Banner tone="bad" title="Job error">
          <span className="small">{job.error}</span>
          {job.errorCode ? <Chip tone="bad" dot={false}>{job.errorCode}</Chip> : null}
          {job.retryAfterMs ? <span className="small">retry after {job.retryAfterMs} ms</span> : null}
        </Banner>
      ) : null}

      {job.artifact ? (
        <div className="grid" style={{ gap: 6 }}>
          <span className="panel-eyebrow">STORED ARTIFACT</span>
          <Chip tone="ok" dot={false}>sha256 {String(job.artifact.sha256 ?? '').slice(0, 24)}…</Chip>
          <div className="small muted">
            {formatValue(job.artifact.format)} · {formatValue(job.artifact.mime)} · {formatValue(job.artifact.byteLength)} bytes
          </div>
        </div>
      ) : null}

      {job.history?.length ? <Code label="STATE HISTORY" value={job.history.map((entry) => `${entry.state ?? entry.stage ?? '?'}${entry.at ? ` @ ${new Date(entry.at).toISOString()}` : ''}`)} /> : null}
    </div>
  )
}

export function JobTable({ jobs, onSelect, selectedId, empty }) {
  return (
    <Table
      columns={[
        { key: 'state', label: 'State', render: (job) => <Chip tone={jobTone(job)}>{job.state}</Chip> },
        { key: 'prompt', label: 'Prompt', render: (job) => <span className="small">{String(job.params?.prompt ?? '—').slice(0, 60)}</span> },
        { key: 'validation', label: 'Validation', render: (job) => (job.validation ? <Chip tone={job.validation.valid ? 'ok' : 'bad'} dot={false}>{job.validation.format ?? 'checked'}</Chip> : <span className="muted small">none</span>) },
        { key: 'size', label: 'Bytes', render: (job) => formatValue(job.artifact?.byteLength ?? job.validation?.byteLength) },
        { key: 'open', label: '', render: (job) => <Button onClick={() => onSelect(job.id)}>Inspect</Button> },
      ]}
      rows={(jobs ?? []).map((job) => ({ ...job, key: job.id }))}
      empty={empty}
    />
  )
}
