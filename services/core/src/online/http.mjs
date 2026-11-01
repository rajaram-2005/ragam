import { failure } from './gateway.mjs'
export function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value)); return true
}
/**
 * Read and bound a JSON request body.
 *
 * `principal` is the identity of the SESSION, supplied by the route layer after
 * authentication. It is overwritten here rather than merged, and any caller-supplied
 * `principal`/`createdBy` is deleted first: tenancy is decided by who signed in, never
 * by a field in the request. With accounts, that value is the account id, so two people
 * on one installation cannot address each other's data by naming a principal.
 */
export async function readBody(req, { principal = 'owner' } = {}) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw failure('invalid_content_type', 'JSON content type required.', 415)
  const chunks = []; let size = 0
  const timer = setTimeout(() => req.destroy(), 15_000)
  try {
    // Vercel's Node adapter may provide a parsed body instead of an unread request stream.
    // Normalize it through the same byte cap and JSON parser so the serverless path cannot
    // bypass the local HTTP route's input limits.
    if (req.body !== undefined) {
      const body = req.body
      let serialized = null
      if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array) && typeof body !== 'string') {
        try { serialized = JSON.stringify(body) } catch { throw failure('invalid_json', 'Invalid JSON request.') }
        if (typeof serialized !== 'string') throw failure('invalid_json', 'Invalid JSON request.')
      }
      const bytes = Buffer.isBuffer(body) ? body
        : body instanceof Uint8Array ? Buffer.from(body)
          : Buffer.from(typeof body === 'string' ? body : serialized)
      size = bytes.length
      if (size > 2 * 1024 * 1024) throw failure('body_too_large', 'Request exceeds 2 MiB.', 413)
      chunks.push(bytes)
    } else {
      for await (const chunk of req) {
        size += chunk.length
        if (size > 2 * 1024 * 1024) throw failure('body_too_large', 'Request exceeds 2 MiB.', 413)
        chunks.push(chunk)
      }
    }
    let value
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw failure('invalid_json', 'Invalid JSON request.') }
    if (!value || Array.isArray(value) || typeof value !== 'object') throw failure('invalid_json', 'Expected a JSON object.')
    delete value.principal; delete value.createdBy
    value.principal = principal
    return value
  } finally { clearTimeout(timer) }
}
