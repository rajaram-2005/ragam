# 06 — Full five-area end-to-end qualification report

Harness: `node scripts/release/e2e-qualification.mjs` → [evidence/e2e-qualification.json](evidence/e2e-qualification.json). **17 PASS, 0 FAIL, 0 live third-party calls.** The production `OnlineApp` was started on a real loopback HTTP socket with real SQLite stores, the real media job queue, the real plugin registry and the real MCP registry. The provider is an **isolated OpenAI-compatible test service** with a synthetic key; it is never reported as a live vendor. Every result records its mode.

| Area | Check | Mode | Result | Evidence detail |
|---|---|---|---|---|
| Chat | `chat.auth` | isolated test service | **PASS** | 401 unauthenticated; register 201; first account owner |
| Chat | `chat.model_selection_no_substitution` | isolated test service | **PASS** | Explicit `isolated-model-a` selected; unlisted model → 409 `model_unavailable` |
| Chat | `chat.real_inference_and_intended_routing` | isolated test service | **PASS** | One provider call with the exact model and `Bearer synthetic-test-key` |
| Chat | `chat.streaming` | isolated test service | **PASS** | 2 `delta` SSE events + `done` |
| Chat | `chat.history_persistence_across_restart` | isolated test service | **PASS** | User turn persisted; survived app close/reopen; 401 after restart |
| Chat | `chat.cancellation` | isolated test service | **PASS** | Abort cancelled the in-flight stream; `/api/health` 200 afterwards |
| Chat | `chat.error_handling_and_credential_non_exposure` | isolated test service | **PASS** | Provider 401 → 502 `provider_auth_failed`; key absent from response |
| Image | `image.no_fake_success_without_provider` | isolated test service | **PASS** | 503 `provider_not_configured`, no fake success |
| Image | `image.generation_storage_gallery_provenance` | isolated test service | **PASS** | Real 70-byte PNG stored, gallery listed, provenance carries provider/model |
| Image | `image.failure_handling_no_artifact` | isolated test service | **PASS** | Malformed provider response → `failed`, `artifact: null` |
| Video | `video.no_fake_success_without_provider` | isolated test service | **PASS** | 503 `provider_not_configured` |
| Video | `video.job_lifecycle_and_provider_failure` | isolated test service | **PASS** | History `queued → running → failed`, no artifact |
| Video | `video.cancellation` | isolated test service | **PASS** | Stalled queue job cancelled |
| Plugins | `plugins.discovery_and_preflight` | in_process | **PASS** | 2 plugins discovered, read-only preflight |
| Plugins | `plugins.execution_errors_and_permission_boundary` | in_process | **PASS** | Invoke 200; unknown 404; install refused 403; member owner-only 403 |
| MCP | `mcp.startup_discovery` | in_process | **PASS** | 3 servers, 4 tools; **0 resources, 0 prompts** (observed absence) |
| MCP | `mcp.invocation_and_error_recovery` | in_process | **PASS** | Preflight/call 200; unknown tool 400; registry healthy afterwards |

## Not tested / blocked

| Item | Status | Exact requirement |
|---|---|---|
| Live provider inference in Chat/Image/Video | **BLOCKED** | Authorized test/staging provider credentials (see [03-provider-qualification.md](03-provider-qualification.md)) |
| Real generated video artifact (MP4) | **BLOCKED** | Authorized live/staging video provider and an actual artifact |
| Real image from a live provider | **BLOCKED** | Authorized live/staging image provider |
| MCP resource access and prompt invocation | **BLOCKED** | In-process registry exposes 0 resources and 0 prompts; needs an authorized remote MCP server |
| MCP remote timeouts and remote error recovery | **BLOCKED** | Authorized remote MCP test server with a recorded timeout/reconnect run |
| Browser UI (React) interaction via a real browser | **NOT TESTED** | A browser automation runner and a hosted build; the HTTP/backend E2E above is not a UI click-through |

Modes used: `isolated_test_service`, `in_process`. No result uses `live` or `mock`. The isolated service is a real HTTP server, not an in-process mock, but it is explicitly **not** a third-party provider.
