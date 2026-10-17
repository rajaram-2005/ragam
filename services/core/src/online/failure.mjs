// The one error shape the online entry throws.
//
// It lives in its own module so the wire adapters can raise a coded failure without importing the
// transport (which imports them). A cycle here would be invisible until one of the modules was
// loaded first in a way a test happened to exercise, which is the worst kind of import bug.

export function failure(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status })
}
