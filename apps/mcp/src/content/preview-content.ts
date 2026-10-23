import {
  DomainError,
  previewAccessPath,
  previewOrigin,
  type PreviewAddress,
  type PreviewUpstream,
  type PublishedContentGateway,
  type SecretStore,
  type SiteContentAdapter,
  type SiteStack,
} from '@repo/domain'

import { previewContentGateway } from '@repo/site-content'
import type { PreviewDbRuntime } from '@repo/site-content'

export const MCP_PREVIEW_RESOLVER = Symbol('MCP_PREVIEW_RESOLVER')

/**
 * A preview as a content write reaches it (docs/plan/53-chat-preview-release.md, Р24): read from
 * `preview_environments` under the journal's lock, never from a request. `upstream` is where its
 * entry forwarder listens; `writeEpoch` fences the write — the epoch the site plugin of the copy
 * is sent, the same one the build of the preview replays the plan with (R5c).
 */
export interface McpPreviewTarget {
  previewId: string
  siteId: string
  workspaceId: string
  stack: SiteStack
  hostname: string
  upstream: PreviewUpstream
  writeEpoch: number
  /**
   * What the agent may change in its database (`runtime.db` of its last build); absent — the
   * text of records alone.
   */
  db?: PreviewDbRuntime
}

/** The gateway to the published content of a preview: the stack's own, reached over its upstream. */
export type PreviewGatewayResolver = (target: McpPreviewTarget) => Promise<PublishedContentGateway>

export type PreviewAccessRefusal =
  'address' | 'stack' | 'upstream' | 'vault' | 'secret' | 'format' | 'origin' | 'adapter'

/** One fixed refusal; the reason is a word for the operator, never a value. */
const refusal = (reason: PreviewAccessRefusal) =>
  new DomainError('CONTENT_PREVIEW_UNAVAILABLE', 'Preview content access is unavailable', 503, {
    reason,
  })

/** What builds the gateway of a stack over the upstream of a preview (core's own, R5c). */
export type PreviewGatewayFactory = typeof previewContentGateway

export interface PreviewContentResolverOptions {
  secrets: Pick<SecretStore, 'kvRead'>
  /** The registry of site adapters: the stack of the site picks the adapter, not this code. */
  adapters: (stack: SiteStack) => SiteContentAdapter
  /** Where previews answer (PREVIEW_BASE_DOMAIN and the rest); null — previews are not configured. */
  address: PreviewAddress | null
  /** PREVIEW_UPSTREAM_HOST: the only host a preview's upstream may be. */
  upstreamHost: string
  gateway?: PreviewGatewayFactory
  /** How long a secret read from Vault is used before it is read again. */
  ttlMs?: number
  maxEntries?: number
  now?: () => number
  onRefusal?: (reason: PreviewAccessRefusal) => void
}

interface Entry {
  key: string
  gateway: PublishedContentGateway
  expires: number
}

/**
 * The gateway to the published content of the dialog's preview (Р24). The preview comes from the
 * journal's row, never from a request:
 *
 *   the stack's adapter names the kind of its access → Vault `kv/previews/<previewId>/<kind>`
 *   (the account the build created) → the origin in the secret is the preview's origin → the
 *   gateway of core's preview manager: the plugin of the copy is bound to `previewId` (R5b), and
 *   every request goes over plain http to the row's upstream with `Host` of the preview — its
 *   entry forwarder answers 421 to any other (R5a).
 *
 * An upstream on any other host than PREVIEW_UPSTREAM_HOST, a secret for another address and a
 * stack without published content are all refused the same way. A copy is used for `ttlMs` and
 * never across another upstream or another write epoch: a rebuild issues a new password.
 */
export function createPreviewContentResolver({
  secrets,
  adapters,
  address,
  upstreamHost,
  gateway: build = previewContentGateway,
  ttlMs = 60_000,
  maxEntries = 256,
  now = Date.now,
  onRefusal,
}: PreviewContentResolverOptions): PreviewGatewayResolver {
  const cache = new Map<string, Entry>()
  const refused = (reason: PreviewAccessRefusal) => {
    onRefusal?.(reason)
    return refusal(reason)
  }

  return async (target) => {
    if (!address) throw refused('address')
    const { host, port } = target.upstream
    if (host !== upstreamHost || !Number.isInteger(port) || port < 1 || port > 65_535)
      throw refused('upstream')
    let adapter: SiteContentAdapter
    try {
      adapter = adapters(target.stack)
    } catch {
      throw refused('stack')
    }
    let path: string
    let origin: string
    try {
      path = previewAccessPath(target.previewId, adapter.accessKind)
      origin = previewOrigin(target.hostname, address)
    } catch {
      throw refused('address')
    }
    const key = JSON.stringify([target.stack, target.hostname, host, port, target.writeEpoch])
    const cached = cache.get(target.previewId)
    if (cached && cached.key === key && cached.expires > now()) return cached.gateway
    cache.delete(target.previewId)

    let stored: Awaited<ReturnType<typeof secrets.kvRead>>
    try {
      stored = await secrets.kvRead(path)
    } catch {
      throw refused('vault')
    }
    if (!stored) throw refused('secret')
    const access = adapter.accessSchema.safeParse(stored.data)
    if (!access.success) throw refused('format')
    // A password issued for one preview is never sent to another.
    if (URL.parse(access.data.origin)?.origin !== origin) throw refused('origin')

    let gateway: PublishedContentGateway
    try {
      gateway = build({
        adapter,
        previewId: target.previewId,
        origin,
        access: stored.data,
        target: { upstream: { host, port }, hostname: target.hostname },
      })
    } catch {
      throw refused('adapter')
    }
    while (cache.size >= maxEntries) {
      const oldest = cache.keys().next()
      if (oldest.done) break
      cache.delete(oldest.value)
    }
    cache.set(target.previewId, { key, gateway, expires: now() + ttlMs })
    return gateway
  }
}
