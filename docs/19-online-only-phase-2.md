# Phase 2 — online-only product increment

Date: 2026-10-14. This supersedes the earlier offline-first product direction.

## Agreed scope and delivered change

The user selected **five areas with simplified Chat**, and **LiteLLM gateway first**.
The active `npm run core` entry now loads `online/app.mjs`, not the legacy offline-first application.

- **Chat, Image, Video, Plugins, MCP** remain the only primary areas. Provider Settings is a dialog reached from the sidebar and Chat.
- No local/hybrid inference mode, local runtime startup, model downloads, Klyvaron tier/hardware panel, training panel, benchmark panel, God Core dashboard, or local inference fallback in the active product.
- Authenticated Provider Settings saves a LiteLLM API base URL and gateway key; tests connection by fetching `/models`; refreshes listings; removes the connection/key. Configuration is server-owned and persists across restart.
- A visible model picker saves an exact model ID. Unknown/unavailable selections fail rather than silently choosing another model. Model listings are labelled unverified; successful text inference is recorded separately. A gateway alias may itself route upstream; Aetheris does not attest to the gateway's internal routing policy.
- Real OpenAI-compatible `/chat/completions` transport with SSE, cancellation, total body-inclusive timeout, response/request limits, no redirects, no retries, and at most two concurrent chat requests per installation.
- Conversation history, optional approved memory and text-file knowledge remain. Files are limited to supported plain-text formats up to 1 MiB in the UI; no PDF/Office parsing. Context is sent only when selected for the request. Sensitive data needs explicit per-request authorization; credential-shaped content is redacted. Classification covers the entire assembled request and cannot be lowered by a caller's `public` label.
- Plugins/MCP retain reviewed read-only built-ins. Arbitrary extension installs, trust-key modifications, external MCP registration and agent-driven tool execution are disabled in this increment. Built-ins are trusted because they are part of reviewed application source, not because of a publisher signature or a claimed in-process sandbox.

**Not delivered:** real online Image/Video generation adapters, direct native provider integrations, cloud deployment, durable autonomous tasks, or a qualified Sparsiz training loop. Image/Video clearly state that their adapters are not connected; no synthetic output is substituted. LiteLLM metadata does not prove image/video support or access rights.

## Run and connect

Node >=22.5 and the existing Web dependencies are sufficient for the online product; Python, NumPy, Fabric and model weights are not required to run it.

```bash
npm run core
# another terminal
npm run web
```

Core binds `0.0.0.0:8790`; Web uses relative `/api` requests through the Vite proxy. The proxy preserves the request Host so the same-origin check works behind the Arena preview. For HTTPS preview/production, secure cookies remain enabled. For **HTTP-only local development**, explicitly use:

```bash
AETHERIS_COOKIE_SECURE=false npm run core
```

**Sign-in is an account, not a token.** The operator token file this increment originally created (`.aetheris-data/online/access-token`) has been **removed**, together with its `{ token }` login route: there is one way in. Open the web app, choose **Create account** (`#/signup`), and sign in with an email address and a password. The first account created owns the installation and is the only one that can change the gateway connection; later accounts are members. Accounts, scrypt password hashes, sessions, per-account data isolation and the host-delivered password-reset flow are specified in [docs/20](20-accounts-and-sign-in.md). Sign-in still creates an HttpOnly, eight-hour cookie whose `SameSite` is `Strict` by default (`AETHERIS_COOKIE_SAMESITE=none` opts in for an installation embedded in another site, and requires secure cookies), sessions are still bounded and revoked on restart, and sign-out still invalidates the current session.

Then:

1. Open **Provider Settings**.
2. Enter your LiteLLM API base URL, e.g. your gateway's `/v1` base, and gateway API key.
3. **Save connection**. Changing endpoint requires a new key; the old key is not forwarded to a new destination. Saving does not make a network request.
4. **Test connection & refresh models**. This makes a metadata request, not a billed test completion. Any gateway-specific metadata charges remain the gateway operator's responsibility.
5. In Chat, select a model. **Send** authorizes transmission of that conversation to the displayed gateway and its configured upstream services. Context and sensitive-content controls are separate. Model permission, quota, billing and retention are determined by your gateway and upstream provider.

No provider credentials have been supplied or real external inference performed in this increment. This Arena sandbox's outbound destinations are restricted to GitHub/npm/PyPI infrastructure; arbitrary remote LiteLLM/provider connectivity is not available for live qualification here. Run/deploy on a host with authorized network access to your gateway to qualify actual inference. Local fixtures used in tests are explicitly synthetic, never exposed as user models in the preview.

## Active configuration

Export environment variables into the process; the new entry does not load legacy `.env` files automatically.

| Variable | Default | Meaning |
|---|---|---|
| `AETHERIS_CORE_HOST` | `0.0.0.0` | Bind address, not authorization |
| `AETHERIS_CORE_PORT` | `8790` | API port |
| `AETHERIS_ONLINE_DATA_DIR` | `.aetheris-data/online` | Separate settings, accounts, history, memory and knowledge directory |
| `AETHERIS_COOKIE_SECURE` | `true` | Set `false` only for deliberate HTTP local development |
| `AETHERIS_COOKIE_SAMESITE` | `strict` | `none` when the web app is served inside another site's iframe; requires secure cookies |
| `AETHERIS_MAX_ACCOUNTS` | `64` | Cap on accounts an open sign-up page can create |
| `AETHERIS_PRINT_RESET_CODES` | `false` | Also print a password-reset code on the Core console |
| `AETHERIS_LITELLM_TRUSTED_ORIGINS` | empty | Comma-separated exact origins for explicitly trusted internal gateways |
| `AETHERIS_CORE_URL` | proxy default | Web server's backend target, never a browser-facing localhost URL |
| `WEB_PORT` | `5173` | Web server port |

Without an explicitly trusted internal origin, gateway configuration requires HTTPS and forbids IP-literal private destinations. DNS addresses are filtered at connection lookup, blocking private/link-local destinations; the connected address is chosen from that filtered resolution rather than validating once and resolving again. Redirects are never followed. An internal gateway such as a loopback LiteLLM process requires an exact operator allowlist entry; it is still classified as **online inference**, because the gateway forwards upstream. This does not claim OS-wide network isolation or attest to a gateway's behavior.

The provider key is encrypted with AES-256-GCM in `provider.json`, using the server-owned `master.key`. Both files and the token are protected by filesystem permissions; plaintext keys are never returned by settings APIs, stored in browser storage, or written to the audit ledger. Someone who obtains both ciphertext and the master key can decrypt it. This is not protection against a compromised server/OS; production should use managed secret storage and appropriate backups/access controls. Deletion removes the active stored key, not historical filesystem backups.

## Security boundary and remaining limitations

This installation has **accounts**, and sign-up is open to anybody who can reach it. Conversation, memory and file knowledge are per account (separate databases, not filters); the gateway connection and its key belong to the installation and can be changed only by its owner account. All settings, conversation, memory, knowledge and tool APIs require authentication. Mutations require a same-origin request and non-simple request header; no permissive CORS is emitted. Only health, sign-in status, registration, sign-in and password reset are public. No client-provided principal grants access to another identity. Sign-in is rate-limited and locks an account after repeated failures; account count, session count, request sizes, provider responses and inference concurrency are bounded. See [docs/20](20-accounts-and-sign-in.md) for the full account model and for what password reset without a mail transport does and does not protect against.

Provider credentials remain server-side, but inference data necessarily leaves the deployment when sent. The UI explicitly identifies the gateway; upstream disclosure, budget enforcement, retention and training policies must be configured/verified in LiteLLM. No free-access, privacy, quota or price guarantee is inferred from its model list. Prompt injection is not solved by classification: external context remains untrusted, and model outputs do not automatically execute tools.

History is saved for completed turns. Incomplete/failed generations retain the draft and visible partial text but do not become saved assistant turns. Existing offline-era data is preserved separately; there is no automatic migration or upload. Local storage of history/context is not offline model inference.

## Validation and preservation

- Full verification: **549 Core + 91 Web + 575 Fabric = 1,215 tests**, followed by production build. (This increment delivered 528 + 76 + 575 = 1,179; the accounts and sign-in change in [docs/20](20-accounts-and-sign-in.md) added 21 Core and 15 Web tests.)
- Core adds **19 online-specific tests** for authentication, CSRF, secret storage, model switching/persistence, no fallback, data consent, classification, body deadlines, provider errors, SSE completion, context/history, reviewed tools, and removed routes.
- Web's superseded offline-control/research-panel assertions were replaced with current online UI assertions; remaining component/API/render regressions remain. A new provider-settings render test verifies key input and connection controls.
- Existing legacy Core and Fabric suites are retained. Their passing tests do **not** mean their capabilities are in the online product. Counts include retained research/library coverage.
- SSR render tests passed. A separate Happy DOM event-flow check exercised owner sign-in → settings save → metadata refresh → exact model selection → streamed chat → sign-out against an isolated synthetic gateway. This is DOM simulation, not real-browser or real-provider qualification. Its test-only dependency was installed outside the repository; no production dependency changed.
- Production-preview HTTP checks passed for compiled assets, Host/Origin forwarding, unauthenticated 401 responses, secure sign-in cookies, online-only readiness, settings access and sign-out. The old offline Core and standalone Fabric preview processes were stopped.
- Prior audit evidence is historical and left unchanged. Local/research modules and data are preserved; `legacy-server.mjs` and `apps/web/legacy/` retain prior entry/UI references, not active imports. Do not deploy the legacy API as an authenticated online service.
- No additional production dependency, model installation, training, paid inference, commit or push was performed.

Next increment: qualify an actual reachable LiteLLM gateway and authorized models; then implement and test real online image/video adapters one modality at a time, which is where universal provider support starts. The unfinished image/video additions are deliberately **not** part of this increment or of the sign-in change: they still need testing before a follow-up pull request. Professional/industrial or autonomous capabilities remain outside this delivered scope.
