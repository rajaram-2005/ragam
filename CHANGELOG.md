# Changelog

Every entry below is a claim about what the repository contains, and each one is checked by
`services/core/src/release/manifest.mjs` against the files and the measured suites — a version with
no entry here cannot be released, and an entry is not a substitute for the tests.

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
