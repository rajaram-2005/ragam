import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeProfile, readProfile, recommendationsForProfile, writeProfile } from '../src/profile.js'

function storageFixture() {
  const entries = new Map()
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
    entries,
  }
}

test('profile fields are trimmed, whitespace-normalized and bounded', () => {
  const profile = normalizeProfile({ name: '  Ada   Lovelace ', profession: ` ${'engineer'.repeat(20)} ` })
  assert.equal(profile.name, 'Ada Lovelace')
  assert.equal(profile.profession.length, 100)
})

test('an optional name and profession persist only in the provided browser storage', () => {
  const storage = storageFixture()
  const saved = writeProfile({ name: 'Sam', profession: 'Teacher' }, storage)
  assert.deepEqual(saved, { name: 'Sam', profession: 'Teacher' })
  assert.deepEqual(readProfile(storage), saved)
  assert.equal(storage.entries.size, 1)
})

test('clearing the profile removes the stored value', () => {
  const storage = storageFixture()
  writeProfile({ name: 'Sam', profession: 'Teacher' }, storage)
  writeProfile({}, storage)
  assert.deepEqual(readProfile(storage), { name: '', profession: '' })
  assert.equal(storage.entries.size, 0)
})

test('malformed saved profile data degrades to an empty profile', () => {
  const storage = storageFixture()
  storage.setItem('ragam.local-profile.v1', '{not json')
  assert.deepEqual(readProfile(storage), { name: '', profession: '' })
})

test('teacher recommendations are relevant prompt drafts, not automatic requests', () => {
  const items = recommendationsForProfile({ profession: 'High-school teacher' })
  assert.deepEqual(items.map((item) => item.title), ['Plan a lesson', 'Adapt an explanation', 'Draft practice questions', 'Improve feedback'])
  assert.ok(items.every((item) => item.prompt.length > 0 && /^0[1-4]$/.test(item.number)))
})

test('regulated-profession suggestions avoid diagnosis, treatment or legal conclusions', () => {
  const health = recommendationsForProfile({ profession: 'Nurse' }).map((item) => item.prompt).join('\n')
  const legal = recommendationsForProfile({ profession: 'Attorney' }).map((item) => item.prompt).join('\n')
  assert.match(health, /Do not diagnose or recommend treatment/)
  assert.match(legal, /Do not make legal conclusions/)
})

test('an unfamiliar profession gets general suggestions with user-controlled context', () => {
  const items = recommendationsForProfile({ profession: 'Marine biologist' })
  assert.equal(items.length, 4)
  assert.ok(items.every((item) => item.prompt.includes('My profession is Marine biologist')))
})
