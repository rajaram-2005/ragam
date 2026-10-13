# 10 — Hermes Agent: reference audit

**What was actually inspected, what was adopted, and what was deliberately not.**

Hermes Agent (`NousResearch/hermes-agent`) is the reference for experience-driven
agent design. This document records the audit required before borrowing anything, and
the specific decisions that followed. It is not a summary of the README: every claim
below was checked against the repository contents.

---

## 1. Repository facts

| | |
|---|---|
| Licence | **MIT** (confirmed via the GitHub API `license` field and `LICENSE`) \
| Language | Python (primary), JavaScript/TypeScript (TUI, `tests-js`, `web`) |
| Size | **~1.2 GB** — `auxiliary_client.py` alone is 438 KB, `scheduler.py` 218 KB, `agent_runtime_helpers.py` 210 KB |
| Default branch | `main` |
| Created / last push | 2025-07-22 / 2026-10-13 (active) |
| Relevant directories | `agent/`, `skills/`, `optional-skills/`, `tools/`, `toolsets.py`, `cron/`, `providers/`, `plugin-catalog/`, `plugins/`, `mcp_serve.py`, `gateway/`, `evals/` |

**Licence compatibility: yes.** MIT, same as Aetheris Omni, no copyleft obligation, and
attribution is preserved in [`third-party/NOTICES.md`](../third-party/NOTICES.md).

## 2. Decision: principles, not vendoring

**Nothing from Hermes is vendored, and that is a deliberate engineering decision rather
than a licensing one.**

At ~1.2 GB with single files exceeding 400 KB, Hermes is a mature production framework
whose scale comes from serving an enormous surface: seven terminal backends, six chat
platforms, a TUI, a desktop app, a cron subsystem with its own scheduler and delivery
queue, an Honcho user-modelling integration, ACP adapters, and provider adapters for
many vendors. The master directive is explicit that this is the wrong shape to copy:
*"Do not blindly copy the entire Hermes codebase, assume every component is needed, or
create competing implementations of functionality that Aetheris already provides
reliably."*

Aetheris already has working, tested implementations of several things Hermes solves in
its own way — the God Core lifecycle, a capability-aware router, an egress choke point,
a plugin registry with scoped permissions, an MCP layer, and an audit ledger. Rewriting
those against Hermes's interfaces would mean discarding verified code to adopt an
unverified one. So what follows is a **principle audit**: what Hermes does that Aetheris
does not, adopted through Aetheris-native interfaces.

## 3. What was adopted

### 3.1 Skill provenance gates the lifecycle — the single most valuable idea found

Hermes's skill curator maintains agent-created skills in the background and archives
stale ones. Its documented invariants are the part worth taking, and they are stricter
than they first appear:

- it **touches only `created_by: "agent"` skills** — bundled and hub-installed skills are
  off-limits to the automatic path;
- it **never deletes — "archive is the maximum"**;
- **pinned skills are exempt from every automatic transition**, and even an explicit
  delete refuses a pinned skill;
- disabled skills are excluded from the candidate list *because the agent must only be
  offered skills it can read and write*.

This is exactly the governance the master directive demands in §6C: *"Do not silently
rewrite core system instructions, grant new permissions or install arbitrary code
because an agent believes it has learned something."* Hermes enforces it structurally —
by provenance, not by policy text — and that is the transferable idea.

Implemented in [`services/core/src/skills/lifecycle.mjs`](../services/core/src/skills/lifecycle.mjs)
with the directive's additional requirement that a candidate skill must pass validation
before it is usable at all.

### 3.2 A documented SKILL.md format with a hard authoring standard

Hermes ships skills as `SKILL.md` with YAML frontmatter — `name`, `description`,
`version`, `author`, `license`, `platforms`, and namespaced `metadata.hermes.*`
(`tags`, `category`, `related_skills`, `config`) — followed by a fixed section order
(`When to Use`, `Prerequisites`, `How to Run`, `Quick Reference`, `Procedure`,
`Pitfalls`, `Verification`), and it enforces the standard in a test
(`tests/skills/test_authoring_standards.py`).

Two details are worth more than the format itself. The `description` is capped at **60
characters** because long descriptions "bloat listings and dilute attention when many
skills load" — a real discovery about progressive disclosure at scale. And skills ship
`scripts/`, `references/` and `templates/` so the model does not "inline-write parsers
or non-trivial logic every call".

Aetheris implements a **compatible subset** of this frontmatter and the same section
discipline. See §5 for the honest limitation on the open-standard claim.

### 3.3 Progressive disclosure by measurement, not intuition

Hermes tracks `use_count`, `view_count`, `patch_count` and `last_activity_at` per skill
and moves skills between `active`, `stale` and `archived` on time thresholds. Skills
load only when relevant. The directive's §6B asks for exactly this, and the important
part is that the thresholds are **data**, in a usage file, not heuristics buried in
code. Adopted as `SkillRegistry.recordUsage()` plus configurable `staleAfterDays` /
`archiveAfterDays`.

### 3.4 Toolsets distributed by task, not granted wholesale

`toolsets.py` and `toolset_distributions.py` exist to give a task the tools it needs and
no more. Aetheris already does this for plugins via scoped permissions; the directive's
§6F asks for the same at the agent level, so the concept is carried into the specialist
agent registry rather than duplicated.

## 4. What was deliberately not adopted

| Not adopted | Reason |
|---|---|
| Vendoring any Hermes module | 1.2 GB and 400 KB single files; Aetheris already implements the overlapping subsystems with tests |
| `auxiliary_client.py` and the provider adapter layer | Aetheris has its own capability-aware router and providers; adopting an unverified 438 KB client would replace working code |
| The cron scheduler (`scheduler.py`, 218 KB, plus delivery queue, quotas, incidents) | Genuinely capable, but Aetheris has no gateway or multi-platform delivery to schedule into. §6G explicitly warns against *"promising background execution when the app, device or service cannot run the required task"* — so scheduling is deferred until there is a runtime that can honour it |
| Telegram/Discord/Slack/WhatsApp/Signal gateway | Out of the five approved product areas |
| Honcho dialectic user modelling | An external service dependency for user modelling; the directive requires quality local-first operation, and the equivalent is built on local session recall |
| The terminal-backend abstraction (Docker, SSH, Singularity, Modal, Daytona, Vercel) | Aetheris's God Mode is bounded local execution per §15 |
| Trajectory compression / batch runner | Research tooling for training tool-calling models; not needed for the current training path |

## 5. Honest limitations of this audit

- **The agentskills.io specification could not be fetched.** It is not on the list of
  hosts reachable from this environment, so the claim that Aetheris's skill format is
  "compatible with the open standard" rests on the format *as observed in Hermes's own
  skills and its `AGENTS.md`*, which states the compatibility. That is second-hand
  evidence and is labelled as such in code and docs. **Status: Requires external
  verification.**
- **No Hermes code was executed.** Its installation requires `uv`, Python 3.14 and a
  large dependency set, and this host has no Python 3.14. The audit is by reading, so
  every statement about behaviour is a statement about what the source says.
- **Hermes's runtime behaviour under load is not evidence for anything here.** Its
  scale reflects a different deployment target; nothing in this document claims that
  Aetheris's equivalents behave the same way, only that the design principles were
  legible and worth adopting.

## 6. Where each adopted principle now lives

| Principle | Aetheris implementation |
|---|---|
| Provenance-gated skill lifecycle | `services/core/src/skills/lifecycle.mjs` |
| SKILL.md format + section order | `services/core/src/skills/manifest.mjs` |
| Usage telemetry and stale/archive thresholds | `services/core/src/skills/registry.mjs` |
| Archive-not-delete, pinned exemption, rollback | `services/core/src/skills/lifecycle.mjs` |
| Candidate → validated promotion | `services/core/src/skills/registry.mjs` |
| Toolsets per task | specialist agent registry, `services/core/src/agents/registry.mjs` |
