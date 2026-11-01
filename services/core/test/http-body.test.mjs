import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readBody } from '../src/online/http.mjs'

function request(body, contentType = 'application/json') {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const req = Readable.from([bytes])
  req.headers = { 'content-type': contentType }
  return req
}

test('readBody streams JSON and overwrites caller ownership fields', async () => {
  const result = await readBody(request({ prompt: 'hello', principal: 'attacker', createdBy: 'attacker' }), { principal: 'account-1' })
  assert.deepEqual(result, { prompt: 'hello', principal: 'account-1' })
})

test('readBody enforces its byte limit while reading a request stream', async () => {
  await assert.rejects(readBody(request({ text: 'x'.repeat(2 * 1024 * 1024) })), (error) => error.code === 'body_too_large' && error.status === 413)
})

test('readBody rejects malformed JSON, non-object payloads, and unsupported content types', async () => {
  await assert.rejects(readBody(request('not-json')), (error) => error.code === 'invalid_json')
  await assert.rejects(readBody(request('[]')), (error) => error.code === 'invalid_json')
  await assert.rejects(readBody(request({ ok: true }, 'text/plain')), (error) => error.code === 'invalid_content_type')
})
