# Hosted deployment status and requirements

## Current status

This repository does not configure a managed Core hosting provider. The previous paid hosting configuration was removed to meet the zero-cost requirement. That repository change does not create, cancel, or delete services, disks, or data in any external account; inspect those separately in the provider dashboard.

The web frontend may be deployed to Vercel, but the frontend alone is not a working application: its `/api/*` proxy requires a separately running Core API. No free Core host with verified persistent storage is configured, and no live Core health check or end-to-end deployment is currently verified. Do not treat a successful frontend build as evidence that Core is deployed.

## Zero-cost hosting constraint

A free compute plan is not automatically suitable for Core. Core stores account records, provider configuration and key material, audit data, and per-account state on disk. If a free service has an ephemeral filesystem, that data can disappear on restart, redeploy, or instance replacement. Do not point real account data at `/tmp` or another ephemeral directory. Use free hosting only for disposable demonstrations with synthetic data and an explicit understanding that the data may be lost. No claim is made here that a free, durable Core hosting option has been verified.

## Connecting a future Core host

When a suitable Core host is selected and its storage behavior is verified:

1. Configure Vercel's server-side `CORE_API_URL` as the Core server's **exact HTTPS origin**—no path and no trailing slash. Do not prefix it with `VITE_`; it must not be exposed to browser code.
2. Configure Core's `AETHERIS_TRUSTED_WEB_ORIGINS` with the exact HTTPS origin of the Vercel site being tested. Do not use a wildcard, path, or trailing slash. Preview and production origins are distinct.
3. Keep browser requests on the same-origin `/api/*` proxy. Do not enable permissive CORS as a workaround.
4. Confirm the Core health endpoint returns HTTP 200 through its direct origin and through the Vercel proxy. A health response is not evidence of durable storage.
5. Verify persistence with a dedicated synthetic account and marker across an actual service restart, then define and test backups and restore before storing real user data.

The proxy's serverless function limit is 60 seconds; Core's upstream time budget must be below that ceiling. Core keeps sessions in process memory, so users must sign in again after a restart. Any horizontal scaling plan must separately address shared session state and storage locking.

## Security gate

Public registration is currently open, and the first account becomes owner. There is no controlled owner bootstrap or registration lock. Do not expose this service for real users until that is fixed and tested. `AETHERIS_TRUSTED_WEB_ORIGINS` is a browser-origin/CSRF control, not an authentication boundary; direct HTTP clients can forge an `Origin` header.

The smoke script `scripts/production-smoke.mjs` checks a pre-provisioned dedicated account through the configured Vercel-to-Core path. It does not create or delete accounts. Persistence modes write and remove a synthetic marker and should only be used with a dedicated test account after the security gate is resolved; never use a real user's account or content.
