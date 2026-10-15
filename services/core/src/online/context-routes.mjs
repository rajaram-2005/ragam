// Reused bounded context and registry routes; called only after authentication.
//
// `session` is the signed-in account, resolved by the caller from its own cookie. Every
// history, memory and knowledge access below goes through `app.contextFor(session.id)`,
// which is that account's own database — so "your conversations" means yours, and there
// is no request field that can widen it. Plugins and MCP stay installation-wide: they
// are reviewed read-only built-ins, not personal data.
import { CANDIDATE_STATES } from '../memory/store.mjs'
import { validateManifest } from '../plugins/manifest.mjs'
import { readBody, sendJson } from './http.mjs'
import { failure } from './gateway.mjs'
export async function contextRoutes(request, response, app, session) {
 if (!session?.accountId) throw failure('unauthenticated', 'Sign in to this Aetheris installation.', 401)
 const accountId = session.accountId
 const { memory, knowledge } = app.contextFor(accountId)
 const readJson = (extra) => readBody(request, { principal: accountId, ...extra })
 const url = new URL(request.url, 'http://core.invalid')
 const path = url.pathname.replace(/\/+$/, '') || '/'
 const segments = path.split('/').filter(Boolean).map(decodeURIComponent)
 const method = request.method
 if (path.startsWith('/api/plugins/trust')) {
   if (method === 'GET') return sendJson(response, 200, { keys: [], signaturesRequired: false, customInstallationDisabled: true, file: null })
   throw failure('extension_installation_disabled', 'Custom code and trust changes are disabled in the online product.', 403)
 }
 if (path === '/api/plugins/install') throw failure('extension_installation_disabled', 'Only reviewed built-ins can execute. Custom extension installation is disabled.', 403)
  // --- memory -------------------------------------------------------------
  // The surface for the things a user asked to be remembered, and for searching their
  // own past conversations. Both live inside the five areas -- memory is a control in
  // Chat, not a sixth destination.
  if (method === 'GET' && path === '/api/memory') {
    return sendJson(response, 200, {
      memories: memory.listMemories({ limit: Number(url.searchParams.get('limit') ?? 200) }),
      candidates: memory.listCandidates({ status: CANDIDATE_STATES.PENDING }),
      stats: memory.stats(),
    }, app)
  }
  if (method === 'POST' && path === '/api/memory') {
    // Remembering is a user action, so this route is the user's hand. There is no body
    // field that makes it an agent's: the store's approver is a constant, enforced by a
    // database CHECK.
    return sendJson(response, 201, memory.remember(await readJson()), app)
  }
  if (method === 'GET' && segments[1] === 'memory' && segments[2] === 'export') {
    // Everything the store holds about a person, in one envelope that states its own
    // consent and training-use terms. This is the other half of deletion: a user who can
    // delete their data but cannot take a copy of it has been given half a right.
    return sendJson(response, 200, memory.exportAll(), app)
  }
  if (method === 'GET' && segments[1] === 'memory' && segments[2] === 'search') {
    const query = url.searchParams.get('q') ?? ''
    return sendJson(response, 200, { query, results: memory.searchMemories(query, { topK: Number(url.searchParams.get('limit') ?? 10) }) }, app)
  }
  if (method === 'POST' && segments[1] === 'memory' && segments[2] === 'candidates' && segments.length === 3) {
    // Exactly three segments: without the length check this route also matched
    // /api/memory/candidates/<id>/decide and proposed a candidate instead of deciding
    // one, which is how the decide endpoint returned 'pending' for an approval.
    return sendJson(response, 201, memory.propose(await readJson()), app)
  }
  if (method === 'POST' && segments[1] === 'memory' && segments[2] === 'candidates' && segments[3] && segments[4] === 'decide') {
    const body = await readJson()
    return sendJson(response, 200, memory.decideCandidate(segments[3], { approve: body.approve === true, kind: body.kind, subject: body.subject ?? null, tags: body.tags }), app)
  }
  if (method === 'DELETE' && segments[1] === 'memory' && segments[2] === 'forget-all') {
    return sendJson(response, 200, memory.forgetAll(await readJson()), app)
  }
  if (method === 'PATCH' && segments[1] === 'memory' && segments[2]) {
    return sendJson(response, 200, memory.updateMemory(segments[2], await readJson()), app)
  }
  if (method === 'DELETE' && segments[1] === 'memory' && segments[2]) {
    // readBody, not a fetch-style request.text(): this is a Node request, and readBody
    // already maps an absent body to {} rather than throwing.
    const body = await readJson()
    return sendJson(response, 200, memory.forget(segments[2], { reason: body.reason ?? null, requestedBy: 'user' }), app)
  }


  // --- session recall -----------------------------------------------------
  if (method === 'POST' && path === '/api/sessions') {
    const body = await readJson()
    return sendJson(response, 201, memory.startSession({ title: body.title ?? null }), app)
  }
  if (method === 'GET' && path === '/api/sessions') {
    return sendJson(response, 200, { sessions: memory.listSessions({ limit: Number(url.searchParams.get('limit') ?? 50) }) }, app)
  }
  if (method === 'GET' && segments[1] === 'sessions' && segments[2] === 'recall') {
    const query = url.searchParams.get('q') ?? ''
    return sendJson(response, 200, memory.recall(query, { topK: Number(url.searchParams.get('limit') ?? 10) }), app)
  }
  if (method === 'GET' && segments[1] === 'sessions' && segments[2]) {
    const session = memory.getSession(segments[2])
    if (!session) {
      const error = new Error(`no session '${segments[2]}'`)
      error.code = 'not_found'
      error.status = 404
      throw error
    }
    return sendJson(response, 200, session, app)
  }
  if (method === 'DELETE' && segments[1] === 'sessions' && segments[2]) {
    return sendJson(response, 200, memory.deleteSession(segments[2]), app)
  }


  // --- knowledge ----------------------------------------------------------
  if (method === 'POST' && path === '/api/knowledge/ingest') return sendJson(response, 201, await knowledge.ingestText({ ...await readJson(), owner: accountId, principals: [] }), app)
  if (method === 'POST' && path === '/api/knowledge/search') return sendJson(response, 200, knowledge.search(await readJson()), app)
  if (method === 'POST' && path === '/api/knowledge/reindex') return sendJson(response, 200, knowledge.rebuildIndex(), app)
  if (method === 'GET' && path === '/api/knowledge/stats') return sendJson(response, 200, knowledge.stats(), app)
  if (method === 'GET' && path === '/api/knowledge/documents') return sendJson(response, 200, { documents: knowledge.store.listDocuments({}) }, app)
  if (method === 'DELETE' && segments[1] === 'knowledge' && segments[2] === 'documents' && segments[3]) {
    const body = url.searchParams.get('reason') ? { reason: url.searchParams.get('reason') } : {}
    return sendJson(response, 200, knowledge.purgeDocument(segments[3], body), app)
  }


  // --- plugins ------------------------------------------------------------
  if (method === 'GET' && path === '/api/plugins') {
    // The UI needs to tell an enabled plugin from a disabled or uninstalled one,
    // so the filters the registry already supports are exposed here.
    return sendJson(
      response,
      200,
      {
        plugins: app.plugins.list({
          state: url.searchParams.get('state'),
          protocol: url.searchParams.get('protocol'),
        }),
      },
      app,
    )
  }
  if (method === 'GET' && path === '/api/plugins/capabilities') return sendJson(response, 200, { capabilities: app.plugins.capabilities() }, app)
  if (method === 'POST' && path === '/api/plugins/validate') {
    try {
      return sendJson(response, 200, { valid: true, ...validateManifest(await readJson()) }, app)
    } catch (error) {
      return sendJson(response, 400, { valid: false, error: error.message, details: error.errors ?? [] }, app)
    }
  }
  if (method === 'POST' && path === '/api/plugins/discover') return sendJson(response, 200, app.plugins.discover(await readJson()), app)
  if (method === 'POST' && path === '/api/plugins/install') return sendJson(response, 201, app.plugins.install(await readJson()), app)
  if (method === 'POST' && segments[1] === 'plugins' && segments[2] && segments[3]) {
    const action = segments[3]
    const body = await readJson()
    if (action === 'enable') return sendJson(response, 200, app.plugins.enable(segments[2]), app)
    if (action === 'disable') return sendJson(response, 200, app.plugins.disable(segments[2]), app)
    if (action === 'uninstall') return sendJson(response, 200, app.plugins.uninstall(segments[2]), app)
    if (action === 'preflight') return sendJson(response, 200, app.plugins.preflight(segments[2], body.capability, body), app)
    if (action === 'invoke') return sendJson(response, 200, await app.plugins.invoke(segments[2], body.capability, body.input ?? {}, body), app)
  }


  // --- MCP ----------------------------------------------------------------
  if (method === 'GET' && path === '/api/mcp/servers') return sendJson(response, 200, { servers: app.mcp.listServers() }, app)
  if (method === 'GET' && path === '/api/mcp/tools') {
    return sendJson(response, 200, { tools: app.mcp.listTools({ serverId: url.searchParams.get('server'), risk: url.searchParams.get('risk'), query: url.searchParams.get('q') }) }, app)
  }
  if (method === 'GET' && path === '/api/mcp/resources') return sendJson(response, 200, { resources: app.mcp.listResources({ serverId: url.searchParams.get('server') }) }, app)
  if (method === 'GET' && path === '/api/mcp/prompts') return sendJson(response, 200, { prompts: app.mcp.listPrompts({ serverId: url.searchParams.get('server') }) }, app)
  if (method === 'POST' && path === '/api/mcp/preflight') {
    const body = await readJson()
    return sendJson(response, 200, app.mcp.preflight(body.server, body.tool, body), app)
  }
  if (method === 'POST' && path === '/api/mcp/call') {
    const body = await readJson()
    return sendJson(response, 200, await app.mcp.callTool(body.server, body.tool, body.arguments ?? {}, body), app)
  }
  if (method === 'POST' && segments[1] === 'mcp' && segments[2] === 'servers' && segments[3] && segments[4] === 'toggle') {
    const body = await readJson()
    return sendJson(response, 200, app.mcp.setEnabled(segments[3], Boolean(body.enabled)), app)
  }


 return false
}
