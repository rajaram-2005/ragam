import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, streamChat } from '../api.js'
import {
  Banner, Button, Checks, Chip, Code, EmptyState, ErrorNote, Field, FixtureTag,
  Kv, Lifecycle, Panel, Stat, Stats, Table, formatValue,
} from '../components/ui.jsx'

// ---------------------------------------------------------------------------
// Chat.
//
// Three internal services are surfaced here rather than as sections of their own:
//   - the Model Router (which candidate was chosen, and why the others were not)
//   - the private knowledge pipeline (ingest, search, cited grounding)
//   - God Core orchestration (the eight-phase task lifecycle, pause/resume/cancel)
// ---------------------------------------------------------------------------

const DATA_CLASSES = ['public', 'internal', 'confidential', 'restricted']

function Message({ message }) {
  const meta = message.meta ?? {}
  return (
    <article className="message" data-role={message.role}>
      <header className="message-head">
        <span className="message-role">{message.role}</span>
        {meta.modelId ? <Chip tone="violet" dot={false}>{meta.modelId}</Chip> : null}
        {meta.sentExternally === true ? <Chip tone="bad">left the machine</Chip> : null}
        {meta.sentExternally === false ? <Chip tone="ok">stayed local</Chip> : null}
        {meta.classification ? <Chip tone={meta.classification === 'public' ? 'info' : 'warn'} dot={false}>{meta.classification}</Chip> : null}
        {typeof meta.durationMs === 'number' ? <Chip dot={false}>{meta.durationMs} ms</Chip> : null}
        {meta.redacted ? <Chip tone="warn">redacted {meta.redacted}</Chip> : null}
        {meta.streaming ? <Chip tone="info">streamed</Chip> : null}
        {meta.error ? <Chip tone="bad">{meta.error.code ?? 'error'}</Chip> : null}
      </header>

      <div className="message-body">{message.text || (meta.streaming ? '…' : '(empty)')}</div>

      {meta.error ? (
        <Banner tone={meta.error.unavailable ? 'warn' : 'bad'} title={meta.error.message}>
          <span className="small">
            code {meta.error.code ?? 'error'}
            {meta.error.status ? ` · HTTP ${meta.error.status}` : ''}
            {meta.error.route?.explanation ? ` · ${meta.error.route.explanation}` : ''}
          </span>
          {meta.error.limitation ? <span className="small">Limitation: {meta.error.limitation}</span> : null}
          {Array.isArray(meta.error.route?.rejected) && meta.error.route.rejected.length > 0 ? (
            <ul>
              {meta.error.route.rejected.map((entry, index) => (
                <li key={index} className="small">
                  {formatValue(entry)}
                </li>
              ))}
            </ul>
          ) : null}
        </Banner>
      ) : null}

      {meta.citations?.length ? (
        <div className="citations">
          {meta.citations.map((citation) => (
            <div className="citation" key={citation.ref ?? citation.chunkId ?? Math.random()}>
              <div className="citation-head">
                {citation.ref ? <span className="citation-ref">{citation.ref}</span> : null}
                <span className="citation-title">{citation.title ?? 'untitled'}</span>
                {citation.chunkIndex !== undefined ? <span className="citation-meta">chunk {citation.chunkIndex}</span> : null}
                {citation.classification ? <span className="citation-meta">{citation.classification}</span> : null}
              </div>
              {citation.text ? <p className="citation-snippet">{citation.text}</p> : null}
              <span className="citation-meta">
                {citation.sha256 ? `sha256 ${String(citation.sha256).slice(0, 16)}…` : ''}
                {citation.sourcePath ? ` · ${citation.sourcePath}` : ''}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {meta.grounding && !meta.grounding.hasEvidence ? (
        <Banner tone="warn" title="No indexed evidence matched">
          <span className="small">
            The answer was produced without company sources. The retrieval method was {meta.grounding.method ?? 'unknown'}.
          </span>
        </Banner>
      ) : null}

      {meta.toolCalls?.length ? (
        <div className="grid" style={{ gap: 6 }}>
          <span className="panel-eyebrow">TOOL CALLS REQUESTED BY THE MODEL</span>
          <Code value={meta.toolCalls} />
        </div>
      ) : null}
    </article>
  )
}

function Composer({ models, busy, onSend, canChat }) {
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [temperature, setTemperature] = useState('0.2')
  const [maxTokens, setMaxTokens] = useState('512')
  const [useKnowledge, setUseKnowledge] = useState(false)
  const [stream, setStream] = useState(true)
  const [dataClass, setDataClass] = useState('')
  const inputRef = useRef(null)

  const submit = (event) => {
    event?.preventDefault()
    if (!prompt.trim() || busy) return
    onSend({
      prompt: prompt.trim(),
      model: model || null,
      temperature: Number(temperature),
      maxTokens: Number(maxTokens),
      useKnowledge,
      stream,
      dataClass: dataClass || null,
    })
    setPrompt('')
  }

  return (
    <form onSubmit={submit}>
      <Field label="Message" hint={canChat ? 'Ctrl/⌘ + Enter sends' : 'No model is ready — sending will return no_model_available, which is the honest result.'}>
        <textarea
          ref={inputRef}
          className="textarea"
          value={prompt}
          placeholder="Ask about an indexed document, or request a task…"
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit(event)
          }}
        />
      </Field>

      <div className="grid cols-3" style={{ gap: 11 }}>
        <Field label="Model preference">
          <select className="select" value={model} onChange={(event) => setModel(event.target.value)}>
            <option value="">router decides</option>
            {models.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.displayName ?? entry.id}
                {entry.availability ? ` (${entry.availability})` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Temperature">
          <input className="input" type="number" step="0.1" min="0" max="2" value={temperature} onChange={(event) => setTemperature(event.target.value)} />
        </Field>
        <Field label="Max tokens">
          <input className="input" type="number" step="64" min="16" max="32768" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} />
        </Field>
      </div>

      <Field label="Data classification" hint="Declaring confidential or restricted requires explicit authorisation before anything may leave the machine.">
        <select className="select" value={dataClass} onChange={(event) => setDataClass(event.target.value)}>
          <option value="">classify automatically</option>
          {DATA_CLASSES.map((entry) => (
            <option key={entry} value={entry}>{entry}</option>
          ))}
        </select>
      </Field>

      <div className="row between" style={{ marginTop: 4 }}>
        <div className="row">
          <label className="checkbox">
            <input type="checkbox" checked={useKnowledge} onChange={(event) => setUseKnowledge(event.target.checked)} />
            Ground in company knowledge
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={stream} onChange={(event) => setStream(event.target.checked)} />
            Stream
          </label>
        </div>
        <Button type="submit" variant="primary" busy={busy} disabled={!prompt.trim()}>
          Send
        </Button>
      </div>
    </form>
  )
}

function KnowledgePanel() {
  const [stats, setStats] = useState(null)
  const [documents, setDocuments] = useState([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [classification, setClassification] = useState('internal')
  const [owner, setOwner] = useState('')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const load = useCallback(async () => {
    setBusy('loading')
    try {
      const [statPayload, documentPayload] = await Promise.all([api.knowledgeStats(), api.knowledgeDocuments()])
      setStats(statPayload)
      setDocuments(documentPayload.documents ?? [])
      setError(null)
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const search = async (event) => {
    event?.preventDefault()
    if (!query.trim()) return
    setBusy('search')
    setError(null)
    setNotice(null)
    try {
      setResults(await api.knowledgeSearch({ query: query.trim(), topK: 6 }))
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
    }
  }

  const ingest = async (event) => {
    event?.preventDefault()
    if (!text.trim()) return
    setBusy('ingest')
    setError(null)
    setNotice(null)
    try {
      const result = await api.knowledgeIngest({
        title: title.trim() || 'untitled document',
        text,
        classification,
        owner: owner.trim() || null,
        mime: 'text/plain',
      })
      setNotice(
        result.duplicate
          ? `Duplicate detected by content hash — nothing was stored again. Existing document ${result.documentId} (${result.reason}).`
          : `Stored ${result.documentId}: ${result.chunks} chunks indexed locally.`,
      )
      setText('')
      setTitle('')
      await load()
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
    }
  }

  const reindex = async () => {
    setBusy('reindex')
    setError(null)
    try {
      const result = await api.knowledgeReindex()
      setNotice(`Index rebuilt: ${formatValue(result)} `)
      await load()
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Panel
      eyebrow="INTERNAL SERVICE"
      title="Private company knowledge"
      actions={<Button busy={busy === 'loading' || busy === 'reindex'} onClick={reindex}>Rebuild index</Button>}
      footer="Stored locally: SQLite metadata, filesystem media, in-memory BM25 rebuilt from stored chunks. Nothing here is sent externally by indexing."
    >
      <div className="grid" style={{ gap: 14 }}>
        {error ? <ErrorNote error={error} title="Knowledge request failed" /> : null}
        {notice ? <Banner tone="ok" title="Done"><span className="small">{notice}</span></Banner> : null}

        {/* stats() is nested: {store: {...sqlite counts}, index: {...bm25 counts}} */}
        <Stats>
          <Stat label="documents" value={stats?.store?.documents ?? documents.length} />
          <Stat label="chunks" value={stats?.store?.chunks ?? '—'} />
          <Stat label="indexed bytes" value={stats?.store?.bytesIndexed ?? '—'} />
          <Stat label="unique terms" value={stats?.index?.uniqueTerms ?? '—'} />
          <Stat
            label="ranker"
            value={`bm25 k1=${stats?.index?.k1 ?? '?'} b=${stats?.index?.b ?? '?'}`}
            note="rebuilt from stored chunks at startup"
            small
          />
          <Stat label="deletions" value={stats?.store?.deletions ?? 0} note="retention record kept" />
        </Stats>

        <form onSubmit={search}>
          <Field label="Search" hint="Ranked locally; the same index that grounds chat answers.">
            <div className="row">
              <input className="input grow" value={query} placeholder="Query the index…" onChange={(event) => setQuery(event.target.value)} />
              <Button type="submit" busy={busy === 'search'} disabled={!query.trim()}>Search</Button>
            </div>
          </Field>
        </form>

        {results ? (
          <div className="grid" style={{ gap: 8 }}>
            <div className="row">
              <Chip tone={results.results?.length ? 'ok' : 'warn'}>{results.results?.length ?? 0} matches</Chip>
              <Chip dot={false}>{results.method ?? 'bm25'}</Chip>
            </div>
            {results.results?.length ? (
              <div className="citations">
                {results.results.map((entry) => (
                  <div className="citation" key={entry.chunkId}>
                    <div className="citation-head">
                      <span className="citation-title">{entry.citation?.title ?? 'untitled'}</span>
                      <Chip tone="violet" dot={false}>{entry.score?.toFixed(4)}</Chip>
                    </div>
                    <p className="citation-snippet">{entry.text}</p>
                    <span className="citation-meta">
                      {entry.matchedTerms?.length ? `matched: ${entry.matchedTerms.join(', ')} · ` : ''}
                      {entry.documentId} · chunk {entry.citation?.chunkIndex ?? '?'}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState title="No matches">The index holds no chunk matching that query. Chat answers will not cite company sources for it.</EmptyState>
            )}
          </div>
        ) : null}

        <form onSubmit={ingest}>
          <Field label="Ingest a document">
            <input className="input" value={title} placeholder="Title" onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field label="Content" hint="Parsed, deduplicated by content hash, chunked and indexed locally.">
            <textarea className="textarea" value={text} placeholder="Paste document text…" onChange={(event) => setText(event.target.value)} />
          </Field>
          <div className="grid cols-2" style={{ gap: 11 }}>
            <Field label="Classification">
              <select className="select" value={classification} onChange={(event) => setClassification(event.target.value)}>
                {DATA_CLASSES.map((entry) => (
                  <option key={entry} value={entry}>{entry}</option>
                ))}
              </select>
            </Field>
            <Field label="Owner / principal">
              <input className="input" value={owner} placeholder="e.g. engineering" onChange={(event) => setOwner(event.target.value)} />
            </Field>
          </div>
          <div className="row end">
            <Button type="submit" variant="primary" busy={busy === 'ingest'} disabled={!text.trim()}>Ingest locally</Button>
          </div>
        </form>

        {documents.length ? (
          <Table
            columns={[
              { key: 'title', label: 'Title', render: (row) => <strong>{row.title ?? '—'}</strong> },
              { key: 'id', label: 'Document', render: (row) => <span className="small">{row.id ?? '—'}</span> },
              { key: 'classification', label: 'Class', render: (row) => <Chip tone="info" dot={false}>{row.classification ?? '—'}</Chip> },
              { key: 'chunkCount', label: 'Chunks', render: (row) => formatValue(row.chunkCount) },
              { key: 'sha256', label: 'sha256', render: (row) => <span className="small">{String(row.sha256 ?? '').slice(0, 12)}…</span> },
              { key: 'owner', label: 'Owner', render: (row) => formatValue(row.owner) },
            ]}
            rows={documents.map((document) => ({ ...document, key: document.id }))}
          />
        ) : null}
      </div>
    </Panel>
  )
}

function TaskPanel() {
  const [tasks, setTasks] = useState([])
  const [selected, setSelected] = useState(null)
  const [prompt, setPrompt] = useState('')
  const [godMode, setGodMode] = useState(false)
  const [principal, setPrincipal] = useState('')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const payload = await api.tasks(25)
      setTasks(payload.tasks ?? [])
      if (selected) {
        const current = (payload.tasks ?? []).find((task) => task.id === selected)
        if (current) setSelected(current.id)
      }
    } catch (caught) {
      setError(caught)
    }
  }, [selected])

  useEffect(() => {
    load()
    const timer = setInterval(load, 4000)
    return () => clearInterval(timer)
  }, [load])

  const open = async (id) => {
    setSelected(id)
    setError(null)
    try {
      const task = await api.task(id)
      setTasks((previous) => previous.map((entry) => (entry.id === id ? task : entry)))
    } catch (caught) {
      setError(caught)
    }
  }

  const submit = async (event) => {
    event?.preventDefault()
    if (!prompt.trim()) return
    setBusy('submit')
    setError(null)
    try {
      const task = await api.createTask({
        prompt: prompt.trim(),
        godMode,
        principal: principal.trim() || null,
        run: true,
      })
      setPrompt('')
      await load()
      setSelected(task.id)
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
    }
  }

  const act = async (label, fn) => {
    setBusy(label)
    setError(null)
    try {
      const result = await fn()
      const task = result?.task ?? result
      if (task?.id) {
        setSelected(task.id)
        setTasks((previous) => previous.map((entry) => (entry.id === task.id ? task : entry)))
      }
      await load()
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
    }
  }

  const task = tasks.find((entry) => entry.id === selected) ?? null

  return (
    <Panel
      eyebrow="INTERNAL SERVICE"
      title="God Core task lifecycle"
      footer="Understand → Plan → Retrieve → Route → Execute → Observe → Verify → Synthesize. A task that could not be verified reports partial, never succeeded."
    >
      <div className="grid" style={{ gap: 14 }}>
        {error ? <ErrorNote error={error} title="Task request failed" /> : null}

        <form onSubmit={submit}>
          <Field label="Task prompt">
            <textarea className="textarea" value={prompt} placeholder="Describe a multi-phase task…" onChange={(event) => setPrompt(event.target.value)} />
          </Field>
          <div className="row between">
            <div className="row">
              <label className="checkbox">
                <input type="checkbox" checked={godMode} onChange={(event) => setGodMode(event.target.checked)} />
                God Mode (bounded)
              </label>
              <input className="input" style={{ width: 150 }} value={principal} placeholder="principal" onChange={(event) => setPrincipal(event.target.value)} />
            </div>
            <Button type="submit" variant="primary" busy={busy === 'submit'} disabled={!prompt.trim()}>Run task</Button>
          </div>
        </form>

        {godMode ? (
          <Banner tone="warn" title="God Mode is bounded, not unlimited">
            <span className="small">
              Execution stays inside the configured capability list and budget. There is no executor seam wired to this host, so a God Mode run
              finishes as <strong>partial</strong> with its limitations listed — that is the honest outcome, not a failure of the UI.
            </span>
          </Banner>
        ) : null}

        <Table
          columns={[
            { key: 'state', label: 'State', render: (row) => <Chip>{row.state}</Chip> },
            { key: 'prompt', label: 'Prompt', render: (row) => <span className="small">{String(row.prompt ?? '').slice(0, 70)}</span> },
            { key: 'phase', label: 'Phase', render: (row) => <span className="small">{row.phase ?? '—'} <span className="muted">[{row.phaseIndex ?? -1}]</span></span> },
            {
              key: 'open',
              label: '',
              render: (row) => (
                <Button onClick={() => open(row.id)}>Open</Button>
              ),
            },
          ]}
          rows={tasks}
          empty="No tasks submitted yet"
        />

        {task ? (
          <div className="grid" style={{ gap: 12 }}>
            <div className="row">
              <Chip>{task.state}</Chip>
              {task.godMode ? <Chip tone="violet">god mode</Chip> : null}
              <Chip dot={false}>{task.id.slice(0, 8)}</Chip>
            </div>

            <Lifecycle task={task} />

            <div className="row">
              <Button busy={busy === 'pause'} onClick={() => act('pause', () => api.pauseTask(task.id, 'paused from the interface'))}>Pause</Button>
              <Button busy={busy === 'resume'} onClick={() => act('resume', () => api.resumeTask(task.id))}>Resume</Button>
              <Button busy={busy === 'cancel'} onClick={() => act('cancel', () => api.cancelTask(task.id, 'cancelled from the interface'))}>Cancel</Button>
              {task.state === 'awaiting_approval' ? (
                <Button
                  variant="primary"
                  busy={busy === 'approve'}
                  onClick={() => act('approve', () => api.approveTask(task.id, { approvals: [{ decision: 'approve', principal: principal.trim() || null, at: Date.now() }] }))}
                >
                  Approve and continue
                </Button>
              ) : null}
            </div>

            <Stats>
              <Stat label="steps" value={task.usage?.steps ?? 0} />
              <Stat label="tool calls" value={task.usage?.toolCalls ?? 0} />
              <Stat label="model calls" value={task.usage?.modelCalls ?? 0} />
              <Stat label="retrieved" value={task.usage?.retrievedChunks ?? 0} />
              <Stat label="retries" value={task.usage?.retries ?? 0} />
            </Stats>

            {task.limitations?.length ? (
              <Banner tone="warn" title="Recorded limitations" items={task.limitations} />
            ) : null}

            {task.verification ? (
              <div className="grid" style={{ gap: 6 }}>
                <span className="panel-eyebrow">
                  VERIFICATION — {task.verification.passed ? 'passed' : task.verification.reason ?? 'did not pass'}
                </span>
                <Checks checks={task.verification.checks} />
              </div>
            ) : null}

            {task.error ? <Banner tone="bad" title="Task error"><span className="small">{formatValue(task.error)}</span></Banner> : null}
            {task.result ? <Code label="RESULT" value={task.result} /> : null}
            {task.steps?.length ? <Code label="STEP LOG" value={task.steps} /> : null}
          </div>
        ) : null}
      </div>
    </Panel>
  )
}

export default function ChatArea({ readiness, refreshReadiness }) {
  const [messages, setMessages] = useState([])
  const [models, setModels] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [route, setRoute] = useState(null)
  const threadRef = useRef(null)

  useEffect(() => {
    api.models()
      .then((payload) => setModels(payload.models ?? []))
      .catch(() => setModels([]))
  }, [readiness])

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight
  }, [messages])

  const canChat = Boolean(readiness?.capabilities?.chat)

  const send = useCallback(async (draft) => {
    const userMessage = { role: 'user', text: draft.prompt, meta: {} }
    setMessages((previous) => [...previous, userMessage])
    setError(null)
    setBusy(true)

    const body = {
      prompt: draft.prompt,
      model: draft.model,
      temperature: draft.temperature,
      maxTokens: draft.maxTokens,
      useKnowledge: draft.useKnowledge,
      dataClass: draft.dataClass,
    }

    try {
      if (draft.stream) {
        let assistantText = ''
        let citations = null
        let grounding = null
        let redacted = 0
        setMessages((previous) => [...previous, { role: 'assistant', text: '', meta: { streaming: true } }])
        await streamChat(body, {
          onEvent: ({ name, data }) => {
            if (name === 'delta') {
              assistantText += data?.text ?? ''
              setMessages((previous) => {
                const next = [...previous]
                next[next.length - 1] = { role: 'assistant', text: assistantText, meta: { streaming: true } }
                return next
              })
            } else if (name === 'redaction') {
              redacted += data?.findings?.length ?? 0
            } else if (name === 'done') {
              grounding = data?.grounding ?? null
              citations = data?.grounding?.citations ?? null
              setRoute(data?.routing ?? null)
              setMessages((previous) => {
                const next = [...previous]
                next[next.length - 1] = {
                  role: 'assistant',
                  text: data?.text ?? assistantText,
                  meta: {
                    modelId: data?.modelId,
                    sentExternally: data?.sentExternally,
                    classification: data?.classification,
                    durationMs: data?.durationMs,
                    streaming: true,
                    citations,
                    grounding,
                    redacted: redacted || null,
                  },
                }
                return next
              })
            } else if (name === 'error') {
              setMessages((previous) => {
                const next = [...previous]
                next[next.length - 1] = {
                  role: 'assistant',
                  text: assistantText,
                  meta: { error: { message: data?.message ?? 'stream failed', code: data?.error ?? data?.code, status: data?.status, route: data?.route, limitation: data?.limitation } },
                }
                return next
              })
            }
          },
        })
      } else {
        const result = await api.chat(body)
        setRoute(result.routing ?? null)
        setMessages((previous) => [
          ...previous,
          {
            role: 'assistant',
            text: result.text ?? '',
            meta: {
              modelId: result.modelId,
              providerModel: result.providerModel,
              sentExternally: result.sentExternally,
              classification: result.classification,
              durationMs: result.durationMs,
              usage: result.usage,
              citations: result.grounding?.citations ?? null,
              grounding: result.grounding ?? null,
              redacted: result.redaction?.findings?.length ?? null,
              toolCalls: result.toolCalls?.length ? result.toolCalls : null,
            },
          },
        ])
      }
    } catch (caught) {
      setMessages((previous) => [...previous, { role: 'assistant', text: '', meta: { error: caught } }])
      setError(caught)
    } finally {
      setBusy(false)
      refreshReadiness?.()
    }
  }, [refreshReadiness])

  const routing = useMemo(() => {
    if (!route) return null
    return route
  }, [route])

  return (
    <div className="split">
      <div className="grid" style={{ gap: 16 }}>
        <Panel
          eyebrow="PRODUCT AREA"
          title="Conversation"
          actions={
            <>
              <Chip tone={canChat ? 'ok' : 'bad'}>{canChat ? 'chat ready' : 'no model ready'}</Chip>
              {messages.length ? <Button onClick={() => { setMessages([]); setRoute(null) }}>Clear</Button> : null}
            </>
          }
          tight
        >
          <div className="thread" ref={threadRef}>
            {messages.length === 0 ? (
              <EmptyState
                title="No messages yet"
                action={null}
              >
                {canChat
                  ? 'Send a message. The router picks a ready model; the response reports which one and whether it stayed local.'
                  : 'No model is installed on this host, so a send will return no_model_available with the router’s explanation. That is reported, not hidden.'}
              </EmptyState>
            ) : (
              messages.map((message, index) => <Message key={index} message={message} />)
            )}
          </div>
          <div className="panel-footer">
            <Composer models={models} busy={busy} onSend={send} canChat={canChat} />
          </div>
        </Panel>

        {error ? <ErrorNote error={error} title="Chat failed" /> : null}

        {routing ? (
          <Panel eyebrow="INTERNAL SERVICE" title="Model routing decision" footer="Capability-aware and provider-independent. Rejections are shown so a routing failure can be diagnosed.">
            <div className="grid" style={{ gap: 12 }}>
              <Kv
                entries={{
                  chosen: routing.modelId ?? '(none)',
                  policy: routing.policy,
                  explanation: routing.explanation,
                  candidates: routing.candidates?.length ?? 0,
                  rejected: routing.rejected?.length ?? 0,
                }}
              />
              {routing.rejected?.length ? <Code label="REJECTED CANDIDATES" value={routing.rejected} /> : null}
            </div>
          </Panel>
        ) : null}

        <KnowledgePanel />
      </div>

      <div className="grid" style={{ gap: 16 }}>
        <Panel eyebrow="INTERNAL SERVICE" title="Registered models" actions={<Button onClick={refreshReadiness}>Probe</Button>} tight>
          <Table
            columns={[
              { key: 'id', label: 'Model', render: (row) => <strong>{row.displayName ?? row.id}</strong> },
              { key: 'availability', label: 'State', render: (row) => <Chip>{row.availability ?? '—'}</Chip> },
              { key: 'location', label: 'Where', render: (row) => <span className="small">{row.location ?? '—'}</span> },
              {
                key: 'capabilities',
                label: 'Capabilities',
                render: (row) => (
                  <div className="row" style={{ gap: 4 }}>
                    {(row.capabilities ?? []).slice(0, 4).map((capability) => (
                      <Chip key={capability} dot={false}>{capability}</Chip>
                    ))}
                  </div>
                ),
              },
            ]}
            rows={models}
            empty="No models registered. Install a local runtime (Ollama or llama.cpp) and re-probe; this interface will not pretend a model exists."
          />
        </Panel>

        <TaskPanel />
      </div>
    </div>
  )
}
