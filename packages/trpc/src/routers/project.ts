import { BlockList, isIP } from 'node:net'
import { domainToUnicode } from 'node:url'

import { profileNameSchema } from '@repo/auth'
import { Prisma, SiteStack, SiteStatus } from '@repo/db'
import { appEnvSchema, DomainError, isProduction } from '@repo/domain'
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

const alreadyExists = () =>
  new DomainError('PROJECT_ALREADY_EXISTS', 'The user already has access to this site', 409)

/**
 * A technical ceiling on the sites one user creates, well above the largest tariff (15 sites).
 * The limit of the user's plan (`plans.max_sites`) arrives with billing.
 */
export const MAX_SITES_PER_USER = 50

export const projectRouter = router({
  list: consentedProcedure.output(z.array(projectOutput)).query(async ({ ctx }) => {
    const sites = await ctx.prisma.site.findMany({
      where: { workspace: { members: { some: { userId: ctx.user.id } } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: projectSelect,
    })
    return sites.map(withHost)
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
      const production = isProduction(appEnvSchema.parse(process.env.APP_ENV))
      if (production && siteHost(new URL(input.url).hostname) !== 'public') {
        throw new DomainError(
          'SITE_ADDRESS_NOT_PUBLIC',
          'Local and private site addresses are accepted only outside production',
          400,
        )
      }
      const dataClass = production ? 'client' : 'synthetic'
      try {
        return await ctx.prisma.$transaction(
          async (tx) => {
            // Serialize this user's first and subsequent projects across web replicas.
            // READ COMMITTED sees the previous creator's committed workspace after this lock.
            // NO KEY: rows that reference the user (sessions, consents) are not held up.
            const users = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR NO KEY UPDATE
          `
            if (users.length === 0) {
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

            // Shared or inherited workspaces are never implicitly chosen for a new project.
            let workspace = await tx.workspace.findFirst({
              where: {
                createdById: ctx.user.id,
                dataClass,
                members: {
                  some: { userId: ctx.user.id, role: 'owner' },
                  every: { userId: ctx.user.id, role: 'owner' },
                },
              },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: { id: true },
            })
            workspace ??= await tx.workspace.create({
              data: {
                name: 'Мои проекты',
                createdById: ctx.user.id,
                dataClass,
                members: { create: { userId: ctx.user.id, role: 'owner' } },
              },
              select: { id: true },
            })
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
