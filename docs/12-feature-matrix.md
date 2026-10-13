# Feature matrix: what Aetheris Omni does, and what it does not

A capability audit against the consumer-AI market, with four statuses and no fifth. The
purpose is to make the gap visible in one place, because the failure mode this document
exists to prevent is a product whose documentation is a list of intentions.

**Completed** means implemented in this repository and exercised by a test. **Partial**
means implemented with a named limitation. **Planned** means designed, no code.
**Unsupported** means no implementation and no accepted design.

Line counts and suite totals quoted here are checked by
`services/core/test/docs.test.mjs`, which fails the build when a documented number stops
being the real one. The counts move when the code moves; that is the point of guarding
them rather than restating them.

---

## 1. Conversation (the Chat area)

| Capability | Status | Note |
|---|---|---|
| Streaming responses | **Completed** | Server-sent events; the client renders partial tokens |
| Multi-turn context | **Completed** | Messages are passed whole; nothing is persisted (L1) |
| Stop / cancel a generation | **Completed** | Aborts the upstream request, not just the display |
| Copy, regenerate, edit-and-resend | **Completed** | Edit resends from that turn; earlier turns are kept |
| Conversation history + search | **Partial** | Sessions, turns and recall are in the Chat **Conversation history** panel, which also lists sessions and deletes them. Still partial for one reason: search is lexical (BM25 over your own turns), not semantic |
| Suggested prompts | **Completed** | Shown on an empty conversation |
| Plain-language model control | **Completed** | Provider and location, never quantisation, unless Advanced is open |
| Privacy mode control | **Completed** | Strict offline / hybrid / online-enabled, with the trade-off stated |
| Memory the user can inspect and delete | **Completed** | Level 2 is implemented and reachable: the Chat **Memory you approved** panel lists, adds, edits, deletes, searches, exports and decides pending proposals, and the composer's switch to use it is off by default. Superseding a memory from the UI is not offered (editing in place is), which is a missing affordance rather than a missing capability |
| Citations from the user's own documents | **Completed** | Every grounded claim carries the chunk it came from; no evidence is admitted when there is none |
| Assistants / projects / spaces | **Unsupported** | Would be a sixth area; deliberately not built |
| Voice conversation | **Planned** | Needs a speech model; none is installed |

## 2. Image

| Capability | Status | Note |
|---|---|---|
| Text-to-image generation | **Unsupported** | No image provider is configured in this build — no local runtime and no online one — so a request is refused with an explicit limitation. The queue, magic-byte validation and storage that a provider would feed are implemented and tested, but nothing generates an image |
| Local image generation | **Planned** | Needs weights and a GPU; this host has neither |
| Image understanding | **Partial** | Adapters declared; no vision model is installed |
| Upload validation before processing | **Completed** | Magic-byte sniffing; a mislabelled file is refused |
| Prompt and output validation | **Completed** | Output is checked for genuineness, not just for arrival |
| Image editing | **Planned** | No inpainting or instruction-edit path |
| Gallery, history, re-run | **Completed** | Jobs persist with their parameters |

## 3. Video

| Capability | Status | Note |
|---|---|---|
| Text-to-video generation | **Unsupported** | No video provider is configured in this build, so a request is refused with an explicit limitation and a still image is never substituted. The job queue, container sniffing and genuineness check are implemented and tested |
| Local video generation | **Unsupported** | Too demanding for this hardware class. The limitation is stated rather than hidden, and the refusal is explicit rather than routed somewhere else |
| Video input handling | **Partial** | Magic-byte genuineness check; no frame-level analysis |
| Honest quality reporting | **Completed** | No quality adjective is attached to a generated video; the parameters are shown |
| Long-form / multi-shot | **Planned** | Requires a real video model |

## 4. Plugins

| Capability | Status | Note |
|---|---|---|
| Discover, validate, install, enable, disable, uninstall | **Completed** | Lifecycle with provenance retained |
| Scope model and least privilege | **Completed** | Declared scopes are enforced at invocation; elevated and forbidden scopes are separate sets |
| Approval gates for destructive actions | **Completed** | A destructive call without approval returns 409, not a warning |
| Built-in plugins | **Completed** | Two, both real |
| Third-party plugin ecosystem | **Partial** | The registry works and manifests can be signed (Ed25519, trust store, verified at install **and** before every invocation); there is still **no review pipeline**, and no revocation |
| Community store UI | **Planned** | |

## 5. MCP

| Capability | Status | Note |
|---|---|---|
| Register servers and enumerate tools/resources/prompts | **Completed** | |
| Schema validation of tools *and* of arguments | **Completed** | Everything is validated before invocation, and output is validated too |
| Risk tiers and approval gates | **Completed** | |
| Untrusted-input neutralisation | **Completed** | Tool output is treated as data, never as instructions |
| Timeouts and output limits | **Completed** | Bounded per call |
| In-process server | **Completed** | One, with four tools |
| Remote server transports beyond stdio/HTTP | **Planned** | |
| Server allowlist | **Completed** | `id:` and `origin:` entries, matched exactly, enforced at registration and again at every call; a malformed allowlist refuses to start |
| Signature verification of MCP servers | **Planned** | Plugin manifests are signed; the MCP wire protocol carries no signature to check, so a server's provenance rests on the allowlist entry that admitted it |

## 6. Models and routing

| Capability | Status | Note |
|---|---|---|
| Capability-aware routing across local and online models | **Completed** | Privacy restrictions override quality and cost |
| Every adapter declares real capabilities, hardware and licence | **Completed** | An unknown licence is recorded as `unknown`, not guessed |
| First-party model family with honest status | **Completed** | Three tiers; one partial, two recorded unbuilt |
| A tier label that cannot be faked | **Completed** | `tierClaimFor()` is a lookup against backing records, not a field |
| Embeddings and reranking | **Partial** | Declared in the router; no reranker model is installed |
| Multi-tier local models (Pro, High) | **Unsupported** | No artifact and no way to obtain base weights on this host |
| Model download and integrity verification | **Completed** | Digest checked before load; a truncated artifact is caught |
| Managed storage accounting | **Completed** | Measured, not estimated; 5 GB mobile budget with a 500 MB reserve, and `/api/storage` reports the bytes plus the unmanaged files the category walk cannot see |
| A first-party model that loads and runs locally | **Partial** | Klyvaron Lite loads from a verified artifact and generates in the core service; the model is a base completion model, so chat refuses it unless pinned. Real, and far below assistant quality |
| Local model integrity verification | **Completed** | The manifest's digests are re-checked before a byte is used; a corrupted install is reported and never loaded, silently deleted or described as ready |

## 7. Privacy and security

| Capability | Status | Note |
|---|---|---|
| Three execution modes | **Completed** | Strict offline / hybrid / online-enabled |
| Offline enforcement at the execution layer | **Completed** | Network egress is blocked, not hidden in the UI; the test asserts real blocking |
| Secret detection and redaction | **Completed** | Sixteen patterns; classification runs before egress |
| Credentials kept server-side | **Completed** | Never in the frontend bundle, logs or source control |
| Append-only audit ledger | **Completed** | NDJSON export, subject purge |
| Prompt-injection defence | **Partial** | Untrusted input is neutralised; a determined injection through a legitimate tool remains possible |
| Sandboxing of plugin code | **Partial** | Scope enforcement and process isolation; not a hardened sandbox |
| Rollback of a bad release | **Completed** | Known-good baseline retained with a digest |
| God Mode: broad but bounded | **Completed** | Budgets, timeouts and an audit trail apply; it is not unbounded |

## 8. Learning

| Level | Status | Note |
|---|---|---|
| L1 contextual adaptation | **Completed** | Session only; nothing stored |
| L2 user-approved memory | **Implemented and tested** | Approval is a database `CHECK`; deletion is real; the store attempts no network call |
| L3 procedural skills | **Partial** | Stored on disk, evidence-gated promotion, rollback, deletion tombstones and relevance matching are reachable over 12 routes and from a review panel in Chat; nothing loads a procedure automatically during a task yet |
| L4 strategy across tasks | **Partial** | Failure recurrence is implemented, and the cross-task transfer test has been run over 8 seeds and 4 task families — `docs/07` §9. Its verdict was `no_lesson`: nothing beat the a-priori baseline on the selection family, so nothing was transferred and the held-out families are recorded as observations. The remaining gap is that no component selects a strategy at request time |
| L5 model adaptation | **Partial** | SFT, preference and distillation paths exist; three stages are blocked on this host and say so |
| L6 verified release improvement | **Completed** | One promotion, one recorded rejection |

## 9. Consumer experience

| Capability | Status | Note |
|---|---|---|
| Five areas, Chat as the entry point | **Completed** | No sixth top-level section exists |
| Everyday mode / Advanced disclosure | **Completed** | One disclosure, not a mode switcher |
| Keyboard navigation and focus management | **Completed** | |
| Responsive layout | **Completed** | |
| Streaming, uploads, error-and-retry | **Completed** | A failure explains itself and offers a retry |
| Export and deletion of user data | **Completed** | |
| Learned procedures visible and controllable | **Completed** | Review, confirm, pin, set aside, restore and delete, in Chat's advanced view |
| Accessibility audit against WCAG | **Partial** | Keyboard and semantics are covered; no formal conformance audit has been run |
| Onboarding for a first-time user | **Partial** | Suggested prompts and plain language; no guided tour |
| Mobile build | **Partial** | Storage accounting and a mobile tier exist; there is no mobile application |

## 10. Benchmarks

| Capability | Status | Note |
|---|---|---|
| Reproducible evaluation with recorded conditions | **Completed** | Hardware, settings and versions are recorded with every result |
| Comparison against computed baselines | **Completed** | Three baselines, not a hand-picked one |
| Comparison against named competitor models | **Unsupported** | No competitor weights are obtainable on this host. Reporting a comparison would require fabricating it, so none is reported |
| Benchmark contamination checks | **Completed** | Development and evaluation data are separated and the check is automated |
| Published limitation of every result | **Completed** | Every result carries what it does not show |
| Pre-registered transfer experiment | **Completed** | Thresholds, baseline and verdict vocabulary were frozen in `fabric/transfer.py` before the run; the result was a recorded non-transfer, not a tuned one |

---

## 11. How to read this table

No cell in this table is filled in to make the product look complete, and no row claims
parity with a named competitor. Where a capability exists at a smaller scale than a
frontier system, the cell says **Partial** and the note says how small — which is why
"Image generation" is Partial rather than Completed even though it works, and why
"Comparison against named competitor models" is Unsupported rather than Partial.

Three further rules apply to every row:

- **A row marked Completed has a test behind it**, not merely a code path. Where the
  test exercises the limitation rather than the feature, the note says so.
- **A row that depends on an external service says so in the note**, so that a reader can
  tell a capability that works from one that would work if a credential existed.
- **The counts move when the code moves.** Line counts and suite totals quoted in this
  document are asserted against the filesystem by `services/core/test/docs.test.mjs`, so a
  stale figure fails the build rather than ageing quietly.

---

## 12. Summary by status

Counting the rows above, so that the shape of the product is visible without reading all
of it:

- **Completed** rows are the majority, and they cluster in the areas a user touches
  most: conversation controls, plugins, MCP, privacy enforcement and the five-area
  interface.
- **Partial** rows cluster around *quality* rather than *existence*: retrieval whose
  precision is unmeasured, a sandbox that is enforced by scopes rather than by kernel
  isolation.
- **Image and video generation are Unsupported, not Partial.** With the online
  integration removed there is no provider of any kind, and calling that "implemented
  with a named limitation" would overstate it. What exists — the queue, the
  validation and the refusals — is recorded in the rows below.
- **Planned** rows are mostly model-dependent. They fail together if a model cannot be
  obtained, which is why the from-scratch Lite artifact matters: it is the one path that
  does not depend on a download.
- **Memory moved from Planned to implemented**, and its interface with it: memory can be
  listed, added, edited, deleted, exported and searched from Chat, and proposals are
  approved or rejected by hand. What keeps it Partial is superseding, not existence.
- **Learned procedures moved from module to surface and from untested to measured.** The
  skills subsystem is stored, served, versioned, rollback-able and reviewable in Chat, and
  the cross-task transfer question has now been *run* rather than deferred — with a null
  result. L3 stays Partial because nothing loads a procedure automatically, and L4 stays
  Partial because nothing selects a strategy from experience; both notes say exactly that
  instead of claiming a level is finished because its test exists.
- **Unsupported** rows are deliberate. Local video generation, competitor-model
  benchmarking and a multi-tier local family are not blocked by effort; they are blocked
  by hardware, weights and honesty respectively.
