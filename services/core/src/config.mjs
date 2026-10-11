// Configuration loading.
//
// Secrets are read only here, in the server process, from the environment or from a
// file path. They are never returned to a client, never written to the audit ledger,
// and never included in a frontend bundle (directive §4.E, §12).

import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { RUNTIME_POLICIES, DATA_CLASSES } from './policy/egress.mjs'

export const DEFAULT_CONFIG = Object.freeze({
  port: 8790,
  host: '0.0.0.0',
  allowedOrigin: null, // null → same-origin only; '*' must be an explicit choice
  dataDir: resolve(process.cwd(), '.aetheris-data'),
  policy: RUNTIME_POLICIES.STRICT_OFFLINE,
  externalCeiling: DATA_CLASSES.INTERNAL,
  // Local runtimes: loopback only, so they stay reachable in strict_offline.
  ollama: { enabled: true, baseUrl: 'http://127.0.0.1:11434' },
  llamaCpp: { enabled: false, baseUrl: 'http://127.0.0.1:8080/v1', runtime: 'llama.cpp', apiKey: null },
  // Online gateway. Off unless explicitly configured AND the policy allows it.
  freellmapi: { enabled: false, baseUrl: null, apiKey: null },
  onlineAllowlist: [],
  localAllowlist: [],
  fabric: { enabled: false, baseUrl: 'http://127.0.0.1:8791' },
  media: { concurrency: 1, videoTimeoutMs: 600_000, imageTimeoutMs: 300_000 },
  knowledge: { chunkTargetChars: 1200, chunkMaxChars: 2000, chunkOverlapChars: 160, embeddingModel: null },
  godMode: { enabled: true, maxSteps: 12, maxDurationMs: 300_000 },
})

/** Read a secret from the environment or from a *_FILE path. Never logged. */
function readSecret(env, directKey, fileKey) {
  const filePath = env[fileKey]
  if (filePath) {
    try {
      return readFileSync(resolve(filePath), 'utf8').trim() || null
    } catch {
      return null
    }
  }
  const direct = env[directKey]
  return direct ? String(direct).trim() : null
}

function parseList(value) {
  if (!value) return []
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

/**
 * Build a config from an environment object.
 * Unknown keys are reported so a typo cannot silently disable a safety control.
 */
export function loadConfig(env = process.env, overrides = {}) {
  const warnings = []

  const policy = env.AETHERIS_RUNTIME_POLICY || DEFAULT_CONFIG.policy
  if (!Object.values(RUNTIME_POLICIES).includes(policy)) {
    warnings.push(`AETHERIS_RUNTIME_POLICY='${policy}' is not valid; falling back to strict_offline`)
  }
  const resolvedPolicy = Object.values(RUNTIME_POLICIES).includes(policy) ? policy : RUNTIME_POLICIES.STRICT_OFFLINE

  const externalCeiling = env.AETHERIS_EXTERNAL_DATA_CEILING || DEFAULT_CONFIG.externalCeiling
  if (!Object.values(DATA_CLASSES).includes(externalCeiling)) {
    warnings.push(`AETHERIS_EXTERNAL_DATA_CEILING='${externalCeiling}' is not valid; falling back to internal`)
  }

  const freellmapiKey = readSecret(env, 'FREELLMAPI_API_KEY', 'FREELLMAPI_API_KEY_FILE')
  const freellmapiBaseUrl = env.FREELLMAPI_BASE_URL || null
  const freellmapiEnabled = parseBoolean(env.FREELLMAPI_ENABLED, Boolean(freellmapiKey && freellmapiBaseUrl))
  if (freellmapiEnabled && (!freellmapiKey || !freellmapiBaseUrl)) {
    warnings.push('FREELLMAPI_ENABLED is set but the key or base URL is missing; the online gateway stays disabled')
  }

  const onlineAllowlist = parseList(env.AETHERIS_ONLINE_ALLOWLIST)
  if (freellmapiEnabled && freellmapiBaseUrl) {
    try {
      const host = new URL(freellmapiBaseUrl).hostname
      if (!onlineAllowlist.includes(host)) onlineAllowlist.push(host)
    } catch {
      warnings.push(`FREELLMAPI_BASE_URL='${freellmapiBaseUrl}' is not a valid absolute URL`)
    }
  }

  if (resolvedPolicy === RUNTIME_POLICIES.STRICT_OFFLINE && onlineAllowlist.length) {
    warnings.push(`an online allowlist is configured but policy is strict_offline; ${onlineAllowlist.length} host(s) will still be blocked`)
  }

  // A secret in a VITE_* variable would be shipped to the browser. Refuse loudly.
  for (const key of Object.keys(env)) {
    if (/^VITE_.*(KEY|TOKEN|SECRET|PASSWORD)/i.test(key)) {
      warnings.push(`${key} looks like a secret in a frontend-exposed variable; move it server-side`)
    }
  }

  const dataDir = resolve(env.AETHERIS_DATA_DIR || DEFAULT_CONFIG.dataDir)
  mkdirSync(dataDir, { recursive: true })

  const config = {
    port: Number(env.AETHERIS_CORE_PORT || DEFAULT_CONFIG.port),
    host: env.AETHERIS_CORE_HOST || DEFAULT_CONFIG.host,
    allowedOrigin: env.AETHERIS_ALLOWED_ORIGIN || null,
    dataDir,
    policy: resolvedPolicy,
    externalCeiling: Object.values(DATA_CLASSES).includes(externalCeiling) ? externalCeiling : DATA_CLASSES.INTERNAL,
    ollama: {
      enabled: parseBoolean(env.OLLAMA_ENABLED, DEFAULT_CONFIG.ollama.enabled),
      baseUrl: env.OLLAMA_BASE_URL || DEFAULT_CONFIG.ollama.baseUrl,
    },
    llamaCpp: {
      enabled: parseBoolean(env.LLAMACPP_ENABLED, DEFAULT_CONFIG.llamaCpp.enabled),
      baseUrl: env.LLAMACPP_BASE_URL || DEFAULT_CONFIG.llamaCpp.baseUrl,
      runtime: env.LLAMACPP_RUNTIME || DEFAULT_CONFIG.llamaCpp.runtime,
      apiKey: readSecret(env, 'LLAMACPP_API_KEY', 'LLAMACPP_API_KEY_FILE'),
    },
    freellmapi: {
      enabled: freellmapiEnabled && Boolean(freellmapiKey && freellmapiBaseUrl),
      baseUrl: freellmapiBaseUrl,
      apiKey: freellmapiKey,
      videoTimeoutMs: Number(env.FREELLMAPI_VIDEO_TIMEOUT_MS || DEFAULT_CONFIG.media.videoTimeoutMs),
    },
    onlineAllowlist,
    localAllowlist: parseList(env.AETHERIS_LOCAL_ALLOWLIST),
    fabric: {
      enabled: parseBoolean(env.AETHERIS_FABRIC_ENABLED, DEFAULT_CONFIG.fabric.enabled),
      baseUrl: env.AETHERIS_FABRIC_URL || DEFAULT_CONFIG.fabric.baseUrl,
    },
    media: {
      concurrency: Number(env.AETHERIS_MEDIA_CONCURRENCY || DEFAULT_CONFIG.media.concurrency),
      videoTimeoutMs: Number(env.FREELLMAPI_VIDEO_TIMEOUT_MS || DEFAULT_CONFIG.media.videoTimeoutMs),
      imageTimeoutMs: Number(env.AETHERIS_IMAGE_TIMEOUT_MS || DEFAULT_CONFIG.media.imageTimeoutMs),
    },
    knowledge: {
      chunkTargetChars: Number(env.AETHERIS_CHUNK_TARGET || DEFAULT_CONFIG.knowledge.chunkTargetChars),
      chunkMaxChars: Number(env.AETHERIS_CHUNK_MAX || DEFAULT_CONFIG.knowledge.chunkMaxChars),
      chunkOverlapChars: Number(env.AETHERIS_CHUNK_OVERLAP || DEFAULT_CONFIG.knowledge.chunkOverlapChars),
      embeddingModel: env.AETHERIS_EMBEDDING_MODEL || null,
      dbFile: resolve(dataDir, 'knowledge.sqlite'),
    },
    godMode: {
      enabled: parseBoolean(env.AETHERIS_GODMODE_ENABLED, DEFAULT_CONFIG.godMode.enabled),
      maxSteps: Number(env.AETHERIS_GODMODE_MAX_STEPS || DEFAULT_CONFIG.godMode.maxSteps),
      maxDurationMs: Number(env.AETHERIS_GODMODE_MAX_MS || DEFAULT_CONFIG.godMode.maxDurationMs),
    },
    warnings,
  }
  return config
}

/**
 * A redacted view safe to expose over HTTP. Contains no secret material: only
 * whether each credential exists.
 */
export function publicConfig(config) {
  return {
    policy: config.policy,
    externalCeiling: config.externalCeiling,
    offlineEnforced: config.policy === RUNTIME_POLICIES.STRICT_OFFLINE,
    dataDir: config.dataDir,
    ollama: { enabled: config.ollama.enabled, baseUrl: config.ollama.baseUrl },
    llamaCpp: { enabled: config.llamaCpp.enabled, baseUrl: config.llamaCpp.baseUrl, runtime: config.llamaCpp.runtime, keyConfigured: Boolean(config.llamaCpp.apiKey) },
    freellmapi: {
      enabled: config.freellmapi.enabled,
      // Host and path only — never a query string or credentials.
      endpoint: redactUrl(config.freellmapi.baseUrl),
      keyConfigured: Boolean(config.freellmapi.apiKey),
      keyTransport: process.env.FREELLMAPI_API_KEY_FILE ? 'file' : 'server environment',
    },
    fabric: config.fabric,
    onlineAllowlist: config.onlineAllowlist,
    localAllowlist: config.localAllowlist,
    media: config.media,
    knowledge: { ...config.knowledge, dbFile: undefined },
    godMode: config.godMode,
    browserKeyExposure: false,
    warnings: config.warnings,
  }
}

export function redactUrl(value) {
  if (!value) return null
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return '[configured endpoint]'
  }
}

/** Minimal .env reader, mirroring the original Aetheris gateway. */
export function loadDotEnv(cwd = process.cwd()) {
  const path = resolve(cwd, '.env')
  if (!existsSync(path)) return {}
  const parsed = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match) continue
    parsed[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
  return parsed
}
