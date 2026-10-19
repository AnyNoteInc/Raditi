import { z } from 'zod'

import { badRequest } from '../errors.ts'
import { siteAccessKinds, type SiteAccessKind } from '../ports/site-adapter.ts'
import { isPreviewPath, previewGatewayPaths, previewTicketSchema } from './hostname.ts'

/**
 * Secrets of one preview in Vault (docs/plan/53-chat-preview-release.md, Р21, Р24): `core`
 * writes them while it builds the preview and starts its browser, the mcp role reads them. They
 * live apart from `kv/sites/<siteId>/`: a preview's password opens its copy, never the site.
 */

const PREVIEW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The one Vault path of an access of a preview: `kv/previews/<previewId>/<kind>` — the content
 * access of the stack's adapter (WordPress: `wp`, the application password the build created)
 * or `browser` (`previewBrowserSecretSchema`).
 */
export function previewAccessPath(previewId: string, kind: SiteAccessKind): string {
  if (!PREVIEW_ID.test(previewId) || !siteAccessKinds.includes(kind))
    throw badRequest('Invalid preview access reference')
  return `kv/previews/${previewId}/${kind}`
}

/** Where the browser of a preview is reached: its control socket on the host's loopback. */
export const previewBrowserSecretPath = (previewId: string): string =>
  previewAccessPath(previewId, 'browser')

/**
 * `kv/previews/<previewId>/browser`, written by `core` for one row of
 * `preview_browser_requests` before it sets `ready_at`: the control socket of the browser
 * (`PreviewRuntime.startBrowser` answers `wsEndpoint` + `wsPath` as one URL), and a one-time
 * entry link with a fresh browser ticket for the context this request opens. Strings only (KV).
 */
export const previewBrowserSecretSchema = z.strictObject({
  v: z.literal('1'),
  /** `preview_browser_requests.id`: the request this ticket was issued for. */
  requestId: z.uuid(),
  /** `ws://127.0.0.1:<port>`: the relay publishes the control port on loopback only. */
  wsEndpoint: z.string().regex(/^ws:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/),
  /** The secret path of the browser server. */
  wsPath: z.string().regex(/^\/[A-Za-z0-9_-]{43,128}$/),
  /** `previewEnterUrl(origin, ticket, to)`: the gateway's way in for the browser's own session. */
  enterUrl: z
    .string()
    .max(4096)
    .refine((value) => {
      const url = URL.parse(value)
      if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return false
      if (url.pathname !== previewGatewayPaths.enter || url.username || url.password) return false
      const keys = [...url.searchParams.keys()].sort()
      return (
        keys.length === 2 &&
        keys[0] === 't' &&
        keys[1] === 'to' &&
        previewTicketSchema.safeParse(url.searchParams.get('t')).success &&
        isPreviewPath(url.searchParams.get('to') ?? '')
      )
    }, 'expected the entry link of a preview'),
})
export type PreviewBrowserSecret = z.infer<typeof previewBrowserSecretSchema>

/** The control socket of the browser as `PreviewRuntime.startBrowser` answers it. */
export const previewBrowserSocket = (secret: PreviewBrowserSecret): string =>
  `${secret.wsEndpoint}${secret.wsPath}`
