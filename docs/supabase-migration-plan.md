# Supabase migration plan (not yet deployed)

## Chosen target

The proposed cloud architecture is Vercel Node.js Functions for request execution, Supabase Postgres for durable structured state, and a private Supabase Storage bucket for file artifacts. This is a substantial backend migration, not a `CORE_API_URL` change. Supabase does not run the existing long-lived Node server by itself.

The Supabase project `ragam-core` is `ACTIVE_HEALTHY` in `eu-west-2` (London); the user confirmed its dashboard plan is Free and chose to keep this region. Its database is healthy and has no migrations recorded yet. The existing inactive projects were left untouched. A server-only REST transport module (`services/core/src/storage/supabase-admin.mjs`) has been added with fixed-origin, path/header allowlists, bounded requests, and sanitized errors; its four tests use mocks only. No live database/storage request has been made, no schema has been applied, no Core data has been exported or migrated, and no Vercel configuration has been changed. The connector does not independently report billing plan or quota; no production readiness is claimed.

## Current implementation that must change

The Core service currently starts a long-lived `node:http` server and uses synchronous `node:sqlite` stores. Persistent state spans accounts and password resets, provider configuration, audit events, memories and sessions, knowledge documents/chunks/embeddings, skills/styles, Klyvaron configuration, and durable job metadata. Media and other artifacts also use local filesystem paths. Authentication sessions are currently process-local memory.

### Repository storage inventory (migration work starts here)

| Existing state | Current implementation | Hosted replacement / gate |
|---|---|---|
| Accounts and password resets | `online/accounts.mjs`: SQLite accounts; reset-code delivery is file-backed and operator-local | Postgres account/reset records; keep password hashes (never plaintext); choose a reset-delivery method before enabling reset on hosted deployment |
| Sessions and sign-in throttles | `OnlineApp` keeps sessions and auth-attempt counters in process-local `Map`s | Persist only a hash of opaque session tokens; use shared, atomic throttling; verify revocation across independent function invocations |
| Provider connections and presets | `online/store.mjs`: one installation-level JSON file; credentials are AES-GCM encrypted with a local `master.key` | Postgres records with app-side encryption key held as a server secret; preserve the installation-wide/owner semantics and never return ciphertext or plaintext to the browser |
| Audit ledger | `audit/ledger.mjs`: append-only SQLite events | Postgres append-only table; preserve redaction and actor/subject linkage |
| Memory, chat sessions, and turns | `memory/store.mjs`: account-specific SQLite files; `memory/fabric.mjs` adds provenance/tombstones | Account-owned Postgres rows with explicit owner filters and deletion/tombstone semantics |
| Knowledge documents and index | `knowledge/store.mjs`: account-specific SQLite tables for documents, chunks, ACL, embeddings, index runs, and deletion records | Account-owned Postgres rows; decide whether embeddings are stored as vectors or serialized data only after checking actual retrieval usage and available extensions |
| Skills and styles | `skills/store.mjs` and `online/styles.mjs`: local files and version/deletion records | Database-backed metadata/content with preserved version history; installation-wide reviewed skills remain distinct from user-owned preferences |
| Media jobs and generated files | Job state and outputs use process/local filesystem storage in current paths | Durable job metadata and private Storage objects; a serverless request must not claim background execution beyond its bounded lifetime |
| Klyvaron artifacts and training | Model files, qualifications, checkpoints, and worker state are local filesystem/process based | **Not a Vercel Functions migration item.** Keep local training/artifacts local unless a separately approved compatible worker/storage design is provided; do not claim serverless training or move private artifacts to public Storage |

A versioned baseline SQL migration now exists at `supabase/migrations/20261030000100_initial_core.sql`. It creates 28 relational tables, enables RLS with no browser-role policies, and includes account-scoped foreign keys and constraints for personal-memory consent/training prohibition. Its syntax was exercised in an ephemeral PGlite instance, and a repository test checks the table/RLS inventory. `SupabaseAccountRepository` adds a narrow, tested PostgREST layer that always filters reads/writes by account and refuses caller-supplied ownership changes. Neither repository is wired into `OnlineApp` yet, and the schema has NOT been applied to the hosted project. The baseline is a starting schema, not application parity: transactional RPCs, account/session integration, remaining repositories, private Storage, and serverless route conversion remain before a live schema change.

A correct hosted migration therefore needs all of the following before the Vercel proxy can be replaced:

1. An asynchronous Postgres data layer and explicit, versioned SQL migrations for every active store.
2. A private Storage bucket for media/artifacts, with ownership checks in Core and no public object access by default.
3. Application-side encryption for provider credentials, with the encryption key held only as a server-side Vercel secret. Never expose a service-role key or encryption key to browser code.
4. Persistent, revocable session records (store a hash of opaque session tokens, not raw tokens) and distributed authentication throttles. The existing in-memory session store is not reliable across serverless invocations.
5. A request handler compatible with Vercel's Node function lifecycle, plus bounded request/response handling and authenticated ownership checks on every database and storage operation.
6. Durable job state and an honest design for long-running provider calls. A Vercel function's execution limit is not a background worker; tasks that exceed it must be declined or use a separately approved worker design.
7. Tests using a disposable database and storage bucket, migration/rollback tests, and security tests for row ownership, storage paths, session revocation, and secret redaction.
8. An explicit data-migration decision. This plan does not copy, transform, or delete any existing service data.

The current registration behavior is a release blocker: public registration is open and the first account becomes owner. Do not expose the API to real users until controlled owner bootstrap/registration has been implemented and tested.

## Project setup status

The user-created `ragam-core` project is active and its database is healthy. The connector reports region `eu-west-2` (London); the user confirmed the dashboard shows the **Free** plan and chose to keep this region. The project is empty and has no migrations. The other inactive projects remain untouched. The connector itself does not report the plan, so any billing change must be checked in the dashboard. The region is fixed for this project; an India region would require a separate project.

Keep the database password in the user's password manager. Do not paste it into chat, Git, a browser build variable, or Vercel logs. Share only the project reference when needed for connector operations; never share the database password, service-role key, or provider credentials.

Free project quotas, sleep/pausing behavior, storage limits, and function limits can change. Verify current limits in the dashboard before relying on the project for availability or real user data.

## Implementation sequence

1. Review the active SQLite schemas and data ownership rules; write corresponding Postgres migrations with RLS default-deny policies.
2. Implement and test the Postgres repository layer while keeping the SQLite path available for local development until parity is measured.
3. Implement private Storage access and migrate file references to opaque object keys; add explicit size/type validation and account ownership checks.
4. Replace in-memory sessions and throttles with durable Postgres records.
5. Convert the Node server entrypoint to a Vercel-compatible request handler and update the `/api/*` routing without adding a second public API path.
6. Run the full Core/Web suites plus disposable Supabase integration tests; validate migrations, authorization, deletion, and restart behavior.
7. Only after an explicit data-migration approval, export and migrate any existing user data with integrity checks and a rollback plan.
8. Configure Vercel server-only Supabase settings and test Preview health/auth/storage. Do not set Production variables or route production traffic until security, backup, quota, and end-to-end checks pass.

Until these phases pass, the current frontend remains a frontend only; this document is a plan, not evidence of a working Supabase backend.
