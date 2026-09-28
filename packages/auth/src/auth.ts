import { prisma as defaultPrisma, type PrismaClient } from '@repo/db'
import { notify, type NotificationPayload } from '@repo/notifications'
import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { nextCookies } from 'better-auth/next-js'

import { authConfigFromEnv, type AuthConfig } from './config.ts'
import { consents } from './consents-plugin.ts'
import { ipAddressOptions } from './request-meta.ts'
import { smartCaptcha } from './smart-captcha.ts'

const VERIFY_EMAIL_TTL_S = 24 * 60 * 60
const RESET_PASSWORD_TTL_S = 60 * 60

/** Letters auth sends; they go to the outbox and the orchestrator delivers them. */
export interface AuthNotifier {
  verifyEmail(payload: NotificationPayload<'auth.verify_email'>): Promise<unknown>
  resetPassword(payload: NotificationPayload<'auth.reset_password'>): Promise<unknown>
  welcome(payload: NotificationPayload<'auth.welcome'> & { userId: string }): Promise<unknown>
}

export interface CreateAuthOptions {
  config: AuthConfig
  /** Defaults to the process-wide client of @repo/db. */
  prisma?: PrismaClient
  /** Defaults to `notify` of @repo/notifications. */
  notifier?: AuthNotifier
  /** Transport for captcha checks; tests replace it. */
  fetch?: typeof fetch
}

const expiresAt = (ttlSeconds: number): string =>
  new Date(Date.now() + ttlSeconds * 1000).toISOString()

export function createAuth({
  config,
  prisma = defaultPrisma,
  notifier = notify,
  fetch,
}: CreateAuthOptions) {
  return betterAuth({
    appName: 'Радити',
    baseURL: config.baseUrl,
    secret: config.secret,
    trustedOrigins: [config.appUrl],
    // No adapter transactions: better-auth would hold a pooled connection through password
    // hashing while the outbox write needs a second one, so a burst of sign-ups could starve
    // the pool.
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    telemetry: { enabled: false },
    // Counters live in PostgreSQL so every web replica sees the same limits.
    rateLimit: { enabled: true, storage: 'database' },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      resetPasswordTokenExpiresIn: RESET_PASSWORD_TTL_S,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await notifier.resetPassword({
          to: user.email,
          url,
          expiresAt: expiresAt(RESET_PASSWORD_TTL_S),
        })
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: VERIFY_EMAIL_TTL_S,
      // If queueing fails the account stays unverified; the letter can be requested again
      // (/send-verification-email), and sign-in stays closed until then.
      sendVerificationEmail: async ({ user, url }) => {
        await notifier.verifyEmail({
          to: user.email,
          url,
          expiresAt: expiresAt(VERIFY_EMAIL_TTL_S),
        })
      },
      afterEmailVerification: async (user) => {
        await notifier.welcome({
          userId: user.id,
          to: user.email,
          name: user.name,
          appUrl: config.appUrl,
        })
      },
    },
    advanced: {
      // Ids come from PostgreSQL: uuid v7 defaults in the schema.
      database: { generateId: false },
      ipAddress: ipAddressOptions,
    },
    plugins: [
      // First: its hook must run before any other plugin touches the request.
      ...(config.captcha ? [smartCaptcha({ serverKey: config.captcha.serverKey, fetch })] : []),
      consents({ db: prisma }),
      // Last, as better-auth requires: it copies Set-Cookie into Next's cookie store.
      nextCookies(),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
export type Session = Auth['$Infer']['Session']
export type User = Session['user']

let instance: Auth | undefined

/** The process-wide instance; reads the environment on first use, not on import. */
export function getAuth(): Auth {
  instance ??= createAuth({ config: authConfigFromEnv(process.env) })
  return instance
}

/**
 * Lazy handle to the process-wide instance for Next route handlers
 * (`toNextJsHandler(auth)`): importing @repo/auth during a build needs no secrets.
 */
export const auth: Auth = new Proxy({} as Auth, {
  get(_target, property) {
    // Not a thenable: `await auth` must not build the instance.
    if (property === 'then') return undefined
    const target = getAuth()
    const value: unknown = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  },
  has(_target, property) {
    return Reflect.has(getAuth(), property)
  },
})

/** The session behind the session cookie in these request headers, or null. */
export async function getSessionFromHeaders(
  headers: Headers,
  authInstance: Auth = auth,
): Promise<Session | null> {
  return authInstance.api.getSession({ headers })
}
