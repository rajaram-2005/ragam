import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once, EventEmitter } from 'node:events'
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { KlyvaronRuntime } from '../src/klyvaron/runtime.mjs'
import { LocalCpuExecutor } from '../src/klyvaron/execution.mjs'
import { KlyvaronProvider } from '../src/providers/klyvaron.mjs'
import { AetherisOmniApp, createHttpServer } from '../src/app.mjs'
import { loadConfig } from '../src/config.mjs'
import { CATEGORIES, MobileStorageBudget } from '../src/storage/budget.mjs'

const guard = { fetch() { throw new Error('local inference must not call fetch') } }
const float = JSON.parse(readFileSync(new URL('./fixtures/klyvaron-lite-parity.json', import.meta.url)))
const int8 = JSON.parse(readFileSync(new URL('./fixtures/klyvaron-lite-int8-parity.json', import.meta.url)))
function writeArtifact(directory, fixture = float) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'model.klyvaron.json'), JSON.stringify(fixture.manifest))
  writeFileSync(join(directory, fixture.manifest.weights.file), Buffer.from(fixture.npzBase64, 'base64'))
  return directory
}
function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'klyvaron-execution-'))
  writeArtifact(directory, options.fixture ?? float)
  const executor = new LocalCpuExecutor(options)
  const runtime = KlyvaronRuntime.load(directory)
  const provider = new KlyvaronProvider({ runtime, executor, guard, timeoutMs: options.timeoutMs ?? 10_000 })
  t.after(async () => { await executor.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, executor, runtime, provider }
}
function blockedWorker(executor) {
  const worker = new Worker(new URL('./helpers/blocked-cpu-worker.mjs', import.meta.url))
  executor.worker = worker
  const forward = new Promise((resolve) => {
    const listen = (event) => { if (event.type === 'test_forward_started') { worker.off('message', listen); resolve() } }
    worker.on('message', listen)
  })
  return { worker, forward }
}
async function core(t) {
  const root = mkdtempSync(join(tmpdir(), 'klyvaron-http-execution-'))
  const budget = new MobileStorageBudget({ root: join(root, 'klyvaron') })
  const directory = writeArtifact(join(budget.pathFor(CATEGORIES.MODEL_WEIGHTS), float.manifest.id))
  const app = new AetherisOmniApp({ config: loadConfig({ AETHERIS_DATA_DIR: root, AETHERIS_RUNTIME_POLICY: 'strict_offline', OLLAMA_ENABLED: 'false', LLAMACPP_ENABLED: 'false' }) })
  const server = createHttpServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    await app.localExecution.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await app.close()
    rmSync(root, { recursive: true, force: true })
  })
  const model = `klyvaron:${float.manifest.id}`
  const post = (path, extra = {}, signal) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'Aetheris', temperature: 0, maxTokens: 8, model, ...extra }), signal })
  return { app, url, model, post, directory }
}

test('float and int8 worker results retain parity, one resident model, and no parent weight arrays', async (t) => {
  const { directory, executor, runtime, provider } = setup(t)
  assert.equal(executor.snapshot().state, 'cold')
  assert.equal(provider.runtime.params, undefined)
  assert.equal(provider.safeDescriptor().residentWeightBytes, 0)
  const reference = runtime.generate({ prompt: 'Aetheris', maxNewTokens: 8 })
  const first = await provider.chat({ prompt: 'Aetheris', maxTokens: 8 })
  assert.equal(first.text, reference.text)
  assert.equal(first.doneReason, 'length')
  const worker = executor.worker
  assert.ok(worker instanceof Worker)
  await provider.chat({ prompt: 'Aetheris', maxTokens: 2 })
  assert.equal(executor.worker, worker, 'reuse the one cached model')
  const secondDir = writeArtifact(join(directory, 'int8'), int8)
  const secondRuntime = KlyvaronRuntime.load(secondDir)
  const second = new KlyvaronProvider({ runtime: secondRuntime, executor, guard })
  const expected = secondRuntime.generate({ prompt: 'Aetheris', maxNewTokens: 8 })
  let streamed = '', completion
  for await (const delta of second.chatStream({ prompt: 'Aetheris', maxTokens: 8, onComplete: (value) => { completion = value } })) streamed += delta
  assert.equal(streamed, expected.text)
  assert.equal(completion.usage.completionTokens, 8)
  assert.equal(worker.threadId, -1, 'old worker was terminated before loading another model')
  assert.notEqual(executor.worker, worker)
  assert.equal(provider.safeDescriptor().resident, false)
  assert.equal(second.safeDescriptor().residentWeightBytes, int8.report.quantizedResidentWeightBytes)
  assert.equal(executor.snapshot().residentWeightPayloadBytes, int8.report.quantizedResidentWeightBytes)
})

test('token delivery is incremental, backpressured, busy-refusing and closes on an early break', async (t) => {
  const { executor, provider } = setup(t)
  await provider.chat({ prompt: 'Aetheris', maxTokens: 1 })
  let tokens = 0, finished = false
  executor.worker.on('message', (event) => { if (event.type === 'token') tokens += 1 })
  const stream = provider.chatStream({ prompt: 'Aetheris', maxTokens: 8, onComplete: () => { finished = true } })
  const first = await stream.next()
  assert.equal(first.done, false)
  assert.ok(first.value.length)
  assert.equal(finished, false)
  await delay(30)
  assert.equal(tokens, 1, 'the worker must wait for acknowledgement, not buffer the remainder')
  assert.equal(executor.snapshot().state, 'running')
  await assert.rejects(provider.chat({ prompt: 'Aetheris' }), { code: 'local_busy', status: 503 })
  assert.equal(executor.snapshot().queueDepth, 0)
  await stream.return()
  assert.equal(executor.worker, null)
  assert.equal(provider.measurement().completions, 1, 'abandoned stream is not successful completion')
})

test('partial stop sequences never leak, including overlapping and unmatched prefixes', (t) => {
  const { runtime } = setup(t)
  for (const stop of [['her'], ['Az'], ['AetherisZZ'], ['ris', 'heris'], ['A'], []]) {
    let position = 0
    const ids = runtime.tokenizer.encode('Aetheris')
    runtime.logits = () => {
      const logits = new Float64Array(runtime.manifest.architecture.vocab_size)
      logits[ids[position++]] = 1
      return logits
    }
    const chunks = []
    const result = runtime.generate({ prompt: 'A', maxNewTokens: 8, stop, onToken: (text) => chunks.push(text) })
    assert.equal(chunks.join(''), result.text)
    assert.ok(stop.every((sequence) => !result.text.includes(sequence)))
    if (stop[0] === 'her') assert.equal(result.text, 'Aet')
    if (stop[0] === 'AetherisZZ') assert.equal(result.text, 'Aetheris')
  }
})

test('a pre-aborted task does not start a worker or count as success', async (t) => {
  const { executor, provider } = setup(t)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(provider.chat({ prompt: 'Aetheris', signal: controller.signal }), { code: 'cancelled', status: 499 })
  assert.equal(executor.worker, null)
  assert.equal(provider.measurement().completions, 0)
})

test('a paused consumer times out, releases capacity, and cannot kill a subsequent task when it unwinds', { timeout: 10_000 }, async (t) => {
  const { executor, provider } = setup(t)
  await provider.chat({ prompt: 'Aetheris', maxTokens: 1 })
  provider.timeoutMs = 1000
  const old = provider.chatStream({ prompt: 'Aetheris', maxTokens: 8 })
  await old.next()
  const exit = once(executor.worker, 'exit')
  await exit
  await nextTurn()
  assert.equal(executor.active, null)
  assert.equal(executor.worker, null)
  provider.timeoutMs = 10_000
  const current = provider.chatStream({ prompt: 'Aetheris', maxTokens: 8 })
  assert.equal((await current.next()).done, false)
  const currentWorker = executor.worker
  await assert.rejects(old.next(), { code: 'timeout', status: 504 })
  assert.equal(executor.worker, currentWorker)
  assert.equal(executor.snapshot().state, 'running')
  await current.return()
})

test('a deadline interrupts a non-cooperative forward pass, not merely its next token', { timeout: 10_000 }, async (t) => {
  const { executor, provider } = setup(t, { timeoutMs: 2000 })
  const { forward } = blockedWorker(executor)
  const rejected = assert.rejects(provider.chat({ prompt: 'Aetheris' }), { code: 'timeout', status: 504 })
  await forward
  await rejected
  assert.equal(executor.worker, null)
  assert.equal(provider.measurement().completions, 0)
})

test('worker reload rejects a manifest changed after startup verification', async (t) => {
  const { directory, provider, executor } = setup(t)
  const manifest = structuredClone(float.manifest)
  manifest.limitations.push('changed after verification')
  writeFileSync(join(directory, 'model.klyvaron.json'), JSON.stringify(manifest))
  await assert.rejects(provider.chat({ prompt: 'Aetheris' }), { code: 'artifact_changed' })
  assert.equal(executor.worker, null)
  assert.equal(provider.measurement().completions, 0)
})

test('worker reload independently checks the weight digest', async (t) => {
  const { directory, provider } = setup(t)
  const file = join(directory, float.manifest.weights.file)
  const bytes = readFileSync(file)
  bytes[bytes.length - 1] ^= 1
  writeFileSync(file, bytes)
  await assert.rejects(provider.chat({ prompt: 'Aetheris' }), { code: 'digest_mismatch' })
})

test('idle expiry and shutdown release resident weights and refuse later execution', async (t) => {
  const { executor, provider } = setup(t, { idleTimeoutMs: 30 })
  await provider.chat({ prompt: 'Aetheris', maxTokens: 1 })
  executor.idleTimer.ref() // The production timer intentionally does not keep Core alive.
  await once(executor.worker, 'exit')
  assert.equal(executor.snapshot().residentWeightPayloadBytes, 0)
  assert.equal(executor.snapshot().state, 'cold')
  await executor.close()
  await assert.rejects(provider.chat({ prompt: 'Aetheris' }), { code: 'executor_closed' })
})

test('unexpected worker exit rejects rather than fabricating a completed response', async (t) => {
  const { executor, provider } = setup(t)
  const { worker, forward } = blockedWorker(executor)
  const rejected = assert.rejects(provider.chat({ prompt: 'Aetheris' }), { code: 'worker_failed' })
  await forward
  await worker.terminate()
  await rejected
  assert.equal(provider.measurement().completions, 0)
})

test('HTTP health remains responsive during a blocked CPU pass; disconnect cancels JSON generation', { timeout: 10_000 }, async (t) => {
  const { app, url, post } = await core(t)
  assert.equal(app.readiness().klyvaron.execution.state, 'cold')
  const { worker, forward } = blockedWorker(app.localExecution)
  const controller = new AbortController()
  const request = assert.rejects(post('/api/chat', {}, controller.signal), { name: 'AbortError' })
  await forward
  const health = await fetch(url + '/api/health')
  assert.equal(health.status, 200)
  await health.json()
  assert.equal(app.localExecution.snapshot().state, 'running')
  const busy = await post('/api/chat')
  assert.equal(busy.status, 503)
  assert.equal((await busy.json()).error, 'local_busy')
  const exit = once(worker, 'exit')
  controller.abort()
  await request
  await exit
  await nextTurn()
  assert.equal(app.localExecution.worker, null)
  const retry = await post('/api/chat')
  assert.equal(retry.status, 200)
  assert.equal((await retry.json()).sentExternally, false)
})

test('HTTP SSE disconnect also interrupts a blocked forward pass', { timeout: 10_000 }, async (t) => {
  const { app, post } = await core(t)
  const { worker, forward } = blockedWorker(app.localExecution)
  const response = await post('/api/chat/stream')
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.match(new TextDecoder().decode(first.value), /event: route/)
  await forward
  const exit = once(worker, 'exit')
  await reader.cancel()
  reader.releaseLock()
  await exit
  await nextTurn()
  assert.equal(app.localExecution.worker, null)
})

test('HTTP streamed stops are private and completion metadata reports the actual stop reason', async (t) => {
  const { post } = await core(t)
  const response = await post('/api/chat/stream', { stop: ['syy'] })
  const frames = (await response.text()).trim().split('\n\n').map((frame) => ({
    name: /^event: (.+)$/m.exec(frame)[1], data: JSON.parse(/^data: (.+)$/m.exec(frame)[1]),
  }))
  const text = frames.filter((f) => f.name === 'delta').map((f) => f.data.text).join('')
  assert.equal(text, 's')
  assert.equal(frames.at(-1).name, 'done')
  assert.equal(frames.at(-1).data.doneReason, 'stop')
  assert.equal(frames.at(-1).data.usage.completionTokens, 4)
  assert.equal(frames.at(-1).data.instructionTuned, false)
  assert.equal(frames.at(-1).data.sentExternally, false)
})

test('HTTP SSE deadline emits an error, never a successful done event', { timeout: 10_000 }, async (t) => {
  const { app, model, post } = await core(t)
  app.providers[model].timeoutMs = 2000
  blockedWorker(app.localExecution)
  const response = await post('/api/chat/stream')
  const body = await response.text()
  assert.match(body, /event: error/)
  assert.match(body, /"code":"timeout"/)
  assert.doesNotMatch(body, /event: done/)
  assert.equal(app.providers[model].measurement().completions, 0)
})


test('SSE socket backpressure withholds the next worker token until drain', async (t) => {
  const { app, model } = await core(t)
  const response = new EventEmitter()
  response.destroyed = false
  response.writableNeedDrain = false
  let unblock, ended = false
  const blocked = new Promise((resolve) => { unblock = resolve })
  const frames = []
  const streaming = app.streamChat(response, { prompt: 'Aetheris', model, temperature: 0, maxTokens: 8 }, () => {}, (frame) => {
    frames.push(frame)
    if (frame.startsWith('event: delta') && !response.blockedOnce) {
      response.blockedOnce = true
      response.writableNeedDrain = true
      unblock()
      return false
    }
    return true
  }, () => { ended = true })
  await blocked
  let ahead = 0
  app.localExecution.worker.on('message', (event) => { if (event.type === 'token') ahead += 1 })
  await delay(30)
  assert.equal(ended, false)
  assert.equal(ahead, 0)
  response.writableNeedDrain = false
  response.emit('drain')
  await streaming
  assert.equal(ended, true)
  assert.match(frames.at(-1), /^event: done/)
  assert.equal(response.listenerCount('drain'), 0)
  assert.equal(response.listenerCount('close'), 0)
})

test('app shutdown interrupts an active worker before closing its audit stores', { timeout: 10_000 }, async (t) => {
  const { app, model } = await core(t)
  const { forward } = blockedWorker(app.localExecution)
  const rejected = assert.rejects(app.chat({ prompt: 'Aetheris', model }), { code: 'cancelled' })
  await forward
  await app.close()
  await rejected
  assert.equal(app.localExecution.snapshot().state, 'closed')
  assert.equal(app.localExecution.worker, null)
})
