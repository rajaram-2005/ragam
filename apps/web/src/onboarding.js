const SETUP_GUIDE_KEY = 'ragam.setup-guide.dismissed.v1'

function browserStorage() {
  try { return globalThis.localStorage ?? null } catch { return null }
}

/** A dismissible, non-sensitive UI preference stored only in this browser. */
export function setupGuideDismissed(storage = browserStorage()) {
  if (!storage) return false
  try { return storage.getItem(SETUP_GUIDE_KEY) === 'true' } catch { return false }
}

/** Persistence is best-effort; the current page still responds if storage is blocked. */
export function setSetupGuideDismissed(dismissed, storage = browserStorage()) {
  if (!storage) return false
  try {
    if (dismissed) storage.setItem(SETUP_GUIDE_KEY, 'true')
    else storage.removeItem(SETUP_GUIDE_KEY)
    return true
  } catch { return false }
}
