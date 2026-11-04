import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

const MIME = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
})

export function reserveLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const server = createTcpServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close((error) => error ? reject(error) : resolvePort(port))
    })
  })
}

export function listenLoopback(server) {
  return new Promise((resolvePort, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolvePort(server.address().port))
  })
}

function sendFile(req, res, file) {
  let info
  try { info = statSync(file) } catch { return false }
  if (!info.isFile()) return false
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': /-[\w-]{8,}\./.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') res.end()
  else createReadStream(file).on('error', () => res.destroy()).pipe(res)
  return true
}

/** Serve the built SPA and proxy same-origin /api requests to a loopback-only Core. */
export function createLocalWebServer(webRoot, upstreamPort) {
  const absoluteWebRoot = resolve(webRoot)
  if (!existsSync(resolve(absoluteWebRoot, 'index.html'))) throw new Error(`Built web app is missing at ${absoluteWebRoot}; build apps/web first.`)

  return createHttpServer((req, res) => {
    let rawPath
    try { rawPath = decodeURIComponent(String(req.url ?? '/').split('?', 1)[0]) } catch {
      res.writeHead(400).end('Bad path')
      return
    }
    if (rawPath.split(/[\\/]/).includes('..')) {
      res.writeHead(403).end('Forbidden')
      return
    }
    let url
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1') } catch {
      res.writeHead(400).end('Bad request')
      return
    }

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const upstream = httpRequest({
        host: '127.0.0.1',
        port: upstreamPort,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        // Keep the browser's loopback Host and same-origin Origin. Core checks both
        // before accepting a local-workspace mutation.
        headers: req.headers,
      }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(res)
      })
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ error: 'core_unavailable', message: 'Ragam Core is unavailable. Close and reopen the desktop app to restart it.' }))
      })
      req.on('aborted', () => upstream.destroy())
      res.on('close', () => { if (!res.writableEnded) upstream.destroy() })
      req.pipe(upstream)
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end()
      return
    }

    let decoded
    try { decoded = decodeURIComponent(url.pathname) } catch {
      res.writeHead(400).end('Bad path')
      return
    }
    // Normalize both separators before resolving so encoded Windows backslashes
    // cannot bypass the same traversal check used on POSIX platforms.
    const candidate = resolve(absoluteWebRoot, `.${decoded.replaceAll('\\', '/')}`)
    const rel = relative(absoluteWebRoot, candidate)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      res.writeHead(403).end('Forbidden')
      return
    }
    if (sendFile(req, res, candidate)) return
    if (sendFile(req, res, resolve(candidate, 'index.html'))) return
    if (sendFile(req, res, resolve(absoluteWebRoot, 'index.html'))) return
    res.writeHead(404).end('Not found')
  })
}
