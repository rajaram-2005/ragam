// One local CPU worker. No sockets, remote fallback, training or dynamic code.
import { parentPort } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { KlyvaronRuntime } from './runtime.mjs'

globalThis.fetch = async () => { throw new Error('network access is disabled in the local inference worker') }
let runtime = null
let identity = null

parentPort.on('message', ({ directory, expected, generation, controlBuffer }) => {
  const control = new Int32Array(controlBuffer)
  const signal = { get aborted() { return Atomics.load(control, 0) !== 0 } }
  const send = (event) => parentPort.postMessage(event)
  try {
    if (signal.aborted) return send({ type: 'error', code: 'cancelled', message: 'local generation cancelled' })
    const key = JSON.stringify([directory, expected])
    if (!runtime || identity !== key) {
      runtime = null
      const started = performance.now()
      const loaded = KlyvaronRuntime.load(directory)
      const manifestSha256 = createHash('sha256').update(JSON.stringify(loaded.manifest)).digest('hex')
      if (loaded.sha256 !== expected.weightsSha256 || manifestSha256 !== expected.manifestSha256) {
        throw Object.assign(new Error('installed artifact changed since verification; re-open the library before using it'), { code: 'artifact_changed' })
      }
      if (expected.adapterDir) {
        const attached = loaded.attachAdapter(expected.adapterDir)
        if (expected.adapterSha256 && attached.sha256 !== expected.adapterSha256) {
          throw Object.assign(new Error('installed adapter digest changed since verification'), { code: 'artifact_changed' })
        }
      }
      runtime = loaded
      identity = key
      send({ type: 'loaded', loadMs: performance.now() - started, residentWeightPayloadBytes: runtime.residentWeightBytes })
    }
    const result = runtime.generate({ ...generation, signal,
      onResourceAdjustment: (adjustment) => send({ type: 'resource', adjustment }),
      onToken: (text) => {
        if (signal.aborted) return
        // One unacknowledged token only. Slow readers cannot build an unbounded queue.
        Atomics.store(control, 1, 0)
        send({ type: 'token', text })
        while (!signal.aborted && Atomics.load(control, 1) === 0) Atomics.wait(control, 1, 0, 1000)
      },
    })
    send({ type: 'result', result })
  } catch (error) {
    send({ type: 'error', code: error.code ?? 'inference_failed', message: error.message })
  }
})
