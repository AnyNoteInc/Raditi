import type { PrismaClient } from '@repo/db'
import {
  DomainError,
  siteAccessPath,
  type PublishedContentGateway,
  type SecretStore,
  type SiteContentAdapter,
  type SiteHttpTransport,
  type SiteStack,
} from '@repo/domain'
import { z } from 'zod'

import type { ContentGatewayResolver } from './mcp-content.ts'

export const MCP_CONTENT_RESOLVER = Symbol('MCP_CONTENT_RESOLVER')

export type SiteAccessRefusal =
  'stack' | 'reference' | 'path' | 'vault' | 'secret' | 'version' | 'format' | 'origin' | 'adapter'

/**
 * One fixed refusal for every way a site's access can be unusable. The reason is a word for
 * the operator; nothing of the reference, the secret or a Vault answer travels with it.
 */
const refusal = (reason: SiteAccessRefusal) =>
  new DomainError('CONTENT_SITE_ACCESS_UNAVAILABLE', 'Site content access is unavailable', 503, {
    reason,
  })

const referenceSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  vaultPath: z.string().min(1).max(512),
  keyVersion: z.number().int().min(1),
})

export interface SiteContentResolverOptions {
  prisma: Pick<PrismaClient, 'credentialRef'>
  secrets: Pick<SecretStore, 'kvRead'>
  /** The registry of site adapters: the stack of the site picks the adapter, not this code. */
  adapters: (stack: SiteStack) => SiteContentAdapter
  transport: SiteHttpTransport
  /** A disposable local site over plain http on loopback; never in production. */
  allowLoopbackHttp: boolean
  /** How long a secret read from Vault is used before it is read again. */
  ttlMs?: number
  maxEntries?: number
  now?: () => number
  /** Told the reason of every refusal: the agent and the journal get fixed codes only. */
  onRefusal?: (reason: SiteAccessRefusal) => void
}

interface Entry {
  referenceId: string
  keyVersion: number
  origin: string
  gateway: PublishedContentGateway
  expires: number
}

/**
 * The gateway to the published content of the admitted site (spec §8, §11, §15). The site
 * comes from the scope of the call, never from its arguments:
 *
 *   credential_refs row of the kind the stack's adapter names → its path is exactly
 *   kv/sites/<siteId>/<kind> → the secret in Vault at the version the row names → the origin
 *   in the secret is the origin of the site's address → the adapter builds the gateway.
 *
 * A row that points anywhere else, a secret of another version or for another address, and a
 * stack without published content are all refused the same way. The reference is read on
 * every call; Vault once per reference and key version, until the copy expires: another row
 * or another key version of the row never gets a gateway built from the previous secret.
 */
export function createSiteContentResolver({
  prisma,
  secrets,
  adapters,
  transport,
  allowLoopbackHttp,
  ttlMs = 60_000,
  maxEntries = 256,
  now = Date.now,
  onRefusal,
}: SiteContentResolverOptions): ContentGatewayResolver {
  const cache = new Map<string, Entry>()
  const refused = (reason: SiteAccessRefusal) => {
    onRefusal?.(reason)
    return refusal(reason)
  }

  return async (scope) => {
    let adapter: SiteContentAdapter
    try {
      adapter = adapters(scope.stack)
    } catch {
      throw refused('stack')
    }
    let canonical: string
    let origin: string
    try {
      canonical = siteAccessPath(scope.siteId, adapter.accessKind)
      origin = new URL(scope.url).origin
    } catch {
      throw refused('reference')
    }

    let rows: unknown[]
    try {
      rows = await prisma.credentialRef.findMany({
        where: { siteId: scope.siteId, kind: adapter.accessKind },
        select: { id: true, workspaceId: true, vaultPath: true, keyVersion: true },
        take: 2,
      })
    } catch {
      throw refused('reference')
    }
    // One copy per site and stack: the stack picks the adapter that built the gateway.
    const slot = `${scope.siteId}:${scope.stack}`
    // Exactly one access of the kind, in the workspace of the admitted task.
    const reference = rows.length === 1 ? referenceSchema.safeParse(rows[0]) : undefined
    if (!reference?.success || reference.data.workspaceId !== scope.workspaceId) {
      cache.delete(slot)
      throw refused('reference')
    }
    const ref = reference.data
    // The database only points: a changed row must not lead to another site or another mount.
    if (ref.vaultPath !== canonical) {
      cache.delete(slot)
      throw refused('path')
    }

    const cached = cache.get(slot)
    if (
      cached &&
      cached.referenceId === ref.id &&
      cached.keyVersion === ref.keyVersion &&
      cached.expires > now()
    ) {
      // The address of the site may change after the access was read.
      if (cached.origin !== origin) throw refused('origin')
      return cached.gateway
    }
    cache.delete(slot)

    let stored: Awaited<ReturnType<typeof secrets.kvRead>>
    try {
      stored = await secrets.kvRead(canonical)
    } catch {
      throw refused('vault')
    }
    if (!stored) throw refused('secret')
    // A rotation writes Vault first and the reference second: until both agree, nothing read
    // from Vault is used, neither the old secret nor the new one. A copy taken before the
    // rotation still serves until it expires (`ttlMs`).
    if (stored.version !== ref.keyVersion) throw refused('version')
    const access = adapter.accessSchema.safeParse(stored.data)
    if (!access.success) throw refused('format')
    let accessOrigin: string
    try {
      accessOrigin = new URL(access.data.origin).origin
    } catch {
      throw refused('format')
    }
    // A password issued for one address is never sent to another.
    if (accessOrigin !== origin) throw refused('origin')

    let gateway: PublishedContentGateway
    try {
      gateway = adapter.createGateway({
        siteId: scope.siteId,
        origin,
        access: access.data,
        transport,
        allowLoopbackHttp,
      })
    } catch {
      throw refused('adapter')
    }
    while (cache.size >= maxEntries) {
      const oldest = cache.keys().next()
      if (oldest.done) break
      cache.delete(oldest.value)
    }
    cache.set(slot, {
      referenceId: ref.id,
      keyVersion: ref.keyVersion,
      origin,
      gateway,
      expires: now() + ttlMs,
    })
    return gateway
  }
}
