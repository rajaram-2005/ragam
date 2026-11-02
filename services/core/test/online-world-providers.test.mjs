// Contract fixtures for additional independently documented international Chat APIs.
// These tests make no external requests and do not establish live vendor access or billing status.
import test from 'node:test'
import assert from 'node:assert/strict'
import { wireFor } from '../src/providers/wires/index.mjs'

const providers = [
  {
    wire: 'alibaba_model_studio_chat', baseUrl: 'https://dashscope-intl.aliyuncs.com',
    modelsPath: '/api/v1/models?page_no=1&page_size=100', chatPath: '/compatible-mode/v1/chat/completions',
    expectedModel: 'qwen3.8-max', expectedModels: ['qwen3.8-max', 'qwen3.8-plus'],
    listResponses: {
      '/api/v1/models?page_no=1&page_size=100': { output: { total: 101, page_no: 1, page_size: 100, models: [
        { model: 'qwen3.8-max', inference_metadata: { request_modality: ['Text'], response_modality: ['Text'] } },
        ...Array.from({ length: 99 }, (_, index) => ({ model: `image-only-${index}`, inference_metadata: { request_modality: ['Text'], response_modality: ['Image'] } })),
      ] } },
      '/api/v1/models?page_no=2&page_size=100': { output: { total: 101, page_no: 2, page_size: 100, models: [
        { model: 'qwen3.8-plus', inference_metadata: { request_modality: ['Text'], response_modality: ['Text'] } },
      ] } },
    },
    docs: 'https://help.aliyun.com/en/model-studio/compatibility-of-openai-with-dashscope',
  },
  {
    wire: 'cerebras_chat', baseUrl: 'https://api.cerebras.ai/v1', modelsPath: '/models',
    docs: 'https://inference-docs.cerebras.ai/api-reference/chat-completions',
  },
  {
    wire: 'deepinfra_chat', baseUrl: 'https://api.deepinfra.com/v1/openai', modelsPath: '/models?filter=with_meta&sort_by=maf',
    model: { id: 'fixture-chat-model', metadata: { tags: ['chat'] } },
    docs: 'https://docs.deepinfra.com/api-reference/introduction',
  },
  {
    wire: 'minimax_chat', baseUrl: 'https://api.minimax.io/v1', modelsPath: '/models',
    docs: 'https://platform.minimax.io/docs/api-reference/text-openai-api',
  },
  {
    wire: 'siliconflow_chat', baseUrl: 'https://api.siliconflow.com/v1', modelsPath: '/models?sub_type=chat',
    docs: 'https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions',
  },
]

test('international provider adapters discover documented models and send documented Chat Completions requests', async (t) => {
  for (const provider of providers) await t.test(provider.wire, async () => {
    const calls = []
    const adapter = wireFor(provider.wire)
    const config = { baseUrl: provider.baseUrl, apiKey: 'synthetic-fixture-key' }
    const expectedModel = provider.expectedModel ?? 'fixture-chat-model'
    const transport = async (receivedConfig, path, options = {}) => {
      calls.push({ receivedConfig, path, options })
      if (path === provider.modelsPath || Object.hasOwn(provider.listResponses ?? {}, path)) {
        return provider.listResponses?.[path] ?? provider.listResponse ?? { object: 'list', data: [{ id: expectedModel, object: 'model', owned_by: 'fixture', ...(provider.model ?? {}) }] }
      }
      if (path === '/chat/completions' || path === '/compatible-mode/v1/chat/completions') {
        return {
          id: 'fixture-completion', object: 'chat.completion', model: expectedModel,
          choices: [{ index: 0, message: { role: 'assistant', content: 'fixture answer' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }
      }
      assert.fail(`${provider.wire} requested undocumented path ${path}`)
    }

    assert.equal(adapter.adapter.docsUrl, provider.docs)
    assert.deepEqual(await adapter.models(transport, config), provider.expectedModels ?? [expectedModel])
    assert.equal(calls[0].path, provider.modelsPath)
    assert.equal(calls[0].options.headers.authorization, 'Bearer synthetic-fixture-key')
    if (provider.wire === 'alibaba_model_studio_chat') {
      assert.equal(calls[1].path, '/api/v1/models?page_no=2&page_size=100', 'Alibaba model discovery follows the documented page counter')
      assert.equal(calls[1].options.headers.authorization, 'Bearer synthetic-fixture-key')
    }

    const result = await adapter.chat(transport, config, {
      model: expectedModel, messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 64, temperature: 0.2,
    })
    assert.equal(result.text, 'fixture answer')
    assert.equal(result.model, expectedModel)
    assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })
    const request = calls.find((call) => call.path === (provider.chatPath ?? '/chat/completions'))
    assert.ok(request, `${provider.wire} sent its Chat Completions request`)
    assert.equal(request.receivedConfig, config)
    assert.equal(request.options.headers.authorization, 'Bearer synthetic-fixture-key')
    assert.deepEqual(request.options.body.messages, [{ role: 'user', content: 'hello' }])
    assert.equal(request.options.body.model, expectedModel)
    assert.equal(request.options.body.max_tokens, 64)
    assert.equal(request.options.body.stream, false)
  })
})
