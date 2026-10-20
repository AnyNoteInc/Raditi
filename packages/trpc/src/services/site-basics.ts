import { BlockList, isIP } from 'node:net'
import { domainToUnicode } from 'node:url'

import {
  findPersonalWorkspace,
  type PersonalWorkspaceOwner,
  type Prisma,
  type PrismaClient,
} from '@repo/db'
import {
  DomainError,
  isProduction,
  liveSubscriptionStatuses,
  siteConnectionLimits,
  type AppEnv,
  type SiteStack,
} from '@repo/domain'
import { z } from 'zod'

// The first step of «Добавить проект» (docs/plan/39-site-connection-wizard.md): the name, the address and the
// platform of a site, and whether the user has room for one more. One rule for the wizard's «Далее»
// (`siteConnection.checkBasics`, read-only) and for `project.create`, which checks the same again under the
// lock of the user's row before it writes.

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

export const siteOrigin = z
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

/**
 * The host of a stored site address as its owner reads it: the row keeps the ASCII form of an
 * international domain (`xn--e1aiboc0b6e.xn--p1ai`), people know it as `кофейня.рф`. A label
 * that is not Punycode and a row that is not an address stay as they are.
 */
export function displayHost(address: string): string {
  const url = URL.parse(address)
  if (!url) return address
  const hostname = domainToUnicode(url.hostname) || url.hostname
  return url.port ? `${hostname}:${url.port}` : hostname
}

export const withHost = <Site extends { url: string }>(site: Site) => ({
  ...site,
  host: displayHost(site.url),
})

/**
 * A site the user may open: one in a workspace they are a member of. A site of someone else
 * and a site that does not exist answer the same — the caller must not learn which it is.
 */
export const accessibleSite = (userId: string, id: string) =>
  ({ id, workspace: { members: { some: { userId } } } }) satisfies Prisma.SiteWhereInput

export const siteNotFound = () =>
  new DomainError('NOT_FOUND', 'No such site among the sites of the user', 404)

export const alreadyExists = () =>
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

/** A platform the wizard connects (`connectableStacks` of the registry of site adapters). */
export function assertStackConnectable(
  rule: { connectableStacks: readonly SiteStack[] },
  stack: SiteStack,
): void {
  if (!rule.connectableStacks.includes(stack)) {
    throw new DomainError(
      'SITE_STACK_NOT_CONNECTABLE',
      'The wizard does not connect sites of this platform',
      400,
    )
  }
}

/**
 * What a site is accepted as before anything is read: in production an address that opens from the
 * internet, and a platform the wizard connects.
 */
export function assertSiteAccepted(
  rule: { appEnv: AppEnv; connectableStacks: readonly SiteStack[] },
  site: { url: string; stack: SiteStack },
): void {
  if (isProduction(rule.appEnv) && siteHost(new URL(site.url).hostname) !== 'public') {
    throw new DomainError(
      'SITE_ADDRESS_NOT_PUBLIC',
      'Local and private site addresses are accepted only outside production',
      400,
    )
  }
  assertStackConnectable(rule, site.stack)
}

/** The client or a transaction: everything the room for a site is read from. */
export type SiteRoomDb = Pick<
  Prisma.TransactionClient,
  'site' | 'order' | 'subscription' | 'siteProvisioningStage'
>

/**
 * Whether the user has room for one more site at `url`, in this order: no site at this address among the
 * sites they can open, fewer than MAX_SITES_PER_USER sites in the workspaces they created, room under the
 * site limit of the tariff of the personal workspace, and fewer than connectionsInProgressPerUser sites of
 * those workspaces whose import is queued or running. Returns the personal workspace.
 *
 * `personalWorkspace` is asked between the ceiling and the tariff: the read-only check of the wizard passes
 * `findPersonalWorkspace` (null while there is none — no tariff to count), `project.create` passes
 * `ensurePersonalWorkspaceWithGift` under the lock of the user's row, so the duplicate, the ceiling, the
 * tariff and the imports in progress are all counted under that lock.
 */
export async function assertRoomForSite<Workspace extends { id: string } | null>(
  db: SiteRoomDb,
  { userId, url }: { userId: string; url: string },
  personalWorkspace: () => Promise<Workspace>,
): Promise<Workspace> {
  const duplicate = await db.site.findFirst({
    where: { url, workspace: { members: { some: { userId } } } },
    select: { id: true },
  })
  if (duplicate) throw alreadyExists()

  const created = await db.site.count({ where: { workspace: { createdById: userId } } })
  if (created >= MAX_SITES_PER_USER) {
    throw new DomainError(
      'PROJECT_LIMIT_REACHED',
      'The user reached the ceiling on created sites',
      403,
    )
  }

  // The workspace billing keeps its accounts for; a shared or inherited one is never implicitly
  // chosen for a new project. In `project.create` the gift of the registration is granted here
  // when the user has none yet: the first site may be what makes the workspace.
  const workspace = await personalWorkspace()

  if (workspace !== null) {
    // With a tariff the workspace holds as many sites as its plan allows, and a tariff whose
    // payment is overdue is still one. Every site counts, whatever its status: the count a
    // checkout compares with the plan. The user lock of `project.create` orders this with the
    // user's other sites and checkouts.
    //
    // A tariff that is being paid for limits the sites as well: its checkout compared them
    // with the plan, and nothing counts them again when the money arrives. The unfinished order
    // is read before the live subscription, as a checkout reads them: a settlement does not
    // wait for the user lock, but it takes the order out of `pending` and starts the
    // subscription in one commit, so whenever that commit lands these two reads see the order
    // still pending or the subscription already live — never neither.
    const unfinished = await db.order.findFirst({
      where: { workspaceId: workspace.id, kind: 'subscription', status: 'pending' },
      select: { plan: { select: { maxSites: true } } },
    })
    //
    // So does the tariff chosen for the next period (`next_plan_id`): the choice was compared
    // with the sites when it was made (`schedulePlanChange`, under this same user lock), and the
    // renewal, or the payment of an overdue tariff, that applies it counts nothing. Without this
    // a customer could choose a smaller tariff and then add sites up to the limit of the one
    // they have.
    const live = await db.subscription.findFirst({
      where: { workspaceId: workspace.id, status: { in: [...liveSubscriptionStatuses] } },
      select: {
        plan: { select: { maxSites: true } },
        nextPlan: { select: { maxSites: true } },
      },
    })
    // The smallest of the three: a renewal that moves the workspace to a smaller tariff is
    // being charged, or is scheduled.
    const limit = siteLimitOf({
      live: live?.plan.maxSites ?? null,
      unpaid: unfinished?.plan?.maxSites ?? null,
      scheduled: live?.nextPlan?.maxSites ?? null,
    })
    if (
      limit !== null &&
      (await db.site.count({ where: { workspaceId: workspace.id } })) >= limit.maxSites
    ) {
      throw planLimitReached(limit.maxSites, limit.of)
    }
  }

  await assertConnectionsNotBusy(db, userId)
  return workspace
}

/**
 * `assertRoomForSite` before the lock of the user's row — the wizard's «Основные данные» and the fail-fast of
 * `project.create` — in one snapshot. Read by separate statements, a site and its import that another request
 * of the user commits between them would show the imports in progress full while the sites are not, and answer
 * SITE_CONNECTIONS_BUSY where PROJECT_LIMIT_REACHED is due. Read-only, so REPEATABLE READ never fails to
 * serialize; `project.create` asks everything again under the lock. Returns the personal workspace, if any.
 */
export function assertRoomForSiteSnapshot(
  prisma: Pick<PrismaClient, '$transaction'>,
  owner: PersonalWorkspaceOwner,
  url: string,
): Promise<{ id: string } | null> {
  return prisma.$transaction(
    (tx) =>
      assertRoomForSite(tx, { userId: owner.userId, url }, () => findPersonalWorkspace(tx, owner)),
    { isolationLevel: 'RepeatableRead' },
  )
}

/**
 * Fewer than connectionsInProgressPerUser sites of the workspaces the user created have their first import
 * queued or running, or SITE_CONNECTIONS_BUSY. Each connection downloads a whole site in the background: a
 * user does not start more of them at once than this, whatever their tariff — by a new site, «Повторить» or
 * «Изменить доступ» alike, each counting under the lock of the user's row. A failed import is not in
 * progress, so the one being retried is not counted.
 */
export async function assertConnectionsNotBusy(
  db: Pick<Prisma.TransactionClient, 'siteProvisioningStage'>,
  userId: string,
): Promise<void> {
  const inProgress = await db.siteProvisioningStage.count({
    where: {
      stage: 'code_import',
      status: { in: ['queued', 'running'] },
      site: { workspace: { createdById: userId } },
    },
  })
  if (inProgress >= siteConnectionLimits.connectionsInProgressPerUser) {
    throw new DomainError(
      'SITE_CONNECTIONS_BUSY',
      'The user already has the maximum number of site imports in progress',
      429,
    )
  }
}
