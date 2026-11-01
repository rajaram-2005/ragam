import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createVercelHandler } from '../src/vercel/handler.mjs'

function response() {
  const res = new EventEmitter()
  res.headers = new Map()
  res.headersSent = false
  res.destroyed = false
  res.setHeader = (name, value) => res.headers.set(name.toLowerCase(), value)
  res.end = (value = '') => { res.body = String(value); res.headersSent = true; res.writableEnded = true }
  return res
}

function request({ method = 'GET', url = '/api/health', headers = {}, body } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers
  req.body = body
  return req
}

test('Vercel adapter initializes OnlineApp once per warm instance and dispatches requests', async () => {
  let starts = 0
  const calls = []
  const app = {
    server() {
      const server = new EventEmitter()
      server.emit = (event, req, res) => {
        calls.push([event, req.url])
        res.statusCode = 200
        res.end('ok')
        return true
      }
      return server
    },
  }
  const handler = createVercelHandler({ appFactory: async () => { starts += 1; return app } })
  const first = response(), second = response()
  await handler(request(), first)
  await handler(request({ url: '/api/config' }), second)
  assert.equal(starts, 1)
  assert.deepEqual(calls, [['request', '/api/health'], ['request', '/api/config']])
  assert.equal(first.body, 'ok')
  assert.equal(second.body, 'ok')
})

test('Vercel adapter rejects oversized parsed bodies before Core starts', async () => {
  let starts = 0
  const handler = createVercelHandler({ appFactory: async () => { starts += 1; throw new Error('must not start') } })
  const res = response()
  await handler(request({ method: 'POST', headers: { 'content-length': '3000000' }, body: 'x' }), res)
  assert.equal(starts, 0)
  assert.equal(res.statusCode, 413)
  assert.equal(JSON.parse(res.body).error, 'body_too_large')
})

test('deployment gate can reject local-only routes before initializing remote storage', async () => {
  let starts = 0
  const handler = createVercelHandler({
    appFactory: async () => { starts += 1; throw new Error('must not start for local-only work') },
    beforeDispatch: (req, res) => {
      if (req.url !== '/api/klyvaron/worker') return false
      res.statusCode = 501
      res.end('{"error":"local_runtime_required"}')
      return true
    },
  })
  const res = response()
  await handler(request({ url: '/api/klyvaron/worker' }), res)
  assert.equal(starts, 0)
  assert.equal(res.statusCode, 501)
  assert.equal(JSON.parse(res.body).error, 'local_runtime_required')
})

test('Vercel adapter retries a failed cold-start initialization on the next request', async () => {
  let attempts = 0
  const app = { server: () => ({ emit: (_event, _req, res) => { res.statusCode = 200; res.end('ready') } }) }
  const handler = createVercelHandler({ appFactory: async () => {
    attempts += 1
    if (attempts === 1) throw new Error('secret startup details')
    return app
  } })
  const first = response(), second = response()
  await handler(request(), first)
  assert.equal(first.statusCode, 503)
  assert.doesNotMatch(first.body, /secret startup details/)
  await handler(request(), second)
  assert.equal(second.statusCode, 200)
  assert.equal(attempts, 2)
})
