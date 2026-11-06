// Bounded execution of the optional Python worker behind legacy artifact hosts.
//
// Cancellation is a process boundary, not just a rejected promise: SIGTERM is
// followed by SIGKILL if the child does not exit. A pre-aborted signal starts no
// child, and a spawn failure settles the promise instead of leaving it pending.

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const DEFAULT_WORKER_EXEC_PY = join(REPO_ROOT, 'services', 'fabric', 'scripts', 'worker_exec.py')

export function runWorkerExec(op, spec, {
  pythonBinary = 'python3',
  workerExecScript = DEFAULT_WORKER_EXEC_PY,
  cwd = REPO_ROOT,
  timeoutMs = 120_000,
  killGraceMs = 2_000,
  signal = null,
} = {}) {
  return new Promise((resolveOut, rejectOut) => {
    if (signal?.aborted) {
      const err = new Error(`worker_exec '${op}' was cancelled before it started`)
      err.code = 'aborted'
      rejectOut(err)
      return
    }

    mkdirSync(tmpdir(), { recursive: true })
    const specPath = join(tmpdir(), `klyvaron-mm-${op}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
    writeFileSync(specPath, JSON.stringify(spec), 'utf8')
    const child = spawn(pythonBinary, [workerExecScript, op, specPath], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, XLA_PYTHON_CLIENT_PREALLOCATE: 'false' },
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let aborted = false
    let timedOut = false
    let killTimer = null

    const killChild = () => {
      try { child.kill('SIGTERM') } catch {}
      killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, killGraceMs)
      killTimer.unref()
    }
    const onAbort = () => { aborted = true; killChild() }
    const timer = setTimeout(() => { timedOut = true; killChild() }, timeoutMs)
    timer.unref()
    signal?.addEventListener('abort', onAbort, { once: true })

    const cleanup = () => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
      try { rmSync(specPath, { force: true }) } catch {}
    }
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      cleanup()
      fn(value)
    }

    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (cause) => {
      const err = new Error(`worker_exec '${op}' could not start '${pythonBinary}': ${cause.message}`)
      err.code = 'multimodal_exec_failed'
      settle(rejectOut, err)
    })
    child.on('close', (code) => {
      if (aborted) {
        const err = new Error(`worker_exec '${op}' was cancelled`)
        err.code = 'aborted'
        settle(rejectOut, err)
        return
      }
      if (timedOut) {
        const err = new Error(`worker_exec '${op}' exceeded ${timeoutMs}ms and was terminated`)
        err.code = 'multimodal_exec_timeout'
        settle(rejectOut, err)
        return
      }
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
      let last = null
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try { last = JSON.parse(lines[i]); break } catch {}
      }
      if (code === 0 && last?.ok) {
        settle(resolveOut, last)
      } else {
        const err = new Error(last?.message || stderr.trim() || `worker_exec '${op}' exited with code ${code}`)
        err.code = last?.code || 'multimodal_exec_failed'
        settle(rejectOut, err)
      }
    })
  })
}
