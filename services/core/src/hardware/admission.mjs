// Profiles are operator/release inputs, NOT task payloads or model-name heuristics.
// No Pro/Max profiles ship until repeatable model+runtime benchmarks exist.
export const EXECUTION_MODES = Object.freeze(['local', 'hybrid', 'online'])
const bytes = (n) => Number.isSafeInteger(n) && n >= 0
const positive = (n) => Number.isFinite(n) && n > 0
const text = (s) => typeof s === 'string' && s.trim().length > 0
const digest = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)

export function validateProfile(p, profiles = []) {
  const reasons = []
  if (!p || !text(p.id) || !text(p.modelId) || !text(p.modelVersion) || !digest(p.artifactSha256)) reasons.push('missing model identity/digest')
  if (!['lite', 'pro', 'max'].includes(p?.tier)) reasons.push('unknown tier')
  if (!text(p?.quantization) || !text(p?.workload) || !Number.isSafeInteger(p?.contextTokens) || p.contextTokens < 1) reasons.push('missing evaluated workload/context/quantization')
  if (!positive(p?.ramBytes) || !bytes(p?.ramBytes) || !bytes(p?.storageBytes) || !Array.isArray(p?.gpuMemoryBytes) || !p.gpuMemoryBytes.every(bytes)) reasons.push('invalid memory/storage envelope')
  if (!text(p?.runtime?.id) || !text(p?.runtime?.version) || !text(p?.runtime?.backend)) reasons.push('missing runtime compatibility')
  if (!Array.isArray(p?.os) || !p.os.length || !Array.isArray(p?.arch) || !p.arch.length || !Array.isArray(p?.instructionSets)) reasons.push('missing OS/CPU compatibility')
  if (!text(p?.benchmark?.command) || !text(p?.benchmark?.report) || !digest(p?.benchmark?.sha256) || (!text(p?.computeMetric) || !positive(p?.minComputeScore))) reasons.push('missing repeatable benchmark evidence')
  if (p?.tier === 'lite' && (p.runtime?.backend !== 'cpu' || p.gpuMemoryBytes?.length)) reasons.push('Lite must support CPU-only execution')
  if (['pro', 'max'].includes(p?.tier) && (p.runtime?.backend === 'cpu' || !p.gpuMemoryBytes?.length || !p.gpuMemoryBytes.every(positive))) reasons.push('GPU tiers require a GPU runtime and memory envelope')
  if (p?.tier === 'max') {
    const lower = profiles.find((q) => q.id === p.proProfileId && q.tier === 'pro')
    if (!lower || validateProfile(lower).length || lower.workload !== p.workload || lower.computeMetric !== p.computeMetric || !(p.minComputeScore > lower.minComputeScore)) reasons.push('Max requires a higher measured compute profile than its Pro baseline for this workload')
  }
  return reasons
}

export function assessProfile(profile, hardware, workload = {}, profiles = []) {
  const reasons = validateProfile(profile, profiles)
  if (reasons.length) return { eligible: false, reasons }
  const p = profile, h = hardware ?? {}
  if (h.scope !== 'core_host' && h.scope !== 'device') reasons.push('local device scope is unverified')
  if (!p.os.includes(h.os) || !p.arch.includes(h.arch)) reasons.push('OS/CPU architecture is incompatible')
  if (p.instructionSets.some((f) => !h.instructionSets?.includes(f))) reasons.push('CPU instruction set is unsupported or unknown')
  if (h.mobile && p.tier !== 'lite') reasons.push('mobile devices use Lite')
  if (h.mobile && (!bytes(h.managedStorageBytes) || h.managedStorageBytes + p.storageBytes >= 5_000_000_000)) reasons.push('mobile managed storage must remain below 5 GB')
  if (workload.kind && workload.kind !== p.workload) reasons.push('workload has not been evaluated for this configuration')
  if (!Number.isSafeInteger(workload.contextTokens ?? p.contextTokens) || (workload.contextTokens ?? p.contextTokens) < 1 || (workload.contextTokens ?? 0) > p.contextTokens) reasons.push('context exceeds the evaluated configuration')
  if (!bytes(h.availableRamBytes) || h.availableRamBytes < p.ramBytes) reasons.push('insufficient or unknown available RAM')
  if (!bytes(h.availableStorageBytes) || h.availableStorageBytes < p.storageBytes) reasons.push('insufficient or unknown available storage')
  const runtime = h.runtimes?.find((r) => r.id === p.runtime.id && r.version === p.runtime.version && r.backend === p.runtime.backend)
  const measured = runtime?.configurations?.find((c) => c.profileId === p.id && c.artifactSha256 === p.artifactSha256 && c.benchmarkSha256 === p.benchmark.sha256)
  if (!measured || measured.computeMetric !== p.computeMetric || !positive(measured.computeScore) || measured.computeScore < p.minComputeScore) reasons.push('runtime/model support or measured compute is insufficient/unverified')
  const gpuIds = measured?.gpuIds ?? []
  if (gpuIds.length !== p.gpuMemoryBytes.length || new Set(gpuIds).size !== gpuIds.length) reasons.push('runtime GPU placement is unverified')
  p.gpuMemoryBytes.forEach((required, i) => {
    const gpu = h.gpus?.find((g) => g.id === gpuIds[i] && g.backend === p.runtime.backend)
    if (!gpu || !bytes(gpu.availableBytes) || !bytes(gpu.totalBytes) || gpu.availableBytes > gpu.totalBytes || gpu.availableBytes < required) reasons.push(`insufficient or unknown VRAM on runtime device ${i + 1}`)
  })
  if (p.gpuMemoryBytes.length > 1 && !(measured?.multiGpuSpeedup > 1)) reasons.push('multi-GPU benefit has not been measured')
  return { eligible: reasons.length === 0, reasons, profileId: p.id, tier: p.tier, contextTokens: p.contextTokens }
}

export class HardwareAdmission {
  constructor({ probe, profiles = [] }) {
    this.probe = probe
    this.profiles = structuredClone(profiles)
    for (const profile of this.profiles) {
      const errors = validateProfile(profile, this.profiles)
      if (errors.length) throw new TypeError(`invalid hardware profile ${profile.id}: ${errors.join('; ')}`)
    }
  }

  check(model, workload = {}, hardware = this.probe()) {
    const profiles = this.profiles.filter((p) => p.modelId === model.id && p.modelVersion === model.version && p.quantization === model.quantization)
    const tier = model.tags?.find((t) => /^tier:(lite|pro|max)$/.test(t))?.slice(5)
    const applicable = profiles.filter((p) => !tier || p.tier === tier)
    const evaluated = applicable.map((p) => assessProfile(p, hardware, workload, this.profiles))
    const ready = evaluated.find((r) => r.eligible)
    // Ordinary third-party descriptors are not relabelled as Klyvaron. Legacy CPU
    // completion gets its allocation check in the runtime, not a fake benchmark here.
    if (!profiles.length && !['pro', 'max'].includes(tier)) return { eligible: true, qualifiedTier: null, reasons: [], status: 'unprofiled' }
    return ready ?? { eligible: false, reasons: evaluated.flatMap((r) => r.reasons).concat(applicable.length ? [] : ['no benchmark-qualified model configuration']), alternatives: this.alternatives(model, workload, hardware) }
  }

  alternatives(model, workload, hardware) {
    return this.profiles.filter((p) => p.tier !== 'max').flatMap((p) => {
      const reduced = { ...workload, contextTokens: Math.min(workload.contextTokens ?? p.contextTokens, p.contextTokens) }
      const result = assessProfile(p, hardware, reduced, this.profiles)
      return result.eligible ? [{ modelId: p.modelId, profileId: p.id, contextTokens: p.contextTokens,
        requiresConfirmation: true, tradeoff: 'A smaller model may reduce answer quality; a shorter context retains less input. CPU execution may be slower.' }] : []
    })
  }

  report(models, hardware = this.probe()) {
    const installed = models.filter((m) => m.location === 'local' && m.measured.availability === 'ready')
    const configurations = this.profiles.filter((p) => installed.some((m) => m.id === p.modelId && m.version === p.modelVersion && m.quantization === p.quantization))
      .map((p) => assessProfile(p, hardware, {}, this.profiles))
    const recommendedTier = ['max', 'pro', 'lite'].find((tier) => configurations.some((c) => c.eligible && c.tier === tier)) ?? 'lite'
    return { recommendedTier, qualified: configurations.some((c) => c.eligible && c.tier === recommendedTier), configurations,
      note: 'Lite is the accessibility default, not a claim that an assistant is installed. GPU names and workstation labels do not qualify a tier.' }
  }
}
