import { appRouter, createContext } from '@repo/trpc'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'

import { MAX_TRPC_BODY_BYTES, withBodyLimit } from '@/server/body-limit'
import { MAX_BATCH_SIZE } from '@/trpc/batch'

export const runtime = 'nodejs'

// The fetch adapter of tRPC reads a body whole and has no limit of its own.
const handler = withBodyLimit(MAX_TRPC_BODY_BYTES, (req) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    maxBatchSize: MAX_BATCH_SIZE,
    createContext: () => createContext({ headers: req.headers }),
    onError: ({ path, error, type }) => {
      // Expected failures (validation, auth) are the client's business; log the rest.
      if (error.code !== 'INTERNAL_SERVER_ERROR') return
      console.error(`[trpc] ${type} ${path ?? '<unknown>'} failed`, error.cause ?? error)
    },
  }),
)

export { handler as GET, handler as POST }
