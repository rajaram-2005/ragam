import { SupabaseKnowledgeStore } from '../storage/supabase-knowledge-store.mjs'
import { SupabaseMemoryStore } from '../storage/supabase-memory-store.mjs'
import { SupabaseKnowledgePipeline } from '../knowledge/supabase-pipeline.mjs'

const REQUIRED_MEDIA_METHODS = ['enqueue', 'has', 'readArtifact']

/**
 * Build one durable, account-filtered memory/knowledge context for OnlineApp's existing
 * async contextStoreFactory seam. Media is injected separately because this repository's
 * current queue writes artifacts to local disk; silently substituting that queue in a
 * serverless deployment would misrepresent durability.
 */
export function createSupabaseContextStoreFactory({ client, mediaFactory, now, chunking } = {}) {
  if (!client || typeof client.request !== 'function') throw new TypeError('a server-only Supabase admin client is required')
  if (typeof mediaFactory !== 'function') throw new TypeError('a mediaFactory must provide the deployment-appropriate media queue')

  return async ({ accountId, ledger: _localLedger = null } = {}) => {
    if (typeof accountId !== 'string' || !accountId) throw new TypeError('context requires the authenticated account id')
    const options = { client, accountId, ...(now ? { now } : {}) }
    const memory = new SupabaseMemoryStore(options)
    const knowledgeStore = new SupabaseKnowledgeStore(options)
    const knowledge = new SupabaseKnowledgePipeline({
      store: knowledgeStore,
      defaultPrincipal: accountId,
      ...(chunking ? { chunking } : {}),
    })
    let media
    try {
      await knowledge.initialize()
      media = await mediaFactory({ client, accountId })
      if (!media || REQUIRED_MEDIA_METHODS.some((method) => typeof media[method] !== 'function')) {
        throw new TypeError(`mediaFactory must return a queue implementing ${REQUIRED_MEDIA_METHODS.join(', ')}`)
      }
      return { accountId, memory, knowledge, media }
    } catch (error) {
      await Promise.allSettled([memory.close?.(), knowledge.close?.(), media?.close?.()])
      throw error
    }
  }
}
