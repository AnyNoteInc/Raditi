import 'server-only'

import { TRPCError } from '@trpc/server'

import { readBodyWithin } from './body-limit'
import { refusedCrossOriginPost } from './trpc-origin'

// The browser replaced its Web Push subscription (docs/plan/82-scheduled-tasks.md, Зп41): the
// service worker's `pushsubscriptionchange` posts the old endpoint and the new subscription here,
// with the cookie of the session — it runs on the origin of the cabinet. The procedure
// `notification.replaceSubscription` checks the session, the consents and the subscription itself,
// and moves only a row of the signed-in user (Зп37): the session may be of another account.

/** A subscription is a few hundred bytes. */
export const MAX_RESUBSCRIBE_BODY_BYTES = 4 * 1024

export interface ResubscribeRoute {
  /** APP_URL: a post from another origin is refused. */
  appUrl: () => string
  /** `notification.replaceSubscription` with the session of the request. */
  resubscribe: (headers: Headers, body: unknown) => Promise<unknown>
}

const json = (status: number) =>
  Response.json({ ok: status === 200 }, { status, headers: { 'cache-control': 'no-store' } })

/** The HTTP status of a refusal of the procedure; anything else is a failure to try again. */
const STATUS: Partial<Record<TRPCError['code'], number>> = {
  UNAUTHORIZED: 401,
  PRECONDITION_REQUIRED: 428,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
}

export async function handleResubscribe(
  request: Request,
  route: ResubscribeRoute,
): Promise<Response> {
  if (refusedCrossOriginPost(request, route.appUrl())) return json(403)
  let body: Buffer | null
  try {
    body = await readBodyWithin(request, MAX_RESUBSCRIBE_BODY_BYTES)
  } catch {
    return json(400)
  }
  if (body === null) return json(413)
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return json(400)
  }
  try {
    await route.resubscribe(request.headers, parsed)
    return json(200)
  } catch (error) {
    if (error instanceof TRPCError) return json(STATUS[error.code] ?? 503)
    return json(503)
  }
}
