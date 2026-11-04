const STORAGE_KEY = 'ragam.chat-organization.v1'
const MAX_PROJECTS = 50
const MAX_SESSIONS = 500
const MAX_LABEL_LENGTH = 100

function browserStorage() {
  try { return globalThis.localStorage ?? null } catch { return null }
}

function cleanLabel(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL_LENGTH) : ''
}

function emptyOrganization() {
  return { projects: [], sessions: {} }
}

function normalizeOrganization(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) return emptyOrganization()
  const projects = [...new Set((Array.isArray(value.projects) ? value.projects : [])
    .map(cleanLabel).filter(Boolean))].slice(0, MAX_PROJECTS)
  const projectSet = new Set(projects)
  const source = value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions)
    ? value.sessions : {}
  const sessions = {}
  for (const [id, metadata] of Object.entries(source).slice(0, MAX_SESSIONS)) {
    if (!id || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue
    const title = cleanLabel(metadata.title)
    const project = cleanLabel(metadata.project)
    const entry = {}
    if (title) entry.title = title
    if (projectSet.has(project)) entry.project = project
    if (metadata.pinned === true) entry.pinned = true
    if (Object.keys(entry).length) sessions[id] = entry
  }
  return { projects, sessions }
}

/** Only user-authored organization labels are stored in this browser; no prompts or turns. */
export function readChatOrganization(storage = browserStorage()) {
  if (!storage) return emptyOrganization()
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return emptyOrganization()
    return normalizeOrganization(JSON.parse(raw))
  } catch { return emptyOrganization() }
}

/** Best-effort persistence; the current UI still works if browser storage is blocked. */
export function writeChatOrganization(value, storage = browserStorage()) {
  if (!storage) return false
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...normalizeOrganization({ version: 1, ...value }) }))
    return true
  } catch { return false }
}

/** Return a new normalized organization with one session's local labels changed. */
export function updateChatSessionOrganization(value, id, patch) {
  const current = normalizeOrganization({ version: 1, ...value })
  if (typeof id !== 'string' || !id || !patch || typeof patch !== 'object') return current
  const sessions = { ...current.sessions }
  const next = { ...(sessions[id] ?? {}) }
  if (Object.hasOwn(patch, 'title')) {
    const title = cleanLabel(patch.title)
    if (title) next.title = title
    else delete next.title
  }
  if (Object.hasOwn(patch, 'project')) {
    const project = cleanLabel(patch.project)
    if (current.projects.includes(project)) next.project = project
    else delete next.project
  }
  if (Object.hasOwn(patch, 'pinned')) {
    if (patch.pinned === true) next.pinned = true
    else delete next.pinned
  }
  if (Object.keys(next).length) sessions[id] = next
  else delete sessions[id]
  return { projects: current.projects, sessions }
}

/** Add a bounded local project label, rejecting empty or duplicate names. */
export function addChatProject(value, name) {
  const current = normalizeOrganization({ version: 1, ...value })
  const project = cleanLabel(name)
  if (!project || current.projects.length >= MAX_PROJECTS
      || current.projects.some((item) => item.toLocaleLowerCase() === project.toLocaleLowerCase())) return null
  return { projects: [...current.projects, project], sessions: current.sessions }
}
