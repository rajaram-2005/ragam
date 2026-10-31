# Supabase migration plan (not yet deployed)

## Chosen target

The proposed cloud architecture is Vercel Node.js Functions for request execution, Supabase Postgres for durable structured state, and a private Supabase Storage bucket for file artifacts. This is a substantial backend migration, not a `CORE_API_URL` change. Supabase does not run the existing long-lived Node server by itself.

The Supabase project `ragam-core` is `ACTIVE_HEALTHY` in `eu-west-2` (London); the user confirmed its dashboard plan is Free and chose to keep this region. Its database is healthy and has no migrations recorded yet. The existing inactive projects were left untouched. A server-only REST transport module (`services/core/src/storage/supabase-admin.mjs`) has been added with fixed-origin, path/header allowlists, bounded requests, and sanitized errors; its four tests use mocks only. No live database/storage request has been made, no schema has been applied, no Core data has been exported or migrated, and no Vercel configuration has been changed. The connector does not independently report billing plan or quota; no production readiness is claimed.

## Current implementation that must change

The Core service currently starts a long-lived `node:http` server and uses synchronous `node:sqlite` stores. Persistent state spans accounts and password resets, provider configuration, audit events, memories and sessions, knowledge documents/chunks/embeddings, skills/styles, Klyvaron configuration, and durable job metadata. Media and other artifacts also use local filesystem paths. Authentication sessions are currently process-local memory.

### Repository storage inventory (migration work starts here)

| Existing state | Current implementation | Hosted replacement / gate |
|---|---|---|
| Accounts and password resets | Default `online/accounts.mjs` remains SQLite/file-backed; an injectable `SupabaseAccountStore` now uses Postgres rows and atomic auth RPCs | Wire only after the Vercel handler and controlled owner bootstrap; choose a reset-delivery method before enabling hosted reset |
| Sessions and sign-in throttles | Default `OnlineApp` remains process-local; injectable Supabase stores now persist token hashes and use shared hashed rate-limit buckets | Wire the stores at the serverless entrypoint and verify revocation/throttling across independent invocations |
| Provider connections and presets | `online/store.mjs`: one installation-level JSON file; credentials are AES-GCM encrypted with a local `master.key` | Postgres records with app-side encryption key held as a server secret; preserve the installation-wide/owner semantics and never return ciphertext or plaintext to the browser |
| Audit ledger | `audit/ledger.mjs`: append-only SQLite events | Postgres append-only table; preserve redaction and actor/subject linkage |
| Memory, chat sessions, and turns | `memory/store.mjs`: account-specific SQLite files; `memory/fabric.mjs` adds provenance/tombstones. `storage/supabase-memory-store.mjs` now implements the account-filtered async memory/session contract; BM25 is rebuilt from approved rows, while deduplication, candidate approval, supersede/delete, and turn append use account-serialized Postgres RPCs. `OnlineApp` can inject this through its async context factory, but defaults to SQLite | Wire it only after the Vercel handler is ready, then run cross-invocation tests and explicit export/deletion checks against disposable Supabase; Fabric entries/provenance/tombstones still need their own repository |
| Knowledge documents and index | `knowledge/store.mjs`: account-specific SQLite tables for documents, chunks, ACL, embeddings, index runs, and deletion records. `OnlineApp` context routes now await knowledge operations from the injectable async context factory; the default still constructs local SQLite | Implement an account-owned Postgres repository and rebuildable, deletion-safe retrieval index; decide embedding storage only after checking actual retrieval usage and available extensions |
| Skills and styles | `skills/store.mjs` and `online/styles.mjs`: local files and version/deletion records; an account-filtered `SupabaseStyleStore` now validates and persists response-style preferences, and `OnlineApp` accepts an injected async-compatible style store | The app still defaults to its local file store; startup does not construct the Supabase adapter. Skills remain local. Database-backed skill metadata/content must preserve version history, and installation-wide reviewed skills remain distinct from user-owned preferences |
| Media jobs and generated files | Job state and outputs use process/local filesystem storage in current paths | Durable job metadata and private Storage objects; a serverless request must not claim background execution beyond its bounded lifetime |
| Klyvaron artifacts and training | Model files, qualifications, checkpoints, and worker state are local filesystem/process based | **Not a Vercel Functions migration item.** Keep local training/artifacts local unless a separately approved compatible worker/storage design is provided; do not claim serverless training or move private artifacts to public Storage |

A versioned baseline SQL migration exists at `supabase/migrations/20261030000100_initial_core.sql`. It creates 28 relational tables, enables RLS with no browser-role policies, and includes account-scoped foreign keys and constraints for personal-memory consent/training prohibition. Its syntax was exercised in an ephemeral PGlite instance, and a repository test checks the table/RLS inventory. `SupabaseAccountRepository` adds a narrow, tested PostgREST layer that always filters reads/writes by account and refuses caller-supplied ownership changes.

Authentication persistence is partially implemented. The baseline migration includes service-role-only atomic account registration, password lockout/update/reset, shared rate-limit, and session create/revoke RPCs. `SupabaseAccountStore` preserves the scrypt password policy, stores only password/reset hashes, delegates concurrent account/lockout/reset operations to SQL, and supports distributed address/installation throttling. `SupabaseSessionStore` persists only hashes of opaque cookies. `OnlineApp` accepts injected async account/session stores and awaits their auth operations. The second staged migration adds the transactional memory/session operations used by `SupabaseMemoryStore`. Both migrations were applied together in a disposable PGlite database; remember/dedupe, candidate approval, supersede, append, delete, and full wipe RPC paths were exercised there. This validates SQL syntax and local RPC behavior only; it is not a live Supabase integration. Repository tests cover account filtering, consent invariants, store behavior, service-role grants and the migration inventory.

This is still an injectable foundation, not a deployed integration: `OnlineApp` accepts an async per-account `contextStoreFactory`, and chat/context/media/training call sites await the relevant context and store operations. `SupabaseMemoryStore` and its service-role-only memory RPC migration are implemented and locally tested, but startup does not construct them; Core still defaults to SQLite, and the Vercel Functions request handler is not implemented. `SupabaseStyleStore` is also tested and injectable, while startup still selects the local file store. Reset delivery is intentionally disabled unless an explicit delivery callback is provided. Provider, audit, history, knowledge, skills, styles, and media still use local files/SQLite/process memory by default. Registration remains open to the first owner and is a release blocker for real users. No hosted project has been changed, and neither migration has been applied. This is not application parity; remaining repositories, private Storage, controlled owner bootstrap, and serverless route conversion remain.

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
4. Wire the tested account/session stores into a serverless entrypoint only after controlled owner bootstrap and an explicit reset-delivery method are implemented; keep throttling in the shared Postgres RPCs.
5. Convert the Node server entrypoint to a Vercel-compatible request handler and update the `/api/*` routing without adding a second public API path.
6. Run the full Core/Web suites plus disposable Supabase integration tests; validate migrations, authorization, deletion, and restart behavior.
7. Only after an explicit data-migration approval, export and migrate any existing user data with integrity checks and a rollback plan.
8. Configure Vercel server-only Supabase settings and test Preview health/auth/storage. Do not set Production variables or route production traffic until security, backup, quota, and end-to-end checks pass.

Until these phases pass, the current frontend remains a frontend only; this document is a plan, not evidence of a working Supabase backend.
