import { browserStreamQuerySchema, browserWorkerPaths } from '@repo/domain'
import { z } from 'zod'

// Where the browser worker listens (docs/plan/57-browser-tasks.md, Б10, §3.5): an internal origin
// such as `http://127.0.0.1:8086`, never a public address. Errors here name what is wrong with the
// setting, never the setting itself: the address of an internal service stays out of logs.

/** The worker's origin without a trailing slash, from a setting of the app that calls it. */
export function browserWorkerOrigin(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error('The browser worker address is not a URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('The browser worker address must be http or https')
  if (url.username !== '' || url.password !== '')
    throw new Error('The browser worker address must not carry credentials')
  // A path, a query or a fragment would be silently dropped or joined into every request.
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '')
    throw new Error('The browser worker address must be an origin without a path')
  return url.origin
}

/** Who watches through one stream connection: the session, the tab of the cabinet, its user. */
export interface BrowserStreamTarget {
  sessionId: string
  viewerId: string
  userId: string
}

/**
 * The internal WebSocket address of a session's stream (`WS /v1/sessions/:id/stream`) the gateway
 * opens for one viewer: `ws://` for an `http://` worker, `wss://` for an `https://` one. The ids
 * are checked as UUIDs, so nothing else ever reaches the path or the query.
 */
export function browserStreamUrl(baseUrl: string, target: BrowserStreamTarget): string {
  const origin = new URL(browserWorkerOrigin(baseUrl))
  if (!z.uuid().safeParse(target.sessionId).success)
    throw new Error('The browser session id is not a UUID')
  const query = browserStreamQuerySchema.safeParse({ viewer: target.viewerId, user: target.userId })
  if (!query.success) throw new Error('The viewer and user of a browser stream must be UUIDs')
  const url = new URL(browserWorkerPaths.stream(target.sessionId), origin)
  url.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:'
  url.search = new URLSearchParams(query.data).toString()
  return url.href
}
