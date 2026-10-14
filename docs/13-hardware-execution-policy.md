# Klyvaron Lite × Pro × Max — hardware-based execution policy

This is the controlling execution policy. **Max replaces the former High name**
in the family API, product specification and export CLI. Historical model cards
and experimental measurements are not rewritten. A tier name is never proof of
quality, model ownership, installed weights, GPU compatibility or readiness.

**Lite prioritizes accessibility. Pro prioritizes capable GPU hardware. Max
prioritizes high-performance GPU hardware.** Local execution targets the user's
own device, not mandatory company GPUs. No tier requires a company account or
company GPU to execute installed local weights.

## Tier requirements

| Tier | Target and execution contract | Workload priorities |
|---|---|---|
| Lite | CPU-first on modest laptops/desktops, systems without dedicated graphics, and supported Android/iOS installations. Compact quantized weights and a compatible CPU runtime; no CUDA or accelerator requirement. Minimize memory, disk, startup and CPU consumption. | Basic conversation, summarization, writing, supported translation, simple coding and lightweight tasks. Prefer local retrieval and ordinary CPU tools. Useful offline once assets are installed; demanding reasoning and advanced media are not guaranteed. |
| Pro | Local by default on a GPU-qualified laptop/desktop. Verify backend, runtime, available VRAM/RAM, storage and the actual model/context configuration before enabling it. CPU assistance is permitted only for an evaluated configuration. | Stronger reasoning, coding, research, larger context and high-quality images. Video and other heavy workloads only when separately evaluated and supported. |
| Max | Local by default on a qualified high-performance GPU laptop/workstation. Highest evaluated compatibility profile in the family; validate model size, memory, runtime, storage, compute and workload. | Highest practical reasoning quality, demanding coding/research, advanced agents, image generation and supported video. Larger context/models and specialist models only when they fit. |

Max does not mean every task fits every powerful GPU. Multi-GPU support requires
runtime-confirmed placement and a measured benefit; memory on separate cards
cannot be blindly added together. No fixed family-wide VRAM minimum is specified
before models and configurations are selected and benchmarked.

Mobile Lite must remain **strictly below 5,000,000,000 bytes** of total
Aetheris-managed storage, including installed app assets, weights, optional models,
indexes, caches, media and retained data. At the limit is over budget. Never delete
user-owned data to make room. Native mobile release testing must account for the
app package as well as the complete managed data directory.

## Detection, recommendation and admission

At startup, inspect the device through OS APIs and runtime probes. Record CPU
architecture/type/instructions, available system memory, GPU/backend, total and
available VRAM where accessible, available disk space, OS/runtime compatibility
and changing resource availability. Unknown is not compatible.

`services/core/src/hardware/detect.mjs` currently uses Node OS APIs, `statfs`,
Linux CPU features and cgroup v2 memory limits, plus a bounded `nvidia-smi` probe
when installed. It does not require that utility. Runtime and other vendor/native
probes are extension points; GPU discovery alone does not verify an inference
runtime. `/api/hardware` and readiness expose the profile and recommendation.
Measurements describe the **Core host**. A phone browser connected to a server
has not become an on-phone inference runtime.

`hardware/admission.mjs` validates model-specific profiles. Profiles are trusted
release/operator inputs to the Core constructor (`modelProfiles`), **never HTTP
request fields**. No production profiles are supplied yet. A profile names:

- Model id, version, artifact SHA-256 and quantization.
- Tier, workload and evaluated context limit.
- Exact runtime id/version/backend, OS/architecture and required CPU instructions.
- Available RAM envelope, incremental disk requirement and memory per placed GPU.
- Benchmark command, report path, report SHA-256, a named compute metric and its
  minimum score. Max must exceed an evaluated Pro baseline **on the same metric
  and workload**, not necessarily tokens/second on different-sized models.

A trusted runtime probe must confirm that exact profile and artifact/report
identity, its runtime backend/version, measured compute score and device ids.
Multi-GPU placement additionally requires measured speedup greater than one.
The metadata validator does not run or authenticate benchmark reports: release
review must verify them before registering profiles. Test fixtures are synthetic
boundary conditions, not evidence that a real GPU model has qualified.

The recommendation is the highest installed, compatible profile, otherwise Lite
with `qualified: false`. No profile means no Pro/Max qualification. Runtime-ready
and benchmark-qualified are different states. `tierFitsHardware` no longer accepts
a workstation/laptop label as evidence. Qualified local tiers outrank cheaper
local candidates; a model preference cannot bypass admission.

Before routing each task, refresh resources. Reject incompatible model/workload,
context, RAM, VRAM, disk, runtime or compute. Offer available smaller/shorter
configurations with quality/context/speed trade-offs; do not silently change the
request into a remote upload. Responses expose rejections, fallback identity,
retryability and local alternatives. Preserve the task: browser drafts remain on
failure and existing session history records the user turn before execution,
including streaming. Headless clients without a session must retain their request
for retry. This is retry preservation, **not GPU/KV-cache checkpoint resumption**.

The existing CPU completion runtime additionally bounds weight-loading allocation
before reading weights, reduces its context under low RAM and checks scratch
memory before every forward pass. Context reduction is disclosed in responses and
stream events. Allocation bounds are not substituted for benchmark evidence.
Future GPU adapters must enforce the selected configuration, reserve resources
against concurrent execution, and re-probe during long workloads where supported.
Until those adapters and models are released, GPU execution remains unavailable.

## Execution modes and privacy

The Chat, Image and Video composers and their APIs accept `executionMode`:

| Mode | Behavior |
|---|---|
| `local` (default) | In-process/loopback inference on the Core device; no remote fallback. Install Core and assets on the user's device for on-device execution. |
| `hybrid` | Local Lite or qualified Pro/Max; remote candidates only after the user selects this mode and server policy/data authorization allows the send. |
| `online` | Only an explicitly configured remote provider, still subject to server policy and authorization. Never labelled local. |

These are task choices, not a browser override of server network policy.
`strict_offline` overrides every mode: only on-device loopback HTTP is reachable;
remote Internet **and LAN** services are blocked, even if allowlisted. HTTP
redirects are refused so an approved URL cannot forward a prompt to an unchecked
host. In-process computation and local tools continue to work. Exceeding local
capacity produces a limitation and an available local alternative, not an upload.

Non-loopback Ollama/OpenAI-compatible endpoints are labelled `online`, not local.
Their existing adapters can be explicitly configured remotely; no managed cloud,
image or video provider is bundled. A route's `execution.location`,
`execution.scope`, and `sentExternally` identify where it actually ran, including
streamed replies. GPU hardware is not inferred from endpoint reachability.

## Release benchmarks and company infrastructure

Use **Sparsiz and the designated training environment** for development,
fine-tuning, evaluation and release. Company GPUs may support authorized training
or optional centralized inference, but never gate locally installed tiers.
User GPUs must not perform company training, distributed computation or shared
inference without **separate explicit consent**; choosing Hybrid or installing a
local model is not that consent. No such shared-compute feature is enabled here.

For each release, commit a digest-bound benchmark report and reproducible command:
record artifact/runtime/build versions, device/backend/driver, OS, quantization,
context/batch or media workload, peak resident RAM/VRAM, disk/installation peak,
startup latency, throughput/compute metric, quality evaluation and repeated-run
results. Measure cold/warm starts, low-memory refusal, concurrent pressure and
long-running behavior. Review headroom and minimums from those measurements.
Re-evaluate when weights, runtime, quantization or workload changes. Never publish
synthetic test envelopes as real minimum hardware requirements.

## Acceptance evidence and remaining release gates

Run `npm run test:core`, `npm run test:web`, `npm run test:fabric` and
`npm run web:build`. Hardware boundary tests live in `hardware.test.mjs`; CPU
parity and real local HTTP responses in the `klyvaron-*` tests; egress tests prove
refusal before a network call. Rendering tests cover the execution selectors.

| Acceptance condition | Current evidence / remaining work |
|---|---|
| Actual local CPU responses, no dedicated GPU | Float32 and resident-int8 CPU completion paths have numerical and local execution tests. The released model is still a float32 base model, not an instruction-tuned assistant. |
| Useful quantized Lite assistant | **Not delivered**: requires suitable licensed assistant weights and release/device benchmarks. The int8 format/runtime and relative quality gate are implemented; see [CPU int8 inference](./14-cpu-int8-inference.md). Do not present the current toy completion model as useful conversation/translation/coding. |
| Pro enabled only when model fits | Admission tests cover backend/runtime, per-GPU VRAM, available RAM/disk, context and benchmark identity. **No Pro release or production GPU probe adapter yet.** |
| Max higher compatibility profile | Tests enforce the higher compute baseline and evaluated workload. **No Max weights or real GPU benchmarks yet.** |
| Honest local execution and fallback | On-Core CPU inference; explicit modes, LAN reclassification, stream location metadata, retained drafts and no implicit upload. |
| Insufficient resources rejected | Allocation checks before CPU loading/inference; synthetic profile boundaries for GPU tiers. Hardware races and GPU reservations require native adapter testing. |
| Mobile storage below 5 GB | Strict boundary tests; footprint and installation admission count the wider managed directory as well as model categories. **Native Android/iOS packaging and all-write mobile storage enforcement are not built.** A browser connected to Core is not a mobile installation. |
| Measurement-based hardware profiles | Required evidence schema and fail-closed GPU qualification; **real release profiles remain a benchmark gate**, not a marketing name or fabricated number. |

**Final rule:** Lite makes AI accessible on modest hardware; Pro unlocks stronger
local AI on capable GPU computers; Max unlocks demanding local AI on qualified
high-performance GPU computers. These are release requirements, not a claim that
unbuilt models already satisfy them.
