// User-controlled response styles.
//
// This is not an emotional state and not a personality the system claims to have. It is a
// preference the person sets, sent to the model as an instruction for how to phrase an answer.
// The seven ids are the directive's list; there is no eighth "adaptive" mode that infers a mood,
// because inferring one and then acting on it is exactly what the emotional rules forbid.
//
// Two things are enforced outside the model as well:
//   - the instruction always carries the prohibitions (no claimed feelings, consciousness,
//     memories, manipulation or urgency), so a style cannot silently widen what the assistant
//     may say;
//   - the response is audited with adaptive/wording.mjs, and a violation is reported to the
//     caller. It is not silently rewritten: a checker that edits prose is a checker whose
//     findings nobody can see.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { failure } from './failure.mjs'

export const STYLES = Object.freeze([
  Object.freeze({ id: 'supportive', label: 'Supportive', instruction: 'Be warm and steady. Acknowledge a difficulty once, then help with the next concrete step.' }),
  Object.freeze({ id: 'focused', label: 'Focused', instruction: 'Be direct and economical. Lead with the answer, then the smallest set of steps that supports it.' }),
  Object.freeze({ id: 'curious', label: 'Curious', instruction: 'Ask one clarifying question when it would change the answer; otherwise compare alternatives and name the trade-offs.' }),
  Object.freeze({ id: 'cautious', label: 'Cautious', instruction: 'Name uncertainty, prerequisites and risks before recommending an action, and state what would make the recommendation wrong.' }),
  Object.freeze({ id: 'reflective', label: 'Reflective', instruction: 'Summarise what the evidence supports, what it does not, and what the reader should check next.' }),
  Object.freeze({ id: 'playful', label: 'Playful', instruction: 'Use light, harmless humour when it fits. Never joke at the user\'s expense or about a failure, a loss or a safety issue.' }),
  Object.freeze({ id: 'technical', label: 'Technical', instruction: 'Use precise terminology, explicit assumptions and reproducible steps. Do not simplify away a constraint that matters.' }),
])

export const STYLE_IDS = Object.freeze(STYLES.map((style) => style.id))

/** The same boundary for every style. A style may change tone; it may not change claims. */
export const STYLE_PROHIBITIONS = 'Regardless of style: do not claim feelings, consciousness, memories or a relationship; do not flatter, pressure or manufacture urgency; do not imply that a change of tone changes the facts, the evidence or any permission.'

export function styleFor(id) {
  if (typeof id !== 'string' || !STYLE_IDS.includes(id)) {
    throw failure('invalid_style', `Style must be one of ${STYLE_IDS.join(', ')}, or null for no style instruction.`, 400)
  }
  return STYLES.find((style) => style.id === id)
}

export function instructionFor(id) {
  if (id === null || id === undefined) return null
  const style = styleFor(id)
  return `Response style, chosen by the user: ${style.label}. ${style.instruction} ${STYLE_PROHIBITIONS}`
}

/** A per-account preference file. A corrupt file falls back to "no style", never to a guess. */
export class StyleStore {
  constructor({ dir }) {
    if (!dir) throw new TypeError('StyleStore requires a directory')
    this.dir = dir
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  #file(accountId) {
    if (typeof accountId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(accountId)) {
      throw new TypeError('invalid account id for a style preference')
    }
    return join(this.dir, `style-${accountId}.json`)
  }

  get(accountId) {
    const file = this.#file(accountId)
    if (!existsSync(file)) return { style: null, explicit: false }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const style = parsed?.style ?? null
      if (style !== null && !STYLE_IDS.includes(style)) return { style: null, explicit: false, corrupt: true }
      return { style, explicit: true }
    } catch {
      // A preference that cannot be read is not a reason to refuse to chat. Say it was
      // unreadable so the UI can offer to set it again, and use no style instruction.
      return { style: null, explicit: false, corrupt: true }
    }
  }

  set(accountId, style) {
    if (style !== null) styleFor(style)
    const file = this.#file(accountId)
    const temp = `${file}.tmp-${process.pid}`
    writeFileSync(temp, `${JSON.stringify({ schema: 1, style, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, file)
    return { style, explicit: true }
  }
}
