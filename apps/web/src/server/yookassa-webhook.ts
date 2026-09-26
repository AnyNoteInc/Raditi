import { isIP } from 'node:net'

import { clientIp } from '@repo/auth'
import {
  parseWebhookEvent,
  verifyTrustedIp,
  YOOKASSA_WEBHOOK_IP_RANGES,
  type WebhookEvent,
} from '@repo/yookassa'

export interface YookassaWebhookOptions {
  /** Production: an empty allowlist denies everything instead of allowing everything. */
  requireAllowlist: boolean
  allowlist?: readonly string[]
  /** Called with every accepted notification. */
  onEvent?: (event: WebhookEvent) => void | Promise<void>
}

// A notification body is a few kilobytes; anything far larger is not from ЮKassa.
const MAX_BODY_BYTES = 64 * 1024

/**
 * The sender address. The reverse proxy in front of web overwrites X-Forwarded-For with the one
 * address it sees; a list means a client-sent value got through with hops appended, and its
 * first entry is whatever the client wrote, so a list is refused instead of trusted.
 */
export function webhookSenderIp(headers: Headers): string | null {
  const value = headers.get('x-forwarded-for')?.trim()
  // clientIp falls back to 127.0.0.1 in development; checked first so that never happens here.
  if (!value || value.includes(',') || isIP(value) === 0) return null
  return clientIp(headers)
}

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

/** Checks the sender and the body; 403 for a foreign address, 400 for a broken notification. */
export async function handleYookassaWebhook(
  request: Request,
  options: YookassaWebhookOptions,
): Promise<Response> {
  const allowlist = options.allowlist ?? YOOKASSA_WEBHOOK_IP_RANGES
  const ip = webhookSenderIp(request.headers)
  if (!verifyTrustedIp(ip, allowlist, { requireAllowlist: options.requireAllowlist })) {
    return json({ error: 'forbidden' }, 403)
  }

  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return json({ error: 'invalid notification' }, 400)

  let event: WebhookEvent
  try {
    event = parseWebhookEvent(JSON.parse(text))
  } catch {
    return json({ error: 'invalid notification' }, 400)
  }

  await options.onEvent?.(event)
  return json({ ok: true }, 200)
}
