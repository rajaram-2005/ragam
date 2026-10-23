# Changelog

Every entry below is a claim about what the repository contains, and each one is checked by
`services/core/src/release/manifest.mjs` against the files and the measured suites — a version with
no entry here cannot be released, and an entry is not a substitute for the tests.

## Unreleased — universal provider framework (phases 1–3)

**Direction (2026-10-17): online-first.** The product requires connectivity for its AI
functionality. Offline operation and OS-level network isolation are not requirements; local
runtimes remain optional self-hosted integrations. Security controls (SSRF filtering, redirect
refusal, origin allowlists, deadlines, encrypted credentials) remain because they make online
requests safe.

Not in 0.2.0. On this branch only.

- **First-party Klyvaron Pro & Max multimodal build across Chat, Image, Video, and Voice.**
  Separates `PRODUCT_SUBSCRIPTION_TIERS`, 8 `KLYVARON_MODEL_IDENTITIES`
  (`klyvaron-{pro,max}-{lm,image,video,voice}@0.1.0`), and programmatic `RUNTIME_READINESS_STATES`
  (`ready`, `partially_available`, `missing_artifact`, `runtime_unqualified`, `training_required`,
  `unsupported_hardware`) in `services/core/src/klyvaron/tiers.mjs`. Trains, evaluates, and
  installs SHA-256-verified first-party checkpoints from random initialisation for
  `aetheris-core-v1`, `aetheris-image-v1` (generation, editing, understanding),
  `aetheris-video-v1` (short-clip multi-frame H.264 `.mp4` generation and temporal understanding),
  and `aetheris-voice-v1` (16 kHz WAV speech transcription and synthesis), with persistent
  component-keyed runtime qualification (`services/core/src/klyvaron/qualification.mjs`), separate
  Pro and Max capability manifests, multimodal user-computer training/adapter engines, and 5-area
  UI/API integration (`Chat`, `Image`, `Video`, `Plugins`, `MCP`).

- **Klyvaron user-computer-first training architecture & first-party Pro/Max release verification.**
  Adds `UserTrainingController` (`services/core/src/klyvaron/training-controller.mjs`), the
  authenticated cross-platform local worker (`services/core/src/klyvaron/local-worker.mjs`,
  `npm run worker`), first-party analytical LoRA / full-fine-tune / foundation engines
  (`services/fabric/fabric/lm/adapter.py`), hot adapter activation & rollback in `KlyvaronRuntime`
  and `NativeKlyvaronHost`, and `UserTrainingPanel` in Chat. Enforces `localWorkerConnected: false`
  by default, single-use pairing + constant-time Bearer RPC auth, directory confinement, zero shell
  execution, non-silent full-to-adapter downgrade approval, hard 120-second interactive adapter cap
  including finalization (uncapped for separate foundation sessions), 9 separate release gate
  fields, and live SHA-256-verified `klyvaron-pro-lm` (27.56M) and `klyvaron-max-lm` (92.08M)
  int8 artifacts.

- A 39-entry provider catalogue with a status per entry and **evidence per capability**: `ready`
  means a tested code path, `gateway_only` means the wire format is implemented and the vendor is
  not verified, `pending` means an adapter does not exist and selection refuses it by name.
- Capability selection with explainable refusals: strict offline refuses a remote request before any
  candidate is considered, and an unrecorded context limit does not satisfy a stated minimum.
- Error normalisation with retry classification and redaction of six credential shapes.
- `GET /api/providers/catalog` (session-gated, secret-free) and a read-only capability matrix in
  Provider Settings.
- **Nine native image adapters and five native video adapters.** OpenAI Images and Gemini Images
  keep their inline-byte path; Stability returns raw `image/*` bytes; Recraft asks for `b64_json`;
  Ideogram supports its synchronous result and its asynchronous `generation_id`; FLUX polls the
  provider-supplied `polling_url`; fal submits to the queue and polls its own URLs; Replicate polls
  a prediction's `urls.get`; Firefly exchanges a two-part client credential for a cached IMS token.
  Video adds Runway (version header and task polling), Luma (generation polling), fal video and
  Replicate video. Every adapter refuses a provider URL on a foreign origin instead of sending the
  key there, and no CDN/download hop carries a credential.
- **Klyvaron tiers are pointers with provenance.** `GET /api/klyvaron` lists Lite, Pro and Max
  with `independentWeights: false`, and each preset resolves to a saved connection and a listed
  model. `PUT /api/klyvaron/<tier>` is owner-only, refuses an unlisted model (`model_unlisted`), a
  wrong modality (`klyvaron_tier_modality`) and an unconfigured connection, and bumps the store
  revision so the next chat re-consents. Chat accepts `tier` and returns
  `klyvaron: { tier, provenance }`; image and video jobs store `params.tier` and
  `params.provenance`. A tier with no preset refuses with `klyvaron_tier_unconfigured`; it never
  falls back to another model. Provider Settings gains a read-and-assign panel that names the
  third-party provider and model behind every tier.
- **The Image and Video areas follow the wire's modality, not a vendor id.** A connection's
  `SIZES`/`ASPECT_RATIOS`/`RESOLUTIONS` are published by its adapter; an empty list hides the
  control and the request omits it. Readiness names the exact connection and wire a media request
  will use.
- **Media contract tests.** `test/online-media-wires.test.mjs` exercises each adapter's request
  shape, credential header, polling/download separation and failure paths, then drives the real
  Image and Video routes through a local Stability/Runway fixture with a real PNG and a 9 KB MP4.

- **Several saved connections (store schema 2).** Each connection keeps its own encrypted key, model
  list, selected model and verification record; one is active. A schema-1 file migrates on read with
  its key and revision preserved, and is rewritten in the new shape.
- **Custom OpenAI-compatible endpoints.** `custom` and `custom-<name>` are first-class keyless
  connections, so a compatible server that is not in the catalogue does not have to masquerade as one
  that is. Catalogue ids resolve through the same path: `wire: 'openai_chat'` is admitted, `pending`
  is refused with `adapter_pending`, and an invented id is `invalid_runtime`.
- **`PUT /api/providers/active`** switches connections without rewriting a credential, and a probe
  (`POST /api/providers/<id>/test`) reads and writes only the connection it names — a key is never
  spent on another vendor's endpoint.
- **Six native adapters, each speaking its vendor's published wire.** Anthropic Messages
  (`x-api-key` + `anthropic-version`, top-level `system`), Gemini generateContent (model in the
  path, `x-goog-api-key`, `contents`/`systemInstruction`, `?alt=sse`), Cohere Chat v2 (Bearer,
  `message.content[]`, typed SSE ending at `message-end`, paginated `/v1/models`), Azure OpenAI v1
  (`api-key`, `/openai/v1`, the deployment name in `model`, no `api-version`), Vertex AI (a
  service-account JWT exchanged for a cached OAuth token, regional `generateContent`, v1beta1
  publisher-model discovery) and Bedrock Converse (SigV4, IAM credential JSON, non-streaming by
  contract). A stream that ends before its protocol's completion signal is `provider_interrupted`,
  never a short answer.
- **Credentials stay one encrypted string per connection.** A structured credential — a
  service-account JSON or `{accessKeyId, secretAccessKey, sessionToken?, region?}` — is validated
  by its wire and compacted before sealing, so an unusable document fails at save time. The
  catalogue and `public()` expose the credential *kind*, never a value.
- **Contract tests, not vendor calls.** `test/online-wires.test.mjs` runs every adapter against
  local fixtures that return the documented response shapes and records the exact headers and
  bodies the product sent, including a SigV4 signature checked against AWS's published worked
  example. All six native adapters are `ready` in the catalogue — a tested code path — and the matrix
  says in as many words that no vendor has been called.
- No live provider call was made. The nine `pending` entries are media and local-model vendors; see
  `docs/27-provider-framework.md` for the audited status.

### Image generation (phase 3)

- **OpenAI Images is a real adapter, not a placeholder.** `openai_images` posts
  `{base}/images/generations` with an explicit model, `n: 1` and an allowed size, decodes
  `data[0].b64_json` and accepts the artifact only if the bytes re-encode to the same container.
  A URL-only response, a non-image payload or a truncated base64 value is `invalid_completion`;
  the returned URL is never fetched.
- **Image jobs are durable, asynchronous and per account.** `POST /api/image/generate` returns
  `202` with a job record; `GET /api/image/jobs` and `GET /api/image/jobs/<id>` report it;
  `GET /api/image/jobs/<id>/content` serves the stored bytes with `nosniff` and a sandbox CSP; and
  `DELETE` removes the record and the artifact. The queue persists terminal records atomically and
  marks an interrupted job as failed with `interrupted` instead of replaying it as running.
- **The Image area is a provider surface.** It polls the job list, renders only succeeded jobs,
  shows the prompt, provider, model, digest and size, and keeps a failed job visible with its
  reason and no image element. A chat connection cannot be used as an image provider, and an image
  connection refuses chat with `capability_unavailable` before contacting the vendor.
- **Tests:** `services/core/test/online-image.test.mjs` (9 tests) covers the request shape, base64
  decoding and tamper rejection, URL-only and non-image responses, per-account isolation, deletion,
  restart persistence and the prompt/size/model refusals. No vendor was called.

### Video generation (phase 4)

- **Google Veo is a real adapter with a real asynchronous lifecycle.** `gemini_veo` starts
  `models/{model}:predictLongRunning`, polls the operation with a bounded cancellable loop, and
  downloads the finished file as bytes. The API key is sent only to the API origin; a file URI on
  another host is fetched without it, and a redirect is refused.
- **The artifact is measured, not asserted.** The MP4 container must validate, `assertGenuineVideo`
  rejects a still image or a stub, and duration is read from `moov/mvhd`. The job records the model,
  platform, requested aspect ratio and resolution, measured duration, byte length and digest.
- **Video jobs are durable, per account and cancellable.** `POST /api/video/generate` returns 202;
  `GET /api/video/jobs[.id]` reports it; `.../content` serves the stored bytes; `.../cancel` aborts
  the live provider request; `DELETE` removes the record and the artifact. A terminal job survives a
  restart; an interrupted one is recorded as `failed` with `interrupted`, never replayed.
- **The catalogue now names the video market.** `veo` is `ready`; Runway, Luma, fal.ai video and
  Replicate video are `pending` and refused by name rather than silently missing.
- **Tests:** `services/core/test/online-video.test.mjs` (9 tests) covers model discovery, the
  operation request, polling, binary download, credential non-leakage to a second host, redirect
  refusal, cancellation, pre-queue validation, failed/filtered/still-image outcomes and the
  transport's binary ceiling. No vendor was called.

### A working MCP and plugin surface (phase 9)

- **The MCP area now shows the servers this build actually registers.** `installation-docs` is a
  reviewed in-process server with two read-only tools (`list-documents`, `read-document`); reads are
  bounded to 20,000 characters, the directory is resolved from the module rather than the working
  directory, and a name is checked against both a pattern and the resolved prefix. `aetheris.online`
  keeps the connection-status tool.
- **The gate is visible before the call.** The area lists servers, tools, risk, scopes, resources
  and prompts; "Check the gate" runs preflight and "Call" sends validated JSON arguments. Results
  are labelled untrusted data, with provenance, and cannot grant a permission or trigger a call.
- **Toggling a server is owner-only.** The MCP toggle and the plugin mutation routes now require the
  owner; a member can read the catalogue and call reviewed read-only tools, not change what is
  installed. The old MCP UI addressed `tool.server`, which does not exist, so its call button was
  broken; it now uses `serverId`.
- **Tests:** `services/core/test/online-mcp.test.mjs` (5 tests) covers the servers and tools,
  preflight, argument validation, the traversal refusal, the untrusted provenance label, the owner
  gate, a disabled server and the plugin surface. The Plugins and MCP render tests move with the
  new empty-state text.

### A second image provider: Gemini Images (phase 8)

- **Image generation is no longer one vendor.** `providers/wires/gemini-images.mjs` implements the
  documented Gemini image request (`generateContent` with `responseModalities: ["IMAGE"]`) and reads
  the image from `candidates[].content.parts[].inlineData`. The catalogue gains `gemini-images` as a
  ready entry with an `x-goog-api-key` credential, and the Image area reaches it through the same
  durable job path as OpenAI Images.
- **The route chooses by modality, not by a hard-coded id.** Any saved connection whose wire
  generates images is eligible; when both are saved, OpenAI Images keeps an existing installation's
  choice stable. A failed Gemini generation is a failed job with the provider's reason, never a
  stored placeholder.
- **Sizes map to aspect ratios explicitly.** `1024x1024`, `1536x1024` and `1024x1536` become `1:1`,
  `4:3` and `3:4`; `auto` sends no `imageConfig`. A size that no ratio expresses is refused.
- **Tests:** `services/core/test/online-gemini-images.test.mjs` (3 tests) covers the model filter,
  the request shape and header, inline-byte decoding, refusals (missing image, wrong MIME, bad
  base64, unknown size, safety block), the saved-connection path, stored bytes and a failed job.

### Measured procedure comparison (phase 7)

- **A review is not a measurement.** `POST /api/skills/:name/measure` runs the same cases through
  the baseline and the candidate version, scores each answer deterministically against phrases it
  must and must not contain, and reports pass rates, latency and tokens for both.
- **Regressions come first.** A case the baseline passed and the candidate failed stops the verdict
  regardless of the aggregate. Equal scores are `no_difference_measured`, never an improvement; a
  sample that cannot distinguish two versions says so.
- **The record keeps the measurement, not the prompt.** `skills/measurements.jsonl` stores case ids,
  digests, checks and results; prompt text is never written. `GET /api/skills/:name` lists the last
  three measurements, and a restart keeps them.
- **It costs money and changes nothing.** Measurement requires the owner, explicit consent for the
  current gateway revision and a listed model; it never switches models and never promotes, enables
  or rolls back a version. The Chat panel's Measure button makes the two-call cost explicit.
- **Tests:** `services/core/test/online-skill-measure.test.mjs` (6 tests) covers an improvement, a
  regression, a no-difference verdict, owner-only access, consent, an unlisted model, invalid cases
  and durability across a restart.

### Response styles (phase 6)

- **A style is a preference the person sets, not a guess about how they feel.** Seven styles
  (supportive, focused, curious, cautious, reflective, playful, technical) are stored per account
  by `PUT /api/styles`; the chat route reads that value and sends one short instruction. There is no
  route that infers a style, and the adaptive estimator in `adaptive/wording.mjs` remains a library.
- **The instruction carries its own boundary.** Every style includes the same prohibitions: no
  claimed feelings, consciousness, memories or relationship; no flattery, pressure or manufactured
  urgency; and no implication that tone changes a fact, the evidence or a permission.
- **The reply is audited, and findings are visible.** `auditWording` runs on every styled reply.
  A soft finding (an idiomatic "happy to help", a superlative) is returned with the text unchanged
  and a warning the UI shows; a claim of consciousness, dependence, manipulation, invented
  emotional history or an inferred sensitive attribute is refused with `style_violation` and the
  text is discarded, not stored and not counted.
- **Tests:** `services/core/test/online-styles.test.mjs` (8 tests) covers the seven ids, the
  default of no instruction, no inference from an emotional message, per-account durability across
  a restart, an unreadable preference, the instruction reaching the provider, an invalid style
  failing before any provider call, a soft warning, a hard refusal with an empty history, and
  authentication.


### Reviewed procedures (phase 5)

- **Skills are a product surface, not a library-only module.** `GET /api/skills` lists every
  procedure with its version, state, declared scope and usage; the owner installs a structured
  document and promotes a candidate through a **named structural review** (parses, at least two
  steps, scope declared, no network). A new version is a candidate again, and a rollback restores
  the text without inheriting a review it never had.
- **A procedure is text, not code.** A validated, text-only procedure can be selected for one chat
  message; its steps are sent as reference material with an explicit boundary, and usage is counted
  only when the provider answers. A document that declares file or network access is refused with
  `skill_requires_executor` because this product has no executor to grant the scope.
- **Deletion is a deletion with a tombstone.** The document and its versions are removed; a
  restart does not reseed a deleted built-in, and the tombstone records the act, never the content.
- **Built-ins are reviewed procedures:** evidence-first answers, incident triage and release audit,
  each installed as a candidate, structurally reviewed and stored with `createdBy: bundled`.
- **Tests:** `services/core/test/online-skills.test.mjs` (9 tests) covers the built-ins, the
  candidate gate, owner-only mutation, member selection, version reset and rollback, disabled and
  permission-bearing refusals, deletion and restart persistence.

## [0.2.0] — 2026-10-17

The adaptive intelligence work, phases 1–10 of the directive: capability profiles over one shared
adaptive core rather than one model per tier, with every phase shipped as code, tests, documentation
and a status record.

- **Adaptive core (phases 2).** Intent with the phrase that produced it, dependency-ordered plans
  with a digest, budgets that refuse to start work they cannot measure, atomic digest-chained
  checkpoints, a resumable runner, a router that decides on measured cost, and a loop that learns a
  skill only from a verified success and promotes it only when every recorded check passed.
- **Memory fabric (3).** Seven layers with assertion and verification held as separate records,
  required provenance, scope and readers enforced on read, and deletion that takes the provenance
  with it.
- **Skills with evaluation and permissions (4).** A candidate must pass every check the incumbent
  passed; a suite that dropped a test is rejected as `regression_not_run`, and a skill's declared
  permissions are the scope it runs with, not the caller's intentions.
- **Emotional interaction states (5).** Seven states with estimates reported as estimates, a
  correction store the user can withdraw, validated settings, and a render-time audit that refuses
  to emit claimed feelings, invented history or a failure described as a success.
- **Provider fabric (6).** Adapters declare what they serve; availability is measured, never
  assumed; one eligibility rule is shared by routing and probing, so a provider the policy forbids
  is never contacted; a request no single adapter covers is refused by name rather than split.
- **Plugin and MCP authority boundary (7).** Every tool, plugin, resource and prompt result carries
  provenance; an authority can only be minted from a user turn; a consequential action whose only
  reason is data is refused — and a named test proves the gate does not depend on the classifier.
- **Image and video workflows (8).** Routed through the provider fabric, measured from the
  artifact's own header, with a still image refused as a video and unmeasured properties reported
  rather than assumed.
- **Industry packs (9).** Packs add vocabulary, refusals, review requirements and restrictions;
  they cannot widen a policy, grant a permission or authorise an action, and a pack whose
  capability this installation lacks is refused by name.
- **Benchmark and release (10).** A measured benchmark of the adaptive core modules, and a release
  verifier that refuses a version whose documents disagree with the measured suites.

**Not in this release.** The adaptive core is not reachable from the product: no HTTP route calls
the loop, the memory fabric, the provider fabric, the authority boundary, the media workflow or the
packs. The online product still refuses image and video generation with its own limitation codes.
`klyvaron-pro-lm` and `klyvaron-max-lm` remain unbuilt, and the `klyvaron-mini-lm@0.2.0` training
run remains parked with its record in `docs/experiments/`.

## [0.1.0] — 2026-10-04

The online-only product: accounts and sign-in, a LiteLLM-gated chat, the knowledge pipeline, media
jobs with validation, plugins and MCP with approval gates, the model registry and router, and the
Aetheris Lite language model with its release gate and training service.
