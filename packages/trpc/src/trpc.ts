import { getSessionFromHeaders, type Auth, type Session } from '@repo/auth'
import { prisma as defaultPrisma, type PrismaClient } from '@repo/db'
import { DomainError, isDomainError, missingRequiredConsents, type AppEnv } from '@repo/domain'
import type { YookassaClient } from '@repo/yookassa'
import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'

import { CONSENT_REQUIRED, formatError, toTRPCError } from './errors.ts'
import type { AccountSkillServices } from './services/account-skills.ts'
import type { BuiltinMcpServices } from './services/builtin-mcp.ts'
import type { ChatContext } from './services/chat/context.ts'
import type { GitServices } from './services/git/connections.ts'
import type { McpServerServices } from './services/mcp-server-auth.ts'
import { loadLatestConsents } from './services/consents.ts'

/** What the billing procedures pay through. The app builds it once per process. */
export interface BillingContext {
  /** The ЮKassa shop. */
  yookassa: YookassaClient
  /** Public origin of the app (APP_URL), no trailing slash: the customer returns to it. */
  appUrl: string
  /** APP_ENV: it decides which workspace is the user's personal one, as in task.create. */
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
  /**
   * What the procedures of a chat reach outside the database: the browser, the inbox and Vault
   * (docs/plan/53-chat-preview-release.md).
   * Absent or null: dialogs are not set up in this process, and their procedures that need it
   * answer CHAT_NOT_CONFIGURED.
   */
  chat?: ChatContext | null
  /**
   * What an MCP server with a key is checked and written through (docs/plan/81-mcp-server-
   * credentials.md): a check of the server and a Vault store that can only write. Absent or null:
   * a server with a key cannot be added here; servers without one work as before.
   */
  mcpServers?: McpServerServices | null
  /**
   * What the git connections are written and checked through (docs/plan/84-projects.md, 84.17):
   * a Vault store that can only write and the check of a host. Absent or null — repositories
   * cannot be connected here; the rest works.
   */
  git?: GitServices | null
  /**
   * What the keys of the built-in MCP servers are checked and written through
   * (docs/plan/99-vk-community.md, ВК15): a Vault store that can only write and the check of a VK
   * key. Absent or null — the servers are listed and switched, no key is connected.
   */
  builtinMcp?: BuiltinMcpServices | null
  /**
   * What the skills of an account are installed through (docs/plan/97-skills.md): the readers of
   * public repositories and the store of their files. Absent or null — skills are listed and
   * switched, not installed.
   */
  skills?: AccountSkillServices | null
  /**
   * What one HTTP request has read once for all the procedures of its batch (`requestOnce`):
   * the consents of the user, the personal workspace. Absent — a context made by hand (a test, a
   * server component): every procedure reads for itself.
   */
  memo?: Map<string, Promise<unknown>>
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
  /** Defaults to null: dialogs are not set up. */
  chat?: ChatContext | null
  /** Defaults to null: servers with a key cannot be added. */
  mcpServers?: McpServerServices | null
  /** Defaults to null: repositories cannot be connected. */
  git?: GitServices | null
  /** Defaults to null: skills cannot be installed. */
  skills?: AccountSkillServices | null
  /** Defaults to null: no key of a built-in server is connected. */
  builtinMcp?: BuiltinMcpServices | null
}

export async function createContext({
  headers,
  prisma = defaultPrisma,
  auth,
  billing = null,
  chat = null,
  mcpServers = null,
  git = null,
  skills = null,
  builtinMcp = null,
}: CreateContextOptions): Promise<Context> {
  const current = await getSessionFromHeaders(headers, auth)
  return {
    prisma,
    headers,
    session: current?.session ?? null,
    user: current?.user ?? null,
    billing,
    chat,
    mcpServers,
    git,
    skills,
    builtinMcp,
    memo: new Map(),
  }
}

/**
 * A value read once per HTTP request (`Context.memo`): the procedures of a batch share the first
 * read, and its promise. Only what `keep` says is kept — an answer that may change within the
 * request (a consent just given, a workspace just made) is read again by the next procedure; a
 * failed read is not kept either.
 */
export function requestOnce<T>(
  ctx: Pick<Context, 'memo'>,
  key: string,
  load: () => Promise<T>,
  keep: (value: T) => boolean = () => true,
): Promise<T> {
  const memo = ctx.memo
  if (memo === undefined) return load()
  const known = memo.get(key) as Promise<T> | undefined
  if (known !== undefined) return known
  const read = load().then(
    (value) => {
      if (!keep(value)) memo.delete(key)
      return value
    },
    (error: unknown) => {
      memo.delete(key)
      throw error
    },
  )
  memo.set(key, read)
  return read
}

// Stack traces and raw messages reach the browser only in `next dev`.
const isDev = process.env.NODE_ENV === 'development'

const t = initTRPC.context<Context>().create({
  // superjson keeps Date intact on the way to the client. Money never travels as Decimal:
  // procedures return it as a string (toFixed) described by their zod output schema.
  transformer: superjson,
  isDev,
  errorFormatter: ({ shape, error }) => formatError(shape, error, isDev),
  // The streams of `task.signals` (SSE): a comment every 15 s keeps a quiet one open through
  // proxies, and a client that hears nothing for 40 s connects again.
  sse: {
    ping: { enabled: true, intervalMs: 15_000 },
    client: { reconnectAfterInactivityMs: 40_000 },
  },
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
  // Once per HTTP request, not once per procedure of a batch; a refusal is not kept.
  const consented = await requestOnce(
    ctx,
    `consented:${ctx.user.id}`,
    async () =>
      missingRequiredConsents(await loadLatestConsents(ctx.prisma, ctx.user.id)).length === 0,
    (accepted) => accepted,
  )
  if (!consented) {
    throw toTRPCError(new DomainError(CONSENT_REQUIRED, 'Required documents are not accepted', 428))
  }
  return next()
})
