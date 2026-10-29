import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

import handler, { proxyRequest } from '../api/[...path].js'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function close(server) {
  return new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

test('Vercel proxy preserves bodies, cookies, status, streaming, and fails closed on unsafe routes or upstream errors', async (t) => {
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
  assert.equal(vercel.outputDirectory, 'dist')
  assert.equal(vercel.functions['api/**/*.js'].maxDuration, 60)
  const render = readFileSync(new URL('../../../render.yaml', import.meta.url), 'utf8')
  assert.match(render, /autoDeploy: false/)
  assert.match(render, /healthCheckPath: \/api\/health/)
  assert.match(render, /mountPath: \/var\/data/)
  assert.match(render, /value: \/var\/data\/online/)

  let seen = null
  const upstream = createServer(async (req, res) => {
    if (req.url === '/api/health') {
      res.setHeader('content-type', 'application/json')
      res.end('{"status":"ok"}')
      return
    }
    if (req.url.startsWith('/api/echo')) {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      seen = { url: req.url, cookie: req.headers.cookie, origin: req.headers.origin, marker: req.headers['x-aetheris-request'], requestId: req.headers['x-request-id'], body: Buffer.concat(chunks) }
      res.statusCode = 207
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', 'public, max-age=3600')
      res.setHeader('set-cookie', ['first=one; Path=/api; HttpOnly', 'second=two; Path=/api; SameSite=Strict'])
      res.end(JSON.stringify({ accepted: true }))
      return
    }
    if (req.url === '/api/binary') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      res.statusCode = 206
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('content-range', 'bytes 0-4/5')
      res.setHeader('accept-ranges', 'bytes')
      res.end(Buffer.concat(chunks))
      return
    }
    if (req.url === '/api/stream') {
      res.setHeader('content-type', 'text/event-stream')
      res.setHeader('cache-control', 'no-store')
      res.write('data: first\n\n')
      setTimeout(() => res.end('data: second\n\n'), 15)
      return
    }
    if (req.url === '/api/slow') {
      setTimeout(() => { if (!res.destroyed) res.end('late') }, 100)
      return
    }
    if (req.url === '/api/failure') {
      res.statusCode = 502
      res.setHeader('content-type', 'application/json')
      res.end('{"error":"upstream_failure"}')
      return
    }
    if (req.url === '/api/redirect') {
      res.statusCode = 302
      res.setHeader('location', 'https://internal-core.invalid/private')
      res.end('redirect')
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  const coreOrigin = await listen(upstream)
  t.after(() => close(upstream))

  const proxy = createServer((req, res) => {
    void proxyRequest(req, res, { coreOrigin, allowLoopbackForTests: true, upstreamTimeoutMs: 500 })
  })
  const proxyUrl = await listen(proxy)
  t.after(() => close(proxy))

  const savedCoreApiUrl = process.env.CORE_API_URL
  const savedRuntimeNodeEnv = process.env.NODE_ENV
  process.env.CORE_API_URL = coreOrigin
  process.env.NODE_ENV = 'development'
  const configuredProxy = createServer((req, res) => { void handler(req, res) })
  try {
    const configuredUrl = await listen(configuredProxy)
    const configuredHealth = await fetch(`${configuredUrl}/api/health`)
    assert.equal(configuredHealth.status, 200, 'the Vercel handler reads CORE_API_URL at invocation time')
    assert.deepEqual(await configuredHealth.json(), { status: 'ok' })
  } finally {
    await close(configuredProxy)
    if (savedCoreApiUrl === undefined) delete process.env.CORE_API_URL
    else process.env.CORE_API_URL = savedCoreApiUrl
    if (savedRuntimeNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = savedRuntimeNodeEnv
  }

  const echoed = await fetch(`${proxyUrl}/api/echo?keep=this`, {
    headers: {
      cookie: 'aetheris_session=test-token',
      origin: 'https://ragam.example',
      'sec-fetch-site': 'same-origin',
      'x-aetheris-request': '1',
    },
  })
  assert.equal(echoed.status, 207)
  assert.deepEqual(await echoed.json(), { accepted: true })
  assert.equal(seen.url, '/api/echo?keep=this')
  assert.equal(seen.cookie, 'aetheris_session=test-token')
  assert.equal(seen.origin, 'https://ragam.example')
  assert.equal(seen.marker, '1')
  assert.match(seen.requestId, /^[0-9a-f-]{36}$/i)
  assert.equal(echoed.headers.get('cache-control'), 'private, no-store', 'the proxy must not cache authenticated API responses')
  assert.match(echoed.headers.get('x-request-id'), /^[0-9a-f-]{36}$/i)
  assert.deepEqual(echoed.headers.getSetCookie(), [
    'first=one; Path=/api; HttpOnly',
    'second=two; Path=/api; SameSite=Strict',
  ])

  const oversized = await fetch(`${proxyUrl}/api/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.alloc(2 * 1024 * 1024 + 1),
  })
  assert.equal(oversized.status, 413)
  assert.equal((await oversized.json()).error, 'proxy_rejected')

  const bytes = Buffer.from([0, 1, 2, 127, 128, 255])
  const binary = await fetch(`${proxyUrl}/api/binary`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  })
  assert.equal(binary.status, 206)
  assert.deepEqual(Buffer.from(await binary.arrayBuffer()), bytes)
  assert.equal(binary.headers.get('content-range'), 'bytes 0-4/5')
  assert.equal(binary.headers.get('accept-ranges'), 'bytes')

  const stream = await fetch(`${proxyUrl}/api/stream`)
  assert.equal(stream.status, 200)
  assert.equal(await stream.text(), 'data: first\n\ndata: second\n\n')

  const upstreamFailure = await fetch(`${proxyUrl}/api/failure`)
  assert.equal(upstreamFailure.status, 502)
  assert.deepEqual(await upstreamFailure.json(), { error: 'upstream_failure' })

  const redirect = await fetch(`${proxyUrl}/api/redirect`)
  assert.equal(redirect.status, 502, 'Core redirects must not escape the same-origin proxy')
  assert.equal(redirect.headers.get('location'), null, 'internal redirect targets must not be exposed')
  assert.deepEqual(await redirect.json(), { error: 'core_unavailable', message: 'The Core API returned an unexpected redirect.' })

  const unsafePath = await fetch(`${proxyUrl}/api/%2e%2e/private`)
  assert.equal(unsafePath.status, 404)
  const outsidePrefix = await fetch(`${proxyUrl}/outside`)
  assert.equal(outsidePrefix.status, 404)
  const unsupported = await fetch(`${proxyUrl}/api/health`, { method: 'OPTIONS' })
  assert.equal(unsupported.status, 405)

  const timeoutProxy = createServer((req, res) => {
    void proxyRequest(req, res, { coreOrigin, allowLoopbackForTests: true, upstreamTimeoutMs: 10 })
  })
  const timeoutUrl = await listen(timeoutProxy)
  t.after(() => close(timeoutProxy))
  const timeout = await fetch(`${timeoutUrl}/api/slow`)
  assert.equal(timeout.status, 504)
  assert.deepEqual(await timeout.json(), { error: 'core_unavailable', message: 'The Core API request timed out.' })

  const unavailableUpstream = createServer()
  const unavailableOrigin = await listen(unavailableUpstream)
  await close(unavailableUpstream)
  const savedConsoleError = console.error
  const proxyFailureLogs = []
  console.error = (line) => proxyFailureLogs.push(String(line))
  const unavailableProxy = createServer((req, res) => {
    void proxyRequest(req, res, { coreOrigin: unavailableOrigin, allowLoopbackForTests: true })
  })
  try {
    const unavailableUrl = await listen(unavailableProxy)
    const unavailable = await fetch(`${unavailableUrl}/api/health`)
    assert.equal(unavailable.status, 502)
    assert.equal((await unavailable.json()).error, 'core_unavailable')
    assert.ok(proxyFailureLogs.some((line) => line.includes('"event":"core_proxy_failed"')))
    assert.equal(proxyFailureLogs.some((line) => line.includes(unavailableOrigin)), false, 'proxy logs must not expose internal upstream URLs')
  } finally {
    await close(unavailableProxy)
    console.error = savedConsoleError
  }

  const unconfiguredProxy = createServer((req, res) => {
    void proxyRequest(req, res, { coreOrigin: '' })
  })
  const unconfiguredUrl = await listen(unconfiguredProxy)
  t.after(() => close(unconfiguredProxy))
  const unconfigured = await fetch(`${unconfiguredUrl}/api/health`)
  assert.equal(unconfigured.status, 503)
  assert.equal((await unconfigured.json()).error, 'core_unconfigured')

  const savedNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const insecureProxy = createServer((req, res) => {
      void proxyRequest(req, res, { coreOrigin })
    })
    const insecureUrl = await listen(insecureProxy)
    t.after(() => close(insecureProxy))
    const insecure = await fetch(`${insecureUrl}/api/health`)
    assert.equal(insecure.status, 503, 'production must reject an HTTP loopback Core origin')
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = savedNodeEnv
  }
})
