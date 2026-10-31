/** Shared memory contract constants and error type; deliberately free of storage/runtime imports. */
export const MEMORY_MECHANISMS = Object.freeze({
  CONVERSATION_CONTEXT: 'conversation_context',
  APPROVED_MEMORY: 'approved_memory',
  SESSION_RECALL: 'session_recall',
  RETRIEVAL_INDEX: 'retrieval_index',
  TRAINING_EXAMPLE: 'training_example',
  RELEASED_WEIGHTS: 'released_weights',
})

export const MEMORY_KINDS = Object.freeze({
  FACT: 'fact',
  PREFERENCE: 'preference',
  DECISION: 'decision',
  CONSTRAINT: 'constraint',
})

export const CANDIDATE_STATES = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
})

/** The only value the schema accepts. An agent cannot approve its own memory. */
export const APPROVER = 'user'

export const LIMITS = Object.freeze({
  maxMemoryChars: 2000,
  maxMemories: 2000,
  maxTurnsPerSession: 2000,
  maxRecallResults: 25,
  maxContextMemories: 8,
})

export class MemoryError extends Error {
  constructor(message, code = 'memory_error', detail = {}) {
    super(message)
    this.name = 'MemoryError'
    this.code = code
    this.detail = detail
  }
}
