import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addChatProject,
  readChatOrganization,
  updateChatSessionOrganization,
  writeChatOrganization,
} from '../src/chat-organization.js'

function storageFixture(initial = null) {
  const entries = new Map(initial ? [['ragam.chat-organization.v1', initial]] : [])
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
  }
}

test('chat organization stores only bounded local titles, project names and pin state', () => {
  const storage = storageFixture()
  let organization = addChatProject(readChatOrganization(storage), 'Research')
  assert.ok(organization)
  organization = updateChatSessionOrganization(organization, 'session-1', {
    title: '  Compare model options  ', project: 'Research', pinned: true,
  })
  assert.equal(writeChatOrganization(organization, storage), true)
  assert.deepEqual(readChatOrganization(storage), {
    projects: ['Research'],
    sessions: { 'session-1': { title: 'Compare model options', project: 'Research', pinned: true } },
  })
  const serialized = [...storage.entries.values()][0]
  assert.doesNotMatch(serialized, /prompt|turns|api.?key|secret/i)
})

test('projects reject duplicates and session metadata cannot reference unknown projects', () => {
  let organization = addChatProject(readChatOrganization(storageFixture()), 'Studio')
  assert.equal(addChatProject(organization, ' studio '), null)
  organization = updateChatSessionOrganization(organization, 'session-2', { project: 'Missing' })
  assert.deepEqual(organization.sessions, {})
})

test('invalid saved organization data degrades to empty and browser-storage errors are harmless', () => {
  const invalid = storageFixture('{broken')
  assert.deepEqual(readChatOrganization(invalid), { projects: [], sessions: {} })
  assert.equal(readChatOrganization({ getItem() { throw Error('blocked') } }).projects.length, 0)
  assert.equal(writeChatOrganization({ projects: [], sessions: {} }, { setItem() { throw Error('blocked') } }), false)
})
