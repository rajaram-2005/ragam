# 27 — Universal provider framework: audit, catalogue, and what is actually reachable

The master directive of 2026-10-17 asks for a universal provider architecture, a real Image and
Video pipeline, first-party Klyvaron integrations, memory and skills, adaptation, emotional
intelligence and Plugins/MCP — twelve phases, each independently testable. This page records the
audit that preceded the work, the provider framework built in this increment, and the honest status
of every other part.

> **Architecture override (2026-10-17): online-first.** RAGAM requires connectivity for its primary
> AI functionality. Offline operation, strict-offline mode and OS-level network isolation are **not**
> product requirements or completion criteria, and no longer appear in the remaining-work list.
> Local runtimes stay as optional self-hosted integrations. The security controls that remain —
> egress filtering, redirect refusal, exact-origin allowlists, timeouts and credential encryption —
> exist to make online requests safe, not to make the product offline.

**Status vocabulary.** Every claim below is exactly one of: *implemented and tested*, *implemented,
awaiting live credentials*, *hardware-dependent*, *partially implemented*, *planned*, *unsupported*.
A catalogue entry is never evidence of support; the provider matrix in §4 says which providers have
a tested code path and which merely speak a wire format this build implements.

---

## 1. Repository audit (phase 0)

Baseline before this increment: branch `arena/68ef18d8-ragam` at `ec3f42b` (release 0.2.0), core
**809** tests, web **92**, fabric **814**, all green in CI; docs 46. The working tree was clean.

What exists, read rather than assumed:

| Area | Where | What it is |
|---|---|---|
| Product surface | `apps/web/src/areas.js` | Exactly five areas — Chat, Image, Video, Plugins, MCP — asserted by `structure.test.mjs` |
| HTTP surface | `services/core/src/online/app.mjs` | One server, session-gated after `/api/auth`; `/api/providers` is the installation's *single* connection |
| Transport | `services/core/src/online/gateway.mjs` | One OpenAI-compatible client: no redirects, DNS/IP filtering, deadlines, size bounds, SSE parsing, cancellation |
| Credentials | `services/core/src/online/store.mjs` | AES-256-GCM at `0600`, master key beside it; `public()` returns no secret |
| Adaptive core | `services/core/src/adaptive/*` | Provider *fabric* (capability tags, probing, eligibility), router, loop, verification — a library, not wired to routes |
| Media | `services/core/src/media/*` | Byte validation, job queue, and the Phase 8 workflow that measures an artifact before describing it — no provider |
| Safety | `mcp/authority.mjs`, `policy/*` | Provenance, authority minted only from a user turn, egress policy, offline guard |
| Packs | `services/core/src/packs/*` | Industry restrictions that can only narrow |

**Findings that shaped this increment.**

1. **The product has one provider slot, not a provider system.** `PROVIDER_ROUTES` has three
   entries, all speaking the same wire. That is honest and well tested, and it is not a universal
   architecture. Adding twenty adapters behind it without a capability model would produce twenty
   ways to overclaim.
2. **There are already two provider vocabularies** — `router/registry.mjs` (model metadata) and
   `adaptive/providers.mjs` (runtime fabric). A third would be a duplicate. The new catalogue is
   therefore *descriptive metadata about vendors*, and it composes with both: it does not open
   sockets, and the fabric remains the only thing that probes.
3. **No image or video adapter exists in any form.** The Image and Video areas refuse with their own
   limitation codes. Nothing in this increment changes that, and §5 says so per provider.
4. **Nothing has ever been called live.** The sandbox reaches `github.com`, `codeload.github.com`,
   `api.github.com`, `registry.npmjs.org`, `pypi.org` and `files.pythonhosted.org`; vendor APIs are
   not reachable from it, and no credentials exist for them.
5. **FreeLLMAPI remains excluded**, and the exclusion is tested rather than remembered
   (`test/provider-framework.test.mjs`).

---

## 2. Traceability

| Master-prompt requirement | Status | Where |
|---|---|---|
| Five areas, no sixth | implemented and tested | `areas.js`, `structure.test.mjs` |
| Provider registry with capability metadata | **implemented and tested** | `providers/catalog.mjs`, `test/provider-framework.test.mjs` |
| Capability-based routing with explainable refusals | **implemented and tested** | `providers/select.mjs` |
| Error normalisation, retry classification, redaction | **implemented and tested** | `providers/errors.mjs` |
| Provider setup UI (credentials, test, model list) | implemented for the three runtimes, the six native wires and custom endpoints | `ProviderSettings.jsx`, `test/online.test.mjs`, `test/online-wires.test.mjs` |
| Capability matrix in the UI | **implemented and tested (read-only)** | `ProviderCatalogue.jsx`, `test/render.test.mjs` |
| Catalog API | **implemented and tested** | `GET /api/providers/catalog` |
| Direct per-vendor chat adapters | **implemented and tested for Anthropic, Gemini, Cohere, Azure OpenAI, Vertex and Bedrock**; no vendor called live | `providers/wires/*.mjs`, `test/online-wires.test.mjs`; media vendors stay `pending` and are refused by name |
| Other OpenAI-compatible vendors | implemented, awaiting live credentials | §4 — `gateway_only`; no vendor called |
| Image generation | **implemented and tested for OpenAI Images**; editing and history planned | `wires/images.mjs`, `/api/image/*`, `test/online-image.test.mjs`; no vendor called live |
| Video generation, async jobs, cancellation | **implemented and tested for Google Veo**; other video vendors pending | `wires/veo.mjs`, `/api/video/*`, `test/online-video.test.mjs`; no vendor called live |
| Klyvaron Lite/Pro/Max runtime adapters | partially implemented | docs/24: two Lite artifacts released, Pro/Max unbuilt |
| Klyvaron Image / Video registries | planned | docs/22 records the modality roles; no weights exist |
| Persistent memory, provenance, deletion | implemented and tested (product routes; the layered fabric remains a library) | `/api/memory` in `context-routes.mjs`; `memory/store.mjs` |
| Versioned skills, permissions, rollback | **implemented and tested (reviewed procedures)**; execution of declared permissions remains a library | `/api/skills` in `context-routes.mjs`, `skills/product.mjs`, `test/online-skills.test.mjs` |
| Experience-driven adaptation, regression gates | implemented and tested (library) | `adaptive/loop.mjs`, `adaptive/episodes.mjs` |
| Response styles (user-chosen) | **implemented and tested (product surface)** | `/api/styles` in `context-routes.mjs`, `online/styles.mjs`, `test/online-styles.test.mjs`; the state *estimator* remains a library in `adaptive/wording.mjs` |
| Plugins and MCP least privilege | implemented and tested (library) | `plugins/*`, `mcp/*` |
| Safe egress (SSRF, private addresses, redirects, origins) | **implemented and tested** | `online/gateway.mjs`, `policy/egress.mjs`; security controls, **not** an offline product mode |
| Live-provider verification | not possible here | no credentials, vendor hosts unreachable |

The library rows are not a dismissal: those modules have acceptance tests and records in
[docs/25](25-adaptive-intelligence.md). What they do not have is a product route, and the release
note says so.

---

## 3. The provider framework

Three catalogue modules and one adapter per implemented wire; no vendor socket in any of them
(the transport lives in `online/gateway.mjs`).

**`providers/catalog.mjs` — what exists, and what this build can prove.** Each descriptor carries an
id, label, category, wire format, auth kind, a documentation URL, a free-text note, an egress policy,
and a status:

| Status | Meaning | What it may claim |
|---|---|---|
| `ready` | a tested code path reaches it (the three runtimes against a local server; the six native wires against a contract fixture) | capabilities whose evidence is a test in this repository |
| `gateway_only` | it speaks the OpenAI-compatible wire the transport implements | **nothing** — the capability list is empty by rule |
| `pending` | it needs a wire adapter this build does not have | nothing; it is refused by selection |

Validation is the enforcement: a `ready` entry whose capability is backed by a vendor document
rather than a test fails the build; a capability with no evidence source fails; an unknown field
fails, which is also how a credential is kept out of a descriptor (there is no field for one).

**`providers/select.mjs` — a decision, with reasons.** Requirements (capabilities, minimum context,
whether the request leaves the machine) are checked against the catalogue. Every candidate that does
not qualify is returned with a code and a sentence; there is no "best available". A caller-supplied
offline policy still refuses a remote request before any candidate is considered — that is a library
guarantee for embedders, not a product mode. An unrecorded context limit does not satisfy a stated
minimum.

**`providers/errors.mjs` — one failure shape that cannot leak.** Status codes map to stable codes,
retryability is decided by code rather than by optimism, `Retry-After` is honoured and bounded, and
the message is redacted against six credential shapes before it is returned. A 429 whose body says
the account is out of credit is a quota failure, not a rate limit, because the advice differs.

**What is wired into the product.** `GET /api/providers/catalog` (session-gated, no credentials, no
model list) answers with the report and the descriptors; Provider Settings renders it as a
read-only matrix with three sentences and no controls.

---

## 4. Provider matrix

**38 entries — 11 ready, 14 reachable via an OpenAI-compatible endpoint, 13 pending.**

| Provider | Status | Wire | Auth | Capabilities evidenced | Documentation |
|---|---|---|---|---|---|
| `litellm` — LiteLLM gateway | ready | openai_chat | bearer | streaming:test<br>cancellation:test | [docs](https://docs.litellm.ai/docs/providers) |
| `ollama` — Ollama (OpenAI-compatible) | ready | openai_chat | bearer | streaming:test<br>cancellation:test | [docs](https://github.com/ollama/ollama/blob/main/docs/openai.md) |
| `llamacpp` — llama.cpp server | ready | openai_chat | bearer | streaming:test<br>cancellation:test | [docs](https://github.com/ggml-org/llama.cpp/blob/master/examples/server/README.md) |
| `openai` — OpenAI | gateway_only | openai_chat | bearer | — | [docs](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) |
| `openrouter` — OpenRouter | gateway_only | openai_chat | bearer | — | [docs](https://openrouter.ai/docs/quickstart) |
| `mistral` — Mistral AI | gateway_only | openai_chat | bearer | — | [docs](https://docs.mistral.ai/api/) |
| `deepseek` — DeepSeek | gateway_only | openai_chat | bearer | — | [docs](https://api-docs.deepseek.com/) |
| `groq` — Groq | gateway_only | openai_chat | bearer | — | [docs](https://console.groq.com/docs/openai) |
| `together` — Together AI | gateway_only | openai_chat | bearer | — | [docs](https://docs.together.ai/docs/openai-api-compatibility) |
| `fireworks` — Fireworks AI | gateway_only | openai_chat | bearer | — | [docs](https://docs.fireworks.ai/api-reference/introduction) |
| `xai` — xAI | gateway_only | openai_chat | bearer | — | [docs](https://docs.x.ai/docs/api-reference) |
| `perplexity` — Perplexity | gateway_only | openai_chat | bearer | — | [docs](https://docs.perplexity.ai/api-reference/chat-completions) |
| `novita` — Novita AI | gateway_only | openai_chat | bearer | — | [docs](https://novita.ai/docs/api-reference/model-apis-llm-create-chat-completion) |
| `sambanova` — SambaNova | gateway_only | openai_chat | bearer | — | [docs](https://docs.sambanova.ai/cloud/docs/get-started/api-reference) |
| `huggingface` — Hugging Face Inference Providers | gateway_only | openai_chat | bearer | — | [docs](https://huggingface.co/docs/inference-providers/index) |
| `vllm` — vLLM (OpenAI-compatible server) | gateway_only | openai_chat | bearer | — | [docs](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html) |
| `localai` — LocalAI | gateway_only | openai_chat | bearer | — | [docs](https://localai.io/features/openai-functions/) |
| `anthropic` — Anthropic Claude | ready | anthropic_messages | x_api_key | streaming:test | [docs](https://docs.anthropic.com/en/api/messages) |
| `gemini` — Google Gemini | ready | gemini_generate | x_api_key | streaming:test | [docs](https://ai.google.dev/api/generate-content) |
| `cohere` — Cohere | ready | cohere_chat | bearer | streaming:test | [docs](https://docs.cohere.com/reference/chat) |
| `azure-openai` — Azure OpenAI | ready | azure_openai | x_api_key | streaming:test | [docs](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle) |
| `vertex` — Google Vertex AI | ready | gcp_vertex | gcp_adc | streaming:test | [docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations) |
| `bedrock` — Amazon Bedrock | ready | aws_bedrock | aws_sigv4 | cancellation:test | [docs](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html) |
| `openai-images` — OpenAI Images | ready | openai_images | bearer | image_generation:test | [docs](https://developers.openai.com/api/reference/resources/images/methods/generate) |
| `veo` — Google Veo (Gemini API) | ready | gemini_veo | x_api_key | video_generation:test | [docs](https://ai.google.dev/gemini-api/docs/veo) |
| `runway` — Runway | pending | — | bearer | — | [docs](https://docs.dev.runwayml.com/) |
| `luma` — Luma AI | pending | — | bearer | — | [docs](https://docs.lumalabs.ai/docs/api) |
| `fal-video` — fal.ai video | pending | — | bearer | — | [docs](https://docs.fal.ai/model-endpoints/queue) |
| `replicate-video` — Replicate video | pending | — | bearer | — | [docs](https://replicate.com/docs/reference/http) |
| `stability` — Stability AI | pending | — | bearer | — | [docs](https://platform.stability.ai/docs/api-reference) |
| `fal` — fal.ai | pending | — | bearer | — | [docs](https://docs.fal.ai/) |
| `replicate` — Replicate | pending | — | bearer | — | [docs](https://replicate.com/docs/reference/http) |
| `recraft` — Recraft | pending | — | bearer | — | [docs](https://www.recraft.ai/docs) |
| `ideogram` — Ideogram | pending | — | bearer | — | [docs](https://developer.ideogram.ai/api-reference) |
| `black-forest-labs` — Black Forest Labs (FLUX) | pending | — | bearer | — | [docs](https://docs.bfl.ml/) |
| `firefly` — Adobe Firefly | pending | — | bearer | — | [docs](https://developer.adobe.com/firefly-services/docs/firefly-api/) |
| `comfyui` — ComfyUI (local) | pending | — | bearer | — | [docs](https://github.com/comfyanonymous/ComfyUI) |
| `diffusers` — Diffusers (local) | pending | — | bearer | — | [docs](https://huggingface.co/docs/diffusers/index) |

`gateway_only` is a statement about a wire format, not an integration: an operator can point a
compatible endpoint at these vendors, and nothing in this repository has done so.

`ready` for the eight native adapters (six chat shapes, one image shape and one video shape) means the
same thing it means for the three runtimes: a code path this repository exercises against a fixture. It does **not** mean the vendor was called. Their
request shapes are not OpenAI's — auth header, system-prompt placement, role names and the
completion signal all differ — so each has its own adapter rather than a compatibility shim. The
first two are compared here; the four added in the latest increment are in §4.1:

| Difference | Anthropic Messages | Gemini generateContent |
|---|---|---|
| Auth | `x-api-key` | `x-goog-api-key` |
| Version header | `anthropic-version: 2023-06-01` (required) | none |
| Model location | body | path (`models/{model}:generateContent`) |
| System prompt | top-level `system` string | `systemInstruction.parts` |
| Assistant role | `assistant` | `model` |
| Stream completion | `message_stop` event | end of body (no sentinel) |
| Token fields | `input_tokens` / `output_tokens` | `promptTokenCount` / `candidatesTokenCount` |

`pending` adapters are refused by name — `adapter_pending` — even if a vendor documents the
capability.

### 4.1 The four adapters added in this increment

Each is a wire of its own — request shape, credential chain and completion signal — rather than
another compatibility shim. All four are contract-tested against local fixtures that return the
published response shapes, and **no vendor has been called live**.

| Wire | Request | Credential | Streaming | What is genuinely different |
|---|---|---|---|---|
| `cohere_chat` | `POST {base}/v2/chat`, `GET {base}/v1/models` | `Authorization: Bearer` | typed SSE, `content-delta` through `message-end` | model discovery is paginated (`next_page_token`, 100 per page); the system prompt is a `system` message, not a separate field |
| `azure_openai` | `POST {base}/openai/v1/chat/completions`, `GET {base}/openai/v1/models` | `api-key` header | OpenAI SSE with `[DONE]` | no `api-version` (the v1 API); the selected id is the **deployment name**, sent in `model`, not a model name in a path |
| `gcp_vertex` | `POST {base}/v1/projects/{p}/locations/{l}/publishers/google/models/{m}:generateContent` | service-account JSON → RS256 JWT assertion → OAuth access token | `:streamGenerateContent?alt=sse` | the token is exchanged once per credential and cached by audience; discovery uses the v1beta1 publisher-model list because v1 has no list method |
| `aws_bedrock` | `POST {base}/model/{id}/converse`, `GET {control}/foundation-models` | IAM access key JSON, SigV4 | **not implemented** — `ConverseStream` is a binary event stream, not SSE | model metadata lives on a different host (`bedrock.` rather than `bedrock-runtime.`); inference profiles are listed separately and a permission gap there does not hide the foundation models |

**Credentials are still one encrypted string per connection.** The store does not gain a schema-3
with a second secret field. A structured credential is a JSON document — the service-account file,
or `{accessKeyId, secretAccessKey, sessionToken?, region?}` — validated by its wire and **compacted
before sealing**, so an unusable document fails at save time in front of the person who pasted it,
and what is encrypted is one line. `public()` returns the credential *kind*
(`api_key`, `service_account`, `aws_credentials`), never a value; Provider Settings renders a
password field for a key and a text area for a document.

**Signing is checked, not asserted.** `wires/sigv4.mjs` implements the canonical request, the
credential scope and the date → region → service → `aws4_request` key chain, and a contract test
reproduces AWS's published worked example byte for byte (signature
`5d672d79…f2b5d7`). Reversing that chain still produces a plausible signature, which is exactly why
the vector, not a self-consistency check, is the test.

**What remains unproven.** A key that works, a deployment that exists, a model that is enabled for
the project and a quota that allows the request. The catalogue's `ready` means "a tested code path",
and the notes on every native entry say that no live call has been made.

---

## 5. Image and video

Image and video generation are each **implemented for one provider**; the remaining media vendors
are pending.

| Area | Capability | Status | What happens today |
|---|---|---|---|
| Image | text-to-image through OpenAI Images | **implemented and tested** | `POST /api/image/generate` queues a durable job (202), the provider returns inline base64, the Core validates the container and stores the bytes, and `GET /api/image/jobs/<id>/content` serves them. No provider URL is ever fetched or rendered |
| Video | text-to-video through Google Veo (Gemini API) | **implemented and tested** | `POST /api/video/generate` queues a job (202); the wire starts `predictLongRunning`, polls the operation with a bounded cancellable loop, downloads the file URI, and the Core validates the MP4 container before storing it. `POST /api/video/jobs/<id>/cancel` aborts the live request |
| Image | edit, variations, mask, history beyond the job list | planned | Those routes do not exist; the Image area cannot send them and the adapter cannot fake them |
| Video | image-to-video, extension, a second vendor | planned | The adapter sends a text prompt only; Runway, Luma, fal.ai video and Replicate video remain `pending` and are refused by name |
| Image | Stability, fal.ai, Replicate, Recraft, Ideogram, BFL, Firefly, ComfyUI, Diffusers | pending | Each is refused by name. A model name in a catalogue is not an adapter |

The `media/workflow.mjs` measurement layer is used by both paths for container checks and digests,
and its tests remain the check on what "validated" means. The image wire adds a prompt cap of 4,000
characters (the provider allows 32,000; this product caps what it will send), four sizes
(`1024x1024`, `1536x1024`, `1024x1536`, `auto`), and a 20 MB decoded-image ceiling. A response with
only a URL, a non-image payload, a truncated base64 value or a container whose bytes do not
re-encode is `invalid_completion` — never a broken image in the browser.

The video wire adds the asynchronous half: an operation name is the only thing the start call
returns, the poll is bounded and cancellable, and the finished file is downloaded as bytes. The
credential is sent only to the API origin; a file URI on another public HTTPS host is fetched
without it, and a redirect is refused. Duration is measured from the MP4's own `moov/mvhd` box, not
copied from a provider claim. A still image, a stub or a truncated container fails
`assertGenuineVideo` and never becomes a `<video>`.

**Provenance is part of the artifact.** Every job stores the prompt, the provider and model, the
size or aspect ratio/resolution that was requested, the measured duration (video), the byte length
and SHA-256 digest, and the revised prompt when the vendor returns one. The area renders a result
only for a job whose state is `succeeded` and whose artifact the Core validated. A failed or
cancelled job stays visible with its reason and has no media element.

## 6. Klyvaron

- **Lite** has two released artifacts, both trained here and recorded with digests
  ([docs/08](08-aetheris-lite.md), [docs/24](24-own-models.md)).
- **Pro and Max** have no weights. Their `backend`, `train`, `evaluate` and `release` steps are open
  in `klyvaron/plan.mjs`; the plan reports them as open rather than as pending.
- **Klyvaron Image and Video** have modality *roles* in `klyvaron/architecture.mjs` and no
  artifacts. No model card claims one. There is no registry for them yet, because a registry of
  models that do not exist would be a fiction with good formatting.

---

## 7. Security posture for an online-first product

Online-first does not mean unrestricted network access. What is proven by tests: the gateway's
DNS/IP filtering and redirect refusal, the exact-origin allowlist for private or plain-HTTP
destinations, per-request deadlines and size bounds, CSRF and origin checks on mutations, credential
encryption at rest, and that no catalogue descriptor can carry a secret. These controls exist to make
an outbound request to a chosen provider safe; they are not an offline mode.

The legacy egress guard and its `strict_offline` policy remain in the repository for the retained
local service and for embedders that request them, and its tests still pass. They are no longer a
product requirement, a completion criterion, or a gate on any phase (the 2026-10-17 override above).
No OS-level network isolation is claimed, and none is needed: the product is expected to be online.

---

## 8. Saved connections (store schema 2)

The catalogue describes vendors; the store keeps what the user saved. Since the second increment the
store holds **more than one connection**:

```
{ schema: 2, revision, active, connections: { [id]: { id, baseUrl, key, models, selectedModel,
                                                       verified, checkedAt } } }
```

- **A connection id is a catalogue id or `custom-<name>`.** `custom` and `custom-<name>` are
  first-class keyless OpenAI-compatible endpoints, so an OpenAI-compatible server that is not in the
  catalogue can be saved without pretending to be one that is.
- **One sealed credential per connection.** `key` is AES-256-GCM ciphertext under the same
  `master.key` (directory `0700`, file `0600`, atomic temp-file + rename). It holds either one API
  key or one compact JSON credential document; the wire's `credential` kind says which, and the
  document is validated and compacted at save time. No API response returns it: `public()` reports
  `keyConfigured: true` and the kind, and nothing else.
- **`revision` is store-wide** and increments on any connection change, so a chat authorisation
  recorded against an older revision does not silently authorise a newer configuration.
- **Migration is a read, not a rewrite the user has to trigger.** A schema-1 file — one record whose
  id was its runtime kind — is read as one connection with `active` set to that kind, the sealed key
  preserved, and the file is rewritten in schema 2 on construction. A test writes a synthetic
  schema-1 file and asserts both the key and the revision survive.

Routes (all session-gated; mutations owner-only, CSRF-checked, origin-checked):

| Route | Meaning |
|---|---|
| `GET /api/providers` | The saved connections plus which one is active. Never a secret |
| `PUT /api/providers/<id>` | Save that connection and make it active |
| `POST /api/providers/<id>/test` | Probe **that** connection and store its models |
| `DELETE /api/providers/<id>` | Remove **that** connection |
| `PUT /api/providers/active` | Switch the active id without rewriting credentials |

A route names one connection; it cannot act on a different one. `POST /api/providers/litellm/test`
against a store that only holds `ollama` is `404 provider_not_found` and contacts nothing — one key
is never spent on another vendor's endpoint. `PUT /api/providers/not-a-provider` is
`400 invalid_runtime`; a real catalogue id whose adapter is `pending` is `400 adapter_pending`. The
three built-in runtimes (LiteLLM, Ollama, llama.cpp) keep their existing routes and semantics.

## 9. Known limitations of this increment

- **No live provider call was made.** "Implemented, awaiting live credentials" is the ceiling for
  every vendor outside the three tested runtimes and the eight contract-tested native adapters.
- **Eight native adapters exist, and none has been called live.** Anthropic Messages, Gemini
  generateContent, Cohere Chat v2, Azure OpenAI v1, Vertex AI, Bedrock Converse, OpenAI Images and
  Google Veo are contract-tested against local fixtures that return the published response shapes. A key that is
  valid, a model that exists and a quota that allows the request are all still unverified; the
  matrix and `docs/03` say so.
- **Bedrock does not stream in this build.** `ConverseStream` returns
  `application/vnd.amazon.eventstream`; the transport parses SSE. The stream endpoint therefore
  returns that provider's answer in one `done` event, and no `delta` frames are fabricated.
- **Vertex accepts a service-account JSON, not an express-mode API key.** The service-account
  chain is the one Vertex documents for a project principal; express mode is a separate, narrower
  surface and is not implemented.
- **Azure discovery is a model list, not a deployment list.** Azure exposes deployment listing only
  through the ARM management plane; the data-plane `/openai/v1/models` response is the resource's
  models. The v1 chat API names the **deployment** in `model`, so the connection needs a deployment
  whose name matches the selected id. The hint in Provider Settings says this, and a missing
  deployment fails with Azure's own not-found error rather than being silently substituted.
- **Thirteen media providers remain `pending`.** Every remaining pending entry is a media or
  local-model vendor with no adapter; adding a connection for one is `400 adapter_pending`, not
  accepted and quietly broken.
- **Video is one vendor and one prompt mode.** Only text-to-video through Veo is implemented. There
  is no image-to-video, extension or second video vendor, and no storyboard or edit route.
- **A restart interrupts an in-flight video.** The queue persists terminal records and marks a job
  interrupted mid-render as `failed` with `interrupted`; it does not resume a provider operation
  whose name was not durably stored. A completed clip and its record survive a restart.
- **Video downloads follow one redirect rule and no others.** The gateway refuses redirects for
  every adapter. Google's file URI is fetched directly; an underlying storage redirect would fail
  honestly rather than being followed.
- **Image generation has one provider, and no image editing.** Only text-to-image through OpenAI
  Images is implemented. There is no inpainting, mask, variation or upscale route, and no second
  image vendor. The Image area says which connection it used and never presents a stored sample.
- **Images are generated once per job; retries are explicit.** A failed job is a record with an
  error, not a background retry loop. Deleting a job removes the record and the stored bytes.
- **A catalogue id is usable when its wire is implemented and its status is not `pending`.** All
  nine wires are implemented, so the eleven `ready` entries and the thirteen `gateway_only` entries
  can be saved.
- **The UI cannot configure a pending provider.** That is deliberate: a control that cannot work is
  a claim that it can.
- **A style is a preference, never an inference.** The chat route reads the stored value or sends
  no style instruction; it does not inspect the message for a mood. The estimator in
  `adaptive/wording.mjs` still exists as a library and is not reachable from chat.
- **The style audit reads the reply text, not the model's intent.** It finds the listed patterns;
  it cannot prove a sentence has no manipulative effect. A soft finding is returned with a warning
  and the answer is shown unchanged; a claim of consciousness, dependence, manipulation, invented
  emotional history or an inferred sensitive attribute is refused and discarded. There is no
  automatic retry, so the user chooses whether to try again.
- **The style preference is per account, not per conversation.** Changing it applies to the next
  message; earlier turns are not re-rendered.

## 10. Remaining work, ranked

1. A live verification run for the six native adapters: one real request each, recorded with date,
   model and response digest. Until then their status means "tested code path", not "verified
   vendor".
2. Bedrock streaming through the AWS event-stream framing, if the product needs it; until then the
   limitation is stated rather than hidden.
3. A live verification run for the image and video adapters: one paid generation each, recorded
   with date, model, prompt digest and response digest. Until then `openai-images` and `veo` mean
   "tested code path".
4. A second image vendor, image editing, and a second video vendor (Runway, Luma, fal.ai video or
   Replicate video), so neither area is one vendor's surface.
5. Resume of an in-flight video operation after a restart, if the product needs it; until then the
   interruption is recorded rather than hidden.
6. Provider health checks and usage accounting surfaced in the five areas.
7. Product routes for the adaptive core's measured loop, which remains a library; the style
   estimator is deliberately not one of them.

## 11. Tests

```
npm run test:core                      # includes test/provider-framework.test.mjs
node --test services/core/test/online.test.mjs          # 29 tests, including schema 2
node --test services/core/test/online-runtimes.test.mjs # 10 tests
node --test services/core/test/online-wires.test.mjs    # 20 contract tests, six native chat wires plus SigV4
node --test services/core/test/online-image.test.mjs    # 9 tests, the image wire and the durable job path
node --test services/core/test/online-video.test.mjs    # 9 tests, Veo polling, download policy and cancellation
node --test services/core/test/online-skills.test.mjs   # 9 tests, install, review, versions and chat selection
node --test services/core/test/online-styles.test.mjs   # 8 tests, preferences, instructions, audit and refusal
node --test services/core/test/provider-framework.test.mjs
npm run test:web                       # includes the catalogue and saved-connection renders
```
