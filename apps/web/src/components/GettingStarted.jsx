import React from 'react'
import { Button } from './ui.jsx'

/** A no-network first-run guide. Its actions open settings or fill a draft only. */
export default function GettingStarted({ providerReady, modelReady, onSettings, onUseExample, onDismiss, hidden = false, modelIndependent = false }) {
  if (modelIndependent) return (
    <section className="getting-started" id="chat-getting-started" aria-labelledby="getting-started-title" hidden={hidden}>
      <header className="getting-started-head">
        <div>
          <p className="getting-started-eyebrow">KLYVARON · MODEL-INDEPENDENT</p>
          <h2 id="getting-started-title">Process information locally</h2>
        </div>
        <Button className="ghost small" type="button" onClick={onDismiss} aria-label="Hide the setup guide">Hide guide</Button>
      </header>
      <p className="getting-started-intro">Klyvaron’s built-in engine uses deterministic parsing, local retrieval and bounded workflows. No AI model, weights, training, download, provider account or network call is required.</p>
      <ol className="getting-started-steps">
        <li className="getting-started-step complete"><span className="getting-started-index">01</span><span className="getting-started-copy"><strong>Choose a task and tier</strong><small>Lite, Pro and Max change bounded context and workflow limits, not a trained model.</small></span><span className="getting-started-state">LOCAL</span></li>
        <li className="getting-started-step complete"><span className="getting-started-index">02</span><span className="getting-started-copy"><strong>Supply text</strong><small>Text and locally extracted PDF text are supported. Binary image/audio/video understanding is not included.</small></span><span className="getting-started-state">YOUR DATA</span></li>
        <li className="getting-started-step complete"><span className="getting-started-index">03</span><span className="getting-started-copy"><strong>Choose what persists</strong><small>Knowledge is saved only when you explicitly select the local-save option. Memory remains separately user-approved.</small></span><span className="getting-started-state">OPT IN</span></li>
      </ol>
      <div className="getting-started-footer"><div><strong>Try an extractive workflow</strong><small>The sample is local text and will not be sent to a model.</small></div><Button className="ghost" type="button" onClick={onUseExample}>Fill sample text</Button></div>
      <p className="getting-started-disclosure">This engine does not provide learned open-ended language reasoning. It shows its limits and returns source evidence for retrieval tasks.</p>
    </section>
  )
  return (
    <section className="getting-started" id="chat-getting-started" aria-labelledby="getting-started-title" hidden={hidden}>
      <header className="getting-started-head">
        <div>
          <p className="getting-started-eyebrow">AETHERIS OMNI · QUICK START</p>
          <h2 id="getting-started-title">Your workspace, in three steps</h2>
        </div>
        <Button className="ghost small" type="button" onClick={onDismiss} aria-label="Hide the setup guide">Hide guide</Button>
      </header>
      <p className="getting-started-intro">The app and saved workspace run in your local Docker installation. A cloud model is separate: when you send a prompt, the selected provider receives it. Provider API use may incur charges.</p>
      <ol className="getting-started-steps">
        <li className="getting-started-step complete">
          <span className="getting-started-index">01</span>
          <span className="getting-started-copy"><strong>Understand where things run</strong><small>This guide does not send your prompt, test a provider, or download a model.</small></span>
          <span className="getting-started-state">LOCAL APP</span>
        </li>
        <li className={`getting-started-step${providerReady ? ' complete' : ''}`}>
          <span className="getting-started-index">02</span>
          <span className="getting-started-copy"><strong>{providerReady ? 'Provider connection saved' : 'Connect a provider you choose'}</strong><small>{providerReady ? 'Use Provider Settings to review it or explicitly test and refresh its model list.' : 'Choose OpenAI (ChatGPT), Google Gemini, Anthropic Claude, xAI (Grok), or a service you operate. Saving is separate from testing; only an explicit test fetches the model IDs that key can access.'}</small></span>
          {!providerReady ? <Button type="button" onClick={onSettings}>Choose a provider</Button> : <span className="getting-started-state">SAVED</span>}
        </li>
        <li className={`getting-started-step${modelReady ? ' complete' : ''}`}>
          <span className="getting-started-index">03</span>
          <span className="getting-started-copy"><strong>{modelReady ? 'Model selected explicitly' : 'Choose an available model'}</strong><small>{modelReady ? 'The selected model is shown above the conversation. There is no automatic provider fallback.' : providerReady ? 'After a deliberate connection test refreshes the model list, choose an exact model above.' : 'After connecting and explicitly refreshing, choose an exact model above.'}</small></span>
          <span className="getting-started-state">{modelReady ? 'SELECTED' : 'YOUR CHOICE'}</span>
        </li>
      </ol>
      <div className="getting-started-footer">
        <div><strong>Want to try the composer?</strong><small>Draft a sample question; it will not be sent until you press Send.</small></div>
        <Button className="ghost" type="button" onClick={onUseExample}>Fill a sample prompt</Button>
      </div>
      <p className="getting-started-disclosure">Connection tests contact the provider you select; check its pricing first. Nothing in this guide automatically tests, sends, or bills.</p>
    </section>
  )
}
