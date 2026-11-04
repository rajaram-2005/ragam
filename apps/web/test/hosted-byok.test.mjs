import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const component = readFileSync(resolve(root, 'src/HostedByokApp.jsx'), 'utf8')
const switcher = readFileSync(resolve(root, 'src/App.jsx'), 'utf8')
const rewrite = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'))

test('hosted BYOK uses same-origin API calls and never saves provider keys in browser storage', () => {
  assert.ok(component.includes('fetch(`/api/hosted${path}`'))
  assert.ok(!/localStorage|sessionStorage/.test(component))
  assert.ok(component.includes("type=\"password\""))
  assert.ok(component.includes('Save encrypted key'))
  assert.ok(component.includes('provider charges apply to your account'))
})

test('hosted chat asks for explicit per-turn provider and Search approval', () => {
  assert.ok(component.includes('I approve sending this message'))
  assert.ok(component.includes('Use provider-native Search for this turn'))
  assert.ok(component.includes('nativeSearchConfirmed: search'))
  assert.ok(component.includes("industryMode: 'manufacturing'"))
  assert.ok(component.includes('localOnly: localOnlyMode'))
  assert.ok(component.includes('Local-only is on'))
  assert.ok(component.includes('IndustryOperationsPanel'))
  assert.ok(component.includes('No fallback'))
})

test('hosted BYOK is opt-in at build time and its API rewrite has a fixed backend origin', () => {
  assert.ok(switcher.includes('import.meta.env?.VITE_HOSTED_BYOK === \'true\''))
  assert.deepEqual(rewrite.rewrites, [{
    source: '/api/hosted/:path*',
    destination: 'https://ragam-core.vercel.app/api/hosted/:path*',
  }])
})
