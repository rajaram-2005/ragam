// Fixed metadata-only protocol adapters. No downloads, inference or arbitrary URLs
// from HTTP clients. Endpoint/credential configuration belongs to the operator.
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { catalogError, MAX_RECORDS } from './registry.mjs'

const MAX_BYTES = 2 * 1024 * 1024
const loopback = (url) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
function endpoint(value) {
  const url = new URL(value)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url))) || url.username || url.password || url.search || url.hash) {
    throw catalogError('invalid_source', 'catalog endpoints require HTTPS or loopback HTTP, without embedded credentials or query strings')
  }
  return url
}
async function readJson(response) {
  if (!response.ok) { await response.body?.cancel(); throw catalogError('catalog_http_error', 'catalog HTTP request failed') }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw catalogError('catalog_too_large', 'catalog body exceeds the limit') }
  if (!response.body) throw catalogError('invalid_catalog', 'catalog response has no body')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) throw catalogError('catalog_too_large', 'catalog body exceeds the limit')
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
const array = (value) => {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) throw catalogError('invalid_catalog', 'invalid model list or record limit exceeded')
  return value
}
export function httpCatalogSource({ id, kind, baseUrl, token = null, ttlMs, timeoutMs = 8000 }, guard) {
  if (!['huggingface', 'ollama', 'litellm', 'openai-compatible'].includes(kind)) throw catalogError('invalid_source', 'unsupported catalog adapter')
  const base = endpoint(baseUrl ?? (kind === 'huggingface' ? 'https://huggingface.co' : ''))
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw catalogError('invalid_source', 'invalid catalog timeout')
  if (token !== null && (typeof token !== 'string' || !token || token.length > 8192 || /[\r\n]/.test(token))) throw catalogError('invalid_source', 'invalid catalog credential')
  const url = new URL(base.href.replace(/\/$/, '') + (kind === 'huggingface' ? '/api/models?limit=100&full=true&cardData=true' : kind === 'ollama' ? '/api/tags' : '/models'))
  // A localhost gateway may itself contact remote services. Treat it as external
  // catalog discovery unless it is the dedicated Ollama listing adapter.
  const network = kind === 'ollama' && loopback(base) ? 'loopback' : 'external'
  return { id, kind: `catalog.${kind}/1`, ttlMs, network, endpointOrigin: base.origin, async load({ signal } = {}) {
    if (network === 'external' && guard.offlineEnforced) throw catalogError('EGRESS_BLOCKED', 'external catalog discovery is disabled in Strict Offline', 403)
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted) throw catalogError('cancelled', 'catalog refresh cancelled', 499)
    signal?.addEventListener('abort', abort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    try {
      const response = await guard.fetch(url.href, { method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } })
      const data = await readJson(response)
      let records
      if (kind === 'huggingface') records = array(data).map((m) => ({
        id: m.id ?? m.modelId, revision: m.sha ?? null, publisher: m.author ?? null,
        licence: typeof m.cardData?.license === 'string' ? m.cardData.license : null,
        modelCard: base.protocol === 'https:' ? `${base.href.replace(/\/$/, '')}/${String(m.id ?? m.modelId).split('/').map(encodeURIComponent).join('/')}` : null,
        tasks: m.pipeline_tag ? [m.pipeline_tag] : [],
        baseModels: typeof m.cardData?.base_model === 'string' ? [m.cardData.base_model] : m.cardData?.base_model ?? [],
      }))
      else if (kind === 'ollama') records = array(data?.models).map((m) => ({
        id: m.name ?? m.model, revision: m.digest ?? null, artifactBytes: m.size ?? null,
        family: m.details?.family ?? null, quantization: m.details?.quantization_level ?? null,
        runtimes: ['ollama'], executionLocation: m.remote_model || m.remote_host ? 'online' : null,
        // /api/tags alone does not prove a model's task support or execution locality.
      }))
      else records = array(data?.data).map((m) => ({ id: m.id, publisher: m.owned_by ?? null }))
      if (token && JSON.stringify(records).includes(token)) throw catalogError('invalid_catalog', 'credential appeared in catalog response')
      return { records, coverage: kind === 'huggingface' || data?.has_more ? 'bounded_page' : 'complete_response' }
    } catch (error) {
      if (timedOut) throw catalogError('timeout', 'catalog request timed out', 504)
      if (signal?.aborted) throw catalogError('cancelled', 'catalog refresh cancelled', 499)
      throw error
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  } }
}

/** Optional, trusted server-side config. No source/URL/secret registration over HTTP. */
export function configuredCatalogSources(file, guard) {
  if (!file) return []
  if (statSync(file).size > 64 * 1024) throw catalogError('invalid_source', 'catalog configuration exceeds 64 KiB')
  const config = JSON.parse(readFileSync(file, 'utf8'))
  if (config.schema !== 'aetheris.catalog-sources/1' || !Array.isArray(config.sources) || config.sources.length > 14) throw catalogError('invalid_source', 'invalid catalog configuration envelope')
  return config.sources.map((source) => {
    if (!source || Object.keys(source).some((key) => !['id', 'kind', 'baseUrl', 'tokenFile', 'ttlMs'].includes(key))) throw catalogError('invalid_source', 'unsupported catalog source configuration field')
    let token = null
    if (source.tokenFile) {
      const path = resolve(dirname(file), source.tokenFile)
      if (statSync(path).size > 8192) throw catalogError('invalid_source', 'catalog credential file exceeds the limit')
      token = readFileSync(path, 'utf8').trim()
    }
    return httpCatalogSource({ id: source.id, kind: source.kind, baseUrl: source.baseUrl, ttlMs: source.ttlMs, token }, guard)
  })
}
