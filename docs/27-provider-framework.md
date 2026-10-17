# 27 — Universal provider framework: audit, catalogue, and what is actually reachable

The master directive of 2026-10-17 asks for a universal provider architecture, a real Image and
Video pipeline, first-party Klyvaron integrations, memory and skills, adaptation, emotional
intelligence, Plugins/MCP, and verified offline operation — twelve phases, each independently
testable. This page records the audit that preceded the work, the provider framework built in this
increment, and the honest status of every other part.

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
| Provider setup UI (credentials, test, model list) | implemented for the three runtimes | `ProviderSettings.jsx`, `test/online.test.mjs` |
| Capability matrix in the UI | **implemented and tested (read-only)** | `ProviderCatalogue.jsx`, `test/render.test.mjs` |
| Catalog API | **implemented and tested** | `GET /api/providers/catalog` |
| Direct per-vendor chat adapters (Anthropic, Gemini, Bedrock, Vertex, Cohere, Azure) | planned | §4 — `pending`, refused by name |
| Other OpenAI-compatible vendors | implemented, awaiting live credentials | §4 — `gateway_only`; no vendor called |
| Image generation, editing, history | planned | product routes still refuse `not_implemented` |
| Video generation, async jobs, cancellation | planned | idem |
| Klyvaron Lite/Pro/Max runtime adapters | partially implemented | docs/24: two Lite artifacts released, Pro/Max unbuilt |
| Klyvaron Image / Video registries | planned | docs/22 records the modality roles; no weights exist |
| Persistent memory, provenance, deletion | implemented and tested (library) | `memory/fabric.mjs`; not on a route |
| Versioned skills, permissions, rollback | implemented and tested (library) | `skills/*` |
| Experience-driven adaptation, regression gates | implemented and tested (library) | `adaptive/loop.mjs`, `adaptive/episodes.mjs` |
| Emotional interaction states | implemented and tested (library) | `adaptive/wording.mjs` |
| Plugins and MCP least privilege | implemented and tested (library) | `plugins/*`, `mcp/*` |
| Strict offline enforcement | partially implemented | policy guard and fabric refuse; no OS-level network-isolation test |
| Live-provider verification | not possible here | no credentials, vendor hosts unreachable |

The library rows are not a dismissal: those modules have acceptance tests and records in
[docs/25](25-adaptive-intelligence.md). What they do not have is a product route, and the release
note says so.

---

## 3. The provider framework

Three modules, no sockets.

**`providers/catalog.mjs` — what exists, and what this build can prove.** Each descriptor carries an
id, label, category, wire format, auth kind, a documentation URL, a free-text note, an egress policy,
and a status:

| Status | Meaning | What it may claim |
|---|---|---|
| `ready` | a tested code path reaches it | capabilities whose evidence is a test in this repository |
| `gateway_only` | it speaks the OpenAI-compatible wire the transport implements | **nothing** — the capability list is empty by rule |
| `pending` | it needs a wire adapter this build does not have | nothing; it is refused by selection |

Validation is the enforcement: a `ready` entry whose capability is backed by a vendor document
rather than a test fails the build; a capability with no evidence source fails; an unknown field
fails, which is also how a credential is kept out of a descriptor (there is no field for one).

**`providers/select.mjs` — a decision, with reasons.** Requirements (capabilities, minimum context,
whether the request leaves the machine) are checked against the catalogue. Every candidate that does
not qualify is returned with a code and a sentence; there is no "best available". Strict offline
policy refuses a remote request before any candidate is considered. An unrecorded context limit does
not satisfy a stated minimum.

**`providers/errors.mjs` — one failure shape that cannot leak.** Status codes map to stable codes,
retryability is decided by code rather than by optimism, `Retry-After` is honoured and bounded, and
the message is redacted against six credential shapes before it is returned. A 429 whose body says
the account is out of credit is a quota failure, not a rate limit, because the advice differs.

**What is wired into the product.** `GET /api/providers/catalog` (session-gated, no credentials, no
model list) answers with the report and the descriptors; Provider Settings renders it as a
read-only matrix with three sentences and no controls.

---

## 4. Provider matrix

**33 entries — 3 ready, 14 reachable via an OpenAI-compatible endpoint, 16 pending.**

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
| `anthropic` — Anthropic Claude | pending | anthropic_messages | x_api_key | — | [docs](https://docs.anthropic.com/en/api/messages) |
| `gemini` — Google Gemini | pending | gemini_generate | bearer | — | [docs](https://ai.google.dev/api/generate-content) |
| `vertex` — Google Vertex AI | pending | gcp_vertex | gcp_adc | — | [docs](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference) |
| `cohere` — Cohere | pending | cohere_chat | bearer | — | [docs](https://docs.cohere.com/reference/chat) |
| `azure-openai` — Azure OpenAI | pending | openai_chat | x_api_key | — | [docs](https://learn.microsoft.com/en-us/azure/ai-services/openai/reference) |
| `bedrock` — Amazon Bedrock | pending | aws_bedrock | aws_sigv4 | — | [docs](https://docs.aws.amazon.com/bedrock/latest/APIReference/welcome.html) |
| `openai-images` — OpenAI Images | pending | — | bearer | — | [docs](https://platform.openai.com/docs/api-reference/images) |
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
compatible endpoint at these vendors, and nothing in this repository has done so. `pending` adapters
are refused by name — `adapter_pending` — even if a vendor documents the capability.

---

## 5. Image and video

Every media provider in the catalogue is `pending`, because no adapter exists:

| Area | Capability | Status | What happens today |
|---|---|---|---|
| Image | text-to-image, edit, variations, history | planned | The product returns `not_implemented`; `media/workflow.mjs` can route and measure, but no provider is registered |
| Video | text-to-video, image-to-video, jobs, cancel | planned | Same; the workflow refuses a still image presented as a video |

The Phase 8 workflow is real code with tests, and it is a *plumbing* claim: it refuses correctly and
measures what arrives. It is not a generation claim, and this increment does not turn it into one.

---

## 6. Klyvaron

- **Lite** has two released artifacts, both trained here and recorded with digests
  ([docs/08](08-aetheris-lite.md), [docs/24](24-own-models.md)).
- **Pro and Max** have no weights. Their `backend`, `train`, `evaluate` and `release` steps are open
  in `klyvaron/plan.mjs`; the plan reports them as open rather than as pending.
- **Klyvaron Image and Video** have modality *roles* in `klyvaron/architecture.mjs` and no
  artifacts. No model card claims one. There is no registry for them yet, because a registry of
  models that do not exist would be a fiction with good formatting.

---

## 7. Offline and security posture

What is proven by tests: the egress guard's policy matrix, the fabric's refusal to probe or route an
external adapter under `strict_offline`, the gateway's DNS/IP filtering and redirect refusal, CSRF
and origin checks on mutations, credential encryption at rest, and that the catalogue cannot carry a
secret.

What is **not** proven: OS-level network isolation. No test in this repository asserts that the
process cannot open a socket under strict offline; the guarantee is at the policy layer, and the
directive asks for an enforceable network policy. That gap is recorded rather than papered over, and
it is the first item in §9.

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
- **One sealed key per connection.** `key` is AES-256-GCM ciphertext under the same `master.key`
  (directory `0700`, file `0600`, atomic temp-file + rename). No API response returns it: `public()`
  reports `keyConfigured: true` and nothing else.
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
  every vendor outside the three tested runtimes.
- **No direct per-vendor adapter exists** beyond the OpenAI-compatible transport. Anthropic, Gemini,
  Bedrock, Vertex, Cohere and Azure need their own request builders; they are `pending`, and adding
  a connection for one is refused with `adapter_pending` rather than accepted and quietly broken.
- **A catalogue id is usable only when its `wire` is `openai_chat`.** The fourteen `gateway_only`
  entries that speak that wire can be saved against the implemented transport; the rest cannot.
- **The UI cannot configure a pending provider.** That is deliberate: a control that cannot work is
  a claim that it can.

## 10. Remaining work, ranked

1. Anthropic Messages and Gemini `generateContent` adapters, each with contract tests and a
   `ready` promotion that validation will only accept with a test behind it. This needs a raw
   request transport first: the current gateway only speaks the OpenAI chat wire.
2. Image generation through one verified provider, reusing `media/workflow.mjs` and the job queue.
3. Video generation, async lifecycle, cancellation and restart recovery.
4. An OS-level offline test (network namespace or a hooked DNS resolver), then strict offline can be
   called *verified* rather than *policy-enforced*.
5. Product routes for the adaptive core, which remains a library.

## 11. Tests

```
npm run test:core                      # includes test/provider-framework.test.mjs
node --test services/core/test/online.test.mjs          # 29 tests, including schema 2
node --test services/core/test/online-runtimes.test.mjs # 10 tests
node --test services/core/test/provider-framework.test.mjs
npm run test:web                       # includes the catalogue and saved-connection renders
```
