import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { advanceKlyvaronModelRelease, klyvaronReleaseGateReport, MODEL_RELEASE_STATES } from './model-registry.mjs'

const VALID_STATUSES = new Set(Object.values(MODEL_RELEASE_STATES))

function freeze(value) {
  if (!value || typeof value !== 'object') return value
  for (const child of Object.values(value)) freeze(child)
  return Object.freeze(value)
}

/**
 * Durable local lifecycle state for Klyvaron release records. This is a trusted Core-side
 * service; it exposes no browser mutation route. Evidence must come from verifier/training
 * components before `advance` is called. Writes are atomic and private to the installation.
 */
export class KlyvaronModelRegistryStore {
  #trustStore

  constructor({ filePath, initialRecords, trustStore = null }) {
    if (typeof filePath !== 'string' || !filePath || !initialRecords || typeof initialRecords !== 'object') {
      throw new TypeError('Klyvaron model registry storage requires a path and seed records')
    }
    if (trustStore !== null && typeof trustStore.verify !== 'function') {
      throw new TypeError('Klyvaron evidence trust store must provide verify(payload, attestation, options)')
    }
    this.#trustStore = trustStore
    this.filePath = resolve(filePath)
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    this.records = this.#loadOrSeed(initialRecords)
  }

  #loadOrSeed(initialRecords) {
    let records
    if (existsSync(this.filePath)) {
      let saved
      try {
        saved = JSON.parse(readFileSync(this.filePath, 'utf8'))
      } catch (error) {
        throw new Error(`Klyvaron model registry is unreadable; refusing to reset release state: ${error.message}`)
      }
      if (!saved || saved.version !== 1 || !saved.records || typeof saved.records !== 'object' || Array.isArray(saved.records)) {
        throw new Error('Klyvaron model registry has an unsupported or malformed schema; refusing to reset release state')
      }
      records = structuredClone(saved.records)
      for (const [id, record] of Object.entries(records)) {
        if (!record || record.id !== id || !VALID_STATUSES.has(record.status)) {
          throw new Error(`Klyvaron model registry contains an invalid record '${id}'; refusing to reset release state`)
        }
        if (record.ownership === 'first_party_fine_tuned_assistant') {
          const gates = klyvaronReleaseGateReport(record, { trustStore: this.#trustStore })
          const validPersistedStage = record.status === MODEL_RELEASE_STATES.PLANNED
            || record.status === MODEL_RELEASE_STATES.TRAINING
            || (record.status === MODEL_RELEASE_STATES.TRAINED
              && gates.gates.verifiedArtifactAndChecksum && gates.gates.artifactIntegrityAttested)
            || (record.status === MODEL_RELEASE_STATES.EVALUATED
              && gates.gates.verifiedArtifactAndChecksum && gates.gates.artifactIntegrityAttested
              && gates.gates.heldOutEvaluationPassed)
            || (record.status === MODEL_RELEASE_STATES.RELEASE_CANDIDATE && gates.releaseCandidateReady)
            || (record.status === MODEL_RELEASE_STATES.PRODUCTION_APPROVED && gates.productionApprovalReady)
            || (record.status === MODEL_RELEASE_STATES.RELEASED && gates.releasedReady)
            || (record.status === MODEL_RELEASE_STATES.SUSPENDED && typeof record.reason === 'string' && record.reason.trim())
            || record.status === MODEL_RELEASE_STATES.FAILED
            || record.status === MODEL_RELEASE_STATES.DEPRECATED
          if (!validPersistedStage) {
            throw new Error(`Klyvaron model registry contains an unverifiable persisted stage for '${id}'; refusing to advertise it`)
          }
        }
      }
      let changed = false
      for (const [id, seed] of Object.entries(initialRecords)) {
        if (!records[id]) { records[id] = structuredClone(seed); changed = true }
      }
      if (changed) this.#write(records)
    } else {
      records = structuredClone(initialRecords)
      this.#write(records)
    }
    return records
  }

  #write(records) {
    const tempPath = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      writeFileSync(tempPath, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      chmodSync(tempPath, 0o600)
      renameSync(tempPath, this.filePath)
      chmodSync(this.filePath, 0o600)
    } catch (error) {
      throw new Error(`Klyvaron model registry write failed: ${error.message}`)
    }
  }

  get(id) {
    const record = this.records[id]
    return record ? freeze(structuredClone(record)) : null
  }

  list() {
    return Object.values(this.records).map((record) => freeze(structuredClone(record)))
  }

  snapshot() {
    return freeze(Object.fromEntries(this.list().map((record) => [record.id, record])))
  }

  advance(id, nextStatus, evidence = {}) {
    const current = this.records[id]
    if (!current) throw new Error(`unknown Klyvaron model release record '${id}'`)
    const next = advanceKlyvaronModelRelease(current, nextStatus, evidence, { trustStore: this.#trustStore })
    const records = { ...this.records, [id]: next }
    this.#write(records)
    this.records = records
    return this.get(id)
  }
}
