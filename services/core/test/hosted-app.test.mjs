import test from 'node:test'
import assert from 'node:assert/strict'
import { createHostedOnlineApp, blockLocalOnlyHostedRoutes } from '../src/vercel/hosted-app.mjs'

function res() {
  return { headers: new Map(), setHeader(name, value) { this.headers.set(name, value) }, end(value) { this.body = value } }
}

test('hosted startup fails closed until service credentials and controlled owner bootstrap are configured', async () => {
  await assert.rejects(createHostedOnlineApp({ env: {} }), (error) => error.code === 'supabase_url_missing')
  await assert.rejects(createHostedOnlineApp({ env: { SUPABASE_URL: 'https://project.supabase.co' } }), (error) => error.code === 'supabase_service_key_missing')
  await assert.rejects(createHostedOnlineApp({ env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-long-enough' } }), (error) => error.code === 'owner_bootstrap_email_missing')
})

test('hosted route gate keeps local training and unsupported voice off Vercel', () => {
  for (const [url, code] of [
    ['/api/klyvaron/worker/start', 'local_runtime_required'],
    ['/api/klyvaron/qualification/run', 'local_runtime_required'],
    ['/api/voice/synthesize', 'hosted_voice_unavailable'],
    ['/api/skills', 'hosted_skills_unavailable'],
    ['/api/skills/my-skill', 'hosted_skills_unavailable'],
  ]) {
    const response = res()
    assert.equal(blockLocalOnlyHostedRoutes({ url }, response), true)
    assert.equal(response.statusCode, 501)
    assert.equal(JSON.parse(response.body).error, code)
  }
  const response = res()
  assert.equal(blockLocalOnlyHostedRoutes({ url: '/api/chat' }, response), false)
})
