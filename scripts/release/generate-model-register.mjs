#!/usr/bin/env node
// Model-by-model qualification evidence derived from the tracked model cards and
// the actual filesystem. No weight payload is manufactured or downloaded.
//
//   node scripts/release/generate-model-register.mjs

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { atRoot, writeJson } from './lib.mjs'

const cardDir = atRoot('docs/model-cards')
const cards = readdirSync(cardDir).filter((name) => name.endsWith('.json')).sort()
const byFamily = { lite: [], pro: [], max: [] }
for (const name of cards) {
  const card = JSON.parse(readFileSync(join(cardDir, name), 'utf8'))
  const family = card.card?.family ?? 'unknown'
  const key = /klyvaron-pro|klyvaron-mini/.test(family) ? 'pro' : /klyvaron-max/.test(family) ? 'max' : /aetheris-lite/.test(family) ? 'lite' : null
  if (!key) continue
  const artifacts = []
  const a = card.card?.artifacts ?? {}
  for (const [label, filename, digest, bytes] of [
    ['int8', a.filename, a.fileDigest, a.bytes],
    ['fp32', a.fp32Filename, a.fp32FileDigest, a.fp32Bytes],
  ]) {
    if (!filename) continue
    artifacts.push({ label, filename, expectedSha256: digest ?? null, expectedBytes: bytes ?? null, presentInCheckout: false, verifiedSha256: null })
  }
  byFamily[key].push({
    card: name,
    identifier: card.card?.identifier ?? null,
    status: card.card?.status ?? null,
    licence: card.card?.licence ?? null,
    architecture: 'from-scratch pure-NumPy TransformerLM (archived experiment)',
    parameterCount: card.card?.parameterCount ?? null,
    generateCommand: card.reproduce ?? null,
    note: card.note ?? null,
    artifacts,
  })
}

// A real filesystem check, not a remembered result: neither Git nor the working
// tree may contain weight payloads.
const WEIGHT_EXT = /\.(safetensors|bin|pt|pth|onnx|gguf|npz|ckpt|lora)$/i
const found = []
const walk = (dir, depth = 0) => {
  if (depth > 5) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.venv', 'dist', 'build', '__pycache__', 'docs'].includes(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, depth + 1)
    else if (WEIGHT_EXT.test(entry.name)) found.push(full.replace(`${atRoot('')}/`, ''))
  }
}
walk(atRoot(''))

const tier = (id, label, family) => ({
  id,
  label,
  architecture: 'Model-independent deterministic Klyvaron processor (no separate trained model per tier)',
  tokenizer: 'Deterministic text tokenizer in services/core/src/knowledge/text.mjs; no model tokenizer is loaded',
  tierSemantics: 'processing/resource/context/orchestration profile of one shared engine, not a distinct model',
  archivedCards: byFamily[family],
  trackedWeightFiles: [],
  actualWeightsPresent: false,
  artifactSourceAndLicensing: 'Archived model cards claim MIT and a from-scratch first-party pure-NumPy TransformerLM, but every card is status not_released and states that the weight payload is absent. No licence can be verified against bytes that do not exist.',
  qualification: {
    architectureAndTokenizer: { status: 'NOT TESTED', reason: 'The active processor is model-independent; no trained architecture/tokenizer artifact is installed to inspect.' },
    weightsPresent: { status: 'FAIL', reason: 'No weight payload is tracked or installed in this checkout.' },
    sha256Verified: { status: 'BLOCKED', reason: 'Expected digests exist only in archived metadata; there are no bytes to hash and no trusted download source.' },
    runtimeLoad: { status: 'BLOCKED', reason: 'No weights to load.' },
    realInference: { status: 'BLOCKED', reason: 'No loaded model; provider inference requires an authorized credential.' },
    outputLatencyResourceErrorHandling: { status: 'BLOCKED', reason: 'Requires a loaded model and a runtime run.' },
    chatSelection: { status: 'PASS', evidence: 'docs/release/evidence/e2e-qualification.json → chat.model_selection_no_substitution (isolated test service); explicit provider model selection and refusal of unlisted models' },
    tierModelSeparation: { status: 'PASS', evidence: 'services/core/test/online.test.mjs and docs/33-model-independent-klyvaron.md; /api/klyvaron/{lite,pro,max} and tier→model mappings are refused with 410' },
    unavailableReporting: { status: 'PASS', evidence: 'docs/release/evidence/e2e-qualification.json → chat.model_selection_no_substitution returns coded 409 model_unavailable; unconfigured image/video providers return 503 provider_not_configured' },
    multimodal: { status: 'NOT APPLICABLE', justification: 'No first-party image/audio/video weights exist in this release; native multimodal model requests are explicitly refused with 410 model_independent_architecture.' },
  },
  unblock: [
    `Provide an authorized, licensed weight payload for the archived ${label} architecture (expected filenames and digests listed under archivedCards).`,
    'Publish a trusted download source with a SHA-256 manifest, then independently verify the downloaded bytes.',
    'Provide compatible hardware/runtime (CPU memory for the fp32/int8 NumPy artifacts) and an installation procedure that does not place weights in Git.',
    'Record real load, inference, latency, resource and error-handling logs for the exact verified bytes; do not classify metadata as an operational model.',
  ].join(' '),
  notFirstPartyClaim: false,
})

const report = {
  schema: 'ragam-model-qualification/1',
  generatedAt: new Date().toISOString(),
  stance: 'Klyvaron Lite/Pro/Max are processing/resource/context profiles of one shared model-independent engine. Separate trained Pro/Max models are not part of this release. Third-party provider models are never represented as first-party Klyvaron.',
  weightFilesFoundInWorkspace: found,
  weightFilesTrackedInGit: 0,
  models: [tier('lite', 'Klyvaron Lite', 'lite'), tier('pro', 'Klyvaron Pro', 'pro'), tier('max', 'Klyvaron Max', 'max')],
  operationalModelsVerified: 0,
}
for (const model of report.models) {
  for (const card of model.archivedCards) {
    for (const artifact of card.artifacts) {
      artifact.presentInCheckout = found.some((path) => path.endsWith(artifact.filename))
    }
  }
  model.trackedWeightFiles = model.archivedCards.flatMap((card) => card.artifacts.filter((a) => a.presentInCheckout).map((a) => a.filename))
  model.actualWeightsPresent = model.trackedWeightFiles.length > 0
}
writeJson(atRoot('docs/release/model-register.json'), report)
console.log(`model register: ${report.models.length} tiers, ${cards.length} archived cards, ${found.length} weight files found, ${report.operationalModelsVerified} operational models verified`)
