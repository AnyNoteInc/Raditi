import 'server-only'

import type { BillingContext } from '@repo/trpc'
import { createYookassaClient } from '@repo/yookassa'

import { env } from '@/env'

let shop: { value: BillingContext | null } | undefined

/**
 * The ЮKassa shop of this process with the public origin and the environment of the app: what
 * the tRPC context pays through and the notification route settles through. null — payments
 * are off: both shop credentials are empty.
 *
 * Built on first use, so the environment is not read when the module is imported, and kept:
 * one client for the life of the process. A broken section of the environment throws here and
 * is read again next time. The origin and the environment of the app, and the grace of an
 * overdue tariff, are read only for a shop that is set up: every tRPC context asks for the shop, and with payments off a broken `web`
 * section must not fail the pages that never use it.
 */
export function paymentShop(): BillingContext | null {
  if (shop === undefined) {
    const config = env.yookassa()
    if (config === null) {
      shop = { value: null }
    } else {
      const { appEnv, appUrl, pastDueDays } = env.web()
      shop = {
        value: {
          yookassa: createYookassaClient(config),
          appUrl,
          appEnv,
          // YOOKASSA_AUTOPAYMENTS: off, the pages offer no auto-renewal and nothing asks the
          // shop to save a payment method.
          autopayments: config.autopayments,
          pastDueDays,
        },
      }
    }
  }
  return shop.value
}
