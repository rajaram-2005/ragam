import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { AccountStore } from '../src/online/accounts.mjs'
import { OnlineApp } from '../src/online/app.mjs'

const OWNER_EMAIL = 'owner@example.test'
const PASSWORD = 'a-long-local-owner-password'

function directory() {
  return mkdtempSync(join(tmpdir(), 'ragam-local-single-user-'))
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
}

function send(url, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const req = httpRequest(target, { method, headers: { host: target.host, ...headers } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }))
    })
    req.once('error', reject)
    if (body !== undefined) req.end(JSON.stringify(body))
    else req.end()
  })
}

function localApp(t, dataDir) {
  const app = new OnlineApp({ dataDir, localSingleUser: true })
  const server = app.server()
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    app.close()
  })
  return { app, server }
}

test('fresh local mode opens a persistent workspace without accounts or a session cookie', async (t) => {
  const dir = directory()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { app, server } = localApp(t, dir)
  const url = await listen(server)

  const first = await send(`${url}/api/auth`)
  assert.equal(first.status, 200)
  assert.equal(first.body.authenticated, true)
  assert.equal(first.body.mode, 'local')
  assert.equal(first.body.account.mode, 'local')
  assert.equal(first.body.account.role, 'owner')
  assert.equal('email' in first.body.account, false)
  assert.equal(first.headers['set-cookie'], undefined)
  assert.equal(await app.accounts.count(), 0)
  assert.equal((await send(`${url}/api/providers`)).status, 200)

  const identity = JSON.parse(readFileSync(join(dir, 'local-identity.json'), 'utf8'))
  assert.equal(identity.accountId, first.body.account.id)
  assert.equal(statSync(join(dir, 'local-identity.json')).mode & 0o777, 0o600)
})

test('local identity is stable across restarts and account endpoints are disabled', async (t) => {
  const dir = directory()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let firstId
  {
    const { app, server } = localApp(t, dir)
    const url = await listen(server)
    firstId = (await send(`${url}/api/auth`)).body.account.id
    const response = await send(`${url}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aetheris-request': '1', origin: url },
      body: { email: OWNER_EMAIL, password: PASSWORD },
    })
    assert.equal(response.status, 404)
    assert.equal(await app.accounts.count(), 0)
  }
  const { app, server } = localApp(t, dir)
  const url = await listen(server)
  assert.equal((await send(`${url}/api/auth`)).body.account.id, firstId)
  assert.equal(await app.accounts.count(), 0)
})

test('local mode preserves a sole account principal while erasing email and credentials', async (t) => {
  const dir = directory()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const accounts = new AccountStore({ dir, ownerEmail: OWNER_EMAIL, registrationEnabled: true })
  const owner = accounts.register({ email: OWNER_EMAIL, password: PASSWORD })
  accounts.close()

  const { app, server } = localApp(t, dir)
  const url = await listen(server)
  const status = await send(`${url}/api/auth`)
  assert.equal(status.body.account.id, owner.id)
  assert.equal(status.body.account.mode, 'local')
  assert.equal(await app.accounts.count(), 0)
  assert.deepEqual(app.accounts.pendingResets(), [])
  const database = readFileSync(join(dir, 'accounts.sqlite'))
  assert.equal(database.includes(Buffer.from(OWNER_EMAIL)), false)
})

test('local mode refuses non-loopback Host headers before serving APIs', async (t) => {
  const dir = directory()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { server } = localApp(t, dir)
  const url = await listen(server)
  const blocked = await send(`${url}/api/auth`, { headers: { host: 'external.example' } })
  assert.equal(blocked.status, 403)
  assert.equal(blocked.body.error, 'local_only')
})

test('local mode refuses ambiguous multi-account migration without deleting accounts', (t) => {
  const dir = directory()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const accounts = new AccountStore({ dir, maxAccounts: 2, ownerEmail: OWNER_EMAIL, registrationEnabled: true })
  accounts.register({ email: OWNER_EMAIL, password: PASSWORD })
  accounts.register({ email: 'member@example.test', password: 'another-long-local-password' })
  accounts.close()

  assert.throws(() => new OnlineApp({ dataDir: dir, localSingleUser: true }), { code: 'local_mode_multiple_accounts' })
  const untouched = new AccountStore({ dir })
  assert.equal(untouched.count(), 2)
  assert.ok(untouched.findByEmail(OWNER_EMAIL))
  untouched.close()
})
