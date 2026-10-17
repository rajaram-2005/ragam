import React, { useEffect, useRef, useState } from 'react'
import { api, streamChat } from '../api.js'
import { Banner, Button, Field, Panel } from '../components/ui.jsx'
import { KnowledgePanel, MemoryPanel, HistoryPanel, SkillsPanel } from '../components/ContextPanels.jsx'
export default function ChatArea({ provider, refreshReadiness, onSettings, account }) {
  const [messages, setMessages] = useState([]), [prompt, setPrompt] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(null)
  const [model, setModel] = useState(provider?.selectedModel ?? ''), [saving, setSaving] = useState(false)
  const [useKnowledge, setUseKnowledge] = useState(false), [useMemory, setUseMemory] = useState(false), [allowSensitive, setAllowSensitive] = useState(false)
  const [temperature, setTemperature] = useState('0.2'), [maxTokens, setMaxTokens] = useState('512'), [sessionId, setSessionId] = useState(null), [skill, setSkill] = useState('')
  const abort = useRef(null), thread = useRef(null)
  useEffect(() => { setModel(provider?.selectedModel ?? '') }, [provider?.selectedModel, provider?.revision])
  useEffect(() => () => abort.current?.abort(), [])
  useEffect(() => { if (thread.current) thread.current.scrollTop = thread.current.scrollHeight }, [messages])
  const send = async (event) => {
    event.preventDefault(); if (busy || saving || !prompt.trim() || !model) return
    const controller = new AbortController(); abort.current = controller
    const content = prompt.trim(), history = [...messages.filter((m) => !m.failed).map(({ role, content }) => ({ role, content })), { role: 'user', content }]
    setBusy(true); setError(null); setAllowSensitive(false)
    setMessages((old) => [...old, { role: 'user', content }, { role: 'assistant', content: '', pending: true }])
    let text = '', completed = false
    try {
      let id = sessionId
      if (!id) { const s = await api.startSession(content.slice(0, 80), { signal: controller.signal }); id = s.id; setSessionId(id) }
      await streamChat({ messages: history, model, sessionId: id, temperature: Number(temperature), maxTokens: Number(maxTokens), useKnowledge, useMemory, ...(skill ? { skill } : {}), authorization: { confirmed: true, providerRevision: provider.revision, includeContext: useKnowledge || useMemory, allowSensitive } }, {
        signal: controller.signal,
        onEvent: ({ name, data }) => {
          if (name === 'error') throw Object.assign(new Error(data.message), { code: data.error })
          if (name === 'delta') { text += data.text; setMessages((old) => [...old.slice(0, -1), { role: 'assistant', content: text, pending: true }]) }
          if (name === 'done') { completed = true; setMessages((old) => [...old.slice(0, -1), { role: 'assistant', content: data.text, meta: data }]) }
        },
      })
      if (!completed) throw Error('The response did not complete. Your draft is retained.')
      setPrompt((draft) => draft.trim() === content ? '' : draft)
    } catch (e) {
      setError(controller.signal.aborted ? Error('Generation stopped. Partial output is not saved to history; your draft is retained.') : e)
      setMessages((old) => [...old.slice(0, -2), { role: 'user', content, failed: true }, { role: 'assistant', content: text, failed: true }])
    } finally { abort.current = null; setBusy(false); refreshReadiness?.() }
  }
  return <div className="online-chat">
    {!provider?.configured ? <Banner tone="info" title="Connect your online provider"><p>Add an online gateway (LiteLLM, or an Ollama or llama.cpp server on this Core host) to start chatting. Requests are sent to that endpoint, so none of them stay on this machine.</p><Button onClick={onSettings}>Open Provider Settings</Button></Banner> : null}
    <Panel title="Conversation" actions={<Button disabled={busy} onClick={() => { setMessages([]); setSessionId(null); setError(null) }}>New conversation</Button>}>
      <div className="row between"><Field label="Provider"><span className="chip">{provider?.name ?? 'Gateway'}</span></Field><Field label="Model" hint="Your exact selection is used. No silent substitution. The default is shared by everyone signed in here."><select aria-label="Model" className="select" value={model} disabled={busy || saving || !provider?.models?.length} onChange={async (e) => { const next = e.target.value; setSaving(true); setError(null); try { await api.selectModel(next); setModel(next); await refreshReadiness?.() } catch (err) { setError(err) } finally { setSaving(false) } }}><option value="" disabled>Choose a model</option>{provider?.models?.map((id) => <option key={id} value={id}>{id}</option>)}</select></Field><Button disabled={busy} onClick={onSettings}>Provider Settings</Button></div>
      <p className="small">{provider?.baseUrl || 'No gateway configured'} · Listed models are not inference-verified until a request succeeds.</p>
      <div className="thread" ref={thread} aria-live="polite">{messages.length ? messages.map((m, i) => <div className={`message ${m.role}`} data-role={m.role} key={i}><strong className="message-role">{m.role === 'user' ? 'You' : m.meta?.modelId ?? model}</strong><div className="message-body message-text" style={{ whiteSpace: 'pre-wrap' }}>{m.content || (m.pending ? 'Waiting for the gateway…' : 'No completed response.')}</div>{m.failed ? <small>Not completed</small> : null}{m.meta ? <small>Executed online via {m.meta.provider ?? provider?.name ?? 'the gateway'}{m.meta.redaction?.findings?.length ? ' · credentials redacted' : ''}</small> : null}{typeof m.meta?.providerModel === 'string' && m.meta.providerModel !== m.meta.modelId ? <small>Gateway-reported model: {m.meta.providerModel}</small> : null}{m.meta?.skill ? <small>Procedure used: {m.meta.skill.name} v{m.meta.skill.version}</small> : null}{m.meta?.grounding?.citations?.length ? <details><summary>File references sent with this request</summary><ul>{m.meta.grounding.citations.map((c, index) => <li key={index}>{c.ref} · {c.title ?? c.documentId}</li>)}</ul></details> : null}</div>) : <p className="muted">Choose a model and start a conversation.</p>}</div>
      {error ? <Banner tone="bad" title={error.message} /> : null}
      <form onSubmit={send}><Field label="Message"><textarea className="textarea" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Ask your selected model…" maxLength={100000} /></Field>
        <details><summary>Context & generation options</summary><div className="row" style={{ marginTop: 12 }}><Field label="Temperature"><input className="input" type="number" min="0" max="2" step="0.1" value={temperature} onChange={(e) => setTemperature(e.target.value)} /></Field><Field label="Max output tokens"><input className="input" type="number" min="1" max="8192" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} /></Field></div>
          <label className="checkbox"><input type="checkbox" checked={useKnowledge} onChange={(e) => setUseKnowledge(e.target.checked)} />Send matching file excerpts to this gateway</label>
          <label className="checkbox"><input type="checkbox" checked={useMemory} onChange={(e) => setUseMemory(e.target.checked)} />Send matching approved memories to this gateway</label>
          <label className="checkbox"><input type="checkbox" checked={allowSensitive} onChange={(e) => setAllowSensitive(e.target.checked)} />I authorize sensitive content in this request and selected context to be sent to this gateway (one request)</label>
        </details><p className="small">Send transmits this conversation and any selected context to the gateway and its configured upstream provider. Provider charges and retention policies apply.</p>
        {busy ? <Button variant="danger" onClick={() => abort.current?.abort()}>Stop generation</Button> : <Button type="submit" variant="primary" disabled={saving || !model || !prompt.trim()}>Send</Button>}
      </form>
    </Panel>
    <details className="context-section"><summary>Conversation history</summary><HistoryPanel sessionId={sessionId} /></details>
    <details className="context-section"><summary>Optional files & knowledge</summary><KnowledgePanel /></details>
    <details className="context-section"><summary>Optional approved memory</summary><MemoryPanel /></details>
    <details className="context-section"><summary>Reviewed procedure (optional)</summary><SkillsPanel value={skill} onChange={setSkill} account={account} /></details>
  </div>
}
