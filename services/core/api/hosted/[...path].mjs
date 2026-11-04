import { createHostedByokService } from '../../src/hosted/byok.mjs'

// Vercel reuses the module instance between warm invocations. Keep only the stateless
// service configuration and transport; authentication and provider ownership are resolved
// from each request's verified Supabase session and user_id.
let service

export default async function handler(req, res) {
  service ??= createHostedByokService({ logger: (record) => console.error(JSON.stringify(record)) })
  return service.handle(req, res)
}
