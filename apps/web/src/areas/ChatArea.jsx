import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, streamChat } from '../api.js'
import { Banner, Button, CopyButton, Field, Panel } from '../components/ui.jsx'
import { KnowledgePanel, MemoryPanel, HistoryPanel, SkillsPanel } from '../components/ContextPanels.jsx'
import UserTrainingPanel from '../components/UserTrainingPanel.jsx'

export default function ChatArea({ provider, readiness, refreshReadiness, onSettings, account }) {
  const firstPartyAll = readiness?.firstPartyModels?.models ?? []
  const firstPartyReady = firstPartyAll.filter((entry) => entry.status === 'ready' && entry.selectorEnabled)
  const firstPartyUnavailable = firstPartyAll.filter((entry) => !(entry.status === 'ready' && entry.selectorEnabled))
  const gatewayModels = provider?.models ?? []
  const hasSelectableModels = firstPartyReady.length > 0 || gatewayModels.length > 0
  const preferredDefault = readiness?.provider?.selectedModel || provider?.selectedModel || firstPartyReady[0]?.id || ''

  const [messages, setMessages] = useState([]), [prompt, setPrompt] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(null)
  const [model, setModel] = useState(preferredDefault), [saving, setSaving] = useState(false)
  const [useKnowledge, setUseKnowledge] = useState(false), [useMemory, setUseMemory] = useState(false), [allowSensitive, setAllowSensitive] = useState(false)
  const [temperature, setTemperature] = useState('0.2'), [maxTokens, setMaxTokens] = useState('512'), [sessionId, setSessionId] = useState(null), [skill, setSkill] = useState(''), [style, setStyle] = useState(''), [styles, setStyles] = useState([])
  const abort = useRef(null), thread = useRef(null)

  useEffect(() => {
    setModel(readiness?.provider?.selectedModel || provider?.selectedModel || firstPartyReady[0]?.id || '')
  }, [readiness?.provider?.selectedModel, provider?.selectedModel, provider?.revision, firstPartyReady.length])
  useEffect(() => () => abort.current?.abort(), [])
  // The preference is read from the server, never inferred from what is typed here.
  useEffect(() => { api.styles().then((data) => { setStyles(data.styles); setStyle(data.preference?.style ?? '') }).catch(() => {}) }, [])
  useEffect(() => { if (thread.current) thread.current.scrollTop = thread.current.scrollHeight }, [messages])

  const voiceModels = readiness?.media?.voice?.models ?? []
  const [voiceModel, setVoiceModel] = useState(voiceModels[0] || 'klyvaron-pro-voice')
  const [voiceText, setVoiceText] = useState('status check')
  const [voiceSynthResult, setVoiceSynthResult] = useState(null)
  const [voiceTranscript, setVoiceTranscript] = useState(null)
  const [voiceBusy, setVoiceBusy] = useState(false)

  const selectedFirstParty = firstPartyReady.find((entry) => entry.id === model) ?? null

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
      await streamChat({
        messages: history,
        model,
        sessionId: id,
        temperature: Number(temperature),
        maxTokens: Number(maxTokens),
        useKnowledge,
        useMemory,
        ...(skill ? { skill } : {}),
        ...(style ? { style } : {}),
        authorization: {
          confirmed: true,
          providerRevision: provider?.revision ?? 0,
          includeContext: useKnowledge || useMemory,
          allowSensitive,
        },
      }, {
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

  const retry = async (index) => {
    // Find the failed user message and resend it
    const failedUser = messages[index]
    if (!failedUser || failedUser.role !== 'user') return
    setMessages((old) => old.filter((_, i) => i !== index && i !== index + 1))
    setPrompt(failedUser.content)
  }

  return <div className="online-chat">
    {!provider?.configured && firstPartyReady.length === 0 ? <Banner tone="info" title="Connect your online provider"><p>Add an online gateway (LiteLLM, or an Ollama or llama.cpp server on this Core host) to start chatting. Requests are sent to that endpoint, so none of them stay on this machine.</p><Button onClick={onSettings}>Open Provider Settings</Button></Banner> : null}
    <Panel title="Conversation" actions={<Button disabled={busy} onClick={() => { setMessages([]); setSessionId(null); setError(null) }}>New conversation</Button>}>
      <div className="row between">
        <Field label="Provider">
          <span className="chip">{selectedFirstParty ? 'Klyvaron Native' : (provider?.name ?? 'Gateway')}</span>
        </Field>
        <Field label="Model" hint="Your exact selection is used. No silent substitution. The default is shared by everyone signed in here.">
          <select aria-label="Model" className="select" value={model} disabled={busy || saving || !hasSelectableModels} onChange={async (e) => { const next = e.target.value; setSaving(true); setError(null); try { await api.selectModel(next); setModel(next); await refreshReadiness?.() } catch (err) { setError(err) } finally { setSaving(false) } }}>
            <option value="" disabled>Choose a model</option>
            {firstPartyReady.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName ?? entry.id}</option>)}
            {firstPartyUnavailable.map((entry) => <option key={entry.id} value={entry.id} disabled>{entry.label ?? entry.id} ({entry.id}) — {entry.status}</option>)}
            {gatewayModels.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </Field>
        <Button disabled={busy} onClick={onSettings}>Provider Settings</Button>
      </div>
      <p className="small">
        {selectedFirstParty
          ? `First-party weights ${selectedFirstParty.id} (${selectedFirstParty.parameters.toLocaleString('en-US')} params · SHA-256 ${selectedFirstParty.weightsSha256.slice(0, 16)}…) · verified in-host without external transfer.`
          : `${provider?.baseUrl || 'No gateway configured'} · Listed models are not inference-verified until a request succeeds.`}
      </p>
      <div className="thread" ref={thread} aria-live="polite">
        {messages.length ? messages.map((m, i) => (
          <div className={`message ${m.role}`} data-role={m.role} key={i}>
            <div className="message-head">
              <strong className="message-role">{m.role === 'user' ? 'You' : m.meta?.modelId ?? model}</strong>
              {m.content ? <div className="message-actions" style={{ marginLeft: 'auto' }}>
                <CopyButton text={m.content} label="Copy" className="ghost small" />
              </div> : null}
            </div>
            <div className="message-body message-text" style={{ whiteSpace: 'pre-wrap' }}>{m.content || (m.pending ? (selectedFirstParty ? 'Generating with verified first-party weights…' : 'Waiting for the gateway…') : 'No completed response.')}</div>
            {m.failed ? <small>Not completed {m.role === 'user' ? <Button className="ghost small" onClick={() => retry(i)}>Retry</Button> : null}</small> : null}
            {m.meta ? (m.meta.firstPartyWeights ? <small>Served by verified first-party Klyvaron weights ({m.meta.modelId} · SHA-256 {m.meta.weightsSha256?.slice(0, 12)}… · {m.meta.tokensPerSecond} tok/s · sentExternally: false){m.meta.differentiators ? ` · verdict: ${m.meta.differentiators.verdict} · state: ${m.meta.differentiators.state}` : ''}</small> : <small>Executed online via {m.meta.provider ?? provider?.name ?? 'the gateway'}{m.meta.redaction?.findings?.length ? ' · credentials redacted' : ''}</small>) : null}
            {typeof m.meta?.providerModel === 'string' && m.meta.providerModel !== m.meta.modelId ? <small>Reported model: {m.meta.providerModel}</small> : null}
            {m.meta?.skill ? <small>Procedure used: {m.meta.skill.name} v{m.meta.skill.version}</small> : null}
            {m.meta?.styleAudit && !m.meta.styleAudit.ok ? <small>Style check: {m.meta.styleAudit.violations.join(', ')}. The answer is shown unchanged; it was not rewritten.</small> : null}
            {m.meta?.grounding?.citations?.length ? <details><summary>File references sent with this request</summary><ul>{m.meta.grounding.citations.map((c, index) => <li key={index}>{c.ref} · {c.title ?? c.documentId}</li>)}</ul></details> : null}
          </div>
        )) : <p className="muted">Choose a model and start a conversation.</p>}
      </div>
      {error ? <Banner tone="bad" title={error.message} /> : null}
      <form onSubmit={send}>
        <div className="composer">
          <div className="composer-row">
            <textarea
              className="textarea"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask your selected model…"
              maxLength={100000}
              disabled={busy}
              rows={1}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e) }
              }}
            />
          </div>
          <div className="composer-actions">
            <details style={{ display: 'inline-block' }}>
              <summary style={{ listStyle: 'none', cursor: 'pointer', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>Context & options</summary>
              <div style={{ padding: '10px 0 4px' }}>
                <div className="row" style={{ marginBottom: 8 }}>
                  <Field label="Temperature"><input className="input" type="number" min="0" max="2" step="0.1" value={temperature} onChange={(e) => setTemperature(e.target.value)} style={{ width: 90 }} /></Field>
                  <Field label="Max tokens"><input className="input" type="number" min="1" max="8192" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} style={{ width: 90 }} /></Field>
                </div>
                <label className="checkbox"><input type="checkbox" checked={useKnowledge} onChange={(e) => setUseKnowledge(e.target.checked)} />Send matching file excerpts to this gateway</label>
                <label className="checkbox"><input type="checkbox" checked={useMemory} onChange={(e) => setUseMemory(e.target.checked)} />Send matching approved memories to this gateway</label>
                <label className="checkbox"><input type="checkbox" checked={allowSensitive} onChange={(e) => setAllowSensitive(e.target.checked)} />I authorize sensitive content in this request and selected context to be sent to this gateway (one request)</label>
                <Field label="Response style" hint="A preference you set. It changes how an answer is phrased, not the facts or the result; the server checks the reply and never rewrites it.">
                  <select aria-label="Response style" className="select" value={style} disabled={busy} onChange={async (event) => { const next = event.target.value; setStyle(next); try { await api.setStyle(next || null) } catch (err) { setError(err) } }}>
                    <option value="">No style instruction</option>
                    {styles.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </select>
                </Field>
              </div>
            </details>
            {busy ? <Button variant="danger" onClick={() => abort.current?.abort()}>Stop generation</Button> : <Button type="submit" variant="primary" disabled={saving || !model || !prompt.trim()}>Send</Button>}
          </div>
        </div>
        <p className="small" style={{ marginTop: 8 }}>{selectedFirstParty ? 'First-party Klyvaron weights process this conversation on this Core host with zero third-party network transfer or fallback.' : 'Send transmits this conversation and any selected context to the gateway and its configured upstream provider. Provider charges and retention policies apply.'}</p>
      </form>
    </Panel>
    <details className="context-section">
      <summary>First-party Klyvaron Voice (speech synthesis &amp; speech-to-text)</summary>
      <Panel title="Klyvaron Voice (Bidirectional Neural TTS + ASR)">
        <p className="small">
          {voiceModels.length
            ? `Verified first-party voice models ready: ${voiceModels.join(', ')}. Processes 16 kHz PCM WAV locally without third-party audio transfer.`
            : 'No verified first-party voice model checkpoint installed in this workspace yet.'}
        </p>
        <div className="row" style={{ gap: 8 }}>
          <Field label="Voice model">
            <select aria-label="Voice model" className="select" value={voiceModel} disabled={voiceBusy} onChange={(e) => setVoiceModel(e.target.value)}>
              {(voiceModels.length ? voiceModels : ['klyvaron-pro-voice', 'klyvaron-max-voice']).map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
          </Field>
          <Field label="Speech synthesis text">
            <input className="input" value={voiceText} disabled={voiceBusy} onChange={(e) => setVoiceText(e.target.value)} placeholder="Phrase to synthesize…" />
          </Field>
          <Button disabled={voiceBusy || !voiceModels.length || !voiceText.trim()} onClick={async () => {
            setVoiceBusy(true); setError(null)
            try {
              const out = await api.synthesizeVoice({ model: voiceModel, text: voiceText.trim() })
              setVoiceSynthResult(out)
            } catch (err) { setError(err) } finally { setVoiceBusy(false) }
          }}>Synthesize WAV</Button>
          {(voiceSynthResult?.jobId || voiceSynthResult?.job?.id) ? (
            <Button disabled={voiceBusy} onClick={async () => {
              setVoiceBusy(true); setError(null)
              try {
                const tr = await api.transcribeVoice({ model: voiceModel, sourceJobId: voiceSynthResult.jobId ?? voiceSynthResult.job.id })
                setVoiceTranscript(tr)
                if (tr.text) setPrompt(tr.text)
              } catch (err) { setError(err) } finally { setVoiceBusy(false) }
            }}>Transcribe audio → Chat draft</Button>
          ) : null}
          <Field label="Upload WAV (16 kHz)">
            <input aria-label="Upload WAV for transcription" type="file" accept="audio/wav,.wav" disabled={voiceBusy || !voiceModels.length} onChange={async (e) => {
              const file = e.target.files?.[0]
              if (!file) return
              setVoiceBusy(true); setError(null)
              try {
                const bytes = new Uint8Array(await file.arrayBuffer())
                let bin = ''
                for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i])
                const tr = await api.transcribeVoice({ model: voiceModel, audioBase64: btoa(bin) })
                setVoiceTranscript(tr)
                if (tr.text) setPrompt(tr.text)
              } catch (err) { setError(err) } finally { setVoiceBusy(false); e.target.value = '' }
            }} />
          </Field>
        </div>
        {voiceSynthResult ? (
          <div style={{ marginTop: 8 }}>
            <audio controls src={voiceSynthResult.artifactUrl || (voiceSynthResult.audioBase64 ? `data:audio/wav;base64,${voiceSynthResult.audioBase64}` : undefined)} />
            <p className="small">
              Synthesized by {voiceSynthResult.modelId} ({voiceSynthResult.durationSeconds}s · {voiceSynthResult.sampleRate} Hz · SHA-256 {voiceSynthResult.weightsSha256?.slice(0, 12)}…)
            </p>
          </div>
        ) : null}
        {voiceTranscript ? (
          <p className="small">Transcribed text: <strong>{voiceTranscript.text}</strong>{voiceTranscript.nearestCommand ? ` · command: ${voiceTranscript.nearestCommand}` : ''} (confidence {(Number(voiceTranscript.commandConfidence ?? voiceTranscript.utteranceConfidence ?? 0) * 100).toFixed(1)}%)</p>
        ) : null}
      </Panel>
    </details>
    <details className="context-section"><summary>Conversation history</summary><HistoryPanel sessionId={sessionId} /></details>
    <details className="context-section"><summary>Optional files & knowledge</summary><KnowledgePanel /></details>
    <details className="context-section"><summary>Optional approved memory</summary><MemoryPanel /></details>
    <details className="context-section"><summary>Reviewed procedure (optional)</summary><SkillsPanel value={skill} onChange={setSkill} account={account} model={model} provider={provider} /></details>
    <details className="context-section"><summary>Local training worker (your computer, explicit consent only)</summary><UserTrainingPanel readiness={readiness} refreshReadiness={refreshReadiness} /></details>
  </div>
}
