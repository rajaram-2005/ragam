# 03 — Provider-by-provider live qualification results

**Result: 0 live calls. 45 supported providers BLOCKED, 1 NOT APPLICABLE (`diffusers`, no adapter and not selectable).** The complete machine-readable register is [provider-register.json](provider-register.json), generated directly from `services/core/src/providers/catalog.mjs` and `services/core/src/providers/wires/index.mjs` by `node scripts/release/generate-provider-register.mjs`. No row was hand-edited.

## What was actually verified

| Check | Scope | Result | Evidence |
|---|---|---|---|
| Catalogue validation (46 rows, 23 ready / 22 gateway_only / 1 pending) | Code | **PASS** | `services/core/test/provider-framework.test.mjs`, [provider-register.json](provider-register.json) |
| Official documentation URL and default endpoint per provider | Code | **PASS** | Each row has `officialDocumentation`, `officialEndpoint` (from `wire.defaultBaseUrl`) or `endpointSource: operator-supplied baseUrl` |
| Intended-provider routing and no silent model substitution | Isolated test service | **PASS** | [evidence/e2e-qualification.json](evidence/e2e-qualification.json) → `chat.real_inference_and_intended_routing`, `chat.model_selection_no_substitution` |
| Invalid credentials (HTTP 401) and credential non-exposure | Isolated test service | **PASS** | `chat.error_handling_and_credential_non_exposure` (502 `provider_auth_failed`, synthetic key absent from the body) |
| Malformed provider response refused | Isolated test service | **PASS** | `image.failure_handling_no_artifact` (job `failed`, no artifact) |
| Provider-reported failure and cancellation | Isolated test service | **PASS** | `video.job_lifecycle_and_provider_failure`, `video.cancellation` |
| Static frontend-bundle credential check | Build | **PASS** | CI step "Verify the bundle carries no backend URL or credential"; [evidence/final-web-build.log](evidence/final-web-build.log) |
| Real request per provider, success schemas, 429 rate limits, timeout, network failure, malformed responses, unavailability, retry behaviour | **Live vendor** | **BLOCKED** | No authorized test/staging credential exists |

## Exact configuration fields (no credential values were read or stored)

**Self-hosted Core:** `PUT /api/providers/{id}` with body `{ baseUrl, apiKey, options }` (`options.accountId` only for `fireworks`). The key is sealed AES-256-GCM into `.aetheris-data/online/provider.json` → `connections["{id}"].key`; the master key is `master.key` in the same 0700 data directory. The catalogue descriptor returned to the browser has **no credential field at all**.

**Hosted BYOK:** `PUT /hosted/provider` with body `{ provider, apiKey, baseUrl }` → Supabase `byok_provider_connections.credential`. Required environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `AETHERIS_PROVIDER_ENCRYPTION_KEY` (32 random bytes, base64 or 64 hex), `AETHERIS_HOSTED_ORIGINS`, `AETHERIS_HOSTED_SITE_URL`.

**Local runtimes** (`ollama`, `llamacpp`, `vllm`, `localai`, `comfyui`) need no vendor key; the operator starts them on a trusted loopback/private origin and configures `baseUrl`. The legacy `LLAMACPP_API_KEY` / `LLAMACPP_API_KEY_FILE` variables are documented in `.env.example` and ship empty/commented. Structured credentials (`service_account`, `aws_credentials`, `client_credentials`) are validated and compacted by their wire before sealing; they are still one encrypted string per connection.

## Supported provider ids (45)

`ollama`, `llamacpp`, `anthropic`, `gemini`, `cohere`, `azure-openai`, `vertex`, `bedrock`, `openai`, `baidu-qianfan`, `alibaba-model-studio`, `openrouter`, `mistral`, `deepseek`, `cerebras`, `deepinfra`, `minimax`, `siliconflow`, `moonshot`, `sarvam`, `groq`, `together`, `fireworks`, `xai`, `perplexity`, `novita`, `sambanova`, `huggingface`, `vllm`, `localai`, `openai-images`, `gemini-images`, `stability`, `recraft`, `ideogram`, `black-forest-labs`, `fal`, `replicate`, `firefly`, `comfyui`, `veo`, `runway`, `luma`, `fal-video`, `replicate-video`.

`diffusers` is `pending`: no wire adapter exists and `selectProvider` refuses it, so live qualification is **NOT APPLICABLE**, not silently passed.

## Unblock procedure (per provider)

1. Supply an **explicitly authorized test/staging credential** (never a production key) through the exact `configField` in [provider-register.json](provider-register.json).
2. Obtain owner authorization for exactly one real request to the recorded `officialEndpoint` / `officialDocumentation`.
3. Capture a call log with: success response schema, invalid credential, 429, timeout, network failure, malformed response, provider unavailability, retry behaviour, credential non-exposure, intended-provider routing and proof that the selected model was not substituted.
4. Set `status: PASS` only with that log attached as `liveCredentialEvidence.callLog`; the report validator refuses a live PASS without it.

Until then all 45 remain **BLOCKED**. Contract-tested adapters, the readiness snapshot and isolated-service E2E are **not** live vendor evidence.
