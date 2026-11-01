import test from 'node:test'
import assert from 'node:assert/strict'
import { SupabaseAuditLedger } from '../src/storage/supabase-audit-ledger.mjs'

test('audit events are queued as append-only inserts and flush waits for durable writes', async () => {
  const writes = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const ledger = new SupabaseAuditLedger({
    client: { async request(endpoint, options) { await gate; writes.push({ endpoint, options }); return null } },
    now: () => 1234,
  })
  const accepted = ledger.record({ category: 'model', action: 'chat', outcome: 'success', subject: 'account-1', detail: { model: 'known-model' } })
  assert.match(accepted.id, /^[0-9a-f-]{36}$/)
  assert.equal(writes.length, 0)
  const flushing = ledger.flush()
  release()
  await flushing
  assert.equal(writes.length, 1)
  assert.equal(writes[0].endpoint, 'rest/v1/ragam_audit_events')
  assert.equal(writes[0].options.method, 'POST')
  assert.equal(writes[0].options.body.occurred_at, 1234)
  assert.equal(writes[0].options.body.subject, 'account-1')
})

test('an audit persistence failure is surfaced by flush without exposing provider error details', async () => {
  const ledger = new SupabaseAuditLedger({ client: { request: async () => { throw new Error('secret response') } } })
  ledger.record({ category: 'policy', action: 'blocked' })
  await assert.rejects(ledger.flush(), (error) => error.code === 'supabase_audit_write_failed' && !error.message.includes('secret response'))
})
