import { getSessionFromHeaders, type Auth, type Session } from '@repo/auth'
import { prisma as defaultPrisma, type PrismaClient } from '@repo/db'
import { DomainError, isDomainError, missingRequiredConsents } from '@repo/domain'
import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'

import { CONSENT_REQUIRED, formatError, toTRPCError } from './errors.ts'
import { loadLatestConsents } from './services/consents.ts'

export interface Context {
  prisma: PrismaClient
  headers: Headers
  session: Session['session'] | null
  user: Session['user'] | null
}

export interface CreateContextOptions {
  /** Request headers: the fetch adapter's `req.headers`, or `await headers()` in RSC. */
  headers: Headers
  /** Defaults to the process-wide client of @repo/db. */
  prisma?: PrismaClient
  /** Defaults to the process-wide instance of @repo/auth. */
  auth?: Auth
}

export async function createContext({
  headers,
  prisma = defaultPrisma,
  auth,
}: CreateContextOptions): Promise<Context> {
  const current = await getSessionFromHeaders(headers, auth)
  return { prisma, headers, session: current?.session ?? null, user: current?.user ?? null }
}

// Stack traces and raw messages reach the browser only in `next dev`.
const isDev = process.env.NODE_ENV === 'development'

const t = initTRPC.context<Context>().create({
  // superjson keeps Date intact on the way to the client. Money never travels as Decimal:
  // procedures return it as a string (toFixed) described by their zod output schema.
  transformer: superjson,
  isDev,
  errorFormatter: ({ shape, error }) => formatError(shape, error, isDev),
})

/** A DomainError thrown anywhere in a procedure becomes the matching tRPC error. */
const domainErrors = t.middleware(async ({ next }) => {
  const result = await next()
  if (
    !result.ok &&
    result.error.code === 'INTERNAL_SERVER_ERROR' &&
    isDomainError(result.error.cause)
  ) {
    throw toTRPCError(result.error.cause)
  }
  return result
})

export const router = t.router
export const createCallerFactory = t.createCallerFactory
export const publicProcedure = t.procedure.use(domainErrors)

/**
 * A signed-in user. Only consent.* and user.me use it directly: the consent page needs them
 * before the documents are accepted. Everything that writes or reads more is consented.
 */
export const protectedProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.user || !ctx.session) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Войдите, чтобы продолжить' })
  }
  return next({ ctx: { ...ctx, user: ctx.user, session: ctx.session } })
})

/**
 * Every business procedure: a signed-in user who accepted the current edition of every
 * required document (152-FZ). Otherwise PRECONDITION_REQUIRED with domainCode
 * CONSENT_REQUIRED, and the web sends the user to accept them (consent.acceptRequired).
 */
export const consentedProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  const latest = await loadLatestConsents(ctx.prisma, ctx.user.id)
  if (missingRequiredConsents(latest).length > 0) {
    throw toTRPCError(new DomainError(CONSENT_REQUIRED, 'Required documents are not accepted', 428))
  }
  return next()
})
