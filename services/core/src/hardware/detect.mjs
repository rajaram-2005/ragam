// Local OS measurements only. Unknown is null, never an invented zero/qualification.
import { arch, cpus, freemem, platform, totalmem } from 'node:os'
import { readFileSync, statfsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const number = (value) => {
  const n = Number(value)
  return String(value).trim() && Number.isFinite(n) && n >= 0 ? n : null
}
const read = (path) => { try { return readFileSync(path, 'utf8') } catch { return '' } }

export function parseNvidiaSmi(text) {
  return text.trim().split('\n').filter(Boolean).flatMap((line) => {
    const [id, name, total, free] = line.split(',').map((s) => s.trim())
    const totalMiB = number(total), freeMiB = number(free)
    if (!id || !name || totalMiB === null || freeMiB === null || freeMiB > totalMiB) return []
    return [{ id, name, backend: 'cuda', totalBytes: totalMiB * 1024 ** 2, availableBytes: freeMiB * 1024 ** 2 }]
  })
}

export function detectHardware({ storagePath = process.cwd(), runtimeProbe = () => [], gpuProbe = null } = {}) {
  const os = platform(), cpu = cpus()
  const warnings = []
  const { availableRamBytes, totalRamBytes } = memorySnapshot()
  const flags = os === 'linux' ? [...read('/proc/cpuinfo').matchAll(/^(?:flags|Features)\s*:\s*(.+)$/gm)].map((m) => m[1].split(/\s+/)) : []
  const instructionSets = flags.length ? flags[0].filter((f) => flags.every((set) => set.includes(f))) : null
  let availableStorageBytes = null
  try { const fs = statfsSync(storagePath); availableStorageBytes = fs.bavail * fs.bsize } catch { warnings.push('storage measurement unavailable') }
  let gpus = []
  try {
    gpus = gpuProbe ? gpuProbe() : parseNvidiaSmi(execFileSync('nvidia-smi', [
      '--query-gpu=uuid,name,memory.total,memory.free', '--format=csv,noheader,nounits',
    ], { encoding: 'utf8', timeout: 1000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }))
  } catch { warnings.push('GPU probe unavailable; no GPU qualification inferred') }
  let runtimes = []
  try { runtimes = runtimeProbe() } catch { warnings.push('runtime compatibility probe failed') }
  return {
    detectedAt: Date.now(), os, arch: arch(), cpuType: cpu[0]?.model ?? null,
    cpuCount: cpu.length, instructionSets, totalRamBytes, availableRamBytes,
    availableStorageBytes, gpus, runtimes, warnings,
    // Compatibility fields for existing API consumers; free memory is used for admission.
    ramGb: totalRamBytes / 1024 ** 3, ramFreeGb: availableRamBytes / 1024 ** 3,
    vramGb: Math.max(0, ...gpus.map((g) => g.availableBytes / 1024 ** 3)), gpuDetected: gpus.length > 0,
    scope: 'core_host', // A browser connected to a remote core is NOT running on its phone.
  }
}

export function memorySnapshot() {
  let availableRamBytes = freemem()
  let totalRamBytes = totalmem()
  // Honour Linux container limits rather than admitting against the host's RAM.
  if (platform() === 'linux') {
    const limit = number(read('/sys/fs/cgroup/memory.max'))
    const used = number(read('/sys/fs/cgroup/memory.current'))
    if (limit !== null && used !== null) {
      totalRamBytes = Math.min(totalRamBytes, limit)
      availableRamBytes = Math.min(availableRamBytes, Math.max(0, limit - used))
    }
  }
  return { availableRamBytes, totalRamBytes }
}
