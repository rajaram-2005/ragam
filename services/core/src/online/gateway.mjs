// Online gateway transport. No redirect, retry or alternate-model fallback.
//
// Every runtime here speaks the same OpenAI-compatible wire protocol, `GET {base}/models`
// and `POST {base}/chat/completions` (with SSE when streaming). LiteLLM was the first
// gateway the online entry supported. Ollama and llama.cpp's `llama-server` both expose the same
// `/v1` routes, so they reach the online entry through this one transport. That keeps
// their traffic under the same deadline, size limits, cancellation, redirect refusal and
// destination checks, instead of a second network path with weaker guarantees.
import http from 'node:http'
import https from 'node:https'
import { lookup } from 'node:dns'
import { isIP, BlockList } from 'node:net'

export function failure(code, message, status = 400) { return Object.assign(new Error(message), { code, status }) }

/**
 * The runtimes Provider Settings can point at.
 *
 * `keyRequired` is the only behavioural difference. A LiteLLM gateway is an authenticated
 * service, so it always needs a key. A local Ollama or llama.cpp server usually has none,
 * and a key is sent only if one is stored (`llama-server --api-key` is the case that needs
 * one). Local runtimes are still ONLINE inference: the request leaves this process for the
 * configured endpoint, and the UI and ledger say so.
 */
export const RUNTIMES = Object.freeze({
  litellm: Object.freeze({ id: 'litellm', label: 'LiteLLM', keyRequired: true }),
  ollama: Object.freeze({ id: 'ollama', label: 'Ollama', keyRequired: false }),
  llamacpp: Object.freeze({ id: 'llamacpp', label: 'llama.cpp server', keyRequired: false }),
})

/** The runtime record for a kind. Unknown kinds are refused, never mapped to a default. */
export function runtimeFor(kind = 'litellm') {
  const runtime = Object.hasOwn(RUNTIMES, kind) ? RUNTIMES[kind] : null
  if (!runtime) throw failure('invalid_runtime', 'Choose LiteLLM, Ollama or llama.cpp server.', 400)
  return runtime
}
const blocked = new BlockList(), blocked6 = new BlockList()
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [['::',96],['::ffff:0:0',96],['fc00::',7],['fe80::',10],['ff00::',8],['2001:db8::',32],['2002::',16]]) blocked6.addSubnet(address, prefix, 'ipv6')
export function privateAddress(address) {
  const ip = address.replace(/^\[|\]$/g, '')
  return !isIP(ip) || (isIP(ip) === 6 ? blocked6 : blocked).check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4')
}
export function gatewayUrl(value, trustedOrigins = []) {
  if (typeof value !== 'string' || value.length > 2048) throw failure('invalid_endpoint', 'Gateway URL is too long or invalid.')
  let url
  try { url = new URL(value) } catch { throw failure('invalid_endpoint', 'Enter a valid API base URL.') }
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw failure('invalid_endpoint', 'Use an HTTP(S) base URL without credentials, query or fragment.')
  const trusted = trustedOrigins.includes(url.origin)
  if ((!trusted && url.protocol !== 'https:') || (!trusted && isIP(url.hostname.replace(/^\[|\]$/g, '')) && privateAddress(url.hostname))) throw failure('endpoint_blocked', 'Use public HTTPS. A private gateway requires an operator-configured trusted origin.')
  return url.href.replace(/\/+$/, '')
}

export class OnlineGateway {
  constructor({ trustedOrigins = [], timeoutMs = 120_000, maxBytes = 2 * 1024 * 1024 } = {}) { Object.assign(this, { trustedOrigins, timeoutMs, maxBytes }) }
  async request(config, path, { body, signal, onFrame } = {}) {
    const runtime = runtimeFor(config.kind ?? 'litellm'), label = runtime.label
    const base = gatewayUrl(config.baseUrl, this.trustedOrigins)
    const url = new URL(`${base}${path}`)
    const trusted = this.trustedOrigins.includes(url.origin)
    const payload = body === undefined ? null : JSON.stringify(body)
    if (payload && Buffer.byteLength(payload) > this.maxBytes) throw failure('payload_too_large', 'Assembled request is too large.', 413)
    if (runtime.keyRequired && !config.apiKey) throw failure('provider_not_configured', `Configure a ${label} key in Provider Settings.`, 503)
    if (signal?.aborted) throw failure('cancelled', 'Request cancelled.', 499)
    return await new Promise((resolve, reject) => {
      let req, timer, response, finished = false
      const done = (error, value) => {
        if (finished) return
        finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
        if (error) { response?.destroy(); req?.destroy(); reject(error) } else resolve(value)
      }
      const abort = () => done(failure('cancelled', 'Request cancelled.', 499))
      const safeLookup = (hostname, options, callback) => lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error)
        const allowed = addresses.filter((entry) => trusted || !privateAddress(entry.address))
        if (!allowed.length) return callback(failure('endpoint_blocked', 'Gateway DNS resolves only to blocked addresses.', 403))
        if (options.all) callback(null, allowed)
        else callback(null, allowed[0].address, allowed[0].family)
      })
      req = (url.protocol === 'https:' ? https : http).request(url, {
        method: payload ? 'POST' : 'GET', lookup: safeLookup,
        headers: { ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}), accept: onFrame ? 'text/event-stream' : 'application/json', ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
      }, (res) => {
        response = res
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const code = res.statusCode === 401 || res.statusCode === 403 ? 'provider_auth_failed' : res.statusCode === 429 ? 'provider_rate_limited' : 'provider_error'
          return done(failure(code, `${label} returned HTTP ${res.statusCode}. Check gateway access, model permissions and quota.`, 502))
        }
        if (onFrame && !String(res.headers['content-type']).includes('text/event-stream')) return done(failure('invalid_stream', 'Gateway did not return a streaming response.', 502))
        let text = '', size = 0, streamDone = false
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          if (finished) return
          size += Buffer.byteLength(chunk)
          if (size > this.maxBytes) return done(failure('provider_response_too_large', 'Gateway response exceeds the configured limit.', 502))
          text += chunk
          if (!onFrame) return
          // Handle CRLF even when a CR and LF arrive in separate chunks.
          text = text.replace(/\r\n/g, '\n')
          let boundary
          while ((boundary = text.indexOf('\n\n')) !== -1) {
            const frame = text.slice(0, boundary); text = text.slice(boundary + 2)
            const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
            if (!data) continue
            if (data === '[DONE]') { streamDone = true; continue }
            if (streamDone) return done(failure('invalid_stream', 'Unexpected content after stream completion.', 502))
            try {
              const parsed = JSON.parse(data)
              if (parsed.error) throw Error('upstream error')
              onFrame(parsed)
            } catch { return done(failure('invalid_stream', 'Gateway returned an invalid or failed stream.', 502)) }
          }
        })
        res.on('aborted', () => done(failure('provider_interrupted', 'Gateway response was interrupted.', 502)))
        res.on('error', () => done(failure('provider_interrupted', 'Gateway response failed.', 502)))
        res.on('end', () => {
          if (onFrame) return streamDone ? done(null, null) : done(failure('provider_interrupted', 'Gateway stream ended without completion.', 502))
          try { done(null, JSON.parse(text)) } catch { done(failure('invalid_response', 'Gateway returned invalid JSON.', 502)) }
        })
      })
      req.on('error', (error) => done(error.code === 'endpoint_blocked' ? error : failure('provider_unreachable', `Cannot reach ${label}. Check the endpoint, TLS, DNS and server network access.`, 502)))
      // This timer remains active through DNS, headers AND the entire body/stream.
      timer = setTimeout(() => done(failure('provider_timeout', `${label} request exceeded its total deadline.`, 504)), this.timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      req.end(payload)
    })
  }
  async models(config) {
    const data = await this.request(config, '/models')
    if (!Array.isArray(data.data) || data.data.length > 500) throw failure('invalid_model_list', 'Gateway must return at most 500 model records.', 502)
    return [...new Set(data.data.map((entry) => entry?.id).filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 240 && !/[\x00-\x1f\x7f]/.test(id)))].sort()
  }
}
