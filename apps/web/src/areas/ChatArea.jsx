import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, streamChat } from '../api.js'
import { Banner, Button, CopyButton, Field, Panel } from '../components/ui.jsx'
import { KnowledgePanel, MemoryPanel, HistoryPanel, SkillsPanel } from '../components/ContextPanels.jsx'
import GettingStarted from '../components/GettingStarted.jsx'
import ChatToolRunner from '../components/ChatToolRunner.jsx'
import { recommendationsForProfile } from '../profile.js'
import { CHAT_FILE_LIMITS, messageWithChatFiles, readChatAttachment } from '../chat-files.js'
import { CHAT_TRANSCRIPT_SEARCH_LIMIT, cleanPinnedIds, contextLimitLabel, downloadMarkdownFile, highlightSegments, isClearSearchKey, isSearchShortcut, isStopShortcut, messageText, normalizeSearchQuery, outputLimitLabel, replaceLastMessage, replaceLastTurn, selectVisibleMessages, transcriptToMarkdown, validateStructuredOutput, withMessageId } from '../chat-transcript.js'
import { setSetupGuideDismissed, setupGuideDismissed } from '../onboarding.js'

const LOCAL_CHAT_CONNECTIONS = new Set(['ollama', 'llamacpp', 'vllm', 'localai'])
const PROCESSOR_PROFILE_TASK_LIMITS = Object.freeze({ lite: 2, pro: 5, max: 8 })
const PROCESSOR_TASK_OPTIONS = Object.freeze([
  { id: 'summarize', label: 'Extractive summary' }, { id: 'inspect', label: 'Inspect input' },
  { id: 'extract', label: 'Pattern-based extraction' }, { id: 'outline', label: 'Build outline' },
  { id: 'retrieve', label: 'Retrieve local knowledge' }, { id: 'answer', label: 'Show local evidence for a query (no generated answer)' },
  { id: 'compare', label: 'Compare text lexically' }, { id: 'calculate', label: 'Calculate arithmetic' },
])
const BUILT_IN_RECOMMENDATIONS = [
  { id: 'summarize', number: '01', title: 'Summarize a passage', detail: 'Select informative sentences from the original text', prompt: 'Summarize the most informative original sentences in this passage:\n\n' },
  { id: 'inspect', number: '02', title: 'Inspect supplied text', detail: 'See bounded counts, structure and input metadata', prompt: 'Inspect this text and report its bounded metadata:\n\n' },
  { id: 'extract', number: '03', title: 'Extract common patterns', detail: 'Find supported dates, email addresses, URLs and phone-like strings', prompt: 'Extract supported dates, email addresses, URLs and phone-like strings from this text:\n\n' },
  { id: 'outline', number: '04', title: 'Build a short outline', detail: 'Create an outline from headings and source sentences', prompt: 'Build a short outline from the following text:\n\n' },
]

export default function ChatArea({ provider, readiness, refreshReadiness, onSettings, onProfile, profile, account, industryMode = false, localOnlyMode = false, industryPrompt = '', onIndustryPromptConsumed }) {
  const gatewayModels = provider?.models ?? []
  const hasSelectableModels = gatewayModels.length > 0
  const preferredDefault = readiness?.provider?.selectedModel || provider?.selectedModel || ''

  const [messages, setMessages] = useState([]), [prompt, setPrompt] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(null)
  const [model, setModel] = useState(preferredDefault), [saving, setSaving] = useState(false)
  const [loadedSavedSession, setLoadedSavedSession] = useState(false), [loadedSavedSessionHasMedia, setLoadedSavedSessionHasMedia] = useState(false)
  const [showSetupGuide, setShowSetupGuide] = useState(() => !setupGuideDismissed())
  const [attachments, setAttachments] = useState([]), [attachmentError, setAttachmentError] = useState(''), [mediaConsent, setMediaConsent] = useState(false)
  const [offeredTools, setOfferedTools] = useState([]), [toolsConsent, setToolsConsent] = useState(false), [nativeSearchConsent, setNativeSearchConsent] = useState(false)
  const [useKnowledge, setUseKnowledge] = useState(false), [useMemory, setUseMemory] = useState(false), [allowSensitive, setAllowSensitive] = useState(false)
  const [processingMode, setProcessingMode] = useState('klyvaron')
  const [processorTier, setProcessorTier] = useState('lite'), [processorTask, setProcessorTask] = useState('summarize')
  const [processorAdditionalTasks, setProcessorAdditionalTasks] = useState([])
  const processorTasks = [processorTask, ...processorAdditionalTasks.filter((task) => task !== processorTask)]
  const processorTaskLimitExceeded = processorTasks.length > PROCESSOR_PROFILE_TASK_LIMITS[processorTier]
  const modelIndependent = processingMode === 'klyvaron'
  const recommendations = modelIndependent ? BUILT_IN_RECOMMENDATIONS : recommendationsForProfile(profile)
  const [comparisonInput, setComparisonInput] = useState(''), [saveProcessedInput, setSaveProcessedInput] = useState(false)
  const [searchQuery, setSearchQuery] = useState(''), [pinnedIds, setPinnedIds] = useState(new Set()), [pinnedOnly, setPinnedOnly] = useState(false)
  const [structuredOutputCheck, setStructuredOutputCheck] = useState(false), [transcriptNotice, setTranscriptNotice] = useState('')
  const [temperature, setTemperature] = useState('0.2'), [maxTokens, setMaxTokens] = useState('512'), [sessionId, setSessionId] = useState(null), [skill, setSkill] = useState(''), [style, setStyle] = useState(''), [styles, setStyles] = useState([])
  const abort = useRef(null), thread = useRef(null), composerInput = useRef(null), searchInput = useRef(null)
  const normalizedSearchQuery = normalizeSearchQuery(searchQuery)
  const visibleMessages = useMemo(() => selectVisibleMessages(messages, { query: normalizedSearchQuery, pinnedOnly, pinnedIds }), [messages, normalizedSearchQuery, pinnedOnly, pinnedIds])
  const pinnedMessages = useMemo(() => messages.map((message, index) => ({ message, index })).filter(({ message }) => pinnedIds.has(message.id)), [messages, pinnedIds])

  useEffect(() => {
    setModel(readiness?.provider?.selectedModel || provider?.selectedModel || '')
  }, [readiness?.provider?.selectedModel, provider?.selectedModel, provider?.revision])
  useEffect(() => () => {
    abort.current?.abort()
  }, [])
  // The preference is read from the server, never inferred from what is typed here.
  useEffect(() => { api.styles().then((data) => { setStyles(data.styles); setStyle(data.preference?.style ?? '') }).catch(() => {}) }, [])
  useEffect(() => { if (thread.current) thread.current.scrollTop = thread.current.scrollHeight }, [messages])
  useEffect(() => {
    setPinnedIds((current) => {
      const next = cleanPinnedIds(current, messages)
      return next.size === current.size && [...current].every((id) => next.has(id)) ? current : next
    })
  }, [messages])
  useEffect(() => { if (pinnedOnly && pinnedMessages.length === 0) setPinnedOnly(false) }, [pinnedOnly, pinnedMessages.length])
  useEffect(() => {
    if (!industryPrompt) return
    setPrompt(industryPrompt)
    onIndustryPromptConsumed?.()
  }, [industryPrompt, onIndustryPromptConsumed])
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onKeyDown = (event) => {
      if (isSearchShortcut(event)) {
        event.preventDefault()
        searchInput.current?.focus()
        searchInput.current?.select?.()
        return
      }
      if (isStopShortcut(event) && busy) {
        event.preventDefault()
        abort.current?.abort()
        return
      }
      if (isClearSearchKey(event) && (searchQuery || pinnedOnly)) {
        event.preventDefault()
        setSearchQuery('')
        setPinnedOnly(false)
        setTranscriptNotice('')
        composerInput.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, searchQuery, pinnedOnly])

  const selectedModelEvidence = provider?.modelDetails?.find((entry) => entry.id === model) ?? null
  const industryUnsupported = Boolean(!modelIndependent && industryMode && selectedModelEvidence?.instructionTuned === false)
  const localOnlyUnsupported = Boolean(!modelIndependent && localOnlyMode && !LOCAL_CHAT_CONNECTIONS.has(provider?.kind))
  const selectedModelReady = Boolean(model && gatewayModels.includes(model))
  const setSetupGuideOpen = (open) => {
    setShowSetupGuide(open)
    setSetupGuideDismissed(!open)
  }

  const send = async (event) => {
    event.preventDefault(); if (busy || saving || (!prompt.trim() && !attachments.length) || (!modelIndependent && !model)) return
    if (modelIndependent && processorTaskLimitExceeded) { setError(Error(`The ${processorTier.toUpperCase()} profile permits at most ${PROCESSOR_PROFILE_TASK_LIMITS[processorTier]} task(s). Remove a processing step or choose a larger profile.`)); return }
    if (modelIndependent && processorTasks.includes('compare') && !comparisonInput.trim()) { setError(Error('Add comparison text for the lexical comparison task.')); return }
    if (!modelIndependent && localOnlyUnsupported) { setError(Error('Local-only mode blocks this provider. Select an allowed self-hosted local endpoint, or turn Local-only off to use remote APIs that may bill.')); return }
    if (!modelIndependent && industryUnsupported) { setError(Error('Manufacturing Operations mode needs a model documented as instruction-tuned. Switch the mode off or choose a compatible Chat model.')); return }
    const content = messageWithChatFiles(prompt, attachments)
    const mediaAttachments = attachments.filter((file) => ['image', 'audio', 'video'].includes(file.kind))
    if (modelIndependent && mediaAttachments.length) {
      setError(Error('The built-in Klyvaron processor handles text and locally extracted document text only. It does not interpret image, audio or video bytes.'))
      return
    }
    const allowedMediaKinds = new Set(provider?.chatInputKinds ?? [])
    const unsupportedMedia = mediaAttachments.filter((file) => !allowedMediaKinds.has(file.kind))
    if (unsupportedMedia.length) {
      setError(Error(`The selected Chat wire cannot send ${[...new Set(unsupportedMedia.map((file) => file.kind))].join(', ')} attachments. Choose a compatible listed provider; no fallback will occur.`))
      return
    }
    if (mediaAttachments.length && !mediaConsent) {
      setError(Error('Before sending, confirm that these selected media files may be transferred to the selected provider.'))
      return
    }
    if (!modelIndependent && nativeSearchConsent && !provider?.chatNativeSearch) {
      setError(Error('Provider-native search is not available on the selected Chat wire.'))
      return
    }
    if (!modelIndependent && toolsConsent && offeredTools.length && !provider?.chatTools) {
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
    const userMessage = withMessageId({ role: 'user', content, draftPrompt: prompt, attachments: attachmentLabels })
    const assistantMessage = withMessageId({ role: 'assistant', content: '', pending: true })
    setBusy(true); setError(null); setAllowSensitive(false)
    setMessages((old) => [...old, userMessage, assistantMessage])
    let text = '', completed = false
    try {
      let id = sessionId
      if (!id) { const s = await api.startSession(content.slice(0, 80), { signal: controller.signal }); id = s.id; setSessionId(id) }
      if (modelIndependent) {
        const result = await api.processKlyvaron({
          tier: processorTier,
          input: providerText,
          tasks: processorTasks,
          ...(processorTasks.includes('compare') ? { comparisonInput } : {}),
          useKnowledge,
          useMemory,
          saveToKnowledge: saveProcessedInput,
          title: `Klyvaron ${processorTasks.join(' + ')} input`,
          sessionId: id,
        }, { signal: controller.signal })
        text = result.text
        completed = true
        setMessages((old) => replaceLastMessage(old, { role: 'assistant', content: result.text, meta: result, pending: false }))
      } else {
        await streamChat({
        messages: history,
        model,
        localOnly: localOnlyMode,
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
          if (name === 'delta') { text += data.text; setMessages((old) => replaceLastMessage(old, { role: 'assistant', content: text, pending: true, failed: false })) }
          if (name === 'done') { completed = true; setMessages((old) => replaceLastMessage(old, { role: 'assistant', content: data.text, meta: data, pending: false, failed: false })) }
        },
      })
      }
      if (!completed) throw Error('The response did not complete. Your draft is retained.')
      setPrompt((draft) => draft.trim() === prompt.trim() ? '' : draft)
      setAttachments([])
      setAttachmentError('')
    } catch (e) {
      setError(controller.signal.aborted ? Error('Generation stopped. Partial output is not saved to history; your draft is retained.') : e)
      setMessages((old) => replaceLastTurn(old, { failed: true }, { content: text, failed: true, pending: false }))
    } finally { abort.current = null; setBusy(false); setMediaConsent(false); setToolsConsent(false); setNativeSearchConsent(false); setSaveProcessedInput(false); refreshReadiness?.() }
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

  const useStarter = (value, task) => {
    if (modelIndependent && PROCESSOR_PROFILE_TASK_LIMITS[processorTier] && PROCESSOR_TASK_OPTIONS.some((item) => item.id === task)) setProcessorTask(task)
    setPrompt(value)
    composerInput.current?.focus()
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
          if (!(provider?.chatInputKinds ?? []).includes(attachment.kind)) {
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
  const clearTranscriptState = () => {
    setSearchQuery('')
    setPinnedIds(new Set())
    setPinnedOnly(false)
    setTranscriptNotice('')
  }
  const togglePinned = (id) => {
    if (!id) return
    setPinnedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const exportCurrentTranscript = () => {
    const markdown = transcriptToMarkdown(visibleMessages.map(({ message }) => message), {
      query: normalizedSearchQuery,
      pinnedOnly,
      pinnedIds,
    })
    const exported = downloadMarkdownFile(markdown)
    setTranscriptNotice(exported
      ? `Exported ${visibleMessages.length} visible message${visibleMessages.length === 1 ? '' : 's'} as Markdown.`
      : 'This browser blocked the local Markdown export. No data left the page.')
  }
  const renderMessageText = (message) => {
    const fallback = message.pending
      ? (modelIndependent ? 'Processing with deterministic Klyvaron workflows…' : 'Waiting for the gateway…')
      : 'No completed response.'
    const text = messageText(message) || fallback
    if (!normalizedSearchQuery) return text
    return highlightSegments(text, normalizedSearchQuery).map((segment, index) => segment.match
      ? <mark className="chat-search-hit" key={index}>{segment.text}</mark>
      : <span key={index}>{segment.text}</span>)
  }
  const structuredValidationFor = (message) => structuredOutputCheck && message.role === 'assistant' && !message.pending
    ? validateStructuredOutput(messageText(message))
    : null

  const openSavedSession = (session) => {
    if (!session?.id || !Array.isArray(session.turns)) {
      setError(Error('This saved conversation could not be opened because its transcript was unavailable.'))
      return
    }
    setMessages(session.turns
      .filter((turn) => ['user', 'assistant'].includes(turn.role))
      .map((turn) => withMessageId({ role: turn.role, content: turn.content, historical: true })))
    setSessionId(session.id)
    setPrompt('')
    setAttachments([])
    setAttachmentError('')
    setLoadedSavedSessionHasMedia(session.turns.some((turn) => typeof turn.content === 'string' && /\[Attached (?:image|audio|video):/.test(turn.content)))
    setLoadedSavedSession(true)
    setMediaConsent(false)
    setError(null)
    clearTranscriptState()
  }
  const handleDeletedSession = (id) => {
    if (id !== sessionId) return
    setMessages([])
    setSessionId(null)
    setLoadedSavedSession(false)
    setLoadedSavedSessionHasMedia(false)
    setPrompt('')
    setError(null)
    clearTranscriptState()
  }

  return <div className="online-chat">
    {localOnlyMode ? <Banner tone="info" title="Local-only mode is active"><p>{modelIndependent ? 'The built-in Klyvaron processor runs deterministic text workflows on this Core host without a model, provider, or network request.' : 'Remote gateways are blocked for this request. Only an allowed self-hosted local Chat endpoint can run; no external model provider is contacted.'}</p></Banner> : null}
    {localOnlyUnsupported ? <Banner tone="warn" title="Selected model is remote"><p>Local-only mode prevents sending this Chat request to {provider?.name ?? 'the selected provider'}. Choose an allowed local model or turn Local-only off; remote APIs may bill.</p></Banner> : null}
    {industryMode ? <Banner tone="info" title="Manufacturing Operations mode is active"><p>{modelIndependent ? 'The deterministic Klyvaron processor can inspect or summarize supplied text, but it does not provide manufacturing advice or operate equipment.' : 'Safety-first context is added to this text Chat request for the selected gateway model. This does not train model weights or guarantee correct advice. Retrieved files are included only when you separately enable Knowledge and approve context transfer; verify every action against approved site procedures.'}</p></Banner> : null}
    {industryUnsupported ? <Banner tone="bad" title="The selected model cannot use this mode"><p>The provider's catalogue does not mark this model as instruction-tuned. Turn Manufacturing Operations mode off or choose a compatible Chat model; Ragam will not switch models for you.</p></Banner> : null}
    <GettingStarted
      providerReady={Boolean(provider?.configured)}
      modelReady={selectedModelReady}
      modelIndependent={modelIndependent}
      onSettings={onSettings}
      onUseExample={() => useStarter('The project stores supplied knowledge in an account-isolated local index. Retrieval uses deterministic token ranking. A user can delete saved knowledge at any time.')}
      onDismiss={() => setSetupGuideOpen(false)}
      hidden={!showSetupGuide}
    />
    {!modelIndependent && !showSetupGuide && !provider?.configured ? <Banner tone="info" title="Connect an optional model provider"><p>Klyvaron works without a model. If you switch to the optional provider engine, connect using your own API key. Provider API use may incur charges and follow that provider's policies.</p><Button onClick={onSettings}>Choose a provider</Button></Banner> : null}
    <Panel className="chat-panel" title="Conversation">
      <div className="row between chat-toolbar">
        <div className="chat-model-fields">
        <Field label="Processing engine">
          <select aria-label="Processing engine" className="select" value={processingMode} disabled={busy} onChange={(event) => { setProcessingMode(event.target.value); setMediaConsent(false); setError(null) }}>
            <option value="klyvaron">Klyvaron built-in (no AI model)</option>
            <option value="provider">Optional connected AI provider</option>
          </select>
        </Field>
        {modelIndependent ? <>
          <Field label="Klyvaron tier">
            <select aria-label="Klyvaron tier" className="select" value={processorTier} disabled={busy} onChange={(event) => setProcessorTier(event.target.value)}>
              <option value="lite">Lite · concise local workflows</option>
              <option value="pro">Pro · larger context and multi-step workflows</option>
              <option value="max">Max · largest bounded workflows</option>
            </select>
          </Field>
          <Field label="Processing task">
            <select aria-label="Klyvaron processing task" className="select" value={processorTask} disabled={busy} onChange={(event) => {
              const next = event.target.value
              setProcessorTask(next)
              setProcessorAdditionalTasks((current) => current.filter((task) => task !== next))
            }}>
              {PROCESSOR_TASK_OPTIONS.map((task) => <option key={task.id} value={task.id}>{task.label}</option>)}
            </select>
          </Field>
          <details className="processor-task-details">
            <summary>Additional independent steps ({processorTasks.length - 1} selected)</summary>
            <p className="small">Selected tasks each process the same input independently; they are not chained. {processorTier.toUpperCase()} allows up to {PROCESSOR_PROFILE_TASK_LIMITS[processorTier]} task(s). Retrieval uses local account data only when you separately opt in below.</p>
            <div role="group" aria-label="Additional independent Klyvaron tasks">
              {PROCESSOR_TASK_OPTIONS.filter((task) => task.id !== processorTask).map((task) => {
                const checked = processorAdditionalTasks.includes(task.id)
                const atLimit = processorTasks.length >= PROCESSOR_PROFILE_TASK_LIMITS[processorTier]
                return <label className="checkbox" key={task.id}>
                  <input type="checkbox" checked={checked} disabled={busy || (!checked && atLimit)} onChange={(event) => {
                    const enabled = event.target.checked
                    setProcessorAdditionalTasks((current) => enabled
                      ? [...current, task.id]
                      : current.filter((item) => item !== task.id))
                  }} />
                  {task.label}
                </label>
              })}
            </div>
          </details>
          {processorTaskLimitExceeded ? <p className="small" role="alert">This task set exceeds the {processorTier.toUpperCase()} profile limit. Remove steps or choose a larger profile.</p> : null}
        </> : null}
        <Field label="Optional provider">
          <span className="chat-provider-value"><i className="chat-provider-dot" aria-hidden="true" />{modelIndependent ? 'Not used by built-in processor' : (provider?.name ?? 'No provider connected')}</span>
        </Field>
        <Field label="Optional model" hint="Used only with the optional provider engine. No silent substitution: the built-in Klyvaron processor never loads weights.">
          <select aria-label="Model" className="select" value={model} disabled={modelIndependent || busy || saving || !hasSelectableModels} onChange={async (e) => { const next = e.target.value; setSaving(true); setError(null); try { await api.selectModel(next); setModel(next); setMediaConsent(false); setToolsConsent(false); setNativeSearchConsent(false); await refreshReadiness?.() } catch (err) { setError(err) } finally { setSaving(false) } }}>
            <option value="" disabled>Choose a model</option>
            {gatewayModels.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </Field>
        </div>
        <div className="chat-toolbar-actions">
          <span className="chat-online-label"><i aria-hidden="true" />Online</span>
          <Button className="ghost small" type="button" aria-expanded={showSetupGuide} aria-controls="chat-getting-started" onClick={() => setSetupGuideOpen(!showSetupGuide)}>Setup guide</Button>
          <Button disabled={busy} onClick={() => { setMessages([]); setSessionId(null); setLoadedSavedSession(false); setLoadedSavedSessionHasMedia(false); setMediaConsent(false); setToolsConsent(false); setNativeSearchConsent(false); setError(null); setPrompt(''); setAttachments([]); setAttachmentError(''); clearTranscriptState() }}>New conversation</Button>
          <Button className="chat-settings-button" disabled={busy} onClick={onSettings}>Provider Settings</Button>
        </div>
      </div>
      <p className="small chat-model-note">
        {modelIndependent
          ? `Klyvaron deterministic processor · ${processorTier.toUpperCase()} · tasks: ${processorTasks.join(', ')} · no model, weights, training, download, provider or network call.`
          : `${provider?.baseUrl || 'No gateway configured'} · Listed models are not inference-verified until a request succeeds.`}
      </p>
      {modelIndependent ? <Banner tone="info" title="Model-independent Klyvaron processing"><p>Uses deterministic parsing, extractive ranking, local retrieval and bounded arithmetic. It does not train or download AI models and does not claim open-ended language reasoning. Text and locally extracted document text only; binary image, audio and video understanding are not included.</p></Banner> : null}
      {modelIndependent && processorTasks.includes('compare') ? <Field label="Comparison text">
        <textarea aria-label="Comparison text" className="textarea" value={comparisonInput} disabled={busy} maxLength={100000} onChange={(event) => setComparisonInput(event.target.value)} placeholder="Paste the second text to compare lexically…" />
      </Field> : null}
      {selectedModelEvidence?.capabilities ? <p className="small chat-capability-evidence" aria-label="Selected model capability evidence">
        Provider catalogue for {selectedModelEvidence.name ?? model}: input {(selectedModelEvidence.capabilities.input ?? ['unknown']).join(', ')}, output {(selectedModelEvidence.capabilities.output ?? ['unknown']).join(', ')}, streaming {selectedModelEvidence.capabilities.streaming ?? 'unknown'}, image input {selectedModelEvidence.capabilities.imageInput ?? 'unknown'}, tools {provider?.chatTools && selectedModelEvidence.capabilities.tools === 'not_exposed_by_ragam' ? 'unknown' : selectedModelEvidence.capabilities.tools ?? 'unknown'}.
        {selectedModelEvidence.capabilities.provenance?.source ? ` Evidence source: ${selectedModelEvidence.capabilities.provenance.source}.` : ''}
        {' '}Catalogue metadata is not an inference or modality test. This wire accepts function schemas, but the selected model may not support them. Search and function calls are opt-in; any returned function call is a proposal, never automatic execution.
      </p> : model ? <p className="small chat-capability-evidence">This provider has not supplied capability evidence for the selected model. Ragam does not infer image, search, audio or tool support from a model name.</p> : null}
      <p className="small chat-provider-fabric" aria-label="Provider fabric evidence">
        Provider fabric: {readiness?.providerFabric?.counts?.total ?? 'unknown'} catalogued · {readiness?.providerFabric?.counts?.local ?? 0} local · {readiness?.providerFabric?.counts?.cloud ?? 0} cloud · {readiness?.providerFabric?.counts?.unknown ?? 0} unknown · evidence {readiness?.providerFabric?.evidenceState ?? 'unknown'} · live qualification {readiness?.providerFabric?.liveQualification?.state ?? 'not_requested'}.
      </p>
      <p className="small chat-context-limit" aria-label="Selected engine and context evidence">
        {modelIndependent
          ? 'Route: local deterministic Klyvaron · no provider, model context window, weights or network call. Context limits are bounded input/task limits, not a model context window. Evidence state: implemented and contract-tested; live provider verification is not applicable.'
          : `Route: optional provider with no silent substitution · context limit ${contextLimitLabel(selectedModelEvidence)} · max output ${outputLimitLabel(selectedModelEvidence)}. Evidence state: catalogue metadata, contract-tested only; not live-verified.`}
      </p>
      {loadedSavedSession ? <p className="small chat-history-disclosure" role="status">Saved conversation opened. The earlier provider/model was not recorded. When you press Send, this visible transcript will be processed by the selected engine.{loadedSavedSessionHasMedia ? ' Earlier binary media is not stored in history; reattach it if you want an optional model provider to inspect it again.' : ''}</p> : null}
      <div className="chat-transcript-tools" role="search" aria-label="Transcript tools">
        <input
          ref={searchInput}
          className="input chat-search-input"
          aria-label="Search transcript"
          aria-controls="chat-transcript"
          type="search"
          value={searchQuery}
          maxLength={CHAT_TRANSCRIPT_SEARCH_LIMIT}
          disabled={!messages.length}
          placeholder="Search transcript"
          onChange={(event) => { setSearchQuery(normalizeSearchQuery(event.target.value)); setTranscriptNotice('') }}
        />
        <span className="chat-transcript-count" role="status">{visibleMessages.length} of {messages.length} visible</span>
        <label className="checkbox chat-pinned-filter">
          <input type="checkbox" checked={pinnedOnly} disabled={!pinnedMessages.length} onChange={(event) => { setPinnedOnly(event.target.checked); setTranscriptNotice('') }} />Pinned only
        </label>
        <Button type="button" className="ghost small" disabled={!visibleMessages.length} onClick={exportCurrentTranscript}>Export Markdown</Button>
        {transcriptNotice ? <span className="small chat-transcript-notice" role="status">{transcriptNotice}</span> : null}
      </div>
      {pinnedMessages.length ? <div className="chat-pinned-list" aria-label="Pinned messages">
        <strong>Pinned messages ({pinnedMessages.length})</strong>
        <ul>{pinnedMessages.map(({ message, index }) => <li key={message.id ?? index}>
          <span>{message.role === 'user' ? 'You' : 'Assistant'}: {messageText(message).replace(/\s+/g, ' ').slice(0, 120) || '(no text)'}</span>
          <Button type="button" className="ghost small" aria-label={`Unpin message ${index + 1}`} onClick={() => togglePinned(message.id)}>Unpin</Button>
        </li>)}</ul>
      </div> : null}
      <div className="thread" id="chat-transcript" ref={thread} aria-live="polite" aria-label="Conversation transcript">
        {visibleMessages.length ? visibleMessages.map(({ message: m, index: i }) => (
          <div className={`message ${m.role}${pinnedIds.has(m.id) ? ' pinned' : ''}`} data-role={m.role} key={m.id ?? i}>
            <div className="message-head">
              <strong className="message-role">{m.historical && m.role === 'assistant' ? 'Earlier assistant reply' : m.role === 'user' ? 'You' : m.meta?.engine ? 'Klyvaron Processor' : m.meta?.modelId ?? model}</strong>
              <div className="message-actions" style={{ marginLeft: 'auto' }}>
                {messageText(m) ? <CopyButton text={messageText(m)} label="Copy" className="ghost small" /> : null}
                <Button type="button" className="ghost small" aria-pressed={pinnedIds.has(m.id)} aria-label={pinnedIds.has(m.id) ? `Unpin message ${i + 1}` : `Pin message ${i + 1}`} onClick={() => togglePinned(m.id)}>{pinnedIds.has(m.id) ? 'Unpin' : 'Pin'}</Button>
              </div>
            </div>
            <div className="message-body message-text" style={{ whiteSpace: 'pre-wrap' }}>{renderMessageText(m)}</div>
            {(() => { const check = structuredValidationFor(m); return check ? <small className={check.ok ? 'chat-json-ok' : 'chat-json-fail'}>Client-side JSON syntax check: {check.ok ? `PASS (${check.kind})` : `FAIL — ${check.error}`}. No provider schema was enforced; the reply is shown unchanged.</small> : null })()}
            {m.meta?.toolCalls?.length ? <div className="chat-tool-proposals" role="status"><strong>Provider function-call proposals — not executed</strong><p className="small">Review these untrusted model-proposed arguments. No provider or MCP tool runs unless you separately choose it in the manual tool panel.</p>{m.meta.toolCalls.map((call, index) => <details key={`${call.name}-${index}`}><summary>{call.name}</summary><pre className="code">{JSON.stringify(call.arguments, null, 2)}</pre></details>)}</div> : null}
            {(() => { const sources = m.meta?.grounding?.sources ?? m.meta?.grounding?.provider?.sources ?? []; return sources.length ? <div className="chat-grounding-sources"><strong>Provider search sources</strong><ul>{sources.map((source, index) => <li key={`${source.url}-${index}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a></li>)}</ul><small>Sources were returned by the provider; verify them independently.</small></div> : null })()}
            {m.attachments?.length ? <small>Attached: {m.attachments.map((file) => `${file.kind} ${file.name}`).join(', ')}. Binary content is not stored in this transcript.</small> : null}
            {m.failed ? <small>Not completed {m.role === 'user' ? <Button className="ghost small" onClick={() => retry(i)}>Retry</Button> : null}</small> : null}
            {m.meta ? (m.meta.engine === 'klyvaron-deterministic-v1' ? <small>Processed by {m.meta.engine} · tier {m.meta.tier} · modelUsed: false · weightsUsed: false · networkUsed: false{m.meta.persistence?.requested ? ' · saved to local knowledge by explicit request' : ''}</small> : <small>Executed online via {m.meta.provider ?? provider?.name ?? 'the gateway'}{m.meta.redaction?.findings?.length ? ' · credentials redacted' : ''}</small>) : null}
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
          <p className="chat-welcome-copy">{modelIndependent ? 'Choose a supported local task and supply text or an arithmetic expression. These starters match the built-in processor’s bounded capabilities; nothing is sent until you press Send.' : profile?.profession ? `A few starting points for ${profile.profession}. Choose one to draft a prompt; nothing is sent until you press Send.` : 'Choose an available model, then start with a question or one of these ideas. Nothing is sent until you press Send.'}</p>
          {!profile?.profession ? <Button className="ghost small profile-welcome-action" type="button" onClick={onProfile}>Add your name and profession for tailored ideas</Button> : null}
          <div className="chat-starter-grid" aria-label="Draft prompt ideas">
            {recommendations.map((item) => <button className="chat-starter" type="button" key={item.id} onClick={() => useStarter(item.prompt, item.id)}>
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
              aria-label={modelIndependent ? 'Input for Klyvaron processing' : 'Message your selected model'}
              value={prompt}
              onChange={(e) => { setPrompt(e.target.value); setMediaConsent(false) }}
              placeholder={modelIndependent ? 'Paste text or enter a bounded task…' : 'Message your selected model…'}
              maxLength={100000}
              disabled={busy}
              rows={1}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e) }
              }}
            />
          </div>
          <div className="chat-attachment-box">
            <p className="small">Attach up to {CHAT_FILE_LIMITS.files} files. {modelIndependent ? 'Text/PDF text extraction stays in this browser; only extracted text is processed locally. Image, audio and video bytes are not interpreted by this engine.' : 'Text/PDF extraction stays in this browser; the extracted text joins your message only when you press Send. Images, audio and video are encoded only when you press Send, after the per-turn transfer approval below. Binary media is not saved in conversation history. File selection never calls a provider. Actual model modality may be unknown; unsupported models can refuse, with no fallback. Vendor use may incur charges.'}</p>
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
            {!modelIndependent && attachments.some((file) => ['image', 'audio', 'video'].includes(file.kind)) ? <label className="checkbox chat-media-consent"><input type="checkbox" checked={mediaConsent} disabled={busy} onChange={(event) => setMediaConsent(event.target.checked)} />I approve sending these selected binary attachments to {provider?.name ?? 'the selected provider'} with this one Chat request. The selected model's support may be unknown and the provider may retain data or charge for use.</label> : null}
          </div>
          {provider?.chatNativeSearch ? <label className="checkbox chat-media-consent"><input type="checkbox" checked={nativeSearchConsent} disabled={busy} onChange={(event) => setNativeSearchConsent(event.target.checked)} />I approve provider-native web search for this one request to {provider?.name ?? 'the selected provider'}. The provider and its search service may receive the query and prompt context; data may be retained and charges may apply. OpenAI-compatible endpoints must implement Responses API web search; OpenRouter uses its documented openrouter:web_search tool. No Chat Completions fallback is attempted. Search is not enabled unless checked.</label> : null}
          {offeredTools.length ? <label className="checkbox chat-media-consent"><input type="checkbox" checked={toolsConsent} disabled={busy || !provider?.chatTools} onChange={(event) => setToolsConsent(event.target.checked)} />I approve sending {offeredTools.length} selected MCP function schema{offeredTools.length === 1 ? '' : 's'} to {provider?.name ?? 'the selected provider'} for this request. The model may propose a call; Ragam will never execute it automatically.</label> : null}
          {offeredTools.length && !provider?.chatTools ? <p className="small">The current Chat wire cannot receive function tool schemas. Choose a supported provider; no fallback occurs.</p> : null}
          <div className="composer-actions">
            <details style={{ display: 'inline-block' }}>
              <summary style={{ listStyle: 'none', cursor: 'pointer', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>Context & options</summary>
              <div style={{ padding: '10px 0 4px' }}>
                <div className="row" style={{ marginBottom: 8 }}>
                  <Field label="Temperature"><input className="input" type="number" min="0" max="2" step="0.1" value={temperature} onChange={(e) => setTemperature(e.target.value)} style={{ width: 90 }} /></Field>
                  <Field label="Max tokens"><input className="input" type="number" min="1" max="8192" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} style={{ width: 90 }} /></Field>
                </div>
                <label className="checkbox"><input type="checkbox" checked={useKnowledge} onChange={(e) => setUseKnowledge(e.target.checked)} />{modelIndependent ? 'Search my account-local knowledge' : 'Send matching file excerpts to this gateway'}</label>
                <label className="checkbox"><input type="checkbox" checked={useMemory} onChange={(e) => setUseMemory(e.target.checked)} />{modelIndependent ? 'Search my approved local memories' : 'Send matching approved memories to this gateway'}</label>
                {modelIndependent ? <label className="checkbox"><input type="checkbox" checked={saveProcessedInput} disabled={busy} onChange={(e) => setSaveProcessedInput(e.target.checked)} />Save this supplied text to my local knowledge base after successful processing</label> : null}
                {!modelIndependent ? <label className="checkbox"><input type="checkbox" checked={allowSensitive} onChange={(e) => setAllowSensitive(e.target.checked)} />I authorize sensitive content in this request and selected context to be sent to this gateway (one request)</label> : null}
                <label className="checkbox"><input type="checkbox" checked={structuredOutputCheck} onChange={(e) => setStructuredOutputCheck(e.target.checked)} />Validate assistant replies as JSON in this browser (syntax only; no provider schema, no rewriting and no live-verification claim)</label>
                <Field label="Response style" hint="A preference you set. It changes how an answer is phrased, not the facts or the result; the server checks the reply and never rewrites it.">
                  <select aria-label="Response style" className="select" value={style} disabled={busy} onChange={async (event) => { const next = event.target.value; setStyle(next); try { await api.setStyle(next || null) } catch (err) { setError(err) } }}>
                    <option value="">No style instruction</option>
                    {styles.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </select>
                </Field>
              </div>
            </details>
            {busy ? <Button variant="danger" onClick={() => abort.current?.abort()}>{modelIndependent ? 'Stop processing' : 'Stop generation'}</Button> : <Button type="submit" variant="primary" disabled={saving || (modelIndependent && processorTaskLimitExceeded) || (!modelIndependent && !model) || industryUnsupported || localOnlyUnsupported || (!prompt.trim() && !attachments.length)}>Send</Button>}
          </div>
        </div>
        <div className="chat-composer-foot"><span>Enter to send <b>·</b> Shift + Enter for a new line <b>·</b> Ctrl/⌘+K search <b>·</b> Esc clear <b>·</b> Ctrl/⌘+Shift+S stop</span><span>{modelIndependent ? `Klyvaron ${processorTier.toUpperCase()} · deterministic local processing · no model, weights or network` : localOnlyMode && LOCAL_CHAT_CONNECTIONS.has(provider?.kind) ? 'Sent only to the configured self-hosted runtime · remote vendor requests blocked' : localOnlyMode ? 'Local-only mode · remote requests blocked' : 'Sent to the selected provider · charges and retention policies may apply'}</span></div>
      </form>
    </Panel>
    <details className="context-section"><summary>Conversation history</summary><HistoryPanel sessionId={sessionId} onOpen={openSavedSession} onDelete={handleDeletedSession} disabled={busy || saving} /></details>
    <details className="context-section"><summary>Use a connected MCP tool (manual, optional)</summary><ChatToolRunner onAddResult={addToolResultToDraft} onToolsChange={setOfferedTools} /></details>
    <details className="context-section"><summary>Optional files & knowledge</summary><KnowledgePanel /></details>
    <details className="context-section"><summary>Optional approved memory</summary><MemoryPanel /></details>
    <details className="context-section"><summary>Reviewed procedure (optional)</summary><SkillsPanel value={skill} onChange={setSkill} account={account} model={model} provider={provider} /></details>
  </div>
}
