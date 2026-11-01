import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OnlineApp } from '../src/online/app.mjs'

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))

test('OnlineApp refreshes provider state before routing and flushes durable writes before ending the response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ragam-vercel-flush-'))
  const order = []
  const providerStore = {
    async refresh() { order.push('refresh') },
    async flush() { order.push('provider-flush') },
    public() { return { connections: [], preferred: {}, configured: false, models: [], selectedModel: '', revision: 0 } },
    config() { throw new Error('not used') },
  }
  const auditLedger = { record() {}, async flush() { order.push('audit-flush') }, close() {} }
  const app = new OnlineApp({ dataDir: dir, providerStore, auditLedger })
  const server = app.server()
  const origin = await listen(server)
  try {
    const response = await fetch(`${origin}/api/health`)
    assert.equal(response.status, 200)
    assert.deepEqual(order, ['refresh', 'provider-flush', 'audit-flush'])
  } finally {
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })
    app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
