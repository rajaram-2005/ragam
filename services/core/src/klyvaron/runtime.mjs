// Klyvaron Lite inference, in plain JavaScript.
//
// This is the forward pass of `services/fabric/fabric/lm/model.py` — the same
// architecture, the same parameter names, the same order of operations — reimplemented
// for the core service so a phone or a browser-backed core can run a model without a
// Python process. The parity test in `services/core/test/klyvaron-runtime.test.mjs`
// compares this implementation's logits against values computed by NumPy from the same
// weights, which is what makes "the same architecture" a checkable statement rather
// than a comment.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
//  * No instruction following. The artifact is a base completion model: it continues
//    text. There is no chat template here because the model was never trained on one,
//    and inventing one would produce confident-looking output that the model cannot
//    support. `instructionTuned` comes from the manifest and the router respects it.
//  * No KV cache. Each generated token re-runs the full window, exactly as the Python
//    reference does. At a 128-token context and a sub-million-parameter model this is
//    microseconds of work; a cache would be a second implementation to keep in parity.
//  * No quality claim from quantisation: v2 supports int8 resident matrix weights,
//    float32 scales/normalisation and float32 activations. Export evaluates the
//    quality delta; a quantized base completion model is still not an assistant.
//
// Numerical policy: activations are stored in the manifest's dtype (float32 for
// released artifacts), and accumulation happens in JavaScript's float64 with each
// stored value rounded back to the storage dtype. NumPy accumulates float32 matmuls in
// float32 and this does not, so the implementations agree to a small tolerance rather
// than bit-for-bit; the parity test asserts that tolerance and the greedy-decode
// agreement that follows from it.

import { memorySnapshot } from '../hardware/detect.mjs'
import { ArtifactError, loadArtifact, parameterCount } from './format.mjs'

const LN_EPS = 1e-5
const GELU_C = Math.sqrt(2 / Math.PI)
const GELU_K = 0.044715
const NEGATIVE_INFINITY_MASK = -1e9

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

function zeroLike(weights) {
  return weights instanceof Float64Array ? new Float64Array(weights.length) : new Float32Array(weights.length)
}

class ArrayView {
  constructor(array, shape) {
    this.array = array
    this.shape = shape
  }
}

// ---------------------------------------------------------------------------
// Primitives (mirroring model.py, including the backward-free forward subset)
// ---------------------------------------------------------------------------

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

/** out = x (X×Y) · w (Y×Z), row-major. */
function matmulInto(x, X, Y, weight, Z, out) {
  const w = weight.data, scale = weight.scale?.[0] ?? 1
  for (let i = 0; i < X; i += 1) {
    const xBase = i * Y
    for (let k = 0; k < Z; k += 1) out[i * Z + k] = 0
    for (let j = 0; j < Y; j += 1) {
      const xv = x[xBase + j]
      if (xv === 0) continue
      const wBase = j * Z
      for (let k = 0; k < Z; k += 1) out[i * Z + k] += xv * (scale === 1 ? w[wBase + k] : Math.fround(w[wBase + k] * scale))
    }
  }
}

export class KlyvaronRuntime {
  /**
   * @param {object} artifact  the return value of `loadArtifact`
   * @param {object} [options]
   * @param {object} [options.tokenizer]  overrides the manifest vocabulary (used by tests)
   */
  constructor(artifact, { tokenizer = null, availableMemory = () => memorySnapshot().availableRamBytes } = {}) {
    this.availableMemory = availableMemory
    this.manifest = artifact.manifest
    this.directory = artifact.directory
    this.sha256 = artifact.sha256
    const arch = this.manifest.architecture
    this.config = Object.freeze({ ...arch })
    this.params = new Map()
    for (const [name, entry] of artifact.weights) {
      this.params.set(name, { shape: entry.shape, data: entry.data, scale: entry.scale })
    }
    const dtype = artifact.weights.get('emb')?.data
    this.dtype = dtype instanceof Float64Array ? Float64Array : Float32Array
    this.tokenizer = tokenizer ?? this.#buildTokenizer(this.manifest.tokenizer)
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

  #buildTokenizer(spec) {
    const index = new Map()
    spec.characters.forEach((character, i) => index.set(character, i + 1))
    return {
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

  /** Bounds typed-array scratch for this implementation, with headroom for GC.
   * This is an allocation guard, not a measured minimum hardware profile. */
  scratchBytes(context) {
    const { d_model: d, d_ff: ff, vocab_size: v } = this.config
    return 2 * (this.dtype.BYTES_PER_ELEMENT * (context * (10 * d + ff) + d) + 16 * context + 24 * v)
  }

  assertMemory(context) {
    const available = this.availableMemory()
    if (!Number.isFinite(available) || available < this.scratchBytes(context)) {
      throw new ArtifactError('memory pressure: task stopped locally; retry with a smaller model or shorter context', { code: 'needs_hardware' })
    }
  }

  /** Logits for the last position of a token window. Returns Float64Array of vocab size. */
  logits(ids) {
    const T = ids.length
    const { d_model: d, d_ff: ff, n_heads: heads, n_layers: layers, vocab_size: V, seq_len } = this.config
    if (!T) throw new ArtifactError('a prompt is required', { code: 'empty_prompt' })
    if (T > seq_len) throw new ArtifactError(`sequence length ${T} exceeds the context of ${seq_len}`, { code: 'context_overflow' })
    this.assertMemory(T)
    const headDim = d / heads
    const W = (name) => this.params.get(name)
    const P = (name) => W(name).data
    const at = (weight, index) => weight.scale === undefined ? weight.data[index] : Math.fround(weight.data[index] * weight.scale[0])

    // h = emb[ids] + pos[:T]
    const emb = W('emb')
    const pos = W('pos')
    let h = new this.dtype(T * d)
    for (let t = 0; t < T; t += 1) {
      const id = ids[t]
      if (id < 0 || id >= V) throw new ArtifactError(`id ${id} is outside the vocabulary`, { code: 'invalid_token' })
      const embBase = id * d
      const hBase = t * d
      for (let i = 0; i < d; i += 1) h[hBase + i] = at(emb, embBase + i) + at(pos, t * d + i)
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

    for (let layer = 0; layer < layers; layer += 1) {
      layernormInto(h, T, d, P(`L${layer}.ln1_gain`), P(`L${layer}.ln1_bias`), LN_EPS, a)
      matmulInto(a, T, d, W(`L${layer}.wq`), d, q)
      matmulInto(a, T, d, W(`L${layer}.wk`), d, k)
      matmulInto(a, T, d, W(`L${layer}.wv`), d, v)

      y.fill(0)
      const scale = 1 / Math.sqrt(headDim)
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

    const hf = new this.dtype(d)
    layernormInto(h.subarray((T - 1) * d), 1, d, P('lnf_gain'), P('lnf_bias'), LN_EPS, hf)
    const head = this.config.tie_embeddings ? emb : W('head')
    const logits = new Float64Array(V)
    for (let token = 0; token < V; token += 1) {
      let dot = 0
      const base = token * d
      for (let i = 0; i < d; i += 1) dot += hf[i] * at(head, base + i)
      logits[token] = dot
    }
    return logits
  }

  /**
   * Sample a continuation.
   *
   * @param {object} options
   * @param {string} options.prompt
   * @param {number} [options.maxNewTokens]  bounded by the manifest default and the context
   * @param {number} [options.temperature]   0 means greedy (exact, and cross-checked)
   * @param {number} [options.topK]
   * @param {number} [options.seed]
   * @param {string[]} [options.stop]        stop sequences, applied to the decoded text
   * @param {(chunk:string)=>void} [options.onToken]
   * @param {AbortSignal} [options.signal]
   */
  generate(options) {
    const steps = this.generateSteps(options)
    for (;;) {
      const step = steps.next()
      if (step.done) return step.value
      if (step.value.type === 'token') options.onToken?.(step.value.text)
      if (step.value.type === 'resource') options.onResourceAdjustment?.(step.value.adjustment)
    }
  }

  /** Pull-based steps are also consumed by the local worker and in-memory tests. */
  *generateSteps({ prompt, maxNewTokens = null, temperature = 0, topK = 40, seed = 0, stop = [], signal = null }) {
    if (typeof prompt !== 'string') throw new ArtifactError('a prompt string is required', { code: 'invalid_request' })
    let contextLimit = this.contextTokens
    const available = this.availableMemory()
    while (contextLimit > 1 && this.scratchBytes(contextLimit) > available) contextLimit = Math.max(1, Math.floor(contextLimit / 2))
    this.assertMemory(contextLimit)
    // This tokenizer is character-level; avoid allocating an unbounded prompt array.
    const ids = this.tokenizer.encode(prompt.slice(-contextLimit))
    if (!ids.length) throw new ArtifactError('the prompt encodes to no tokens', { code: 'empty_prompt' })
    if (!Number.isFinite(temperature) || temperature < 0) throw new ArtifactError('temperature must be finite and nonnegative', { code: 'invalid_request' })
    if (!Array.isArray(stop) || stop.some((s) => typeof s !== 'string' || !s.length)) {
      throw new ArtifactError('stop sequences must be non-empty strings', { code: 'invalid_request' })
    }

    const limit = Math.min(
      maxNewTokens ?? this.manifest.generation?.maxNewTokens ?? 64,
      this.manifest.generation?.maxNewTokens ?? 64,
    )
    if (limit < 1) throw new ArtifactError('maxNewTokens must be at least 1', { code: 'invalid_request' })
    const resourceAdjustment = contextLimit < this.contextTokens
      ? { contextTokens: contextLimit, reason: 'available RAM', tradeoff: 'Shorter context retains less input; the task stayed on this device.' } : null
    if (resourceAdjustment) yield { type: 'resource', adjustment: resourceAdjustment }
    const random = mulberry32(seed)
    const window = Array.from(ids.slice(-contextLimit))
    const produced = []
    let text = ''
    let emitted = 0
    let stoppedBy = 'length'

    for (let step = 0; step < limit; step += 1) {
      if (signal?.aborted) {
        stoppedBy = 'cancelled'
        break
      }
      const logits = this.logits(Int32Array.from(window.slice(-contextLimit)))
      let next
      if (temperature === 0) {
        let best = 0
        for (let i = 1; i < logits.length; i += 1) if (logits[i] > logits[best]) best = i
        next = best
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
      produced.push(next)
      const character = this.tokenizer.decode([next])
      text += character
      const hit = stop.find((sequence) => text.endsWith(sequence))
      if (hit) {
        text = text.slice(0, -hit.length)
        stoppedBy = 'stop'
        break
      }
      // Hold only a suffix that could become a stop sequence on a later token.
      // Streaming never emits text that the final completion would remove.
      let hold = 0
      for (const sequence of stop) {
        for (let size = Math.min(sequence.length - 1, text.length); size > hold; size -= 1) {
          if (text.endsWith(sequence.slice(0, size))) { hold = size; break }
        }
      }
      const end = text.length - hold
      if (end > emitted) { yield { type: 'token', text: text.slice(emitted, end) }; emitted = end }
    }
    if (text.length > emitted) yield { type: 'token', text: text.slice(emitted) }
    return {
      text,
      tokenIds: produced,
      stoppedBy,
      promptTokens: prompt.length,
      generatedTokens: produced.length,
      contextTokens: contextLimit,
      resourceAdjustment,
    }
  }
}
