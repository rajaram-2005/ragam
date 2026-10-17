// Accelerators a local model can run on, and the arithmetic that decides whether it fits.
//
// "Pro and Max need a GPU" is not an answer a user can act on. What they need to know is which
// accelerator their machine has, which runtime actually uses it, and whether the model plus its
// context fits in the memory that accelerator reports right now. This module answers those three
// questions and refuses to guess at any of them:
//
//   1  AN ACCELERATOR IS NOT CONFIRMED UNTIL A PROBE CONFIRMS IT. An Apple laptop is not a Metal
//      runtime, an Intel laptop is not an NPU runtime, and a discrete card is not a working
//      driver. `eligibleAccelerators()` returns candidates with `confirmed: false` and the probe
//      that would confirm them. A candidate can never satisfy a placement on its own.
//   2  THE MEMORY ARITHMETIC IS DONE, NOT ESTIMATED. Weights are parameters x bits / 8, and the
//      KV cache is 2 (K and V) x layers x kv-heads x head-dim x context x bytes-per-element.
//      Those are the two numbers that decide a real refusal.
//   3  UNKNOWN MEMORY IS A REFUSAL, NOT A ZERO. A device that does not report available memory
//      cannot be judged to have enough of it.
//   4  CPU IS NOT A GPU TIER. `requiresAccelerator` is passed by the caller: a GPU tier with no
//      confirmed accelerator is refused, and the refusal names what is missing.

/** Runtimes that can consume each accelerator, and how each one is confirmed. */
export const ACCELERATORS = Object.freeze({
  cuda: {
    id: 'cuda', vendor: 'NVIDIA', kind: 'gpu',
    probe: 'nvidia-smi reports the device (hardware/detect.mjs does this already)',
    runtimes: ['llama.cpp (CUDA)', 'Ollama (CUDA)', 'vLLM', 'PyTorch CUDA'],
    notes: 'Reported memory must be the free figure, not the card total.',
  },
  rocm: {
    id: 'rocm', vendor: 'AMD', kind: 'gpu',
    probe: 'a runtime probe reporting backend "rocm" (rocm-smi or a ROCm PyTorch build)',
    runtimes: ['llama.cpp (ROCm)', 'Ollama (ROCm)', 'PyTorch ROCm'],
    notes: 'A ROCm runtime probe is an extension point; nothing here assumes one is installed.',
  },
  metal: {
    id: 'metal', vendor: 'Apple', kind: 'gpu',
    probe: 'a runtime probe reporting backend "mps" on darwin/arm64',
    runtimes: ['llama.cpp (Metal)', 'Ollama (Metal)', 'PyTorch MPS'],
    notes: 'Unified memory: the budget is system RAM, and the model competes with everything else.',
  },
  vulkan: {
    id: 'vulkan', vendor: 'any', kind: 'gpu',
    probe: 'a runtime probe reporting backend "vulkan"',
    runtimes: ['llama.cpp (Vulkan)'],
    notes: 'The portable fallback for cards with no vendor runtime. Slower, still accelerated.',
  },
  'openvino-gpu': {
    id: 'openvino-gpu', vendor: 'Intel', kind: 'gpu',
    probe: 'an OpenVINO probe listing a GPU device',
    runtimes: ['OpenVINO GenAI', 'llama.cpp via OpenVINO'],
    notes: 'Integrated Intel graphics share system memory with the CPU.',
  },
  'openvino-npu': {
    id: 'openvino-npu', vendor: 'Intel', kind: 'npu',
    probe: 'an OpenVINO probe listing an NPU device',
    runtimes: ['OpenVINO GenAI (NPU)'],
    notes: 'An NPU is not a GPU: it holds less, prefers a converted int8/int4 graph, and its runtime is separate.',
  },
  cpu: {
    id: 'cpu', vendor: 'any', kind: 'cpu',
    probe: 'always available',
    runtimes: ['llama.cpp (CPU)', 'Ollama (CPU)', 'the core\'s own klyvaron runtime'],
    notes: 'The accessibility path. Not an accelerator, and never evidence of a GPU tier.',
  },
})

export const ACCELERATOR_IDS = Object.freeze(Object.keys(ACCELERATORS))

const isBytes = (n) => Number.isSafeInteger(n) && n >= 0
const positiveInt = (n) => Number.isSafeInteger(n) && n > 0

/** Weight bytes: parameters x bits per weight / 8. The quantisation is the caller's choice. */
export function weightBytes({ parameters, bitsPerWeight = 16 } = {}) {
  if (!positiveInt(parameters)) throw new TypeError('weightBytes: parameters must be a positive integer')
  if (![4, 8, 16, 32].includes(bitsPerWeight)) throw new TypeError(`weightBytes: unsupported bitsPerWeight ${bitsPerWeight}`)
  return Math.ceil((parameters * bitsPerWeight) / 8)
}

/**
 * KV cache bytes: 2 (one K, one V) x layers x kvHeads x headDim x context x bytesPerElement.
 * Groups/heads is not guessed: `kvHeads` is the model's own key/value head count, which is what
 * grouped-query attention changes -- using the attention head count would overstate memory by
 * the group factor and refuse a machine that would have run the model.
 */
export function kvCacheBytes({ layers, kvHeads, headDim, contextTokens, bytesPerElement = 2 } = {}) {
  for (const [name, value] of Object.entries({ layers, kvHeads, headDim, contextTokens })) {
    if (!positiveInt(value)) throw new TypeError(`kvCacheBytes: ${name} must be a positive integer`)
  }
  if (![1, 2, 4].includes(bytesPerElement)) throw new TypeError(`kvCacheBytes: bytesPerElement must be 1, 2 or 4`)
  return 2 * layers * kvHeads * headDim * contextTokens * bytesPerElement
}

export function envelope({ parameters, bitsPerWeight, layers, kvHeads, headDim, contextTokens, bytesPerElement }) {
  const weightsBytes = weightBytes({ parameters, bitsPerWeight })
  const kvBytes = kvCacheBytes({ layers, kvHeads, headDim, contextTokens, bytesPerElement })
  return { weightsBytes, kvBytes, totalBytes: weightsBytes + kvBytes }
}

/**
 * Which accelerators this device could use, and which are confirmed.
 *
 * `confirmed` is true only when a runtime probe names the backend. A device record with no
 * runtimes therefore yields candidates and no confirmation -- which is what the placement below
 * refuses on.
 */
export function eligibleAccelerators(device = {}) {
  const out = []
  const runtimes = Array.isArray(device.runtimes) ? device.runtimes : []
  const gpus = Array.isArray(device.gpus) ? device.gpus : []
  const backends = new Set([...gpus.map((g) => g?.backend), ...runtimes.map((r) => r?.backend)].filter(Boolean))

  for (const gpu of gpus) {
    const id = ACCELERATORS[gpu.backend] ? gpu.backend : null
    if (!id) continue
    out.push({
      accelerator: id, name: gpu.name ?? id, confirmed: true, totalBytes: isBytes(gpu.totalBytes) ? gpu.totalBytes : null,
      availableBytes: isBytes(gpu.availableBytes) ? gpu.availableBytes : null,
      confirmedBy: `device probe: ${gpu.name ?? id}`,
    })
  }
  for (const runtime of runtimes) {
    const id = ACCELERATORS[runtime.backend] ? runtime.backend : null
    if (!id || out.some((entry) => entry.accelerator === id && entry.confirmed)) continue
    out.push({
      accelerator: id, name: runtime.id ?? runtime.backend, confirmed: true,
      totalBytes: null, availableBytes: null, confirmedBy: `runtime probe: ${runtime.id ?? runtime.backend}`,
    })
  }
  // Candidates the probes did not confirm. They are listed so a user can see what to install and
  // re-probe, and they are never enough to place a model.
  const candidates = []
  if (device.os === 'darwin' && device.arch === 'arm64' && !backends.has('metal')) candidates.push('metal')
  if (device.os === 'linux' && device.arch === 'x64' && !backends.has('openvino-npu')) candidates.push('openvino-npu', 'openvino-gpu')
  return {
    confirmed: out,
    candidates: candidates.map((id) => ({ accelerator: id, confirmed: false, probe: ACCELERATORS[id].probe })),
    cpuAvailable: true,
  }
}

/**
 * Can this model run on this device, at this context?
 *
 * Returns the arithmetic and every reason it does not fit. `requiresAccelerator` is the caller's
 * rule -- true for the GPU tiers -- and a CPU-only device fails it explicitly rather than quietly.
 */
export function placementFor({ device, model, contextTokens, requiresAccelerator = false, bitsPerWeight = 16, bytesPerElement = 2, reserveBytes = 512 * 1024 ** 2 } = {}) {
  const reasons = []
  if (!model || !positiveInt(model.parameters) || !positiveInt(model.layers) || !positiveInt(model.kvHeads) || !positiveInt(model.headDim)) {
    return { eligible: false, reasons: ['model record is incomplete: parameters, layers, kvHeads and headDim are all required'], envelope: null }
  }
  if (!device || typeof device !== 'object') {
    return { eligible: false, reasons: ['no device record: an unmeasured device cannot be judged to fit'], envelope: null }
  }
  if (!positiveInt(contextTokens) || contextTokens > (model.maxContextTokens ?? contextTokens)) {
    reasons.push('the requested context is not a positive integer, or exceeds what the model was evaluated at')
  }
  const memory = envelope({ parameters: model.parameters, bitsPerWeight, layers: model.layers, kvHeads: model.kvHeads, headDim: model.headDim, contextTokens: positiveInt(contextTokens) ? contextTokens : 1, bytesPerElement })
  const found = eligibleAccelerators(device)
  const chosen = found.confirmed.find((entry) => entry.accelerator !== 'cpu') ?? null

  if (!chosen) {
    const cpuEnough = isBytes(device.availableRamBytes) && device.availableRamBytes >= memory.totalBytes + reserveBytes
    if (requiresAccelerator) {
      reasons.push('this tier requires a confirmed accelerator, and no runtime probe confirmed one '
        + `(candidates to install and re-probe: ${found.candidates.map((c) => c.accelerator).join(', ') || 'none detected'})`)
    } else if (!isBytes(device.availableRamBytes)) {
      reasons.push('available system memory is unknown, so CPU placement cannot be judged')
    } else if (!cpuEnough) {
      reasons.push(`CPU placement needs ${memory.totalBytes + reserveBytes} bytes (model, context and reserve) and ${device.availableRamBytes} are available`)
    }
    return {
      eligible: !requiresAccelerator && !reasons.length, accelerator: reasons.length ? null : 'cpu', runtime: reasons.length ? null : ACCELERATORS.cpu.runtimes[0],
      envelope: memory, budget: { availableBytes: isBytes(device.availableRamBytes) ? device.availableRamBytes : null, reserveBytes }, reasons,
      note: 'A candidate accelerator that a probe did not confirm is not a placement.',
    }
  }

  const available = chosen.availableBytes ?? (chosen.accelerator === 'metal' && isBytes(device.availableRamBytes) ? device.availableRamBytes : null)
  if (!isBytes(available)) {
    reasons.push(`available memory on ${chosen.accelerator} is not reported; a device with unknown free memory cannot be judged to fit`)
  } else if (available < memory.totalBytes + reserveBytes) {
    reasons.push(`${chosen.accelerator} has ${available} bytes available; this model and context need ${memory.totalBytes + reserveBytes} including a ${reserveBytes}-byte reserve, `
      + `so reduce the context, quantise further, or use a smaller model`)
  }
  return {
    eligible: reasons.length === 0,
    accelerator: chosen.accelerator,
    runtime: ACCELERATORS[chosen.accelerator].runtimes[0],
    envelope: memory,
    budget: { availableBytes: isBytes(available) ? available : null, reserveBytes },
    reasons,
    confirmedBy: chosen.confirmedBy,
  }
}
