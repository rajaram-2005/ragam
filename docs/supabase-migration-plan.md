# Supabase migration plan (not yet deployed)

## Chosen target

The proposed cloud architecture is Vercel Node.js Functions for request execution, Supabase Postgres for durable structured state, and a private Supabase Storage bucket for file artifacts. This is a substantial backend migration, not a `CORE_API_URL` change. Supabase does not run the existing long-lived Node server by itself.

No Supabase project has been created or modified for Ragam. Existing inactive projects were left untouched. No Core data has been exported or migrated. No production readiness or free-tier capacity is claimed.

## Current implementation that must change

The Core service currently starts a long-lived `node:http` server and uses synchronous `node:sqlite` stores. Persistent state spans accounts and password resets, provider configuration, audit events, memories and sessions, knowledge documents/chunks/embeddings, skills/styles, Klyvaron configuration, and durable job metadata. Media and other artifacts also use local filesystem paths. Authentication sessions are currently process-local memory.

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

## Create a separate Supabase project yourself

The Supabase connector currently shows no project named Ragam and several inactive projects. Keep those untouched. To create a new project without sharing database credentials in chat:

1. In the Supabase Dashboard, choose **New project** and select your intended organization.
2. Name it `ragam-core`.
3. Select **Free** only if the dashboard confirms that no paid upgrade or add-on is required. If it asks for a paid plan, stop.
4. Select **South Asia (Mumbai)** (`ap-south-1`) if offered; it is the closest listed region to Chennai. Keep the project isolated from other applications.
5. Generate a strong database password, save it in your password manager, and do not paste it into chat, Git, or a browser build variable.
6. Create the project and wait until Supabase reports that it is healthy. Do not add data or production credentials yet.
7. Share only the project reference (the short project ID shown in the dashboard) when ready. Do not share the database password, service-role key, or any provider credentials.

Free project quotas, sleep/pausing behavior, storage limits, and function limits can change. Verify the current limits in the dashboard before relying on the project for availability or real user data.

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
