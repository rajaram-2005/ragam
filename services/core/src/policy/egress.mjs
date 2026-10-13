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

/**
 * Sentinel meaning "any external host".
 *
 * It exists because the three-policy model could not express "fully online".
 * ``online_enabled`` relaxes the *data* gate — ``#mayGoExternal`` returns true
 * unconditionally — but the egress guard still consulted the allowlist, so with
 * an empty allowlist ``online_enabled`` blocked every external host and was
 * indistinguishable from ``strict_offline`` at the point of enforcement. A policy
 * named "online enabled" that cannot reach anything online is a name that promises
 * more than the control delivers, so the capability is stated explicitly instead.
 *
 * It is a single exact entry, not a glob: an allowlist of ``['*.example.com']``
 * still matches nothing, so the subdomain-spoofing property of the exact-match
 * allowlist is preserved.
 *
 * It is never honoured under ``strict_offline``. That check runs first and returns
 * before this one, so offline mode stays absolute.
 */
export const ALLOW_ALL_HOSTS = '*'

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

class PolicyDeniedError extends Error {
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

  // Resolved once so the ordering below can rely on it being a fixed property of
  // this guard rather than something re-evaluated per request.
  //
  // The policy is folded in on purpose. The field answers "does this guard permit
  // every external host?", and under strict_offline the honest answer is no even if
  // '*' is sitting in the allowlist being ignored. Reporting true there would tell
  // an operator that egress is wide open at the exact moment it is fully closed.
  const allowAllExternal =
    onlineAllowlist.has(ALLOW_ALL_HOSTS) && policy !== RUNTIME_POLICIES.STRICT_OFFLINE

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
    // Order matters and is load-bearing: strict_offline is absolute, so it is
    // checked before allow-all. Reversing these two lines would let '*' silently
    // disable offline mode, which is the one guarantee the guard exists to keep.
    if (policy === RUNTIME_POLICIES.STRICT_OFFLINE) {
      return { allowed: false, scope, reason: 'strict_offline forbids all external requests', ...target }
    }
    if (allowAllExternal) {
      return { allowed: true, scope, allowAll: true, ...target }
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
    /**
     * True when every external host is permitted. Exposed so an operator can see
     * that the guard is wide open rather than having to infer it from a config file.
     * Always false under strict_offline, where '*' is ignored.
     */
    get allowAllExternal() {
      return allowAllExternal
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
 * Severity order for the data classes. Exported because "which of these two is more
 * sensitive" is asked in more than one place, and two copies of the ordering would
 * eventually disagree.
 */
export const DATA_CLASS_RANK = Object.freeze({
  [DATA_CLASSES.PUBLIC]: 0,
  [DATA_CLASSES.INTERNAL]: 1,
  [DATA_CLASSES.CONFIDENTIAL]: 2,
  [DATA_CLASSES.RESTRICTED]: 3,
})

/** An unknown class is treated as the most sensitive, never as the least. */
export const dataClassRank = (dataClass) => DATA_CLASS_RANK[dataClass] ?? DATA_CLASS_RANK[DATA_CLASSES.RESTRICTED]

/**
 * The more sensitive of two classes.
 *
 * This exists for one specific reason: text that is *added to* a request must be able to
 * raise its classification. A memory injected into a prompt, or a retrieved document
 * spliced into it, is part of what would be sent -- so a public question plus a
 * confidential memory is a confidential request. Without this, memory injection would be
 * an exfiltration channel with a friendly name.
 */
export function mostSensitiveDataClass(...classes) {
  let worst = DATA_CLASSES.PUBLIC
  for (const candidate of classes) {
    if (!candidate) continue
    if (dataClassRank(candidate) > dataClassRank(worst)) worst = candidate
  }
  return worst
}

/**
 * Hybrid mode additionally gates *what* may be sent, not just *where*.
 * Company-private material defaults to local processing.
 */
export function createDataPolicy(options = {}) {
  // Anything at or above this class requires explicit per-request authorisation
  // before it may be sent to an external provider.
  const externalCeiling = options.externalCeiling || DATA_CLASSES.INTERNAL

  function authorizeExternalSend(dataClass, authorization = {}) {
    // One ranking, one function: an unknown class ranks as restricted, and the ceiling is
    // compared with the same ranking rather than a second copy of it.
    if (dataClassRank(dataClass) <= dataClassRank(externalCeiling)) {
      return { allowed: true, dataClass, reason: 'within external ceiling' }
    }
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
