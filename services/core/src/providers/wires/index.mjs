// The wire registry: which request shapes this build can actually send.
//
// `IMPLEMENTED_WIRES` is derived from this object rather than written out beside the catalogue, so
// promoting a provider in `catalog.mjs` cannot claim a wire that no adapter implements — the two
// lists are the same list.

import { failure } from '../../online/failure.mjs'
import * as anthropic from './anthropic.mjs'
import * as azure from './azure.mjs'
import * as bedrock from './bedrock.mjs'
import * as cohere from './cohere.mjs'
import * as gemini from './gemini.mjs'
import * as openai from './openai.mjs'
import * as vertex from './vertex.mjs'

const WIRES = Object.freeze({
  [openai.wire]: openai,
  [anthropic.wire]: anthropic,
  [cohere.wire]: cohere,
  [gemini.wire]: gemini,
  [azure.wire]: azure,
  [bedrock.wire]: bedrock,
  [vertex.wire]: vertex,
})

/**
 * What a wire expects in the connection's encrypted credential slot.
 *
 * `api_key` is one opaque string. The other two are JSON documents that the wire validates and
 * compacts before they are sealed; the store still holds one encrypted string per connection, so
 * this needs no schema migration and no secret is ever split across fields or shown in the UI.
 */
export const CREDENTIAL_KINDS = Object.freeze({
  API_KEY: 'api_key',
  SERVICE_ACCOUNT: 'service_account',
  AWS_CREDENTIALS: 'aws_credentials',
})

/** The credential kind a wire expects, defaulting to an API key. */
export function credentialFor(wire) {
  const found = Object.hasOwn(WIRES, wire) ? WIRES[wire] : null
  return found?.credential ?? CREDENTIAL_KINDS.API_KEY
}

/** Validate and compact a structured credential; an API key is returned unchanged. */
export function normaliseCredential(wire, value) {
  const found = Object.hasOwn(WIRES, wire) ? WIRES[wire] : null
  if (!found) throw failure('wire_not_implemented', `No adapter for wire '${wire}' in this build.`, 400)
  if ((found.credential ?? CREDENTIAL_KINDS.API_KEY) === CREDENTIAL_KINDS.API_KEY) return value
  return JSON.stringify(found.readCredential(value))
}

/** Wires the gateway's transport can speak. */
export const IMPLEMENTED = Object.freeze(Object.keys(WIRES))

export function wireFor(name) {
  const wire = Object.hasOwn(WIRES, name) ? WIRES[name] : null
  if (!wire) throw failure('wire_not_implemented', `No adapter for wire '${name}' in this build.`, 400)
  return wire
}
