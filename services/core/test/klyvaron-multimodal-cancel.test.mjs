// Cancelling a native media job must stop the Python worker, not just the
// bookkeeping. Regression: the job's AbortSignal never reached
// `runWorkerExec`, so a cancelled generation kept computing to completion
// (and a hung worker could outlive its SIGTERM-only timeout forever).

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NativeMultimodalHost } from '../src/klyvaron/multimodal-host.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const MODELS = join(REPO_ROOT, '.aetheris-data', 'online', 'klyvaron', 'models')
const PYTHON = process.env.AETHERIS_PYTHON || 'python3'

let pythonChecked = null
/** The worker imports numpy and the Fabric adapters (jax/av/Pillow); without them
 * the second test fails with an environment error that reads as a product bug.
 * Probe once and skip honestly instead — CI installs these into its python. */
function pythonCanRunWorker() {
  if (pythonChecked === null) {
    const probe = spawnSync(PYTHON, ['-c', 'import numpy, jax, av, PIL'], { encoding: 'utf8', timeout: 60_000 })
    pythonChecked = probe.status === 0
  }
  return pythonChecked
}

function hostOrSkip(t, modelId) {
  if (!existsSync(join(MODELS, modelId))) return t.skip(`${modelId} is not installed on this host`)
  if (!pythonCanRunWorker()) return t.skip(`${PYTHON} cannot import numpy/jax/av/Pillow; set AETHERIS_PYTHON to an interpreter that can`)
  const host = new NativeMultimodalHost({ modelsRoot: MODELS, pythonBinary: PYTHON })
  if (!host.records.get(modelId)?.verified) return t.skip(`${modelId} is not verified on this host`)
  return host
}

test('a pre-aborted generation refuses before any worker starts', async (t) => {
  const host = hostOrSkip(t, 'klyvaron-pro-image')
  if (!host) return
  const controller = new AbortController()
  controller.abort()
  const started = Date.now()
  await assert.rejects(
    host.generateImage({ modelId: 'klyvaron-pro-image', prompt: 'a lighthouse', signal: controller.signal }),
    { code: 'aborted' },
  )
  assert.ok(Date.now() - started < 2_000, 'refused immediately, without inference')
})

test('aborting mid-generation terminates the worker instead of completing', async (t) => {
  const host = hostOrSkip(t, 'klyvaron-pro-video')
  if (!host) return
  const controller = new AbortController()
  const started = Date.now()
  const pending = host.generateVideo({
    modelId: 'klyvaron-pro-video',
    prompt: 'waves over a harbour',
    signal: controller.signal,
  })
  // Python + JAX startup alone takes longer than this, so the abort always
  // lands while the worker is running.
  setTimeout(() => controller.abort(), 150)
  await assert.rejects(pending, { code: 'aborted' })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 30_000, `settled as cancelled in ${elapsed}ms, not after a full generation`)
})
