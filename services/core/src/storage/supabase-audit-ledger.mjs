import { randomUUID } from 'node:crypto'

export class SupabaseAuditLedgerError extends Error {
  constructor(code) {
    super(code)
    this.name = 'SupabaseAuditLedgerError'
    this.code = code
  }
}

/** Append-only audit writer. Events remain queued until flush() confirms persistence;
 * stable IDs make retries safe if a Function loses the response after a committed insert. */
export class SupabaseAuditLedger {
  #client
  #pending = []
  #flushing = null
  #now

  constructor({ client, now = () => Date.now() } = {}) {
    if (!client || typeof client.request !== 'function') throw new SupabaseAuditLedgerError('supabase_client_invalid')
    if (typeof now !== 'function') throw new SupabaseAuditLedgerError('supabase_clock_invalid')
    this.#client = client
    this.#now = now
  }

  record({ category, action, outcome = 'info', actor = null, subject = null, policy = null, detail = null, redacted = null }) {
    if (!category || !action) throw new TypeError('audit event requires category and action')
    const event = {
      id: randomUUID(),
      occurred_at: this.#now(),
      category: String(category),
      action: String(action),
      outcome: String(outcome),
      actor: actor == null ? null : String(actor),
      subject: subject == null ? null : String(subject),
      policy: policy == null ? null : String(policy),
      detail,
      redacted,
    }
    this.#pending.push(event)
    return { id: event.id, category: event.category, action: event.action, outcome: event.outcome }
  }

  flush() {
    if (this.#flushing) return this.#flushing
    this.#flushing = (async () => {
      while (this.#pending.length) {
        const event = this.#pending[0]
        try {
          await this.#client.request('rest/v1/ragam_audit_events', {
            method: 'POST',
            query: 'on_conflict=id',
            headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
            body: event,
          })
          this.#pending.shift()
        } catch {
          throw new SupabaseAuditLedgerError('supabase_audit_write_failed')
        }
      }
    })().finally(() => { this.#flushing = null })
    return this.#flushing
  }

  close() { return this.flush() }
}
