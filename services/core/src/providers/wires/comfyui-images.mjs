// ComfyUI's documented local HTTP API: checkpoint discovery, prompt submission, history polling,
// and retrieval of a generated output. This uses the stock text-to-image node graph only; no
// custom workflow/node assumptions and no local server or checkpoint is installed by Ragam.
//
// The base URL must be explicitly trusted by the Core operator because a ComfyUI endpoint is
// commonly private HTTP. Cancellation stops Ragam waiting but does not call ComfyUI's global
// `/interrupt`: that endpoint can interrupt another person's queued generation on a shared host.

import { randomUUID, randomInt } from 'node:crypto'
import { failure } from '../../online/failure.mjs'
import {
  assertModelId, assertPrompt, IMAGE_MAX_BYTES, pollSchedule, sleep, sniffImage,
} from './media-common.mjs'

export const wire = 'comfyui_images'
export const credential = 'none'
export const modality = 'image'

export const SIZES = Object.freeze(['512x512', '768x512', '512x768', '1024x1024'])
const DEFAULT_POLL = Object.freeze({ initialMs: 500, factor: 1.25, maxMs: 1500, attempts: 60 })
const MAX_MODELS = 500
const MAX_DEVICES = 16
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$/
const SAFE_PROMPT_ID = /^[A-Za-z0-9_-]{1,128}$/

function noAuth() { return {} }

/** Extract exactly the installed checkpoint names from ComfyUI's object-info response. */
export async function models(transport, config) {
  const data = await transport(config, '/object_info/CheckpointLoaderSimple', { headers: noAuth() })
  const choices = data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]
  if (!Array.isArray(choices) || choices.some((name) => typeof name !== 'string')) {
    throw failure('invalid_model_list', 'ComfyUI did not return its CheckpointLoaderSimple checkpoint list.', 502)
  }
  const unique = [...new Set(choices)]
  if (unique.length > MAX_MODELS || unique.some((name) => !name || name.length > 200 || name.includes('..'))) {
    throw failure('invalid_model_list', 'ComfyUI returned an unsupported checkpoint list.', 502)
  }
  return unique
}

/**
 * Read the device report from the connected ComfyUI instance itself. Core may run in a Docker
 * container which cannot see the Windows host GPU, so never infer host hardware from Core's own
 * process. Only return device labels and reported VRAM; omit ComfyUI's OS, RAM, argv and paths.
 */
export async function systemInfo(transport, config) {
  const data = await transport(config, '/system_stats', { headers: noAuth() })
  if (!Array.isArray(data?.devices) || data.devices.length > MAX_DEVICES) {
    throw failure('invalid_hardware_report', 'ComfyUI did not return a supported device report.', 502)
  }
  const devices = data.devices.map((device, index) => {
    const clean = (value, maxLength) => typeof value === 'string'
      ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength) || null
      : null
    const bytes = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null
    const vramTotalBytes = bytes(device?.vram_total)
    const reportedFree = bytes(device?.vram_free)
    return {
      index,
      name: clean(device?.name, 160),
      backend: clean(device?.type, 32),
      vramTotalBytes,
      vramFreeBytes: vramTotalBytes !== null && reportedFree !== null && reportedFree <= vramTotalBytes ? reportedFree : null,
    }
  })
  return { source: 'comfyui_system_stats', detectedAt: new Date().toISOString(), devices }
}

function dimensions(size) {
  if (size === undefined || size === '') return { width: 512, height: 512 }
  if (!SIZES.includes(size)) throw failure('invalid_parameters', `Size must be one of ${SIZES.join(', ')}.`, 400)
  const [width, height] = size.split('x').map(Number)
  return { width, height }
}

function workflow({ model, prompt, width, height }) {
  return {
    '3': { class_type: 'KSampler', inputs: {
      seed: randomInt(0, 2 ** 32), steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
      model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
    } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'ragam', images: ['8', 0] } },
  }
}

function outputImages(record) {
  const outputs = record?.outputs
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return []
  return Object.values(outputs).flatMap((entry) => Array.isArray(entry?.images) ? entry.images : [])
}

function safeOutputPath(image) {
  const filename = image?.filename
  const subfolder = image?.subfolder ?? ''
  if (typeof filename !== 'string' || !SAFE_FILE.test(filename) || filename.includes('..')) {
    throw failure('invalid_completion', 'ComfyUI returned an invalid output filename.', 502)
  }
  if (typeof subfolder !== 'string' || subfolder.length > 512 || (subfolder && subfolder.split('/').some((part) => !SAFE_FILE.test(part) || part.includes('..')))) {
    throw failure('invalid_completion', 'ComfyUI returned an invalid output folder.', 502)
  }
  // Generated outputs must come from ComfyUI's output directory. Never read an input or temp file.
  if (image?.type !== 'output') throw failure('invalid_completion', 'ComfyUI did not mark the generated image as an output.', 502)
  const query = new URLSearchParams({ filename, subfolder, type: 'output' })
  return `/view?${query}`
}

export async function generate(transport, config, { model, prompt, size, signal, poll = {} }) {
  assertModelId(model)
  assertPrompt(prompt)
  const { width, height } = dimensions(size)
  if (signal?.aborted) throw failure('cancelled', 'Image generation was cancelled.', 499)

  const submitted = await transport(config, '/prompt', {
    headers: noAuth(),
    signal,
    body: { prompt: workflow({ model, prompt, width, height }), client_id: randomUUID() },
  })
  const promptId = submitted?.prompt_id
  if (typeof promptId !== 'string' || !SAFE_PROMPT_ID.test(promptId)) {
    throw failure('invalid_completion', 'ComfyUI did not return a valid prompt id.', 502)
  }
  if (submitted?.node_errors && Object.keys(submitted.node_errors).length) {
    throw failure('provider_request_rejected', 'ComfyUI rejected one or more nodes in the generated workflow.', 502)
  }

  const schedule = pollSchedule({ ...DEFAULT_POLL, ...poll })
  let images = []
  for (let attempt = 0; attempt < schedule.attempts; attempt += 1) {
    if (signal?.aborted) throw failure('cancelled', 'Image generation was cancelled; ComfyUI may continue its queued work.', 499)
    if (attempt > 0) await sleep(schedule.next(), signal, 'Image generation was cancelled; ComfyUI may continue its queued work.')
    const history = await transport(config, `/history/${encodeURIComponent(promptId)}`, { headers: noAuth(), signal })
    const record = history?.[promptId]
    if (record?.status?.status_str === 'error' || record?.status?.completed === false && record?.status?.status_str === 'error') {
      throw failure('provider_error', 'ComfyUI reported that its image workflow failed.', 502)
    }
    images = outputImages(record)
    if (images.length) break
  }
  if (!images.length) throw failure('provider_timeout', 'ComfyUI did not produce an output within the bounded wait.', 504)

  const path = safeOutputPath(images[0])
  const response = await transport(config, path, {
    headers: noAuth(), signal, binary: true, maxResponseBytes: IMAGE_MAX_BYTES,
  })
  const bytes = response?.bytes
  if (!bytes?.length || bytes.length > IMAGE_MAX_BYTES || !sniffImage(bytes)) {
    throw failure('invalid_completion', 'ComfyUI returned bytes that are not a supported image.', 502)
  }
  return {
    bytes,
    contentType: response.contentType || 'image/png',
    model,
    revisedPrompt: null,
    usage: null,
    operation: promptId,
  }
}
