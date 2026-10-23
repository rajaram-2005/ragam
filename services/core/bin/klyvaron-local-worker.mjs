#!/usr/bin/env node
// Standalone CLI entry point for running the authenticated Klyvaron Local Worker
// on the user's own computer (`linux`, `darwin`, or `win32`).

import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

import { KlyvaronLocalWorkerServer } from '../src/klyvaron/local-worker.mjs'

function readArg(args, flag, fallback = null) {
  const idx = args.indexOf(flag)
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : fallback
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write([
      'Usage: node services/core/bin/klyvaron-local-worker.mjs [options]',
      '  --workspace <dir>       Authorized local training workspace directory (default: ./.klyvaron-user-worker)',
      '  --models-dir <dir>      Authorized Klyvaron models directory (default: ./.aetheris-data/online/klyvaron/models)',
      '  --pairing-secret <str>  One-time pairing secret generated if omitted',
      '  --host <loopback>       Loopback interface (default: 127.0.0.1)',
      '  --port <port>           TCP port (default: 4319)',
      '  --label <name>          Human-readable device label',
    ].join('\n') + '\n')
    return
  }

  const workspaceDir = resolve(readArg(args, '--workspace', './.klyvaron-user-worker'))
  const modelsDir = resolve(readArg(args, '--models-dir', './.aetheris-data/online/klyvaron/models'))
  const pairingSecret = readArg(args, '--pairing-secret', randomBytes(24).toString('hex'))
  const host = readArg(args, '--host', '127.0.0.1')
  const port = Number(readArg(args, '--port', '4319'))
  const workerLabel = readArg(args, '--label', `${process.platform}-${process.arch} user machine`)

  const worker = new KlyvaronLocalWorkerServer({
    workspaceDir,
    modelsDir,
    pairingSecret,
    workerLabel,
    host,
    port,
  })
  const endpoint = await worker.start()
  const caps = worker.detectCapabilities()
  process.stdout.write(JSON.stringify({
    status: 'listening_unpaired',
    endpoint,
    pairingSecret,
    platform: caps.platform,
    arch: caps.arch,
    cpuCores: caps.cpu.logicalCores,
    availableRamMb: Math.round(caps.memory.availableRamBytes / 1e6),
    gpuAvailable: caps.gpu.available,
    supportedBackends: caps.software.supportedBackends,
  }, null, 2) + '\n')

  const shutdown = async () => {
    await worker.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  process.stderr.write(`klyvaron-local-worker error: ${err.message}\n`)
  process.exit(1)
})
