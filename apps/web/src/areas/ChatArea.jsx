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
        {meta.memory?.used ? <Chip tone="info">used {meta.memory.count} remembered</Chip> : null}
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
  const [useMemory, setUseMemory] = useState(false)
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
      useMemory,
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
            <input type="checkbox" checked={useMemory} onChange={(event) => setUseMemory(event.target.checked)} />
            Use what I asked you to remember
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

/**
 * Memory: the things the user asked Aetheris to remember.
 *
 * This panel exists because the approval gate was, until now, only reachable through the
 * API. A memory system whose approval step has no interface is a memory system that
 * cannot be used as intended -- the point of the gate is that a person decides, and a
 * person decides in a UI.
 *
 * Three things are shown separately, because they are three different things:
 *   - what is remembered (the user's own statements, editable and deletable)
 *   - what has been PROPOSED (a candidate is not memory and is never injected)
 *   - what the store will refuse (its limits, and that nothing is trained on)
 */
function MemoryPanel() {
  const [data, setData] = useState(null)
  const [draft, setDraft] = useState('')
  const [kind, setKind] = useState('fact')
  const [subject, setSubject] = useState('')
  const [dataClass, setDataClass] = useState('internal')
  const [editing, setEditing] = useState(null)
  const [editText, setEditText] = useState('')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [find, setFind] = useState('')
  const [found, setFound] = useState(null)

  const load = useCallback(async () => {
    setBusy('loading')
    try {
      setData(await api.memory())
      setError(null)
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // `message` may be a function of the response: the store already distinguishes a stored
  // memory from a duplicate, and says how many rows a wipe removed, so the confirmation can
  // state what actually happened instead of a sentence that is true either way.
  const run = async (key, action, message) => {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      const result = await action()
      if (message) setNotice(typeof message === 'function' ? message(result) : message)
      await load()
      return true
    } catch (caught) {
      setError(caught)
      return false
    } finally {
      setBusy(null)
    }
  }

  const remember = (event) => {
    event.preventDefault()
    if (!draft.trim()) return
    run(
      'add',
      () => api.remember({ text: draft.trim(), kind, subject: subject.trim() || null, dataClass }),
      (result) => (result?.duplicate ? 'That is already remembered, so nothing was added.' : 'Remembered.'),
    ).then((ok) => { if (ok) { setDraft(''); setSubject('') } })
  }

  const search = async (event) => {
    event.preventDefault()
    if (!find.trim()) return
    setBusy('find')
    try {
      setFound(await api.searchMemory(find.trim()))
      setError(null)
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
    }
  }

  // Take a copy before deleting anything: the store can state the consent and
  // training-use terms of every record it returns, and a user who can delete their data
  // without being able to take it elsewhere has been given half a right.
  const download = async () => {
    setBusy('export')
    setError(null)
    setNotice(null)
    try {
      const envelope = await api.exportMemory()
      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `aetheris-memory-${new Date().toISOString().slice(0, 10)}.json`
      link.click()
      URL.revokeObjectURL(url)
      setNotice(
        `Exported ${envelope.memories.length} memories and ${envelope.sessions.length} conversations, `
        + `marked ${envelope.consent} and training use ${envelope.trainingUse}.`,
      )
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
    }
  }

  const memories = data?.memories ?? []
  const candidates = data?.candidates ?? []
  const stats = data?.stats ?? null
  // The list is served with a limit; when it comes back full, saying so is the honest
  // thing rather than implying these are all of them.
  const listIsCapped = memories.length >= 200

  return (
    <Panel
      eyebrow="INTERNAL SERVICE"
      title="Memory you approved"
      actions={
        <>
          <Button busy={busy === 'export'} onClick={download}>Download a copy</Button>
          <Button busy={busy === 'loading'} onClick={load}>Refresh</Button>
        </>
      }
      footer={stats?.limits
        ? `Stored in its own local database, up to ${stats.limits.maxMemories} entries. Nothing here is trained on, and nothing here reaches a prompt unless you switch memory on in the composer.`
        : 'Stored in its own local database. Nothing here is trained on, and nothing here reaches a prompt unless you switch memory on in the composer.'}
    >
      <div className="grid" style={{ gap: 14 }}>
        {error ? <ErrorNote error={error} title="Memory request failed" /> : null}
        {notice ? <Banner tone="ok" title="Done"><span className="small">{notice}</span></Banner> : null}

        <Stats>
          <Stat label="remembered" value={stats?.memories ?? memories.length} note="approved by you" />
          <Stat label="awaiting your decision" value={stats?.pendingCandidates ?? candidates.length} note="not used until approved" />
          <Stat label="superseded" value={stats?.supersededMemories ?? 0} note="kept, not injected" small />
          <Stat label="deletions recorded" value={stats?.deletionsRecorded ?? 0} note="what went, never what it said" small />
        </Stats>

        {candidates.length ? (
          <Banner tone="warn" title={`${candidates.length} proposed ${candidates.length === 1 ? 'memory' : 'memories'} needs your decision`}>
            <span className="small">
              A proposal is not a memory. It is not searched, not injected into any prompt, and not used
              until you approve it here.
            </span>
            {candidates.map((candidate) => (
              <div className="row between" key={candidate.id} style={{ marginTop: 6, gap: 10 }}>
                <div className="grid" style={{ gap: 2 }}>
                  <span>{candidate.text}</span>
                  <span className="small">
                    proposed by {candidate.proposedFrom}
                    {candidate.rationale ? ` · ${candidate.rationale}` : ''}
                  </span>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <Button
                    variant="primary"
                    busy={busy === `approve-${candidate.id}`}
                    onClick={() => run(`approve-${candidate.id}`, () => api.decideMemory(candidate.id, true), 'Approved and remembered.')}
                  >
                    Approve
                  </Button>
                  <Button
                    busy={busy === `reject-${candidate.id}`}
                    onClick={() => run(`reject-${candidate.id}`, () => api.decideMemory(candidate.id, false), 'Rejected.')}
                  >
                    Reject
                  </Button>
                </div>
              </div>
            ))}
          </Banner>
        ) : null}

        <form onSubmit={remember}>
          <Field label="Ask Aetheris to remember something" hint="Short statements. Documents belong in the knowledge panel, not here.">
            <input className="input" value={draft} maxLength={2000} placeholder="Prefers responses in British English." onChange={(event) => setDraft(event.target.value)} />
          </Field>
          <div className="grid cols-3" style={{ gap: 11 }}>
            <Field label="Kind">
              <select className="select" value={kind} onChange={(event) => setKind(event.target.value)}>
                {['fact', 'preference', 'decision', 'constraint'].map((entry) => <option key={entry} value={entry}>{entry}</option>)}
              </select>
            </Field>
            <Field label="About">
              <input className="input" value={subject} placeholder="optional" onChange={(event) => setSubject(event.target.value)} />
            </Field>
            <Field label="Classification" hint="Raises the classification of any request it is injected into.">
              <select className="select" value={dataClass} onChange={(event) => setDataClass(event.target.value)}>
                {DATA_CLASSES.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
              </select>
            </Field>
          </div>
          <div className="row between">
            <span className="small">Remembering is your action: the store records you as the approver, and the database refuses anything else.</span>
            <Button type="submit" variant="primary" busy={busy === 'add'} disabled={!draft.trim()}>Remember</Button>
          </div>
        </form>

        <form onSubmit={search}>
          <Field label="Find a memory" hint="Searches what you asked to be remembered, and nothing else.">
            <div className="row">
              <input className="input" value={find} onChange={(event) => setFind(event.target.value)} placeholder="deploy, invoice, British English…" />
              <Button type="submit" busy={busy === 'find'} disabled={!find.trim()}>Search</Button>
            </div>
          </Field>
        </form>

        {found ? (
          found.results.some((result) => result.memory) ? (
            <div className="citations">
              {found.results.map((result) => (result.memory ? (
                <div className="citation" key={result.memory.id}>
                  <div className="citation-head">
                    <span className="citation-ref">{result.memory.kind}</span>
                    <span className="citation-meta">{result.memory.dataClass}</span>
                  </div>
                  <p className="citation-snippet">{result.memory.text}</p>
                </div>
              ) : null))}
            </div>
          ) : (
            <Banner tone="info" title="Nothing you asked me to remember matched">
              <span className="small">Nothing was invented to fill the result.</span>
            </Banner>
          )
        ) : null}

        {memories.length ? (
          <Table
            columns={[
              { key: 'text', label: 'Memory', render: (memory) => (editing === memory.id ? (
                <div className="row" style={{ gap: 6 }}>
                  <input className="input" value={editText} onChange={(event) => setEditText(event.target.value)} />
                  <Button
                    variant="primary"
                    busy={busy === `save-${memory.id}`}
                    onClick={() => run(`save-${memory.id}`, () => api.updateMemory(memory.id, { text: editText }), 'Updated.')
                      .then((ok) => { if (ok) setEditing(null) })}
                  >
                    Save
                  </Button>
                  <Button onClick={() => setEditing(null)}>Cancel</Button>
                </div>
              ) : (
                <span>
                  {memory.text}
                  {memory.subject ? <span className="small"> · about {memory.subject}</span> : null}
                </span>
              )) },
              { key: 'kind', label: 'Kind', render: (memory) => <Chip tone="violet" dot={false}>{memory.kind}</Chip> },
              { key: 'dataClass', label: 'Class', render: (memory) => <Chip tone={memory.dataClass === 'public' ? 'info' : 'warn'} dot={false}>{memory.dataClass}</Chip> },
              { key: 'actions', label: '', render: (memory) => (
                <div className="row" style={{ gap: 6 }}>
                  <Button onClick={() => { setEditing(memory.id); setEditText(memory.text) }}>Edit</Button>
                  <Button
                    variant="danger"
                    busy={busy === `forget-${memory.id}`}
                    onClick={() => run(`forget-${memory.id}`, () => api.forgetMemory(memory.id, 'removed from the memory panel'), 'Forgotten. The row is gone, not archived.')}
                  >
                    Delete
                  </Button>
                </div>
              ) },
            ]}
            rows={memories.map((memory) => ({ ...memory, key: memory.id }))}
          />
        ) : (
          <EmptyState title="Nothing remembered yet">
            <span className="small">
              Nothing is remembered automatically. When a conversation suggests something worth keeping, it is
              proposed above and waits for you.
            </span>
          </EmptyState>
        )}

        {listIsCapped ? (
          <span className="small">
            Showing the {memories.length} most recent. There are more than fit here — use Find a memory to
            look through the rest.
          </span>
        ) : null}

        {memories.length || candidates.length ? (
          <div className="row between">
            <span className="small">Deleting removes the memory and its index entry. A tombstone records that a deletion happened, never what it said.</span>
            <Button
              variant="danger"
              busy={busy === 'wipe'}
              onClick={() => run(
                'wipe',
                () => api.forgetAllMemory(),
                (result) => `Removed ${result?.deletedMemories ?? 0} memories and ${result?.deletedCandidates ?? 0} proposals.`,
              )}
            >
              Delete everything
            </Button>
          </div>
        ) : null}
      </div>
    </Panel>
  )
}

/**
 * History: recall over the user's own past turns.
 *
 * Separate from Memory on purpose. Recall searches conversations and reports where each
 * hit came from; memory is a set of statements the user approved. Neither is injected
 * unless asked for, which is why the results show their session and role rather than
 * being pasted into the composer.
 */
function HistoryPanel({ sessionId }) {
  const [sessions, setSessions] = useState([])
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const payload = await api.sessions()
      setSessions(payload.sessions ?? [])
      setError(null)
    } catch (caught) {
      setError(caught)
    }
  }, [])

  useEffect(() => { load() }, [load, sessionId])

  const search = async (event) => {
    event.preventDefault()
    if (!query.trim()) return
    setBusy('search')
    try {
      setHits(await api.recall(query.trim()))
      setError(null)
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (id) => {
    setBusy(`del-${id}`)
    try {
      await api.deleteSession(id)
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
      title="Conversation history"
      actions={<Button onClick={load}>Refresh</Button>}
      footer="Turns are stored locally only when the browser asked for a session. Recall is a search you run, never something silently added to a new question."
    >
      <div className="grid" style={{ gap: 14 }}>
        {error ? <ErrorNote error={error} title="History request failed" /> : null}

        <form onSubmit={search}>
          <Field label="Search your own past conversations" hint="Lexical search over stored turns, ranked locally.">
            <div className="row">
              <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="delimiter, deploy, invoice…" />
              <Button type="submit" busy={busy === 'search'} disabled={!query.trim()}>Search</Button>
            </div>
          </Field>
        </form>

        {hits ? (
          hits.reason ? (
            <Banner tone="info" title="Nothing to search for">
              <span className="small">{hits.reason}</span>
            </Banner>
          ) : hits.hits.length ? (
            <div className="citations">
              {hits.hits.map((hit) => (
                <div className="citation" key={hit.turnId}>
                  <div className="citation-head">
                    <span className="citation-ref">{hit.role}</span>
                    <span className="citation-title">{hit.sessionTitle ?? hit.sessionId}</span>
                    <span className="citation-meta">{new Date(hit.at).toLocaleString()}</span>
                  </div>
                  <p className="citation-snippet">{hit.excerpt?.text}</p>
                </div>
              ))}
            </div>
          ) : (
            <Banner tone="info" title="No stored turn matched">
              <span className="small">
                Searched {hits.searchedTurns} stored {hits.searchedTurns === 1 ? 'turn' : 'turns'}. Nothing was
                invented to fill the result.
              </span>
            </Banner>
          )
        ) : null}

        {sessions.length ? (
          <Table
            columns={[
              { key: 'title', label: 'Session', render: (session) => session.title ?? <span className="small">{session.id.slice(0, 8)}…</span> },
              { key: 'turnCount', label: 'Turns', render: (session) => formatValue(session.turnCount) },
              { key: 'lastAt', label: 'Last used', render: (session) => new Date(session.lastAt).toLocaleString() },
              { key: 'actions', label: '', render: (session) => (
                <Button variant="danger" busy={busy === `del-${session.id}`} onClick={() => remove(session.id)}>Delete</Button>
              ) },
            ]}
            rows={sessions.map((session) => ({ ...session, key: session.id }))}
            empty="No conversation has been stored yet."
          />
        ) : (
          <EmptyState title="No conversations stored yet">
            <span className="small">
              Send a message and it will appear here. Nothing is stored unless the browser asks for a session,
              and deleting a session removes its turns.
            </span>
          </EmptyState>
        )}
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
  // The session is created lazily, on the first message. Creating one on mount would
  // write a row for every visit, including visits where nothing was asked -- storage the
  // user never agreed to is storage the user should not have to delete.
  const [sessionId, setSessionId] = useState(null)
  const [sessionError, setSessionError] = useState(null)
  const sessionRef = useRef(null)
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

    // Ask the backend for a session once, then reuse it. A failure here is reported and
    // the conversation continues without history rather than being blocked: losing the
    // record of a question is not a reason to refuse to answer it.
    if (!sessionRef.current) {
      try {
        const created = await api.startSession(null)
        sessionRef.current = created.id
        setSessionId(created.id)
        setSessionError(null)
      } catch (caught) {
        sessionRef.current = null
        setSessionError(caught)
      }
    }

    const body = {
      prompt: draft.prompt,
      model: draft.model,
      temperature: draft.temperature,
      maxTokens: draft.maxTokens,
      useKnowledge: draft.useKnowledge,
      useMemory: draft.useMemory,
      sessionId: sessionRef.current,
      dataClass: draft.dataClass,
    }

    try {
      if (draft.stream) {
        let assistantText = ''
        let citations = null
        let grounding = null
        let memoryUsed = null
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
              memoryUsed = data?.memory ?? null
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
                    memory: memoryUsed,
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
              memory: result.memory ?? null,
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
              {messages.length ? (
                <Button onClick={() => {
                  setMessages([])
                  setRoute(null)
                  // Clearing starts a new conversation rather than appending to the old
                  // one, so the next message creates its own session.
                  sessionRef.current = null
                  setSessionId(null)
                }}
                >
                  Clear
                </Button>
              ) : null}
            </>
          }
          tight
        >
          {sessionError ? (
            <Banner tone="warn" title="This conversation is not being stored">
              <span className="small">
                {sessionError.message} The conversation continues; only the local history is missing.
              </span>
            </Banner>
          ) : null}
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
        <MemoryPanel />
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

        <HistoryPanel sessionId={sessionId} />
      </div>
    </div>
  )
}
