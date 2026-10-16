import { BlockList, isIP } from 'node:net'
import { domainToUnicode } from 'node:url'

import { profileNameSchema } from '@repo/auth'
import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import type {
  CredentialKind} from '@repo/db';
import {
  lockUserRow,
  Prisma,
  SiteStack,
  SiteStatus,
} from '@repo/db'
import { appEnvSchema, DomainError, isProduction, liveSubscriptionStatuses } from '@repo/domain'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { consentedProcedure, router } from '../trpc.ts'

const privateAddresses = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  privateAddresses.addSubnet(address, prefix, 'ipv4')
}
const globalIpv6 = new BlockList()
globalIpv6.addSubnet('2000::', 3, 'ipv6')
privateAddresses.addSubnet('2001::', 32, 'ipv6')
privateAddresses.addSubnet('2001:db8::', 32, 'ipv6')
privateAddresses.addSubnet('2002::', 16, 'ipv6')
// Loopback, RFC 1918 and unique local addresses: a site on the developer's machine or network.
const localAddresses = new BlockList()
for (const [address, prefix] of [
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  localAddresses.addSubnet(address, prefix, 'ipv4')
}
// A list of its own: BlockList matches IPv4-mapped IPv6 addresses against IPv4 rules.
const localIpv6 = new BlockList()
localIpv6.addAddress('::1', 'ipv6')
localIpv6.addSubnet('fc00::', 7, 'ipv6')

/**
 * `public` is a site address everywhere; `local` only outside production, where the site is a
 * WordPress on the developer's machine; null never is. Input validation only; connecting a
 * site must separately validate resolved addresses.
 */
function siteHost(hostname: string): 'public' | 'local' | null {
  const address = hostname.replace(/^\[|\]$/g, '')
  const ipVersion = isIP(address)
  if (ipVersion === 4) {
    if (localAddresses.check(address, 'ipv4')) return 'local'
    return privateAddresses.check(address, 'ipv4') ? null : 'public'
  }
  if (ipVersion === 6) {
    if (localIpv6.check(address, 'ipv6')) return 'local'
    return globalIpv6.check(address, 'ipv6') && !privateAddresses.check(address, 'ipv6')
      ? 'public'
      : null
  }
  const labels = hostname.split('.')
  if (
    hostname.length > 253 ||
    !labels.every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label)) ||
    !/[a-z]/i.test(labels.at(-1) ?? '') ||
    /(?:^|\.)(?:invalid|onion)$/i.test(hostname)
  ) {
    return null
  }
  return labels.length === 1 ||
    /(?:^|\.)(?:localhost|local|internal|test|lan|home)$/i.test(hostname)
    ? 'local'
    : 'public'
}

const siteOrigin = z
  .string()
  .trim()
  .max(512)
  .transform((value, ctx) => {
    const url = URL.parse(value)
    // Reject paths before parsing as URL resolves /.. and backslashes to an origin.
    if (
      !/^https?:\/\/[^/?#\\\s]+\/?$/i.test(value) ||
      !url ||
      url.username ||
      url.password ||
      !siteHost(url.hostname.replace(/\.$/, ''))
    ) {
      ctx.addIssue({ code: 'custom', message: 'Укажите адрес сайта: https://example.ru' })
      return z.NEVER
    }
    url.hostname = url.hostname.replace(/\.$/, '')
    if (url.origin.length > 512) {
      ctx.addIssue({ code: 'custom', message: 'Адрес сайта слишком длинный' })
      return z.NEVER
    }
    return url.origin
  })

const projectSelect = {
  id: true,
  name: true,
  url: true,
  stack: true,
  status: true,
  createdAt: true,
} satisfies Prisma.SiteSelect

const projectOutput = z.object({
  id: z.uuid(),
  name: z.string(),
  url: z.string(),
  host: z.string(),
  stack: z.enum(SiteStack),
  status: z.enum(SiteStatus),
  createdAt: z.date(),
})

/**
 * The host of a stored site address as its owner reads it: the row keeps the ASCII form of an
 * international domain (`xn--e1aiboc0b6e.xn--p1ai`), people know it as `кофейня.рф`. A label
 * that is not Punycode and a row that is not an address stay as they are.
 */
function displayHost(address: string): string {
  const url = URL.parse(address)
  if (!url) return address
  const hostname = domainToUnicode(url.hostname) || url.hostname
  return url.port ? `${hostname}:${url.port}` : hostname
}

const withHost = <Site extends { url: string }>(site: Site) => ({
  ...site,
  host: displayHost(site.url),
})

/**
 * A site the user may open: one in a workspace they are a member of. A site of someone else
 * and a site that does not exist answer the same — the caller must not learn which it is.
 */
const accessibleSite = (userId: string, id: string) =>
  ({ id, workspace: { members: { some: { userId } } } }) satisfies Prisma.SiteWhereInput

const siteNotFound = () =>
  new DomainError('NOT_FOUND', 'No such site among the sites of the user', 404)

/** The kinds of access a site itself has; a row of any other kind is not shown on its page. */
const SITE_ACCESS_KINDS = [
  'ssh',
  'ftp',
  'wp',
  'browser',
  'db',
] as const satisfies readonly CredentialKind[]

/**
 * What stands between the site and a new operation, by the rule of the lease store
 * (`site-leases.ts`): `held` — the outcome of the last operation is unknown, by a hold for the
 * operator or by a content write that was not confirmed; `busy` — a turn, a deploy or a revert
 * is running; `free` — nothing.
 */
function siteState(
  lease: {
    operation: unknown
    expiresAt: Date | null
    heldForOperator: boolean
    inflightMcpCallId: string | null
  } | null,
): 'free' | 'busy' | 'held' {
  if (!lease) return 'free'
  if (lease.heldForOperator || lease.inflightMcpCallId !== null) return 'held'
  const running =
    lease.operation !== null && (lease.expiresAt === null || lease.expiresAt > new Date())
  return running ? 'busy' : 'free'
}

const siteOutput = projectOutput.extend({
  /** Nothing new starts on a site that is `busy` or `held`. */
  state: z.enum(['free', 'busy', 'held']),
})

/** A saved access of the site as its owner may see it: never the Vault path, never a value. */
const credentialOutput = z.object({
  kind: z.enum(SITE_ACCESS_KINDS),
  version: z.number().int(),
  updatedAt: z.date(),
})

const alreadyExists = () =>
  new DomainError('PROJECT_ALREADY_EXISTS', 'The user already has access to this site', 409)

/**
 * A technical ceiling on the sites one user creates, well above the largest tariff (15 sites).
 * It is all that limits a user without a tariff; with one, or with one being paid for, the
 * personal workspace also holds no more sites than its plan allows (`plans.max_sites`) — and no
 * more than the plan it is to change to.
 */
export const MAX_SITES_PER_USER = 50

/**
 * Whose limit holds the sites: the tariff that is on (`live`), a tariff whose payment is not
 * finished (`unpaid`), or the tariff chosen for the next period (`scheduled`).
 */
type LimitingTariff = 'live' | 'unpaid' | 'scheduled'

/**
 * The site limit of the workspace: the smallest of the limits of the tariff that is on, of a
 * tariff that is being paid for and of the tariff scheduled for the next period — nothing counts
 * the sites again when a payment arrives or a renewal applies the scheduled tariff, so each of
 * them limits from the moment it is chosen. null when none of them names a number.
 *
 * Of equal limits the one named is the tariff the customer has, then the one they pay for: a
 * scheduled tariff is named only when it alone is the smallest, which is when taking the choice
 * back helps.
 */
function siteLimitOf(limits: Record<LimitingTariff, number | null>): {
  maxSites: number
  of: LimitingTariff
} | null {
  let limit: { maxSites: number; of: LimitingTariff } | null = null
  // The variable is not called `of`: Next's parser refuses `for (const of of …)`.
  for (const tariff of ['live', 'unpaid', 'scheduled'] as const) {
    const maxSites = limits[tariff]
    if (maxSites !== null && (limit === null || maxSites < limit.maxSites)) {
      limit = { maxSites, of: tariff }
    }
  }
  return limit
}

/**
 * The site limit of the tariff is reached; the client text names `maxSites` from the details.
 * `unpaid`: the limit is of a tariff whose payment is not finished, not of the one that is on.
 * `scheduled`: it is of the tariff the customer chose for the next period.
 */
const planLimitReached = (maxSites: number, tariff: LimitingTariff) =>
  new DomainError(
    'PROJECT_PLAN_LIMIT_REACHED',
    'The plan of the workspace allows no more sites',
    403,
    tariff === 'live' ? { maxSites } : { maxSites, [tariff]: true },
  )

export const projectRouter = router({
  list: consentedProcedure.output(z.array(projectOutput)).query(async ({ ctx }) => {
    const sites = await ctx.prisma.site.findMany({
      where: { workspace: { members: { some: { userId: ctx.user.id } } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: projectSelect,
    })
    return sites.map(withHost)
  }),

  /** One site of the user, for its page in the cabinet. */
  get: consentedProcedure
    .input(z.strictObject({ id: z.uuid() }))
    .output(siteOutput)
    .query(async ({ ctx, input }) => {
      const site = await ctx.prisma.site.findFirst({
        where: accessibleSite(ctx.user.id, input.id),
        select: {
          ...projectSelect,
          lease: {
            select: {
              operation: true,
              expiresAt: true,
              heldForOperator: true,
              inflightMcpCallId: true,
            },
          },
        },
      })
      if (!site) throw siteNotFound()
      const { lease, ...row } = site
      return { ...withHost(row), state: siteState(lease) }
    }),

  /** Which accesses of the site are saved: kind, version and date — the secrets stay in Vault. */
  credentials: consentedProcedure
    .input(z.strictObject({ id: z.uuid() }))
    .output(z.array(credentialOutput))
    .query(async ({ ctx, input }) => {
      const site = await ctx.prisma.site.findFirst({
        where: accessibleSite(ctx.user.id, input.id),
        select: {
          credentialRefs: {
            where: { kind: { in: [...SITE_ACCESS_KINDS] } },
            orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
            select: { kind: true, keyVersion: true, updatedAt: true },
          },
        },
      })
      if (!site) throw siteNotFound()
      return site.credentialRefs.map((ref) => ({
        // The query asked for these kinds only.
        kind: ref.kind as (typeof SITE_ACCESS_KINDS)[number],
        version: ref.keyVersion,
        updatedAt: ref.updatedAt,
      }))
    }),

  create: consentedProcedure
    .input(
      z.strictObject({
        // A one-line name, by the rule of every other name a user types (`sites.name`, VarChar 255).
        name: profileNameSchema,
        url: siteOrigin,
        stack: z.enum(SiteStack),
      }),
    )
    .output(projectOutput)
    .mutation(async ({ ctx, input }) => {
      const appEnv = appEnvSchema.parse(process.env.APP_ENV)
      if (isProduction(appEnv) && siteHost(new URL(input.url).hostname) !== 'public') {
        throw new DomainError(
          'SITE_ADDRESS_NOT_PUBLIC',
          'Local and private site addresses are accepted only outside production',
          400,
        )
      }
      try {
        return await ctx.prisma.$transaction(
          async (tx) => {
            // Serialize this user's first and subsequent projects across web replicas: the
            // duplicate and the ceiling below are checked under the lock.
            if (!(await lockUserRow(tx, ctx.user.id))) {
              throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Войдите, чтобы продолжить' })
            }

            const duplicate = await tx.site.findFirst({
              where: {
                url: input.url,
                workspace: { members: { some: { userId: ctx.user.id } } },
              },
              select: { id: true },
            })
            if (duplicate) throw alreadyExists()

            const created = await tx.site.count({
              where: { workspace: { createdById: ctx.user.id } },
            })
            if (created >= MAX_SITES_PER_USER) {
              throw new DomainError(
                'PROJECT_LIMIT_REACHED',
                'The user reached the ceiling on created sites',
                403,
              )
            }

            // The workspace billing keeps its accounts for; a shared or inherited one is never
            // implicitly chosen for a new project. The gift of the registration is granted here
            // when the user has none yet: the first site may be what makes the workspace.
            const workspace = await ensurePersonalWorkspaceWithGift(tx, {
              userId: ctx.user.id,
              appEnv,
            })

            // With a tariff the workspace holds as many sites as its plan allows, and a tariff
            // whose payment is overdue is still one. Every site counts, whatever its status:
            // the count a checkout compares with the plan. The user lock above orders this
            // with the user's other sites and checkouts.
            //
            // A tariff that is being paid for limits the sites as well: its checkout compared
            // them with the plan, and nothing counts them again when the money arrives. The
            // unfinished order is read before the live subscription, as a checkout reads them:
            // a settlement does not wait for the user lock, but it takes the order out of
            // `pending` and starts the subscription in one commit, so whenever that commit
            // lands these two reads see the order still pending or the subscription already
            // live — never neither.
            const unfinished = await tx.order.findFirst({
              where: { workspaceId: workspace.id, kind: 'subscription', status: 'pending' },
              select: { plan: { select: { maxSites: true } } },
            })
            //
            // So does the tariff chosen for the next period (`next_plan_id`): the choice was
            // compared with the sites when it was made (`schedulePlanChange`, under this same
            // user lock), and the renewal, or the payment of an overdue tariff, that applies it
            // counts nothing. Without this a customer could choose a smaller tariff and then
            // add sites up to the limit of the one they have.
            const live = await tx.subscription.findFirst({
              where: { workspaceId: workspace.id, status: { in: [...liveSubscriptionStatuses] } },
              select: {
                plan: { select: { maxSites: true } },
                nextPlan: { select: { maxSites: true } },
              },
            })
            // The smallest of the three: a renewal that moves the workspace to a smaller tariff
            // is being charged, or is scheduled.
            const limit = siteLimitOf({
              live: live?.plan.maxSites ?? null,
              unpaid: unfinished?.plan?.maxSites ?? null,
              scheduled: live?.nextPlan?.maxSites ?? null,
            })
            if (
              limit !== null &&
              (await tx.site.count({ where: { workspaceId: workspace.id } })) >= limit.maxSites
            ) {
              throw planLimitReached(limit.maxSites, limit.of)
            }

            const site = await tx.site.create({
              data: { ...input, workspaceId: workspace.id, status: 'onboarding' },
              select: projectSelect,
            })
            return withHost(site)
          },
          { isolationLevel: 'ReadCommitted' },
        )
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw alreadyExists()
        }
        throw error
      }
    }),
})
