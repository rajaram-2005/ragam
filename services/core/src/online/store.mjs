import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { failure, runtimeFor } from './gateway.mjs'

// Single-operator, server-owned store. File encryption protects a settings-only
// backup; possession of both this file and master.key decrypts the credential.
//
// One active connection at a time. `kind` says which runtime it is (LiteLLM, Ollama or
// llama.cpp). Records written before runtimes existed have no `kind`, and they were
// always LiteLLM, so an absent kind reads as 'litellm' rather than being rewritten.
export class OnlineStore {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700)
    this.file = join(dir, 'provider.json')
    const master = join(dir, 'master.key')
    if (!existsSync(master)) writeFileSync(master, randomBytes(32), { mode: 0o600, flag: 'wx' })
    this.key = readFileSync(master)
    if (this.key.length !== 32) throw Error('Invalid provider encryption key')
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { kind: 'litellm', baseUrl: '', key: null, models: [], selectedModel: '', verified: {}, revision: 0 }
    if (existsSync(this.file)) chmodSync(this.file, 0o600)
  }
  save(patch) {
    const state = { ...this.state, ...patch }
    const temp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' }); renameSync(temp, this.file)
    this.state = state
  }
  kind() { return this.state.kind ?? 'litellm' }
  seal(secret) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    return { iv: iv.toString('base64'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
  }
  /**
   * What a request needs: runtime kind, endpoint and, where one is stored, the decrypted key.
   * A local runtime without a key is valid. A LiteLLM connection without one is not.
   */
  config() {
    const kind = this.kind(), runtime = runtimeFor(kind)
    if (!this.state.baseUrl || (runtime.keyRequired && !this.state.key)) throw failure('provider_not_configured', 'Add your gateway connection in Provider Settings.', 503)
    if (!this.state.key) return { kind, baseUrl: this.state.baseUrl, apiKey: null }
    const { iv, data, tag } = this.state.key
    const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64')); cipher.setAuthTag(Buffer.from(tag, 'base64'))
    return { kind, baseUrl: this.state.baseUrl, apiKey: Buffer.concat([cipher.update(Buffer.from(data, 'base64')), cipher.final()]).toString('utf8') }
  }
  public() {
    const { baseUrl, models, selectedModel, checkedAt, verified, revision } = this.state
    const kind = this.kind(), runtime = runtimeFor(kind)
    // `configured` is the connection being usable, which is not the same as holding a key:
    // a local runtime is configured by its endpoint alone.
    const configured = Boolean(baseUrl) && (Boolean(this.state.key) || !runtime.keyRequired)
    return { kind, name: runtime.label, baseUrl, keyRequired: runtime.keyRequired, keyConfigured: Boolean(this.state.key), configured, models, selectedModel, checkedAt: checkedAt ?? null, verified, revision }
  }
}
