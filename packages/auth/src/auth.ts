import { prisma as defaultPrisma, recordOriFact, type PrismaClient } from '@repo/db'
import { notify, type NotificationPayload } from '@repo/notifications'
import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { nextCookies } from 'better-auth/next-js'

import { authConfigFromEnv, type AuthConfig } from './config.ts'
import { consents } from './consents-plugin.ts'
import { signUpProfile } from './profile.ts'
import { profileLastNameSchema } from './profile-schema.ts'
import { ipAddressOptions, USER_AGENT_MAX } from './request-meta.ts'
import { smartCaptcha } from './smart-captcha.ts'
import { withoutProviderTokens, yandexSignIn } from './yandex-sign-in.ts'

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

/**
 * A fact of the journal of an organiser of distribution of information (plan 88, Ар56): a failed
 * write never stops a sign-in — it is told to the log, without the user, for the operator to see.
 */
async function oriFact(prisma: PrismaClient, fact: Parameters<typeof recordOriFact>[1]) {
  try {
    await recordOriFact(prisma, fact)
  } catch {
    console.error(`[auth] ori_fact_failed kind=${fact.kind}`)
  }
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
    // The built-in profile update takes any `name` and `image` from a signed-in user. The
    // profile changes only through user.updateProfile (tRPC) and the avatar upload of the web
    // app, which validate what they store. The handler ignores this list for auth.api calls.
    disabledPaths: ['/update-user'],
    databaseHooks: {
      account: {
        create: { before: async (account) => ({ data: withoutProviderTokens(account) }) },
        update: { before: async (account) => ({ data: withoutProviderTokens(account) }) },
      },
      session: {
        create: {
          // better-auth stores the raw header; a longer one than the column failed the sign-in.
          before: async (session) =>
            typeof session.userAgent === 'string' && session.userAgent.length > USER_AGENT_MAX
              ? { data: { userAgent: session.userAgent.slice(0, USER_AGENT_MAX) } }
              : undefined,
          // A fact of every sign-in, with the address of the session (149-FZ, art. 10.1; plan
          // 88, Ар56): the journal keeps it 3 years, past the account.
          after: async (session) => {
            await oriFact(prisma, {
              kind: 'sign_in',
              userId: session.userId,
              origin: { ip: typeof session.ipAddress === 'string' ? session.ipAddress : null },
            })
          },
        },
      },
      user: {
        create: {
          // A fact of the registration (Ар56); the address comes with the first session.
          after: async (user) => {
            await oriFact(prisma, { kind: 'register', userId: user.id })
          },
        },
      },
    },
    account: {
      // A Yandex sign-in joins an existing account by its address only once that address was
      // confirmed here: otherwise whoever registered someone's address first would get in.
      accountLinking: { requireLocalEmailVerified: true },
      updateAccountOnSignIn: false,
    },
    user: {
      additionalFields: {
        lastName: {
          type: 'string',
          required: false,
          validator: { input: profileLastNameSchema },
        },
      },
    },
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
      signUpProfile(),
      ...(config.yandex ? [yandexSignIn(config.yandex)] : []),
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
