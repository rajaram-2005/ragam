export const INDUSTRY_MODE_KEY = 'ragam-industry-mode'
export const LOCAL_ONLY_MODE_KEY = 'ragam-local-only-mode'

export const INDUSTRY_TASKS = Object.freeze([
  Object.freeze({
    id: 'maintenance-triage',
    label: 'Maintenance triage',
    prompt: 'Help me investigate this equipment issue. First ask for the asset ID, symptoms, alarm codes, recent changes, and what the approved site procedure says. Separate confirmed evidence from hypotheses, cite any supplied source by its exact title or section, and list only low-risk checks allowed by our site procedures. Never recommend bypassing guards, lockout/tagout, permits, or PPE; tell me to stop and escalate if a hazard is possible. Do not invent specifications or claim to control equipment.',
  }),
  Object.freeze({
    id: 'quality-capa',
    label: 'Quality / CAPA draft',
    prompt: 'Help me draft a quality non-conformance and corrective-action plan. Ask for the part or process, lot, observed defect, containment already approved, and source records. Clearly separate facts, hypotheses, and missing evidence; cite supplied sources by exact title or section. Do not invent measurements, acceptance limits, root cause, or regulatory compliance. Keep approvals with qualified people.',
  }),
  Object.freeze({
    id: 'shift-handover',
    label: 'Shift handover',
    prompt: 'Help me prepare a concise manufacturing shift handover from the information I provide. Organize it into current status, completed work, open issues, quality concerns, safety/escalation items, and next-shift actions. Mark unknowns as unknown, preserve asset IDs and times exactly, and cite supplied source material. Do not create work orders or change machine settings.',
  }),
])

function browserStorage(storage) {
  if (storage !== undefined) return storage
  try { return globalThis.localStorage ?? null } catch { return null }
}

export function readIndustryMode(storage) {
  try { return browserStorage(storage)?.getItem(INDUSTRY_MODE_KEY) !== 'off' } catch { return true }
}

export function writeIndustryMode(enabled, storage) {
  try { browserStorage(storage)?.setItem(INDUSTRY_MODE_KEY, enabled ? 'on' : 'off') } catch { /* storage is optional */ }
  return Boolean(enabled)
}

export function readLocalOnlyMode(storage) {
  try { return browserStorage(storage)?.getItem(LOCAL_ONLY_MODE_KEY) !== 'off' } catch { return true }
}

export function writeLocalOnlyMode(enabled, storage) {
  try { browserStorage(storage)?.setItem(LOCAL_ONLY_MODE_KEY, enabled ? 'on' : 'off') } catch { /* storage is optional */ }
  return Boolean(enabled)
}
