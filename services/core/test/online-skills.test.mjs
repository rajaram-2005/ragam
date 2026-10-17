// Product tests for reviewed procedures.
//
// The library's rules are already tested (skills.test.mjs, skills-evaluation.test.mjs,
// skill-store.test.mjs). These tests are about the product use: who may install and validate, what
// is stored, what a member may select, and the one effect a skill has on a chat request — a system
// message containing the procedure. Nothing here executes a skill.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OnlineApp } from '../src/online/app.mjs'
import { SkillService } from '../src/skills/product.mjs'
import { renderSkillDocument } from '../src/skills/lifecycle.mjs'
import { SKILL_STATES } from '../src/skills/registry.mjs'

const listen = (s) => new Promise((done) => s.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${s.address().port}`)))
const close = (s) => new Promise((done) => { s.closeAllConnections(); s.close(done) })

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aetheris-skills-test-'))
  const f = { calls: [], dir }
  const gateway = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    f.calls.push({ path: req.url, body })
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'model-a' }] }))
    return res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: `Synthetic answer for ${body.model}` } }] }))
  })
  f.gatewayUrl = await listen(gateway)
  const create = () => new OnlineApp({ dataDir: dir, trustedOrigins: [f.gatewayUrl], timeoutMs: 2000 })
  f.app = create(); const server = f.app.server(); f.url = await listen(server)
  f.request = async (method, path, body, opts = {}) => {
    const response = await fetch(f.url + path, {
      method,
      headers: { cookie: opts.cookie ?? f.cookie ?? '', ...(body ? { 'content-type': 'application/json', 'x-aetheris-request': '1' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text(); let data; try { data = JSON.parse(text) } catch { data = text }
    return { status: response.status, data, headers: response.headers }
  }
  f.owner = { email: 'owner@example.test', password: 'a-long-owner-password' }
  f.member = { email: 'member@example.test', password: 'a-long-member-password' }
  f.login = async (account = f.owner) => {
    let r = await f.request('POST', '/api/auth/register', account)
    if (r.status !== 201) r = await f.request('POST', '/api/auth/login', account)
    f.cookie = r.headers.get('set-cookie').split(';')[0]
    return r
  }
  f.configure = async () => {
    await f.login()
    assert.equal((await f.request('PUT', '/api/providers/litellm', { baseUrl: `${f.gatewayUrl}/v1`, apiKey: 'synthetic-gateway-secret' })).status, 200)
    assert.equal((await f.request('POST', '/api/models/probe', {})).status, 200)
  }
  f.chat = (extra = {}) => ({ prompt: 'ordinary question', model: 'model-a', authorization: { confirmed: true, providerRevision: f.app.store.state.revision }, ...extra })
  t.after(async () => { await close(server); await close(gateway); f.app.close(); rmSync(dir, { recursive: true, force: true }) })
  return f
}

const procedure = (extra = {}) => ({
  name: 'check-the-date',
  description: 'State what date the evidence was read and never assume it is current',
  whenToUse: 'When an answer depends on something changing over time.',
  steps: ['Name the date the evidence was produced.', 'Say whether that is recent enough for the question.', 'State what a reader should re-check.'],
  pitfalls: ['A remembered date is not evidence.'],
  verification: 'The answer names the evidence date or says it is unknown.',
  tags: ['dates', 'honesty'],
  version: '1.0.0',
  ...extra,
})

test('the built-in procedures are installed, validated and declare no access', async (t) => {
  const f = await fixture(t); await f.login()
  const list = await f.request('GET', '/api/skills')
  assert.equal(list.status, 200)
  assert.deepEqual(list.data.skills.map((skill) => skill.name), ['evidence-first-answer', 'incident-triage', 'release-audit'])
  for (const skill of list.data.skills) {
    assert.equal(skill.state, SKILL_STATES.VALIDATED)
    assert.equal(skill.loadable, true)
    assert.deepEqual(skill.permissions.fsRead, [])
    assert.deepEqual(skill.permissions.fsWrite, [])
    assert.equal(skill.permissions.network, false)
    assert.equal(skill.createdBy, 'bundled')
  }
  const one = await f.request('GET', '/api/skills/evidence-first-answer')
  assert.equal(one.status, 200)
  assert.match(one.data.document, /## Procedure/)
  assert.match(one.data.validation.note, /not a measured improvement/)
})

test('a candidate cannot be used until the owner validates it, and usage is counted only on success', async (t) => {
  const f = await fixture(t); await f.configure()
  const installed = await f.request('POST', '/api/skills', procedure())
  assert.equal(installed.status, 201, JSON.stringify(installed.data))
  assert.equal(installed.data.state, SKILL_STATES.CANDIDATE)
  assert.equal(installed.data.loadable, false)

  const before = f.calls.length
  const refused = await f.request('POST', '/api/chat', f.chat({ skill: 'check-the-date' }))
  assert.equal(refused.status, 409)
  assert.equal(refused.data.error, 'skill_not_validated')
  assert.equal(f.calls.length, before, 'a refused skill must not contact the provider')

  const validated = await f.request('POST', '/api/skills/check-the-date/validate', {})
  assert.equal(validated.status, 200, JSON.stringify(validated.data))
  assert.equal(validated.data.state, SKILL_STATES.VALIDATED)
  assert.equal(validated.data.validation.source, 'structural-review')
  assert.equal(validated.data.validation.checks.every((check) => check.passed), true)
  assert.equal(validated.data.validation.checks.length, 4)

  const answered = await f.request('POST', '/api/chat', f.chat({ skill: 'check-the-date' }))
  assert.equal(answered.status, 200, JSON.stringify(answered.data))
  assert.deepEqual(answered.data.skill, { name: 'check-the-date', version: '1.0.0' })
  const sent = f.calls.at(-1).body.messages
  const system = sent.filter((message) => message.role === 'system').map((message) => message.content).join('\n')
  assert.match(system, /reference material/)
  assert.match(system, /grants no permissions/)
  assert.match(system, /Name the date the evidence was produced/)
  assert.equal(answered.data.text, 'Synthetic answer for model-a')

  const after = await f.request('GET', '/api/skills/check-the-date')
  assert.equal(after.data.usage.useCount, 1)
})

test('a member may read and select procedures but cannot install, validate or delete them', async (t) => {
  const f = await fixture(t); await f.configure()
  await f.login(f.member)
  assert.equal((await f.request('GET', '/api/skills')).status, 200)
  const denied = await f.request('POST', '/api/skills', procedure())
  assert.equal(denied.status, 403)
  assert.equal(denied.data.error, 'owner_required')
  assert.equal((await f.request('POST', '/api/skills/evidence-first-answer/validate', {})).status, 403)
  assert.equal((await f.request('DELETE', '/api/skills/evidence-first-answer', {})).status, 403)

  // Selecting a built-in is the member's own choice.
  const answered = await f.request('POST', '/api/chat', f.chat({ skill: 'incident-triage' }))
  assert.equal(answered.status, 200, JSON.stringify(answered.data))
  assert.equal(answered.data.skill.name, 'incident-triage')
})

test('a new version is a candidate again, and a rollback does not inherit the old review', async (t) => {
  const f = await fixture(t); await f.configure()
  await f.request('POST', '/api/skills', procedure())
  await f.request('POST', '/api/skills/check-the-date/validate', {})

  const second = await f.request('POST', '/api/skills', procedure({ version: '2.0.0', steps: ['First new step.', 'Second new step.'], whenToUse: 'A changed procedure.' }))
  assert.equal(second.status, 201)
  assert.equal(second.data.state, SKILL_STATES.CANDIDATE, 'an unreviewed version must not inherit validation')
  assert.equal((await f.request('POST', '/api/chat', f.chat({ skill: 'check-the-date' }))).status, 409)

  const rolled = await f.request('POST', '/api/skills/check-the-date/rollback', { version: '1.0.0' })
  assert.equal(rolled.status, 200)
  assert.equal(rolled.data.version, '1.0.0')
  assert.equal(rolled.data.state, SKILL_STATES.CANDIDATE, 'rollback restores the text, not a review that was never run on it')
  assert.match(rolled.data.document, /Name the date the evidence was produced/)

  await f.request('POST', '/api/skills/check-the-date/validate', {})
  const used = await f.request('POST', '/api/chat', f.chat({ skill: 'check-the-date' }))
  assert.equal(used.status, 200)
  assert.match(f.calls.at(-1).body.messages.map((m) => m.content).join('\n'), /Name the date the evidence was produced/)
})

test('a disabled procedure is refused, and the refusal contacts nothing', async (t) => {
  const f = await fixture(t); await f.configure()
  const off = await f.request('PATCH', '/api/skills/release-audit', { enabled: false })
  assert.equal(off.status, 200)
  assert.equal(off.data.enabled, false)
  const before = f.calls.length
  const refused = await f.request('POST', '/api/chat', f.chat({ skill: 'release-audit' }))
  assert.equal(refused.status, 409)
  assert.equal(refused.data.error, 'skill_disabled')
  assert.equal(f.calls.length, before)
})

test('a procedure that declares file or network access cannot be selected in chat', () => {
  // A document from elsewhere may declare a scope. Chat has no executor to grant it, so the
  // service refuses rather than sending it as if the scope had been approved.
  const dir = mkdtempSync(join(tmpdir(), 'aetheris-skills-scope-'))
  try {
    const service = new SkillService({ dir })
    const document = renderSkillDocument({
      name: 'read-the-tree', description: 'Read a project tree before answering.', version: '1.0.0',
      createdBy: 'human', author: 'someone', whenToUse: 'When a question depends on files.',
      steps: ['Read the named root.', 'Report the paths that answered the question.'],
      verification: 'The answer names the paths it read.', permissions: { fsRead: ['/srv/project'], fsWrite: [], network: false },
    })
    service.registry.install(document, { state: SKILL_STATES.CANDIDATE })
    service.registry.validate('read-the-tree', { checks: [{ name: 'reviewed elsewhere', passed: true }] })
    assert.throws(() => service.prepareForChat('read-the-tree'), (error) => error.code === 'skill_requires_executor')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a deletion removes the document, leaves a tombstone and is not undone by a restart', async (t) => {
  const f = await fixture(t); await f.login()
  const removed = await f.request('DELETE', '/api/skills/incident-triage?reason=not-for-us', {})
  assert.equal(removed.status, 200)
  assert.equal(removed.data.removed, true)
  assert.equal((await f.request('GET', '/api/skills/incident-triage')).status, 404)

  const again = new SkillService({ dir: join(f.dir, 'skills') })
  assert.equal(again.registry.names().includes('incident-triage'), false, 'a deleted built-in must not be reseeded')
  assert.equal(again.registry.names().includes('release-audit'), true)
  const tombstones = again.store.deletions()
  assert.equal(tombstones.some((entry) => entry.name === 'incident-triage' && entry.reason === 'not-for-us'), true)
})

test('an installed procedure keeps its state, versions and usage across a restart', async (t) => {
  const f = await fixture(t); await f.configure()
  await f.request('POST', '/api/skills', procedure())
  await f.request('POST', '/api/skills/check-the-date/validate', {})
  await f.request('POST', '/api/chat', f.chat({ skill: 'check-the-date' }))

  const again = new SkillService({ dir: join(f.dir, 'skills') })
  const restored = again.describe('check-the-date')
  assert.equal(restored.state, SKILL_STATES.VALIDATED)
  assert.equal(restored.version, '1.0.0')
  assert.equal(restored.usage.useCount, 1)
  assert.match(restored.document, /State what date the evidence was read/)
})

test('install refuses an unusable document at the route, in front of the person who wrote it', async (t) => {
  const f = await fixture(t); await f.login()
  const cases = [
    [{ ...procedure(), name: 'Not A Name' }, 'invalid_skill'],
    [{ ...procedure(), steps: ['only one'] }, 'invalid_skill'],
    [{ ...procedure(), steps: Array.from({ length: 21 }, (_, i) => `step ${i}`) }, 'invalid_skill'],
    [{ ...procedure(), verification: '' }, 'invalid_skill'],
  ]
  for (const [body, code] of cases) {
    const r = await f.request('POST', '/api/skills', body)
    assert.equal(r.status, 400, JSON.stringify(r.data))
    assert.equal(r.data.error, code)
  }
  assert.equal((await f.request('GET', '/api/skills')).data.skills.length, 3, 'a refused install must not be stored')
})
