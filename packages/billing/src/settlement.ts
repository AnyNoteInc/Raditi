import type { Order, PrismaClient } from '@repo/db'
import {
  billingOrderNotFound,
  billingPeriod,
  conflict,
  isDomainError,
  liveSubscriptionStatuses,
  Money,
  nextBillingPeriod,
  nextSubscriptionStatus,
  notImplemented,
  orderTransitionForPayment,
  paymentMethodLabel,
  type BillingPeriod,
  type OrderStatus,
  type SubscriptionStatus,
} from '@repo/domain'
import { enqueueNotification, notificationCatalog } from '@repo/notifications'
import {
  YookassaApiError,
  type Payment,
  type PaymentMethod,
  type YookassaClient,
} from '@repo/yookassa'
import { z } from 'zod'

import type { BillingTx } from './accounts.ts'
import { writeBillingAudit, type BillingAuditEntry } from './audit.ts'
import type { BillingDeps } from './deps.ts'
import { orderFailureReasons } from './failure-text.ts'
import { expireTariffRemainder, grantPackCredits, grantTariffCredits } from './ledger.ts'
import { getCreditBalances } from './read-models.ts'
import { isRenewalOrder, renewedPeriodEnd } from './renewal-order.ts'

// Settlement: what a payment did to its order. A notification and the customer's return are
// only reasons to look: the payment is read back through the API and that answer alone moves
// the order. Whatever arrives first, twice or never — the webhook, the return page, a retry —
// the order leaves `pending` once, under a conditional update, and the quota is granted in
// that transaction.

/** audit_log actions of checkout and settlement. */
export const settlementAuditActions = {
  /** A first payment switched the tariff on. */
  subscriptionStart: 'billing.subscription.start',
  /** The customer agreed to auto-renewal when paying: who, when, which plan and amount. */
  autoRenewalConsent: 'billing.auto_renewal.consent',
  /** A paid pack was granted to the account of purchased credits. */
  packPurchase: 'billing.pack.purchase',
  /** The customer paid by hand for a tariff that was past due: it is active again. */
  pastDuePayment: 'billing.subscription.reactivate',
  /** Money arrived that was not applied: an operator has to return it. One per order. */
  refundNeeded: 'billing.order.refund_needed',
  /**
   * A payment whose id its order had never stored — the answer to the request that made it was
   * lost — was read back and attached to the order. One per order.
   */
  paymentAttached: 'billing.order.payment_attached',
} as const

/** Why the money of an order has to go back: `meta.reason` of the refund entry. */
export const refundReasons = {
  /** The payment is not the order's: another amount, currency or `metadata.order_id`. */
  amountMismatch: 'amount_mismatch',
  /** A part of the payment had gone back before the order was settled: the rest follows it. */
  partlyRefunded: 'partly_refunded',
  /** The workspace already had a live subscription when the order was paid. */
  liveSubscription: 'live_subscription',
  /** The payment succeeded after the order was closed as failed or cancelled. */
  orderClosed: 'order_closed',
  /** A renewal was paid for a subscription that no longer waited for it. */
  staleRenewal: 'stale_renewal',
  /** A payment by hand came for a tariff that was no longer past due: ended, or paid already. */
  notPastDue: 'subscription_not_past_due',
} as const
type RefundReason = (typeof refundReasons)[keyof typeof refundReasons]

/** What applying a payment works with: the database, the clock and the address in letters. */
export type ApplyDeps = Pick<BillingDeps, 'prisma' | 'appUrl' | 'now'>

/**
 * What settlement works with. It reads a payment back and applies it; it creates neither a
 * payment nor a workspace, so the scheduler of the core role can call it as well as a checkout.
 */
export type SettlementDeps = ApplyDeps & { yookassa: Pick<YookassaClient, 'getPayment'> }

/** Where an order stands after its payment was read back. */
export type OrderSettlement =
  | {
      /** No order has this payment and none is named by it: it is not ours. */
      state: 'unknown'
    }
  | SettledOrder

export interface SettledOrder {
  /** The status of the order now. */
  state: OrderStatus
  orderId: string
  /**
   * The payment succeeded and nothing was applied for it; an audit entry asks an operator
   * to return the money. The order is `failed` or `cancelled`, or `paid` without a
   * subscription of its own.
   */
  refundNeeded: boolean
}

/** The key of the «payment succeeded» letter in the outbox: one letter per order. */
export const paymentLetterKey = (orderId: string) => `billing.payment_succeeded:${orderId}`

const SYSTEM_ACTOR = { type: 'system', id: 'billing' } as const

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text)

const settleOrderInputSchema = z.strictObject({ orderId: z.uuid() })
const settleByPaymentInputSchema = z.strictObject({ paymentId: z.string().min(1) })

/**
 * Reads the payment of the order back and applies its outcome; safe to call any number of
 * times and at once. `pending` — the payment has no outcome yet. An order without a payment
 * and a settled one (`paid`, `refunded`) are returned as they are, without asking ЮKassa.
 * Throws BILLING_ORDER_NOT_FOUND for an unknown order and whatever the API call threw: the
 * caller decides whether to ask again.
 */
export async function settleOrder(
  deps: SettlementDeps,
  input: { orderId: string },
): Promise<SettledOrder> {
  const { orderId } = settleOrderInputSchema.parse(input)
  const order = await deps.prisma.order.findUnique({ where: { id: orderId } })
  if (order === null) throw billingOrderNotFound()
  return (await settleOrderRow(deps, order)).settlement
}

/**
 * `settleOrder` for the order that holds this ЮKassa payment: what a notification leads to.
 * The id is all a notification is trusted with. A payment no order holds is read back, and
 * when it is the payment of an order that never stored it, it is attached to that order first
 * (`settleUnattachedPayment`). `unknown` when the payment is none of ours, which is not an
 * error.
 */
export async function settleOrderByPaymentId(
  deps: SettlementDeps,
  input: { paymentId: string },
): Promise<OrderSettlement> {
  const { paymentId } = settleByPaymentInputSchema.parse(input)
  // orders.yookassa_payment_id is varchar(64): a longer id is not a payment of ours.
  if (paymentId.length > 64) return { state: 'unknown' }
  const order = await deps.prisma.order.findUnique({ where: { yookassaPaymentId: paymentId } })
  if (order === null) return settleUnattachedPayment(deps, paymentId)
  return (await settleOrderRow(deps, order)).settlement
}

/**
 * A payment no order holds. The request that made it may have been served while its answer
 * never reached us — a renewal charge that timed out, a checkout whose process died —, so the
 * order never stored the id and a notification of the payment would pass it by. The payment is
 * read back, and when it is recognisably the payment of an order that holds none, its id is
 * attached to that order, once, and the order is settled by the usual path: a pending order is
 * applied or failed as if the id had been stored in time, and one that was closed meanwhile —
 * a charge given up as `unknown_result`, an abandoned checkout — gets its `refund_needed` entry
 * when the money came.
 *
 * What makes the payment the order's. It is answered by `GET /payments/{id}` under the shop's
 * credentials, so it is a payment of this shop. Its `metadata.order_id` names the order: a
 * payer cannot set metadata, only a request with the shop's key can, and the platform writes
 * it in `requestPayment` and `chargeOrder`. Its amount is the order's, in RUB, and
 * `metadata.workspace_id`, when the payment carries it, is the order's workspace. An order that
 * already holds a payment is never given another; an order has one Idempotence-Key, so within
 * the day ЮKassa keeps it there is one payment of it at most.
 *
 * `unknown` when the shop does not know the payment or it is no such payment. Whatever else
 * the read-back threw is thrown on: the notification is then repeated.
 */
async function settleUnattachedPayment(
  deps: SettlementDeps,
  paymentId: string,
): Promise<OrderSettlement> {
  const { prisma, yookassa } = deps
  let payment: Payment
  try {
    payment = await yookassa.getPayment(paymentId)
  } catch (error) {
    if (error instanceof YookassaApiError && error.status === 404) return { state: 'unknown' }
    throw error
  }
  const named = z.uuid().safeParse(payment.metadata?.order_id)
  if (payment.id !== paymentId || !named.success) return { state: 'unknown' }
  const order = await prisma.order.findUnique({ where: { id: named.data } })
  if (order === null) return { state: 'unknown' }
  // The answer of the request that made the payment landed while the shop was being asked
  // here: the order holds this very payment now, and is settled as any order that does.
  if (order.yookassaPaymentId === payment.id) return (await settleOrderRow(deps, order)).settlement
  if (order.yookassaPaymentId !== null) return { state: 'unknown' }
  const workspaceId = payment.metadata?.workspace_id
  if (
    payment.amount.currency !== 'RUB' ||
    !new Money(payment.amount.value).equals(order.amount) ||
    (workspaceId !== undefined && workspaceId !== order.workspaceId)
  ) {
    return { state: 'unknown' }
  }
  await prisma.$transaction(
    async (tx) => {
      // The status is not the one read above: whoever closes the order at this moment — a
      // charge given up, an abandoned checkout — does it by its own `yookassaPaymentId: null`
      // condition, and whichever of the two loses, the payment stays attached.
      const attached = await tx.order.updateMany({
        where: {
          id: order.id,
          yookassaPaymentId: null,
          status: { in: ['pending', 'failed', 'cancelled'] },
        },
        data: { yookassaPaymentId: payment.id },
      })
      if (attached.count === 0) return
      await writeBillingAudit(tx, {
        actor: SYSTEM_ACTOR,
        workspaceId: order.workspaceId,
        action: settlementAuditActions.paymentAttached,
        target: { type: 'order', id: order.id },
        meta: {
          paymentId: payment.id,
          paymentStatus: payment.status,
          amount: payment.amount.value,
        },
      })
    },
    { isolationLevel: 'ReadCommitted' },
  )
  // Whoever stored it: this call, one that raced it, or the request whose answer came just now.
  const holder = await prisma.order.findUnique({ where: { yookassaPaymentId: payment.id } })
  if (holder === null) return { state: 'unknown' }
  return (await settleOrderRow(deps, holder)).settlement
}

/**
 * Settlement of an order row the caller has already read. `payment` is what ЮKassa answered
 * to this call, null when it was not asked.
 */
export async function settleOrderRow(
  deps: SettlementDeps,
  order: Order,
): Promise<{ settlement: SettledOrder; payment: Payment | null }> {
  const { prisma, yookassa } = deps
  const paymentId = order.yookassaPaymentId
  if (order.status === 'paid' || order.status === 'refunded' || paymentId === null) {
    return { settlement: await storedSettlement(prisma, order), payment: null }
  }

  if (order.status !== 'pending') {
    // Closed without the money. The only news left is that the money came after all: a
    // payment page stays open after we cancel the order. Once that is recorded, nothing is.
    if (await refundFlagged(prisma, order.id)) {
      return { settlement: settled(order, true), payment: null }
    }
    const payment = await yookassa.getPayment(paymentId)
    const late = paidWhileClosed(order.status, payment)
    if (late) await flagLatePayment(prisma, order, payment)
    return { settlement: settled(order, late), payment }
  }

  const payment = await yookassa.getPayment(paymentId)
  return { settlement: await applyPayment(deps, order, payment), payment }
}

/**
 * Applies what ЮKassa answered about the payment of a pending order and reports where the
 * order stands. The answer is a read-back, or the answer to the charge itself: a renewal is
 * settled from the payment its request returned, without asking again.
 */
export async function applyPayment(
  deps: ApplyDeps,
  order: Order,
  payment: Payment,
): Promise<SettledOrder> {
  const { prisma } = deps
  const renewal = isRenewalOrder(order)
  const next = orderTransitionForPayment(order.status, payment.status)
  if (next === 'failed') {
    if (renewal) await failRenewal(deps, order, declinedRenewal(payment))
    else await closeUnpaid(prisma, order, payment)
  } else if (next === 'paid') {
    const refused = refusal(order, payment)
    if (refused === null) await applySucceededPayment(deps, order, payment)
    else if (renewal) await failRenewal(deps, order, refusedRenewal(order, payment, refused))
    else await refusePayment(prisma, order, payment, refused)
  }
  // Whoever moved the order, this call or one that raced it: report where it stands now.
  const current = await prisma.order.findUniqueOrThrow({
    where: { id: order.id },
    select: { id: true, status: true },
  })
  const settlement = await storedSettlement(prisma, current)
  // Another request closed the order while the shop was being asked, and the money came all
  // the same. ЮKassa does not repeat a notification that was answered: this call records it.
  if (!settlement.refundNeeded && paidWhileClosed(current.status, payment)) {
    await flagLatePayment(prisma, { ...order, status: current.status }, payment)
    return settled(current, true)
  }
  return settlement
}

/** What a succeeded payment of the order pays for: every kind of order has its own function. */
function applySucceededPayment(deps: ApplyDeps, order: Order, payment: Payment): Promise<void> {
  if (isRenewalOrder(order)) return applyRenewalPayment(deps, order, payment)
  if (order.kind === 'pack') return applyPackPayment(deps, order, payment)
  // A subscription order of a subscription that is not its renewal: the customer's own
  // payment for a tariff that was past due.
  if (order.kind === 'subscription' && order.subscriptionId !== null) {
    return applyPastDuePayment(deps, order, payment)
  }
  return applyFirstPayment(deps, order, payment)
}

const settled = (order: Pick<Order, 'id' | 'status'>, refundNeeded: boolean): SettledOrder => ({
  state: order.status,
  orderId: order.id,
  refundNeeded,
})

/** The settlement the database already holds, without asking ЮKassa. */
export async function storedSettlement(
  db: Pick<PrismaClient, 'auditLog'>,
  order: Pick<Order, 'id' | 'status'>,
): Promise<SettledOrder> {
  const mayOweRefund =
    order.status === 'paid' || order.status === 'failed' || order.status === 'cancelled'
  return settled(order, mayOweRefund && (await refundFlagged(db, order.id)))
}

async function refundFlagged(db: Pick<BillingTx, 'auditLog'>, orderId: string): Promise<boolean> {
  const entry = await db.auditLog.findFirst({
    where: { action: settlementAuditActions.refundNeeded, targetType: 'order', targetId: orderId },
    select: { id: true },
  })
  return entry !== null
}

/** True when the money arrived for an order that was closed without it. */
function contradictsOrder(status: OrderStatus, payment: Payment): boolean {
  try {
    orderTransitionForPayment(status, payment.status)
    return false
  } catch (error) {
    if (isDomainError(error) && error.code === 'CONFLICT') return true
    throw error
  }
}

/**
 * What we still hold of the payment: its amount without what has gone back. ЮKassa keeps a
 * payment `succeeded` after a refund, so `refunded_amount` alone tells that the money left.
 */
function unreturned(payment: Payment) {
  return new Money(payment.amount.value).minus(payment.refunded_amount?.value ?? 0)
}

/** True when money that has not gone back arrived for an order that was closed without it. */
function paidWhileClosed(status: OrderStatus, payment: Payment): boolean {
  const closed = status === 'failed' || status === 'cancelled'
  return closed && contradictsOrder(status, payment) && unreturned(payment).greaterThan(0)
}

/** The payment is the one the order asked for: its id, amount, currency and order. */
function paymentIsOrders(order: Order, payment: Payment): boolean {
  const metadataOrderId = payment.metadata?.order_id
  return (
    payment.id === order.yookassaPaymentId &&
    payment.amount.currency === 'RUB' &&
    new Money(payment.amount.value).equals(order.amount) &&
    (metadataOrderId === undefined || metadataOrderId === order.id)
  )
}

/** Why a succeeded payment is not applied: how its order fails and what an operator is told. */
interface Refusal {
  failureReason: string
  /** null when no money is left to return. */
  refund: RefundReason | null
}

/**
 * null when the succeeded payment pays the order: it is the order's and all of its money is
 * still with us. A payment returned in the ЮKassa cabinet before anybody settled the order
 * must not switch a tariff on, whether all of it went back or a part.
 */
function refusal(order: Order, payment: Payment): Refusal | null {
  if (!paymentIsOrders(order, payment)) {
    return {
      failureReason: orderFailureReasons.amountMismatch,
      refund: refundReasons.amountMismatch,
    }
  }
  const left = unreturned(payment)
  if (left.equals(order.amount)) return null
  return left.greaterThan(0)
    ? { failureReason: orderFailureReasons.amountMismatch, refund: refundReasons.partlyRefunded }
    : { failureReason: orderFailureReasons.paymentRefunded, refund: null }
}

function refundEntry(
  order: Order,
  payment: Payment,
  reason: RefundReason,
  orderStatus: OrderStatus,
): BillingAuditEntry {
  return {
    actor: SYSTEM_ACTOR,
    workspaceId: order.workspaceId,
    action: settlementAuditActions.refundNeeded,
    target: { type: 'order', id: order.id },
    meta: {
      reason,
      orderStatus,
      paymentId: clip(payment.id, 64),
      orderAmount: order.amount.toFixed(2),
      paidAmount: payment.amount.value,
      paidCurrency: payment.amount.currency,
      // What has already gone back: the operator returns the rest, not the whole amount.
      refundedAmount: payment.refunded_amount?.value ?? null,
      metadataOrderId: clip(payment.metadata?.order_id ?? '', 64) || null,
    },
  }
}

/** ЮKassa cancelled the payment: the bank declined it, or the customer never paid. */
async function closeUnpaid(prisma: PrismaClient, order: Order, payment: Payment): Promise<void> {
  const reason = payment.cancellation_details?.reason ?? 'canceled'
  await prisma.order.updateMany({
    where: { id: order.id, status: 'pending' },
    data: { status: 'failed', failureReason: clip(reason, 64) },
  })
}

/**
 * A succeeded payment that does not pay the order: the order fails, nothing is applied, and
 * an operator is asked to look when money is left to return.
 */
async function refusePayment(
  prisma: PrismaClient,
  order: Order,
  payment: Payment,
  { failureReason, refund }: Refusal,
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      const closed = await tx.order.updateMany({
        where: { id: order.id, status: 'pending' },
        data: { status: 'failed', failureReason },
      })
      if (closed.count === 0 || refund === null) return
      await writeBillingAudit(tx, refundEntry(order, payment, refund, 'failed'))
    },
    { isolationLevel: 'ReadCommitted' },
  )
}

/** The payment of a failed or cancelled order succeeded: one entry, however often it is seen. */
async function flagLatePayment(prisma: PrismaClient, order: Order, payment: Payment) {
  await prisma.$transaction(
    async (tx) => {
      // Notifications and polls of one order queue here, so the entry is looked for and
      // written by one of them at a time.
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id}::uuid FOR NO KEY UPDATE`
      if (await refundFlagged(tx, order.id)) return
      await writeBillingAudit(
        tx,
        refundEntry(order, payment, refundReasons.orderClosed, order.status),
      )
    },
    { isolationLevel: 'ReadCommitted' },
  )
}

/**
 * Records the payment of an order that was closed without it, when the money came all the
 * same; true then. For a caller that holds the answer of the shop and finds its order closed.
 */
export async function recordLatePayment(
  prisma: PrismaClient,
  order: Order,
  payment: Payment,
): Promise<boolean> {
  if (!paidWhileClosed(order.status, payment)) return false
  await flagLatePayment(prisma, order, payment)
  return true
}

/** `captured_at` of the payment; undefined when ЮKassa did not send a moment. */
function capturedAt(payment: Payment): Date | undefined {
  const at = payment.captured_at === undefined ? Number.NaN : Date.parse(payment.captured_at)
  return Number.isFinite(at) ? new Date(at) : undefined
}

/**
 * The method to charge at renewals. Stored only when the customer agreed to auto-renewal at
 * checkout AND ЮKassa says the method is saved: a method the buyer saved on the payment page
 * without that consent is never kept, and consent without a saved method renews nothing.
 */
function consentedMethod(order: Order, payment: Payment): PaymentMethod | null {
  const method = payment.payment_method
  // subscriptions.payment_method_id is varchar(64): an id that does not fit cannot be charged.
  const usable = order.savePaymentMethod && method?.saved === true && method.id.length <= 64
  return usable ? method : null
}

/**
 * The columns of a subscription that describe its saved method, all five: nothing of a method
 * saved before stays beside the new one.
 */
export function methodColumns(method: PaymentMethod) {
  const last4 = method.card?.last4
  const cardType = method.card?.card_type
  return {
    paymentMethodId: method.id,
    paymentMethodTitle: method.title === undefined ? null : clip(method.title, 128),
    paymentMethodType: clip(method.type, 32),
    paymentMethodCardType: cardType === undefined ? null : clip(cardType, 32),
    paymentMethodLast4: last4 !== undefined && /^\d{4}$/.test(last4) ? last4 : null,
  }
}

const savedMethodColumns = (method: PaymentMethod | null) =>
  method === null ? {} : methodColumns(method)

/**
 * The first payment of a tariff: the order becomes `paid`, the subscription starts, the quota
 * of its first period is granted and the owner is told — in one transaction, or not at all.
 * The loser of a race for the order does nothing. Locks, in this order: the order row, the
 * workspace row, then the credit accounts (`grantTariffCredits`).
 */
async function applyFirstPayment(deps: ApplyDeps, order: Order, payment: Payment) {
  // A later slice adds what else an order may pay for: a top-up.
  if (order.kind !== 'subscription' || order.subscriptionId !== null || order.planId === null) {
    throw notImplemented('Settlement of this kind of order')
  }
  const { planId, workspaceId } = order
  const paidAt = capturedAt(payment) ?? deps.now?.() ?? new Date()
  await deps.prisma.$transaction(
    async (tx) => {
      const paid = await tx.order.updateMany({
        where: { id: order.id, status: 'pending' },
        data: { status: 'paid', paidAt },
      })
      if (paid.count === 0) return

      // Two paid orders of one workspace decide one after the other who starts the tariff.
      await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId}::uuid FOR NO KEY UPDATE`
      const live = await tx.subscription.findFirst({
        where: { workspaceId, status: { in: [...liveSubscriptionStatuses] } },
        select: { id: true },
      })
      if (live !== null) {
        // The tariff is already on: the order stays paid, and its money goes back.
        await writeBillingAudit(
          tx,
          refundEntry(order, payment, refundReasons.liveSubscription, 'paid'),
        )
        return
      }

      const plan = await tx.plan.findUniqueOrThrow({ where: { id: planId } })
      if (plan.creditsPerMonth === null)
        throw conflict('The plan of the order has no monthly quota')
      // The months of the subscription are counted from this payment.
      const period = billingPeriod(paidAt, 0)
      const method = consentedMethod(order, payment)
      const subscription = await tx.subscription.create({
        data: {
          workspaceId,
          planId,
          status: nextSubscriptionStatus(null, 'first_payment_succeeded'),
          currentPeriodStart: period.start,
          currentPeriodEnd: period.end,
          periodAnchor: paidAt,
          cancelAtPeriodEnd: method === null,
          ...savedMethodColumns(method),
        },
        select: { id: true },
      })
      await tx.order.update({
        where: { id: order.id },
        data: { subscriptionId: subscription.id, periodStart: period.start, periodEnd: period.end },
      })
      await grantTariffCredits(tx, {
        workspaceId,
        orderId: order.id,
        credits: plan.creditsPerMonth,
      })

      const amount = order.amount.toFixed(2)
      const notified = await enqueuePaymentLetter(tx, {
        order,
        planName: plan.name,
        amount,
        periodEnd: period.end,
        credits: plan.creditsPerMonth,
        appUrl: deps.appUrl,
      })
      const actor =
        order.userId === null ? SYSTEM_ACTOR : ({ type: 'user', id: order.userId } as const)
      const target = { type: 'subscription', id: subscription.id } as const
      await writeBillingAudit(tx, {
        actor,
        workspaceId,
        action: settlementAuditActions.subscriptionStart,
        target,
        meta: {
          orderId: order.id,
          planSlug: plan.slug,
          amount,
          credits: plan.creditsPerMonth,
          periodStart: period.start.toISOString(),
          periodEnd: period.end.toISOString(),
          autoRenewal: method !== null,
          notified,
        },
      })
      if (order.savePaymentMethod) {
        await writeBillingAudit(tx, {
          actor,
          workspaceId,
          action: settlementAuditActions.autoRenewalConsent,
          target,
          meta: {
            orderId: order.id,
            planSlug: plan.slug,
            amount,
            // The box was ticked when the order was made.
            consentedAt: order.createdAt.toISOString(),
            paymentMethodSaved: method !== null,
          },
        })
      }
    },
    { isolationLevel: 'ReadCommitted' },
  )
}

/** What a «payment succeeded» letter says was paid for: a tariff period or a pack. */
type PaidFor =
  | {
      item: 'plan'
      planName: string
      amount: string
      periodEnd: string
      credits: number
      appUrl: string
    }
  | { item: 'pack'; packCredits: number; amount: string; appUrl: string }

/**
 * Puts the «payment succeeded» letter of an order to the owner of its workspace into the
 * outbox. false when there is nobody to write to or the letter cannot be written: a letter
 * never undoes a payment, so its schema is asked first and a refusal skips the letter, not the
 * settlement.
 */
async function enqueuePaidLetter(tx: BillingTx, order: Order, paidFor: PaidFor): Promise<boolean> {
  const owner = await findWorkspaceOwner(tx, order.workspaceId)
  if (owner === null) return false
  const payload = { ...paidFor, to: owner.email }
  const definition = notificationCatalog['billing.payment_succeeded']
  if (!definition.payload.safeParse(payload).success) return false
  return enqueueNotification('billing.payment_succeeded', payload, {
    db: tx,
    dedupeKey: paymentLetterKey(order.id),
  })
}

/**
 * The «payment succeeded» letter about a paid period of a tariff. `credits`: what the period
 * was granted, the monthly credits of the tariff that was paid for.
 */
function enqueuePaymentLetter(
  tx: BillingTx,
  letter: {
    order: Order
    planName: string
    amount: string
    periodEnd: Date
    credits: number
    appUrl: string
  },
): Promise<boolean> {
  return enqueuePaidLetter(tx, letter.order, {
    item: 'plan',
    planName: letter.planName,
    amount: letter.amount,
    periodEnd: letter.periodEnd.toISOString(),
    credits: letter.credits,
    appUrl: letter.appUrl,
  })
}

/**
 * Who gets the billing letters of a workspace and stands as the payer of its automatic
 * charges: its owner (the oldest one, should there ever be two). null when the workspace has
 * none — the owner's account was deleted.
 */
export async function findWorkspaceOwner(
  db: Pick<BillingTx, 'member'>,
  workspaceId: string,
): Promise<{ userId: string; email: string } | null> {
  const owner = await db.member.findFirst({
    where: { workspaceId, role: 'owner' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { userId: true, user: { select: { email: true } } },
  })
  return owner === null ? null : { userId: owner.userId, email: owner.user.email }
}

// ─── Pack ─────────────────────────────────────────────────────────────────────

/**
 * A paid pack: the order becomes `paid`, its credits are granted to the account of purchased
 * credits and the owner is told — in one transaction, or not at all. The loser of a race for the
 * order does nothing. The subscription is neither read nor locked: a pack is sold on top of a
 * tariff that takes tasks (`startPackCheckout`), but one paid after its tariff ended is
 * granted all the same — the money came, and purchased credits outlive a tariff (default «ж»
 * of docs/plan/37-billing-plan.md). Locks: the order row, then the pack account
 * (`grantPackCredits`).
 */
async function applyPackPayment(deps: ApplyDeps, order: Order, payment: Payment): Promise<void> {
  const { planId, workspaceId } = order
  if (planId === null) throw conflict('The pack order has no plan')
  const paidAt = capturedAt(payment) ?? deps.now?.() ?? new Date()
  await deps.prisma.$transaction(
    async (tx) => {
      const paid = await tx.order.updateMany({
        where: { id: order.id, status: 'pending' },
        data: { status: 'paid', paidAt },
      })
      if (paid.count === 0) return

      const pack = await tx.plan.findUniqueOrThrow({ where: { id: planId } })
      if (pack.kind !== 'pack' || pack.packCredits === null) {
        throw conflict('The plan of the order is not a pack')
      }
      const credits = pack.packCredits
      // Creates the credit accounts of a workspace that has none yet.
      await grantPackCredits(tx, { workspaceId, orderId: order.id, credits })

      const amount = order.amount.toFixed(2)
      const notified = await enqueuePaidLetter(tx, order, {
        item: 'pack',
        packCredits: credits,
        amount,
        appUrl: deps.appUrl,
      })
      await writeBillingAudit(tx, {
        actor: order.userId === null ? SYSTEM_ACTOR : { type: 'user', id: order.userId },
        workspaceId,
        action: settlementAuditActions.packPurchase,
        target: { type: 'order', id: order.id },
        meta: { planSlug: pack.slug, amount, credits, notified },
      })
    },
    { isolationLevel: 'ReadCommitted' },
  )
}

// ─── Renewal ──────────────────────────────────────────────────────────────────
//
// The order of an automatic charge (renewal-order.ts) ends in one of two ways, each applied
// once under the conditional update of the order. The money came: the subscription moves to
// its next period. It did not, or nobody can tell: the subscription is past due and waits for
// a payment the customer makes by hand. Nothing here charges anybody — the scheduler of the
// core role does (renewal.ts).

/** audit_log actions of a renewal. */
export const renewalAuditActions = {
  /** The saved payment method was charged and the next period started. */
  renewed: 'billing.subscription.renew',
  /** The charge did not bring the money: the tariff is past due. */
  pastDue: 'billing.subscription.past_due',
  /**
   * Nobody can tell whether the charge was made: an operator has to look the payment up in
   * the shop and return the money if it was taken. One per order.
   */
  unknownResult: 'billing.renewal.unknown_result',
  /**
   * An operator looked the charge up and the shop holds no payment of it: the entry above is
   * closed (`closeUnknownCharge`). The target is the order.
   */
  unknownResultChecked: 'billing.renewal.unknown_result_checked',
} as const

/** The key of the «payment failed» letter in the outbox: one letter per order. */
export const paymentFailedLetterKey = (orderId: string) => `billing.payment_failed:${orderId}`

interface RenewedSubscription {
  status: SubscriptionStatus
  planId: string
  nextPlanId: string | null
  currentPeriodEnd: Date
  periodAnchor: Date
  pastDueSince: Date | null
  cancelAtPeriodEnd: boolean
  paymentMethodId: string | null
  paymentMethodType: string | null
  paymentMethodCardType: string | null
  paymentMethodLast4: string | null
}

/**
 * The subscription of a renewal order, locked until the transaction ends — after the order
 * row and before any credit account, the order every billing transaction keeps. Undefined when
 * the row is gone.
 */
async function lockRenewedSubscription(
  tx: Pick<BillingTx, '$queryRaw'>,
  subscriptionId: string,
): Promise<RenewedSubscription | undefined> {
  const [row] = await tx.$queryRaw<RenewedSubscription[]>`
    SELECT status::text AS status, plan_id AS "planId", next_plan_id AS "nextPlanId",
      current_period_end AS "currentPeriodEnd", period_anchor AS "periodAnchor",
      past_due_since AS "pastDueSince", cancel_at_period_end AS "cancelAtPeriodEnd",
      payment_method_id AS "paymentMethodId",
      payment_method_type AS "paymentMethodType",
      payment_method_card_type AS "paymentMethodCardType",
      payment_method_last4 AS "paymentMethodLast4"
    FROM subscriptions WHERE id = ${subscriptionId}::uuid
    FOR NO KEY UPDATE
  `
  return row
}

/**
 * Whether the subscription still stands where the renewal order found it: active, in the
 * period the order was made to renew. Only then may the outcome of the charge move it.
 */
function awaitsRenewal(
  subscription: RenewedSubscription | undefined,
  periodEnd: Date,
): subscription is RenewedSubscription {
  return (
    subscription !== undefined &&
    subscription.status === 'active' &&
    subscription.currentPeriodEnd.getTime() === periodEnd.getTime()
  )
}

/**
 * The period that follows `periodEnd`. The months go on from the anchor; an end that is not a
 * boundary of the anchor's months — a row whose dates were changed by hand — starts a run of
 * its own, so that money which has already been taken still buys a month.
 */
export function periodAfter(
  anchor: Date,
  periodEnd: Date,
): { period: BillingPeriod; anchor: Date } {
  try {
    return { period: nextBillingPeriod(anchor, periodEnd), anchor }
  } catch (error) {
    if (!isDomainError(error) || error.code !== 'BAD_REQUEST') throw error
    return { period: billingPeriod(periodEnd, 0), anchor: periodEnd }
  }
}

/**
 * A paid renewal: the order becomes `paid`, what is left of the old quota expires, the
 * subscription moves to the period after the one that ended — counted from its end by the
 * anchor, never from the moment of the charge — on the plan the order paid for, the quota of
 * that plan is granted and the owner is told. One transaction, or nothing; the loser of a
 * race for the order does nothing. Locks: the order row, the subscription, the accounts.
 */
async function applyRenewalPayment(deps: ApplyDeps, order: Order, payment: Payment): Promise<void> {
  const renewed = renewedPeriodEnd(order)
  const { planId, subscriptionId, workspaceId } = order
  if (renewed === null || planId === null || subscriptionId === null) {
    throw conflict('The order is not a renewal order')
  }
  const paidAt = capturedAt(payment) ?? deps.now?.() ?? new Date()
  await deps.prisma.$transaction(
    async (tx) => {
      const paid = await tx.order.updateMany({
        where: { id: order.id, status: 'pending' },
        data: { status: 'paid', paidAt },
      })
      if (paid.count === 0) return

      const subscription = await lockRenewedSubscription(tx, subscriptionId)
      if (!awaitsRenewal(subscription, renewed)) {
        // The subscription moved on without this payment. The order stays paid, and its
        // money goes back.
        await writeBillingAudit(tx, refundEntry(order, payment, refundReasons.staleRenewal, 'paid'))
        return
      }

      const plan = await tx.plan.findUniqueOrThrow({ where: { id: planId } })
      if (plan.creditsPerMonth === null)
        throw conflict('The plan of the order has no monthly quota')
      const { period, anchor } = periodAfter(subscription.periodAnchor, renewed)
      // While the subscription still stands in the period that ended: only then, and only
      // what no task holds, does the old quota expire.
      const expired = await expireTariffRemainder(tx, {
        workspaceId,
        subscriptionId,
        periodEnd: renewed,
      })
      await tx.subscription.update({
        where: { id: subscriptionId },
        data: {
          status: nextSubscriptionStatus(subscription.status, 'renewal_succeeded'),
          planId,
          // The scheduled change is applied. Another one, scheduled while the charge was on
          // its way, waits for the next renewal.
          ...(subscription.nextPlanId === planId ? { nextPlanId: null } : {}),
          currentPeriodStart: period.start,
          currentPeriodEnd: period.end,
          periodAnchor: anchor,
          // The notice was about the period that ended; the new one gets its own.
          renewalNoticePeriodEnd: null,
        },
      })
      await tx.order.update({
        where: { id: order.id },
        data: { periodStart: period.start, periodEnd: period.end },
      })
      await grantTariffCredits(tx, {
        workspaceId,
        orderId: order.id,
        credits: plan.creditsPerMonth,
      })

      const amount = order.amount.toFixed(2)
      const notified = await enqueuePaymentLetter(tx, {
        order,
        planName: plan.name,
        amount,
        periodEnd: period.end,
        credits: plan.creditsPerMonth,
        appUrl: deps.appUrl,
      })
      await writeBillingAudit(tx, {
        actor: SYSTEM_ACTOR,
        workspaceId,
        action: renewalAuditActions.renewed,
        target: { type: 'subscription', id: subscriptionId },
        meta: {
          orderId: order.id,
          planSlug: plan.slug,
          planChanged: subscription.planId !== planId,
          amount,
          credits: plan.creditsPerMonth,
          expiredCredits: expired === null ? 0 : -expired.entry.amount.toNumber(),
          periodStart: period.start.toISOString(),
          periodEnd: period.end.toISOString(),
          reanchored: anchor.getTime() !== subscription.periodAnchor.getTime(),
          notified,
        },
      })
    },
    { isolationLevel: 'ReadCommitted' },
  )
}

// ─── A payment by hand for a tariff that is past due ──────────────────────────
//
// The order `startPastDuePayment` makes: a subscription order of the subscription with a key
// of its own. Nothing here is counted from the period that ended: the customer pays today for a
// month from today (default «е» of docs/plan/37-billing-plan.md).

/**
 * A paid order of an overdue tariff: the order becomes `paid` and the subscription active
 * again — with a new run of periods, a month from the moment of the payment, which becomes the
 * anchor (the contract of `nextBillingPeriod`: without it the next renewal is refused). The
 * tariff is the one the order paid for; a scheduled change it names is applied. What was left
 * of the quota of the period that ended expires — the available credits only — and the quota of
 * the paid tariff is granted, once per order. The method of the payment replaces the saved one
 * only under the consent rule (`consentedMethod`) and only while auto-renewal is still on:
 * switched off after the order was made, it keeps what it had. The owner is told. One
 * transaction, or nothing; the loser of a race for the order does nothing.
 *
 * A subscription that is no longer past due — it ended while the payment was on its way, or was
 * paid by another order — is left as it is: the order stays paid and an entry asks an operator
 * to return the money. Locks: the order row, the subscription, the accounts.
 */
async function applyPastDuePayment(deps: ApplyDeps, order: Order, payment: Payment): Promise<void> {
  const { planId, subscriptionId, workspaceId } = order
  if (planId === null || subscriptionId === null) {
    throw conflict('The order pays for no tariff of a subscription')
  }
  const paidAt = capturedAt(payment) ?? deps.now?.() ?? new Date()
  await deps.prisma.$transaction(
    async (tx) => {
      const paid = await tx.order.updateMany({
        where: { id: order.id, status: 'pending' },
        data: { status: 'paid', paidAt },
      })
      if (paid.count === 0) return

      const subscription = await lockRenewedSubscription(tx, subscriptionId)
      if (subscription?.status !== 'past_due') {
        await writeBillingAudit(tx, refundEntry(order, payment, refundReasons.notPastDue, 'paid'))
        return
      }

      const plan = await tx.plan.findUniqueOrThrow({ where: { id: planId } })
      if (plan.creditsPerMonth === null)
        throw conflict('The plan of the order has no monthly quota')
      // The months are counted anew, from this payment.
      const period = billingPeriod(paidAt, 0)
      // While the subscription still stands in the period that ended.
      const expired = await expireTariffRemainder(tx, {
        workspaceId,
        subscriptionId,
        periodEnd: subscription.currentPeriodEnd,
      })
      const method = subscription.cancelAtPeriodEnd ? null : consentedMethod(order, payment)
      await tx.subscription.update({
        where: { id: subscriptionId },
        data: {
          status: nextSubscriptionStatus(subscription.status, 'past_due_payment_succeeded'),
          planId,
          // The scheduled change is applied. Another one, scheduled while the payment was on
          // its way, waits for the next renewal.
          ...(subscription.nextPlanId === planId ? { nextPlanId: null } : {}),
          currentPeriodStart: period.start,
          currentPeriodEnd: period.end,
          periodAnchor: paidAt,
          pastDueSince: null,
          // A notice of the period that ended announces nothing of the new one.
          renewalNoticePeriodEnd: null,
          ...savedMethodColumns(method),
        },
      })
      await tx.order.update({
        where: { id: order.id },
        data: { periodStart: period.start, periodEnd: period.end },
      })
      await grantTariffCredits(tx, {
        workspaceId,
        orderId: order.id,
        credits: plan.creditsPerMonth,
      })

      const amount = order.amount.toFixed(2)
      const notified = await enqueuePaymentLetter(tx, {
        order,
        planName: plan.name,
        amount,
        periodEnd: period.end,
        credits: plan.creditsPerMonth,
        appUrl: deps.appUrl,
      })
      await writeBillingAudit(tx, {
        actor: order.userId === null ? SYSTEM_ACTOR : { type: 'user', id: order.userId },
        workspaceId,
        action: settlementAuditActions.pastDuePayment,
        target: { type: 'subscription', id: subscriptionId },
        meta: {
          orderId: order.id,
          planSlug: plan.slug,
          planChanged: subscription.planId !== planId,
          amount,
          credits: plan.creditsPerMonth,
          expiredCredits: expired === null ? 0 : -expired.entry.amount.toNumber(),
          periodStart: period.start.toISOString(),
          periodEnd: period.end.toISOString(),
          // The period that was not paid for, and since when.
          overduePeriodEnd: subscription.currentPeriodEnd.toISOString(),
          pastDueSince: subscription.pastDueSince?.toISOString() ?? null,
          autoRenewal:
            !subscription.cancelAtPeriodEnd && (method ?? subscription.paymentMethodId) !== null,
          paymentMethodReplaced: method !== null,
          notified,
        },
      })
    },
    { isolationLevel: 'ReadCommitted' },
  )
}

/** How a renewal order fails. */
export interface RenewalFailure {
  /** orders.failure_reason. */
  failureReason: string
  /** The bank said no: the customer is told. Not when the money came, or nobody can tell. */
  letter: boolean
  /**
   * The method the declined payment was made with, as the payment names it. The subscription
   * may hold another by then — a method replaced while the charge was at the bank was never
   * asked — and the letter then names this one. Absent when there is no payment or it names no
   * method: the letter names the method of the subscription.
   */
  chargedMethod?: ReturnType<typeof methodColumns>
  /** Money that came and is not applied: the entry that asks an operator to return it. */
  refund?: BillingAuditEntry
  /** Nobody can tell whether the charge was made: an operator is asked to look in the shop. */
  unknown?: boolean
  /** Fail the order only while it has no payment: an answer that arrived meanwhile wins. */
  onlyWithoutPayment?: boolean
  /**
   * The shop refused the charge request itself and made no payment: the status and the text
   * of its answer, kept in the past-due entry for whoever looks into the refusal.
   */
  shopRefusal?: { status: number; message: string }
}

/** ЮKassa cancelled the charge: the bank declined it, or the saved method no longer works. */
function declinedRenewal(payment: Payment): RenewalFailure {
  const method = payment.payment_method
  return {
    failureReason: clip(payment.cancellation_details?.reason ?? 'canceled', 64),
    letter: true,
    ...(method === undefined ? {} : { chargedMethod: methodColumns(method) }),
  }
}

/** The charge succeeded and does not pay the order: another amount, or the money went back. */
function refusedRenewal(order: Order, payment: Payment, refused: Refusal): RenewalFailure {
  return {
    failureReason: refused.failureReason,
    letter: false,
    ...(refused.refund === null
      ? {}
      : { refund: refundEntry(order, payment, refused.refund, 'failed') }),
  }
}

/**
 * A renewal that did not bring the money: the order becomes `failed` and the subscription,
 * if it still waits for this renewal, past due from now — new tasks are not taken until the
 * customer pays by hand, and nothing is charged again by itself. The period, the quota and
 * the saved method stay as they are. A subscription whose auto-renewal was switched off while
 * the charge was on its way is left active: it is not renewed, so it ends with its period
 * like any other (`endPeriods`). One transaction; false when another call had already closed
 * the order. Locks: the order row, then the subscription.
 */
export async function failRenewal(
  deps: ApplyDeps,
  order: Order,
  failure: RenewalFailure,
): Promise<boolean> {
  const renewed = renewedPeriodEnd(order)
  const { subscriptionId, workspaceId } = order
  if (renewed === null || subscriptionId === null) {
    throw conflict('The order is not a renewal order')
  }
  const now = deps.now?.() ?? new Date()
  return deps.prisma.$transaction(
    async (tx) => {
      const closed = await tx.order.updateMany({
        where: {
          id: order.id,
          status: 'pending',
          ...(failure.onlyWithoutPayment ? { yookassaPaymentId: null } : {}),
        },
        data: { status: 'failed', failureReason: failure.failureReason },
      })
      if (closed.count === 0) return false
      if (failure.refund !== undefined) await writeBillingAudit(tx, failure.refund)

      const amount = order.amount.toFixed(2)
      const subscription = await lockRenewedSubscription(tx, subscriptionId)
      const pastDue =
        awaitsRenewal(subscription, renewed) &&
        subscription.paymentMethodId !== null &&
        !subscription.cancelAtPeriodEnd
      if (pastDue) {
        await tx.subscription.update({
          where: { id: subscriptionId },
          data: {
            status: nextSubscriptionStatus(subscription.status, 'renewal_declined'),
            pastDueSince: now,
          },
        })
        // The method that was asked. While it is still the saved one, the subscription names
        // it, as every other letter does; a payment may describe its card in less detail.
        const charged = failure.chargedMethod
        const replaced =
          charged !== undefined && charged.paymentMethodId !== subscription.paymentMethodId
        const notified = failure.letter
          ? await enqueueFailureLetter(tx, {
              order,
              subscription: replaced ? charged : subscription,
              amount,
              appUrl: deps.appUrl,
            })
          : false
        await writeBillingAudit(tx, {
          actor: SYSTEM_ACTOR,
          workspaceId,
          action: renewalAuditActions.pastDue,
          target: { type: 'subscription', id: subscriptionId },
          meta: {
            orderId: order.id,
            reason: failure.failureReason,
            amount,
            pastDueSince: now.toISOString(),
            notified,
            ...(failure.shopRefusal === undefined
              ? {}
              : {
                  shopStatus: failure.shopRefusal.status,
                  shopError: clip(failure.shopRefusal.message, 300),
                }),
          },
        })
      }
      if (failure.unknown) {
        await writeBillingAudit(tx, {
          actor: SYSTEM_ACTOR,
          workspaceId,
          action: renewalAuditActions.unknownResult,
          target: { type: 'order', id: order.id },
          meta: {
            subscriptionId,
            amount,
            // What the shop was asked under: its payment, if there is one, carries this order
            // in `metadata.order_id` and was created not earlier than this moment.
            idempotenceKey: order.idempotenceKey,
            orderCreatedAt: order.createdAt.toISOString(),
            pastDue,
          },
        })
      }
      return true
    },
    { isolationLevel: 'ReadCommitted' },
  )
}

/** The columns a payment method is named by in a letter. */
type NamedMethod = Pick<
  RenewedSubscription,
  'paymentMethodType' | 'paymentMethodCardType' | 'paymentMethodLast4'
>

/**
 * Puts the «payment failed» letter to the owner into the outbox; false when there is nobody
 * to write to or the letter cannot be written. Like the «payment succeeded» one, it never
 * undoes what it tells about. `subscription`: the method the letter names — the one that was
 * charged when the caller knows it, else the saved method of the subscription.
 *
 * The letter is told the gift credits the workspace can spend now: they take tasks while the
 * tariff is not paid for, and the letter says of new tasks what «Тарифы» says.
 */
export async function enqueueFailureLetter(
  tx: BillingTx,
  letter: {
    order: Order
    subscription: NamedMethod
    amount: string
    appUrl: string
  },
): Promise<boolean> {
  const { order, subscription } = letter
  if (order.planId === null) return false
  const owner = await findWorkspaceOwner(tx, order.workspaceId)
  const plan = await tx.plan.findUnique({ where: { id: order.planId }, select: { name: true } })
  if (owner === null || plan === null) return false
  const giftCreditsLeft = (await getCreditBalances(tx, order.workspaceId)).gift.available
  const payload = {
    planName: plan.name,
    amount: letter.amount,
    paymentMethod: paymentMethodLabel({
      type: subscription.paymentMethodType,
      cardType: subscription.paymentMethodCardType,
      last4: subscription.paymentMethodLast4,
    }),
    giftCreditsLeft,
    appUrl: letter.appUrl,
    to: owner.email,
  }
  const definition = notificationCatalog['billing.payment_failed']
  if (!definition.payload.safeParse(payload).success) return false
  return enqueueNotification('billing.payment_failed', payload, {
    db: tx,
    dedupeKey: paymentFailedLetterKey(order.id),
  })
}
