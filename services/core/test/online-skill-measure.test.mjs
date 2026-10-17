// Product tests for measured skill comparisons.
//
// A structural review is a gate, not evidence that a procedure changes an answer. These tests
// exercise the measurement route: the same cases under two versions, deterministic scoring, a
// regression rule, honest no-difference verdicts, and a record that keeps the measurement but not
// the prompt.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OnlineApp } from '../src/online/app.mjs'

const listen = (s) => new Promise((done) => s.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${s.address().port}`)))
const close = (s) => new Promise((done) => { s.closeAllConnections(); s.close(done) })

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aetheris-measure-test-'))
  const f = { calls: [], dir, answer: () => 'The answer is 4.' }
  const gateway = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    f.calls.push({ path: req.url, body })
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'model-a' }] }))
    const system = body.messages?.find((m) => m.role === 'system')?.content ?? ''
    return res.end(JSON.stringify({
      model: body.model,
      choices: [{ message: { content: f.answer({ system, prompt: body.messages?.at(-1)?.content }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }))
  })
  f.gatewayUrl = await listen(gateway)
  const create = () => new OnlineApp({ dataDir: dir, trustedOrigins: [f.gatewayUrl], timeoutMs: 2000 })
  f.app = create(); const server = f.app.server(); f.server = server; f.url = await listen(server)
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
  f.owner = { email: 'measure-owner@example.test', password: 'a-long-measure-password' }
  f.member = { email: 'measure-member@example.test', password: 'a-long-member-password' }
  f.login = async (account = f.owner) => {
    let r = await f.request('POST', '/api/auth/register', account)
    if (r.status !== 201) r = await f.request('POST', '/api/auth/login', account)
    cookie = r.headers.get('set-cookie').split(';')[0]
    return r
  }
  f.configure = async () => {
    await f.login()
    assert.equal((await f.request('PUT', '/api/providers/litellm', { baseUrl: `${f.gatewayUrl}/v1`, apiKey: 'synthetic-gateway-secret' })).status, 200)
    assert.equal((await f.request('POST', '/api/models/probe', {})).status, 200)
  }
  f.install = async (version, marker) => f.request('POST', '/api/skills', {
    name: 'measured-procedure',
    description: 'A procedure used to compare two versions',
    whenToUse: 'When a measurement needs two versions of one procedure.',
    steps: [`Use the ${marker} marker.`, 'State the answer in one sentence.'],
    verification: 'The answer contains the expected phrase.',
    version,
  })
  f.measure = (extra = {}) => ({
    baselineVersion: '1.0.0', candidateVersion: '1.1.0', model: 'model-a',
    cases: [{ prompt: 'What is the answer?', mustInclude: ['4'] }],
    authorization: { confirmed: true, providerRevision: f.app.store.state.revision },
    ...extra,
  })
  f.shutdown = async () => { if (server.listening) await close(server); f.app.close() }
  t.after(async () => { await f.shutdown(); await close(gateway); rmSync(dir, { recursive: true, force: true }) })
  return f
}

test('a candidate that passes a case the baseline failed is a measured improvement', async (t) => {
  const f = await fixture(t); await f.configure()
  assert.equal((await f.install('1.0.0', 'baseline-marker')).status, 201)
  assert.equal((await f.install('1.1.0', 'candidate-marker')).status, 201)
  f.answer = ({ system }) => system.includes('candidate-marker') ? 'The answer is 4.' : 'The answer is five.'

  const r = await f.request('POST', '/api/skills/measured-procedure/measure', f.measure())
  assert.equal(r.status, 200)
  assert.equal(r.data.measured, true)
  assert.equal(r.data.verdict, 'measured_improvement')
  assert.equal(r.data.baseline.passed, 0)
  assert.equal(r.data.candidate.passed, 1)
  assert.equal(r.data.providerCalls, 2)
  assert.equal(typeof r.data.baseline.meanLatencyMs, 'number')
  assert.equal(r.data.candidate.totalTokens, 15)
  assert.equal(f.calls.length, 3, 'the model probe and two measured calls')

  // The record keeps the check and the measurement, not the prompt.
  assert.ok(!JSON.stringify(r.data).includes('What is the answer?'), 'the measurement record must not copy the prompt')
  assert.equal(r.data.cases[0].promptDigest.length, 16)
  const log = readFileSync(join(f.dir, 'skills', 'measurements.jsonl'), 'utf8')
  assert.ok(!log.includes('What is the answer?'))

  const described = await f.request('GET', '/api/skills/measured-procedure')
  assert.equal(described.data.measurements.length, 1)
  assert.equal(described.data.measurements[0].verdict, 'measured_improvement')
  assert.deepEqual(described.data.versions.map((v) => v.version), ['1.0.0', '1.1.0'])
  assert.equal(described.data.state, 'candidate', 'measurement never promotes a version')
})

test('a case the baseline passed and the candidate failed is a regression, whatever the aggregate', async (t) => {
  const f = await fixture(t); await f.configure()
  await f.install('1.0.0', 'baseline-marker')
  await f.install('1.1.0', 'candidate-marker')
  f.answer = ({ system }) => system.includes('baseline-marker') ? 'The answer is 4.' : 'The answer is five.'
  const r = await f.request('POST', '/api/skills/measured-procedure/measure', f.measure())
  assert.equal(r.status, 200)
  assert.equal(r.data.verdict, 'regression')
  assert.deepEqual(r.data.regressions, ['case-1'])
  assert.match(r.data.reason, /case-1/)
})

test('two versions that score the same are reported as no measured difference', async (t) => {
  const f = await fixture(t); await f.configure()
  await f.install('1.0.0', 'baseline-marker')
  await f.install('1.1.0', 'candidate-marker')
  f.answer = () => 'The answer is 4.'
  const r = await f.request('POST', '/api/skills/measured-procedure/measure', f.measure())
  assert.equal(r.status, 200)
  assert.equal(r.data.verdict, 'no_difference_measured')
  assert.match(r.data.reason, /not an improvement/i)
})

test('measurement needs the owner, explicit consent and a listed model before any call', async (t) => {
  const f = await fixture(t); await f.configure()
  await f.install('1.0.0', 'baseline-marker')
  await f.install('1.1.0', 'candidate-marker')
  const before = f.calls.length

  const noConsent = await f.request('POST', '/api/skills/measured-procedure/measure', f.measure({ authorization: { confirmed: false, providerRevision: f.app.store.state.revision } }))
  assert.equal(noConsent.status, 403, JSON.stringify(noConsent.data))
  assert.equal(noConsent.data.error, 'consent_required')

  const badModel = await f.request('POST', '/api/skills/measured-procedure/measure', f.measure({ model: 'not-listed' }))
  assert.equal(badModel.status, 409)
  assert.equal(badModel.data.error, 'model_unavailable')
  assert.equal(f.calls.length, before, 'a refused measurement must not spend a provider call')

  await f.login(f.member)
  const member = await f.request('POST', '/api/skills/measured-procedure/measure', f.measure())
  assert.equal(member.status, 403, JSON.stringify(member.data))
  assert.equal(member.data.error, 'owner_required')
})

test('an invalid case, one version, or an unknown version is refused before the provider', async (t) => {
  const f = await fixture(t); await f.configure()
  await f.install('1.0.0', 'baseline-marker')
  await f.install('1.1.0', 'candidate-marker')
  const before = f.calls.length

  const noCheck = await f.request('POST', '/api/skills/measured-procedure/measure', f.measure({ cases: [{ prompt: 'What?' }] }))
  assert.equal(noCheck.status, 400)
  assert.equal(noCheck.data.error, 'invalid_measurement')

  const oneVersion = await f.request('POST', '/api/skills/measured-procedure/measure', f.measure({ candidateVersion: '1.0.0' }))
  assert.equal(oneVersion.status, 400)

  const unknown = await f.request('POST', '/api/skills/measured-procedure/measure', f.measure({ baselineVersion: '9.9.9' }))
  assert.equal(unknown.status, 404)
  assert.equal(unknown.data.error, 'skill_not_found')

  const tooMany = await f.request('POST', '/api/skills/measured-procedure/measure', f.measure({ cases: Array.from({ length: 6 }, () => ({ prompt: 'What?', mustInclude: ['4'] })) }))
  assert.equal(tooMany.status, 400)
  assert.equal(f.calls.length, before)
})

test('measurements survive a restart and are listed with the skill', async (t) => {
  const f = await fixture(t); await f.configure()
  await f.install('1.0.0', 'baseline-marker')
  await f.install('1.1.0', 'candidate-marker')
  f.answer = () => 'The answer is 4.'
  assert.equal((await f.request('POST', '/api/skills/measured-procedure/measure', f.measure())).status, 200)
  await f.shutdown()

  const again = new OnlineApp({ dataDir: f.dir, trustedOrigins: [f.gatewayUrl], timeoutMs: 2000 })
  const server = again.server(); const url = await listen(server)
  try {
    const login = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aetheris-request': '1' }, body: JSON.stringify(f.owner) })
    const cookie = login.headers.get('set-cookie').split(';')[0]
    const described = await fetch(`${url}/api/skills/measured-procedure`, { headers: { cookie } })
    const body = await described.json()
    assert.equal(described.status, 200)
    assert.equal(body.measurements.length, 1)
    assert.equal(body.measurements[0].verdict, 'no_difference_measured')
  } finally { await close(server); again.close() }
})
