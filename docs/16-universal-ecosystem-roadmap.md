# Universal ecosystem directive: integration map and delivery plan

**Directive revision: 2026-10-14.** This extends the original integration scope.
Earlier “complete” labels describe those narrower increments, not completion of
the universal ecosystem. In particular, the previous decision to exclude online
providers is superseded: **LiteLLM is now the preferred planned inference gateway**.
It is not yet an implemented online inference service. FreeLLMAPI remains excluded.

## Identity and protected working state

- **Aetheris Omni** is the application, orchestration and permission layer;
  `rajaram-2005/Aetheris-` is its upstream application repository.
- **Klyvaron** is the first-party model family: Lite, Pro, Max. Derivatives must
  identify their base, licence, transformation and evaluation; quantization or
  fine-tuning is not original foundation-model pretraining.
- **Sparsiz** is the research/improvement source, integrated through the existing
  Fabric service and reproducible experiments rather than a blind repository merge.
- **Hermes Agent** is a reference for memory/skills/agent mechanisms, not an imported
  trusted runtime or a licence to execute arbitrary skill scripts.
- Work continues in the current `rajaram-2005/ragam` integration checkout on
  `arena/fe54d09a-ragam`. Existing uncommitted hardware, int8 and execution work is
  preserved. No upstream branch or repository was replaced or pushed.
- Exactly **Chat, Image, Video, Plugins, MCP** remain primary product areas.
  Catalogs, coding, agents, industries, memory and research stay contextual.

## Focused upstream re-audit

The earlier broad audits remain in [01](./01-audit.md) and
[10](./10-hermes-audit.md). For this increment, immutable upstream revisions were
retrieved and relevant source, interfaces, dependency/build manifests, tests and
licences inspected. This is a **targeted source review**, not a fresh execution of
all six upstream test suites, a dependency security certification or a production
compatibility claim. No upstream implementation was vendored or installed.

[Machine-readable audit evidence](./experiments/universe-source-audit.json) records
full revisions, per-file SHA-256, sizes and immutable source URLs.

| Source / pinned revision | Evidence and decision |
|---|---|
| Aetheris `bed29f4f98eb0be8b7bb7ae2488607765579dbfe` | MIT; `package.json`, `vite.config.js`, `src/main.jsx`, `test/runtimeApi.test.js`. Preserve React/HTTP service boundaries. Upstream's many navigation entries and prefilled architecture counters are not proof of verified universal capabilities and are not copied back into Omni. |
| Sparsiz `76ec6f0f0f501ea9fbf99f0769ef224d3dbc0d69` | Unlicense; `setup.py`, `SECURITY.md`, evaluation/failure-memory modules and routing tests. `evaluate_category()` uses random scores and `RedTeam.run_attacks()` random success: **prototype/simulation**, not acceptable release evidence. Preserve the existing NumPy-based measured Fabric path; do not install the entire Torch stack onto the CPU development host. |
| Hermes `1f6c02c07c697026888f1c66e634534fa2aae358` | MIT; `pyproject.toml`, `SECURITY.md`, `agent/memory_manager.py`, `tools/skills_tool.py`, interrupted-memory-sync tests. Memory providers and progressive skill disclosure are useful boundaries. Interrupted output must not become durable completed conversational truth. No automatic permission grants or script execution are adopted. |
| LiteLLM `148ca66ecb6b55bafefa738a8327654d0a347b08` | Root licence is MIT **except enterprise content**; `enterprise/LICENSE.md` has separate commercial terms. `pyproject.toml` reports 1.107.0. `proxy_server.py:model_list` exposes authenticated `/v1/models` and `/models`; listing depends on caller access and does not prove capability/readiness. Its own docstring directs richer metadata to `/model/info`. Use a replaceable service boundary; do not import enterprise code. No root `SECURITY.md` at this revision; this is not a statement that no upstream security process exists. |
| Ollama `8718c2bd2363c3f9f422d82bbad322bc2b791d60` | MIT; `go.mod`, routes/types and model-list tests. `/api/tags` uses `ListModelResponse`, which includes `remote_model` / `remote_host`. Cloud-backed entries cannot be called local because the daemon is on loopback. The local adapter now excludes those markers and removes obsolete discovered routes after successful enumeration. |
| Hugging Face Hub `a704b8488c6ec78f719c576ba77a6035095dae77` | Apache-2.0 **client software**, not blanket permission for hosted weights. `hf_api.py:ModelInfo/list_models`, tests, `setup.py`, `pyproject.toml`, `SECURITY.md`: model metadata includes revision, pipeline tag and optional card data; listing is paginated. Use bounded metadata reads, retain unknowns, never interpret a pipeline tag as proof of every modality or instruction following. |

LocalAI, llama.cpp, OpenVINO, vLLM, Transformers-specific deployments and each
provider's extra endpoints need their own applicable revision/licence/runtime audit
before new integration or qualification. A shared OpenAI-style endpoint shape is
not evidence that all those deployments have been tested.

### Development hardware boundary

The user reports an **Intel Core Ultra 5 laptop** as the intended first development
device. This session executes on a **Linux x64 sandbox**, measured as two Xeon CPU
cores and 4,131,278,848 bytes RAM, with no GPU qualification from the available
probe. It is not a measurement of that laptop. `/api/hardware` reports the actual
Core host when deployed there. Intel GPU/NPU availability, OpenVINO acceleration,
thermal behaviour and useful model latency remain unqualified. No fixed Pro/Max
VRAM minimum or CPU foundation-pretraining feasibility is asserted.

## Current deliverable map

| Requested deliverable | Actual status / boundary |
|---|---|
| 1. Repository integration map | **Implemented documentation**, with pinned focused audit above and earlier audits. Broader runtime/provider audits remain. |
| 2. Universal provider/model registry | **Partial; tested catalog foundation.** Versioned model metadata, manual refresh, source provenance, search, bounded cache and unknown-state handling. Not a complete model universe. |
| 3. Versioned adapters | **Partial.** New catalog adapter contracts `/1`; existing local inference adapters and Klyvaron worker path. No qualified universal inference adapter set. |
| 4. Capability router | **Implemented and tested foundation**; catalog entries never become routing candidates automatically. Provider-specific capability evidence/cost budgets remain. |
| 5. Local/Hybrid/Online policies | **Implemented and tested foundation**. Explicit authorization is separate from discovery; Strict Offline blocks external metadata sources as well as inference egress. |
| 6. Lite/Pro/Max pipeline | **Partial.** Original small CPU base model, artifact provenance, evaluated int8 conversion and numeric parity exist. Useful instruction-tuned Lite and measured Pro/Max releases are not delivered. |
| 7. Chat/Code/Image/Video | **Partial.** Local completion path and Chat UI exist; no qualified useful assistant, verified repository-editing agent, actual image-generation or video-generation backend is added here. |
| 8. Plugin/MCP stores | **Partial.** Existing manifests, permissions, preflight, signing, audit and local integration flows; not a universal extension marketplace or arbitrary-code sandbox. |
| 9. Industry agents/workflows | **Planned.** All requested industry packs need explicit tools, sources, model compatibility, permissions, risk controls, evaluations and limitations. No validated domain pack is claimed. |
| 10. Hermes-inspired memory/skills | **Partial; tested components.** User-approved memory, recall and versioned procedures exist. No unrestricted self-learning agent or automatic safe generalization claim. |
| 11. Sparsiz experience evolution | **Partial.** Fabric experiments/failure analysis exist; baseline comparison and held-out regression gates are mandatory. Upstream random scores are excluded. |
| 12. Training/distillation | **Partial; tested small CPU experiments.** Optional and governed; no private-data training consent or user GPU-sharing consent is inferred. |
| 13. Durable task execution | **Not delivered across process restart.** Current God Core checkpoints and pause/resume are in-memory. Worker cancellation is not durable task orchestration or resumable KV state. |
| 14. Security/privacy | **Partial; tested controls.** Existing policy, classification, permissions, audit, bounded artifacts and egress controls. Full multi-user/organization identity, arbitrary extension isolation and all-write/native storage enforcement remain. |
| 15. Benchmarks | **Partial.** Existing reproducible small-model tests and CPU smoke evidence; no verified broad industry/multimodal superiority or hardware profile. |
| 16. Automated checks | **Implemented and tested for current scope.** Catalog adds 20 Core tests and three Web tests; fixtures are labelled, not passed off as live provider qualification. |
| 17. Setup/troubleshooting | **Implemented documentation for current components**; new catalog configuration is in [17](./17-model-catalog.md). |
| 18. Provenance/licensing/cards | **Partial.** Existing first-party cards and new source hashes; catalog licence strings remain unreviewed. No automatic redistribution approval. |
| 19. Release/rollback | **Partial.** Existing artifact/skill versioning and rollback mechanisms; broader universal provider/plugin/model release qualification remains. |
| 20. Honest status | **This map plus docs/03.** Prototype, planned, fixture-tested, resource-blocked and deployed capabilities remain distinct. |

## Next reviewable increments, in dependency order

1. **Catalog foundation — this increment.** Fixed metadata adapters, no implicit
   network, provenance, failure/staleness, no inference-readiness promotion.
2. **Provider/inference contracts and LiteLLM gateway.** Explicit deployment and
   credential configuration; caller identity, data authorization, capability
   evidence, usage/budget accounting, bounded retry/cancellation and errors. Start
   with text; add each modality only after actual endpoint tests. A loopback proxy
   to remote providers is online execution, not local inference.
3. **Useful CPU Lite qualification.** Select a licensed model/runtime configuration,
   verify installation/storage, baseline quality and real hardware measurements.
   Hugging Face is outside this sandbox's outbound allowlist; weight availability
   is a current qualification blocker, not permission to fabricate results.
4. **Durable agent jobs.** Versioned persisted task state, idempotency keys, leases,
   bounded retries, checkpoints and restart recovery. Never replay consequential
   tool actions without verification or renewed approval where needed.
5. **Chat/Code + memory/skills/Sparsiz loop.** Workspace isolation, tested patches,
   verified tool results, explicit data rights and held-out regression gates.
6. **Real multimodal adapters and qualified Pro/Max configurations.** Images/video
   require genuine backend output and measured fit, not text-provider branding.
7. **Industry packs.** Begin with bounded, reviewable workflows and independently
   checked outputs. Regulated advice, financial actions and physical control need
   domain review/authorization; model output never bypasses interlocks.
8. **Hardening/release.** Multi-user policy, storage/native packaging, provider
   failure tests, repeatable measurements, provenance and rollback drills.

No new runtime is installed by default. No model weights, datasets or credentials
were downloaded, no paid provider was invoked, and no user/company data was sent
for inference or training in this increment. Catalog access is not inference consent.
