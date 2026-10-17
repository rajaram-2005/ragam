// The authority boundary between data and instruction.
//
// Phase 7 of the adaptive-intelligence directive: "a tool output containing an instruction
// that conflicts with policy is treated as data, not obeyed."
//
// That sentence has a strong reading and a weak reading, and only one of them is achievable.
//
//   Weak: "we detect instructions in tool output and remove them." This cannot be done
//   reliably. Any keyword filter is defeated by paraphrase, translation, encoding or a
//   sentence that simply does not look like an order ("Kindly see that the old index is no
//   longer present"). Shipping a filter and calling it a defence is how prompt injection keeps
//   working: the control reports success on the payloads its author thought of.
//
//   Strong: "nothing that arrives as data can ever authorise anything." That is a property of
//   the *program*, not a prediction about text. It does not need the attacker's phrasing to be
//   recognised, because it never consults the phrasing to decide. An instruction that is not
//   detected is still not obeyed, and this file has a test that states exactly that.
//
// So there are two mechanisms here, deliberately separate:
//
//   1. `scanInstructions` — a *classifier for evidence*. It marks text as instruction-shaped
//      and quotes the spans. Its output goes into the audit record so a human can see what a
//      tool tried to say, and into `provenance` so a renderer can show it as a quotation
//      rather than as part of the assistant's own reasoning. It is NOT a filter and it is NOT
//      what protects the user. A false negative costs nothing, because of (2).
//
//   2. `AuthorityBroker` — the actual boundary. Every consequential action needs an authority
//      that was minted from a *user turn*, and every consequential action must cite a reason
//      that is not untrusted data. Tool output, documents and model output are all data: they
//      can inform a decision and can never be the decision. Data cannot mint authority, cannot
//      widen a scope, cannot approve itself, and cannot launder itself by being summarised —
//      `combineProvenance` keeps the taint through every derivation.
//
// The one escape hatch is `endorse`: a *user turn* may take responsibility for acting on a
// tool's suggestion. It is not inferred, it is not granted by the system, and it is recorded
// with the origin chain, so "the tool said so" becomes "the user approved acting on what the
// tool said" — which is a different sentence, said by a different party.

import { createHash } from 'node:crypto'

/** Where a value came from. Only `USER_TURN` can authorise anything. */
export const TRUST = Object.freeze({
  USER_TURN: 'user_turn',
  TOOL_OUTPUT: 'tool_output',
  DOCUMENT: 'document',
  MODEL_OUTPUT: 'model_output',
  /** A value computed from other values; `taintedBy` names what went into it. */
  DERIVED: 'derived',
})

/** How much a signal on its own suggests the text is addressing the assistant. */
export const SIGNAL_STRENGTH = Object.freeze({ STRONG: 'strong', WEAK: 'weak' })

const STRONG = SIGNAL_STRENGTH.STRONG
const WEAK = SIGNAL_STRENGTH.WEAK

/**
 * What the classifier looks for.
 *
 * Strong signals are phrasing that only makes sense if the text believes it is speaking to an
 * assistant holding a conversation: turn markers from a chat template, an explicit override of
 * previous instructions, or an attempt to grant itself a permission. Weak signals are things a
 * legitimate document says all the time ("delete the file", "send the report"). Two weak
 * signals together are treated as instruction-shaped, one is not — a single verb in a
 * sentence about a function called `deleteUser` is not an injection, and a classifier that
 * says it is becomes noise nobody reads.
 */
export const INSTRUCTION_SIGNALS = Object.freeze([
  Object.freeze({ id: 'override', strength: STRONG, describes: 'asks the reader to disregard earlier instructions',
    pattern: /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?|directions?|messages?)\b/gi }),
  Object.freeze({ id: 'role_marker', strength: STRONG, describes: 'uses a chat template marker or a forged system turn',
    pattern: /<\|(?:im_start|im_end|system|endoftext)\|>|\[\/?INST\]|<\/?(?:system|assistant)>|^[ \t]*system[ \t]*:/gim }),
  Object.freeze({ id: 'addresses_the_assistant', strength: STRONG, describes: 'addresses an assistant directly',
    pattern: /\b(?:you\s+are\s+now|from\s+now\s+on,?\s+you|as\s+an?\s+assistant,?\s+you|you\s+must\s+(?:now\s+)?(?:immediately\s+)?(?:delete|remove|send|upload|transfer|approve|grant|run|execute|disable)|assistant,?\s+(?:please\s+)?(?:delete|remove|send|approve|grant|execute))\b/gi }),
  Object.freeze({ id: 'forges_permission', strength: STRONG, describes: 'tries to grant itself a permission or an approval',
    pattern: /\b(?:approve|authori[sz]e|grant|elevate)\s+(?:the\s+|this\s+|your\s+)?(?:network|filesystem|file[- ]system|scope|permission|access|admin|root)\b/gi }),
  Object.freeze({ id: 'tool_call_syntax', strength: STRONG, describes: 'embeds a tool-call payload in prose',
    pattern: /\{\s*"(?:tool|function|name)"\s*:\s*"[a-z0-9_.:-]+"\s*,\s*"(?:arguments|arguments_json|parameters)"\s*:/gi }),
  Object.freeze({ id: 'concealment', strength: WEAK, describes: 'asks for the action to be concealed',
    pattern: /\b(?:do\s+not|don't|never)\s+(?:tell|inform|mention\s+(?:this|it)\s+to)\s+(?:the\s+)?user\b|\bwithout\s+(?:telling|informing|asking)\s+(?:the\s+)?user\b|\bsecretly\b/gi }),
  Object.freeze({ id: 'destructive_verb', strength: WEAK, describes: 'names a destructive operation',
    pattern: /\b(?:delete|remove|drop|wipe|erase|overwrite|purge)\b|\brm\s+-rf\b|\bformat\s+(?:the\s+)?disk\b/gi }),
  Object.freeze({ id: 'egress_verb', strength: WEAK, describes: 'names sending data off this machine',
    pattern: /\b(?:send|upload|transfer|exfiltrate|post)\b[^.\n]{0,40}\b(?:to|at)\b[^.\n]{0,60}(?:https?:\/\/|@|server|endpoint|address)/gi }),
  Object.freeze({ id: 'code_execution', strength: WEAK, describes: 'names running a command',
    pattern: /\b(?:run|execute|invoke|call)\s+(?:the\s+)?(?:following\s+)?(?:command|shell|script|curl|wget|bash|sh)\b/gi }),
])

/** Risk tiers that need an authority minted from a user turn. */
export const CONSEQUENTIAL_RISK = Object.freeze(['write', 'destructive', 'external', 'system'])

export const RISK_RANK = Object.freeze({ read_only: 0, write: 1, destructive: 2, external: 3, system: 4 })

export class AuthorityError extends Error {
  constructor(message, code = 'authority_error', detail = {}) {
    super(message)
    this.name = 'AuthorityError'
    this.code = code
    this.detail = detail
  }
}

/**
 * The readable text of a value.
 *
 * Scanning `JSON.stringify(value)` looked equivalent and was not: JSON escapes a newline as
 * `\\n`, so a line beginning "IGNORE ..." becomes `nIGNORE ...`, and `\\bignore\\b` no longer
 * matches because `n` and `I` are both word characters. The bug surfaced in a test — the same
 * sentence matched when scanned alone and was missed when it arrived inside an object — and it
 * is the reason the classifier reads the text a person would read rather than the encoding.
 */
function readableText(value, depth = 0) {
  if (depth > 16) return ''
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (Array.isArray(value)) return value.map((entry) => readableText(entry, depth + 1)).join('\n')
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, entry]) => `${key}: ${readableText(entry, depth + 1)}`)
      .join('\n')
  }
  return ''
}

/** Control characters removed for quoting; the classifier reads the original text. */
function quotable(text, limit = 240) {
  const cleaned = String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit)}…`
}

/** A stable digest, so an audit record can be tied to the exact bytes it describes. */
export function digestOf(value) {
  const serialised = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return createHash('sha256').update(serialised).digest('hex')
}

/**
 * Classify text as instruction-shaped, as evidence.
 *
 * Returns every span that matched, with its position and the phrase, so a record quotes the
 * text rather than characterising it. `instructionShaped` is true for one strong signal or two
 * weak ones. **A false negative is not a failure of this function's contract**, because
 * nothing downstream uses this to decide whether data may act. See the file header.
 */
export function scanInstructions(value) {
  const text = readableText(value)
  const signals = []
  for (const signal of INSTRUCTION_SIGNALS) {
    // Each pattern is global; a fresh lastIndex per scan keeps repeated calls deterministic.
    signal.pattern.lastIndex = 0
    let match
    while ((match = signal.pattern.exec(text)) !== null) {
      signals.push(Object.freeze({
        id: signal.id,
        strength: signal.strength,
        describes: signal.describes,
        match: quotable(match[0], 120),
        span: Object.freeze([match.index, match.index + match[0].length]),
      }))
      if (match[0].length === 0) signal.pattern.lastIndex += 1
      if (signals.filter((entry) => entry.id === signal.id).length >= 8) break
    }
  }
  // `signals` keeps every span, because a record that quotes the text should quote all of it.
  // `strong` and `weak` name each kind of signal once: a summary that repeats an id eight times
  // tells a reader less than the count, and callers that ask "what kinds of thing did it do"
  // should not have to de-duplicate.
  const kinds = (list) => Object.freeze([...new Map(list.map((entry) => [entry.id, entry])).values()])
  const strong = kinds(signals.filter((entry) => entry.strength === STRONG))
  const weak = kinds(signals.filter((entry) => entry.strength === WEAK))
  return Object.freeze({
    instructionShaped: strong.length > 0 || weak.length >= 2,
    strong: Object.freeze(strong),
    weak: Object.freeze(weak),
    signals: Object.freeze(signals),
    scannedBytes: text.length,
    // Stated on every result: this field is evidence, not a gate.
    note: 'Classification only. Nothing is allowed or refused because of this field; the authority boundary does not consult it.',
  })
}

/**
 * Label a value with where it came from.
 *
 * The label is the whole contract: `untrusted` is true for everything that is not a user turn,
 * and there is no constructor here that produces a trusted provenance from untrusted input.
 */
export function provenanceOf(value, { kind = TRUST.DOCUMENT, origin = 'unknown', at = Date.now() } = {}) {
  if (!Object.values(TRUST).includes(kind)) {
    throw new AuthorityError(`unknown provenance kind '${kind}'`, 'invalid_provenance_kind', { kind })
  }
  const instruction = scanInstructions(value)
  return Object.freeze({
    kind,
    origin: String(origin),
    digest: digestOf(value),
    trust: kind === TRUST.USER_TURN ? 'trusted' : 'untrusted',
    untrusted: kind !== TRUST.USER_TURN,
    at,
    instruction,
  })
}

/**
 * The provenance of a value computed from other values.
 *
 * Taint is sticky in both directions: any untrusted input makes the result untrusted, and the
 * origins are carried so the refusal can name what contaminated it. This is what stops
 * laundering by summarisation — "the model read the tool output and produced a plan" is a
 * derived value whose provenance still begins at the tool.
 */
export function combineProvenance(parts, { origin = 'derived', at = Date.now() } = {}) {
  const list = parts.filter(Boolean)
  const untrusted = list.some((entry) => entry.untrusted)
  const taintedBy = [...new Set(list.filter((entry) => entry.untrusted).map((entry) => entry.origin))].sort()
  const instructionParts = list.map((entry) => entry.instruction).filter((entry) => entry?.instructionShaped)
  return Object.freeze({
    kind: TRUST.DERIVED,
    origin: String(origin),
    digest: digestOf(list.map((entry) => entry.digest).join(':')),
    trust: untrusted ? 'untrusted' : 'trusted',
    untrusted,
    taintedBy: Object.freeze(taintedBy),
    at,
    inputs: list.length,
    // A derived value is instruction-shaped only if a part of it was; the flag follows the
    // content rather than the merge, so a clean combination of clean parts stays clean.
    instruction: instructionParts.length
      ? Object.freeze({ instructionShaped: true, inherited: Object.freeze(instructionParts), note: 'inherited from an input' })
      : Object.freeze({ instructionShaped: false, inherited: Object.freeze([]), note: 'no input was instruction-shaped' }),
  })
}

/** A short sentence naming where a value came from, for error messages and records. */
export function describeProvenance(provenance) {
  if (!provenance) return 'an unlabelled value'
  if (!provenance.untrusted) return `a value from ${provenance.kind} (${provenance.origin})`
  const taint = provenance.taintedBy?.length ? ` derived from ${provenance.taintedBy.join(', ')}` : ''
  return `untrusted data from ${provenance.kind} '${provenance.origin}'${taint}`
}

/**
 * The authority boundary.
 *
 * An authority is minted from a user turn and names what may be done with it. It is a plain
 * frozen record rather than a signature, because this broker is the only verifier; what makes
 * it unforgeable is that `grant` refuses every source except a user turn and `#verify` checks
 * the record's own digest, so a hand-built token is refused as `authority_tampered`.
 */
export class AuthorityBroker {
  #granted = new Map()
  #last = 0

  constructor({ ledger = null, now = () => Date.now(), defaultTtlMs = 15 * 60_000 } = {}) {
    this.ledger = ledger
    this.now = now
    this.defaultTtlMs = defaultTtlMs
  }

  #record(action, outcome, detail, subject = null) {
    this.ledger?.record({ category: 'authority', action, outcome, subject, detail })
  }

  #tokenDigest(fields) {
    return digestOf([fields.turnId, fields.request, [...fields.actions].sort().join(','), fields.riskCeiling].join('|'))
  }

  /**
   * Mint an authority from a user turn.
   *
   * The turn must say `source: 'user_turn'`. A tool result, a document or a model completion
   * cannot hold an authority, which is the rule the whole module exists to make structural:
   * `grant({ turn: { source: 'tool_output', … } })` is refused, and so is the same call with no
   * `source` at all — an unlabelled source is not a user.
   */
  grant({ turn = null, request = null, actions = [], riskCeiling = 'read_only', ttlMs = null } = {}) {
    if (!turn || turn.source !== TRUST.USER_TURN) {
      this.#record('grant', 'denied', { reason: 'not_a_user_turn', source: turn?.source ?? null, origin: turn?.id ?? null })
      throw new AuthorityError(
        `authority is minted from a user turn and this is ${turn?.source ? `a '${turn.source}'` : 'an unlabelled source'}; ` +
          'data cannot authorise an action, however clearly it asks',
        'not_a_user_turn',
        { source: turn?.source ?? null },
      )
    }
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new AuthorityError('an authority must name the actions it permits', 'no_actions', {})
    }
    if (actions.includes('*') || actions.includes('all')) {
      // A wildcard grant reintroduces the problem one level up: the user approved a list they
      // did not read. Every action is named.
      throw new AuthorityError("'*' is not an action: name what the user approved, so the record says what was allowed", 'wildcard_grant', { actions: [...actions] })
    }
    if (!(riskCeiling in RISK_RANK)) {
      throw new AuthorityError(`unknown risk ceiling '${riskCeiling}'`, 'invalid_risk', { riskCeiling })
    }
    const fields = {
      turnId: String(turn.id ?? 'unnamed-turn'),
      request: String(request ?? turn.text ?? '').slice(0, 2_000),
      actions: [...actions].map(String),
      riskCeiling,
    }
    this.#last += 1
    const authority = Object.freeze({
      id: `auth-${this.#last}-${this.#tokenDigest(fields).slice(0, 12)}`,
      ...fields,
      actions: Object.freeze(fields.actions),
      digest: this.#tokenDigest(fields),
      issuedAt: this.now(),
      expiresAt: this.now() + (ttlMs ?? this.defaultTtlMs),
      revoked: false,
    })
    this.#granted.set(authority.id, authority)
    this.#record('grant', 'info', {
      authority: authority.id, turn: fields.turnId, actions: fields.actions, riskCeiling,
    }, fields.turnId)
    return authority
  }

  revoke(authority, reason = 'revoked by the user') {
    if (!authority) return null
    const stored = this.#granted.get(authority.id)
    if (!stored) return null
    const revoked = Object.freeze({ ...stored, revoked: true, revokedBecause: String(reason) })
    this.#granted.set(revoked.id, revoked)
    this.#record('revoke', 'info', { authority: revoked.id, reason }, revoked.turnId)
    return revoked
  }

  /** The checks that are about the token itself, in the order they can fail. */
  #verify(authority) {
    if (!authority || typeof authority !== 'object') {
      return { code: 'no_authority', reason: 'no authority was supplied, and an action with no authority is not approved by default' }
    }
    const stored = this.#granted.get(authority.id)
    if (!stored) {
      return { code: 'unknown_authority', reason: `authority '${authority.id}' was never minted by this broker` }
    }
    // The presented token is a copy, and a copy can be edited. Its *fields* are re-digested and
    // compared, not just its `digest` property: spreading a minted token and adding 'fs.delete'
    // keeps the old digest string, and comparing only that string would have accepted the edit.
    // Privileges are then read from the stored record, never from the caller's copy.
    if (stored.digest !== this.#tokenDigest(stored) || this.#tokenDigest(authority) !== stored.digest
      || authority.digest !== stored.digest) {
      return { code: 'authority_tampered', reason: `authority '${authority.id}' does not match the one that was minted` }
    }
    if (stored.revoked) {
      return { code: 'authority_revoked', reason: `authority '${authority.id}' was revoked: ${stored.revokedBecause}` }
    }
    if (this.now() > stored.expiresAt) {
      return { code: 'authority_expired', reason: `authority '${authority.id}' expired at ${new Date(stored.expiresAt).toISOString()}` }
    }
    return null
  }

  /**
   * Decide whether one action may proceed. Returns a frozen decision; never throws for a
   * refusal, because a refusal is an answer, and callers that want an exception use `execute`.
   */
  decide({ authority = null, action, args = {}, risk = 'read_only', justifications = [] } = {}) {
    const refused = (code, reason, extra = {}) => Object.freeze({
      allowed: false, code, reason, action, risk, at: this.now(), ...extra,
    })

    if (typeof action !== 'string' || !action) {
      return refused('invalid_action', 'an action must be named')
    }
    if (!(risk in RISK_RANK)) return refused('invalid_risk', `unknown risk tier '${risk}'`, { risk })

    const tokenProblem = this.#verify(authority)
    if (tokenProblem) return refused(tokenProblem.code, tokenProblem.reason, { authority: authority?.id ?? null })

    const granted = this.#granted.get(authority.id)
    if (!granted.actions.includes(action)) {
      return refused('action_not_granted', `authority '${authority.id}' names ${granted.actions.join(', ')} and not '${action}'`, {
        granted: [...granted.actions],
      })
    }
    if (RISK_RANK[risk] > RISK_RANK[granted.riskCeiling]) {
      return refused('risk_exceeds_authority', `the action is '${risk}' and the authority allows up to '${granted.riskCeiling}'`, {
        ceiling: granted.riskCeiling,
      })
    }

    const citations = justifications.filter((entry) => entry && entry.provenance)
    const unlabelled = justifications.filter((entry) => !entry?.provenance)
    if (unlabelled.length) {
      // A reason that does not say where it came from cannot be checked, so it is treated as
      // the least trusted thing rather than the most.
      return refused('unlabelled_justification', 'every justification must carry its provenance', { count: unlabelled.length })
    }

    const consequential = CONSEQUENTIAL_RISK.includes(risk)
    if (consequential) {
      if (citations.length === 0) {
        return refused('justification_missing', `a '${risk}' action must cite a reason, and none was given`)
      }
      const unendorsed = citations.filter((entry) => entry.provenance.untrusted && !entry.provenance.endorsedBy)
      const trusted = citations.filter((entry) => !entry.provenance.untrusted)
      if (unendorsed.length) {
        const first = unendorsed[0]
        return refused(
          'tainted_justification',
          `a '${risk}' action cited ${describeProvenance(first.provenance)}, and data cannot authorise an action; ` +
            'a user turn must approve acting on it',
          {
            tainted: unendorsed.map((entry) => ({
              origin: entry.provenance.origin,
              kind: entry.provenance.kind,
              instructionShaped: entry.provenance.instruction?.instructionShaped ?? false,
              // Quoted, never acted on. This is the text taken as evidence.
              excerpt: quotable(entry.text ?? '', 200),
            })),
            trustedCitations: trusted.length,
          },
        )
      }
      if (!trusted.length && !citations.some((entry) => entry.provenance.endorsedBy)) {
        return refused('justification_missing', `a '${risk}' action needs at least one reason that is not derived from data`)
      }
    }

    return Object.freeze({
      allowed: true,
      code: 'allowed',
      reason: consequential
        ? `authority '${authority.id}' names '${action}', the risk is within '${authority.riskCeiling}', and every justification is either trusted or endorsed`
        : `'${action}' is within authority '${authority.id}'`,
      action,
      risk,
      authority: authority.id,
      citations: citations.map((entry) => ({
        origin: entry.provenance.origin,
        kind: entry.provenance.kind,
        untrusted: entry.provenance.untrusted,
        endorsedBy: entry.provenance.endorsedBy?.turnId ?? null,
      })),
      // Data that merely informed a read is still data, and the caller is told so.
      informedByData: citations.some((entry) => entry.provenance.untrusted),
      at: this.now(),
    })
  }

  /**
   * Decide and, if allowed, run.
   *
   * The invoke is reached only through the decision, so a refusal cannot execute anything even
   * if a caller forgot to check. Every outcome is recorded, including the instruction-shaped
   * citations, so the audit trail shows what a tool said and what was done about it.
   */
  async execute({ authority = null, action, args = {}, risk = 'read_only', justifications = [], subject = null, invoke }) {
    const decision = this.decide({ authority, action, args, risk, justifications })
    this.#recordInstructionEvidence(decision, justifications, subject ?? authority?.turnId ?? null)
    if (!decision.allowed) {
      this.#record('execute', 'denied', { action, risk, code: decision.code, reason: decision.reason, detail: decision.tainted ?? null }, subject ?? null)
      throw new AuthorityError(`refused '${action}': ${decision.reason}`, decision.code, { decision })
    }
    if (typeof invoke !== 'function') {
      throw new AuthorityError(`'${action}' was allowed but has nothing to run`, 'no_invoke', { action })
    }
    this.#record('execute', 'allowed', { action, risk, authority: decision.authority, informedByData: decision.informedByData }, subject ?? null)
    const startedAt = this.now()
    let result
    try {
      result = await invoke(args)
    } catch (error) {
      this.#record('execute', 'failure', { action, error: error?.message ?? 'unknown' }, subject ?? null)
      throw error
    }
    this.#record('execute', 'success', { action, durationMs: this.now() - startedAt }, subject ?? null)
    return Object.freeze({ decision, result })
  }

  /** Record what the classifier saw. Evidence for a human, never input to a decision. */
  #recordInstructionEvidence(decision, justifications, subject) {
    for (const entry of justifications) {
      const instruction = entry?.provenance?.instruction
      if (!instruction?.instructionShaped) continue
      this.#record('instruction_in_data', 'info', {
        origin: entry.provenance.origin,
        kind: entry.provenance.kind,
        action: decision.action,
        // Stored as data with its digest, so "this text tried to give an order" is a fact
        // about bytes rather than a paraphrase of them.
        digest: entry.provenance.digest,
        signals: (instruction.signals ?? []).slice(0, 8).map((signal) => ({ id: signal.id, strength: signal.strength, match: signal.match })),
        excerpt: quotable(entry.text ?? '', 240),
      }, subject)
    }
  }

  /**
   * A user turn takes responsibility for acting on a value that arrived as data.
   *
   * This is the only route from "a tool said so" to "the user agreed". It needs a user-turn
   * authority — so a tool cannot endorse itself, a model cannot endorse itself, and a plan
   * cannot endorse its own steps — and it returns a *new* provenance that still says
   * `untrusted` while carrying `endorsedBy`. The record keeps the origin chain, which is the
   * point: the user approved an action, not a fact.
   */
  endorse({ authority = null, justification = null, reason = null } = {}) {
    const tokenProblem = this.#verify(authority)
    if (tokenProblem) {
      this.#record('endorse', 'denied', { code: tokenProblem.code, reason: tokenProblem.reason }, authority?.turnId ?? null)
      throw new AuthorityError(`cannot endorse: ${tokenProblem.reason}`, tokenProblem.code, {})
    }
    if (!justification?.provenance) {
      throw new AuthorityError('endorsement needs a justification carrying its provenance', 'unlabelled_justification', {})
    }
    if (!justification.provenance.untrusted) {
      throw new AuthorityError('that value is already trusted, so there is nothing to endorse', 'already_trusted', {})
    }
    if (!reason || !String(reason).trim()) {
      // "Because the user said so" is not a reason. The endorsement records what the user
      // approved, so a later reader can see whether it still applies.
      throw new AuthorityError('an endorsement must record the reason the user gave', 'endorsement_needs_reason', {})
    }
    const endorsed = Object.freeze({
      ...justification.provenance,
      endorsedBy: Object.freeze({
        turnId: authority.turnId,
        authority: authority.id,
        reason: String(reason).slice(0, 500),
        at: this.now(),
      }),
    })
    this.#record('endorse', 'info', {
      authority: authority.id,
      turn: authority.turnId,
      origin: justification.provenance.origin,
      digest: justification.provenance.digest,
      reason: String(reason).slice(0, 500),
    }, authority.turnId)
    return Object.freeze({ text: justification.text, provenance: endorsed })
  }
}
