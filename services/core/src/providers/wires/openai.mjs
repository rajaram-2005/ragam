// OpenAI-compatible chat: `GET {base}/models` and `POST {base}/chat/completions`.
//
// This is the wire the product shipped with; it is now an adapter like the other two, so the app
// has one path and a connection's wire decides which builder runs. The request body, headers and
// SSE frames are unchanged from the version that predates the adapter split — the existing tests
// pin them, which is the point of moving the code rather than rewriting it.

import { failure } from '../../online/failure.mjs'
import { idsFromData } from './common.mjs'

export const wire = 'openai_chat'

const headers = (config) => (config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {})

export async function models(transport, config) {
  return idsFromData(await transport(config, '/models', { headers: headers(config) }))
}

export async function chat(transport, config, { model, messages, maxTokens, temperature, signal, onText }) {
  let reported = null
  let usage = null
  let text = ''
  const onFrame = onText
    ? (frame) => {
        if (frame.model) reported = frame.model
        if (frame.usage) usage = frame.usage
        const delta = frame.choices?.[0]?.delta?.content
        if (typeof delta === 'string') { text += delta; onText(delta) }
      }
    : null
  const data = await transport(config, '/chat/completions', {
    headers: headers(config),
    signal,
    body: { model, messages, max_tokens: maxTokens, temperature, stream: Boolean(onText) },
    onFrame,
  })
  if (onText) return { text, model: reported, usage }
  const completion = data?.choices?.[0]?.message?.content
  if (typeof completion !== 'string') {
    throw failure('invalid_completion', 'This model did not return a text completion. No model was substituted.', 502)
  }
  return { text: completion, model: data.model ?? null, usage: data.usage ?? null }
}
