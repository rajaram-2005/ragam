import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OnlineApp } from '../src/online/app.mjs'
import { gatewayUrl, privateAddress, OnlineGateway } from '../src/online/gateway.mjs'
const listen = (s) => new Promise((done) => s.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${s.address().port}`)))
const close = (s) => new Promise((done) => { s.closeAllConnections(); s.close(done) })
async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aetheris-online-test-'))
  const f = { calls: [], mode: 'normal' }
  const gateway = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    f.calls.push({ path: req.url, body, authorization: req.headers.authorization })
    if (f.mode === 'redirect') { res.writeHead(302, { location: '/stolen' }); return res.end() }
    if (f.mode === 'auth') { res.writeHead(401); return res.end('NEVER SHOW synthetic-gateway-secret') }
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }))
    if (f.mode === 'body-stall') { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); return setTimeout(() => res.end(JSON.stringify({ choices: [{ message: { content: 'late' } }] })), 250) }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: '+JSON.stringify({ model: body.model, choices: [{ delta: { content: 'Synthetic fixture only.' } }] })+'\r\n\r\n')
      return res.end(f.mode === 'truncated' ? '' : 'data: [DONE]\n\n')
    }
    return res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: `Synthetic fixture ${body.model}` } }] }))
  })
  f.gatewayUrl = await listen(gateway)
  const create = () => new OnlineApp({ dataDir: dir, trustedOrigins: options.trustedOrigins ?? [f.gatewayUrl], timeoutMs: options.timeoutMs ?? 2000 })
  f.app = create(); const server = f.app.server(); f.url = await listen(server)
  f.request = async (method, path, body, opts = {}) => {
    const response = await fetch(f.url + path, { method, headers: { cookie: opts.cookie ?? f.cookie ?? '', ...(body ? { 'content-type': 'application/json', 'x-aetheris-request': '1' } : {}), ...opts.headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const text = await response.text(); let data; try { data = JSON.parse(text) } catch { data = text }
    return { status: response.status, data, headers: response.headers }
  }
  // Sign-in is an account: an email address and a password. The first account created on
  // an installation is its owner, which is the one allowed to change the gateway.
  f.account = { email: 'owner@example.test', password: 'a-long-owner-password' }
  f.login = async () => {
    let r = await f.request('POST','/api/auth/register',f.account)
    if (r.status !== 201) r = await f.request('POST','/api/auth/login',f.account)
    f.cookie = r.headers.get('set-cookie').split(';')[0]; f.accountId = r.data.account.id; return r
  }
  f.configure = async () => { await f.login(); const r = await f.request('PUT','/api/providers/litellm',{ baseUrl: f.gatewayUrl+'/v1', apiKey: 'synthetic-gateway-secret' }); assert.equal(r.status,200); const checked = await f.request('POST','/api/models/probe',{}); assert.equal(checked.status,200); return checked.data }
  f.chat = (extra = {}) => ({ prompt: 'ordinary question', model: 'model-a', authorization: { confirmed: true, providerRevision: f.app.store.state.revision }, ...extra })
  // Calling the app in process, rather than over HTTP, still has to say who is asking:
  // history, memory and knowledge are resolved from the session's account.
  f.session = () => f.app.sessionFor({ headers: { cookie: f.cookie } })
  f.restart = () => { f.app.close(); f.app = create() }
  f.dir = dir
  t.after(async () => { await close(server); await close(gateway); f.app.close(); rmSync(dir,{ recursive:true, force:true }) })
  return f
}

test('online entry has no local startup requirements and defaults to setup required', async (t) => {
 const f = await fixture(t); assert.equal(f.app.readiness().policy,'online_only'); assert.equal(f.app.readiness().status,'setup_required'); assert.equal('localExecution' in f.app,false); assert.equal('hardware' in f.app,false)
})
test('provider, context, model and tool routes require owner authentication', async (t) => {
 const f = await fixture(t)
 for (const path of ['/api/providers','/api/models','/api/sessions','/api/memory','/api/knowledge/documents','/api/plugins','/api/mcp/tools']) assert.equal((await f.request('GET',path)).status,401,path)
})
test('the provider catalogue is authenticated, read-only and carries no secrets', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.request('GET', '/api/providers/catalog')).status, 401)
  await f.login()
  const r = await f.request('GET', '/api/providers/catalog')
  assert.equal(r.status, 200)
  assert.equal(r.data.valid, true)
  assert.equal(r.data.counts.ready, 3, 'three runtimes have a tested path')
  assert.ok(r.data.counts.pending > 0, 'the unimplemented adapters must be stated, not hidden')
  assert.match(r.data.summary, /^3 ready/)
  for (const provider of r.data.providers) {
    assert.ok(provider.docsUrl.startsWith('https://'), `${provider.id} must cite documentation`)
    // A descriptor has no credential field, so there is nothing to redact — but assert it anyway,
    // because "there is nothing to redact" is exactly the property that silently regresses.
    for (const field of ['apiKey', 'key', 'token', 'secret', 'credential']) assert.equal(field in provider, false)
  }
  const text = JSON.stringify(r.data)
  assert.ok(!/sk-[A-Za-z0-9]|bearer\s+[a-z0-9]/i.test(text), 'the catalogue leaked a credential shape')
})

test('owner login uses an HttpOnly secure cookie; wrong passwords and cross-origin mutations fail', async (t) => {
 const f = await fixture(t); assert.equal((await f.request('POST','/api/auth/login',{email:f.account.email,password:'a-long-wrong-password'})).status,401)
 const r = await f.login(); assert.match(r.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/); assert.match(r.headers.get('set-cookie'),/Secure/)
 assert.equal((await f.request('POST','/api/auth/logout',{}, {headers:{origin:'https://attacker.example'}})).status,403)
 assert.equal((await f.request('POST','/api/auth/logout',{}, {headers:{'x-aetheris-request':''}})).status,403)
 assert.equal((await f.request('POST','/api/auth/logout',{})).status,200); assert.equal((await f.request('GET','/api/providers')).status,401)
})
test('a private gateway needs an exactly matching trusted origin, and nothing is stored without one', async (t) => {
 // "Bring your own gateway" includes a gateway on your own machine fronting a local
 // runtime, and this refusal is what keeps that from meaning "anybody who can reach the
 // API can point it at an internal address". Verified against a running server rather
 // than only against gatewayUrl(), because the operator-visible half is the route's
 // status, code and message — and because a refused save must not leave a
 // half-configured provider behind.
 for (const trustedOrigins of [[], ['http://127.0.0.1:4000/'], ['http://localhost:4000']]) {
   const f = await fixture(t, { trustedOrigins })
   await f.login()
   const refused = await f.request('PUT', '/api/providers/litellm', { baseUrl: 'http://127.0.0.1:4000/v1', apiKey: 'sk-local-dev' })
   assert.equal(refused.status, 400, JSON.stringify(trustedOrigins))
   assert.equal(refused.data.error, 'endpoint_blocked', JSON.stringify(trustedOrigins))
   assert.match(refused.data.message, /trusted origin/)
   const state = (await f.request('GET', '/api/providers')).data
   assert.equal(state.baseUrl, '', 'a refused endpoint must not be stored')
   assert.equal(state.keyConfigured, false)
   assert.deepEqual(state.models, [])
 }

 // The same URL is accepted once its exact origin is trusted. That is the whole of the
 // local-gateway setup, and the reason the variable exists.
 const f = await fixture(t, { trustedOrigins: ['http://127.0.0.1:4000'] })
 await f.login()
 const saved = await f.request('PUT', '/api/providers/litellm', { baseUrl: 'http://127.0.0.1:4000/v1', apiKey: 'sk-local-dev' })
 assert.equal(saved.status, 200)
 assert.equal(saved.data.baseUrl, 'http://127.0.0.1:4000/v1')
 assert.equal(saved.data.keyConfigured, true)
 assert.ok(!JSON.stringify(saved.data).includes('sk-local-dev'), 'the key is never returned to the browser')
})

test('gateway credential is encrypted at rest and never returned publicly', async (t) => {
 const f = await fixture(t); const settings = await f.configure()
 assert.equal(settings.keyConfigured,true); assert.ok(!JSON.stringify(settings).includes('synthetic-gateway-secret'))
 assert.ok(!readFileSync(join(f.dir,'provider.json'),'utf8').includes('synthetic-gateway-secret'))
 assert.equal(statSync(join(f.dir,'provider.json')).mode & 0o777,0o600)
 assert.equal((await f.request('GET','/api/providers')).data.apiKey,undefined)
 assert.equal(f.calls[0].authorization,'Bearer synthetic-gateway-secret')
})
test('model discovery remains unverified and never silently selects a model', async (t) => {
 const f = await fixture(t); await f.configure(); const r = await f.request('GET','/api/models')
 assert.equal(r.data.selectedModel,''); assert.ok(r.data.models.every((m) => m.availability==='listed_unverified')); assert.equal(f.app.readiness().models.ready,0)
})
test('explicit model selection and encrypted connection survive recreation', async (t) => {
 const f = await fixture(t); await f.configure(); assert.equal((await f.request('PUT','/api/models/selection',{model:'model-b'})).status,200)
 f.restart(); assert.equal(f.app.store.state.selectedModel,'model-b'); assert.equal(f.app.store.config().apiKey,'synthetic-gateway-secret'); assert.equal(f.app.authenticated({headers:{cookie:f.cookie}}),null)
})
test('changing model sends the exact id; unknown models fail without network fallback', async (t) => {
 const f = await fixture(t); await f.configure()
 for (const model of ['model-a','model-b']) { const r = await f.request('POST','/api/chat',f.chat({model})); assert.equal(r.status,200,JSON.stringify(r.data)); assert.equal(f.calls.at(-1).body.model,model); assert.equal(r.data.sentExternally,true) }
 const calls=f.calls.length; assert.equal((await f.request('POST','/api/chat',f.chat({model:'missing'}))).status,409); assert.equal(f.calls.length,calls)
})
test('all local or hybrid execution requests are rejected', async (t) => {
 const f = await fixture(t); await f.configure()
 for (const executionMode of ['local','hybrid']) assert.equal((await f.request('POST','/api/chat',f.chat({executionMode}))).data.error,'online_only')
 assert.equal(f.calls.filter((c)=>c.body).length,0)
})
test('classified history cannot be downgraded by a public label', async (t) => {
 const f = await fixture(t); await f.configure()
 const r = await f.request('POST','/api/chat',f.chat({messages:[{role:'user',content:'confidential internal only report'},{role:'assistant',content:'noted'},{role:'user',content:'hello'}],dataClass:'public'}))
 assert.equal(r.status,403); assert.equal(r.data.error,'sensitive_consent_required'); assert.equal(f.calls.length,1)
})
test('context and sensitive transfers require explicit current-recipient consent', async (t) => {
 const f = await fixture(t); await f.configure()
 assert.equal((await f.request('POST','/api/chat',f.chat({authorization:{confirmed:true,providerRevision:0}}))).status,403)
 assert.equal((await f.request('POST','/api/chat',f.chat({useMemory:true}))).data.error,'context_consent_required')
 const body=f.chat({prompt:'AUDIT_SECRET_TOKEN=not-a-real-credential'}); body.authorization.allowSensitive=true
 const r=await f.request('POST','/api/chat',body); assert.equal(r.status,200); assert.equal(r.data.classification,'restricted'); assert.ok(!JSON.stringify(f.calls.at(-1).body).includes('not-a-real-credential'))
})
test('provider body timeout covers headers-to-body delay', async (t) => {
 const f = await fixture(t,{timeoutMs:60}); await f.configure(); f.mode='body-stall'
 const r=await f.request('POST','/api/chat',f.chat()); assert.equal(r.status,504); assert.equal(r.data.error,'provider_timeout')
})
test('redirects are not followed and provider errors do not expose raw bodies', async (t) => {
 const f=await fixture(t); await f.configure(); f.mode='redirect'; const count=f.calls.length
 assert.equal((await f.request('POST','/api/chat',f.chat())).status,502); assert.equal(f.calls.length,count+1)
 f.mode='auth'; const r=await f.request('POST','/api/chat',f.chat()); assert.equal(r.data.error,'provider_auth_failed'); assert.ok(!JSON.stringify(r).includes('NEVER SHOW'))
})
test('streaming passes deltas and requires a real completion sentinel', async (t) => {
 const f=await fixture(t); await f.configure(); let r=await f.request('POST','/api/chat/stream',f.chat()); assert.equal(r.status,200); assert.match(r.data,/event: delta/); assert.match(r.data,/event: done/)
 f.mode='truncated';r=await f.request('POST','/api/chat/stream',f.chat()); assert.match(r.data,/event: error/); assert.ok(!r.data.includes('event: done'))
})
test('completed conversations are stored; failed streams do not become saved assistant turns', async (t) => {
 const f=await fixture(t);await f.configure(); const {data:s}=await f.request('POST','/api/sessions',{title:'test'})
 assert.equal((await f.request('POST','/api/chat',f.chat({sessionId:s.id}))).status,200)
 const memory=f.app.contextFor(f.accountId).memory
 const before=memory.getSession(s.id).turns.length;assert.equal(before,2)
 f.mode='truncated';await f.request('POST','/api/chat/stream',f.chat({sessionId:s.id}));assert.equal(memory.getSession(s.id).turns.length,before)
})
test('file knowledge and approved memory remain opt-in and backed by real stores', async (t) => {
 const f=await fixture(t);await f.configure()
 const saved=await f.request('POST','/api/knowledge/ingest',{title:'public sample',text:'The orchard gate opens at sunrise every morning.',classification:'public'})
 assert.equal(saved.status,201,JSON.stringify(saved.data))
 assert.equal((await f.request('GET','/api/knowledge/documents')).data.documents.length,1)
 assert.equal((await f.request('POST','/api/chat',f.chat({useKnowledge:true}))).status,403)
 const body=f.chat({prompt:'When does the orchard gate open?',useKnowledge:true});body.authorization.includeContext=true;body.authorization.allowSensitive=true
 assert.equal((await f.request('POST','/api/chat',body)).status,200)
 assert.ok(f.calls.at(-1).body.messages.some((m)=>m.content.includes('orchard')))
})
test('only reviewed built-in tools execute; custom installs and removed features are unavailable', async (t) => {
 const f=await fixture(t);await f.login()
 assert.equal((await f.request('POST','/api/plugins/install',{builtin:true})).status,403)
 assert.equal((await f.request('POST','/api/plugins/aetheris.online-status/invoke',{capability:'status',input:{}})).status,200)
 assert.equal((await f.request('POST','/api/mcp/call',{server:'aetheris.online',tool:'connection.status',arguments:{}})).status,200)
 for (const path of ['/api/hardware','/api/tasks','/api/storage','/api/skills']) assert.equal((await f.request('GET',path)).status,404)
 for (const kind of ['image','video']) assert.equal((await f.request('POST',`/api/${kind}/generate`,{})).data.error,'capability_unavailable')
})
test('connection removal clears credentials and model selection without deleting conversations', async (t) => {
 const f=await fixture(t);await f.configure();await f.request('POST','/api/sessions',{title:'keep me'})
 const r=await f.request('DELETE','/api/providers/litellm',{});assert.equal(r.data.keyConfigured,false);assert.deepEqual(r.data.models,[]);assert.equal((await f.request('GET','/api/sessions')).data.sessions.length,1)
})
test('public HTTPS endpoints are required unless the operator trusts an exact internal origin', () => {
 for (const url of ['file:///etc/passwd','https://user:pass@host.example/v1','http://public.example/v1','https://169.254.169.254','https://127.0.0.1','https://[::1]']) assert.throws(()=>gatewayUrl(url))
 assert.equal(gatewayUrl('https://gateway.example/v1/'),'https://gateway.example/v1')
 assert.equal(gatewayUrl('http://127.0.0.1:9999/v1',['http://127.0.0.1:9999']),'http://127.0.0.1:9999/v1')
 // The comparison is on the exact origin, and that is worth pinning because it surprises
 // people: a trailing slash, or `localhost` where the base URL says `127.0.0.1`, produces
 // the same refusal as never setting the variable at all.
 for (const trusted of [['http://127.0.0.1:9999/'], ['http://localhost:9999'], ['127.0.0.1:9999']]) {
   assert.throws(() => gatewayUrl('http://127.0.0.1:9999/v1', trusted), /trusted origin/, JSON.stringify(trusted))
 }
 for (const ip of ['127.0.0.1','10.0.0.2','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1']) assert.equal(privateAddress(ip),true,ip)
 assert.equal(privateAddress('8.8.8.8'),false)
})
test('an already cancelled request never reaches the gateway', async (t) => {
 const f=await fixture(t);await f.configure();const controller=new AbortController();controller.abort();const n=f.calls.length
 await assert.rejects(f.app.chat(f.chat(),{signal:controller.signal,session:f.session()}),{code:'cancelled'});assert.equal(f.calls.length,n)
})
