// One implementation of "run this work, but not for longer than the caller allowed".
//
// It existed twice, in `mcp/layer.mjs` and `plugins/registry.mjs`, with the same race and the
// same timer handling and different error classes. Two copies of a timeout are two places for a
// cancellation to be lost, and a lost cancellation is the kind of bug that only shows up under
// load — so the mechanism lives here and each caller supplies its own error, because the *type*
// of the failure is part of each caller's contract and the *mechanism* is not.
//
// The work is a thunk rather than a promise on purpose: a promise that is already running cannot
// be cancelled, and a thunk makes it obvious at the call site that the timeout starts here.

/**
 * @param {() => any} work            invoked immediately, inside the race
 * @param {object} options
 * @param {number} options.timeoutMs
 * @param {string} options.label      what to name in the error, e.g. "server:tool"
 * @param {AbortSignal|null} [options.signal]
 * @param {() => Error} options.onTimeout
 * @param {() => Error} options.onCancelled
 */
export async function withTimeout(work, { timeoutMs, label, signal = null, onTimeout, onCancelled }) {
  if (typeof work !== 'function') throw new TypeError(`${label} must be given a function to run`)
  if (typeof onTimeout !== 'function') throw new TypeError(`${label} must be given an onTimeout error factory`)
  if (typeof onCancelled !== 'function') throw new TypeError(`${label} must be given an onCancelled error factory`)

  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeoutMs)
      }),
      new Promise((_, reject) => {
        if (!signal) return
        if (signal.aborted) return reject(onCancelled())
        // `{ once: true }` because a signal outlives one call: a listener left behind would fire
        // on a later abort and reject a promise nobody is waiting for.
        signal.addEventListener('abort', () => reject(onCancelled()), { once: true })
      }),
    ])
  } finally {
    // Cleared on every path, including the failure one: a timer that is left to fire later keeps
    // the process alive and, in a test runner, prints a warning after the test has ended.
    clearTimeout(timer)
  }
}
