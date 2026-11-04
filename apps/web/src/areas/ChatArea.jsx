import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, streamChat } from '../api.js'
import { Banner, Button, CopyButton, Field, Panel } from '../components/ui.jsx'
import { KnowledgePanel, MemoryPanel, HistoryPanel, SkillsPanel } from '../components/ContextPanels.jsx'
import UserTrainingPanel from '../components/UserTrainingPanel.jsx'
import GettingStarted from '../components/GettingStarted.jsx'
import ChatToolRunner from '../components/ChatToolRunner.jsx'
import { recommendationsForProfile } from '../profile.js'
import { CHAT_FILE_LIMITS, messageWithChatFiles, readChatAttachment } from '../chat-files.js'
import { setSetupGuideDismissed, setupGuideDismissed } from '../onboarding.js'
import { recordedBlobToWav, VOICE_CAPTURE_LIMITS } from '../voice-capture.js'

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}

export default function ChatArea({ provider, readiness, refreshReadiness, onSettings, onProfile, profile, account, industryMode = false, industryPrompt = '', onIndustryPromptConsumed }) {
  const firstPartyAll = readiness?.firstPartyModels?.models ?? []
  const firstPartyReady = firstPartyAll.filter((entry) => entry.status === 'ready' && entry.selectorEnabled)
  const firstPartyUnavailable = firstPartyAll.filter((entry) => !(entry.status === 'ready' && entry.selectorEnabled))
  const gatewayModels = provider?.models ?? []
  const hasSelectableModels = firstPartyReady.length > 0 || gatewayModels.length > 0
  const recommendations = recommendationsForProfile(profile)
  const preferredDefault = readiness?.provider?.selectedModel || provider?.selectedModel || firstPartyReady[0]?.id || ''

  const [messages, setMessages] = useState([]), [prompt, setPrompt] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(null)
  const [model, setModel] = useState(preferredDefault), [saving, setSaving] = useState(false)
  const [loadedSavedSession, setLoadedSavedSession] = useState(false), [loadedSavedSessionHasMedia, setLoadedSavedSessionHasMedia] = useState(false)
  const [showSetupGuide, setShowSetupGuide] = useState(() => !setupGuideDismissed())
  const [attachments, setAttachments] = useState([]), [attachmentError, setAttachmentError] = useState(''), [mediaConsent, setMediaConsent] = useState(false)
  const [offeredTools, setOfferedTools] = useState([]), [toolsConsent, setToolsConsent] = useState(false), [nativeSearchConsent, setNativeSearchConsent] = useState(false)
  const [useKnowledge, setUseKnowledge] = useState(false), [useMemory, setUseMemory] = useState(false), [allowSensitive, setAllowSensitive] = useState(false)
  const [temperature, setTemperature] = useState('0.2'), [maxTokens, setMaxTokens] = useState('512'), [sessionId, setSessionId] = useState(null), [skill, setSkill] = useState(''), [style, setStyle] = useState(''), [styles, setStyles] = useState([])
  const abort = useRef(null), thread = useRef(null), composerInput = useRef(null)

  useEffect(() => {
    setModel(readiness?.provider?.selectedModel || provider?.selectedModel || firstPartyReady[0]?.id || '')
  }, [readiness?.provider?.selectedModel, provider?.selectedModel, provider?.revision, firstPartyReady.length])
  useEffect(() => () => {
    abort.current?.abort()
    if (recordingTimer.current) clearTimeout(recordingTimer.current)
    if (recorder.current) { recorder.current.onstop = null; if (recorder.current.state !== 'inactive') recorder.current.stop() }
    recordingStream.current?.getTracks().forEach((track) => track.stop())
  }, [])
  // The preference is read from the server, never inferred from what is typed here.
  useEffect(() => { api.styles().then((data) => { setStyles(data.styles); setStyle(data.preference?.style ?? '') }).catch(() => {}) }, [])
  useEffect(() => { if (thread.current) thread.current.scrollTop = thread.current.scrollHeight }, [messages])
  useEffect(() => {
    if (!industryPrompt) return
    setPrompt(industryPrompt)
    onIndustryPromptConsumed?.()
  }, [industryPrompt, onIndustryPromptConsumed])

  const voiceModels = readiness?.media?.voice?.models ?? []
  const canRecordVoice = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined'
  const [voiceModel, setVoiceModel] = useState(voiceModels[0] || 'klyvaron-pro-voice')
  const [voiceText, setVoiceText] = useState('status check')
  const [voiceSynthResult, setVoiceSynthResult] = useState(null)
  const [voiceTranscript, setVoiceTranscript] = useState(null)
  const [audioDraft, setAudioDraft] = useState(null)
  const [audioPreviewUrl, setAudioPreviewUrl] = useState('')
  const [recording, setRecording] = useState(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [spokenResponses, setSpokenResponses] = useState({})
  const recorder = useRef(null), recordingStream = useRef(null), recordingTimer = useRef(null), recordingChunks = useRef([])

  useEffect(() => {
    if (!audioDraft?.blob) { setAudioPreviewUrl(''); return undefined }
    const url = URL.createObjectURL(audioDraft.blob)
    setAudioPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [audioDraft])

  const selectedFirstParty = firstPartyReady.find((entry) => entry.id === model) ?? null
  const industryUnsupported = Boolean(industryMode && selectedFirstParty && selectedFirstParty.instructionTuned !== true)
  const selectedModelEvidence = provider?.modelDetails?.find((entry) => entry.id === model) ?? null
  const selectedModelReady = Boolean(model && (gatewayModels.includes(model) || firstPartyReady.some((entry) => entry.id === model)))
  const setSetupGuideOpen = (open) => {
    setShowSetupGuide(open)
    setSetupGuideDismissed(!open)
  }

  const send = async (event) => {
    event.preventDefault(); if (busy || saving || (!prompt.trim() && !attachments.length) || !model) return
    if (industryUnsupported) { setError(Error('Manufacturing Operations mode needs an instruction-tuned model. Klyvaron Lite is a base completion model; switch the mode off or choose an instruction-tuned Chat model.')); return }
    const content = messageWithChatFiles(prompt, attachments)
    const mediaAttachments = attachments.filter((file) => ['image', 'audio', 'video'].includes(file.kind))
    const allowedMediaKinds = new Set(selectedFirstParty ? [] : (provider?.chatInputKinds ?? []))
    const unsupportedMedia = mediaAttachments.filter((file) => !allowedMediaKinds.has(file.kind))
    if (unsupportedMedia.length) {
      setError(Error(`The selected Chat wire cannot send ${[...new Set(unsupportedMedia.map((file) => file.kind))].join(', ')} attachments. Choose a compatible listed provider; no fallback will occur.`))
      return
    }
    if (mediaAttachments.length && !mediaConsent) {
      setError(Error('Before sending, confirm that these selected media files may be transferred to the selected provider.'))
      return
    }
    if (nativeSearchConsent && (!provider?.chatNativeSearch || selectedFirstParty)) {
      setError(Error('Provider-native search is not available on the selected Chat wire.'))
      return
    }
    if (toolsConsent && offeredTools.length && (!provider?.chatTools || selectedFirstParty)) {
      setError(Error('Function tool proposals are not available on the selected Chat wire.'))
      return
    }
    if (content.length > 100_000) {
      setError(Error('The question and attached text exceed the 100,000-character message limit. Remove a file or shorten the question.'))
      return
    }
    const providerText = messageWithChatFiles(prompt, attachments.filter((file) => !['image', 'audio', 'video'].includes(file.kind)))
    const providerContent = mediaAttachments.length
      ? [{ type: 'text', text: providerText }, ...mediaAttachments.map(({ kind, name, mimeType, data }) => ({ type: kind, name, mimeType, data }))]
      : content
    const controller = new AbortController(); abort.current = controller
    const history = [...messages.filter((m) => !m.failed).map(({ role, content }) => ({ role, content })), { role: 'user', content: providerContent }]
    const attachmentLabels = attachments.map(({ name, kind, size }) => ({ name, kind, size }))
    setBusy(true); setError(null); setAllowSensitive(false)
    setMessages((old) => [...old, { role: 'user', content, draftPrompt: prompt, attachments: attachmentLabels }, { role: 'assistant', content: '', pending: true }])
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
        ...(industryMode ? { industryMode: 'manufacturing' } : {}),
        useKnowledge,
        useMemory,
        ...(nativeSearchConsent ? { nativeSearch: true } : {}),
        ...(toolsConsent && offeredTools.length ? { tools: offeredTools } : {}),
        ...(skill ? { skill } : {}),
        ...(style ? { style } : {}),
        authorization: {
          confirmed: true,
          providerRevision: provider?.revision ?? 0,
          includeContext: useKnowledge || useMemory,
          allowSensitive,
          mediaConfirmed: mediaAttachments.length > 0 && mediaConsent,
          nativeSearchConfirmed: nativeSearchConsent,
          toolsConfirmed: toolsConsent && offeredTools.length > 0,
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
      setPrompt((draft) => draft.trim() === prompt.trim() ? '' : draft)
      setAttachments([])
      setAttachmentError('')
    } catch (e) {
      setError(controller.signal.aborted ? Error('Generation stopped. Partial output is not saved to history; your draft is retained.') : e)
      setMessages((old) => [...old.slice(0, -2), { role: 'user', content, draftPrompt: prompt, attachments: attachmentLabels, failed: true }, { role: 'assistant', content: text, failed: true }])
    } finally { abort.current = null; setBusy(false); setMediaConsent(false); setToolsConsent(false); setNativeSearchConsent(false); refreshReadiness?.() }
  }

  const retry = async (index) => {
    // Find the failed user message and resend it
    const failedUser = messages[index]
    if (!failedUser || failedUser.role !== 'user') return
    setMessages((old) => old.filter((_, i) => i !== index && i !== index + 1))
    setAttachmentError('')
    setMediaConsent(false)
    setPrompt(failedUser.draftPrompt ?? failedUser.content)
  }

  const useStarter = (value) => { setPrompt(value); composerInput.current?.focus() }
  const transcribeAudioDraft = async () => {
    if (!audioDraft?.blob || !voiceModels.length) return
    setVoiceBusy(true); setError(null); setVoiceTranscript(null)
    try {
      const audioBase64 = await blobToBase64(audioDraft.blob)
      const transcript = await api.transcribeVoice({ model: voiceModel, audioBase64 })
      setVoiceTranscript(transcript)
    } catch (caught) { setError(caught) } finally { setVoiceBusy(false) }
  }
  const addTranscriptToDraft = () => {
    const text = voiceTranscript?.text?.trim()
    if (!text) return
    setPrompt((current) => current.trim() ? `${current.trim()}\n\n${text}` : text)
    composerInput.current?.focus()
  }
  const speakResponse = async (index, text) => {
    if (!voiceModels.length || !text?.trim()) return
    setVoiceBusy(true); setError(null)
    try {
      const result = await api.synthesizeVoice({ model: voiceModel, text: text.trim() })
      setSpokenResponses((current) => ({ ...current, [index]: result }))
    } catch (caught) { setError(caught) } finally { setVoiceBusy(false) }
  }
  const stopVoiceRecording = () => {
    if (recordingTimer.current) clearTimeout(recordingTimer.current)
    recordingTimer.current = null
    if (recorder.current?.state === 'recording') recorder.current.stop()
  }
  const startVoiceRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError(Error('This browser does not provide microphone recording. Upload a short WAV file instead.'))
      return
    }
    setError(null); setVoiceTranscript(null); setAudioDraft(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const activeRecorder = new MediaRecorder(stream)
      recordingStream.current = stream
      recorder.current = activeRecorder
      recordingChunks.current = []
      activeRecorder.ondataavailable = (event) => { if (event.data?.size) recordingChunks.current.push(event.data) }
      activeRecorder.onstop = async () => {
        setRecording(false)
        if (recordingTimer.current) clearTimeout(recordingTimer.current)
        recordingTimer.current = null
        stream.getTracks().forEach((track) => track.stop())
        recordingStream.current = null
        try {
          const blob = new Blob(recordingChunks.current, { type: activeRecorder.mimeType || 'audio/webm' })
          const wav = await recordedBlobToWav(blob)
          setAudioDraft({ name: 'microphone-recording.wav', size: wav.size, blob: wav })
        } catch (caught) { setError(caught) }
      }
      activeRecorder.onerror = () => setError(Error('The microphone recording failed.'))
      activeRecorder.start()
      setRecording(true)
      recordingTimer.current = setTimeout(stopVoiceRecording, VOICE_CAPTURE_LIMITS.durationSeconds * 1000)
    } catch (caught) {
      recordingStream.current?.getTracks().forEach((track) => track.stop())
      recordingStream.current = null
      setError(caught)
    }
  }
  const addToolResultToDraft = (value) => {
    setPrompt((current) => current.trim() ? `${current.trim()}\n\n${value}` : value)
    composerInput.current?.focus()
  }
  const attachChatFiles = async (event) => {
    const selected = Array.from(event.target.files ?? [])
    event.target.value = ''
    const additions = []
    const problems = []
    let chars = attachments.reduce((sum, file) => sum + (file.text?.length ?? 0), 0)
    let mediaBytes = attachments.filter((file) => ['image', 'audio', 'video'].includes(file.kind)).reduce((sum, file) => sum + file.size, 0)
    for (const file of selected) {
      if (attachments.length + additions.length >= CHAT_FILE_LIMITS.files) {
        problems.push(`Attach no more than ${CHAT_FILE_LIMITS.files} files per message.`)
        break
      }
      try {
        const attachment = await readChatAttachment(file)
        if (['image', 'audio', 'video'].includes(attachment.kind)) {
          if (selectedFirstParty || !(provider?.chatInputKinds ?? []).includes(attachment.kind)) {
            problems.push(`${attachment.kind} attachments cannot be sent through the currently selected Chat wire. Choose a compatible provider; there is no fallback.`)
            continue
          }
          if (mediaBytes + attachment.size > CHAT_FILE_LIMITS.mediaBytesTotal) {
            problems.push(`Binary attachments are limited to ${(CHAT_FILE_LIMITS.mediaBytesTotal / 1024 / 1024).toFixed(0)} MiB total.`)
            continue
          }
          mediaBytes += attachment.size
        } else {
          if (chars + (attachment.text?.length ?? 0) > CHAT_FILE_LIMITS.charsTotal) {
            problems.push(`Attached and extracted text is limited to ${CHAT_FILE_LIMITS.charsTotal.toLocaleString()} characters total.`)
            continue
          }
          chars += attachment.text?.length ?? 0
        }
        additions.push({ ...attachment, id: `${Date.now()}-${additions.length}-${attachment.name}` })
      } catch (caught) { problems.push(caught.message) }
    }
    if (additions.length) {
      setAttachments((current) => [...current, ...additions].slice(0, CHAT_FILE_LIMITS.files))
      setMediaConsent(false)
    }
    setAttachmentError(problems.join(' '))
  }
  const openSavedSession = (session) => {
    if (!session?.id || !Array.isArray(session.turns)) {
      setError(Error('This saved conversation could not be opened because its transcript was unavailable.'))
      return
    }
    setMessages(session.turns
      .filter((turn) => ['user', 'assistant'].includes(turn.role))
      .map((turn) => ({ role: turn.role, content: turn.content, historical: true })))
    setSpokenResponses({})
    setSessionId(session.id)
    setPrompt('')
    setAttachments([])
    setAttachmentError('')
    setLoadedSavedSessionHasMedia(session.turns.some((turn) => typeof turn.content === 'string' && /\[Attached (?:image|audio|video):/.test(turn.content)))
    setLoadedSavedSession(true)
    setMediaConsent(false)
    setError(null)
  }
  const handleDeletedSession = (id) => {
    if (id !== sessionId) return
    setMessages([])
    setSessionId(null)
    setLoadedSavedSession(false)
    setLoadedSavedSessionHasMedia(false)
    setPrompt('')
    setError(null)
  }

  return <div className="online-chat">
    {industryMode ? <Banner tone="info" title="Manufacturing Operations mode is active"><p>Safety-first context is added to this text Chat request for the selected Klyvaron or gateway model. This does not retrain model weights or guarantee correct advice. Retrieved files are included only when you separately enable Knowledge and approve context transfer; verify every action against approved site procedures.</p></Banner> : null}
    {industryUnsupported ? <Banner tone="bad" title="The selected Klyvaron model cannot use this mode"><p>Klyvaron Lite is a base completion model and does not follow instructions. Turn Manufacturing Operations mode off or select an instruction-tuned Chat model; Ragam will not switch models for you.</p></Banner> : null}
    <GettingStarted
      providerReady={Boolean(provider?.configured || selectedFirstParty)}
      modelReady={selectedModelReady}
      onSettings={onSettings}
      onUseExample={() => useStarter('Help me explain one idea clearly. Start with a simple example, note what you are unsure about, and ask me one follow-up question.')}
      onDismiss={() => setSetupGuideOpen(false)}
      hidden={!showSetupGuide}
    />
    {!showSetupGuide && !provider?.configured && firstPartyReady.length === 0 ? <Banner tone="info" title="Connect a model provider"><p>This build has provider adapters for OpenAI (ChatGPT), Google Gemini, Anthropic Claude, xAI (Grok), and more. Connect using your own API key. Ragam fetches the model IDs that key can access; no model names are invented. Provider API use may incur charges.</p><Button onClick={onSettings}>Choose a provider</Button></Banner> : null}
    <Panel className="chat-panel" title="Conversation">
      <div className="row between chat-toolbar">
        <div className="chat-model-fields">
        <Field label="Provider">
          <span className="chat-provider-value"><i className="chat-provider-dot" aria-hidden="true" />{selectedFirstParty ? 'Klyvaron Native' : (provider?.name ?? 'No provider connected')}</span>
        </Field>
        <Field label="Model" hint="Your exact selection is used. No silent substitution. The default is shared by everyone signed in here.">
          <select aria-label="Model" className="select" value={model} disabled={busy || saving || !hasSelectableModels} onChange={async (e) => { const next = e.target.value; setSaving(true); setError(null); try { await api.selectModel(next); setModel(next); setMediaConsent(false); setToolsConsent(false); setNativeSearchConsent(false); await refreshReadiness?.() } catch (err) { setError(err) } finally { setSaving(false) } }}>
            <option value="" disabled>Choose a model</option>
            {firstPartyReady.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName ?? entry.id}</option>)}
            {firstPartyUnavailable.map((entry) => <option key={entry.id} value={entry.id} disabled>{entry.label ?? entry.id} ({entry.id}) — {entry.status}</option>)}
            {gatewayModels.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </Field>
        </div>
        <div className="chat-toolbar-actions">
          <span className="chat-online-label"><i aria-hidden="true" />Online</span>
          <Button className="ghost small" type="button" aria-expanded={showSetupGuide} aria-controls="chat-getting-started" onClick={() => setSetupGuideOpen(!showSetupGuide)}>Setup guide</Button>
          <Button disabled={busy} onClick={() => { setMessages([]); setSpokenResponses({}); setSessionId(null); setLoadedSavedSession(false); setLoadedSavedSessionHasMedia(false); setMediaConsent(false); setToolsConsent(false); setNativeSearchConsent(false); setError(null); setPrompt(''); setAttachments([]); setAttachmentError('') }}>New conversation</Button>
          <Button className="chat-settings-button" disabled={busy} onClick={onSettings}>Provider Settings</Button>
        </div>
      </div>
      <p className="small chat-model-note">
        {selectedFirstParty
          ? `First-party weights ${selectedFirstParty.id} (${selectedFirstParty.parameters.toLocaleString('en-US')} params · SHA-256 ${selectedFirstParty.weightsSha256.slice(0, 16)}…) · verified in-host without external transfer.`
          : `${provider?.baseUrl || 'No gateway configured'} · Listed models are not inference-verified until a request succeeds.`}
      </p>
      {selectedModelEvidence?.capabilities ? <p className="small chat-capability-evidence" aria-label="Selected model capability evidence">
        Provider catalogue for {selectedModelEvidence.name ?? model}: input {(selectedModelEvidence.capabilities.input ?? ['unknown']).join(', ')}, output {(selectedModelEvidence.capabilities.output ?? ['unknown']).join(', ')}, streaming {selectedModelEvidence.capabilities.streaming ?? 'unknown'}, image input {selectedModelEvidence.capabilities.imageInput ?? 'unknown'}, tools {provider?.chatTools && selectedModelEvidence.capabilities.tools === 'not_exposed_by_ragam' ? 'unknown' : selectedModelEvidence.capabilities.tools ?? 'unknown'}.
        {selectedModelEvidence.capabilities.provenance?.source ? ` Evidence source: ${selectedModelEvidence.capabilities.provenance.source}.` : ''}
        {' '}Catalogue metadata is not an inference or modality test. This wire accepts function schemas, but the selected model may not support them. Search and function calls are opt-in; any returned function call is a proposal, never automatic execution.
      </p> : model && !selectedFirstParty ? <p className="small chat-capability-evidence">This provider has not supplied capability evidence for the selected model. Ragam does not infer image, search, audio or tool support from a model name.</p> : null}
      {loadedSavedSession ? <p className="small chat-history-disclosure" role="status">Saved conversation opened. The earlier provider/model was not recorded. When you press Send, this visible transcript will be sent to the currently selected model.{loadedSavedSessionHasMedia ? ' Earlier binary media is not stored in history; reattach it if you want the model to inspect it again.' : ''}</p> : null}
      <div className="thread" ref={thread} aria-live="polite" aria-label="Conversation transcript">
        {messages.length ? messages.map((m, i) => (
          <div className={`message ${m.role}`} data-role={m.role} key={i}>
            <div className="message-head">
              <strong className="message-role">{m.historical && m.role === 'assistant' ? 'Earlier assistant reply' : m.role === 'user' ? 'You' : m.meta?.modelId ?? model}</strong>
              {m.content ? <div className="message-actions" style={{ marginLeft: 'auto' }}>
                <CopyButton text={m.content} label="Copy" className="ghost small" />
                {m.role === 'assistant' && !m.pending && voiceModels.length ? <Button className="ghost small" disabled={voiceBusy} busy={voiceBusy} onClick={() => speakResponse(i, m.content)}>Speak with local voice</Button> : null}
              </div> : null}
            </div>
            <div className="message-body message-text" style={{ whiteSpace: 'pre-wrap' }}>{m.content || (m.pending ? (selectedFirstParty ? 'Generating with verified first-party weights…' : 'Waiting for the gateway…') : 'No completed response.')}</div>
            {m.meta?.toolCalls?.length ? <div className="chat-tool-proposals" role="status"><strong>Provider function-call proposals — not executed</strong><p className="small">Review these untrusted model-proposed arguments. No provider or MCP tool runs unless you separately choose it in the manual tool panel.</p>{m.meta.toolCalls.map((call, index) => <details key={`${call.name}-${index}`}><summary>{call.name}</summary><pre className="code">{JSON.stringify(call.arguments, null, 2)}</pre></details>)}</div> : null}
            {(() => { const sources = m.meta?.grounding?.sources ?? m.meta?.grounding?.provider?.sources ?? []; return sources.length ? <div className="chat-grounding-sources"><strong>Provider search sources</strong><ul>{sources.map((source, index) => <li key={`${source.url}-${index}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a></li>)}</ul><small>Sources were returned by the provider; verify them independently.</small></div> : null })()}
            {spokenResponses[i]?.audioBase64 ? <audio className="chat-spoken-response" controls src={`data:audio/wav;base64,${spokenResponses[i].audioBase64}`} aria-label="Locally synthesized response audio" /> : null}
            {m.attachments?.length ? <small>Attached: {m.attachments.map((file) => `${file.kind} ${file.name}`).join(', ')}. Binary content is not stored in this transcript.</small> : null}
            {m.failed ? <small>Not completed {m.role === 'user' ? <Button className="ghost small" onClick={() => retry(i)}>Retry</Button> : null}</small> : null}
            {m.meta ? (m.meta.firstPartyWeights ? <small>Served by verified first-party Klyvaron weights ({m.meta.modelId} · SHA-256 {m.meta.weightsSha256?.slice(0, 12)}… · {m.meta.tokensPerSecond} tok/s · sentExternally: false){m.meta.differentiators ? ` · verdict: ${m.meta.differentiators.verdict} · state: ${m.meta.differentiators.state}` : ''}</small> : <small>Executed online via {m.meta.provider ?? provider?.name ?? 'the gateway'}{m.meta.redaction?.findings?.length ? ' · credentials redacted' : ''}</small>) : null}
            {typeof m.meta?.providerModel === 'string' && m.meta.providerModel !== m.meta.modelId ? <small>Reported model: {m.meta.providerModel}</small> : null}
            {m.meta?.industryMode === 'manufacturing' ? <small>Manufacturing Operations guidance was applied to this text Chat request; verify the answer against your approved procedures.</small> : null}
            {m.meta?.skill ? <small>Procedure used: {m.meta.skill.name} v{m.meta.skill.version}</small> : null}
            {m.meta?.styleAudit && !m.meta.styleAudit.ok ? <small>Style check: {m.meta.styleAudit.violations.join(', ')}. The answer is shown unchanged; it was not rewritten.</small> : null}
            {m.meta?.grounding?.citations?.length ? <details><summary>File references sent with this request</summary><ul>{m.meta.grounding.citations.map((c, index) => <li key={index}>{c.ref} · {c.title ?? c.documentId}</li>)}</ul></details> : null}
          </div>
        )) : <div className="chat-welcome">
          <div className="chat-welcome-mark" aria-hidden="true"><span>R</span><i /></div>
          <p className="chat-welcome-eyebrow">RAGAM · YOUR WORKSPACE</p>
          <h2>{profile?.name ? `What would you like to work through, ${profile.name}?` : 'What would you like to work through?'}</h2>
          <p className="chat-welcome-copy">{profile?.profession ? `A few starting points for ${profile.profession}. Choose one to draft a prompt; nothing is sent until you press Send.` : 'Choose an available model, then start with a question or one of these ideas. Nothing is sent until you press Send.'}</p>
          {!profile?.profession ? <Button className="ghost small profile-welcome-action" type="button" onClick={onProfile}>Add your name and profession for tailored ideas</Button> : null}
          <div className="chat-starter-grid" aria-label="Draft prompt ideas">
            {recommendations.map((item) => <button className="chat-starter" type="button" key={item.id} onClick={() => useStarter(item.prompt)}>
              <span className="chat-starter-number">{item.number}</span>
              <span className="chat-starter-copy"><strong>{item.title}</strong><small>{item.detail}</small></span>
              <span className="chat-starter-arrow" aria-hidden="true">↗</span>
            </button>)}
          </div>
        </div>}
      </div>
      {error ? <Banner tone="bad" title={error.message} /> : null}
      <form onSubmit={send}>
        <div className="composer">
          <div className="composer-row">
            <textarea
              ref={composerInput}
              className="textarea"
              aria-label="Message your selected model"
              value={prompt}
              onChange={(e) => { setPrompt(e.target.value); setMediaConsent(false) }}
              placeholder="Message your selected model…"
              maxLength={100000}
              disabled={busy}
              rows={1}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e) }
              }}
            />
          </div>
          <div className="chat-attachment-box">
            <p className="small">Attach up to {CHAT_FILE_LIMITS.files} files. Text/PDF extraction stays in this browser; the extracted text joins your message only when you press Send. Images, audio and video are encoded only when you press Send, after the per-turn transfer approval below. Binary media is not saved in conversation history. File selection never calls a provider. Actual model modality may be unknown; unsupported models can refuse, with no fallback. Vendor use may incur charges.</p>
            <Field label="Attach text, PDF, image, audio or video">
              <input
                aria-label="Attach files to this message"
                type="file"
                accept=".txt,.md,.csv,.json,.log,.pdf,.jpg,.jpeg,.png,.webp,.gif,.wav,.mp3,.m4a,.ogg,.flac,.mp4,.webm,text/plain,text/markdown,text/csv,application/json,application/pdf,image/jpeg,image/png,image/webp,image/gif,audio/*,video/mp4,video/webm"
                multiple
                disabled={busy || attachments.length >= CHAT_FILE_LIMITS.files}
                onChange={attachChatFiles}
              />
            </Field>
            {attachmentError ? <p className="small chat-attachment-error" role="status">{attachmentError}</p> : null}
            {attachments.length ? <ul className="chat-attachment-list" aria-label="Attached files">{attachments.map((file) => <li key={file.id}>
              <div><strong>{file.name}</strong> <span className="small">{file.kind} · {file.size.toLocaleString()} bytes · inspected in this browser</span>
                {file.text !== undefined ? <details><summary>Review extracted text before sending</summary><pre className="code chat-attachment-preview">{file.text}</pre></details> : null}
                {file.kind === 'image' ? <details><summary>Preview image locally</summary><img className="chat-attachment-image" src={`data:${file.mimeType};base64,${file.data}`} alt={`Local preview of ${file.name}`} /></details> : null}
                {file.kind === 'audio' ? <details><summary>Preview audio locally</summary><audio controls src={`data:${file.mimeType};base64,${file.data}`} /></details> : null}
                {file.kind === 'video' ? <details><summary>Preview video locally</summary><video controls preload="metadata" src={`data:${file.mimeType};base64,${file.data}`} /></details> : null}
              </div>
              <Button type="button" className="ghost small" aria-label={`Remove ${file.name}`} disabled={busy} onClick={() => { setAttachments((current) => current.filter((item) => item.id !== file.id)); setMediaConsent(false) }}>Remove</Button>
            </li>)}</ul> : null}
            {attachments.some((file) => ['image', 'audio', 'video'].includes(file.kind)) ? <label className="checkbox chat-media-consent"><input type="checkbox" checked={mediaConsent} disabled={busy} onChange={(event) => setMediaConsent(event.target.checked)} />I approve sending these selected binary attachments to {provider?.name ?? 'the selected provider'} with this one Chat request. The selected model's support may be unknown and the provider may retain data or charge for use.</label> : null}
          </div>
          {provider?.chatNativeSearch && !selectedFirstParty ? <label className="checkbox chat-media-consent"><input type="checkbox" checked={nativeSearchConsent} disabled={busy} onChange={(event) => setNativeSearchConsent(event.target.checked)} />I approve provider-native web search for this one request to {provider?.name ?? 'the selected provider'}. The provider and its search service may receive the query and prompt context; data may be retained and charges may apply. OpenAI-compatible endpoints must implement Responses API web search; OpenRouter uses its documented openrouter:web_search tool. No Chat Completions fallback is attempted. Search is not enabled unless checked.</label> : null}
          {offeredTools.length && !selectedFirstParty ? <label className="checkbox chat-media-consent"><input type="checkbox" checked={toolsConsent} disabled={busy || !provider?.chatTools} onChange={(event) => setToolsConsent(event.target.checked)} />I approve sending {offeredTools.length} selected MCP function schema{offeredTools.length === 1 ? '' : 's'} to {provider?.name ?? 'the selected provider'} for this request. The model may propose a call; Ragam will never execute it automatically.</label> : null}
          {offeredTools.length && !provider?.chatTools ? <p className="small">The current Chat wire cannot receive function tool schemas. Choose a supported provider; no fallback occurs.</p> : null}
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
            {busy ? <Button variant="danger" onClick={() => abort.current?.abort()}>Stop generation</Button> : <Button type="submit" variant="primary" disabled={saving || !model || industryUnsupported || (!prompt.trim() && !attachments.length)}>Send</Button>}
          </div>
        </div>
        <div className="chat-composer-foot"><span>Enter to send <b>·</b> Shift + Enter for a new line</span><span>{selectedFirstParty ? 'Processed on this Core host · no external transfer' : 'Sent to the selected provider · charges and retention policies may apply'}</span></div>
      </form>
    </Panel>
    <details className="context-section">
      <summary>Voice input &amp; spoken replies (local, explicit)</summary>
      <Panel title="Klyvaron Voice (Bidirectional Neural TTS + ASR)">
        <p className="small">
          {voiceModels.length
            ? `Verified first-party voice models ready: ${voiceModels.join(', ')}. Recording, transcription and speech synthesis run on this Core host with the installed 16 kHz model; no audio is sent to a cloud provider. Recording starts only when you press Start recording.`
            : 'No verified first-party voice model checkpoint installed in this workspace yet. Uploading, recording and transcription controls stay disabled.'}
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
              setVoiceBusy(true); setError(null); setVoiceTranscript(null)
              try {
                const transcript = await api.transcribeVoice({ model: voiceModel, sourceJobId: voiceSynthResult.jobId ?? voiceSynthResult.job.id })
                setVoiceTranscript(transcript)
              } catch (caught) { setError(caught) } finally { setVoiceBusy(false) }
            }}>Transcribe generated speech locally</Button>
          ) : null}
          <Field label="Upload audio for local review" hint="Audio is normalized in this browser. It is sent to the local Core only when you press Transcribe locally.">
            <input aria-label="Choose audio for local transcription" type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm" disabled={voiceBusy || recording || !voiceModels.length} onChange={async (event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              setVoiceBusy(true); setError(null); setVoiceTranscript(null)
              try {
                if (file.size > VOICE_CAPTURE_LIMITS.bytes) throw Error('Audio input is limited to 2 MiB.')
                const wav = await recordedBlobToWav(file)
                setAudioDraft({ name: file.name, size: wav.size, blob: wav })
              } catch (caught) { setError(caught) } finally { setVoiceBusy(false) }
            }} />
          </Field>
          {canRecordVoice ? <Button disabled={voiceBusy || recording || !voiceModels.length} onClick={startVoiceRecording}>Start recording (max 30 seconds)</Button> : null}
          {recording ? <Button variant="danger" onClick={stopVoiceRecording}>Stop recording</Button> : null}
          {audioDraft ? <>
            <p className="small">Ready for local transcription: {audioDraft.name} · {audioDraft.size.toLocaleString()} bytes. Nothing has been transcribed or sent yet.</p>
            {audioPreviewUrl ? <audio controls src={audioPreviewUrl} aria-label="Review selected audio before transcription" /> : null}
            <Button disabled={voiceBusy || !voiceModels.length} busy={voiceBusy} onClick={transcribeAudioDraft}>Transcribe locally</Button>
          </> : null}
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
          <div className="voice-transcript-review" role="status">
            <p className="small">Review this locally produced transcript before using it: <strong>{voiceTranscript.text}</strong>{voiceTranscript.nearestCommand ? ` · command: ${voiceTranscript.nearestCommand}` : ''} (confidence {(Number(voiceTranscript.commandConfidence ?? voiceTranscript.utteranceConfidence ?? 0) * 100).toFixed(1)}%)</p>
            <Button className="ghost small" disabled={!voiceTranscript.text?.trim()} onClick={addTranscriptToDraft}>Add reviewed transcript to Chat draft</Button>
          </div>
        ) : null}
      </Panel>
    </details>
    <details className="context-section"><summary>Conversation history</summary><HistoryPanel sessionId={sessionId} onOpen={openSavedSession} onDelete={handleDeletedSession} disabled={busy || saving} /></details>
    <details className="context-section"><summary>Use a connected MCP tool (manual, optional)</summary><ChatToolRunner onAddResult={addToolResultToDraft} onToolsChange={setOfferedTools} /></details>
    <details className="context-section"><summary>Optional files & knowledge</summary><KnowledgePanel /></details>
    <details className="context-section"><summary>Optional approved memory</summary><MemoryPanel /></details>
    <details className="context-section"><summary>Reviewed procedure (optional)</summary><SkillsPanel value={skill} onChange={setSkill} account={account} model={model} provider={provider} /></details>
    <details className="context-section">
      <summary>Create or adapt model weights (your computer · explicit opt-in)</summary>
      <p className="small">Provider Settings registers existing inference endpoints and their listed models. This separate workflow plans user-authorized adaptation or training on your paired computer; it does not create a provider endpoint or mark third-party weights as Klyvaron.</p>
      <UserTrainingPanel readiness={readiness} refreshReadiness={refreshReadiness} />
    </details>
  </div>
}
