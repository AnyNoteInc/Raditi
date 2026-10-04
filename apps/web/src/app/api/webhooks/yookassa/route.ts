import { env } from '@/env'
import { handleYookassaWebhook, webhookSenders } from '@/server/yookassa-webhook'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** HTTP notifications from ЮKassa. */
export function POST(request: Request): Promise<Response> {
  return handleYookassaWebhook(request, {
    ...webhookSenders(env.web().appEnv, env.yookassa()),
    onEvent: (event) => {
      // TODO(M5): process the event. A notification is a hint, not proof: read the payment,
      // refund or payment method back through the API (getPayment, getRefund,
      // getPaymentMethod) and act only on that answer, idempotently per object id.
      console.info(`[yookassa] notification ${event.event} for ${event.object.id}`)
    },
  })
}
