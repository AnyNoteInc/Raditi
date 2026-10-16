import { getSessionFromHeaders, type Auth, type Session } from '@repo/auth'
import { prisma as defaultPrisma, type PrismaClient } from '@repo/db'
import { DomainError, isDomainError, missingRequiredConsents, type AppEnv } from '@repo/domain'
import type { YookassaClient } from '@repo/yookassa'
import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'

import { CONSENT_REQUIRED, formatError, toTRPCError } from './errors.ts'
import { loadLatestConsents } from './services/consents.ts'

/** What the billing procedures pay through. The app builds it once per process. */
export interface BillingContext {
  /** The ЮKassa shop. */
  yookassa: YookassaClient
  /** Public origin of the app (APP_URL), no trailing slash: the customer returns to it. */
  appUrl: string
  /** APP_ENV: it decides which workspace is the user's personal one, as in project.create. */
  appEnv: AppEnv
  /**
   * YOOKASSA_AUTOPAYMENTS: the shop may save a payment method and charge it. false — one-time
   * payments only: auto-renewal is neither offered on the pages nor switched on by a procedure.
   */
  autopayments: boolean
  /**
   * BILLING_PAST_DUE_DAYS: how long an overdue tariff waits for a payment before the scheduler
   * of the core role ends it. Read here only to tell the customer the day; the two processes
   * have to be given the same value.
   */
  pastDueDays: number
}

export interface Context {
  prisma: PrismaClient
  headers: Headers
  session: Session['session'] | null
  user: Session['user'] | null
  /** null: payments are switched off (the shop is not set up); the tariff state is still read. */
  billing: BillingContext | null
}

export interface CreateContextOptions {
  /** Request headers: the fetch adapter's `req.headers`, or `await headers()` in RSC. */
  headers: Headers
  /** Defaults to the process-wide client of @repo/db. */
  prisma?: PrismaClient
  /** Defaults to the process-wide instance of @repo/auth. */
  auth?: Auth
  /** Defaults to null: payments are switched off. */
  billing?: BillingContext | null
}

export async function createContext({
  headers,
  prisma = defaultPrisma,
  auth,
  billing = null,
}: CreateContextOptions): Promise<Context> {
  const current = await getSessionFromHeaders(headers, auth)
  return {
    prisma,
    headers,
    session: current?.session ?? null,
    user: current?.user ?? null,
    billing,
  }
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
 * A signed-in user. Used directly by consent.* and user.me — the consent page needs them before
 * the documents are accepted — and by what stops the charges of a tariff or shows them on that
 * page: billing.unlinkPaymentMethod, billing.cancelAutoRenew and billing.autoRenewal (default «н»
 * of docs/plan/37-billing-plan.md: a user who has not accepted a new edition is still charged, so
 * they can stop it without accepting). Everything else that writes or reads is consented. The
 * list of the exceptions is `openToEveryUser` in router.test.ts: a new one is added there.
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
