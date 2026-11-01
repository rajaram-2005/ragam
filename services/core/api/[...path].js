import { createVercelHandler } from '../src/vercel/handler.mjs'
import { blockLocalOnlyHostedRoutes, createHostedOnlineApp } from '../src/vercel/hosted-app.mjs'

const handler = createVercelHandler({
  appFactory: () => createHostedOnlineApp({
    logger: (record) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...record })),
  }),
  beforeDispatch: blockLocalOnlyHostedRoutes,
})

export default handler
