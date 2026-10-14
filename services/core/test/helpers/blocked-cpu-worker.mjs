// Test-only fault injection: stall inside a forward pass, without cooperating with
// cancellation. Imports the production worker protocol after installing the hook.
import { parentPort } from 'node:worker_threads'
import { KlyvaronRuntime } from '../../src/klyvaron/runtime.mjs'
KlyvaronRuntime.prototype.logits = function () {
  parentPort.postMessage({ type: 'test_forward_started' })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
  throw new Error('test forward pass was not interrupted')
}
await import('../../src/klyvaron/worker.mjs')
