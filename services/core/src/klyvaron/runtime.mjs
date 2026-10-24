// Klyvaron first-party Transformer runtime in plain JavaScript (`Lite`, `Pro`, `Max`).
//
// Implements the exact `aetheris-core-v1` causal Transformer forward pass of
// `services/fabric/fabric/lm/model.py` across both:
//   - character tokenizers (`klyvaron.tokenizer.character/1`) and learned byte-level
//     BPE tokenizers (`klyvaron.tokenizer.byte-bpe/1`, matching Python's `bpe.py`),
//   - full-sequence reference evaluation (`logits`) AND mathematically identical
//     KV-cached incremental decoding (`prefillKv` + `decodeStepKv`),
//   - unquantized float32/float64 `klyvaron.artifact/1` AND evaluated symmetric int8
//     `klyvaron.artifact/2`,
//   - all `aetheris-core-v1` differentiator conditioning tables (`age_emb`, `state_emb`)
//     and heads (`verdict_w`/`verdict_b`, `state_head_w`/`state_head_b`).

import { memorySnapshot } from '../hardware/detect.mjs'
import { ArtifactError, BASE_BYTE_VOCAB, loadAdapterArtifact, loadArtifact, parameterCount } from './format.mjs'

const LN_EPS = 1e-5
const GELU_C = Math.sqrt(2 / Math.PI)
const GELU_K = 0.044715
const BPE_SPLIT_RE = /'s|'t|'re|'ve|'m|'ll|'d| ?[\p{L}\p{N}_]+| ?[^\s\p{L}\p{N}_]+|\s+(?!\S)|\s+/gu
const UTF8_ENCODER = new TextEncoder()
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false })
const UTF8_FATAL_DECODER = new TextDecoder('utf-8', { fatal: true })

export const DEFAULT_VERDICT_LABELS = Object.freeze(['ungrounded', 'grounded'])
export const DEFAULT_STATE_LABELS = Object.freeze([
  'direct_question',
  'code_explanation',
  'summary_request',
  'debugging_report',
  'verification_check',
  'stepwise_procedure',
  'comparison_request',
  'uncertain_or_ambiguous',
])

/** Deterministic PRNG (mulberry32). Seeded output is reproducible in this runtime. */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildDequantLut(scaleArray) {
  if (!scaleArray) return null
  const s = scaleArray[0]
  const lut = new Float32Array(256)
  for (let q = -128; q <= 127; q += 1) lut[q + 128] = Math.fround(q * s)
  return lut
}

function layernormInto(x, rows, d, gain, bias, eps, out) {
  for (let r = 0; r < rows; r += 1) {
    const base = r * d
    let mean = 0
    for (let i = 0; i < d; i += 1) mean += x[base + i]
    mean /= d
    let variance = 0
    for (let i = 0; i < d; i += 1) {
      const diff = x[base + i] - mean
      variance += diff * diff
    }
    variance /= d
    const inv = 1 / Math.sqrt(variance + eps)
    for (let i = 0; i < d; i += 1) out[base + i] = (x[base + i] - mean) * inv * gain[i] + bias[i]
  }
}

function geluInto(x, n, out) {
  for (let i = 0; i < n; i += 1) {
    const v = x[i]
    const inner = GELU_C * (v + GELU_K * v * v * v)
    out[i] = 0.5 * v * (1 + Math.tanh(inner))
  }
}

/** out = x (X×Y) · w (Y×Z), row-major, exact `Math.fround(q * scale)` parity via LUT. */
function matmulInto(x, X, Y, weight, Z, out) {
  const lut = weight.lut
  if (lut) {
    const u8 = weight.u8
    for (let i = 0; i < X; i += 1) {
      const xBase = i * Y
      const oBase = i * Z
      for (let k = 0; k < Z; k += 1) out[oBase + k] = 0
      for (let j = 0; j < Y; j += 1) {
        const xv = x[xBase + j]
        if (xv === 0) continue
        const wBase = j * Z
        let k = 0
        for (; k + 7 < Z; k += 8) {
          out[oBase + k] += xv * lut[u8[wBase + k]]
          out[oBase + k + 1] += xv * lut[u8[wBase + k + 1]]
          out[oBase + k + 2] += xv * lut[u8[wBase + k + 2]]
          out[oBase + k + 3] += xv * lut[u8[wBase + k + 3]]
          out[oBase + k + 4] += xv * lut[u8[wBase + k + 4]]
          out[oBase + k + 5] += xv * lut[u8[wBase + k + 5]]
          out[oBase + k + 6] += xv * lut[u8[wBase + k + 6]]
          out[oBase + k + 7] += xv * lut[u8[wBase + k + 7]]
        }
        for (; k < Z; k += 1) out[oBase + k] += xv * lut[u8[wBase + k]]
      }
    }
    return
  }
  const w = weight.data
  for (let i = 0; i < X; i += 1) {
    const xBase = i * Y
    const oBase = i * Z
    for (let k = 0; k < Z; k += 1) out[oBase + k] = 0
    for (let j = 0; j < Y; j += 1) {
      const xv = x[xBase + j]
      if (xv === 0) continue
      const wBase = j * Z
      let k = 0
      for (; k + 3 < Z; k += 4) {
        out[oBase + k] += xv * w[wBase + k]
        out[oBase + k + 1] += xv * w[wBase + k + 1]
        out[oBase + k + 2] += xv * w[wBase + k + 2]
        out[oBase + k + 3] += xv * w[wBase + k + 3]
      }
      for (; k < Z; k += 1) out[oBase + k] += xv * w[wBase + k]
    }
  }
}

function softmaxProbs(values) {
  let max = -Infinity
  for (let i = 0; i < values.length; i += 1) if (values[i] > max) max = values[i]
  const probs = new Float64Array(values.length)
  let sum = 0
  for (let i = 0; i < values.length; i += 1) {
    probs[i] = Math.exp(values[i] - max)
    sum += probs[i]
  }
  for (let i = 0; i < values.length; i += 1) probs[i] /= sum
  return probs
}

function argmax(values) {
  let best = 0
  for (let i = 1; i < values.length; i += 1) if (values[i] > values[best]) best = i
  return best
}

export function buildTokenizerFromManifest(spec) {
  if (spec.kind === 'byte-bpe') {
    const baseSize = spec.baseVocabSize ?? BASE_BYTE_VOCAB
    const merges = spec.merges
    const totalSize = baseSize + merges.length
    const rankMap = new Map()
    const expansions = new Array(totalSize)
    for (let b = 0; b < baseSize; b += 1) expansions[b] = Uint8Array.of(b)
    for (let i = 0; i < merges.length; i += 1) {
      const [left, right] = merges[i]
      rankMap.set(left * 65536 + right, i)
      const a = expansions[left]
      const b = expansions[right]
      const joined = new Uint8Array(a.length + b.length)
      joined.set(a, 0)
      joined.set(b, a.length)
      expansions[baseSize + i] = joined
    }
    const cache = new Map()
    const encodeWord = (word) => {
      const hit = cache.get(word)
      if (hit) return hit
      const symbols = Array.from(UTF8_ENCODER.encode(word))
      while (symbols.length > 1) {
        let bestRank = -1
        let bestAt = -1
        for (let i = 0; i < symbols.length - 1; i += 1) {
          const r = rankMap.get(symbols[i] * 65536 + symbols[i + 1])
          if (r !== undefined && (bestRank < 0 || r < bestRank)) {
            bestRank = r
            bestAt = i
          }
        }
        if (bestAt < 0) break
        symbols.splice(bestAt, 2, baseSize + bestRank)
      }
      if (cache.size >= 50_000) cache.clear()
      cache.set(word, symbols)
      return symbols
    }
    const concatBytes = (ids) => {
      let totalBytes = 0
      for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i]
        if (id < 0 || id >= totalSize) throw new ArtifactError(`id ${id} is outside the vocabulary`, { code: 'invalid_token' })
        totalBytes += expansions[id].length
      }
      const bytes = new Uint8Array(totalBytes)
      let cursor = 0
      for (let i = 0; i < ids.length; i += 1) {
        const chunk = expansions[ids[i]]
        bytes.set(chunk, cursor)
        cursor += chunk.length
      }
      return bytes
    }
    return {
      kind: 'byte-bpe',
      size: totalSize,
      encode(text) {
        if (!text) return new Int32Array(0)
        const out = []
        const matches = text.match(BPE_SPLIT_RE)
        if (matches) {
          for (let i = 0; i < matches.length; i += 1) {
            const ids = encodeWord(matches[i])
            for (let j = 0; j < ids.length; j += 1) out.push(ids[j])
          }
        }
        return Int32Array.from(out)
      },
      decode(ids) {
        return UTF8_DECODER.decode(concatBytes(ids))
      },
      tokenBytes(id) {
        return expansions[id]
      },
      decodeStreaming(ids) {
        const bytes = concatBytes(ids)
        // Hold up to 3 trailing continuation-incomplete UTF-8 bytes so split multi-byte
        // code points never emit a transient U+FFFD replacement glyph mid-stream.
        for (let trim = 0; trim <= Math.min(3, bytes.length); trim += 1) {
          try {
            return { text: UTF8_FATAL_DECODER.decode(bytes.subarray(0, bytes.length - trim)), pendingBytes: trim }
          } catch {
            // Try trimming one more trailing incomplete byte.
          }
        }
        return { text: UTF8_DECODER.decode(bytes), pendingBytes: 0 }
      },
    }
  }

  const index = new Map()
  spec.characters.forEach((character, i) => index.set(character, i + 1))
  return {
    kind: 'character',
    unkId: 0,
    size: spec.characters.length + 1,
    characters: spec.characters,
    encode(text) {
      const ids = new Int32Array(text.length)
      for (let i = 0; i < text.length; i += 1) ids[i] = index.get(text[i]) ?? 0
      return ids
    },
    decode(ids) {
      let out = ''
      for (const id of ids) {
        if (id === 0) out += '\ufffd'
        else if (id >= 1 && id <= spec.characters.length) out += spec.characters[id - 1]
        else throw new ArtifactError(`id ${id} is outside the vocabulary`, { code: 'invalid_token' })
      }
      return out
    },
  }
}

export class KlyvaronRuntime {
  constructor(artifact, { tokenizer = null, availableMemory = () => memorySnapshot().availableRamBytes } = {}) {
    this.availableMemory = availableMemory
    this.manifest = artifact.manifest
    this.directory = artifact.directory
    this.sha256 = artifact.sha256
    const arch = this.manifest.architecture
    this.config = Object.freeze({ ...arch })
    this.params = new Map()
    for (const [name, entry] of artifact.weights) {
      const lut = buildDequantLut(entry.scale)
      let u8 = null
      if (lut) {
        u8 = new Uint8Array(entry.data.length)
        for (let i = 0; i < entry.data.length; i += 1) u8[i] = entry.data[i] + 128
      }
      this.params.set(name, {
        shape: entry.shape,
        data: entry.data,
        u8,
        scale: entry.scale,
        lut,
      })
    }
    const dtype = artifact.weights.get('emb')?.data
    this.dtype = dtype instanceof Float64Array ? Float64Array : Float32Array
    this.tokenizer = tokenizer ?? buildTokenizerFromManifest(this.manifest.tokenizer)
    if (this.tokenizer.size !== arch.vocab_size) {
      throw new ArtifactError(
        `the tokenizer produces ${this.tokenizer.size} ids, the architecture expects ${arch.vocab_size}`,
        { code: 'vocabulary_mismatch' },
      )
    }
    const declared = parameterCount(arch)
    const actual = [...this.params.values()].reduce((sum, entry) => sum + entry.data.length, 0)
    if (declared !== actual) {
      throw new ArtifactError(`the architecture implies ${declared} parameters, the weights hold ${actual}`, {
        code: 'parameter_mismatch',
      })
    }
    this.parameterCount = actual
    this.quantization = this.manifest.weights.quantization?.scheme ?? (this.dtype === Float64Array ? 'none (float64)' : 'none (float32)')
    this.residentWeightBytes = [...this.params.values()].reduce((sum, p) => sum + p.data.byteLength + (p.scale?.byteLength ?? 0), 0)
    this.#baseSnapshots = new Map()
    this.activeAdapter = null
    this.assertMemory(1)
  }

  #baseSnapshots

  /** Verify and merge a `klyvaron.adapter/1` package onto frozen base weights, preserving exact rollback. */
  attachAdapter(adapterDirectory) {
    const adapter = loadAdapterArtifact(adapterDirectory, { expectedBaseManifest: this.manifest })
    if (this.activeAdapter) this.detachAdapter()
    const { rank, scale, targets, tensors } = adapter
    for (const target of targets) {
      const baseEntry = this.params.get(target)
      if (!baseEntry || baseEntry.shape.length !== 2) {
        throw new ArtifactError(`adapter target '${target}' does not match a 2D base matrix`, { code: 'adapter_base_mismatch' })
      }
      const [rows, cols] = baseEntry.shape
      const a = tensors.get(`${target}.lora_a`)
      const b = tensors.get(`${target}.lora_b`)
      if (!a || !b || a.shape.join('x') !== `${rows}x${rank}` || b.shape.join('x') !== `${rank}x${cols}`) {
        throw new ArtifactError(`adapter LoRA tensor shape mismatch for '${target}'`, { code: 'shape_mismatch' })
      }
      this.#baseSnapshots.set(target, baseEntry)
      const merged = new Float32Array(rows * cols)
      for (let r = 0; r < rows; r += 1) {
        const aOff = r * rank
        const outOff = r * cols
        for (let c = 0; c < cols; c += 1) {
          const baseVal = baseEntry.lut ? baseEntry.lut[baseEntry.data[outOff + c] + 128] : baseEntry.data[outOff + c]
          let delta = 0
          for (let k = 0; k < rank; k += 1) delta += a.data[aOff + k] * b.data[k * cols + c]
          merged[outOff + c] = Math.fround(baseVal + scale * delta)
        }
      }
      this.params.set(target, { shape: [rows, cols], data: merged, u8: null, scale: null, lut: null })
    }
    this.residentWeightBytes = [...this.params.values()].reduce((sum, p) => sum + p.data.byteLength + (p.scale?.byteLength ?? 0), 0)
    this.activeAdapter = Object.freeze({
      id: adapter.manifest.id,
      version: adapter.manifest.version,
      directory: adapter.directory,
      sha256: adapter.sha256,
      rank: adapter.rank,
      alpha: adapter.alpha,
      parameterCount: adapter.manifest.lora.parameterCount,
      targets: [...adapter.targets],
    })
    return this.activeAdapter
  }

  /** Atomically restore untouched base weights bit-for-bit after rollback or adapter removal. */
  detachAdapter() {
    for (const [target, baseEntry] of this.#baseSnapshots.entries()) {
      this.params.set(target, baseEntry)
    }
    this.#baseSnapshots.clear()
    this.residentWeightBytes = [...this.params.values()].reduce((sum, p) => sum + p.data.byteLength + (p.scale?.byteLength ?? 0), 0)
    this.activeAdapter = null
  }

  /** Score exact mean token cross-entropy (`meanNll`, `perplexity`) over `tokenIds` starting at `lossStartIndex`. */
  scoreSequence(tokenIds, { lossStartIndex = 1 } = {}) {
    const ids = Array.from(tokenIds, Number)
    if (ids.length < 2) throw new ArtifactError('scoreSequence requires at least 2 tokens', { code: 'invalid_request' })
    const clipped = ids.slice(-Math.min(ids.length, this.config.seq_len + 1))
    const shift = ids.length - clipped.length
    const startPred = Math.max(0, lossStartIndex - 1 - shift)
    const inputs = Int32Array.from(clipped.slice(0, -1))
    const targets = clipped.slice(1)
    const kv = this.createKvCache(inputs.length)
    let sumNll = 0
    let count = 0
    for (let t = 0; t < targets.length; t += 1) {
      const { logits } = this.#stepKvCache(inputs[t], { kv })
      if (t >= startPred) {
        let max = -Infinity
        for (let v = 0; v < logits.length; v += 1) if (logits[v] > max) max = logits[v]
        let denom = 0
        for (let v = 0; v < logits.length; v += 1) denom += Math.exp(logits[v] - max)
        sumNll += Math.log(denom) - (logits[targets[t]] - max)
        count += 1
      }
    }
    const meanNll = count > 0 ? sumNll / count : NaN
    return { meanNll, perplexity: Math.exp(Math.min(meanNll, 20)), tokenCount: count }
  }

  static load(directory, options = {}) {
    return new KlyvaronRuntime(loadArtifact(directory, options), options)
  }

  get instructionTuned() {
    return this.manifest.instructionTuned === true
  }

  get contextTokens() {
    return this.config.seq_len
  }

  get hasDifferentiators() {
    return Boolean(
      (this.config.age_buckets ?? 0) > 0
      || (this.config.state_classes ?? 0) > 0
      || this.config.verdict_head === true
      || this.config.state_head === true,
    )
  }

  scratchBytes(context) {
    const { d_model: d, d_ff: ff, vocab_size: v, n_layers: L } = this.config
    const kvBytes = this.dtype.BYTES_PER_ELEMENT * 2 * L * context * d
    return 2 * (this.dtype.BYTES_PER_ELEMENT * (context * (10 * d + ff) + d) + 16 * context + 24 * v) + kvBytes
  }

  assertMemory(context) {
    const available = this.availableMemory()
    if (!Number.isFinite(available) || available < this.scratchBytes(context)) {
      throw new ArtifactError('memory pressure: task stopped locally; retry with a smaller model or shorter context', { code: 'needs_hardware' })
    }
  }

  #readAt(weight, index) {
    return weight.lut ? weight.lut[weight.data[index] + 128] : weight.data[index]
  }

  #normalizeConditioning(length, ages = null, state = 0) {
    const ageBuckets = this.config.age_buckets ?? 0
    const stateClasses = this.config.state_classes ?? 0
    let ageVec = null
    if (ageBuckets > 0) {
      ageVec = new Int32Array(length)
      if (ages != null) {
        if (ages.length !== length) {
          throw new ArtifactError(`ages length ${ages.length} disagrees with input length ${length}`, { code: 'invalid_request' })
        }
        for (let i = 0; i < length; i += 1) {
          const b = ages[i]
          if (!Number.isInteger(b) || b < 0 || b >= ageBuckets) {
            throw new ArtifactError(`age bucket ${b} outside [0, ${ageBuckets})`, { code: 'invalid_request' })
          }
          ageVec[i] = b
        }
      }
    }
    let stateId = 0
    if (stateClasses > 0 && state != null) {
      if (!Number.isInteger(state) || state < 0 || state >= stateClasses) {
        throw new ArtifactError(`state class ${state} outside [0, ${stateClasses})`, { code: 'invalid_request' })
      }
      stateId = state
    }
    return { ageVec, stateId }
  }

  #embedRow(tokenId, posIndex, ageBucket, stateId, out, offset = 0) {
    const { d_model: d, vocab_size: V } = this.config
    if (tokenId < 0 || tokenId >= V) {
      throw new ArtifactError(`id ${tokenId} is outside the vocabulary`, { code: 'invalid_token' })
    }
    const emb = this.params.get('emb')
    const pos = this.params.get('pos')
    const ageEmb = this.params.get('age_emb')
    const stateEmb = this.params.get('state_emb')
    const embBase = tokenId * d
    const posBase = posIndex * d
    const ageBase = ageBucket * d
    const stateBase = stateId * d
    for (let i = 0; i < d; i += 1) {
      let v = this.#readAt(emb, embBase + i) + this.#readAt(pos, posBase + i)
      if (ageEmb) v += this.#readAt(ageEmb, ageBase + i)
      if (stateEmb) v += this.#readAt(stateEmb, stateBase + i)
      out[offset + i] = v
    }
  }

  #projectHead(hf) {
    const { d_model: d, vocab_size: V, tie_embeddings } = this.config
    const head = tie_embeddings ? this.params.get('emb') : this.params.get('head')
    const logits = new Float64Array(V)
    const lut = head.lut
    if (lut) {
      const u8 = head.u8
      for (let token = 0; token < V; token += 1) {
        let dot = 0
        const base = token * d
        let i = 0
        for (; i + 7 < d; i += 8) {
          dot += hf[i] * lut[u8[base + i]]
            + hf[i + 1] * lut[u8[base + i + 1]]
            + hf[i + 2] * lut[u8[base + i + 2]]
            + hf[i + 3] * lut[u8[base + i + 3]]
            + hf[i + 4] * lut[u8[base + i + 4]]
            + hf[i + 5] * lut[u8[base + i + 5]]
            + hf[i + 6] * lut[u8[base + i + 6]]
            + hf[i + 7] * lut[u8[base + i + 7]]
        }
        for (; i < d; i += 1) dot += hf[i] * lut[u8[base + i]]
        logits[token] = dot
      }
      return logits
    }
    const w = head.data
    for (let token = 0; token < V; token += 1) {
      let dot = 0
      const base = token * d
      for (let i = 0; i < d; i += 1) dot += hf[i] * w[base + i]
      logits[token] = dot
    }
    return logits
  }

  #computeTaskHeads(hf) {
    if (!this.config.verdict_head && !this.config.state_head) return null
    const d = this.config.d_model
    const out = {}
    if (this.config.verdict_head) {
      const vLogits = new Float64Array(2)
      matmulInto(hf, 1, d, this.params.get('verdict_w'), 2, vLogits)
      const vb = this.params.get('verdict_b').data
      vLogits[0] += vb[0]
      vLogits[1] += vb[1]
      const probs = softmaxProbs(vLogits)
      const idx = argmax(vLogits)
      const labels = this.manifest.differentiators?.verdictLabels ?? DEFAULT_VERDICT_LABELS
      out.verdict = {
        index: idx,
        label: labels[idx] ?? String(idx),
        confidence: Number(probs[idx].toFixed(4)),
        logits: Array.from(vLogits),
      }
    }
    if (this.config.state_head) {
      const nClasses = this.config.state_classes
      const sLogits = new Float64Array(nClasses)
      matmulInto(hf, 1, d, this.params.get('state_head_w'), nClasses, sLogits)
      const sb = this.params.get('state_head_b').data
      for (let c = 0; c < nClasses; c += 1) sLogits[c] += sb[c]
      const probs = softmaxProbs(sLogits)
      const idx = argmax(sLogits)
      const labels = this.manifest.differentiators?.stateClasses ?? DEFAULT_STATE_LABELS
      out.state = {
        index: idx,
        label: labels[idx] ?? String(idx),
        confidence: Number(probs[idx].toFixed(4)),
        logits: Array.from(sLogits),
      }
    }
    return out
  }

  /** Allocate a reusable per-layer key/value cache bounded by `maxTokens`. */
  createKvCache(maxTokens = this.config.seq_len) {
    const { n_layers: L, d_model: d } = this.config
    return {
      maxTokens,
      length: 0,
      stateId: null,
      k: Array.from({ length: L }, () => new this.dtype(maxTokens * d)),
      v: Array.from({ length: L }, () => new this.dtype(maxTokens * d)),
    }
  }

  /** Full-sequence forward pass (also optionally populates `kv` for exact O(T) decoding). */
  #forwardSequence(ids, { ages = null, state = 0, kv = null, signal = null } = {}) {
    const T = ids.length
    const { d_model: d, d_ff: ff, n_heads: heads, n_layers: layers, seq_len } = this.config
    if (!T) throw new ArtifactError('a prompt is required', { code: 'empty_prompt' })
    if (T > seq_len) throw new ArtifactError(`sequence length ${T} exceeds the context of ${seq_len}`, { code: 'context_overflow' })
    this.assertMemory(T)

    const { ageVec, stateId } = this.#normalizeConditioning(T, ages, state)
    const headDim = d / heads
    const W = (name) => this.params.get(name)
    const P = (name) => W(name).data

    const h = new this.dtype(T * d)
    for (let t = 0; t < T; t += 1) {
      this.#embedRow(ids[t], t, ageVec ? ageVec[t] : 0, stateId, h, t * d)
    }

    const a = new this.dtype(T * d)
    const q = new this.dtype(T * d)
    const k = new this.dtype(T * d)
    const v = new this.dtype(T * d)
    const y = new this.dtype(T * d)
    const o = new this.dtype(T * d)
    const b = new this.dtype(T * d)
    const z = new this.dtype(T * ff)
    const u = new this.dtype(T * d)
    const scores = new Float64Array(T)
    const attention = new Float64Array(T)
    const scale = 1 / Math.sqrt(headDim)

    for (let layer = 0; layer < layers; layer += 1) {
      if (signal?.aborted) return null
      layernormInto(h, T, d, P(`L${layer}.ln1_gain`), P(`L${layer}.ln1_bias`), LN_EPS, a)
      matmulInto(a, T, d, W(`L${layer}.wq`), d, q)
      matmulInto(a, T, d, W(`L${layer}.wk`), d, k)
      matmulInto(a, T, d, W(`L${layer}.wv`), d, v)
      if (kv) {
        kv.k[layer].set(k)
        kv.v[layer].set(v)
      }

      y.fill(0)
      for (let head = 0; head < heads; head += 1) {
        const offset = head * headDim
        for (let t = 0; t < T; t += 1) {
          let max = -Infinity
          for (let s = 0; s <= t; s += 1) {
            let dot = 0
            for (let i = 0; i < headDim; i += 1) dot += q[t * d + offset + i] * k[s * d + offset + i]
            const score = dot * scale
            scores[s] = score
            if (score > max) max = score
          }
          let total = 0
          for (let s = 0; s <= t; s += 1) {
            const weight = Math.exp(scores[s] - max)
            attention[s] = weight
            total += weight
          }
          for (let s = 0; s <= t; s += 1) {
            const weight = attention[s] / total
            if (weight === 0) continue
            for (let i = 0; i < headDim; i += 1) y[t * d + offset + i] += weight * v[s * d + offset + i]
          }
        }
      }
      matmulInto(y, T, d, W(`L${layer}.wo`), d, o)
      for (let i = 0; i < T * d; i += 1) h[i] = h[i] + o[i]

      layernormInto(h, T, d, P(`L${layer}.ln2_gain`), P(`L${layer}.ln2_bias`), LN_EPS, b)
      matmulInto(b, T, d, W(`L${layer}.w1`), ff, z)
      geluInto(z, T * ff, z)
      matmulInto(z, T, ff, W(`L${layer}.w2`), d, u)
      for (let i = 0; i < T * d; i += 1) h[i] = h[i] + u[i]
    }

    if (kv) {
      kv.length = T
      kv.stateId = stateId
    }
    const hf = new this.dtype(d)
    layernormInto(h.subarray((T - 1) * d), 1, d, P('lnf_gain'), P('lnf_bias'), LN_EPS, hf)
    return { logits: this.#projectHead(hf), hf, heads: this.#computeTaskHeads(hf) }
  }

  /** Single-token incremental decode step appending at position `kv.length`. */
  #stepKvCache(tokenId, { age = 0, state = 0, kv }) {
    const posIndex = kv.length
    const { d_model: d, d_ff: ff, n_heads: heads, n_layers: layers } = this.config
    const headDim = d / heads
    const W = (name) => this.params.get(name)
    const P = (name) => W(name).data
    const scale = 1 / Math.sqrt(headDim)

    const h = new this.dtype(d)
    this.#embedRow(tokenId, posIndex, (this.config.age_buckets ?? 0) > 0 ? age : 0, (this.config.state_classes ?? 0) > 0 ? state : 0, h, 0)

    const a = new this.dtype(d)
    const q = new this.dtype(d)
    const kRow = new this.dtype(d)
    const vRow = new this.dtype(d)
    const y = new this.dtype(d)
    const o = new this.dtype(d)
    const b = new this.dtype(d)
    const z = new this.dtype(ff)
    const u = new this.dtype(d)
    const seqLenNow = posIndex + 1
    this.assertMemory(seqLenNow)
    const scores = new Float64Array(seqLenNow)
    const attention = new Float64Array(seqLenNow)

    for (let layer = 0; layer < layers; layer += 1) {
      layernormInto(h, 1, d, P(`L${layer}.ln1_gain`), P(`L${layer}.ln1_bias`), LN_EPS, a)
      matmulInto(a, 1, d, W(`L${layer}.wq`), d, q)
      matmulInto(a, 1, d, W(`L${layer}.wk`), d, kRow)
      matmulInto(a, 1, d, W(`L${layer}.wv`), d, vRow)

      const kCache = kv.k[layer]
      const vCache = kv.v[layer]
      kCache.set(kRow, posIndex * d)
      vCache.set(vRow, posIndex * d)

      y.fill(0)
      for (let head = 0; head < heads; head += 1) {
        const offset = head * headDim
        let max = -Infinity
        for (let s = 0; s < seqLenNow; s += 1) {
          let dot = 0
          const sBase = s * d + offset
          for (let i = 0; i < headDim; i += 1) dot += q[offset + i] * kCache[sBase + i]
          const sc = dot * scale
          scores[s] = sc
          if (sc > max) max = sc
        }
        let total = 0
        for (let s = 0; s < seqLenNow; s += 1) {
          const wgt = Math.exp(scores[s] - max)
          attention[s] = wgt
          total += wgt
        }
        for (let s = 0; s < seqLenNow; s += 1) {
          const wgt = attention[s] / total
          if (wgt === 0) continue
          const sBase = s * d + offset
          for (let i = 0; i < headDim; i += 1) y[offset + i] += wgt * vCache[sBase + i]
        }
      }
      matmulInto(y, 1, d, W(`L${layer}.wo`), d, o)
      for (let i = 0; i < d; i += 1) h[i] = h[i] + o[i]

      layernormInto(h, 1, d, P(`L${layer}.ln2_gain`), P(`L${layer}.ln2_bias`), LN_EPS, b)
      matmulInto(b, 1, d, W(`L${layer}.w1`), ff, z)
      geluInto(z, ff, z)
      matmulInto(z, 1, ff, W(`L${layer}.w2`), d, u)
      for (let i = 0; i < d; i += 1) h[i] = h[i] + u[i]
    }

    kv.length = seqLenNow
    const hf = new this.dtype(d)
    layernormInto(h, 1, d, P('lnf_gain'), P('lnf_bias'), LN_EPS, hf)
    return { logits: this.#projectHead(hf), hf, heads: this.#computeTaskHeads(hf) }
  }

  /** Logits for the last position of a token window. Returns Float64Array of vocab size. */
  logits(ids, { ages = null, state = 0 } = {}) {
    return this.#forwardSequence(ids, { ages, state }).logits
  }

  /** Evaluate differentiator heads (`verdict`, `state`) on a token window. */
  inspectHeads(ids, { ages = null, state = 0 } = {}) {
    return this.#forwardSequence(ids, { ages, state }).heads
  }

  /** Prove that incremental KV-cache decoding matches full-window evaluation (`< 1e-5` max abs diff). */
  verifyKvCacheParity(ids, { ages = null, state = 0 } = {}) {
    if (ids.length < 3) throw new ArtifactError('verifyKvCacheParity needs at least 3 tokens', { code: 'invalid_request' })
    const full = this.#forwardSequence(ids, { ages, state }).logits
    const prefixLen = ids.length - 2
    const kv = this.createKvCache(ids.length)
    this.#forwardSequence(ids.subarray(0, prefixLen), {
      ages: ages ? ages.subarray(0, prefixLen) : null,
      state,
      kv,
    })
    this.#stepKvCache(ids[prefixLen], { age: ages ? ages[prefixLen] : 0, state, kv })
    const stepped = this.#stepKvCache(ids[prefixLen + 1], { age: ages ? ages[prefixLen + 1] : 0, state, kv }).logits
    let maxAbsError = 0
    for (let i = 0; i < full.length; i += 1) {
      const diff = Math.abs(full[i] - stepped[i])
      if (diff > maxAbsError) maxAbsError = diff
    }
    return { maxAbsError, greedyMatch: argmax(full) === argmax(stepped) }
  }

  generate(options) {
    const steps = this.generateSteps(options)
    for (;;) {
      const step = steps.next()
      if (step.done) return step.value
      if (step.value.type === 'token') options.onToken?.(step.value.text)
      if (step.value.type === 'resource') options.onResourceAdjustment?.(step.value.adjustment)
    }
  }

  /** Pull-based token generator supporting both tokenizers, KV cache, and differentiator heads. */
  *generateSteps({
    prompt,
    ages = null,
    state = null,
    maxNewTokens = null,
    minNewTokens = null,
    repetitionPenalty = null,
    temperature = 0,
    topK = 40,
    seed = 0,
    stop = [],
    signal = null,
  }) {
    if (typeof prompt !== 'string') throw new ArtifactError('a prompt string is required', { code: 'invalid_request' })
    let contextLimit = this.contextTokens
    const available = this.availableMemory()
    while (contextLimit > 1 && this.scratchBytes(contextLimit) > available) contextLimit = Math.max(1, Math.floor(contextLimit / 2))
    this.assertMemory(contextLimit)

    const isBpe = this.tokenizer.kind === 'byte-bpe'
    const encodedAll = isBpe ? this.tokenizer.encode(prompt.slice(-(contextLimit * 8))) : this.tokenizer.encode(prompt.slice(-contextLimit))
    if (!encodedAll.length) throw new ArtifactError('the prompt encodes to no tokens', { code: 'empty_prompt' })
    if (!Number.isFinite(temperature) || temperature < 0) throw new ArtifactError('temperature must be finite and nonnegative', { code: 'invalid_request' })
    if (!Array.isArray(stop) || stop.some((s) => typeof s !== 'string' || !s.length)) {
      throw new ArtifactError('stop sequences must be non-empty strings', { code: 'invalid_request' })
    }

    const limit = Math.min(
      maxNewTokens ?? this.manifest.generation?.maxNewTokens ?? 64,
      this.manifest.generation?.maxNewTokens ?? 64,
    )
    if (limit < 1) throw new ArtifactError('maxNewTokens must be at least 1', { code: 'invalid_request' })
    const effMinNew = minNewTokens ?? (this.instructionTuned && isBpe ? Math.min(8, limit) : 0)
    const effRepPenalty = repetitionPenalty ?? (this.instructionTuned && isBpe ? 1.2 : 1)
    const effFreqPenalty = this.instructionTuned && isBpe && repetitionPenalty == null ? 1.25 : 0
    const effPresencePenalty = this.instructionTuned && isBpe && repetitionPenalty == null ? 0.5 : 0
    const resourceAdjustment = contextLimit < this.contextTokens
      ? { contextTokens: contextLimit, reason: 'available RAM', tradeoff: 'Shorter context retains less input; the task stayed on this device.' }
      : null
    if (resourceAdjustment) yield { type: 'resource', adjustment: resourceAdjustment }

    // Precompute standard chat-delimiter / control-byte token masks for instruction-tuned Byte-BPE decoding.
    let openTagMask = null
    let closeTagMask = null
    let bareTagNameMask = null
    let leadingNonLexicalMask = null
    let newlineOnlyMask = null
    let controlByteMask = null
    if (this.instructionTuned && isBpe && typeof this.tokenizer.tokenBytes === 'function') {
      const V = this.tokenizer.size
      openTagMask = new Uint8Array(V)
      closeTagMask = new Uint8Array(V)
      bareTagNameMask = new Uint8Array(V)
      leadingNonLexicalMask = new Uint8Array(V)
      newlineOnlyMask = new Uint8Array(V)
      controlByteMask = new Uint8Array(V)
      for (let id = 0; id < V; id += 1) {
        const raw = this.tokenizer.tokenBytes(id)
        for (let b = 0; b < raw.length; b += 1) {
          const byte = raw[b]
          if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a) || byte === 0x7f) {
            controlByteMask[id] = 1
            break
          }
        }
        const piece = UTF8_DECODER.decode(raw)
        if (piece.includes('<|')) openTagMask[id] = 1
        if (piece.includes('|>')) closeTagMask[id] = 1
        if (piece === 'end' || piece === 'user' || piece === 'assistant' || piece === 'system') bareTagNameMask[id] = 1
        if (!/[A-Za-z0-9[]/.test(piece)) leadingNonLexicalMask[id] = 1
        if (piece.length > 0 && piece.trim() === '' && piece.includes('\n')) newlineOnlyMask[id] = 1
      }
    }

    const promptIds = Array.from(encodedAll.slice(-contextLimit))
    const ageWindow = ages
      ? Array.from(ages.slice(-promptIds.length))
      : ((this.config.age_buckets ?? 0) > 0 ? new Array(promptIds.length).fill(0) : null)

    const random = mulberry32(seed)
    const window = [...promptIds]
    const produced = []
    let text = ''
    let emitted = 0
    let stoppedBy = 'length'
    let differentiators = null

    const logitsOverridden = this.logits !== DEFAULT_LOGITS
    const kv = logitsOverridden ? null : this.createKvCache(contextLimit)
    let activeState = state ?? 0
    let curOut = null

    for (let step = 0; step < limit; step += 1) {
      if (signal?.aborted) {
        stoppedBy = 'cancelled'
        break
      }
      if (logitsOverridden) {
        curOut = { logits: this.logits(Int32Array.from(window.slice(-contextLimit))), heads: null }
      } else if (step === 0) {
        const prefill = this.#forwardSequence(Int32Array.from(window), {
          ages: ageWindow ? Int32Array.from(ageWindow) : null,
          state: activeState,
          kv,
          signal,
        })
        if (!prefill || signal?.aborted) {
          stoppedBy = 'cancelled'
          break
        }
        differentiators = prefill.heads
        // When `state` was not explicitly pinned by the caller and the model carries a
        // trained state head, condition generation on its inferred expressed state if non-zero!
        if (state == null && differentiators?.state && differentiators.state.index !== activeState) {
          activeState = differentiators.state.index
          const conditioned = this.#forwardSequence(Int32Array.from(window), {
            ages: ageWindow ? Int32Array.from(ageWindow) : null,
            state: activeState,
            kv,
            signal,
          })
          if (!conditioned || signal?.aborted) {
            stoppedBy = 'cancelled'
            break
          }
          curOut = conditioned
        } else {
          curOut = prefill
        }
      } else if (kv.length < contextLimit) {
        curOut = this.#stepKvCache(window[window.length - 1], { age: 0, state: activeState, kv })
      } else {
        // Context reached `contextLimit`; slide the window cleanly and re-prefill KV cache.
        const slid = window.slice(-contextLimit)
        const slidAges = ageWindow ? ageWindow.slice(-contextLimit) : null
        const refilled = this.#forwardSequence(Int32Array.from(slid), {
          ages: slidAges ? Int32Array.from(slidAges) : null,
          state: activeState,
          kv,
          signal,
        })
        if (!refilled || signal?.aborted) {
          stoppedBy = 'cancelled'
          break
        }
        curOut = refilled
      }

      const logits = Float64Array.from(curOut.logits)
      if (controlByteMask) {
        for (let i = 0; i < logits.length; i += 1) {
          if (controlByteMask[i]) logits[i] = -Infinity
        }
      }
      if (openTagMask) {
        const inOpenStopTag = text.endsWith('<|') || text.endsWith('<|end')
        for (let i = 0; i < logits.length; i += 1) {
          if (step < effMinNew && (openTagMask[i] || closeTagMask[i])) logits[i] = -Infinity
          if (!inOpenStopTag && (closeTagMask[i] || bareTagNameMask[i])) logits[i] = -Infinity
        }
        if (step === 0) {
          for (let i = 0; i < logits.length; i += 1) {
            if (leadingNonLexicalMask[i] || bareTagNameMask[i]) logits[i] = -Infinity
          }
        } else if (text.endsWith('\n')) {
          for (let i = 0; i < logits.length; i += 1) {
            if (newlineOnlyMask[i]) logits[i] = -Infinity
          }
        }
      }
      if ((effRepPenalty > 1 || effFreqPenalty > 0) && produced.length > 0) {
        const counts = new Map()
        for (let i = 0; i < produced.length; i += 1) counts.set(produced[i], (counts.get(produced[i]) ?? 0) + 1)
        for (const [tok, count] of counts) {
          if (effRepPenalty > 1) {
            logits[tok] = logits[tok] < 0 ? logits[tok] * effRepPenalty : logits[tok] / effRepPenalty
          }
          if (effFreqPenalty > 0 || effPresencePenalty > 0) {
            logits[tok] -= effPresencePenalty + count * effFreqPenalty
          }
        }
      }
      let next
      if (temperature === 0) {
        next = argmax(logits)
      } else {
        for (let i = 0; i < logits.length; i += 1) logits[i] /= temperature
        if (topK && topK < logits.length) {
          const sorted = Float64Array.from(logits).sort()
          const cutoff = sorted[sorted.length - topK]
          for (let i = 0; i < logits.length; i += 1) if (logits[i] < cutoff) logits[i] = -Infinity
        }
        let max = -Infinity
        for (const value of logits) if (value > max) max = value
        let total = 0
        for (let i = 0; i < logits.length; i += 1) {
          logits[i] = Math.exp(logits[i] - max)
          total += logits[i]
        }
        let target = random() * total
        next = logits.length - 1
        for (let i = 0; i < logits.length; i += 1) {
          target -= logits[i]
          if (target <= 0) {
            next = i
            break
          }
        }
      }

      window.push(next)
      if (ageWindow) ageWindow.push(0)
      produced.push(next)

      const decoded = isBpe ? this.tokenizer.decodeStreaming(produced) : { text: this.tokenizer.decode(produced), pendingBytes: 0 }
      text = decoded.text

      // Check earliest occurrence of any declared stop sequence so multi-character BPE tokens
      // like `|>\n` stop cleanly and strip everything from the stop marker onward.
      let stopCut = -1
      for (const sequence of stop) {
        const at = text.indexOf(sequence)
        if (at !== -1 && (stopCut === -1 || at < stopCut)) stopCut = at
      }
      if (stopCut !== -1) {
        text = text.slice(0, stopCut)
        stoppedBy = 'stop'
        break
      }

      let hold = 0
      for (const sequence of stop) {
        for (let size = Math.min(sequence.length - 1, text.length); size > hold; size -= 1) {
          if (text.endsWith(sequence.slice(0, size))) {
            hold = size
            break
          }
        }
      }
      const end = text.length - hold
      if (end > emitted) {
        yield { type: 'token', text: text.slice(emitted, end) }
        emitted = end
      }
    }

    if (stoppedBy !== 'stop' && isBpe && produced.length) {
      // Flush any trailing bytes cleanly at sequence end.
      text = this.tokenizer.decode(produced)
    }
    if (text.length > emitted) yield { type: 'token', text: text.slice(emitted) }

    return {
      text,
      tokenIds: produced,
      stoppedBy,
      promptTokens: isBpe ? encodedAll.length : prompt.length,
      generatedTokens: produced.length,
      contextTokens: contextLimit,
      resourceAdjustment,
      differentiators,
    }
  }
}

const DEFAULT_LOGITS = KlyvaronRuntime.prototype.logits
