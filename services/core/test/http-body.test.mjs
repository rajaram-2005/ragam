import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readBody } from '../src/online/http.mjs'

function request(body, contentType = 'application/json') {
  const req = Readable.from([])
  req.headers = { 'content-type': contentType }
  req.body = body
  req.destroy = () => {}
  return req
}

test('readBody supports a parsed serverless JSON body and overwrites caller ownership fields', async () => {
  const result = await readBody(request({ prompt: 'hello', principal: 'attacker', createdBy: 'attacker' }), { principal: 'account-1' })
  assert.deepEqual(result, { prompt: 'hello', principal: 'account-1' })
})

test('readBody applies the byte limit to parsed serverless payloads', async () => {
  await assert.rejects(readBody(request({ text: 'x'.repeat(2 * 1024 * 1024) })), (error) => error.code === 'body_too_large' && error.status === 413)
})

test('readBody rejects unsupported serverless body shapes and content types safely', async () => {
  await assert.rejects(readBody(request('[]')), (error) => error.code === 'invalid_json')
  await assert.rejects(readBody(request({ ok: true }, 'text/plain')), (error) => error.code === 'invalid_content_type')
})
