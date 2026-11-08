// One configuration surface for the optional Python workers.
//
// `AETHERIS_PYTHON` names the interpreter that has NumPy and the optional
// Fabric media dependencies. A configured value is authoritative: probing
// other interpreters could silently execute a different environment than the
// operator authorized. Without it, retain the historical developer-venv and
// PATH fallbacks.
//
// A clean checkout whose dependencies were installed into the repository's own
// `.venv` must also work without an extra environment variable. That venv is an
// explicit, repository-local installation, not an arbitrary interpreter found
// on PATH, so it is a safe first fallback. This is the difference between a
// release that is reproducible from a clean checkout and one that silently
// depends on a developer's shell exports.

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** Ordered interpreter fallbacks used only when AETHERIS_PYTHON is not set. */
export const DEFAULT_PYTHON_FALLBACKS = Object.freeze([
  join(REPO_ROOT, '.venv', 'bin', 'python'),
  '/tmp/accel-venv/bin/python',
  '/tmp/fabric-venv/bin/python',
  'python3',
])

export function configuredPythonBinary(env = process.env) {
  const value = typeof env.AETHERIS_PYTHON === 'string' ? env.AETHERIS_PYTHON.trim() : ''
  return value || null
}

export function pythonCandidates(fallback, env = process.env) {
  const configured = configuredPythonBinary(env)
  return configured ? [configured] : [...fallback]
}

export function defaultPythonBinary(env = process.env) {
  return configuredPythonBinary(env) || 'python3'
}
