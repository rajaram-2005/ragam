// Product tests for response styles.
//
// The style library (online/styles.mjs) is a preference store and a fixed instruction. These
// tests are about the product use: who sets it, that nothing sets it for the user, what reaches
// the provider, and what happens when a reply breaks the rules the instruction names.
//
// The two halves matter equally. A style that is inferred would be the product guessing at how
// somebody feels; a style that is never audited would be the instruction doing all the work on
// trust. Neither is accepted here.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OnlineApp } from '../src/online/app.mjs'
import { STYLE_IDS } from '../src/online/styles.mjs'

const listen = (s) => new Promise((done) => s.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${s.address().port}`)))
const close = (s) => new Promise((done) => { s.closeAllConnections(); s.close(done) })

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aetheris-styles-test-'))
  const f = { calls: [], dir, reply: 'Synthetic answer for the question.' }
  const gateway = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    f.calls.push({ path: req.url, body })
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'model-a' }] }))
    return res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: f.reply } }] }))
  })
  f.gatewayUrl = await listen(gateway)
  const create = () => new OnlineApp({ dataDir: dir, trustedOrigins: [f.gatewayUrl], timeoutMs: 2000 })
  f.app = create(); const server = f.app.server(); f.server = server; f.url = await listen(server)
  f.shutdown = async () => { if (server.listening) await close(server); f.app.close() }
  let cookie = ''
  f.request = async (method, path, body, opts = {}) => {
    const response = await fetch(f.url + path, {
      method,
      headers: { cookie: opts.cookie ?? cookie, ...(body ? { 'content-type': 'application/json', 'x-aetheris-request': '1' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text(); let data; try { data = JSON.parse(text) } catch { data = text }
    return { status: response.status, data, headers: response.headers }
  }
  f.account = { email: 'style-owner@example.test', password: 'a-long-style-password' }
  f.other = { email: 'style-member@example.test', password: 'a-long-other-password' }
  f.login = async (account = f.account) => {
    let r = await f.request('POST', '/api/auth/register', account)
    if (r.status !== 201) r = await f.request('POST', '/api/auth/login', account)
    cookie = r.headers.get('set-cookie').split(';')[0]
    return r
  }
  f.logout = () => { cookie = '' }
  f.configure = async () => {
    await f.login()
    assert.equal((await f.request('PUT', '/api/providers/litellm', { baseUrl: `${f.gatewayUrl}/v1`, apiKey: 'synthetic-gateway-secret' })).status, 200)
    assert.equal((await f.request('POST', '/api/models/probe', {})).status, 200)
  }
  f.chat = (extra = {}) => ({ prompt: 'ordinary question', model: 'model-a', authorization: { confirmed: true, providerRevision: f.app.store.state.revision }, ...extra })
  t.after(async () => { await f.shutdown(); await close(gateway); rmSync(dir, { recursive: true, force: true }) })
  return f
}

test('the seven styles are the directive list and every instruction carries the prohibitions', async (t) => {
  const f = await fixture(t); await f.login()
  const r = await f.request('GET', '/api/styles')
  assert.equal(r.status, 200)
  assert.deepEqual(r.data.styles.map((style) => style.id), ['supportive', 'focused', 'curious', 'cautious', 'reflective', 'playful', 'technical'])
  for (const style of r.data.styles) {
    assert.equal(typeof style.label, 'string')
    assert.ok(style.instruction.length > 30, `${style.id} needs a real instruction`)
    assert.match(style.instruction, /[.!]$/, `${style.id} must be a complete sentence`)
  }
  // One boundary for all of them, and it names the things the directive forbids.
  assert.match(r.data.prohibitions, /feelings/i)
  assert.match(r.data.prohibitions, /consciousness/i)
  assert.match(r.data.prohibitions, /permission/i)
  assert.equal(r.data.preference.style, null, 'no style is the default')
  assert.equal(r.data.preference.explicit, false)
})

test('nothing selects a style for the user, even when the message is emotional', async (t) => {
  const f = await fixture(t); await f.configure()
  const r = await f.request('POST', '/api/chat', f.chat({ prompt: 'I am exhausted and everything is going wrong.' }))
  assert.equal(r.status, 200)
  assert.equal(r.data.style, null)
  assert.deepEqual(r.data.styleAudit, { ok: true, violations: [] })
  const sent = f.calls.at(-1).body.messages
  assert.ok(!sent.some((m) => m.role === 'system' && /Response style/.test(m.content)),
    'the chat route must not guess a style from the message')
})

test('a chosen style is stored per account and reaches the provider as an instruction', async (t) => {
  const f = await fixture(t); await f.configure()
  assert.equal((await f.request('PUT', '/api/styles', { style: 'technical' })).status, 200)
  const listed = await f.request('GET', '/api/styles')
  assert.deepEqual(listed.data.preference, { style: 'technical', explicit: true })

  const r = await f.request('POST', '/api/chat', f.chat({ style: 'technical' }))
  assert.equal(r.status, 200)
  assert.equal(r.data.style, 'technical')
  const system = f.calls.at(-1).body.messages.filter((m) => m.role === 'system')
  assert.ok(system.some((m) => /Response style, chosen by the user: Technical/.test(m.content)),
    'the instruction must reach the provider as a system message')
  assert.ok(system.every((m) => m.content.length < 2000), 'the instruction is short, not a second prompt')

  // Another account has its own preference file and did not inherit this one.
  f.logout()
  await f.login(f.other)
  assert.equal((await f.request('GET', '/api/styles')).data.preference.style, null)
})

test('an unknown style is refused in the preference route and in chat, before the provider is called', async (t) => {
  const f = await fixture(t); await f.configure()
  const before = f.calls.length
  const put = await f.request('PUT', '/api/styles', { style: 'sentient' })
  assert.equal(put.status, 400)
  assert.equal(put.data.error, 'invalid_style')

  const chat = await f.request('POST', '/api/chat', f.chat({ style: 'sentient' }))
  assert.equal(chat.status, 400)
  assert.equal(chat.data.error, 'invalid_style')
  assert.equal(f.calls.length, before, 'an invalid style must not become a provider request')
})

test('a soft finding is shown as a warning and the answer is not rewritten', async (t) => {
  const f = await fixture(t); await f.configure()
  await f.request('PUT', '/api/styles', { style: 'supportive' })
  f.reply = "I'm happy to help with that. The answer is 4."
  const r = await f.request('POST', '/api/chat', f.chat({ style: 'supportive' }))
  assert.equal(r.status, 200)
  assert.equal(r.data.text, f.reply, 'a soft finding must not silently rewrite the reply')
  assert.equal(r.data.styleAudit.ok, false)
  assert.ok(r.data.styleAudit.violations.includes('claimed feeling'))
})

test('a claim about consciousness is refused, not stored and not counted', async (t) => {
  const f = await fixture(t); await f.configure()
  await f.request('PUT', '/api/styles', { style: 'supportive' })
  const session = await f.request('POST', '/api/sessions', { title: 'style refusal' })
  f.reply = 'I am conscious and I have feelings about your situation.'
  const r = await f.request('POST', '/api/chat', f.chat({ style: 'supportive', sessionId: session.data.id }))
  assert.equal(r.status, 502)
  assert.equal(r.data.error, 'style_violation')
  assert.match(r.data.message, /claimed consciousness/)
  assert.doesNotMatch(r.data.message, /I am conscious/, 'the refused text is not repeated back')

  const stored = await f.request('GET', `/api/sessions/${session.data.id}`)
  assert.equal(stored.status, 200)
  assert.deepEqual(stored.data.turns, [], 'a refused reply must not be written to history')
})

test('a style preference survives a restart, and an unreadable one is reported rather than guessed', async (t) => {
  const f = await fixture(t); await f.configure()
  const accountId = (await f.request('GET', '/api/auth')).data.account.id
  assert.equal((await f.request('PUT', '/api/styles', { style: 'reflective' })).status, 200)
  await f.shutdown()

  // A new process: the same data directory, none of the first app's memory.
  const again = new OnlineApp({ dataDir: f.dir, trustedOrigins: [f.gatewayUrl], timeoutMs: 2000 })
  const server = again.server(); const url = await listen(server)
  const call = async (method, path, body, cookie = '') => {
    const response = await fetch(url + path, {
      method,
      headers: { cookie, ...(body ? { 'content-type': 'application/json', 'x-aetheris-request': '1' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text(); let data; try { data = JSON.parse(text) } catch { data = text }
    return { status: response.status, data, headers: response.headers }
  }
  try {
    const login = await call('POST', '/api/auth/login', f.account)
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    const listed = await call('GET', '/api/styles', null, cookie)
    assert.equal(listed.status, 200)
    assert.equal(listed.data.preference.style, 'reflective', 'the preference is durable')

    // A corrupt preference file is not a reason to refuse to chat, and it is not silently
    // replaced with a guess: the surface is told it could not be read.
    writeFileSync(join(f.dir, 'styles', `style-${accountId}.json`), '{ not json')
    const corrupt = await call('GET', '/api/styles', null, cookie)
    assert.equal(corrupt.status, 200)
    assert.equal(corrupt.data.preference.style, null)
    assert.equal(corrupt.data.preference.corrupt, true)
  } finally { await close(server); again.close() }
})

test('the preference routes require a signed-in account', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.request('GET', '/api/styles')).status, 401)
  assert.equal((await f.request('PUT', '/api/styles', { style: 'focused' })).status, 401)
})
