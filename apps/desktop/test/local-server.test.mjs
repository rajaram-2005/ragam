import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { createLocalWebServer, listenLoopback, reserveLoopbackPort } from '../local-server.mjs'

const openServers = new Set()
const tempDirs = new Set()

afterEach(async () => {
  await Promise.all([...openServers].map((server) => new Promise((done) => server.close(done))))
  openServers.clear()
  await Promise.all([...tempDirs].map((path) => rm(path, { recursive: true, force: true })))
  tempDirs.clear()
})

async function listen(server) {
  openServers.add(server)
  return listenLoopback(server)
}

async function webRoot() {
  const root = await mkdtemp(join(tmpdir(), 'ragam-desktop-web-'))
  tempDirs.add(root)
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Ragam desktop</title>')
  await writeFile(join(root, 'assets', 'app-12345678.js'), 'globalThis.ragam = true')
  return root
}

test('desktop web server is loopback-only and serves the SPA with safe asset headers', async () => {
  const server = createLocalWebServer(await webRoot(), 1)
  const port = await listen(server)
  assert.equal(server.address().address, '127.0.0.1')

  const page = await fetch(`http://127.0.0.1:${port}/`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
  assert.match(await page.text(), /Ragam desktop/)

  const route = await fetch(`http://127.0.0.1:${port}/#/chat`)
  assert.equal(route.status, 200, 'client-side routes must receive index.html')

  const asset = await fetch(`http://127.0.0.1:${port}/assets/app-12345678.js`)
  assert.equal(asset.status, 200)
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(asset.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(await asset.text(), 'globalThis.ragam = true')

  const denied = await fetch(`http://127.0.0.1:${port}/assets/app-12345678.js`, { method: 'POST' })
  assert.equal(denied.status, 405)
})

test('desktop /api proxy preserves same-origin and CSRF headers for the loopback Core', async () => {
  const core = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ method: req.method, host: req.headers.host, origin: req.headers.origin, csrf: req.headers['x-aetheris-request'], body: Buffer.concat(chunks).toString() }))
  })
  const corePort = await listen(core)
  const desktop = createLocalWebServer(await webRoot(), corePort)
  const desktopPort = await listen(desktop)
  const origin = `http://127.0.0.1:${desktopPort}`

  const response = await fetch(`${origin}/api/example?mode=local`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-aetheris-request': '1' },
    body: JSON.stringify({ consent: true }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    method: 'POST',
    host: `127.0.0.1:${desktopPort}`,
    origin,
    csrf: '1',
    body: '{"consent":true}',
  })
})

test('a stopped Core becomes a clear retryable 503, not a generic proxy 502', async () => {
  const stoppedCorePort = await reserveLoopbackPort()
  const desktop = createLocalWebServer(await webRoot(), stoppedCorePort)
  const port = await listen(desktop)
  const response = await fetch(`http://127.0.0.1:${port}/api/health`)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), {
    error: 'core_unavailable',
    message: 'Ragam Core is unavailable. Close and reopen the desktop app to restart it.',
  })
})

test('desktop web server refuses encoded path traversal instead of serving outside its web root', async () => {
  const server = createLocalWebServer(await webRoot(), 1)
  const port = await listen(server)
  const result = await new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: '/%2e%2e/%2e%2e/etc/passwd' }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }))
    })
    request.once('error', reject)
    request.end()
  })
  assert.equal(result.status, 403)
  assert.doesNotMatch(result.body, /root:/)
})
