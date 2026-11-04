import test from 'node:test'
import assert from 'node:assert/strict'
import { processKlyvaronInput, KLYVARON_PROCESSOR_PROFILES } from '../src/klyvaron/processor.mjs'
import { KnowledgePipeline } from '../src/knowledge/pipeline.mjs'
import { MemoryStore } from '../src/memory/store.mjs'

function pipeline(defaultPrincipal = 'account-a') {
  return new KnowledgePipeline({ dbFile: ':memory:', defaultPrincipal })
}

test('tier profiles scale bounded context and orchestration without changing the processing engine', () => {
  assert.ok(KLYVARON_PROCESSOR_PROFILES.lite.contextChars < KLYVARON_PROCESSOR_PROFILES.pro.contextChars)
  assert.ok(KLYVARON_PROCESSOR_PROFILES.pro.contextChars < KLYVARON_PROCESSOR_PROFILES.max.contextChars)
  assert.ok(KLYVARON_PROCESSOR_PROFILES.lite.maxTasks < KLYVARON_PROCESSOR_PROFILES.max.maxTasks)
})

test('extractive summary only returns verbatim source sentences with traceable offsets', async () => {
  const input = 'Ragam stores the source locally. Retrieval uses deterministic BM25 ranking. The user can delete saved knowledge at any time.'
  const result = await processKlyvaronInput({ tier: 'lite', input, tasks: ['summarize'] })
  assert.equal(result.engine, 'klyvaron-deterministic-v1')
  assert.equal(result.modelUsed, false)
  assert.equal(result.weightsUsed, false)
  assert.equal(result.networkUsed, false)
  const sentences = result.results[0].result.sentences
  assert.ok(sentences.length <= KLYVARON_PROCESSOR_PROFILES.lite.maxSummarySentences)
  for (const sentence of sentences) assert.equal(input.slice(sentence.start, sentence.end), sentence.sentence)
})

test('inspection, pattern extraction and outline use explicit structures rather than model claims', async () => {
  const input = '# Release notes\n\nContact ops@example.test on 2026-10-30.\n\n- Verify checksum\n- Record rollback'
  const result = await processKlyvaronInput({ tier: 'pro', input, tasks: ['inspect', 'extract', 'outline'] })
  assert.equal(result.results[0].result.headings[0], 'Release notes')
  assert.deepEqual(result.results[1].result.emails, ['ops@example.test'])
  assert.deepEqual(result.results[1].result.isoDates, ['2026-10-30'])
  assert.deepEqual(result.results[2].result.bullets, ['Verify checksum', 'Record rollback'])
  assert.match(result.results[1].result.note, /not inferred/)
})

test('comparison is lexical only, and calculator is a bounded parser rather than eval', async () => {
  const compared = await processKlyvaronInput({
    input: 'blue green shared', comparisonInput: 'red shared green', tasks: ['compare'],
  })
  assert.deepEqual(compared.results[0].result.sharedTerms, ['green', 'shared'])
  assert.equal(compared.results[0].result.method, 'lexical_token_set')
  const calculated = await processKlyvaronInput({ input: '(12 + 8) / 4 * -3', tasks: ['calculate'] })
  assert.equal(calculated.results[0].result.value, -15)
  await assert.rejects(processKlyvaronInput({ input: '1 / 0', tasks: ['calculate'] }), { code: 'division_by_zero' })
  await assert.rejects(processKlyvaronInput({ input: 'process.exit()', tasks: ['calculate'] }), /accepts only numbers/)
})

test('retrieval uses only explicitly enabled account-local knowledge and memory', async () => {
  const knowledge = pipeline('account-a')
  await knowledge.ingestText({
    title: 'Approved deployment note',
    text: 'Rollback requires restoring the prior artifact and verifying its checksum.',
    owner: 'account-a', principals: ['account-a'],
  })
  const memory = new MemoryStore(':memory:')
  memory.remember({ text: 'The user prefers local-only processing for rollback verification with checksum.', tags: ['preference'] })

  const disabled = await processKlyvaronInput({
    input: 'How should rollback work?', tasks: ['answer'], knowledge, memory,
    principal: 'account-a', useKnowledge: false, useMemory: false,
  })
  assert.equal(disabled.results[0].result.evidenceCount, 0)
  assert.equal(disabled.results[0].result.memoryCount, 0)

  const enabled = await processKlyvaronInput({
    input: 'rollback checksum', tasks: ['answer'], knowledge, memory,
    principal: 'account-a', useKnowledge: true, useMemory: true,
  })
  assert.equal(enabled.results[0].result.evidenceCount, 1)
  assert.equal(enabled.results[0].result.memoryCount, 1)
  assert.equal(enabled.results[0].result.results[0].citation.title, 'Approved deployment note')
  assert.match(enabled.text, /not a generated answer/)

  const otherAccount = await processKlyvaronInput({
    input: 'rollback checksum', tasks: ['retrieve'], knowledge,
    principal: 'account-b', useKnowledge: true,
  })
  assert.equal(otherAccount.results[0].result.evidenceCount, 0)
})

test('saving input to persistent knowledge requires an explicit flag and occurs after successful processing', async () => {
  const knowledge = pipeline('account-a')
  const before = knowledge.stats().store.documents
  const notSaved = await processKlyvaronInput({ input: 'A private note.', tasks: ['inspect'], knowledge, principal: 'account-a' })
  assert.equal(notSaved.persistence.requested, false)
  assert.equal(knowledge.stats().store.documents, before)

  const saved = await processKlyvaronInput({
    input: 'A user-approved note about local processing.', tasks: ['inspect'],
    knowledge, principal: 'account-a', saveToKnowledge: true, title: 'Explicitly saved note',
  })
  assert.equal(saved.persistence.requested, true)
  assert.equal(knowledge.stats().store.documents, before + 1)

  await assert.rejects(processKlyvaronInput({
    input: 'not arithmetic', tasks: ['calculate'], knowledge, principal: 'account-a', saveToKnowledge: true,
  }))
  assert.equal(knowledge.stats().store.documents, before + 1)
})

test('workflow, input, option, and cancellation limits fail closed', async () => {
  await assert.rejects(processKlyvaronInput({ tier: 'lite', input: 'x'.repeat(16_001), tasks: ['inspect'] }), { code: 'processing_input_too_large' })
  await assert.rejects(processKlyvaronInput({ tier: 'lite', input: 'text', tasks: ['inspect', 'extract', 'outline'] }), /accepts 1-2 named tasks/)
  await assert.rejects(processKlyvaronInput({ tier: 'lite', input: 'text', tasks: ['inspect'], futureField: true }), { code: 'invalid_processing_request' })
  await assert.rejects(processKlyvaronInput({ tier: 'lite', input: 'text', tasks: ['inspect'], signal: { aborted: true } }), { code: 'cancelled' })
})
