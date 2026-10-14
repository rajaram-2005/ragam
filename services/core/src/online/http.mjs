import { failure } from './gateway.mjs'
export function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value)); return true
}
export async function readBody(req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw failure('invalid_content_type', 'JSON content type required.', 415)
  const chunks = []; let size = 0
  const timer = setTimeout(() => req.destroy(), 15_000)
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > 2 * 1024 * 1024) throw failure('body_too_large', 'Request exceeds 2 MiB.', 413)
      chunks.push(chunk)
    }
    let value
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw failure('invalid_json', 'Invalid JSON request.') }
    if (!value || Array.isArray(value) || typeof value !== 'object') throw failure('invalid_json', 'Expected a JSON object.')
    // One authenticated operator, not caller-selected tenancy.
    delete value.principal; delete value.createdBy
    value.principal = 'owner'
    return value
  } finally { clearTimeout(timer) }
}
