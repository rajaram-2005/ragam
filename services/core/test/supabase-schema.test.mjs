import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migrationPath = new URL('../../../supabase/migrations/20261030000100_initial_core.sql', import.meta.url)
const migration = readFileSync(migrationPath, 'utf8')
const memoryRpcPath = new URL('../../../supabase/migrations/20261031000100_memory_rpcs.sql', import.meta.url)
const memoryRpcMigration = readFileSync(memoryRpcPath, 'utf8')

test('memory RPC migration keeps compound operations transactional and service-role-only', () => {
  const functions = [
    ['ragam_memory_remember', 'text,text,text,text,text,jsonb,text,text,text,bigint,integer'],
    ['ragam_memory_supersede', 'text,text,text,text,text,text,jsonb,text,text,bigint,integer'],
    ['ragam_memory_forget', 'text,text,text,bigint,text,text'],
    ['ragam_memory_forget_all', 'text,bigint,text,text'],
    ['ragam_memory_decide_candidate', 'text,text,boolean,text,text,text,jsonb,bigint,integer'],
    ['ragam_memory_append_turn', 'text,text,text,text,text,text,bigint,integer'],
    ['ragam_memory_delete_session', 'text,text'],
    ['ragam_memory_stats', 'text'],
  ]
  for (const [name, signature] of functions) {
    const body = new RegExp(`CREATE FUNCTION public\\.${name}\\([\\s\\S]*?\\$\\$;`).exec(memoryRpcMigration)?.[0]
    assert.ok(body, `${name} must be defined in the versioned migration`)
    assert.match(body, /SECURITY DEFINER SET search_path = ''/)
    assert.match(memoryRpcMigration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(${signature}\\) FROM PUBLIC, anon, authenticated;`))
    assert.match(memoryRpcMigration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(${signature}\\) TO service_role;`))
  }
  assert.match(memoryRpcMigration, /pg_advisory_xact_lock/, 'deduplication and count caps serialize per account')
  assert.match(memoryRpcMigration, /training_use/)
  assert.match(memoryRpcMigration, /INSERT INTO public\.ragam_memory_deletions/)
  assert.ok(memoryRpcMigration.includes('This migration remains local/staged; do not apply it to hosted ragam-core yet'))
})

test('initial Supabase schema is additive, fail-closed, and keeps account data scoped', () => {
  const created = [...migration.matchAll(/^CREATE TABLE public\.(\w+)\s*\(/gm)].map((match) => match[1])
  assert.equal(created.length, 28, 'the baseline table inventory should be explicit')
  assert.equal(new Set(created).size, created.length, 'table names must not be duplicated')

  const rlsBlock = migration.match(/FOREACH table_name IN ARRAY ARRAY\[([\s\S]*?)\] LOOP/)
  assert.ok(rlsBlock, 'the complete RLS table list must be present')
  const rlsTables = [...rlsBlock[1].matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1])
  assert.deepEqual([...rlsTables].sort(), [...created].sort(), 'every created table must have RLS enabled')
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/)
  assert.doesNotMatch(migration, /CREATE\s+POLICY\b/i, 'browser roles receive no implicit data access')
  assert.doesNotMatch(migration, /\bDROP\s+(?:TABLE|SCHEMA|COLUMN)\b/i, 'the initial migration must not destroy existing data')

  for (const table of [
    'ragam_memories', 'ragam_memory_candidates', 'ragam_chat_sessions', 'ragam_chat_turns',
    'ragam_fabric_entries', 'ragam_knowledge_documents', 'ragam_knowledge_chunks',
    'ragam_knowledge_embeddings', 'ragam_styles', 'ragam_media_jobs', 'ragam_media_artifacts',
  ]) assert.match(migration, new RegExp(`CREATE TABLE public\\.${table}\\s*\\([\\s\\S]*?account_id\\s+text NOT NULL`), `${table} must be account-scoped`)

  assert.match(migration, /training_use\s+text NOT NULL CHECK \(training_use = 'prohibited'\)/)
  assert.match(migration, /token_hash\s+char\(64\) PRIMARY KEY/)
  for (const rpc of [
    'ragam_register_account', 'ragam_record_account_login', 'ragam_update_account_password', 'ragam_reset_account_password', 'ragam_consume_auth_attempt',
    'ragam_create_session', 'ragam_revoke_session', 'ragam_revoke_sessions',
  ]) {
    assert.match(migration, new RegExp(`CREATE FUNCTION public\\.${rpc}\\(`), `${rpc} must be versioned with the schema`)
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${rpc}\\([^;]+ TO service_role;`), `${rpc} must be restricted to the server role`)
  }
  assert.match(migration, /CREATE TRIGGER ragam_audit_events_append_only/)
  assert.match(migration, /vector\s+bytea NOT NULL/, 'legacy embeddings stay opaque until separately qualified')
  assert.match(migration, /has NOT been\n-- applied to the hosted ragam-core project/i)
})
