import type { PrismaClient } from '@repo/db'
import type { AppEnv } from '@repo/domain'
import type { YookassaClient } from '@repo/yookassa'

/**
 * What checkout and settlement work with. The caller builds it once from its configuration;
 * a test passes a client that answers from a script and a fixed clock.
 */
export interface BillingDeps {
  /** The process-wide client: the functions open their own transactions. */
  prisma: PrismaClient
  /** The shop. Only the calls a customer's payment needs. */
  yookassa: Pick<YookassaClient, 'createPayment' | 'getPayment'>
  /** Public origin of the app (APP_URL), no trailing slash: the customer returns to it. */
  appUrl: string
  /** APP_ENV: it decides the data class of the personal workspace, as in project.create. */
  appEnv: AppEnv
  /**
   * YOOKASSA_AUTOPAYMENTS: the shop may save a payment method and charge it. false — one-time
   * payments only: no payment asks to save its method, no method is bound, and auto-renewal is
   * not switched on (BILLING_AUTO_RENEWAL_UNAVAILABLE). A method saved before stays and is still
   * charged: the renewal passes do not read the switch.
   */
  autopayments: boolean
  /** The clock; the system one unless given. */
  now?: () => Date
}
