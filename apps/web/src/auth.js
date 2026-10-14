// The sign-in surface.
//
// Three pages, and they are pages rather than a dialog or a card inside the app: a
// person who is signed out sees a sign-in page at its own address, can link to it, can
// bookmark it, and can be told "go to #/signup" by whoever runs the installation.
//
// They are addressed by hash for the same reason the five product areas are — the app is
// served as one document behind a proxy, and a hash needs no server rewrite rule to
// resolve. There is no client-side router and no route table: `App.jsx` reads the hash
// and picks a page, which keeps "exactly five product areas" a property of the code
// rather than of a routing configuration somebody can extend.
//
// Kept in a plain .js module, like areas.js, so the structural tests can import it:
// Node cannot parse JSX, and the shape of the sign-in surface is worth testing.

/** The pages a signed-out person can be on. Order is the order the links are shown in. */
export const AUTH_PAGES = Object.freeze([
  { id: 'signin', hash: '#/signin', label: 'Sign in', title: 'Sign in' },
  { id: 'signup', hash: '#/signup', label: 'Create account', title: 'Create your account' },
  { id: 'forgot-password', hash: '#/forgot-password', label: 'Reset password', title: 'Reset your password' },
].map((page) => Object.freeze(page)))

export const AUTH_PAGE_IDS = Object.freeze(AUTH_PAGES.map((page) => page.id))

export const DEFAULT_AUTH_PAGE = 'signin'

/** Which sign-in page a hash asks for. Anything unrecognised is the sign-in page. */
export function authPageFromHash(hash = '') {
  return AUTH_PAGES.find((page) => page.hash === hash)?.id ?? DEFAULT_AUTH_PAGE
}

/**
 * Whether a hash addresses a sign-in page at all.
 *
 * This is not the same question as `authPageFromHash`, which always answers something:
 * a signed-in person who follows a bookmarked `#/signup` link should be sent to the
 * workspace, and deciding that needs to know the hash named a sign-in page rather than
 * merely defaulting to one.
 */
export function isAuthHash(hash = '') {
  return AUTH_PAGES.some((page) => page.hash === hash)
}

/**
 * The password rules, stated before somebody types, in the words the server uses.
 *
 * The server is the authority: `passwordProblems()` in
 * services/core/src/online/accounts.mjs decides, and a test in apps/web/test checks
 * that the minimum length stated here is the minimum length enforced there. This list
 * exists so the rules are not discovered by submitting a form and reading an error.
 */
export const PASSWORD_MIN_LENGTH = 12

export const PASSWORD_RULES = Object.freeze([
  `At least ${PASSWORD_MIN_LENGTH} characters — length is what makes a password strong.`,
  'Not a common password, and not one repeated character.',
  'Not your email address, or the name part of it.',
])
