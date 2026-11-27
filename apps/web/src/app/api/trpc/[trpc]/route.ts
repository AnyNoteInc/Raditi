import { appRouter, createContext } from '@repo/trpc'
import type { TRPCError } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'

import { env } from '@/env'
import { MAX_TRPC_BODY_BYTES, withBodyLimit } from '@/server/body-limit'
import { builtinMcpServices } from '@/server/builtin-mcp-services'
import { chatServices } from '@/server/chat-services'
import { mcpServerServices } from '@/server/mcp-servers'
import { withOriFactHeader } from '@/server/ori-fact-header'
import { gitServices } from '@/server/git-services'
import { paymentShop } from '@/server/payment-shop'
import { skillServices } from '@/server/skill-services'
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
// An action with a fact of the ORI names it to the edge in its answer (88.16а-2).
const serve = withOriFactHeader(async (req) => {
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
        mcpServers: mcpServerServices(),
        git: gitServices(),
        skills: skillServices(),
        builtinMcp: builtinMcpServices(),
      }),
    onError: ({ path, error, type }) => {
      const failure = failureToLog(error)
      if (failure === undefined) return
      console.error(`[trpc] ${type} ${path ?? '<unknown>'} failed`, failure)
    },
  })
})

const handler = withBodyLimit(MAX_TRPC_BODY_BYTES, serve)

export { handler as GET, handler as POST }
