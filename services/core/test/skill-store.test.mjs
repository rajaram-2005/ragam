// Skills on disk: the difference between a stored procedure and a memory of one.
//
// The registry is an in-memory index and was fully tested while nothing it held survived a
// restart. These tests are about what a person can rely on afterwards: that a validated
// procedure is still there, that a candidate cannot be loaded, that history is kept so a
// rollback works, that deleting really deletes, and that one unreadable file does not take
// the rest with it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SKILL_STATES, SkillRegistry } from '../src/skills/registry.mjs'
import { SkillStore, SkillStoreError } from '../src/skills/store.mjs'
import { proposeFromExperience, renderSkillDocument, retire } from '../src/skills/lifecycle.mjs'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'aetheris-skills-'))
  return { dir, store: new SkillStore({ dir }), done: () => rmSync(dir, { recursive: true, force: true }) }
}

const document = (overrides = {}) => renderSkillDocument({
  name: 'fix-docker-build-cache',
  description: 'Fixes a stale Docker build cache.',
  version: '1.0.0',
  createdBy: 'agent',
  author: 'Aetheris experience capture',
  tags: ['docker', 'build'],
  whenToUse: 'When a build does not pick up a changed dependency.',
  prerequisites: ['Docker is installed.'],
  steps: ['Reproduce the stale build.', 'Rebuild without cache.', 'Confirm the change is present.'],
  pitfalls: ['Clearing the cache removes layers you may have wanted.'],
  verification: 'Rebuild twice and confirm the second run is reproducible.',
  observedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const evidence = { checks: [{ name: 'reproduced', passed: true }, { name: 'corrected', passed: true }], verifiedBy: 'user', notes: 'ran it' }

// --- what survives a restart ---------------------------------------------------------

test('a validated skill is still validated after a restart', () => {
  const { store, done } = scratch()
  try {
    const first = new SkillRegistry()
    first.install(document(), { state: SKILL_STATES.CANDIDATE })
    first.validate('fix-docker-build-cache', evidence)
    first.recordUsage('fix-docker-build-cache', { kind: 'use' })
    first.setPinned('fix-docker-build-cache', true)
    store.save(first, 'fix-docker-build-cache')

    const second = new SkillRegistry()
    const result = store.load(second)
    assert.deepEqual(result.restored, ['fix-docker-build-cache'])
    assert.deepEqual(result.failures, [])

    const restored = second.describe('fix-docker-build-cache')
    assert.equal(restored.state, SKILL_STATES.VALIDATED)
    // Usage survives too: a curator that cannot see use counts archives by age alone.
    assert.equal(restored.usage.useCount, 1)
    assert.equal(restored.pinned, true)
    // And the evidence came back, not just the word 'validated'.
    assert.equal(second.record('fix-docker-build-cache').validation.checks.length, 2)
    assert.equal(second.load('fix-docker-build-cache').text, document())
  } finally {
    done()
  }
})

test('a candidate stays unloadable across a restart', () => {
  const { store, done } = scratch()
  try {
    const first = new SkillRegistry()
    const proposed = proposeFromExperience(first, {
      name: 'recover-detached-index',
      failureCategory: 'git_detached_index',
      attempted: 'committed with a detached index',
      observed: 'the commit failed with an index error',
      correction: 'rebuild the index and re-apply the staged changes',
      verifiedSolution: 'the commit succeeded and the diff matched',
    })
    store.save(first, proposed.name)

    const second = new SkillRegistry()
    store.load(second)
    assert.equal(second.describe('recover-detached-index').state, SKILL_STATES.CANDIDATE)
    assert.throws(() => second.load('recover-detached-index'), /has not been validated/)
    // Progressive disclosure: a candidate is not even offered as relevant.
    assert.deepEqual(second.match('detached index commit').matches, [])
    assert.equal(second.match('detached index commit', { includeUnvalidated: true }).matches.length, 1)
  } finally {
    done()
  }
})

test('version history is on disk, so a rollback works after a restart', () => {
  const { store, done } = scratch()
  try {
    const first = new SkillRegistry()
    const name = 'fix-docker-build-cache'
    first.install(document(), { state: SKILL_STATES.CANDIDATE })
    first.validate(name, evidence)
    first.install(document({ version: '1.1.0', description: 'Fixes a stale Docker build cache properly.' }), { state: SKILL_STATES.CANDIDATE })
    first.validate(name, evidence)
    store.saveAll(first)
    assert.ok(existsSync(store.versionPath(name, '1.0.0')), 'every version is written, not only the current one')

    const second = new SkillRegistry()
    store.load(second)
    assert.equal(second.describe(name).version, '1.1.0')
    const rolled = second.rollback(name, '1.0.0')
    assert.equal(rolled.version, '1.0.0')
    assert.equal(second.load(name).text, document(), 'the rolled-back document is the one from disk')

    // And the rollback is what a later restart resumes from.
    store.save(second, name)
    const third = new SkillRegistry()
    store.load(third)
    assert.equal(third.describe(name).version, '1.0.0')
  } finally {
    done()
  }
})

test('one unreadable skill does not take the others with it', () => {
  const { dir, store, done } = scratch()
  try {
    const first = new SkillRegistry()
    first.install(document(), { state: SKILL_STATES.CANDIDATE })
    first.validate('fix-docker-build-cache', evidence)
    store.save(first, 'fix-docker-build-cache')
    // A document that does not validate, as a half-written or hand-edited file would be.
    writeFileSync(join(dir, 'broken-skill.md'), '# not a skill document\n')

    const second = new SkillRegistry()
    const result = store.load(second)
    assert.deepEqual(result.restored, ['fix-docker-build-cache'])
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0].file, /broken-skill\.md/)
    assert.ok(result.failures[0].reason, 'the failure must say what was wrong')
    assert.equal(second.describe('fix-docker-build-cache').state, SKILL_STATES.VALIDATED)
  } finally {
    done()
  }
})

// --- deletion, and what the curator may not do ---------------------------------------

test('the curator archives and never deletes, and the file is still there', () => {
  const { store, done } = scratch()
  try {
    const registry = new SkillRegistry({ now: () => Date.now() })
    registry.install(document(), { state: SKILL_STATES.CANDIDATE })
    registry.validate('fix-docker-build-cache', evidence)
    store.save(registry, 'fix-docker-build-cache')

    const result = retire(registry, 'fix-docker-build-cache', 'no longer accurate')
    assert.equal(result.to, SKILL_STATES.ARCHIVED)
    store.save(registry, 'fix-docker-build-cache')
    assert.ok(existsSync(store.documentPath('fix-docker-build-cache')), 'archiving is a state, not a removal')
    assert.equal(store.deletions().length, 0, 'nothing was deleted, so nothing is in the deletion record')
  } finally {
    done()
  }
})

test("deleting a skill removes the procedure and keeps a tombstone without it", () => {
  const { store, done } = scratch()
  try {
    const registry = new SkillRegistry()
    registry.install(document(), { state: SKILL_STATES.CANDIDATE })
    registry.validate('fix-docker-build-cache', evidence)
    store.saveAll(registry)

    const removed = store.remove(registry, 'fix-docker-build-cache', { reason: 'asked for it to be removed' })
    assert.deepEqual(removed, { deleted: true, name: 'fix-docker-build-cache', versionsRemoved: 1 })
    assert.ok(!existsSync(store.documentPath('fix-docker-build-cache')))
    assert.ok(!existsSync(join(store.dir, '.versions', 'fix-docker-build-cache')), 'the version files are part of the deletion')

    const [tombstone] = store.deletions()
    assert.equal(tombstone.name, 'fix-docker-build-cache')
    assert.equal(tombstone.reason, 'asked for it to be removed')
    assert.equal(tombstone.versionsRemoved, 1)
    assert.ok(!JSON.stringify(tombstone).includes('Docker'), 'the tombstone must not quote the procedure')

    const after = new SkillRegistry()
    assert.deepEqual(store.load(after).restored, [], 'a deleted skill does not come back on restart')
    assert.equal(after.names().length, 0)
  } finally {
    done()
  }
})

test('a name that cannot be a file name is refused before anything is written', () => {
  const { dir, done } = scratch()
  try {
    const store = new SkillStore({ dir })
    for (const name of ['../escape', 'Has Spaces', 'UPPER', '', 'a'.repeat(80), 'dot.ted']) {
      assert.throws(() => store.documentPath(name), SkillStoreError, `'${name}' must be refused`)
    }
    assert.equal(store.documentPath('fine-name'), join(dir, 'fine-name.md'))
  } finally {
    done()
  }
})

// --- relevance -----------------------------------------------------------------------

test('relevance is lexical, stated as such, and ranks the right skill first', () => {
  const registry = new SkillRegistry()
  registry.install(document(), { state: SKILL_STATES.CANDIDATE })
  registry.validate('fix-docker-build-cache', evidence)
  registry.install(document({
    name: 'rotate-signing-keys',
    description: 'Rotates a release signing key.',
    tags: ['release', 'keys'],
    whenToUse: 'When a signing key is due for rotation.',
  }), { state: SKILL_STATES.CANDIDATE })
  registry.validate('rotate-signing-keys', evidence)

  const hit = registry.match('docker build cache is stale')
  assert.equal(hit.method, 'bm25', 'the ranking method is stated, not implied')
  assert.equal(hit.considered, 2)
  assert.equal(hit.matches[0].name, 'fix-docker-build-cache')
  assert.ok(hit.matches[0].score > 0)
  assert.ok(hit.matches[0].matchedTerms.includes('docker'))

  // A listing is built from the short fields: the procedure itself is not in the result, so
  // considering many skills does not pull every procedure into context.
  assert.ok(!JSON.stringify(hit.matches).includes('Rebuild without cache'))

  assert.deepEqual(registry.match('   ').matches, [])
  assert.equal(registry.match('').method, 'none')
  assert.deepEqual(registry.match('quantum chromodynamics').matches, [])
})
