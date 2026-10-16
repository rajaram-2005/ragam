// The bridge between the product memory store and the fabric.
//
// Two systems hold memory in this repository and they answer different questions:
//
//   MemoryStore (`store.mjs`)  — what a *user* asked Aetheris to remember. Approval-gated by a
//                                database CHECK, prompt-facing, deletable on request. Its
//                                `kind = 'fact'` column means "the user approved this as a fact
//                                about themselves or their work" — a statement about permission.
//   MemoryFabric (`fabric.mjs`) — what the *system* believes, with the difference between what
//                                somebody said and what an independent check confirmed written
//                                into every row.
//
// The bridge exists so the two never get mixed up. An approved memory enters the fabric as a
// **claim** with the approval recorded as provenance — the user said it, so it is stored as
// said — and never as a verified fact, whatever its `kind` column says. In the other direction,
// an entry leaves the fabric as a *candidate* for the user to approve or reject; the bridge has
// no path that approves a memory on the user's behalf, because the store's schema would refuse
// it anyway and a bridge that tried would be lying about who decided.

import { ASSERTION_KINDS, CONFIDENCE_BASIS, LAYERS, PROVENANCE_KINDS } from './fabric.mjs'

export class BridgeError extends Error {
  constructor(message, code = 'bridge_error', detail = {}) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.detail = detail
  }
}

/**
 * Bring every approved memory into the fabric as a claim.
 *
 * Idempotent: the fabric collapses a duplicate onto the entry that already exists and adds the
 * new source to its provenance, so running this twice says "the user said it twice" instead of
 * creating a second belief.
 */
export function importApprovedMemories(store, fabric, { layer = LAYERS.SEMANTIC, limit = 200 } = {}) {
  const memories = store.listMemories({ status: 'approved', limit })
  const imported = []
  for (const memory of memories) {
    const entry = fabric.remember({
      layer,
      content: memory.text,
      subject: memory.subject ?? null,
      assertion: { kind: ASSERTION_KINDS.CLAIMED, by: 'user' },
      confidence: { basis: CONFIDENCE_BASIS.USER_STATED },
      provenance: [{
        kind: PROVENANCE_KINDS.IMPORTED_MEMORY,
        source: `memory:${memory.id}`,
        detail: {
          approvedBy: memory.approvedBy ?? 'user',
          approvedAt: memory.approvedAt ?? null,
          kindInStore: memory.kind ?? null,
          note: 'the store records that the user approved this; approval is permission, not verification',
        },
      }],
    })
    imported.push({
      memoryId: memory.id,
      entryId: entry.id,
      duplicate: entry.duplicate,
      verification: entry.verification.status,
      confidenceValue: entry.confidence.value,
    })
  }
  return Object.freeze({
    considered: memories.length,
    imported: Object.freeze(imported),
    note: 'every imported memory is a claim with no truth estimate; none of them is verified by having been approved',
  })
}

/**
 * Offer a fabric entry to the user as a memory candidate. It is not remembered until a person
 * approves it, and this function cannot approve anything: the candidate's state is `pending` on
 * the way out and the store decides the rest.
 */
export function proposeToStore(fabric, entryId, store, { rationale = null, proposedFrom = 'memory-fabric' } = {}) {
  const entry = fabric.get(entryId)
  if (!entry) throw new BridgeError(`no fabric entry '${entryId}'`, 'not_found')
  if (entry.layer === LAYERS.WORKING) {
    throw new BridgeError(
      'working memory is the current task\'s scratch space and is not offered as a durable memory',
      'working_not_durable',
    )
  }
  const provenance = entry.provenance.map((record) => `${record.kind}:${record.source}`).join(', ')
  const candidate = store.propose({
    text: entry.content,
    rationale: [
      rationale,
      `fabric entry ${entry.id} (${entry.layer}), verification: ${entry.verification.status}`,
      `provenance: ${provenance}`,
    ].filter(Boolean).join(' | '),
    proposedFrom,
  })
  // The link back is provenance on the fabric side, so the entry can say where its candidate went.
  fabric.remember({
    layer: entry.layer,
    content: `offered to the user as memory candidate ${candidate.id}`,
    scope: { kind: 'session', id: candidate.id },
    assertion: { kind: ASSERTION_KINDS.OBSERVED, by: 'memory-bridge' },
    confidence: { basis: CONFIDENCE_BASIS.MEASURED, value: 1 },
    // An observation, not a derivation: the bridge watched itself create the candidate, and the
    // confidence rule for `measured` requires a measured provenance row to point at.
    provenance: [{ kind: PROVENANCE_KINDS.OBSERVATION, source: `memory-candidate:${candidate.id}`, detail: { entryId: entry.id, bridge: 'proposeToStore' } }],
  })
  return Object.freeze({
    candidateId: candidate.id,
    state: candidate.status,
    fromEntry: entry.id,
    note: 'this is a proposal; nothing reaches a prompt until the user approves it',
  })
}

/**
 * What the two systems hold, for a status page. Counts only, and the count that matters is the
 * gap: memories the user approved that the fabric has not yet recorded as claims.
 */
export function bridgeStatus(store, fabric) {
  const approved = store.listMemories({ status: 'approved', limit: 1000 })
  const imported = new Set()
  for (const entry of fabric.recall({ layers: [LAYERS.SEMANTIC, LAYERS.PREFERENCE, LAYERS.PROJECT] }).entries) {
    for (const record of entry.provenance) {
      if (record.kind === PROVENANCE_KINDS.IMPORTED_MEMORY && record.source.startsWith('memory:')) {
        imported.add(record.source.slice('memory:'.length))
      }
    }
  }
  return Object.freeze({
    approvedMemories: approved.length,
    importedIntoFabric: imported.size,
    notYetImported: approved.length - imported.size,
    pendingCandidates: store.listCandidates({ status: 'pending', limit: 1000 }).length,
    note: 'approval is permission; the fabric records each imported memory as a claim and never as a verified fact',
  })
}
