// API client for the core service.
//
// Every request goes to a RELATIVE /api path. The dev server proxies those to the
// backend, which matters because the browser is not the sandbox: an absolute
// http://127.0.0.1:8790 in frontend code would point at the user's own machine and
// silently fail behind a preview proxy.
//
// Errors are normalised into ApiError with { status, code, message, detail } so the
// UI can distinguish "no model installed" from "the backend is down" instead of
// showing both as a generic failure. The backend already returns a machine-readable
// code and, for media, an explicit limitation; both are surfaced rather than
// swallowed.

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'network_error', detail = null, limitation = null, route = null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.detail = detail
    this.limitation = limitation
    this.route = route
  }

  /** True when the failure is "this capability is not available here". */
  get unavailable() {
    return ['no_model_available', 'capability_unavailable', 'offline_capability_unavailable', 'needs_hardware', 'not_implemented'].includes(this.code)
  }
}

async function request(method, path, body, { signal } = {}) {
  let response
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-aetheris-request': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new ApiError(`cannot reach the core service at ${path}: ${error?.message ?? error}`, {
      code: 'network_error',
    })
  }

  const text = await response.text()
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    throw new ApiError(payload?.message ?? `request failed with HTTP ${response.status}`, {
      status: response.status,
      code: payload?.error ?? 'http_error',
      detail: payload?.details ?? null,
      limitation: payload?.limitation ?? null,
      route: payload?.route ?? null,
    })
  }
  return payload
}

export const api = {
  // --- sign-in --------------------------------------------------------------
  // One way in: an account on this installation. The operator access token, its file on
  // the Core host and its `{ token }` login body are gone, so nothing here can offer a
  // second sign-in method. `auth()` is the only call that works signed-out, and it says
  // no more than whether this browser holds a session and whose it is.
  auth: () => request('GET', '/api/auth'),
  login: ({ email, password }) => request('POST', '/api/auth/login', { email, password }),
  register: ({ email, password }) => request('POST', '/api/auth/register', { email, password }),
  logout: () => request('POST', '/api/auth/logout', {}),
  changePassword: ({ currentPassword, newPassword }) => request('POST', '/api/auth/password', { currentPassword, newPassword }),
  // A reset code is never returned to the browser: it is delivered on the Core host, and
  // this request answers identically whether or not the address has an account.
  requestPasswordReset: (email) => request('POST', '/api/auth/password-reset/request', { email }),
  confirmPasswordReset: ({ email, code, password }) => request('POST', '/api/auth/password-reset/confirm', { email, code, password }),

  provider: () => request('GET', '/api/providers'),
  // The capability catalogue is metadata about providers in general, not about this connection.
  catalog: () => request('GET', '/api/providers/catalog'),
  // One route per connection id. The id is validated again on the server against the catalogue,
  // so a name this client invents is refused there rather than trusted here.
  saveProvider: (kind, body) => request('PUT', `/api/providers/${encodeURIComponent(kind)}`, body),
  testProvider: (kind) => request('POST', `/api/providers/${encodeURIComponent(kind)}/test`, {}),
  removeProvider: (kind) => request('DELETE', `/api/providers/${encodeURIComponent(kind)}`, {}),
  activateProvider: (id) => request('PUT', '/api/providers/active', { id }),
  selectModel: (model) => request('PUT', '/api/models/selection', { model }),
  modelCatalog: (q = '') => request('GET', `/api/models/catalog?q=${encodeURIComponent(q)}`),
  refreshCatalog: (sourceId, authorizeNetwork = false) => request('POST', '/api/models/catalog/refresh', { sourceId, authorizeNetwork }),
  get: (path, options) => request('GET', path, undefined, options),
  post: (path, body, options) => request('POST', path, body ?? {}, options),
  patch: (path, body, options) => request('PATCH', path, body ?? {}, options),
  del: (path, body, options) => request('DELETE', path, body ?? {}, options),

  // --- system -------------------------------------------------------------
  health: () => request('GET', '/api/health'),
  ready: () => request('GET', '/api/ready'),
  config: () => request('GET', '/api/config'),
  hardware: () => request('GET', '/api/hardware'),
  models: (readyOnly = false) => request('GET', `/api/models${readyOnly ? '?ready=true' : ''}`),
  probeModels: () => request('POST', '/api/models/probe', {}),
  events: () => request('GET', '/api/events'),
  audit: (limit = 50) => request('GET', `/api/audit?limit=${limit}`),

  // --- chat ---------------------------------------------------------------
  chat: (body, options) => request('POST', '/api/chat', body, options),
  knowledgeSearch: (body) => request('POST', '/api/knowledge/search', body),
  knowledgeIngest: (body) => request('POST', '/api/knowledge/ingest', body),
  knowledgeStats: () => request('GET', '/api/knowledge/stats'),
  knowledgeDocuments: () => request('GET', '/api/knowledge/documents'),
  knowledgeReindex: () => request('POST', '/api/knowledge/reindex', {}),

  // --- memory and history -------------------------------------------------
  // Memory is the user's own data, so every one of these is a user action: listing what
  // is held, adding to it, editing it, and deleting it. A candidate proposed by the agent
  // appears in `candidates` and is not a memory until `decideCandidate` approves it.
  memory: () => request('GET', '/api/memory'),
  remember: (body) => request('POST', '/api/memory', body),
  updateMemory: (id, body) => request('PATCH', `/api/memory/${encodeURIComponent(id)}`, body),
  forgetMemory: (id, reason) => request('DELETE', `/api/memory/${encodeURIComponent(id)}`, { reason: reason ?? null }),
  forgetAllMemory: () => request('DELETE', '/api/memory/forget-all', {}),
  searchMemory: (query) => request('GET', `/api/memory/search?q=${encodeURIComponent(query)}`),
  exportMemory: () => request('GET', '/api/memory/export'),
  proposeMemory: (body) => request('POST', '/api/memory/candidates', body),
  decideMemory: (id, approve) => request('POST', `/api/memory/candidates/${encodeURIComponent(id)}/decide`, { approve }),

  // History is a separate mechanism from memory: it searches the user's own past turns
  // on request and returns where each hit came from.
  sessions: () => request('GET', '/api/sessions'),
  startSession: (title, options) => request('POST', '/api/sessions', { title: title ?? null }, options),
  session: (id) => request('GET', `/api/sessions/${encodeURIComponent(id)}`),
  deleteSession: (id) => request('DELETE', `/api/sessions/${encodeURIComponent(id)}`, {}),
  recall: (query) => request('GET', `/api/sessions/recall?q=${encodeURIComponent(query)}`),

  // --- procedural skills ---------------------------------------------------
  // A procedure the assistant wrote down after a task failed and then worked. Only a
  // verified one is used; a candidate is readable for review and is never loaded as
  // though it had been verified.
  skills: () => request('GET', '/api/skills'),
  matchSkills: (query) => request('GET', `/api/skills?q=${encodeURIComponent(query)}`),
  skillDocument: (name) => request('GET', `/api/skills/${encodeURIComponent(name)}/document`),
  skillDeletions: () => request('GET', '/api/skills/deletions'),
  // Attestation, not a system check: the record says a person ran the steps and they
  // worked. The check is named for what it is.
  attestSkill: (name, note) => request('POST', `/api/skills/${encodeURIComponent(name)}/validate`, {
    evidence: {
      checks: [{ name: 'user-attestation', passed: true, note: note ?? null }],
      verifiedBy: 'user',
      note: note ?? null,
    },
  }),
  setSkillFlags: (name, body) => request('PATCH', `/api/skills/${encodeURIComponent(name)}`, body),
  retireSkill: (name, reason) => request('POST', `/api/skills/${encodeURIComponent(name)}/retire`, { reason }),
  restoreSkill: (name) => request('POST', `/api/skills/${encodeURIComponent(name)}/restore`, {}),
  forgetSkill: (name, reason) => request('DELETE', `/api/skills/${encodeURIComponent(name)}`, { reason: reason ?? null }),

  // --- tasks (God Core) ---------------------------------------------------
  tasks: (limit = 25) => request('GET', `/api/tasks?limit=${limit}`),
  task: (id) => request('GET', `/api/tasks/${encodeURIComponent(id)}`),
  createTask: (body) => request('POST', '/api/tasks', body),
  pauseTask: (id, reason) => request('POST', `/api/tasks/${encodeURIComponent(id)}/pause`, { reason }),
  resumeTask: (id) => request('POST', `/api/tasks/${encodeURIComponent(id)}/resume`, {}),
  cancelTask: (id, reason) => request('POST', `/api/tasks/${encodeURIComponent(id)}/cancel`, { reason }),
  approveTask: (id, body) => request('POST', `/api/tasks/${encodeURIComponent(id)}/approve`, body),

  // --- image / video ------------------------------------------------------
  generateImage: (body, options) => request('POST', '/api/image/generate', body, options),
  imageJobs: (limit = 25) => request('GET', `/api/image/jobs?limit=${limit}`),
  generateVideo: (body, options) => request('POST', '/api/video/generate', body, options),
  videoJobs: (limit = 25) => request('GET', `/api/video/jobs?limit=${limit}`),
  // Direct URL for an <img>/<video> tag. Only valid for a succeeded job.
  artifactUrl: (jobId) => `/api/media/artifact/${encodeURIComponent(jobId)}`,
  // Unfiltered job list. /api/media/jobs does not filter by kind server-side, so no
  // kind parameter is sent; use imageJobs/videoJobs for a filtered view.
  mediaJobs: (limit = 25) => request('GET', `/api/media/jobs?limit=${limit}`),
  cancelMediaJob: (jobId) => request('POST', `/api/media/jobs/${encodeURIComponent(jobId)}/cancel`, {}),

  // --- plugins ------------------------------------------------------------
  plugins: (state) => request('GET', `/api/plugins${state ? `?state=${encodeURIComponent(state)}` : ''}`),
  pluginCapabilities: () => request('GET', '/api/plugins/capabilities'),
  // The trust store: which publisher keys this host has decided to trust. The route returns
  // key ids and labels, never key material.
  trustedKeys: () => request('GET', '/api/plugins/trust'),
  trustKey: (body) => request('POST', '/api/plugins/trust', body),
  untrustKey: (keyId) => request('DELETE', `/api/plugins/trust/${encodeURIComponent(keyId)}`, {}),
  validateManifest: (manifest) => request('POST', '/api/plugins/validate', manifest),
  installPlugin: (manifest) => request('POST', '/api/plugins/install', manifest),
  pluginPreflight: (id, capability, body = {}) =>
    request('POST', `/api/plugins/${encodeURIComponent(id)}/preflight`, { capability, ...body }),
  pluginInvoke: (id, capability, input = {}, body = {}) =>
    request('POST', `/api/plugins/${encodeURIComponent(id)}/invoke`, { capability, input, ...body }),
  setPluginState: (id, action) => request('POST', `/api/plugins/${encodeURIComponent(id)}/${action}`, {}),

  // --- MCP ----------------------------------------------------------------
  mcpServers: () => request('GET', '/api/mcp/servers'),
  mcpTools: (params = {}) => {
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value))
    return request('GET', `/api/mcp/tools${query.toString() ? `?${query}` : ''}`)
  },
  mcpResources: () => request('GET', '/api/mcp/resources'),
  mcpPrompts: () => request('GET', '/api/mcp/prompts'),
  mcpPreflight: (server, tool, body = {}) => request('POST', '/api/mcp/preflight', { server, tool, ...body }),
  mcpCall: (server, tool, args = {}, body = {}) => request('POST', '/api/mcp/call', { server, tool, arguments: args, ...body }),
  mcpToggle: (server, enabled) => request('POST', `/api/mcp/servers/${encodeURIComponent(server)}/toggle`, { enabled }),
}

/**
 * Stream a chat completion as server-sent events.
 *
 * Calls `onEvent({ name, data })` for each frame. The backend emits `delta`,
 * `done`, `error` and `redaction`; a redaction frame means something that looked
 * like a credential was removed before the request left the machine, and the UI
 * shows that rather than hiding it.
 */
export async function streamChat(body, { onEvent, signal } = {}) {
  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aetheris-request': '1' },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
    throw new ApiError(payload?.message ?? `stream failed with HTTP ${response.status}`, {
      status: response.status,
      code: payload?.error ?? 'stream_failed',
      limitation: payload?.limitation ?? null,
      route: payload?.route ?? null,
    })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) throw new ApiError('stream ended before a completion or error; keep the draft and retry', { code: 'stream_interrupted' })
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
        if (!frame.trim()) continue
        const name = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim() ?? 'message'
        const raw = /^data:\s*(.+)$/m.exec(frame)?.[1]
        let data = null
        if (raw) {
          try { data = JSON.parse(raw) } catch { data = { text: raw } }
        }
        onEvent?.({ name, data })
        if (name === 'done' || name === 'error') return
      }
    }
  } finally {
    // Breaking/aborting consumption must close the body and release its reader.
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
