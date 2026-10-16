import { settleOrderByPaymentId, settlePaymentMethod, settleRefund } from '@repo/billing'
import { prisma } from '@repo/db'
import type { WebhookEvent } from '@repo/yookassa'

import { env } from '@/env'
import { paymentShop } from '@/server/payment-shop'
import {
  handleYookassaWebhook,
  webhookSenders,
  yookassaEventHandler,
} from '@/server/yookassa-webhook'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

let onEvent: ((event: WebhookEvent) => Promise<void>) | undefined

/** Built on the first notification: the environment is not read when the module is imported. */
function eventHandler(): (event: WebhookEvent) => Promise<void> {
  if (onEvent === undefined) {
    // The shop the tRPC context pays through: one client for the process.
    const shop = paymentShop()
    const deps = shop && { prisma, ...shop }
    onEvent = yookassaEventHandler({
      settlePayment: deps && ((paymentId) => settleOrderByPaymentId(deps, { paymentId })),
      settlePaymentMethod:
        deps && ((paymentMethodId) => settlePaymentMethod(deps, { paymentMethodId })),
      settleRefund: deps && ((refundId) => settleRefund(deps, { refundId })),
    })
  }
  return onEvent
}

/** HTTP notifications from ЮKassa. */
export function POST(request: Request): Promise<Response> {
  return handleYookassaWebhook(request, {
    ...webhookSenders(env.web().appEnv, env.yookassa()),
    onEvent: eventHandler(),
  })
}
