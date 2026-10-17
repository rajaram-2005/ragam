# Release 0.2.0 — the adaptive core

Released **2026-10-17**. This page is the release note, and it is also a claim: every number below
is checked by `services/core/src/release/manifest.mjs`, and a version whose documents disagree with
the measured suites cannot be released.

## What this release is

One shared adaptive core behind Lite, Pro and Max, with capability profiles computed from the
hardware, models, tools, permissions and services a machine actually has — instead of one trained
model per tier. Ten phases, each shipped as working code, tests, documentation and a status record.

| Phase | Delivered | Tests |
|---|---|---|
| 1 | Sparsiz inspected at an exact commit; five pieces reusable, the rest refused | — (audit record) |
| 2 | Adaptive loop: intent, plans, budgets, checkpoints, routing, verification, skills | `adaptive-*.test.mjs` |
| 3 | Memory fabric: seven layers, provenance, scope, deletion | `memory-fabric` (18), `memory-bridge` (7) |
| 4 | Skills: regression evaluation, rejection retained, declared permissions enforced | `skills-evaluation` (13) |
| 5 | Emotional interaction states: seven states, uncertainty, correction, refusal to emit | `emotional-states` (16) |
| 6 | Provider fabric: declared capabilities, measured availability, refusal instead of degradation | `adaptive-providers` (15) |
| 7 | Authority boundary: tool output is data and cannot authorise anything | `mcp-authority` (11) |
| 8 | Image and video workflows: routed, measured, still image refused as video | `media-workflow` (11) |
| 9 | Industry packs: restrictions only, capabilities evidenced or admitted missing | `industry-packs` (12) |
| 10 | Benchmark and release verification | `benchmark`, `release` |

## What it does not claim

**The adaptive loop, the layered fabric, the provider fabric, the authority boundary and the
industry packs remain library-only.** No HTTP route calls `adaptive/loop.mjs`, the fabric layers,
`adaptive/providers.mjs`, `mcp/authority.mjs` or the packs. The memory *store*, reviewed procedures,
response styles and the media job routes are product surfaces, and they are built on the same
modules rather than a second implementation.

**Image and video are real routes with native adapters, never a live call in this build.** OpenAI
Images and Gemini Images generate through inline bytes; Veo starts an operation, polls it and
downloads the clip under the stated origin policy. All three are contract-tested against fixtures
that return the published shapes; no vendor credential exists in this sandbox, and the matrix says
so. The older `media/workflow.mjs` remains the measured library path and is not what the product
routes call.

| Surface added after the first 0.2.0 note | Route | Tests |
|---|---|---|
| Image generation, durable jobs | `POST /api/image/generate`; `GET /api/image/jobs/<id>[/content]` | `online-image` (9), `online-gemini-images` (3) |
| Video generation, polling, cancellation | `POST /api/video/generate`; `GET /api/video/jobs/<id>[/content]` | `online-video` (9) |
| Reviewed procedures, versions and selection | `/api/skills`, chat `skill` | `online-skills` (9) |
| Measured procedure comparison | `POST /api/skills/:name/measure` | `online-skill-measure` (6) |
| Response styles | `GET|PUT /api/styles`, chat `style` | `online-styles` (8) |
| MCP servers and reviewed tools | `/api/mcp/*` | `online-mcp` (5) |

**No external model provider was contacted.** This sandbox has no provider credentials. The external
path is tested against stubs that record calls — which is how the offline guarantee is proven, and
also why no claim is made about a real gateway.

**`klyvaron-pro-lm` and `klyvaron-max-lm` are unbuilt**, and `klyvaron-mini-lm@0.2.0` remains a
parked run with its record in `docs/experiments/`.

## How to verify it

```bash
npm run test:core                          # the core suite
node --test services/core/test/docs.test.mjs   # documentation against the repository
npm run test:web                           # needs `npm ci` in apps/web first
npm run test:fabric
node services/core/scripts/release-check.mjs --core <n> --web <n> --fabric <n>
node services/core/scripts/benchmark-adaptive.mjs
```

The release check takes the suite totals as arguments deliberately: a tool that read its
expectations from the documents it was checking would verify nothing.

## Benchmark

`docs/experiments/phase10-benchmark.json` is a measured record, written by
`scripts/benchmark-adaptive.mjs --write` on this host (2 cores, 3,939 MB). It covers the adaptive
core's modules only — authority decisions, instruction classification, media header parsing,
provider routing, pack application and a line count over 24 files — and is a smoke benchmark, not a
throughput claim about the product. The harness fails a benchmark that produces no measurement
rather than reporting zero.

## Known limitations

- The adaptive core's loop and its layered fabric remain a library with tests, not a feature;
  memory, procedures, styles, media jobs and MCP are the product surfaces built on parts of it.
- Image generation has two vendors and no editing; video is text-to-video through Veo only.
- No provider has been called live; every adapter is a tested code path, not a verified account.
- `legacy-server.mjs` remains as a documented entry point with no importers.
- The instruction classifier is audit evidence and is not a defence; the defence is that no
  consequential action can be authorised by text.
- Emotional estimates are a phrase lookup with a stated tie-break, permanently at `low` confidence.
- One capability has a stored procedure to evaluate (counting newline bytes across a tree).
