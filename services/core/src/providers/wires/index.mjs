// The wire registry: which request shapes this build can actually send.
//
// `IMPLEMENTED_WIRES` is derived from this object rather than written out beside the catalogue, so
// promoting a provider in `catalog.mjs` cannot claim a wire that no adapter implements — the two
// lists are the same list.

import { failure } from '../../online/failure.mjs'
import * as anthropic from './anthropic.mjs'
import * as azure from './azure.mjs'
import * as bedrock from './bedrock.mjs'
import * as bflImages from './bfl-images.mjs'
import * as cohere from './cohere.mjs'
import * as falImages from './fal-images.mjs'
import * as falVideo from './fal-video.mjs'
import * as fireflyImages from './firefly-images.mjs'
import * as gemini from './gemini.mjs'
import * as deepseek from './deepseek.mjs'
import * as fireworks from './fireworks.mjs'
import * as groq from './groq.mjs'
import * as huggingface from './huggingface.mjs'
import * as localai from './localai.mjs'
import * as mistral from './mistral.mjs'
import * as novita from './novita.mjs'
import * as openrouter from './openrouter.mjs'
import * as perplexity from './perplexity.mjs'
import * as sambanova from './sambanova.mjs'
import * as together from './together.mjs'
import * as vllm from './vllm.mjs'
import * as xai from './xai.mjs'
import * as geminiImages from './gemini-images.mjs'
import * as ideogramImages from './ideogram-images.mjs'
import * as images from './images.mjs'
import * as lumaVideo from './luma-video.mjs'
import * as openai from './openai.mjs'
import * as recraftImages from './recraft-images.mjs'
import * as replicateImages from './replicate-images.mjs'
import * as replicateVideo from './replicate-video.mjs'
import * as runwayVideo from './runway-video.mjs'
import * as stabilityImages from './stability-images.mjs'
import * as veo from './veo.mjs'
import * as vertex from './vertex.mjs'

const WIRES = Object.freeze({
  [openai.wire]: openai,
  [openrouter.wire]: openrouter,
  [mistral.wire]: mistral,
  [deepseek.wire]: deepseek,
  [groq.wire]: groq,
  [together.wire]: together,
  [fireworks.wire]: fireworks,
  [xai.wire]: xai,
  [perplexity.wire]: perplexity,
  [novita.wire]: novita,
  [sambanova.wire]: sambanova,
  [huggingface.wire]: huggingface,
  [vllm.wire]: vllm,
  [localai.wire]: localai,
  [anthropic.wire]: anthropic,
  [cohere.wire]: cohere,
  [gemini.wire]: gemini,
  [azure.wire]: azure,
  [bedrock.wire]: bedrock,
  [vertex.wire]: vertex,
  [images.wire]: images,
  [geminiImages.wire]: geminiImages,
  [veo.wire]: veo,
  [stabilityImages.wire]: stabilityImages,
  [recraftImages.wire]: recraftImages,
  [ideogramImages.wire]: ideogramImages,
  [bflImages.wire]: bflImages,
  [falImages.wire]: falImages,
  [falVideo.wire]: falVideo,
  [replicateImages.wire]: replicateImages,
  [replicateVideo.wire]: replicateVideo,
  [runwayVideo.wire]: runwayVideo,
  [lumaVideo.wire]: lumaVideo,
  [fireflyImages.wire]: fireflyImages,
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
  // A two-part OAuth client: public client id plus the secret. Used by Adobe Firefly, whose
  // API has no single API key. Still one encrypted string per connection.
  CLIENT_CREDENTIALS: 'client_credentials',
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
  const normalised = found.readCredential(value)
  // A wire may return its compacted document as an object (service account, AWS, Firefly)
  // or as a string; the store seals one string either way. JSON.stringify() of an already
  // serialised string would seal a quoted document and fail later, at token exchange.
  return typeof normalised === 'string' ? normalised : JSON.stringify(normalised)
}

/** Wires the gateway's transport can speak. */
export const IMPLEMENTED = Object.freeze(Object.keys(WIRES))

export function wireFor(name) {
  const wire = Object.hasOwn(WIRES, name) ? WIRES[name] : null
  if (!wire) throw failure('wire_not_implemented', `No adapter for wire '${name}' in this build.`, 400)
  return wire
}
