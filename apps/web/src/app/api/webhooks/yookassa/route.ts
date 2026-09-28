import { isProduction } from '@repo/domain'

import { env } from '@/env'
import { handleYookassaWebhook } from '@/server/yookassa-webhook'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** HTTP notifications from ЮKassa. */
export function POST(request: Request): Promise<Response> {
  return handleYookassaWebhook(request, {
    requireAllowlist: isProduction(env.web().appEnv),
    onEvent: (event) => {
      // TODO(M5): process the event. A notification is a hint, not proof: read the payment or
      // refund back through the API (getPayment/getRefund) and credit only by that answer,
      // idempotently per object id.
      console.info(`[yookassa] notification ${event.event} for ${event.object.id}`)
    },
  })
}
