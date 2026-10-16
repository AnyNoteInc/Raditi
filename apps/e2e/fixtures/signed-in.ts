import { randomBytes, randomUUID } from 'node:crypto'

import { test as base, type BrowserContext } from '@playwright/test'
import { authConfigFromEnv, createAuth, latestConsents, requiredConsentRows } from '@repo/auth'
import { createPrismaClient } from '@repo/db'

import { authEnv, baseURL, databaseUrl } from './billing-stand.ts'

// A signed-in user for the pages under (protected), made through the server API of @repo/auth
// on the database of the run, not by clicking through the forms: the sign-up records the required
// consents, the link of the confirmation letter verifies the address and opens a session. The
// auth instance is built from the settings web runs with, so web accepts the cookie it signs.
//
// The run also needs a credit rate in force: without one no task is taken, and the settings
// pages say only that. No rate is ever seeded — an operator approves the first one —, so the
// worker writes the provisional rate of the credits design for the time of the run and removes
// it afterwards, unless the database already has a rate of its own.

type Notifier = NonNullable<Parameters<typeof createAuth>[0]['notifier']>

/**
 * The credit rate of the run: 6.00 RUB of accounting cost in a credit, from the first moment of
 * 2026 — before anything a test does. Whole milliseconds, as the table demands.
 */
const RUN_CREDIT_RATE = {
  effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
  rubPerCredit: '6.000000',
  basis:
    'Browser run of the billing pages: the provisional rate of the credits design, not approved',
} as const
type BrowserCookie = Parameters<BrowserContext['addCookies']>[0][number]

export interface SignedInUser {
  id: string
  email: string
  name: string
  lastName: string
  password: string
}

interface Accounts {
  /** A user with a verified address, the required consents and the cookies of a new session. */
  create(): Promise<{ user: SignedInUser; cookies: BrowserCookie[] }>
  /**
   * Removes the user with the sessions, the password, the consents and the memberships, and
   * every workspace the user created with what a test bought or added in it: sites, orders,
   * a subscription, the accounts of credits with their ledger, the audit and the letters about
   * the orders — and what a task of the workspace left: its reserves, its model calls and the
   * claim of its site on the gift.
   */
  remove(userId: string): Promise<void>
}

const SAME_SITE: Record<string, BrowserCookie['sameSite']> = {
  strict: 'Strict',
  lax: 'Lax',
  none: 'None',
}

/** A Set-Cookie header as Playwright takes it. The value is passed as sent: it is encoded. */
function browserCookie(header: string): BrowserCookie {
  const [pair = '', ...attributes] = header.split(';').map((part) => part.trim())
  const separator = pair.indexOf('=')
  if (separator < 1) throw new Error('A Set-Cookie header without a name')
  const attribute = new Map(
    attributes.map((text): [string, string] => {
      const [name = '', ...value] = text.split('=')
      return [name.toLowerCase(), value.join('=')]
    }),
  )
  const maxAge = attribute.has('max-age') ? Number(attribute.get('max-age')) : Number.NaN
  return {
    name: pair.slice(0, separator),
    value: pair.slice(separator + 1),
    domain: new URL(baseURL).hostname,
    path: attribute.get('path') || '/',
    httpOnly: attribute.has('httponly'),
    secure: attribute.has('secure'),
    sameSite: SAME_SITE[attribute.get('samesite')?.toLowerCase() ?? ''] ?? 'Lax',
    ...(Number.isFinite(maxAge) ? { expires: Math.floor(Date.now() / 1000) + maxAge } : {}),
  }
}

export const test = base.extend<{ signedInUser: SignedInUser }, { accounts: Accounts }>({
  accounts: [
    // eslint-disable-next-line no-empty-pattern -- Playwright wants a destructuring pattern here.
    async ({}, use) => {
      const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
      // The rate of the run, only while the database has none: a rate somebody approved stays
      // as it is, and is never removed here.
      const rated = (await prisma.creditRate.count()) > 0
      const ownRate = rated
        ? { count: 0 }
        : await prisma.creditRate.createMany({ data: [RUN_CREDIT_RATE], skipDuplicates: true })
      // Letters stay here instead of the outbox: nobody delivers them in this run.
      const confirmationLinks = new Map<string, string>()
      const notifier: Notifier = {
        verifyEmail: async ({ to, url }) => {
          confirmationLinks.set(to, url)
        },
        resetPassword: async () => undefined,
        welcome: async () => undefined,
      }
      const auth = createAuth({ config: authConfigFromEnv(authEnv), prisma, notifier })

      const remove = async (userId: string) => {
        // A payment or a first site gives the user a workspace. Orders, subscriptions and the
        // accounts of credits hold it with Restrict keys, and the ledger holds the accounts and
        // the orders: what refers goes first, the user last.
        const workspaces = await prisma.workspace.findMany({
          where: { createdById: userId },
          select: { id: true },
        })
        if (workspaces.length > 0) {
          const owned = { workspaceId: { in: workspaces.map(({ id }) => id) } }
          const orders = await prisma.order.findMany({ where: owned, select: { id: true } })
          if (orders.length > 0) {
            // The key of a letter about an order ends with the id of the order.
            await prisma.outboxEvent.deleteMany({
              where: { OR: orders.map(({ id }) => ({ dedupeKey: { endsWith: `:${id}` } })) },
            })
          }
          await prisma.creditLedger.deleteMany({ where: { account: owned } })
          await prisma.creditHold.deleteMany({ where: { account: owned } })
          await prisma.billingAccount.deleteMany({ where: owned })
          // The tasks a test queued (fixtures/credits.ts): a site whose gift a reserve claimed,
          // the model calls of the tasks and their turn keys, then the tasks; the turn rows go
          // with them.
          await prisma.giftSiteClaim.deleteMany({ where: owned })
          await prisma.tokenUsage.deleteMany({ where: { task: owned } })
          await prisma.llmCall.deleteMany({ where: { key: { task: owned } } })
          await prisma.llmKey.deleteMany({ where: { task: owned } })
          await prisma.task.deleteMany({ where: owned })
          await prisma.site.deleteMany({ where: owned })
          await prisma.order.deleteMany({ where: owned })
          await prisma.subscription.deleteMany({ where: owned })
          await prisma.auditLog.deleteMany({ where: owned })
          await prisma.workspace.deleteMany({ where: { id: owned.workspaceId } })
        }
        await prisma.user.deleteMany({ where: { id: userId } })
      }

      const create = async () => {
        const profile = {
          name: 'Анна',
          lastName: 'Проверкина',
          email: `e2e-${randomUUID()}@example.ru`,
          password: randomBytes(18).toString('base64url'),
        }
        // Both required checkboxes of the sign-up form (152-FZ): the plugin of @repo/auth
        // records a consent to the current edition of every required document.
        const consent = { acceptTerms: true, acceptPersonalData: true, marketing: false }
        const { user } = await auth.api.signUpEmail({ body: { ...profile, ...consent } })
        try {
          const link = confirmationLinks.get(profile.email)
          confirmationLinks.delete(profile.email)
          const token = link ? new URL(link).searchParams.get('token') : null
          if (!token) throw new Error('The sign-up sent no confirmation letter')
          // Verifies the address and signs in, as the link of the letter does.
          const verified = await auth.api.verifyEmail({ query: { token }, asResponse: true })
          const cookies = verified.headers.getSetCookie().map(browserCookie)
          if (!verified.ok || cookies.length === 0)
            throw new Error(`The confirmation link opened no session (HTTP ${verified.status})`)

          // The sign-up only logs a failed write of the consents, and without them every page
          // of the cabinet redirects to /onboarding/consents: the fixture fails here instead.
          const stored = await prisma.userConsent.findMany({
            where: { userId: user.id },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { documentType: true, granted: true, documentVersion: true },
          })
          const missing = requiredConsentRows(latestConsents(stored), {
            userId: user.id,
            source: 'sign_up',
            ipAddress: null,
            userAgent: null,
          }).map((row) => row.documentType)
          if (missing.length > 0)
            throw new Error(`The sign-up recorded no consent to: ${missing.join(', ')}`)

          return { user: { id: user.id, ...profile }, cookies }
        } catch (error) {
          await remove(user.id)
          throw error
        }
      }

      await use({ create, remove })
      if (ownRate.count > 0) {
        await prisma.creditRate.deleteMany({
          where: { effectiveFrom: RUN_CREDIT_RATE.effectiveFrom, basis: RUN_CREDIT_RATE.basis },
        })
      }
      await prisma.$disconnect()
    },
    { scope: 'worker' },
  ],

  // Asking for the user signs the `context` and the `page` of the test in.
  signedInUser: async ({ accounts, context }, use) => {
    const { user, cookies } = await accounts.create()
    try {
      await context.addCookies(cookies)
      await use(user)
    } finally {
      await accounts.remove(user.id)
    }
  },
})

export { expect } from '@playwright/test'
