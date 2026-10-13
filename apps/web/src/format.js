// Pure formatting helpers shared by the UI.
//
// These live in a plain .js module rather than in ui.jsx for one practical reason:
// Node cannot import JSX, and these two functions carry real display logic that is
// worth testing (a status rendered with the wrong tone is a lie about the system's
// state). Keeping them here means the test suite can exercise them directly.

/**
 * Map a status string reported by the backend onto a display tone.
 *
 * The tone is derived from the server's own vocabulary, never from a guess: an
 * unrecognised status returns undefined so the chip renders neutral rather than
 * green-by-default.
 */
export function toneFor(status) {
  const value = String(status ?? '').toLowerCase()
  if (
    ['ready', 'ok', 'enabled', 'succeeded', 'passed', 'released', 'accepted', 'online', 'verified', 'complete'].includes(value)
  ) {
    return 'ok'
  }
  if (
    [
      'degraded', 'warn', 'partial', 'awaiting_approval', 'paused', 'unverified',
      'simulated', 'needs_hardware', 'limited', 'retrying', 'planned_only',
    ].includes(value)
  ) {
    return 'warn'
  }
  if (
    [
      'failed', 'error', 'blocked', 'cancelled', 'timed_out', 'rejected', 'offline',
      'unreachable', 'disabled', 'denied', 'budget_exceeded', 'uninstalled',
    ].includes(value)
  ) {
    return 'bad'
  }
  if (['running', 'pending', 'queued', 'probing', 'installed'].includes(value)) return 'info'
  return undefined
}

/** Render any backend value as a short, honest string. */
export function formatValue(value) {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(4)
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.join(', ')
  return JSON.stringify(value)
}

/** Truncate for table cells without hiding that truncation happened. */
export function clip(value, limit = 60) {
  if (value === null || value === undefined) return '—'
  const text = String(value)
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Short id prefix, for labelling jobs and tasks in a list. */
export function shortId(id, length = 8) {
  return String(id ?? '').slice(0, length)
}
