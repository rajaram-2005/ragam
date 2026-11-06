// One configuration surface for the optional Python workers.
//
// `AETHERIS_PYTHON` names the interpreter that has NumPy and the optional
// Fabric media dependencies. A configured value is authoritative: probing
// other interpreters could silently execute a different environment than the
// operator authorized. Without it, retain the historical developer-venv and
// PATH fallbacks.

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
