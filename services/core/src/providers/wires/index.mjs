// The wire registry: which request shapes this build can actually send.
//
// `IMPLEMENTED_WIRES` is derived from this object rather than written out beside the catalogue, so
// promoting a provider in `catalog.mjs` cannot claim a wire that no adapter implements — the two
// lists are the same list.

import { failure } from '../../online/failure.mjs'
import * as anthropic from './anthropic.mjs'
import * as gemini from './gemini.mjs'
import * as openai from './openai.mjs'

const WIRES = Object.freeze({
  [openai.wire]: openai,
  [anthropic.wire]: anthropic,
  [gemini.wire]: gemini,
})

/** Wires the gateway's transport can speak. */
export const IMPLEMENTED = Object.freeze(Object.keys(WIRES))

export function wireFor(name) {
  const wire = Object.hasOwn(WIRES, name) ? WIRES[name] : null
  if (!wire) throw failure('wire_not_implemented', `No adapter for wire '${name}' in this build.`, 400)
  return wire
}
