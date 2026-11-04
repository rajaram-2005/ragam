#!/usr/bin/env node
// Offline Klyvaron qualification ceremony. This tool handles public evidence only;
// it never accepts, creates, reads or stores a private signing key.
//
//   node scripts/klyvaron-evidence.mjs prepare <model-record.json> <captures.json> <bundle.json>
//   node scripts/klyvaron-evidence.mjs finalize <model-record.json> <bundle.json> <attestation.json> <signed-report.json>
//   node scripts/klyvaron-evidence.mjs audit <model-record.json> <signed-report.json> <public-trust.json>
//   node scripts/klyvaron-evidence.mjs capture <model-record.json> <artifact-root> <pinned-files.json> <adapters.mjs> <capture.json>
//   node scripts/klyvaron-evidence.mjs provision-trust <public-trust.json> <new-trust-store.json>
//   node scripts/klyvaron-evidence.mjs decide <model-records.json> <deployments.json> <public-trust.json> <decision.json>
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  auditKlyvaronQualificationAttestation,
  prepareKlyvaronQualificationSigningRequest,
} from '../src/klyvaron/qualification-ceremony.mjs'
import {
  canonicalKlyvaronEvidenceJson,
  KlyvaronEvidenceTrustStore,
  loadKlyvaronEvidenceTrustStore,
} from '../src/klyvaron/evidence-trust.mjs'
import { captureKlyvaronPlatformQualification } from '../src/klyvaron/qualification-capture.mjs'
import { evaluateKlyvaronReleaseDecision } from '../src/klyvaron/release-decision.mjs'

const MAX_INPUT_BYTES = 8 * 1024 * 1024
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0
const USAGE = [
  'usage:',
  '  node scripts/klyvaron-evidence.mjs prepare <model-record.json> <captures.json> <bundle.json>',
  '  node scripts/klyvaron-evidence.mjs finalize <model-record.json> <bundle.json> <attestation.json> <signed-report.json>',
  '  node scripts/klyvaron-evidence.mjs audit <model-record.json> <signed-report.json> <public-trust.json>',
  '  node scripts/klyvaron-evidence.mjs capture <model-record.json> <artifact-root> <pinned-files.json> <adapters.mjs> <capture.json>',
  '  node scripts/klyvaron-evidence.mjs provision-trust <public-trust.json> <new-trust-store.json>',
  '  node scripts/klyvaron-evidence.mjs decide <model-records.json> <deployments.json> <public-trust.json> <decision.json>',
].join('\n')

function readJson(filePath) {
  const target = resolve(filePath)
  let before
  try { before = lstatSync(target) } catch { throw new Error('input file is missing or inaccessible') }
  if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_INPUT_BYTES) {
    throw new Error('input must be a regular non-symlink JSON file no larger than 8 MiB')
  }
  let descriptor
  try {
    descriptor = openSync(target, constants.O_RDONLY | NO_FOLLOW)
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.size > MAX_INPUT_BYTES
      || (before.ino && opened.ino && (before.dev !== opened.dev || before.ino !== opened.ino))) {
      throw new Error('input changed while it was being opened')
    }
    const bytes = Buffer.allocUnsafe(MAX_INPUT_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    if (length > MAX_INPUT_BYTES) throw new Error('input exceeds the 8 MiB limit')
    return JSON.parse(bytes.subarray(0, length).toString('utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('input is not valid JSON')
    throw error
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function writeNewJson(filePath, value) {
  const target = resolve(filePath)
  const parent = dirname(target)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const parentInfo = lstatSync(parent)
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error('output parent must be a real directory')
  let descriptor
  try {
    descriptor = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor)
      try { unlinkSync(target) } catch {}
    }
    if (error.code === 'EEXIST') throw new Error('refusing to overwrite an existing output file')
    throw error
  }
  closeSync(descriptor)
}

async function loadCaptureAdapters(filePath) {
  const target = resolve(filePath)
  let info
  try { info = lstatSync(target) } catch { throw new Error('capture adapter module is missing or inaccessible') }
  if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) {
    throw new Error('capture adapter must be a reviewed regular non-symlink file no larger than 1 MiB')
  }
  const adapters = await import(pathToFileURL(target).href)
  if (!adapters.runtimeAdapter || !adapters.deploymentAdapter) {
    throw new Error('adapter module must export runtimeAdapter and deploymentAdapter')
  }
  return adapters
}

function finalizeBundle(modelRecord, bundle, attestation) {
  if (!bundle || bundle.schema !== 'klyvaron.qualification-signing-bundle.v1'
    || Object.keys(bundle).some((key) => !['schema', 'report', 'signingRequest'].includes(key))
    || !bundle.report || !Array.isArray(bundle.report.targets)) {
    throw new Error('signing bundle has an unsupported schema')
  }
  const captures = bundle.report.targets.map((target) => ({
    status: 'passed', passed: true, blockers: [], target,
    artifactIntegrityReportSha256: target?.artifactIntegrityReportSha256,
  }))
  const expected = prepareKlyvaronQualificationSigningRequest({ modelRecord, captures })
  if (!expected.passed
    || canonicalKlyvaronEvidenceJson(expected.report) !== canonicalKlyvaronEvidenceJson(bundle.report)
    || canonicalKlyvaronEvidenceJson(expected.signingRequest) !== canonicalKlyvaronEvidenceJson(bundle.signingRequest)) {
    throw new Error('signing bundle does not reproduce from this exact release record and its reports')
  }
  const allowedAttestationKeys = ['algorithm', 'keyId', 'purpose', 'signature']
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)
    || Object.keys(attestation).some((key) => !allowedAttestationKeys.includes(key))
    || attestation.algorithm !== 'ed25519'
    || typeof attestation.keyId !== 'string' || !/^[a-f0-9]{64}$/i.test(attestation.keyId)
    || attestation.purpose !== 'tier_release_qualification'
    || typeof attestation.signature !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attestation.signature)
    || Buffer.from(attestation.signature, 'base64').length !== 64
    || Buffer.from(attestation.signature, 'base64').toString('base64') !== attestation.signature) {
    throw new Error('attestation must be a canonical Ed25519 signature for tier_release_qualification')
  }
  return { ...bundle.report, attestation }
}

function usageError() {
  console.error(USAGE)
  process.exitCode = 64
}

try {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'capture' && args.length === 5) {
    const [modelPath, artifactRoot, pinnedFilesPath, adaptersPath, outputPath] = args
    const { runtimeAdapter, deploymentAdapter } = await loadCaptureAdapters(adaptersPath)
    const result = await captureKlyvaronPlatformQualification({
      modelRecord: readJson(modelPath),
      artifactRoot: resolve(artifactRoot),
      pinnedArtifactFiles: readJson(pinnedFilesPath),
      runtimeAdapter,
      deploymentAdapter,
    })
    writeNewJson(outputPath, result)
    console.log(JSON.stringify({
      status: result.status,
      passed: result.passed,
      output: resolve(outputPath),
      platform: result.target?.platform ?? null,
      architecture: result.target?.architecture ?? null,
      attestationRequired: result.attestationRequired ?? false,
    }, null, 2))
    if (!result.passed) process.exitCode = 2
  } else if (command === 'provision-trust' && args.length === 2) {
    const [sourcePath, outputPath] = args
    const trustDocument = readJson(sourcePath)
    if (!trustDocument || typeof trustDocument !== 'object' || Array.isArray(trustDocument)
      || trustDocument.format !== 'klyvaron-evidence-trust/v1'
      || Object.keys(trustDocument).some((key) => !['format', 'keys', 'supersededEvidenceManifestSha256'].includes(key))
      || !Array.isArray(trustDocument.keys)
      || (trustDocument.supersededEvidenceManifestSha256 !== undefined && !Array.isArray(trustDocument.supersededEvidenceManifestSha256))
      || Buffer.byteLength(JSON.stringify(trustDocument), 'utf8') > 256 * 1024) {
      throw new Error('public trust input has an unsupported schema or exceeds 256 KiB')
    }
    const trustStore = new KlyvaronEvidenceTrustStore({
      keys: trustDocument.keys,
      supersededEvidenceManifestSha256: trustDocument.supersededEvidenceManifestSha256 ?? [],
    })
    if (trustStore.size === 0) throw new Error('refusing to provision an empty evidence trust store')
    writeNewJson(outputPath, trustDocument)
    console.log(JSON.stringify({
      status: 'public_trust_provisioned',
      output: resolve(outputPath),
      keys: trustStore.list(),
      privateKeyHandling: 'not_performed_by_this_tool',
    }, null, 2))
  } else if (command === 'decide' && args.length === 4) {
    const [recordsPath, deploymentsPath, trustPath, outputPath] = args
    const decision = evaluateKlyvaronReleaseDecision({
      records: readJson(recordsPath),
      deployments: readJson(deploymentsPath),
      trustStore: loadKlyvaronEvidenceTrustStore(resolve(trustPath)),
    })
    writeNewJson(outputPath, decision)
    console.log(JSON.stringify({
      status: decision.status,
      ready: decision.ready,
      decisionSha256: decision.decisionSha256,
      output: resolve(outputPath),
      executesTestsOrDeployments: false,
    }, null, 2))
    if (!decision.ready) process.exitCode = 2
  } else if (command === 'prepare' && args.length === 3) {
    const [modelPath, capturesPath, outputPath] = args
    const result = prepareKlyvaronQualificationSigningRequest({
      modelRecord: readJson(modelPath),
      captures: readJson(capturesPath),
    })
    if (!result.passed) {
      console.log(JSON.stringify(result, null, 2))
      process.exitCode = 2
    } else {
      writeNewJson(outputPath, {
        schema: 'klyvaron.qualification-signing-bundle.v1',
        report: result.report,
        signingRequest: result.signingRequest,
      })
      console.log(JSON.stringify({
        status: result.status,
        passed: true,
        output: resolve(outputPath),
        privateKeyHandling: 'not_performed_by_this_tool',
      }, null, 2))
    }
  } else if (command === 'finalize' && args.length === 4) {
    const [modelPath, bundlePath, attestationPath, outputPath] = args
    const signedReport = finalizeBundle(
      readJson(modelPath), readJson(bundlePath), readJson(attestationPath),
    )
    writeNewJson(outputPath, signedReport)
    console.log(JSON.stringify({
      status: 'ready_for_signature_audit',
      passed: true,
      output: resolve(outputPath),
      signatureVerified: false,
      privateKeyHandling: 'not_performed_by_this_tool',
    }, null, 2))
  } else if (command === 'audit' && args.length === 3) {
    const [modelPath, reportPath, trustPath] = args
    const result = auditKlyvaronQualificationAttestation({
      modelRecord: readJson(modelPath),
      qualificationReport: readJson(reportPath),
      trustStore: loadKlyvaronEvidenceTrustStore(resolve(trustPath)),
    })
    console.log(JSON.stringify(result, null, 2))
    if (!result.passed) process.exitCode = 2
  } else {
    usageError()
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'error', message: error.message }))
  process.exitCode = 1
}
