// Runtime policy + network egress enforcement.
//
// This is the single choke point for every outbound request Aetheris Omni makes.
// The directive requires that strict-offline mode *prevents* unauthorised external
// network access rather than merely hiding controls in the UI, so the guard is
// installed over globalThis.fetch: code that forgets to route through the guard is
// still blocked.
//
// Enforcement is server-side. A browser toggle can never weaken it.

export const RUNTIME_POLICIES = Object.freeze({
  STRICT_OFFLINE: 'strict_offline',
  HYBRID: 'hybrid',
  ONLINE_ENABLED: 'online_enabled',
})

// Data classification drives whether content may leave the machine in hybrid mode.
export const DATA_CLASSES = Object.freeze({
  PUBLIC: 'public',
  INTERNAL: 'internal',
  CONFIDENTIAL: 'confidential',
  RESTRICTED: 'restricted',
})

// Hosts that count as "local" and are therefore reachable in strict_offline.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

export class EgressBlockedError extends Error {
  constructor(url, reason, policy) {
    super(`egress blocked (${policy}): ${reason} — ${url}`)
    this.name = 'EgressBlockedError'
    this.code = 'EGRESS_BLOCKED'
    this.url = String(url)
    this.reason = reason
    this.policy = policy
  }
}

export class PolicyDeniedError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'PolicyDeniedError'
    this.code = 'POLICY_DENIED'
    Object.assign(this, details)
  }
}

function isLocalHost(hostname) {
  if (!hostname) return false
  const bare = hostname.replace(/^\[|\]$/g, '')
  if (LOOPBACK_HOSTS.has(bare) || LOOPBACK_HOSTS.has(hostname)) return true
  // RFC1918 / link-local literals. Named non-loopback hosts are NOT implicitly
  // local: an internal hostname still needs an explicit allowlist entry.
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(bare)
}

/**
 * @param {object} options
 * @param {string} options.policy            one of RUNTIME_POLICIES
 * @param {string[]} [options.localAllowlist] extra hosts treated as local (e.g. an Ollama box on the LAN)
 * @param {string[]} [options.onlineAllowlist] external hosts permitted in hybrid/online modes
 * @param {(event:object)=>void} [options.onDecision] audit hook
 */
export function createEgressGuard(options = {}) {
  const policy = options.policy || RUNTIME_POLICIES.STRICT_OFFLINE
  const localAllowlist = new Set(options.localAllowlist || [])
  const onlineAllowlist = new Set(options.onlineAllowlist || [])
  const onDecision = options.onDecision || (() => {})
  const realFetch = options.fetch || globalThis.fetch

  if (!Object.values(RUNTIME_POLICIES).includes(policy)) {
    throw new TypeError(`unknown runtime policy: ${policy}`)
  }

  function describe(url) {
    const parsed = new URL(url)
    return { host: parsed.host, hostname: parsed.hostname, protocol: parsed.protocol, origin: parsed.origin }
  }

  /** Classify a target URL and decide whether the current policy permits it. */
  function inspect(url) {
    let target
    try {
      target = describe(url)
    } catch {
      return { allowed: false, reason: 'unparseable url', scope: 'unknown' }
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return { allowed: false, reason: `protocol ${target.protocol} is not permitted`, scope: 'unknown', ...target }
    }
    const local = isLocalHost(target.hostname) || localAllowlist.has(target.hostname) || localAllowlist.has(target.host)
    const scope = local ? 'local' : 'external'
    if (local) return { allowed: true, scope, ...target }
    if (policy === RUNTIME_POLICIES.STRICT_OFFLINE) {
      return { allowed: false, scope, reason: 'strict_offline forbids all external requests', ...target }
    }
    if (onlineAllowlist.has(target.hostname) || onlineAllowlist.has(target.host)) {
      return { allowed: true, scope, allowlisted: true, ...target }
    }
    return { allowed: false, scope, reason: `host not on the online allowlist for policy ${policy}`, ...target }
  }

  async function guardedFetch(url, init = {}) {
    const decision = inspect(typeof url === 'string' ? url : url?.url ?? String(url))
    onDecision({ type: 'egress', allowed: decision.allowed, ...decision, at: Date.now() })
    if (!decision.allowed) throw new EgressBlockedError(decision.href || url, decision.reason, policy)
    return realFetch(url, init)
  }

  return {
    policy,
    inspect,
    fetch: guardedFetch,
    /** Throws unless the URL is reachable under the current policy. */
    assertReachable(url) {
      const decision = inspect(url)
      if (!decision.allowed) throw new EgressBlockedError(url, decision.reason, policy)
      return decision
    },
    /** True when no external request can succeed under this policy. */
    get offlineEnforced() {
      return policy === RUNTIME_POLICIES.STRICT_OFFLINE
    },
    get localAllowlist() {
      return [...localAllowlist]
    },
    get onlineAllowlist() {
      return [...onlineAllowlist]
    },
  }
}

/**
 * Install the guard over globalThis.fetch so that even code paths which call
 * fetch() directly cannot escape the policy. Returns a restore function.
 */
export function installGlobalEgressGuard(guard) {
  const previous = globalThis.fetch
  globalThis.fetch = guard.fetch
  let restored = false
  return function restore() {
    if (restored) return
    restored = true
    globalThis.fetch = previous
  }
}

/**
 * Hybrid mode additionally gates *what* may be sent, not just *where*.
 * Company-private material defaults to local processing.
 */
export function createDataPolicy(options = {}) {
  // Anything at or above this class requires explicit per-request authorisation
  // before it may be sent to an external provider.
  const externalCeiling = options.externalCeiling || DATA_CLASSES.INTERNAL
  const rank = { public: 0, internal: 1, confidential: 2, restricted: 3 }

  function authorizeExternalSend(dataClass, authorization = {}) {
    const level = rank[dataClass] ?? rank.restricted
    if (level <= rank[externalCeiling]) return { allowed: true, dataClass, reason: 'within external ceiling' }
    if (authorization.explicit === true && authorization.scope === dataClass) {
      return { allowed: true, dataClass, reason: 'explicit authorization granted', authorizedBy: authorization.by ?? null }
    }
    return {
      allowed: false,
      dataClass,
      reason: `data class '${dataClass}' exceeds the external ceiling '${externalCeiling}' and no explicit authorization was supplied`,
    }
  }

  return { externalCeiling, authorizeExternalSend }
}
