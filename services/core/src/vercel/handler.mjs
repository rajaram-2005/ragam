const MAX_BODY_BYTES = 2 * 1024 * 1024
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function fail(res, status, code, message) {
  if (res.headersSent || res.destroyed) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify({ error: code, message }))
}

function bodySize(body) {
  if (body === undefined || body === null) return 0
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return body.byteLength
  if (typeof body === 'string') return Buffer.byteLength(body)
  try { return Buffer.byteLength(JSON.stringify(body)) } catch { return Number.POSITIVE_INFINITY }
}

/**
 * Adapt the Node request/response pair supplied by Vercel to OnlineApp's existing
 * node:http request listener. The listener is created once per warm Function instance;
 * the app's durable repositories remain responsible for cross-invocation state.
 */
export function createVercelHandler({ appFactory, beforeDispatch = null, maxBodyBytes = MAX_BODY_BYTES } = {}) {
  if (typeof appFactory !== 'function') throw new TypeError('appFactory must be a function')
  if (beforeDispatch !== null && typeof beforeDispatch !== 'function') throw new TypeError('beforeDispatch must be a function when provided')
  const bodyLimit = Math.max(1024, Math.min(MAX_BODY_BYTES, Number(maxBodyBytes) || MAX_BODY_BYTES))
  let initialized = null

  async function getRuntime() {
    if (!initialized) {
      initialized = Promise.resolve().then(appFactory).then((app) => {
        if (!app || typeof app.server !== 'function') throw new TypeError('hosted Core factory must return an OnlineApp')
        const server = app.server()
        return { app, server }
      }).catch((error) => {
        initialized = null
        throw error
      })
    }
    return initialized
  }

  return async function vercelCoreHandler(req, res) {
    const declared = Number(req.headers?.['content-length'])
    if ((Number.isFinite(declared) && declared > bodyLimit) || bodySize(req.body) > bodyLimit) {
      return fail(res, 413, 'body_too_large', 'Request exceeds the Core 2 MiB limit.')
    }
    try {
      if (beforeDispatch && await beforeDispatch(req, res) === true) return
      const { server } = await getRuntime()
      const incomingId = req.headers?.['x-request-id']
      if (typeof incomingId === 'string' && REQUEST_ID.test(incomingId)) {
        // OnlineApp validates and echoes this same id. Do not synthesize a trusted id from
        // arbitrary user input; the frontend proxy generates it for every forwarded call.
        req.headers['x-request-id'] = incomingId
      }
      server.emit('request', req, res)
    } catch {
      fail(res, 503, 'core_startup_failed', 'Core could not initialize its hosted storage. Check server-side deployment configuration.')
    }
  }
}
