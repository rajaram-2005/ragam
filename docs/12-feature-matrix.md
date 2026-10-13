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
| Conversation history + search | **Partial** | Sessions persist locally; search covers text, not semantics |
| Suggested prompts | **Completed** | Shown on an empty conversation |
| Plain-language model control | **Completed** | Provider and location, never quantisation, unless Advanced is open |
| Privacy mode control | **Completed** | Strict offline / hybrid / online-enabled, with the trade-off stated |
| Memory the user can inspect and delete | **Planned** | Level 2. There is no memory module, so nothing can learn silently |
| Citations from the user's own documents | **Completed** | Every grounded claim carries the chunk it came from; no evidence is admitted when there is none |
| Assistants / projects / spaces | **Unsupported** | Would be a sixth area; deliberately not built |
| Voice conversation | **Planned** | Needs a speech model; none is installed |

## 2. Image

| Capability | Status | Note |
|---|---|---|
| Text-to-image generation | **Partial** | Works through the gateway (JSON response). *Requires external credentials* |
| Local image generation | **Planned** | Needs weights and a GPU; this host has neither |
| Image understanding | **Partial** | Adapters declared; no vision model is installed |
| Upload validation before processing | **Completed** | Magic-byte sniffing; a mislabelled file is refused |
| Prompt and output validation | **Completed** | Output is checked for genuineness, not just for arrival |
| Image editing | **Planned** | No inpainting or instruction-edit path |
| Gallery, history, re-run | **Completed** | Jobs persist with their parameters |

## 3. Video

| Capability | Status | Note |
|---|---|---|
| Text-to-video generation | **Partial** | Raw MP4 through the gateway. *Requires external credentials* |
| Local video generation | **Unsupported** | Too demanding for this hardware class. The limitation is stated rather than hidden, and the user is offered the online path as an explicit choice |
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
| Third-party plugin ecosystem | **Partial** | The registry works; there is no review pipeline or signing |
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
| Server allowlist / signature verification | **Planned** | |

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
| Managed storage accounting | **Completed** | Measured, not estimated; 5 GB mobile budget with a 500 MB reserve |

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
| L2 user-approved memory | **Planned** | No code |
| L3 procedural skills | **Completed** | Five invariants, each proven to bite |
| L4 strategy across tasks | **Partial** | Failure recurrence is implemented; cross-task transfer is not tested |
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
- **Partial** rows cluster around *quality* rather than *existence*: generation that
  depends on an external gateway, retrieval whose precision is unmeasured, a sandbox that
  is enforced by scopes rather than by kernel isolation.
- **Planned** rows are mostly model-dependent. They fail together if a model cannot be
  obtained, which is why the from-scratch Lite artifact matters: it is the one path that
  does not depend on a download.
- **Unsupported** rows are deliberate. Local video generation, competitor-model
  benchmarking and a multi-tier local family are not blocked by effort; they are blocked
  by hardware, weights and honesty respectively.
