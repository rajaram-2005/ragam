// Configuration loading.
//
// Core credentials are read here; optional catalog credentials are loaded by
// catalog/sources.mjs. Both stay in the server process, read from environment or a
// file path. They are never returned to a client, never written to the audit ledger,
// and never included in a frontend bundle (directive §4.E, §12).

import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { RUNTIME_POLICIES, DATA_CLASSES, ALLOW_ALL_HOSTS } from './policy/egress.mjs'

export const DEFAULT_CONFIG = Object.freeze({
  port: 8790,
  host: '0.0.0.0',
  allowedOrigin: null, // null → same-origin only; '*' must be an explicit choice
  dataDir: resolve(process.cwd(), '.aetheris-data'),
  modelCatalogFile: null,
  policy: RUNTIME_POLICIES.STRICT_OFFLINE,
  externalCeiling: DATA_CLASSES.INTERNAL,
  // Local runtimes: loopback only, so they stay reachable in strict_offline.
  ollama: { enabled: true, baseUrl: 'http://127.0.0.1:11434' },
  llamaCpp: { enabled: false, baseUrl: 'http://127.0.0.1:8080/v1', runtime: 'llama.cpp', apiKey: null },
  onlineAllowlist: [],
  localAllowlist: [],
  fabric: { enabled: false, baseUrl: 'http://127.0.0.1:8791' },
  media: { concurrency: 1, videoTimeoutMs: 600_000, imageTimeoutMs: 300_000 },
  knowledge: { chunkTargetChars: 1200, chunkMaxChars: 2000, chunkOverlapChars: 160, embeddingModel: null },
  // Publisher signatures for plugins. The trust store is a file of public keys this host
  // has chosen to trust; it is never fetched, and signatures are required only when the
  // operator says so. An empty list is not a control, and is reported as such.
  plugins: { trustStoreFile: null, requireSignature: false },
  // MCP servers permitted on this host. Empty means unrestricted, which is reported
  // rather than dressed up as a control.
  mcp: { allowlist: [] },
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

  const onlineAllowlist = parseList(env.AETHERIS_ONLINE_ALLOWLIST)

  if (resolvedPolicy === RUNTIME_POLICIES.STRICT_OFFLINE && onlineAllowlist.length) {
    warnings.push(`an online allowlist is configured but policy is strict_offline; ${onlineAllowlist.length} host(s) will still be blocked`)
  }

  // Wide-open egress is a legitimate operating mode, but it must never be *quiet*.
  // An allowlist containing '*' means every outbound host is permitted, and under
  // online_enabled the data-classification gate is bypassed as well, so the two
  // together mean company-private text can leave the machine with no gate at all.
  // That combination is warned about specifically, because "fully online" and
  // "unclassified egress" are different decisions that one setting silently makes.
  if (onlineAllowlist.includes(ALLOW_ALL_HOSTS) && resolvedPolicy !== RUNTIME_POLICIES.STRICT_OFFLINE) {
    warnings.push(
      "AETHERIS_ONLINE_ALLOWLIST contains '*': egress to ANY external host is permitted. " +
        'strict_offline would still block everything; the current policy does not.',
    )
    if (resolvedPolicy === RUNTIME_POLICIES.ONLINE_ENABLED) {
      warnings.push(
        `policy online_enabled bypasses data classification entirely, so text classified up to '` +
          `restricted' may be sent to any host on this allowlist. Use hybrid with the same allowlist ` +
          `to keep the '${externalCeiling}' ceiling enforced while remaining fully online.`,
      )
    }
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
    modelCatalogFile: env.AETHERIS_MODEL_CATALOG_FILE ? resolve(env.AETHERIS_MODEL_CATALOG_FILE) : null,
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
    onlineAllowlist,
    localAllowlist: parseList(env.AETHERIS_LOCAL_ALLOWLIST),
    fabric: {
      enabled: parseBoolean(env.AETHERIS_FABRIC_ENABLED, DEFAULT_CONFIG.fabric.enabled),
      baseUrl: env.AETHERIS_FABRIC_URL || DEFAULT_CONFIG.fabric.baseUrl,
    },
    media: {
      concurrency: Number(env.AETHERIS_MEDIA_CONCURRENCY || DEFAULT_CONFIG.media.concurrency),
      videoTimeoutMs: Number(env.AETHERIS_VIDEO_TIMEOUT_MS || DEFAULT_CONFIG.media.videoTimeoutMs),
      imageTimeoutMs: Number(env.AETHERIS_IMAGE_TIMEOUT_MS || DEFAULT_CONFIG.media.imageTimeoutMs),
    },
    knowledge: {
      chunkTargetChars: Number(env.AETHERIS_CHUNK_TARGET || DEFAULT_CONFIG.knowledge.chunkTargetChars),
      chunkMaxChars: Number(env.AETHERIS_CHUNK_MAX || DEFAULT_CONFIG.knowledge.chunkMaxChars),
      chunkOverlapChars: Number(env.AETHERIS_CHUNK_OVERLAP || DEFAULT_CONFIG.knowledge.chunkOverlapChars),
      embeddingModel: env.AETHERIS_EMBEDDING_MODEL || null,
      dbFile: resolve(dataDir, 'knowledge.sqlite'),
    },
    plugins: {
      // Default sits beside the memory database rather than in it: keys are not user data,
      // and a wipe of user data must not take the keys with it.
      trustStoreFile: resolve(env.AETHERIS_TRUST_STORE || resolve(dataDir, 'trusted-keys.json')),
      requireSignature: parseBoolean(env.AETHERIS_PLUGIN_REQUIRE_SIGNATURE, DEFAULT_CONFIG.plugins.requireSignature),
    },
    mcp: {
      allowlist: parseList(env.AETHERIS_MCP_ALLOWLIST),
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
    // Mirrors the guard: '*' under strict_offline is inert, so reporting it as
    // "allow all" would invert the meaning of the field at the worst moment.
    allowAllExternal:
      config.policy !== RUNTIME_POLICIES.STRICT_OFFLINE && config.onlineAllowlist.includes(ALLOW_ALL_HOSTS),
    onlineAllowlist: [...config.onlineAllowlist],
    dataDir: config.dataDir,
    // URLs that cross the HTTP boundary are reduced to protocol://host/path. A query
    // string is where a token ends up, and this view is served to the browser.
    ollama: { enabled: config.ollama.enabled, baseUrl: redactUrl(config.ollama.baseUrl) },
    llamaCpp: {
      enabled: config.llamaCpp.enabled,
      baseUrl: redactUrl(config.llamaCpp.baseUrl),
      runtime: config.llamaCpp.runtime,
      keyConfigured: Boolean(config.llamaCpp.apiKey),
    },
    plugins: {
      signaturesRequired: config.plugins.requireSignature,
      // The path is reported; the keys are not. A caller that needs them reads them here.
      trustStoreFile: config.plugins.trustStoreFile,
      trustStoreConfigured: Boolean(config.plugins.trustStoreFile),
    },
    mcp: {
      allowlist: [...config.mcp.allowlist],
      restricted: config.mcp.allowlist.length > 0,
    },
    fabric: { ...config.fabric, baseUrl: redactUrl(config.fabric.baseUrl) },
    onlineAllowlist: config.onlineAllowlist,
    localAllowlist: config.localAllowlist,
    media: config.media,
    knowledge: { ...config.knowledge, dbFile: undefined },
    godMode: config.godMode,
    browserKeyExposure: false,
    warnings: config.warnings,
  }
}

/**
 * Reduce a URL to `protocol://host/path` for display.
 *
 * The query string is dropped — that is where a token ends up — and a bare host is
 * reported without an added `/`, so a published value still matches the configured
 * one character for character.
 */
export function redactUrl(value) {
  if (!value) return null
  try {
    const url = new URL(value)
    const path = url.pathname === '/' ? '' : url.pathname
    return `${url.protocol}//${url.host}${path}`
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
