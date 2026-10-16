import { isIP } from 'node:net'

import { clientIp } from '@repo/auth'
import { isProduction, type AppEnv } from '@repo/domain'
import { errorMessage } from '@repo/observability'
import {
  parseWebhookEvent,
  verifyTrustedIp,
  YOOKASSA_WEBHOOK_IP_RANGES,
  type WebhookEvent,
  type YookassaConfig,
} from '@repo/yookassa'

import { readBodyWithin } from './body-limit'

export interface YookassaWebhookOptions {
  /** Production: an empty allowlist denies everything instead of allowing everything. */
  requireAllowlist: boolean
  /** Senders to accept instead of the published ЮKassa ranges. */
  allowlist?: readonly string[]
  /**
   * Called with every accepted notification. When it throws, the route answers 500 and ЮKassa
   * sends the notification again.
   */
  onEvent?: (event: WebhookEvent) => void | Promise<void>
  /** Where the failure of `onEvent` is reported, one line; console.error unless given. */
  logError?: (line: string) => void
}

/**
 * Whom the route takes notifications from. Production trusts the published ЮKassa ranges and
 * nothing else. Outside it YOOKASSA_WEBHOOK_ALLOWLIST replaces them, so that a local fake can
 * send from loopback; the settings refuse that variable in production, and so does this.
 */
export function webhookSenders(
  appEnv: AppEnv,
  yookassa: Pick<YookassaConfig, 'webhookAllowlist'> | null,
): Pick<YookassaWebhookOptions, 'requireAllowlist' | 'allowlist'> {
  const production = isProduction(appEnv)
  return {
    requireAllowlist: production,
    allowlist: production ? undefined : yookassa?.webhookAllowlist,
  }
}

// A notification body is a few kilobytes; anything far larger is not from ЮKassa.
export const MAX_BODY_BYTES = 64 * 1024

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

/**
 * The object of a notification as a log line names it. The id comes from the request body, so
 * only what an id is made of gets through, and no more than an id is long.
 */
const loggedId = (id: string) => id.slice(0, 64).replace(/[^\w.-]/g, '?')

export interface YookassaEventOptions {
  /**
   * Settles the order that holds the payment: reads the payment back through the API and acts
   * on that answer (`settleOrderByPaymentId` of @repo/billing). null — payments are off: no
   * shop is configured, so there is nothing to read back.
   */
  settlePayment: ((paymentId: string) => Promise<{ state: string }>) | null
  /**
   * Stores a bound payment method on the subscription that waits for it: reads the method
   * back through the API and acts on that answer (`settlePaymentMethod` of @repo/billing).
   * null exactly when `settlePayment` is: without a shop there is nothing to read back.
   */
  settlePaymentMethod: ((paymentMethodId: string) => Promise<{ state: string }>) | null
  /**
   * Applies a refund to the order whose payment it returns: reads the refund back through the
   * API and acts on that answer (`settleRefund` of @repo/billing). null exactly when
   * `settlePayment` is.
   */
  settleRefund: ((refundId: string) => Promise<{ state: string }>) | null
  /** One line per notification; console.info unless given. */
  log?: (line: string) => void
}

/**
 * What the route does with an accepted notification. A notification is a hint, never proof:
 * of a `payment.succeeded` or `payment.canceled` only the payment id is used, to find the
 * order whose payment is then read back, of a `payment_method.active` only the id of the
 * method, which is read back for the subscription that waits for it, and of a
 * `refund.succeeded` only the id of the refund, which is read back for the order whose payment
 * it returns. `payment.waiting_for_capture` passes by itself (payments are created with
 * capture): it is accepted and logged. The lines name the event and the object, never the body.
 */
export function yookassaEventHandler({
  settlePayment,
  settlePaymentMethod,
  settleRefund,
  log = (line) => console.info(line),
}: YookassaEventOptions): (event: WebhookEvent) => Promise<void> {
  let reportedOff = false
  return async (event) => {
    if (settlePayment === null || settlePaymentMethod === null || settleRefund === null) {
      // Accepted all the same: a refusal would make ЮKassa repeat it for a day.
      if (!reportedOff) {
        reportedOff = true
        log('[yookassa] payments are not configured: notifications are accepted and ignored')
      }
      return
    }
    const what = `${event.event} for ${loggedId(event.object.id)}`
    if (event.event === 'payment.succeeded' || event.event === 'payment.canceled') {
      const { state } = await settlePayment(event.object.id)
      log(`[yookassa] ${what}: order ${state}`)
      return
    }
    if (event.event === 'payment_method.active') {
      const { state } = await settlePaymentMethod(event.object.id)
      log(`[yookassa] ${what}: payment method ${state}`)
      return
    }
    if (event.event === 'refund.succeeded') {
      const { state } = await settleRefund(event.object.id)
      log(`[yookassa] ${what}: refund ${state}`)
      return
    }
    log(`[yookassa] ${what}: accepted, not processed`)
  }
}

/**
 * Checks the sender and the body, then hands the notification over: 403 for a foreign address,
 * 400 for a broken notification, 500 when it could not be processed, 200 once it was.
 */
export async function handleYookassaWebhook(
  request: Request,
  options: YookassaWebhookOptions,
): Promise<Response> {
  const allowlist = options.allowlist ?? YOOKASSA_WEBHOOK_IP_RANGES
  const ip = webhookSenderIp(request.headers)
  if (!verifyTrustedIp(ip, allowlist, { requireAllowlist: options.requireAllowlist })) {
    return json({ error: 'forbidden' }, 403)
  }

  const body = await readBodyWithin(request, MAX_BODY_BYTES)
  if (body === null) return json({ error: 'invalid notification' }, 400)

  let event: WebhookEvent
  try {
    event = parseWebhookEvent(JSON.parse(new TextDecoder().decode(body)))
  } catch {
    return json({ error: 'invalid notification' }, 400)
  }

  try {
    await options.onEvent?.(event)
  } catch (error) {
    // Anything but 200 makes ЮKassa send the notification again, for 24 hours: a payment whose
    // settlement failed now is settled by a repeat.
    const logError = options.logError ?? ((line: string) => console.error(line))
    logError(
      `[yookassa] ${event.event} for ${loggedId(event.object.id)} failed: ${errorMessage(error)}`,
    )
    return json({ error: 'not processed' }, 500)
  }
  return json({ ok: true }, 200)
}
