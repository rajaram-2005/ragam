import test from 'node:test'
import assert from 'node:assert/strict'

import { SupabaseMemoryStore } from '../src/storage/supabase-memory-store.mjs'
import { MemoryError } from '../src/memory/contracts.mjs'

const ACCOUNT = 'a7f83961-b0cd-4af4-903b-8c2a551fa489'
const OTHER = 'b7f83961-b0cd-4af4-903b-8c2a551fa489'
const MEMORY = 'c7f83961-b0cd-4af4-903b-8c2a551fa489'
const SESSION = 'd7f83961-b0cd-4af4-903b-8c2a551fa489'
const CANDIDATE = 'e7f83961-b0cd-4af4-903b-8c2a551fa489'

function sessionRow(overrides = {}) {
  return { id: SESSION, account_id: ACCOUNT, title: 'A conversation', started_at: 100, last_at: 200, turn_count: 1, ...overrides }
}

function turnRow(overrides = {}) {
  return { id: MEMORY, account_id: ACCOUNT, session_id: SESSION, idx: 0, role: 'user', content: 'I prefer concise replies.', created_at: 200, data_class: 'internal', ...overrides }
}

function memoryRow(overrides = {}) {
  return {
    id: MEMORY,
    account_id: ACCOUNT,
    text: 'The user prefers concise replies.',
    kind: 'preference',
    subject: 'response style',
    tags: ['writing'],
    status: 'approved',
    approved_by: 'user',
    approved_at: 100,
    created_at: 100,
    updated_at: 100,
    superseded_by: null,
    source_kind: 'user_statement',
    source_session: null,
    data_class: 'internal',
    consent: 'user_approved',
    purpose: 'personal_context',
    training_use: 'prohibited',
    ...overrides,
  }
}

function fakeClient(respond) {
  const calls = []
  return {
    calls,
    request: async (endpoint, options) => {
      calls.push({ endpoint, options })
      return respond(endpoint, options, calls.length - 1)
    },
  }
}

test('memory reads are account-filtered, bounded and reject a row owned by another account', async () => {
  const client = fakeClient((endpoint, options) => endpoint.endsWith('/ragam_memories')
    ? [memoryRow()]
    : null)
  const store = new SupabaseMemoryStore({ client, accountId: ACCOUNT })
  const memories = await store.listMemories({ limit: 25 })
  assert.equal(memories[0].text, 'The user prefers concise replies.')
  const query = new URLSearchParams(client.calls[0].options.query)
  assert.equal(query.get('account_id'), `eq.${ACCOUNT}`)
  assert.equal(query.get('status'), 'eq.approved')
  assert.equal(query.get('limit'), '25')

  const leaking = new SupabaseMemoryStore({
    client: fakeClient(() => [memoryRow({ account_id: OTHER })]), accountId: ACCOUNT,
  })
  await assert.rejects(leaking.listMemories(), { code: 'supabase_memory_rows_invalid' })
})

test('remember delegates atomic deduplication/caps to SQL and validates the returned consent boundary', async () => {
  const client = fakeClient((endpoint, options) => {
    assert.equal(endpoint, 'rest/v1/rpc/ragam_memory_remember')
    return { ok: true, duplicate: false, memory: memoryRow() }
  })
  const store = new SupabaseMemoryStore({ client, accountId: ACCOUNT, now: () => 900 })
  const result = await store.remember({ text: 'The user prefers concise replies.', kind: 'preference', tags: ['writing'] })
  assert.equal(result.duplicate, false)
  assert.equal(result.memory.approvedBy, 'user')
  const body = client.calls[0].options.body
  assert.equal(body.p_account_id, ACCOUNT)
  assert.equal(body.p_now, 900)
  assert.equal(body.p_source_kind, 'user_statement')
  assert.deepEqual(body.p_tags, ['writing'])

  const invalid = new SupabaseMemoryStore({
    client: fakeClient(() => ({ ok: true, duplicate: false, memory: memoryRow({ training_use: 'allowed' }) })),
    accountId: ACCOUNT,
  })
  await assert.rejects(invalid.remember({ text: 'A memory.' }), { code: 'supabase_memory_row_invalid' })
  await assert.rejects(store.remember({ text: '  ' }), (error) => error instanceof MemoryError && error.code === 'text_required')
})

test('memory deletion, full wipe, candidate approval and supersede use transaction RPCs', async () => {
  const calls = []
  const client = fakeClient((endpoint, options) => {
    calls.push({ endpoint, options, body: options.body })
    if (endpoint.endsWith('ragam_memory_forget')) return { ok: true, memory_id: MEMORY, text_was: true }
    if (endpoint.endsWith('ragam_memory_forget_all')) return { ok: true, deleted_memories: 2, deleted_candidates: 1 }
    if (endpoint.endsWith('ragam_memory_decide_candidate')) return { ok: true, approved: true, duplicate: false, memory: memoryRow(), candidate: {} }
    if (endpoint.endsWith('ragam_memory_supersede')) return { ok: true, superseded: memoryRow({ status: 'superseded', superseded_by: CANDIDATE }), replacement: memoryRow({ id: CANDIDATE, text: 'Updated preference.' }), duplicate: false }
    if (endpoint.endsWith('/ragam_memories')) return [memoryRow()]
    throw new Error(`unexpected endpoint ${endpoint}`)
  })
  const store = new SupabaseMemoryStore({ client, accountId: ACCOUNT })
  assert.deepEqual(await store.forget(MEMORY), { deleted: true, memoryId: MEMORY, textWas: true })
  assert.deepEqual(await store.forgetAll(), { deletedMemories: 2, deletedCandidates: 1 })
  assert.equal((await store.decideCandidate(CANDIDATE, { approve: true, kind: 'preference' })).approved, true)
  assert.equal((await store.supersede(MEMORY, { text: 'Updated preference.' })).replacement.id, CANDIDATE)
  assert.deepEqual(calls.filter((call) => call.endpoint.includes('/rpc/')).map((call) => call.endpoint), [
    'rest/v1/rpc/ragam_memory_forget',
    'rest/v1/rpc/ragam_memory_forget_all',
    'rest/v1/rpc/ragam_memory_decide_candidate',
    'rest/v1/rpc/ragam_memory_supersede',
  ])
  assert.ok(calls.filter((call) => call.options.method === 'POST').every((call) => call.body.p_account_id === ACCOUNT))
  const getQuery = new URLSearchParams(calls.find((call) => call.endpoint.endsWith('/ragam_memories')).options.query)
  assert.equal(getQuery.get('account_id'), `eq.${ACCOUNT}`)
})

test('context retrieval rebuilds BM25 from approved account rows and never queries candidates', async () => {
  const client = fakeClient((endpoint, options) => {
    if (!endpoint.endsWith('/ragam_memories')) return null
    assert.equal(new URLSearchParams(options.query).get('status'), 'eq.approved')
    return [memoryRow()]
  })
  const store = new SupabaseMemoryStore({ client, accountId: ACCOUNT })
  const context = await store.buildContext('concise replies')
  assert.equal(context.hasMemories, true)
  assert.match(context.promptContext, /The user prefers concise replies/)
  assert.equal(context.memories.length, 1)
  assert.equal(client.calls.length, 1, 'retrieval must not fetch pending candidates')
})

test('session append, deletion and stats delegate cross-invocation invariants to Postgres RPCs', async () => {
  const client = fakeClient((endpoint, options) => {
    if (endpoint.endsWith('ragam_memory_append_turn')) return { ok: true, turn: { id: MEMORY, session_id: SESSION, idx: 0, role: 'user', created_at: 200 } }
    if (endpoint.endsWith('ragam_memory_delete_session')) return { ok: true, turns_removed: 3 }
    if (endpoint.endsWith('ragam_memory_stats')) return { memories: 1, supersededMemories: 0, pendingCandidates: 0, sessions: 1, turns: 3, deletionsRecorded: 0 }
    return null
  })
  const store = new SupabaseMemoryStore({ client, accountId: ACCOUNT })
  assert.deepEqual(await store.appendTurn(SESSION, { role: 'user', content: 'Hello' }), {
    id: MEMORY, sessionId: SESSION, idx: 0, role: 'user', createdAt: 200,
  })
  assert.deepEqual(await store.deleteSession(SESSION), { deleted: true, sessionId: SESSION, turnsRemoved: 3 })
  const stats = await store.stats()
  assert.equal(stats.turns, 3)
  assert.equal(client.calls.length, 3)
  assert.ok(client.calls.every((call) => call.options.body.p_account_id === ACCOUNT))
})

test('updates and session creation bind writes to the owner without allowing identity changes', async () => {
  const updated = memoryRow({ text: 'Updated memory.', updated_at: 300 })
  const client = fakeClient((endpoint, options) => {
    if (endpoint.endsWith('/ragam_memories') && options.method === 'GET') return [memoryRow()]
    if (endpoint.endsWith('/ragam_memories') && options.method === 'PATCH') return [updated]
    if (endpoint.endsWith('/ragam_chat_sessions') && options.method === 'GET') return []
    if (endpoint.endsWith('/ragam_chat_sessions') && options.method === 'POST') return [{ ...sessionRow(options.body), account_id: ACCOUNT }]
    throw new Error(`unexpected request ${endpoint} ${options.method}`)
  })
  const store = new SupabaseMemoryStore({ client, accountId: ACCOUNT, now: () => 300 })
  assert.equal((await store.updateMemory(MEMORY, { text: 'Updated memory.' })).text, 'Updated memory.')
  const patch = client.calls.find((call) => call.options.method === 'PATCH')
  const patchQuery = new URLSearchParams(patch.options.query)
  assert.equal(patchQuery.get('account_id'), `eq.${ACCOUNT}`)
  assert.equal(patchQuery.get('id'), `eq.${MEMORY}`)
  assert.equal(Object.hasOwn(patch.options.body, 'account_id'), false)
  assert.equal(Object.hasOwn(patch.options.body, 'id'), false)

  const session = await store.startSession({ title: 'A conversation' })
  assert.equal(session.title, 'A conversation')
  const insert = client.calls.find((call) => call.options.method === 'POST')
  assert.equal(insert.options.body.account_id, ACCOUNT)
})

test('recall and export preserve turn origins and the no-training statement', async () => {
  const client = fakeClient((endpoint, options) => {
    if (endpoint.endsWith('/ragam_chat_turns')) return [turnRow()]
    if (endpoint.endsWith('/ragam_chat_sessions')) return [sessionRow()]
    if (endpoint.endsWith('/ragam_memories')) return [memoryRow()]
    if (endpoint.endsWith('/ragam_memory_candidates') || endpoint.endsWith('/ragam_memory_deletions')) return []
    throw new Error(`unexpected request ${endpoint} ${options.method}`)
  })
  const store = new SupabaseMemoryStore({ client, accountId: ACCOUNT, now: () => 300 })
  const recalled = await store.recall('concise replies')
  assert.equal(recalled.hits[0].sessionId, SESSION)
  assert.equal(recalled.hits[0].sessionTitle, 'A conversation')
  assert.match(recalled.hits[0].excerpt.text, /concise replies/)
  const exported = await store.exportAll()
  assert.equal(exported.trainingUse, 'prohibited')
  assert.equal(exported.sessions[0].turns[0].content, 'I prefer concise replies.')
  assert.equal(exported.memories[0].trainingUse, 'prohibited')
  assert.ok(client.calls.every((call) => new URLSearchParams(call.options.query ?? '').get('account_id') === `eq.${ACCOUNT}`))
})

test('construction refuses invalid account identities and malformed database rows fail closed', async () => {
  assert.throws(() => new SupabaseMemoryStore({ client: fakeClient(() => []), accountId: 'not-a-uuid' }), { code: 'supabase_account_id_invalid' })
  assert.throws(() => new SupabaseMemoryStore({ client: {}, accountId: ACCOUNT }), { code: 'supabase_client_invalid' })
  const malformed = new SupabaseMemoryStore({
    client: fakeClient(() => [memoryRow({ tags: 'not-json-array' })]), accountId: ACCOUNT,
  })
  await assert.rejects(malformed.getMemory(MEMORY), { code: 'supabase_memory_row_invalid' })
  await assert.rejects(malformed.getMemory('../other'), { code: 'supabase_row_id_invalid' })
})
