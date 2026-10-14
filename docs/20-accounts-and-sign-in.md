# Accounts and traditional sign-in

Date: 2026-10-14. This supersedes the operator-token sign-in described in
[docs/19](19-online-only-phase-2.md) and is the current account model for the online
product.

## What changed, and why

Sign-in used to be one non-traditional method: read `access-token` from the Core host's
online data directory and paste it into a form. That is a good secret for a machine and
a poor one for a person. It cannot be chosen or remembered, it cannot be rotated by the
person using it, it is shared by everybody who has host access, and recovering it means
reading a file on a server.

It is **removed**, not supplemented. There is one way in now, and a second way in would
be a second thing to phish and a second thing to rotate.

| Removed | Added |
|---|---|
| `.aetheris-data/online/access-token` (file, mode 0600) | `accounts.sqlite` with scrypt password hashes (file, mode 0600) |
| `POST /api/auth/login` with `{ token }` | `POST /api/auth/login` with `{ email, password }` |
| `GET /api/auth` reporting `mode: 'single_operator'` | `GET /api/auth` reporting `mode: 'accounts'` and the signed-in account |
| one login card inside the app | three sign-in pages, each with its own address and component |
| one shared history/memory/knowledge store | one store per account |
| every audit row attributed to `owner` | every audit row attributed to an account id |

## The three pages

Addressed by hash, like the five product areas. There is no client-side router and no
route table to extend: `App.jsx` reads the hash and renders either one area (signed in)
or one sign-in page (signed out).

| Page | Address | Component | What it does |
|---|---|---|---|
| Sign in | `#/signin` | `apps/web/src/pages/SignInPage.jsx` | Email address and password. Links to the other two pages. |
| Create account | `#/signup` | `apps/web/src/pages/SignUpPage.jsx` | Open registration, states the password rules, confirms the password client-side, signs you in on success. |
| Reset password | `#/forgot-password` | `apps/web/src/pages/ForgotPasswordPage.jsx` | Two steps: request a single-use code, then set a new password with it. |

The shared frame is `pages/AuthLayout.jsx`; the signed-in identity, password change and
sign-out live in `components/AccountCard.jsx`, inside the existing sidebar. The product
still has exactly five areas, and an account menu is not a sixth one — a structural test
counts the navigation entries and fails if one appears.

## Account model

**Sign-up is open.** Anybody who can reach the installation can create an account on it.
That is a deliberate choice with two consequences, both stated on the sign-up page
rather than left to be discovered:

- **The first account created is the owner.** The role is decided by the store, never by
  the request body — a registration that could ask for `owner` would let the second
  person to arrive take the installation from the first. Only the owner can change the
  gateway connection or its key (`PUT`/`DELETE /api/providers/litellm`,
  `POST /api/providers/litellm/test`, `POST /api/models/probe`); a member who tries gets
  `403 owner_required`, and Provider Settings says so instead of offering inert controls.
- **Every account chats through the one configured gateway**, so whoever configured it is
  paying for all of them. `AETHERIS_MAX_ACCOUNTS` (default 64) bounds how many accounts
  an open sign-up page can create.

Shared by the installation, on purpose: the gateway connection and its encrypted key
(members can use it, cannot read it, cannot change it), the listed models and the default
model selection, the two-concurrent-request inference cap, and the audit ledger. Personal
to each account: history, memory and file knowledge.

## Passwords

| Property | Value |
|---|---|
| Hash | scrypt, N=16384, r=8, p=1, 64-byte derived key |
| Salt | 16 random bytes per password |
| Stored form | `scrypt$N$r$p$salt$hash` in `accounts.sqlite` |
| Comparison | `timingSafeEqual` |
| Reversible copy | none — there is no encrypted-password column, because a key that can decrypt a password can also recover it |
| Minimum length | 12 characters |
| Maximum length | 256 characters |
| Also refused | a short common-password denylist, one repeated character, the account's own email address or the name part of it |

The policy is length-and-denylist rather than character-class rules: length carries the
entropy, and forced symbols mostly produce `Password1!`. Containment of the email's name
part is deliberately **not** a rule — it refuses `dandelion-crusher` for somebody whose
address starts `dan@`, which teaches people the checker is arbitrary.

The server is the authority. The client states the same minimum, and a test reads both
files and fails if they disagree, because a form that asks for one rule and a server that
enforces another is a support queue.

### Guessing, lockout and enumeration

- Eight consecutive failures lock **that account** for fifteen minutes. The counter is per
  account, so one person's typo storm cannot lock everybody out.
- The public auth endpoints are throttled per address (12/minute) and per installation
  (60/minute). Both are in-memory windows; the durable half is the account lockout.
- An unknown address and a wrong password return the same code, status and message, and
  an unknown address still pays for one scrypt pass against a dummy hash, so the two are
  not separable by timing either.
- A duplicate registration returns `409 email_taken`. That is the one answer that may
  differ, and it is defensible: the person asking is being told about an address they
  would have had to hold the password for anyway.
- `POST /api/auth/password-reset/request` answers `202` with an identical message whether
  or not the address exists, and never returns a code.

## Sessions

| Property | Value |
|---|---|
| Cookie | `aetheris_session`, `HttpOnly`, `SameSite=Strict`, `Path=/api`, `Secure` unless `AETHERIS_COOKIE_SECURE=false` |
| Lifetime | 8 hours |
| Storage | in process memory; every session ends when Core restarts |
| Per account | 8, oldest rolled off rather than refusing a new sign-in |
| Per installation | 64, hard stop (`429 session_limit`) |
| On password reset | every session for that account is revoked |
| On password change | every other session for that account is revoked; the one that proved the current password survives |

## Password reset without an email service

This product has no mail transport, so it cannot email a reset link, and a page that
claimed otherwise would not be describing this product. What happens instead:

1. The reset page asks for the address. Core generates a 24-byte single-use code, stores
   its **hash** in `accounts.sqlite`, and writes the code to `password-resets.json`
   (mode 0600) in the online data directory. One pending code per account: requesting
   again replaces the previous one, so stale codes cannot be replayed later.
2. Whoever operates the Core host reads the code from that file, or from the console if
   Core was started with `AETHERIS_PRINT_RESET_CODES=true`.
3. The reset page takes the address, the code and a new password. The code is verified,
   consumed, deleted from the file, the password is set, and every session for the
   account is revoked. Codes expire fifteen minutes after they are requested.

**The honest boundary.** Whoever can read the online data directory can reset any
password on this installation. They could already read `master.key` there and decrypt the
provider credential, so this widens no boundary the installation did not already have —
but it is stated here rather than left to be found at 2 a.m. This is not a control
against a compromised host. If that threat matters, run one account per installation,
keep the data directory on encrypted storage with restricted access, and put the service
behind a network boundary you control.

## Data isolation

Each account gets its own SQLite files inside the online data directory:
`memory-<account-id>.sqlite` (sessions, turns, memories, candidates, deletions) and
`knowledge-<account-id>.sqlite` (documents, chunks, ACL rows). Isolation comes from
separate databases rather than from a `WHERE` clause, so a query that forgot to filter
could not leak another person's turns. `readBody()` overwrites any caller-supplied
`principal` with the session's account id, so tenancy is never a request field.

A single-operator installation that upgrades keeps its data: when the **first** account is
created, `memory.sqlite` and `knowledge.sqlite` — with their WAL and shared-memory
sidecars — are renamed to that account's files. Adoption happens once, for the owner; it
moves the files rather than copying them, so there is no second copy of somebody's
history to forget about. Later accounts start empty.

## Routes

| Method and path | Who | Purpose |
|---|---|---|
| `GET /api/auth` | public | `{ authenticated, mode: 'accounts', account }` — no more than that |
| `POST /api/auth/register` | public | Create an account; first one is the owner; signs the caller in (`201`) |
| `POST /api/auth/login` | public | Email address and password (`200`) |
| `POST /api/auth/password-reset/request` | public | Ask for a host-delivered code (`202`, identical answer either way) |
| `POST /api/auth/password-reset/confirm` | public | Set a new password with a code; revokes that account's sessions |
| `POST /api/auth/logout` | signed in | End this session, clear the cookie |
| `POST /api/auth/password` | signed in | Change own password; requires the current one |
| `PUT`/`DELETE /api/providers/litellm`, `POST …/test`, `POST /api/models/probe` | owner | Gateway connection and key |
| everything else under `/api` | signed in | Chat, models, history, memory, knowledge, reviewed tools |

Mutations still require the same-origin check and the non-simple `x-aetheris-request`
header; nothing about CSRF handling changed.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AETHERIS_MAX_ACCOUNTS` | `64` | Hard cap on accounts an open sign-up page can create |
| `AETHERIS_PRINT_RESET_CODES` | `false` | Also print a password-reset code on the Core console |
| `AETHERIS_COOKIE_SECURE` | `true` | Unchanged; `false` only for deliberate HTTP local development |
| `AETHERIS_ONLINE_DATA_DIR` | `.aetheris-data/online` | Unchanged; now also holds `accounts.sqlite` and `password-resets.json` |

## Not delivered

Email delivery of reset codes, email verification, second factors (TOTP, WebAuthn),
passwordless or third-party identity, self-service account deletion, a role-management or
account-list UI, invited-only registration, per-account rate limits or quotas on
inference, and per-account provider connections. There is still one gateway per
installation and one default model, shared by everybody signed in.

Universal provider support is **not** delivered by this change, and neither are the online
Image/Video adapters: `POST /api/image/generate` and `POST /api/video/generate` still
return `capability_unavailable` rather than substituting output.

## Verification

- Core: **16 new tests** in `services/core/test/accounts.test.mjs` — scrypt storage and
  the absence of a reversible copy, the password policy and its messages, roles and the
  refusal of a caller-chosen role, the removal of the token file and token route,
  enumeration resistance, lockout scope, throttling, the account cap, cookie attributes
  and session bounds, owner-only gateway control with attributable audit rows, per-account
  isolation of history/memory/knowledge, legacy-store adoption, the whole reset lifecycle
  including replay and session revocation, and password change.
- `services/core/test/online.test.mjs` now signs in with an account; its 19 tests pass
  unchanged in intent, including the assertion that a cancelled request never reaches the
  gateway.
- Web: **13 new tests** across `api.test.mjs`, `render.test.mjs` and `structure.test.mjs` —
  the three pages render with named fields and the right `autoComplete` values; both steps
  of the reset page render, which needed each step exported on its own because the second
  is only reachable after a state change; the change-password dialog asks for the current
  password and warns that the account's other sessions will end; the reset page never
  claims an email was sent; the sidebar shows the account without adding a navigation
  entry; Provider Settings is read-only for a member; neither form that sets a password can
  submit a pair that does not match; and no browser-facing source offers the removed token
  sign-in or any third-party method.
- Client and router are checked against each other rather than against a written-down list.
  `api.test.mjs` derives every endpoint the signed-in UI calls from the UI sources
  themselves and asserts the router that actually runs — `src/online/app.mjs` and
  `src/online/context-routes.mjs`, not the legacy table — serves each one; and it records
  the seven account calls to assert every request body carries exactly the fields the
  router reads, so a renamed field fails here instead of surfacing as a 400 that reads like
  a user's typo. One endpoint is a stated exception: `/api/media/artifact/:id`, unreachable
  because every online media list answers `{ jobs: [] }`. The test asserts that emptiness,
  so the exception stops being valid the moment the route becomes real.
- Live HTTP check through the Vite proxy against a running Core: anonymous status, owner
  registration, weak-password rejection, the old `{ token }` body refused, member
  registration, `403 owner_required` on a member gateway change, reset request for a known
  and an unknown address (identical answers), the code on the host and on the console,
  reset confirmation, revocation of the pre-reset session, code replay refused, and
  password change.
- Production build succeeds (`npm run web:build`).

Not verified here: real email delivery (none exists), real provider inference (this
sandbox has no reachable authorized gateway), and real-browser interaction — the page
tests are server-rendered markup assertions, as everywhere else in this repository.
