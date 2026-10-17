import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { Banner, Button, Chip, Code, EmptyState, ErrorNote, Field, Kv, Panel, Stat, Stats, Table, formatValue } from './ui.jsx'
const DATA_CLASSES = ['public', 'internal', 'confidential', 'restricted']
export function KnowledgePanel() {
  const [stats, setStats] = useState(null)
  const [documents, setDocuments] = useState([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [classification, setClassification] = useState('internal')
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
        owner: 'owner',
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
            <input aria-label="Import a text file" type="file" accept=".txt,.md,.csv,.json,.log" onChange={async (event) => {
              const file = event.target.files?.[0]
              if (!file) return
              if (file.size > 1024 * 1024 || !/\.(txt|md|csv|json|log)$/i.test(file.name)) { setError(Error('Choose a plain-text file of at most 1 MiB. PDF and Office files are not supported.')); return }
              try { setText(await file.text()); setTitle(file.name); setError(null) } catch { setError(Error('Could not read this text file.')) }
            }} />
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


export function MemoryPanel() {
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


export function HistoryPanel({ sessionId }) {
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

/**
 * Reviewed procedures, selected for one message.
 *
 * A skill is text, not a tool: the server sends the procedure as reference material and refuses
 * one that declares file or network access, because this product has no executor to grant it.
 * Validation here is structural review; the panel says so rather than implying a measured gain.
 */
export function SkillsPanel({ value, onChange, account }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState('')
  const [form, setForm] = useState({ name: '', description: '', whenToUse: '', steps: '', verification: '' })

  const load = useCallback(async () => {
    try { setData(await api.skills()); setError(null) } catch (e) { setError(e) }
  }, [])
  useEffect(() => { load() }, [load])

  const usable = (data?.skills ?? []).filter((skill) => skill.loadable && skill.state === 'validated'
    && (skill.permissions?.fsRead ?? []).length === 0 && (skill.permissions?.fsWrite ?? []).length === 0 && skill.permissions?.network !== true)

  const act = async (label, work) => {
    setBusy(label); setError(null)
    try { await work(); await load() } catch (e) { setError(e) } finally { setBusy('') }
  }

  const install = async (event) => {
    event.preventDefault()
    await act('install', async () => {
      await api.installSkill({
        name: form.name.trim(),
        description: form.description.trim(),
        whenToUse: form.whenToUse.trim(),
        steps: form.steps.split('\n').map((line) => line.trim()).filter(Boolean),
        verification: form.verification.trim(),
      })
      setForm({ name: '', description: '', whenToUse: '', steps: '', verification: '' })
    })
  }

  return <div className="stack">
    <Banner tone="info" title="A procedure is reference text, not code">
      <p>Selecting one adds its reviewed steps to this message as reference material. Nothing in it runs, no permission is granted, and using it is not training. Validation is a structural review of the document and its scope, not a measured improvement.</p>
    </Banner>
    {error ? <ErrorNote error={error} /> : null}
    {!data ? <p className="small">Loading procedures…</p> : null}
    {data && !usable.length ? <EmptyState title="No validated procedure is available"><span className="small">An owner can install one below. A candidate cannot be selected until it passes its review.</span></EmptyState> : null}
    {usable.length ? <div className="stack">
      <label className="checkbox"><input type="radio" name="skill" checked={!value} onChange={() => onChange('')} />No procedure</label>
      {usable.map((skill) => <label className="checkbox" key={skill.name}>
        <input type="radio" name="skill" checked={value === skill.name} onChange={() => onChange(skill.name)} />
        <span><strong>{skill.name}</strong> v{skill.version} — {skill.description} <span className="muted small">({skill.procedureSteps} steps, structural review)</span></span>
      </label>)}
    </div> : null}

    {account?.role === 'owner' ? <details>
      <summary>Install or review procedures</summary>
      <form onSubmit={install} className="stack">
        <Field label="Name" hint="Lowercase words separated by hyphens."><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={63} /></Field>
        <Field label="One-sentence description"><input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required maxLength={200} /></Field>
        <Field label="When to use it"><textarea className="textarea" rows={2} value={form.whenToUse} onChange={(e) => setForm({ ...form, whenToUse: e.target.value })} required maxLength={2000} /></Field>
        <Field label="Procedure steps" hint="One step per line. Two to twenty steps."><textarea className="textarea" rows={4} value={form.steps} onChange={(e) => setForm({ ...form, steps: e.target.value })} required /></Field>
        <Field label="How a reader verifies it was followed"><textarea className="textarea" rows={2} value={form.verification} onChange={(e) => setForm({ ...form, verification: e.target.value })} required maxLength={1000} /></Field>
        <Button type="submit" variant="primary" busy={busy === 'install'} disabled={!form.name.trim() || !form.description.trim() || !form.whenToUse.trim() || !form.steps.trim() || !form.verification.trim()}>Install as candidate</Button>
      </form>
      <div className="stack" style={{ marginTop: 12 }}>
        {(data?.skills ?? []).map((skill) => <div className="row between" key={skill.name}>
          <span className="small"><strong>{skill.name}</strong> v{skill.version} · {skill.state}{skill.enabled ? '' : ' · disabled'}</span>
          <span className="row">
            {skill.state === 'candidate' ? <Button busy={busy === `validate-${skill.name}`} onClick={() => act(`validate-${skill.name}`, () => api.validateSkill(skill.name))}>Validate</Button> : null}
            <Button onClick={() => act(`toggle-${skill.name}`, () => api.setSkill(skill.name, { enabled: !skill.enabled }))}>{skill.enabled ? 'Disable' : 'Enable'}</Button>
            <Button variant="danger" busy={busy === `delete-${skill.name}`} onClick={() => act(`delete-${skill.name}`, () => api.deleteSkill(skill.name))}>Delete</Button>
          </span>
        </div>)}
      </div>
    </details> : null}
  </div>
}
