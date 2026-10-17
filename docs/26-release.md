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

**The adaptive core is not reachable from the product.** No HTTP route calls the loop, the memory
fabric, the provider fabric, the authority boundary, the media workflow or the packs. The online
product still refuses image and video generation with its own limitation codes
(`not_implemented`, `needs_hardware`).

**No image or video provider exists in this build.** The workflows are exercised against test
doubles that return real containers; the *provider* half is unproven here, and the benchmark says
the same thing in its own `scope` field.

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

- The product surface is unchanged: the adaptive core is a library with tests, not a feature.
- `legacy-server.mjs` remains as a documented entry point with no importers.
- The instruction classifier is audit evidence and is not a defence; the defence is that no
  consequential action can be authorised by text.
- Emotional estimates are a phrase lookup with a stated tie-break, permanently at `low` confidence.
- One capability has a stored procedure to evaluate (counting newline bytes across a tree).
