import { CREDENTIAL_KINDS, IMPLEMENTED, credentialFor } from './wires/index.mjs'

// The provider catalogue: what the world offers, and how little of it this build can prove.
//
// This module exists because the two failure modes a provider list has are opposite and both
// common. One is a short list that pretends the rest of the market does not exist. The other is a
// long list that pretends every entry works. The second is worse: a matrix of twenty logos reads as
// twenty integrations, and the first time a user pastes a key into one of them they discover the
// truth in the least useful way.
//
// So every provider here carries a **status** and every capability carries **evidence**:
//
//   ready         this build has a tested code path to it (the transports in online/gateway.mjs).
//                 Requires `source: 'test'` on every capability.
//   gateway_only  it speaks a wire format the tested transport already speaks (OpenAI-compatible
//                 `/chat/completions`), so an operator *can* reach it by pointing a compatible
//                 endpoint at it. Not independently verified here, and the status says so.
//   pending       it needs a wire adapter this build does not have. It cannot be selected, and
//                 `selectProvider` refuses it by name even if it advertises the capability.
//
// A provider cannot promote itself. Validation refuses an entry that claims `ready` without a test
// behind each capability, and refuses a capability with no evidence at all. Adding a real adapter
// means adding a test, which is the point.
//
// What is deliberately absent: no credential values, no "supports everything" flags, and no
// provider without a documentation URL. A catalogue entry is a claim about somebody else's API,
// and a claim needs a source.

/** How a provider authenticates. A catalogue entry never carries the credential itself. */
export const AUTH_KINDS = Object.freeze({
  BEARER: 'bearer',
  X_API_KEY: 'x_api_key',
  OAUTH2: 'oauth2',
  AWS_SIGV4: 'aws_sigv4',
  GCP_ADC: 'gcp_adc',
  NONE: 'none',
})

/** The wire protocols. Only one is implemented by this build's transport. */
export const WIRE_FORMATS = Object.freeze({
  OPENAI_CHAT: 'openai_chat',
  ANTHROPIC_MESSAGES: 'anthropic_messages',
  GEMINI_GENERATE: 'gemini_generate',
  COHERE_CHAT: 'cohere_chat',
  AZURE_OPENAI: 'azure_openai',
  AWS_BEDROCK: 'aws_bedrock',
  GCP_VERTEX: 'gcp_vertex',
  OPENAI_IMAGES: 'openai_images',
  GEMINI_IMAGES: 'gemini_images',
  GEMINI_VEO: 'gemini_veo',
  STABILITY_IMAGES: 'stability_images',
  RECRAFT_IMAGES: 'recraft_images',
  IDEOGRAM_IMAGES: 'ideogram_images',
  BFL_IMAGES: 'bfl_images',
  FAL_IMAGES: 'fal_images',
  FAL_VIDEO: 'fal_video',
  REPLICATE_IMAGES: 'replicate_images',
  REPLICATE_VIDEO: 'replicate_video',
  RUNWAY_VIDEO: 'runway_video',
  LUMA_VIDEO: 'luma_video',
  FIREFLY_IMAGES: 'firefly_images',
})

/**
 * Wires the online gateway's transport can speak today. Derived from the adapter registry, so a
 * provider cannot be promoted onto a wire that nothing implements.
 */
export const IMPLEMENTED_WIRES = IMPLEMENTED

export const PROVIDER_STATUS = Object.freeze({
  READY: 'ready',
  GATEWAY_ONLY: 'gateway_only',
  PENDING: 'pending',
})

/** A capability is only claimed with a source. `test` means this repository exercises it. */
export const EVIDENCE_SOURCES = Object.freeze(['test', 'vendor-doc'])

export const CAPABILITIES = Object.freeze({
  STREAMING: 'streaming',
  TOOLS: 'tools',
  STRUCTURED_OUTPUT: 'structured_output',
  IMAGE_INPUT: 'image_input',
  FILE_INPUT: 'file_input',
  REASONING: 'reasoning',
  CANCELLATION: 'cancellation',
  ASYNC_JOBS: 'async_jobs',
  IMAGE_GENERATION: 'image_generation',
  VIDEO_GENERATION: 'video_generation',
})

export class ProviderError extends Error {
  constructor(message, code, problems = []) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.problems = problems
  }
}

const cap = (id, source, ref) => Object.freeze({ id, source, ref: ref ?? null })

const ready = (id, label, doc, capabilities, extra = {}) => Object.freeze({
  id, label,
  category: 'gateway',
  wire: WIRE_FORMATS.OPENAI_CHAT,
  auth: AUTH_KINDS.BEARER,
  credential: CREDENTIAL_KINDS.API_KEY,
  status: PROVIDER_STATUS.READY,
  docsUrl: doc,
  // The tested transport: `GET {base}/models`, `POST {base}/chat/completions`, SSE streaming,
  // no redirects, deadline and size bounds. The tests are in test/online.test.mjs.
  capabilities,
  egress: Object.freeze({ https: true, operatorConfigured: true }),
  notes: 'Reached through the tested OpenAI-compatible transport. Local runtimes may use http on an operator-trusted origin.',
  ...extra,
})

// The three runtimes the product actually offers. Their capabilities are the ones the transport's
// tests exercise: streaming with a real sentinel, cancellation, and model listing. Tools are not
// claimed for them here because the online chat path does not send a tool schema.
const GATEWAY_TESTS = 'test/online.test.mjs'
const streaming = cap(CAPABILITIES.STREAMING, 'test', GATEWAY_TESTS)
const cancellation = cap(CAPABILITIES.CANCELLATION, 'test', GATEWAY_TESTS)
const WIRE_TESTS = 'test/online-wires.test.mjs'
const IMAGE_TESTS = 'test/online-image.test.mjs'
const VIDEO_TESTS = 'test/online-video.test.mjs'
const wireStreaming = cap(CAPABILITIES.STREAMING, 'test', WIRE_TESTS)
const wireCancellation = cap(CAPABILITIES.CANCELLATION, 'test', WIRE_TESTS)

// A native adapter: a published wire this build speaks, contract-tested against a local fixture.
// `ready` here means exactly what it means for the three runtimes — a tested code path — and not
// that the vendor has been called. The note says the second part.
/**
 * An image adapter. It is `ready` for the same reason a chat wire is: a test exercises the request
 * and the response parser against a local fixture. It makes no streaming claim, because image
 * generation has no stream in this build, and no attempt is made to reuse chat's capability ids.
 */
const imageNative = (id, label, doc, wire, auth) => Object.freeze({
  id, label,
  category: 'media',
  wire,
  auth,
  credential: credentialFor(wire),
  status: PROVIDER_STATUS.READY,
  docsUrl: doc,
  capabilities: Object.freeze([cap(CAPABILITIES.IMAGE_GENERATION, 'test', IMAGE_TESTS)]),
  egress: Object.freeze({ https: true, operatorConfigured: false }),
  notes: 'Native image adapter, contract-tested against a local fixture. No live call has been made in this build; the key you save is sent only to the endpoint you configure.',
})

const videoNative = (id, label, doc, wire, auth) => Object.freeze({
  id, label,
  category: 'media',
  wire,
  auth,
  credential: credentialFor(wire),
  status: PROVIDER_STATUS.READY,
  docsUrl: doc,
  capabilities: Object.freeze([cap(CAPABILITIES.VIDEO_GENERATION, 'test', VIDEO_TESTS)]),
  egress: Object.freeze({ https: true, operatorConfigured: false }),
  notes: 'Native video adapter: a long-running operation polled to completion, then a validated MP4. Contract-tested against a local fixture; no live call has been made in this build.',
})

const native = (id, label, doc, wire, auth, { streaming: streams = true, capabilities = [] } = {}) => Object.freeze({
  id, label,
  category: 'vendor',
  wire,
  auth,
  credential: credentialFor(wire),
  status: PROVIDER_STATUS.READY,
  docsUrl: doc,
  // Streaming is claimed only where a test exercises it. Bedrock's native stream is a binary
  // event framing this transport does not parse, so its adapter is non-streaming and says so.
  capabilities: Object.freeze([...(streams ? [wireStreaming] : []), ...capabilities]),
  egress: Object.freeze({ https: true, operatorConfigured: false }),
  notes: 'Native adapter, contract-tested against a local fixture. No live call has been made in this build; the credential you save is sent only to the endpoint you configure.',
})

export const PROVIDERS = Object.freeze([
  ready('litellm', 'LiteLLM gateway', 'https://docs.litellm.ai/docs/providers', [streaming, cancellation]),
  ready('ollama', 'Ollama (OpenAI-compatible)', 'https://github.com/ollama/ollama/blob/main/docs/openai.md', [streaming, cancellation]),
  ready('llamacpp', 'llama.cpp server', 'https://github.com/ggml-org/llama.cpp/blob/master/examples/server/README.md', [streaming, cancellation]),

  // Native wires. Their request shapes differ from OpenAI's in ways a compatibility layer would
  // paper over: auth header, system-prompt placement, role names and the completion signal.
  native('anthropic', 'Anthropic Claude', 'https://docs.anthropic.com/en/api/messages', WIRE_FORMATS.ANTHROPIC_MESSAGES, AUTH_KINDS.X_API_KEY),
  native('gemini', 'Google Gemini', 'https://ai.google.dev/api/generate-content', WIRE_FORMATS.GEMINI_GENERATE, AUTH_KINDS.X_API_KEY),
  native('cohere', 'Cohere', 'https://docs.cohere.com/reference/chat', WIRE_FORMATS.COHERE_CHAT, AUTH_KINDS.BEARER),
  native('azure-openai', 'Azure OpenAI', 'https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle', WIRE_FORMATS.AZURE_OPENAI, AUTH_KINDS.X_API_KEY),
  native('vertex', 'Google Vertex AI', 'https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations', WIRE_FORMATS.GCP_VERTEX, AUTH_KINDS.GCP_ADC),
  native('bedrock', 'Amazon Bedrock', 'https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html', WIRE_FORMATS.AWS_BEDROCK, AUTH_KINDS.AWS_SIGV4, { streaming: false, capabilities: [wireCancellation] }),

  // OpenAI-compatible vendors. `gateway_only` is a statement about the wire format, not a tested
  // integration: an operator can point a compatible endpoint at them, and nothing here has done so.
  ...[
    ['openai', 'OpenAI', 'https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create', 'https://developers.openai.com/api/reference'],
    ['openrouter', 'OpenRouter', 'https://openrouter.ai/docs/quickstart', 'https://openrouter.ai/docs'],
    ['mistral', 'Mistral AI', 'https://docs.mistral.ai/api/', 'https://docs.mistral.ai'],
    ['deepseek', 'DeepSeek', 'https://api-docs.deepseek.com/', 'https://api-docs.deepseek.com'],
    ['groq', 'Groq', 'https://console.groq.com/docs/openai', 'https://console.groq.com/docs'],
    ['together', 'Together AI', 'https://docs.together.ai/docs/openai-api-compatibility', 'https://docs.together.ai'],
    ['fireworks', 'Fireworks AI', 'https://docs.fireworks.ai/api-reference/introduction', 'https://docs.fireworks.ai'],
    ['xai', 'xAI', 'https://docs.x.ai/docs/api-reference', 'https://docs.x.ai'],
    ['perplexity', 'Perplexity', 'https://docs.perplexity.ai/api-reference/chat-completions', 'https://docs.perplexity.ai'],
    ['novita', 'Novita AI', 'https://novita.ai/docs/api-reference/model-apis-llm-create-chat-completion', 'https://novita.ai/docs'],
    ['sambanova', 'SambaNova', 'https://docs.sambanova.ai/cloud/docs/get-started/api-reference', 'https://docs.sambanova.ai'],
    ['huggingface', 'Hugging Face Inference Providers', 'https://huggingface.co/docs/inference-providers/index', 'https://huggingface.co/docs/inference-providers'],
    ['vllm', 'vLLM (OpenAI-compatible server)', 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html', 'https://docs.vllm.ai'],
    ['localai', 'LocalAI', 'https://localai.io/features/openai-functions/', 'https://localai.io'],
  ].map(([id, label, docsUrl, docsRoot]) => Object.freeze({
    id,
    label,
    category: 'openai-compatible',
    wire: WIRE_FORMATS.OPENAI_CHAT,
    auth: AUTH_KINDS.BEARER,
    credential: CREDENTIAL_KINDS.API_KEY,
    status: PROVIDER_STATUS.GATEWAY_ONLY,
    docsUrl,
    // Deliberately empty: nothing in this repository has called this vendor, so no capability is
    // evidenced. The status says "this wire format is implemented", not "this vendor is verified".
    capabilities: Object.freeze([]),
    egress: Object.freeze({ https: true, operatorConfigured: true }),
    notes: `OpenAI-compatible. Reachable by pointing a compatible endpoint at ${docsRoot.replace('https://', '')}; not independently verified in this build.`,
  })),

  // Image vendors with a tested wire. The capability is contract-tested against a local
  // fixture that returns the documented shape; no vendor has been called live. Their notes
  // say both things, because the row is a claim about this repository, not about the market.
  imageNative('openai-images', 'OpenAI Images', 'https://developers.openai.com/api/reference/resources/images/methods/generate', WIRE_FORMATS.OPENAI_IMAGES, AUTH_KINDS.BEARER),
  imageNative('gemini-images', 'Google Gemini Images', 'https://ai.google.dev/gemini-api/docs/image-generation', WIRE_FORMATS.GEMINI_IMAGES, AUTH_KINDS.X_API_KEY),
  imageNative('stability', 'Stability AI', 'https://platform.stability.ai/docs/api-reference', WIRE_FORMATS.STABILITY_IMAGES, AUTH_KINDS.BEARER),
  imageNative('recraft', 'Recraft', 'https://www.recraft.ai/docs/api-reference/endpoints', WIRE_FORMATS.RECRAFT_IMAGES, AUTH_KINDS.BEARER),
  imageNative('ideogram', 'Ideogram', 'https://developer.ideogram.ai/ideogram-api/api-overview', WIRE_FORMATS.IDEOGRAM_IMAGES, AUTH_KINDS.X_API_KEY),
  imageNative('black-forest-labs', 'Black Forest Labs (FLUX)', 'https://docs.bfl.ai/quick_start/generating_images', WIRE_FORMATS.BFL_IMAGES, AUTH_KINDS.X_API_KEY),
  imageNative('fal', 'fal.ai', 'https://docs.fal.ai/model-apis/model-endpoints/queue', WIRE_FORMATS.FAL_IMAGES, AUTH_KINDS.BEARER),
  imageNative('replicate', 'Replicate', 'https://replicate.com/docs/reference/http', WIRE_FORMATS.REPLICATE_IMAGES, AUTH_KINDS.BEARER),
  imageNative('firefly', 'Adobe Firefly', 'https://developer.adobe.com/firefly-services/docs/firefly-api/', WIRE_FORMATS.FIREFLY_IMAGES, AUTH_KINDS.OAUTH2),

  // Video vendors with a tested wire. Each adapter implements the vendor's own asynchronous
  // task contract, including bounded polling and cancellation.
  videoNative('veo', 'Google Veo (Gemini API)', 'https://ai.google.dev/gemini-api/docs/veo', WIRE_FORMATS.GEMINI_VEO, AUTH_KINDS.X_API_KEY),
  videoNative('runway', 'Runway', 'https://docs.dev.runwayml.com/', WIRE_FORMATS.RUNWAY_VIDEO, AUTH_KINDS.BEARER),
  videoNative('luma', 'Luma AI', 'https://docs.lumalabs.ai/docs/video-generation', WIRE_FORMATS.LUMA_VIDEO, AUTH_KINDS.BEARER),
  videoNative('fal-video', 'fal.ai video', 'https://docs.fal.ai/model-apis/model-endpoints/queue', WIRE_FORMATS.FAL_VIDEO, AUTH_KINDS.BEARER),
  videoNative('replicate-video', 'Replicate video', 'https://replicate.com/docs/reference/http', WIRE_FORMATS.REPLICATE_VIDEO, AUTH_KINDS.BEARER),

  // Local image stacks stay optional and unintegrated. The product is online-first: these are
  // developer/self-hosted options, not a fallback, and they are refused by name until an
  // adapter and its tests exist.
  ...[
    ['comfyui', 'ComfyUI (local)', 'https://github.com/comfyanonymous/ComfyUI'],
    ['diffusers', 'Diffusers (local)', 'https://huggingface.co/docs/diffusers/index'],
  ].map(([id, label, docsUrl]) => Object.freeze({
    id,
    label,
    category: 'media',
    wire: null,
    auth: AUTH_KINDS.BEARER,
    credential: null,
    status: PROVIDER_STATUS.PENDING,
    docsUrl,
    capabilities: Object.freeze([]),
    notes: 'Optional local image stack with no adapter in this build. The online product does not require it and does not fall back to it.',
    egress: Object.freeze({ https: true, operatorConfigured: false }),
  })),
])

const byId = new Map(PROVIDERS.map((provider) => [provider.id, provider]))

/** Look one up. Unknown is refused rather than defaulted — there is no "closest provider". */
export function providerById(id) {
  const provider = byId.get(id)
  if (!provider) throw new ProviderError(`unknown provider '${id}'`, 'unknown_provider')
  return provider
}

export function providersByStatus(status) {
  return PROVIDERS.filter((provider) => provider.status === status).map((provider) => provider.id)
}

/**
 * Validate the catalogue. This is run by the tests and by `catalogueReport`, so a malformed entry
 * fails a build rather than a user's first request.
 */
export function validateProvider(provider) {
  const problems = []
  const fail = (message) => problems.push(message)
  const allowed = new Set(['id', 'label', 'category', 'wire', 'auth', 'credential', 'status', 'docsUrl', 'capabilities', 'egress', 'notes'])
  for (const key of Object.keys(provider ?? {})) if (!allowed.has(key)) fail(`${key}: unknown field`)

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(provider?.id ?? '')) fail(`id '${provider?.id}' is not kebab-case`)
  if (typeof provider?.label !== 'string' || provider.label.length < 2) fail('label is required')
  if (!Object.values(AUTH_KINDS).includes(provider?.auth)) fail(`auth '${provider?.auth}' is not a known kind`)
  if (!Object.values(PROVIDER_STATUS).includes(provider?.status)) fail(`status '${provider?.status}' is not a known status`)
  if (typeof provider?.docsUrl !== 'string' || !provider.docsUrl.startsWith('https://')) fail('docsUrl must be an https URL')
  // A credential kind is a property of the wire, so the catalogue may only restate it. An entry
  // that claims a different kind would put the wrong form in front of the user.
  if (provider?.wire === null) {
    if (provider?.credential !== null) fail('a provider with no wire has no credential kind')
  } else if (!Object.values(CREDENTIAL_KINDS).includes(provider?.credential)) {
    fail(`credential '${provider?.credential}' is not a known kind`)
  } else if (provider.credential !== credentialFor(provider.wire)) {
    fail(`credential '${provider.credential}' disagrees with wire '${provider.wire}'`)
  }

  // The only evidence a capability has is what a test exercises or what the vendor documents. A
  // capability with neither is an advertisement.
  for (const capability of provider?.capabilities ?? []) {
    if (!Object.values(CAPABILITIES).includes(capability.id)) fail(`capability '${capability.id}' is unknown`)
    if (!EVIDENCE_SOURCES.includes(capability.source)) fail(`capability '${capability.id}' has no recognised evidence source`)
    if (capability.source === 'test' && !String(capability.ref ?? '').startsWith('test/')) {
      fail(`capability '${capability.id}' claims a test, so it must name a test file`)
    }
    if (capability.source === 'vendor-doc' && !String(capability.ref ?? '').startsWith('https://')) {
      fail(`capability '${capability.id}' cites a vendor doc, so it must cite a URL`)
    }
  }

  if (provider?.status === PROVIDER_STATUS.READY) {
    if (!IMPLEMENTED_WIRES.includes(provider.wire)) fail(`'${provider.id}' is ready on a wire this build does not implement`)
    if ((provider.capabilities ?? []).length === 0) fail(`'${provider.id}' is ready with no tested capability`)
    for (const capability of provider.capabilities ?? []) {
      if (capability.source !== 'test') fail(`'${provider.id}' is ready but '${capability.id}' is not backed by a test`)
    }
  }
  if (provider?.status === PROVIDER_STATUS.GATEWAY_ONLY && provider.wire !== WIRE_FORMATS.OPENAI_CHAT) {
    fail(`'${provider.id}' is gateway_only on a wire the gateway does not speak`)
  }
  if (provider?.status === PROVIDER_STATUS.PENDING && (provider.capabilities ?? []).length > 0) {
    fail(`'${provider.id}' is pending and cannot advertise capabilities`)
  }
  if (provider?.wire !== null && !Object.values(WIRE_FORMATS).includes(provider?.wire)) fail(`wire '${provider?.wire}' is unknown`)
  if (!provider?.egress || typeof provider.egress.https !== 'boolean') fail('egress policy is required')

  return Object.freeze({ valid: problems.length === 0, problems: Object.freeze(problems) })
}

export function validateCatalogue(providers = PROVIDERS) {
  const problems = []
  const seen = new Set()
  for (const provider of providers) {
    if (seen.has(provider.id)) problems.push(`duplicate provider id '${provider.id}'`)
    seen.add(provider.id)
    const verdict = validateProvider(provider)
    for (const problem of verdict.problems) problems.push(`${provider.id}: ${problem}`)
  }
  return Object.freeze({ valid: problems.length === 0, problems: Object.freeze(problems) })
}

/**
 * What can be shown to a user. No credential fields exist on a descriptor at all, so there is
 * nothing to redact here — the guarantee is structural, not a filter.
 */
export function describeProvider(id) {
  const provider = providerById(id)
  return Object.freeze({
    id: provider.id,
    label: provider.label,
    category: provider.category,
    status: provider.status,
    wire: provider.wire,
    credential: provider.credential,
    auth: provider.auth,
    docsUrl: provider.docsUrl,
    capabilities: provider.capabilities,
    notes: provider.notes,
    egress: provider.egress,
  })
}

/** Counts for the docs and for the API's summary line. */
export function catalogueReport() {
  const verdict = validateCatalogue()
  const counts = Object.fromEntries(Object.values(PROVIDER_STATUS).map((status) => [status, providersByStatus(status).length]))
  return Object.freeze({
    valid: verdict.valid,
    problems: verdict.problems,
    total: PROVIDERS.length,
    counts: Object.freeze(counts),
    // Stated with every report, because a count of zero is the interesting number here.
    summary: `${counts.ready} ready, ${counts.gateway_only} reachable via an OpenAI-compatible endpoint, ${counts.pending} pending`,
  })
}
