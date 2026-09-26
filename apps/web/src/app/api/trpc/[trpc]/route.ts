import { appRouter, createContext } from '@repo/trpc'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'

export const runtime = 'nodejs'

function handler(req: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => createContext({ headers: req.headers }),
    onError: ({ path, error, type }) => {
      // Expected failures (validation, auth) are the client's business; log the rest.
      if (error.code !== 'INTERNAL_SERVER_ERROR') return
      console.error(`[trpc] ${type} ${path ?? '<unknown>'} failed`, error.cause ?? error)
    },
  })
}

export { handler as GET, handler as POST }
