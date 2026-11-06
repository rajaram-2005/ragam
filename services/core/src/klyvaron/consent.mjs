// Shared freshness rules for explicit, user-authorized training consent.
//
// A consent record is bound to a preflight disclosure digest by its caller. The
// timestamp is the other half: without it, a captured consent could be replayed
// indefinitely, and a far-future timestamp would never expire. Both the optional
// training worker and the retained training controller use these same bounds.

export const CONSENT_EXPIRY_MS = 30 * 60 * 1000
export const CONSENT_CLOCK_SKEW_MS = 60_000

export function consentFreshness(consent, {
  now = Date.now(),
  maxAgeMs = CONSENT_EXPIRY_MS,
  clockSkewMs = CONSENT_CLOCK_SKEW_MS,
} = {}) {
  if (!consent || typeof consent.createdAt !== 'number' || !Number.isFinite(consent.createdAt)) {
    return { valid: false, ageMs: null, reason: 'missing_timestamp' }
  }
  const ageMs = now - consent.createdAt
  if (ageMs > maxAgeMs) return { valid: false, ageMs, reason: 'expired' }
  if (ageMs < -clockSkewMs) return { valid: false, ageMs, reason: 'future_dated' }
  return { valid: true, ageMs, reason: null }
}
