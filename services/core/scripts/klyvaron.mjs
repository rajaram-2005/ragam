#!/usr/bin/env node
// The operator's path to the on-device model library.
//
// The store is the only thing that may write under `<data-dir>/klyvaron/models`, and this
// script is a thin wrapper over it: it does not copy files itself, and it does not invent a
// second install path that could skip a check. Everything it prints comes from the store or
// from the app, so a scripted install and a UI install take the same four gates -- verify,
// budget, copy, re-verify -- and a failed one is a refusal rather than a warning.
//
//   node services/core/scripts/klyvaron.mjs list
//   node services/core/scripts/klyvaron.mjs install <artifact-dir> [--replace]
//   node services/core/scripts/klyvaron.mjs verify [<artifact-id>]
//   node services/core/scripts/klyvaron.mjs status
//   node services/core/scripts/klyvaron.mjs remove <artifact-id> --yes
//
// `--data-dir <dir>` overrides AETHERIS_DATA_DIR for one command; without either, the
// configured default is used, so the script and the service look at the same library.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { loadConfig } from '../src/config.mjs'
import { KlyvaronStore } from '../src/klyvaron/store.mjs'
import { AetherisOmniApp, publicModel } from '../src/app.mjs'
import { RUNTIME_POLICIES } from '../src/policy/egress.mjs'

const USAGE = `usage: node services/core/scripts/klyvaron.mjs <command> [options]

  list                          installed artifacts, read from disk
  install <dir> [--replace]     verify, budget-check, copy, re-verify, record
  verify [<id>]                 re-verify one artifact, or all of them
  remove <id> --yes             delete an artifact the user asked to delete
  status                        what the app reports for the library it opened

options: --data-dir <dir>   the managed root (default: the configured data dir)`

function parse(argv) {
  const options = { dataDir: null, replace: false, yes: false, positional: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--data-dir') {
      options.dataDir = argv[index + 1]
      if (!options.dataDir) throw new Error('--data-dir needs a directory')
      index += 1
    } else if (argument === '--replace') {
      options.replace = true
    } else if (argument === '--yes') {
      options.yes = true
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown option: ${argument}`)
    } else {
      options.positional.push(argument)
    }
  }
  return options
}

/** The data directory this command acts on, from the same config the service reads. */
function dataDirFor(options) {
  if (options.dataDir) return resolve(options.dataDir)
  return loadConfig({}).dataDir
}

function storeFor(options) {
  return new KlyvaronStore({ root: resolve(dataDirFor(options), 'klyvaron'), dataDir: dataDirFor(options) })
}

function print(entry) {
  console.log(JSON.stringify(entry, null, 2))
}

function commandList(options) {
  const store = storeFor(options)
  const installed = store.list()
  print({
    library: store.libraryPath,
    installed: installed.map((entry) => ({
      id: entry.id,
      version: entry.version,
      tier: entry.tier,
      bytes: entry.bytes,
      instructionTuned: entry.instructionTuned,
      broken: entry.broken ?? undefined,
    })),
    verification: store.verify(),
    storage: store.budget.measure(),
  })
  return installed.some((entry) => entry.broken) ? 1 : 0
}

function commandInstall(options) {
  const [source] = options.positional
  if (!source) throw new Error('install needs a directory holding one artifact')
  const store = storeFor(options)
  // The store's own gates run here. A refusal is thrown, printed, and never downgraded
  // to a warning: an artifact that failed verification must not reach the library.
  const installed = store.install(source, { userRequested: true, replace: options.replace })
  print({
    installed: {
      id: installed.id,
      version: installed.version,
      directory: installed.directory,
      bytes: installed.bytes,
      weightsSha256: installed.sha256,
    },
    verification: store.verify(),
    storage: installed.storage,
  })
  return 0
}

function commandVerify(options) {
  const [id = null] = options.positional
  const store = storeFor(options)
  const results = store.verify(id)
  print({ library: store.libraryPath, verification: results })
  return results.every((entry) => entry.ok) ? 0 : 1
}

function commandRemove(options) {
  const [id] = options.positional
  if (!id) throw new Error('remove needs an artifact id')
  const store = storeFor(options)
  const entry = store.get(id)
  if (!entry) throw new Error(`'${id}' is not installed`)
  if (!options.yes) {
    // Never silently delete user data, including a model the user downloaded. The flag is
    // the user saying it, and the listing above the refusal is what they are agreeing to.
    print({ refused: 'removal needs --yes', wouldRemove: entry })
    return 2
  }
  const removed = store.remove(id)
  print({ removed, verification: store.verify(), storage: store.budget.measure() })
  return 0
}

function commandStatus(options) {
  // Opened the way the service opens it, so what this prints is what `/api/ready`,
  // `/api/models` and `/api/storage` would report -- without needing a server or a port.
  const config = loadConfig({
    AETHERIS_RUNTIME_POLICY: RUNTIME_POLICIES.STRICT_OFFLINE,
    ...(options.dataDir ? { AETHERIS_DATA_DIR: options.dataDir } : {}),
    OLLAMA_ENABLED: 'false',
    LLAMACPP_ENABLED: 'false',
  })
  const app = new AetherisOmniApp({ config })
  const readiness = app.readiness()
  print({
    dataDir: config.dataDir,
    library: app.klyvaron.root,
    health: readiness.status,
    capabilities: readiness.capabilities,
    loaded: readiness.klyvaron.loaded,
    broken: readiness.klyvaron.broken,
    errors: app.klyvaron.errors,
    // Presented the way /api/models presents them, from the same function: the raw registry
    // entry has no derived `tier`, so printing it would show `tier: null` beside a
    // `tier:lite` tag for the same model.
    models: app.registry.list().filter((model) => String(model.id).startsWith('klyvaron:')).map(publicModel),
    storage: app.storageReport(),
  })
  return app.klyvaron.errors.length === 0 ? 0 : 1
}

const COMMANDS = {
  list: commandList,
  install: commandInstall,
  verify: commandVerify,
  remove: commandRemove,
  status: commandStatus,
}

function main(argv) {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE)
    return command ? 0 : 2
  }
  const handler = COMMANDS[command]
  if (!handler) {
    console.error(`unknown command: ${command}\n\n${USAGE}`)
    return 2
  }
  try {
    return handler(parse(rest))
  } catch (error) {
    console.error(JSON.stringify({ error: error.code ?? 'error', message: error.message,
      detail: error.detail ?? undefined }, null, 2))
    return 1
  }
}

process.exitCode = main(process.argv.slice(2))
