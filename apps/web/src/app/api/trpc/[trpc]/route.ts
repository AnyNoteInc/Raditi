import { appRouter, createContext } from '@repo/trpc'
import type { TRPCError } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'

import { env } from '@/env'
import { MAX_TRPC_BODY_BYTES, withBodyLimit } from '@/server/body-limit'
import { chatServices } from '@/server/chat-services'
import { paymentShop } from '@/server/payment-shop'
import { siteConnections } from '@/server/site-connections'
import { refusedCrossOriginPost } from '@/server/trpc-origin'
import { MAX_BATCH_SIZE } from '@/trpc/batch'

export const runtime = 'nodejs'

/**
 * What a failed procedure leaves in the log. Expected failures (validation, auth, a refusal of
 * the domain) are the client's business. The rest is ours: an unexpected failure, and the
 * failure a refusal was made of — the payment shop that did not take a request is «payments
 * are unavailable» for the customer and its own error for us.
 */
function failureToLog(error: TRPCError): unknown {
  if (error.code === 'INTERNAL_SERVER_ERROR') return error.cause ?? error
  return error.cause?.cause
}

/** APP_URL, or null when the settings do not parse. */
function appUrl(): string | null {
  try {
    return env.web().appUrl
  } catch {
    return null
  }
}

// The fetch adapter of tRPC reads a body whole and has no limit of its own. A POST of another
// origin — a published page is the same site as the cabinet — is refused first (plan 69, Ст3).
const handler = withBodyLimit(MAX_TRPC_BODY_BYTES, async (req) => {
  const app = appUrl()
  // Without the settings the origin cannot be checked: a POST is not taken unchecked.
  if (app === null && req.method === 'POST') return new Response(null, { status: 503 })
  if (app !== null && refusedCrossOriginPost(req, app)) return new Response(null, { status: 403 })
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    maxBatchSize: MAX_BATCH_SIZE,
    createContext: () =>
      createContext({
        headers: req.headers,
        billing: paymentShop(),
        chat: chatServices(),
        siteConnections: siteConnections(),
      }),
    onError: ({ path, error, type }) => {
      const failure = failureToLog(error)
      if (failure === undefined) return
      console.error(`[trpc] ${type} ${path ?? '<unknown>'} failed`, failure)
    },
  })
})

export { handler as GET, handler as POST }
