// Contract tests for the 14 audited Chat providers. These deterministic fixtures prove request
// shapes and parsers only; they are deliberately not described as live vendor qualification.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDERS, WIRE_FORMATS, providerById } from '../src/providers/catalog.mjs'
import { wireFor } from '../src/providers/wires/index.mjs'

const cases = [
  { id: 'openai', wire: 'openai_chat', modelsPath: '/models', chatPath: '/chat/completions', list: { data: [{ id: 'gpt-test' }] } },
  { id: 'openrouter', wire: 'openrouter_chat', modelsPath: '/models', chatPath: '/chat/completions', list: { data: [{ id: 'vendor/model-test' }] } },
  { id: 'mistral', wire: 'mistral_chat', modelsPath: '/models', chatPath: '/chat/completions', list: { data: [{ id: 'mistral-test' }] } },
  { id: 'deepseek', wire: 'deepseek_chat', modelsPath: '/models', chatPath: '/chat/completions', list: { data: [{ id: 'deepseek-test', name: 'DeepSeek test', context_window: 65536, max_output_tokens: 4096, input_modalities: ['text', 'image'], output_modalities: ['text'] }] } },
  { id: 'groq', wire: 'groq_chat', modelsPath: '/models', chatPath: '/chat/completions', list: { data: [{ id: 'groq-test' }] } },
  { id: 'together', wire: 'together_chat', modelsPath: '/models', chatPath: '/chat/completions', list: [{ id: 'together-test', type: 'chat', context_length: 32768 }] },
  { id: 'fireworks', wire: 'fireworks_chat', modelsPath: '/v1/accounts/acct_test/models?pageSize=200', chatPath: '/inference/v1/chat/completions', list: { models: [{ id: 'accounts/acct_test/models/fw-test', name: 'fw-test-chat' }] }, options: { accountId: 'acct_test' } },
  { id: 'xai', wire: 'xai_responses', modelsPath: '/language-models', chatPath: '/responses', list: { models: [{ id: 'grok-test', input_modalities: ['text'], output_modalities: ['text'], context_length: 131072 }] } },
  { id: 'perplexity', wire: 'perplexity_router', modelsPath: '/v1/models', chatPath: '/router/v1/chat/completions', list: { data: [{ id: 'perplexity/sonar-test' }] } },
  { id: 'novita', wire: 'novita_chat', modelsPath: '/models', chatPath: '/chat/completions', list: { data: [{ id: 'novita-test' }] } },
  { id: 'sambanova', wire: 'sambanova_chat', modelsPath: '/models', chatPath: '/chat/completions', list: { data: [{ id: 'sambanova-test' }] } },
  { id: 'huggingface', wire: 'huggingface_chat', modelsPath: '/models', chatPath: '/chat/completions', list: { data: [{ id: 'org/model-test' }] } },
  { id: 'vllm', wire: 'vllm_chat', modelsPath: '/models', chatPath: '/chat/completions', list: { data: [{ id: 'served-model' }] } },
  { id: 'localai', wire: 'localai_chat', modelsPath: '/models', chatPath: '/chat/completions', list: { data: [{ id: 'local-model' }] } },
]

const configFor = (entry) => ({ id: entry.id, kind: entry.id, wire: entry.wire, baseUrl: 'https://fixture.invalid', apiKey: 'fixture-secret-not-a-real-key', options: entry.options ?? {} })

test('the exact 14 audit providers each have their own contract adapter and compatibility class', () => {
  const expected = ['openai', 'openrouter', 'mistral', 'deepseek', 'groq', 'together', 'fireworks', 'xai', 'perplexity', 'novita', 'sambanova', 'huggingface', 'vllm', 'localai']
  const actual = PROVIDERS.filter((row) => row.adapterStatus === 'contract_tested').map((row) => row.id).sort()
  assert.deepEqual(actual, expected.sort())
  assert.equal(PROVIDERS.some((row) => /freellmapi/i.test(row.id)), false)
  for (const entry of cases) {
    const provider = providerById(entry.id)
    assert.equal(provider.wire, entry.wire)
    assert.equal(provider.liveVerification, 'pending')
    assert.equal(typeof wireFor(entry.wire).modelCatalogue, 'function')
    assert.equal(typeof wireFor(entry.wire).chat, 'function')
    assert.ok(provider.docsUrl.startsWith('https://'))
  }
  assert.equal(providerById('openai').integrationType, 'native-vendor')
  assert.equal(providerById('xai').integrationType, 'native-vendor')
  for (const id of ['openrouter', 'perplexity', 'huggingface']) assert.equal(providerById(id).integrationType, 'gateway-routed')
  for (const id of ['mistral', 'deepseek', 'groq', 'together', 'fireworks', 'novita', 'sambanova', 'vllm', 'localai']) assert.equal(providerById(id).integrationType, 'openai-compatible')
})

test('model-list contracts retain only reported model metadata and never infer unreported features', async () => {
  for (const entry of cases) {
    const wire = wireFor(entry.wire), config = configFor(entry)
    let pathSeen, headersSeen
    const transport = async (_config, path, options = {}) => {
      pathSeen = path
      headersSeen = options.headers
      return entry.list
    }
    const details = await wire.modelCatalogue(transport, config)
    assert.equal(pathSeen, entry.modelsPath, entry.id)
    assert.equal(details.length, 1, entry.id)
    assert.equal(details[0].id, entry.list.models?.[0]?.id ?? entry.list.data?.[0]?.id ?? entry.list[0]?.id, entry.id)
    assert.equal(headersSeen.authorization, `Bearer ${config.apiKey}`, entry.id)
    if (entry.id === 'deepseek') {
      assert.equal(details[0].capabilities.contextTokens, 65536)
      assert.equal(details[0].capabilities.imageInput, 'documented')
    } else if (!['deepseek', 'xai'].includes(entry.id)) {
      assert.equal(details[0].capabilities.streaming, 'unknown', entry.id)
      assert.equal(details[0].capabilities.imageInput, 'unknown', entry.id)
    }
    assert.equal(details[0].capabilities.tools, 'not_exposed_by_ragam', entry.id)
  }
})

test('completion adapters preserve exact model ids and provider-specific endpoints', async () => {
  for (const entry of cases) {
    const wire = wireFor(entry.wire), config = configFor(entry)
    let pathSeen, bodySeen, headersSeen
    const transport = async (_config, path, options = {}) => {
      pathSeen = path; bodySeen = options.body; headersSeen = options.headers
      if (entry.id === 'xai') return { model: 'grok-test', output: [{ content: [{ type: 'output_text', text: 'fixture answer' }] }], usage: { input_tokens: 3, output_tokens: 2 } }
      return { model: entry.list.models?.[0]?.id ?? entry.list.data?.[0]?.id ?? entry.list[0]?.id, choices: [{ message: { content: 'fixture answer' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }
    }
    const result = await wire.chat(transport, config, { model: 'verbatim-model-id', messages: [{ role: 'user', content: 'hello' }], maxTokens: 17, temperature: 0.25 })
    assert.equal(pathSeen, entry.chatPath, entry.id)
    assert.equal(bodySeen.model, 'verbatim-model-id', entry.id)
    assert.equal(result.text, 'fixture answer', entry.id)
    assert.equal(headersSeen.authorization, `Bearer ${config.apiKey}`, entry.id)
    if (entry.id === 'xai') assert.equal(bodySeen.max_output_tokens, 17)
    else assert.equal(bodySeen.max_tokens, 17)
  }
})

test('SSE contracts emit only text deltas and preserve the adapter-defined completion behavior', async () => {
  for (const entry of cases) {
    const wire = wireFor(entry.wire), config = configFor(entry)
    let bodySeen, pathSeen
    const transport = async (_config, path, options = {}) => {
      pathSeen = path; bodySeen = options.body
      if (entry.id === 'xai') {
        options.onFrame({ type: 'response.output_text.delta', delta: 'streamed' })
        options.onFrame({ type: 'response.completed', response: { model: 'grok-test', usage: { output_tokens: 1 } } })
      } else options.onFrame({ model: 'fixture-model', choices: [{ delta: { content: 'streamed' } }] })
      return null
    }
    const deltas = []
    const result = await wire.chat(transport, config, { model: 'exact-id', messages: [{ role: 'user', content: 'hello' }], maxTokens: 4, temperature: 0, onText: (delta) => deltas.push(delta) })
    assert.equal(pathSeen, entry.chatPath, entry.id)
    assert.equal(bodySeen.stream, true, entry.id)
    assert.equal(result.text, 'streamed', entry.id)
    assert.deepEqual(deltas, ['streamed'], entry.id)
  }
})

test('xAI Responses streaming must receive response.completed and does not accept a short/truncated stream', async () => {
  const wire = wireFor('xai_responses'), config = configFor(cases.find((row) => row.id === 'xai'))
  await assert.rejects(() => wire.chat(async (_config, _path, options) => {
    options.onFrame({ type: 'response.output_text.delta', delta: 'partial' })
    return null
  }, config, { model: 'grok-test', messages: [{ role: 'user', content: 'hello' }], maxTokens: 4, temperature: 0, onText: () => {} }), { code: 'provider_interrupted' })
})

test('Fireworks requires an account id for discovery and rejects malformed account identifiers', async () => {
  const wire = wireFor('fireworks_chat'), config = configFor(cases.find((row) => row.id === 'fireworks'))
  await assert.rejects(() => wire.models(async () => ({}), { ...config, options: {} }), { code: 'provider_config_required' })
  assert.throws(() => wire.validateConfig({ options: { accountId: '../private' } }), { code: 'invalid_provider_config' })
  assert.equal(wire.validateConfig(config), true)
  const paths = []
  const paginated = await wire.modelCatalogue(async (_config, path) => {
    paths.push(path)
    return path.includes('pageToken=cursor-2')
      ? { models: [{ name: 'accounts/acct_test/models/second' }] }
      : { models: [{ name: 'accounts/acct_test/models/first', contextLength: 64000, supportsImageInput: true }], nextPageToken: 'cursor-2' }
  }, config)
  assert.deepEqual(paths, ['/v1/accounts/acct_test/models?pageSize=200', '/v1/accounts/acct_test/models?pageSize=200&pageToken=cursor-2'])
  assert.equal(paginated.length, 2)
  assert.equal(paginated[0].capabilities.contextTokens, 64000)
  assert.equal(paginated[0].capabilities.imageInput, 'documented')
})

test('model parsers reject unknown provider list shapes instead of silently returning an empty list', async () => {
  for (const entry of cases.filter((row) => row.id !== 'xai')) {
    await assert.rejects(() => wireFor(entry.wire).models(async () => ({ unexpected: [] }), configFor(entry)), { code: 'invalid_model_list' }, entry.id)
  }
  await assert.rejects(() => wireFor('xai_responses').models(async () => ({ data: [] }), configFor(cases.find((row) => row.id === 'xai'))), { code: 'invalid_model_list' })
})

test('provider error normalizers distinguish authentication, throttling, quota and temporary service failures', () => {
  for (const entry of cases) {
    const normalize = wireFor(entry.wire).normalizeError
    assert.equal(normalize(401, {}).code, 'provider_auth_failed', entry.id)
    assert.equal(normalize(429, { error: { code: 'rate_limit_exceeded' } }).code, 'provider_rate_limited', entry.id)
    assert.equal(normalize(429, { error: { code: 'insufficient_quota' } }).code, 'provider_quota_exhausted', entry.id)
    assert.equal(normalize(402, {}).code, 'provider_quota_exhausted', entry.id)
    assert.equal(normalize(404, {}).code, 'provider_model_not_found', entry.id)
    assert.equal(normalize(408, {}).code, 'provider_request_timeout', entry.id)
    assert.equal(normalize(503, {}).code, 'provider_unavailable', entry.id)
  }
})
