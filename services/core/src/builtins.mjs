// Built-in plugins and the in-process MCP server.
//
// Why this module exists: the Plugins and MCP product areas are only meaningful if
// something real is registered to inspect. A browser cannot bind a `local_tool`
// handler — handlers are bound in code at install time — so without built-ins those
// two areas could only ever show empty tables and "no handler bound" refusals.
//
// What is registered here is deliberately narrow: every capability is a thin, real
// read or write against an internal service that already exists (hardware profile,
// readiness, audit ledger, media queue, knowledge pipeline, God Core). Nothing is
// simulated, and no capability reaches the network.
//
// Risk tiers covered by the MCP server: read_only, write, destructive. The two
// remaining tiers are intentionally absent:
//   - `system`   — refused outright by this build's allowedRisks, so registering a
//                  system tool would advertise something the platform denies.
//   - `external` — there is no external MCP endpoint configured, and under
//                  strict_offline one could not be reached.
// Both facts are recorded in docs/03-status.md rather than papered over with a stub.

import { RISK, SERVER_KINDS } from './mcp/layer.mjs'
import { SCOPES } from './plugins/manifest.mjs'

const VERSION = '1.0.0'
const AUTHOR = 'Aetheris Omni'
const LICENSE = 'MIT'

/** Plain, serialisable copy — handlers must never hand out live internal objects. */
function plain(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value))
}

function bounded(list, limit) {
  const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 25
  return Array.isArray(list) ? list.slice(0, max) : []
}

// ---------------------------------------------------------------------------
// Plugin 1: read-only introspection.
//
// Declares no scopes at all, which is the point: an installation can enable it
// without granting anything, and any attempt to add a scoped capability later has
// to go through manifest validation.
// ---------------------------------------------------------------------------

const INSIGHT_MANIFEST = {
  manifestVersion: 1,
  id: 'aetheris.insight',
  name: 'Aetheris Insight',
  version: VERSION,
  protocol: 'local_tool',
  description:
    'Read-only introspection over the platform’s own state: hardware profile, readiness, the audit ledger tail and the media job queue. Requests no scopes.',
  author: AUTHOR,
  license: LICENSE,
  scopes: [],
  builtin: true,
  capabilities: [
    {
      name: 'system.hardware',
      description: 'Return the measured hardware profile the model router scores candidates against.',
      readOnly: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'system.readiness',
      description: 'Return readiness: policy, enforced offline state, capability availability and outstanding warnings.',
      readOnly: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'audit.tail',
      description: 'Return the most recent audit ledger entries, optionally filtered by category.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          category: { type: 'string', minLength: 1, maxLength: 40 },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'media.jobs',
      description: 'List media jobs with their validation records. Read-only: it cannot create or cancel a job.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['image', 'video', 'audio'] },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
    },
  ],
}

function insightHandlers(app) {
  return {
    'system.hardware': () => plain(app.hardware),
    'system.readiness': () => plain(app.readiness()),
    'audit.tail': ({ limit, category }) =>
      plain(app.ledger.query({ limit: Number.isInteger(limit) ? limit : 25, category: category ?? '' })),
    'media.jobs': ({ kind, limit }) =>
      plain(bounded(app.media.list({ ...(kind ? { kind } : {}), limit: Number.isInteger(limit) ? limit : 25 }), 100)),
  }
}

// ---------------------------------------------------------------------------
// Plugin 2: private knowledge access.
//
// Declares `knowledge.read`, which is granted by default because it is not an
// elevated scope. Reads stay on this machine: the pipeline is local SQLite plus a
// filesystem store plus an in-memory BM25 index rebuilt from stored chunks.
// ---------------------------------------------------------------------------

const KNOWLEDGE_MANIFEST = {
  manifestVersion: 1,
  id: 'aetheris.knowledge',
  name: 'Aetheris Knowledge Access',
  version: VERSION,
  protocol: 'local_tool',
  description:
    'Read access to the private company knowledge index: search with citations, index statistics and the document register. Never writes and never ingests.',
  author: AUTHOR,
  license: LICENSE,
  scopes: [SCOPES.KNOWLEDGE_READ],
  builtin: true,
  capabilities: [
    {
      name: 'knowledge.search',
      description: 'Search the local index and return ranked chunks with citations.',
      readOnly: true,
      requiredScopes: [SCOPES.KNOWLEDGE_READ],
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 2000 },
          topK: { type: 'integer', minimum: 1, maximum: 20 },
          principal: { type: ['string', 'null'], maxLength: 120 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'knowledge.stats',
      description: 'Return store and index statistics (documents, chunks, terms, deletions).',
      readOnly: true,
      requiredScopes: [SCOPES.KNOWLEDGE_READ],
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'knowledge.documents',
      description: 'List indexed documents with their classification, owner and content hash.',
      readOnly: true,
      requiredScopes: [SCOPES.KNOWLEDGE_READ],
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } },
        additionalProperties: false,
      },
    },
  ],
}

function knowledgeHandlers(app) {
  return {
    'knowledge.search': ({ query, topK, principal }) => {
      const result = app.knowledge.search({ query, topK: Number.isInteger(topK) ? topK : 6, principal: principal ?? null })
      return plain({
        query: result.query,
        method: result.method,
        count: result.results?.length ?? 0,
        results: bounded(result.results, 20).map((entry) => ({
          chunkId: entry.chunkId,
          documentId: entry.documentId,
          score: entry.score,
          text: String(entry.text ?? '').slice(0, 1200),
          matchedTerms: entry.matchedTerms ?? [],
          title: entry.citation?.title ?? null,
          classification: entry.citation?.classification ?? null,
          sha256: entry.citation?.sha256 ?? null,
        })),
      })
    },
    'knowledge.stats': () => plain(app.knowledge.stats()),
    'knowledge.documents': ({ limit }) =>
      plain(
        bounded(app.knowledge.store.listDocuments({ limit: Number.isInteger(limit) ? limit : 50 }), 200).map((document) => ({
          id: document.id,
          title: document.title,
          classification: document.classification,
          owner: document.owner,
          chunkCount: document.chunkCount,
          sizeBytes: document.sizeBytes,
          sha256: document.sha256,
          status: document.status,
          ingestedAt: document.ingestedAt,
        })),
      ),
  }
}

// ---------------------------------------------------------------------------
// In-process MCP server.
//
// Same internal services, exposed through the MCP contract so schema validation,
// risk tiers, approval gates, timeouts and untrusted-output neutralisation are all
// exercised by something real.
// ---------------------------------------------------------------------------

function localServerSpec(app) {
  return {
    id: 'aetheris.local',
    name: 'Aetheris In-Process Server',
    kind: SERVER_KINDS.IN_PROCESS,
    version: VERSION,
    // No credential is involved: this server runs inside the same process. The auth
    // mode is recorded as 'none' rather than claimed to be configured.
    auth: { type: 'none', configured: false },
    tools: [
      {
        name: 'aetheris.hardware',
        description: 'Measured hardware profile plus capability readiness. Read-only, no scopes.',
        risk: RISK.READ_ONLY,
        scopes: [],
        timeoutMs: 5_000,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => plain({ hardware: app.hardware, readiness: app.readiness() }),
      },
      {
        name: 'aetheris.knowledge.search',
        description: 'Search the private local index and return cited chunks. Read-only.',
        risk: RISK.READ_ONLY,
        scopes: [SCOPES.KNOWLEDGE_READ],
        timeoutMs: 10_000,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1, maxLength: 2000 },
            topK: { type: 'integer', minimum: 1, maximum: 20 },
          },
          required: ['query'],
          additionalProperties: false,
        },
        handler: ({ query, topK }) => {
          const result = app.knowledge.search({ query, topK: Number.isInteger(topK) ? topK : 5 })
          return plain({
            method: result.method,
            count: result.results?.length ?? 0,
            citations: bounded(result.citations, 20),
            snippets: bounded(result.results, 5).map((entry) => String(entry.text ?? '').slice(0, 600)),
          })
        },
      },
      {
        name: 'aetheris.knowledge.ingest',
        description:
          'Ingest a document into the local index. Changes local state, so it is a write; it requires the elevated knowledge.write scope to be granted by the installation.',
        risk: RISK.WRITE,
        scopes: [SCOPES.KNOWLEDGE_WRITE],
        timeoutMs: 30_000,
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 300 },
            text: { type: 'string', minLength: 1 },
            classification: { type: 'string', enum: ['public', 'internal', 'confidential', 'restricted'] },
            owner: { type: ['string', 'null'], maxLength: 120 },
          },
          required: ['title', 'text'],
          additionalProperties: false,
        },
        handler: async ({ title, text, classification, owner }) => {
          const result = await app.knowledge.ingestText({
            title,
            text,
            classification: classification ?? 'internal',
            owner: owner ?? null,
            mime: 'text/plain',
          })
          return plain({
            duplicate: Boolean(result.duplicate),
            documentId: result.documentId,
            chunks: result.chunks ?? null,
            reason: result.reason ?? null,
            sha256: result.document?.sha256 ?? null,
          })
        },
      },
      {
        name: 'aetheris.task.cancel',
        description:
          'Cancel a running God Core task. Destructive: it discards in-flight work, so this tier always requires an explicit per-call approval.',
        risk: RISK.DESTRUCTIVE,
        scopes: [],
        timeoutMs: 10_000,
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', minLength: 1, maxLength: 120 },
            reason: { type: 'string', minLength: 1, maxLength: 300 },
          },
          required: ['taskId'],
          additionalProperties: false,
        },
        handler: ({ taskId, reason }) => {
          const summary = app.godCore.cancel(taskId, reason ?? 'cancelled through the MCP tool interface')
          return plain({ ...summary, task: app.godCore.get(taskId) })
        },
      },
    ],
    resources: [
      {
        uri: 'aetheris://status',
        name: 'Platform status',
        description: 'Current readiness, policy and hardware as a JSON document.',
        mimeType: 'application/json',
        handler: () => ({ contents: [{ uri: 'aetheris://status', mimeType: 'application/json', text: JSON.stringify(app.readiness(), null, 2) }] }),
      },
    ],
    prompts: [
      {
        name: 'grounded_answer',
        description: 'Prompt template that forces cited, evidence-only answers from the local index.',
        arguments: { question: { type: 'string', description: 'The question to answer from indexed company sources.' } },
        handler: ({ question }) => ({
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Answer using ONLY indexed company sources for: ${question}\nIf no source supports the answer, say so explicitly. Label anything not supported by a source as "Inference:" and cite sources as [E1], [E2], …`,
              },
            },
          ],
        }),
      },
    ],
  }
}

// ---------------------------------------------------------------------------

/**
 * Register the built-in plugins and the in-process MCP server.
 *
 * Idempotent: a second call is a no-op rather than a duplicate-registration error,
 * so tests and hot reloads can call it safely.
 *
 * @returns {{plugins: string[], server: string|null}} what was registered
 */
export function registerBuiltins(app) {
  const registered = { plugins: [], server: null }

  for (const [manifest, handlers] of [
    [INSIGHT_MANIFEST, insightHandlers(app)],
    [KNOWLEDGE_MANIFEST, knowledgeHandlers(app)],
  ]) {
    if (app.plugins.has(manifest.id)) continue
    const installed = app.plugins.install(manifest, { handler: handlers })
    app.plugins.enable(manifest.id)
    registered.plugins.push(`${installed.id}@${installed.version}`)
  }

  if (!app.mcp.hasServer(BUILTIN_SERVER_ID)) {
    app.mcp.registerServer(localServerSpec(app))
    registered.server = BUILTIN_SERVER_ID
  }

  return registered
}

export const BUILTIN_PLUGIN_IDS = Object.freeze([INSIGHT_MANIFEST.id, KNOWLEDGE_MANIFEST.id])
export const BUILTIN_SERVER_ID = 'aetheris.local'
