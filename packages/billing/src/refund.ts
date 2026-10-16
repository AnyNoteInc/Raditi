import type { Order, PrismaClient } from '@repo/db'
import {
  assertOrderTransition,
  billingOrderNotFound,
  conflict,
  isDomainError,
  isLiveSubscription,
  Money,
  nextSubscriptionStatus,
  orderKindSchema,
  orderStatusSchema,
  type OrderKind,
  type OrderStatus,
  type SubscriptionStatus,
} from '@repo/domain'
import {
  YookassaApiError,
  YookassaError,
  type Payment,
  type Refund,
  type YookassaClient,
} from '@repo/yookassa'
import type { Decimal } from 'decimal.js'
import { z } from 'zod'

import { lockCreditAccount, type BillingTx } from './accounts.ts'
import { writeBillingAudit } from './audit.ts'
import type { BillingDeps } from './deps.ts'
import { orderFailureReasons } from './failure-text.ts'
import { expireTariffRemainder, ledgerKeys, post, posted } from './ledger.ts'
import { getCreditBalances } from './read-models.ts'
import { renewalJobAuditActions } from './renewal.ts'
import { renewalAuditActions, settlementAuditActions } from './settlement.ts'

// Refunds: the money of a paid order goes back to the customer. An operator asks for it by a
// command; nothing in the product does. The refund is always for the whole amount of the order
// and is made once: ЮKassa is asked under the key `refund.<orderId>`, its refund id is kept on
// the order, and the payment is read back before the request, so a payment that has already
// been returned in the ЮKassa cabinet is never asked for again.
//
// A refund of the platform is told from one made in the cabinet by its description,
// `Возврат по заказу <orderId>` (`refundDescription`): a documented field of the request that
// the read-back returns. Not `metadata`: the request classes of the official SDKs list no
// such field for a refund. Neither was tried against a real shop.
//
// As with a payment, a notification is only a reason to look: the refund is read back through
// the API and that answer alone makes the order `refunded` — once, under the lock of its row,
// whoever comes first: the command that asked, a later run of it, or `refund.succeeded`.
//
// What the refund does to the customer's rights is the operator's decision and is never
// guessed: without an option only the money moves. The options act once the money has gone
// back, and only in the command that names them; the notification moves nothing but the order.

/** audit_log actions of a refund; the target is the order. */
export const refundAuditActions = {
  /** An operator returned the payment of an order: who, why, the refund and what else was done. */
  refund: 'billing.order.refund',
  /** A refund the platform had asked for was confirmed by a notification: the order is refunded. */
  refundSettled: 'billing.order.refund_settled',
  /** A refund made outside the platform, in the ЮKassa cabinet: its amounts. One per refund. */
  refundOutside: 'billing.order.refund_outside',
} as const

/** `meta.reason` of `billing.subscription.end` for a tariff an operator ended with a refund. */
export const REFUND_END_REASON = 'refund'

/**
 * Fixed refusals the operator can act on: the message of a CONFLICT. The command shows each of
 * them in Russian.
 */
export const refundRefusals = {
  /** Pending, failed or cancelled: there is no payment of the order to return. */
  notPaid: 'Only a paid order is refunded',
  /** A paid order that holds no ЮKassa payment: nothing to ask the shop about. */
  noPayment: 'The order holds no payment',
  /** ЮKassa reports another payment, amount or status than the order was paid with. */
  paymentMismatch: 'The payment is not the one the order was paid with',
  /** Money of the payment has gone back and the order knows no refund of its own. */
  refundedElsewhere: 'The payment already carries a refund the order does not know',
  /** ЮKassa answered with a refund of another payment or amount. */
  refundMismatch: 'The refund is not the one the order asked for',
  /** `endSubscription` for an order that did not pay for a tariff. */
  noTariff: 'The order did not pay for a tariff',
  /** `endSubscription` for an order of a period the tariff has left behind. */
  notCurrentPeriod: 'The order did not pay for the current period of the tariff',
  /** `takeCredits` for an order that is not a pack. */
  notPack: 'The order is not a pack order',
  /** `refundedInCabinet` for an order that keeps a refund of its own. */
  cabinetOwnRefund: 'The order keeps a refund of its own',
  /** `refundedInCabinet` while ЮKassa does not report the whole payment as returned. */
  cabinetNotFull: 'The payment is not refunded in full',
  /** The order is not a renewal charge that was given up without an answer. */
  notUnknownCharge: 'The order is not a charge without an answer',
} as const

/**
 * The Idempotence-Key of a refund request of an order: `refund.<orderId>`, so that every
 * request for the refund repeats the first. A refund ЮKassa cancelled is final and moved no
 * money, and for a day its key is answered with it; the request after `cancelled` such refunds
 * therefore has a key of its own, `refund.<orderId>.<cancelled>` (at most 64 characters of
 * the set ЮKassa keys are kept to).
 */
export const refundKey = (orderId: string, cancelled = 0) =>
  cancelled === 0 ? `refund.${orderId}` : `refund.${orderId}.${cancelled}`

const REFUND_DESCRIPTION = /^Возврат по заказу ([0-9a-f-]{36})$/

/**
 * The description of every refund the platform asks for. It is the mark a refund of ours is
 * known by before the order has stored its id (`refundIsOwn`), so it is built and read only
 * here. The operator's reason is not a part of it: that stays in audit_log.
 */
export const refundDescription = (orderId: string) => `Возврат по заказу ${orderId}`

/** The order a refund description names; null unless it is a description of ours. */
export function orderOfRefundDescription(description: string | undefined): string | null {
  const named = description === undefined ? null : REFUND_DESCRIPTION.exec(description)
  const orderId = z.uuid().safeParse(named?.[1])
  return orderId.success ? orderId.data : null
}

/** What a refund is asked and read back with: the database, the clock and three shop calls. */
export type RefundDeps = Pick<BillingDeps, 'prisma' | 'now'> & {
  yookassa: Pick<YookassaClient, 'getPayment' | 'createRefund' | 'getRefund'>
}

/** What a notification of a refund is settled with. A whole `YookassaClient` fits. */
export type RefundSettlementDeps = Pick<BillingDeps, 'prisma' | 'now'> & {
  yookassa: Pick<YookassaClient, 'getRefund'>
}

// One line without control characters: it is printed to a terminal and kept in audit_log.
const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^\P{Cc}+$/u)

/** Who acts and why: the name of the operator (audit_log.actor_id) and their reason. */
export const operatorActionSchema = z.strictObject({
  operator: oneLine(128),
  /** credit_ledger.note and a value of audit_log.meta hold 500 characters. */
  reason: oneLine(500),
})

const refundInputSchema = z.strictObject({
  orderId: z.uuid(),
  ...operatorActionSchema.shape,
  /** End the tariff the order paid for, now, and expire what is left of its quota. */
  endSubscription: z.boolean().default(false),
  /** Take the credits of the pack the order paid for that are still available. */
  takeCredits: z.boolean().default(false),
  /**
   * The whole payment was returned in the ЮKassa cabinet: ask for no refund and mark the
   * order refunded, when the shop confirms that all of the payment has gone back.
   */
  refundedInCabinet: z.boolean().default(false),
})
export type RefundOrderInput = z.input<typeof refundInputSchema>
type RefundRequest = z.output<typeof refundInputSchema>

const settleRefundInputSchema = z.strictObject({ refundId: z.string().min(1) })
const unknownChargeInputSchema = z.strictObject({
  orderId: z.uuid(),
  ...operatorActionSchema.shape,
})

/** What `endSubscription` did to the tariff of the order. */
export type TariffEnding =
  | { outcome: 'ended'; subscriptionId: string; expiredCredits: number; endedAt: Date }
  /** The tariff was over before this call: by an earlier run, or by itself. */
  | { outcome: 'already_ended'; subscriptionId: string }
  /** The tariff moved to a later period while the refund was on its way: it is left as it is. */
  | { outcome: 'not_current'; subscriptionId: string }

/** What `takeCredits` did to the purchased credits. */
export type CreditsTaking =
  | { outcome: 'taken'; credits: number }
  /** An earlier run took them: nothing more is taken for this order. */
  | { outcome: 'already_taken'; credits: number }
  /** Every credit of the pack is spent or reserved by a task: nothing was taken. */
  | { outcome: 'nothing_available' }

/** Where the refund of an order stands after a call of `refundOrder`. */
export interface OrderRefund {
  orderId: string
  /**
   * `refunded`: the money has gone back and the order says so. `pending`: ЮKassa has the
   * request and has not finished; the order stays paid until the notification or the next
   * call. `canceled`: ЮKassa refused the refund; nothing went back and the order stays paid.
   */
  state: 'refunded' | 'pending' | 'canceled'
  /** The ЮKassa refund this call met; null only for a refunded order that keeps no refund id. */
  refundId: string | null
  /** RUB, the whole amount of the order. */
  amount: string
  /** This call asked ЮKassa for the refund; false: an earlier call had. */
  requested: boolean
  /** This call made the order `refunded`; false: it was already, or is not yet. */
  settled: boolean
  /**
   * This call marked the order refunded without a refund of its own (`refundedInCabinet`):
   * the shop reported the whole payment as returned in the cabinet.
   */
  cabinet: boolean
  /** Why ЮKassa cancelled the refund; null unless `canceled`. */
  cancellation: { party: string; reason: string } | null
  /** null: not asked for, or the money has not gone back yet — the rights are untouched. */
  tariff: TariffEnding | null
  /** null: not asked for, or the money has not gone back yet — the credits are untouched. */
  credits: CreditsTaking | null
}

/** Where the order of a refund stands after the refund was read back on a notification. */
export type RefundSettlement =
  | {
      /** ЮKassa does not know the refund, or no order of ours was paid with its payment. */
      state: 'unknown'
    }
  | {
      /**
       * `refunded`: the order is refunded by this refund. `pending`, `canceled`: the refund
       * moved no money, nothing changed. `outside`: the refund is not the platform's own — it
       * was made in the ЮKassa cabinet — and an audit entry says so.
       */
      state: 'refunded' | 'pending' | 'canceled' | 'outside'
      orderId: string
    }

const SYSTEM_ACTOR = { type: 'system', id: 'billing' } as const

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text)

/**
 * The order, locked until the transaction ends and read under that lock: the command, a second
 * run of it and the notification of the same refund settle one after another. NO KEY: ledger
 * rows that refer to the order are not held up.
 */
async function lockOrder(tx: BillingTx, orderId: string): Promise<Order> {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR NO KEY UPDATE`
  return tx.order.findUniqueOrThrow({ where: { id: orderId } })
}

/** The refund returns the whole amount of the order, to the payment the order was paid with. */
function refundIsOrders(order: Order, refund: Refund): boolean {
  return (
    refund.payment_id === order.yookassaPaymentId &&
    refund.amount.currency === 'RUB' &&
    new Money(refund.amount.value).equals(order.amount)
  )
}

/** The refund carries the mark of the platform's own refund of this order. */
const namesOrder = (order: Order, refund: Refund) =>
  orderOfRefundDescription(refund.description) === order.id

/**
 * Whether the refund is the platform's own for this order: the one whose id the order keeps,
 * or — while the order keeps none — the one whose description names the order. The second is a
 * refund whose notification outran the command that asked for it, or whose answer the command
 * never got: only `refundOrder` writes `refundDescription` into a refund.
 */
function refundIsOwn(order: Order, refund: Refund): boolean {
  if (!refundIsOrders(order, refund)) return false
  if (order.yookassaRefundId !== null) return order.yookassaRefundId === refund.id
  return order.status === 'paid' && namesOrder(order, refund)
}

/** Makes a paid order `refunded` by its own refund; false when it was not paid any more. */
async function markRefunded(tx: BillingTx, order: Order, refund: Refund, now: Date) {
  assertOrderTransition(order.status, 'refunded')
  const marked = await tx.order.updateMany({
    where: { id: order.id, status: 'paid' },
    data: {
      status: 'refunded',
      yookassaRefundId: refund.id,
      refundedAt: now,
      refundedAmount: new Money(refund.amount.value),
    },
  })
  return marked.count === 1
}

/**
 * Makes a paid order `refunded` by a refund made in the ЮKassa cabinet: the whole amount, at
 * this moment, and no refund id — the order never had a refund of its own. false when the
 * order was not paid any more or came to keep a refund meanwhile.
 */
async function markRefundedInCabinet(tx: BillingTx, order: Order, now: Date) {
  assertOrderTransition(order.status, 'refunded')
  const marked = await tx.order.updateMany({
    where: { id: order.id, status: 'paid', yookassaRefundId: null },
    data: { status: 'refunded', refundedAt: now, refundedAmount: order.amount },
  })
  return marked.count === 1
}

// ─── The operator's refund ────────────────────────────────────────────────────

/** What ЮKassa is asked for: the whole amount of the order, marked as the platform's own. */
const refundRequest = (order: Order, paymentId: string) => ({
  payment_id: paymentId,
  amount: { value: order.amount.toFixed(2), currency: 'RUB' as const },
  // How a refund is told to be ours before the order has stored its id (`refundIsOwn`).
  description: refundDescription(order.id),
})

/** One repeat with the same key after a failure whose outcome is unknown. */
async function requestRefund(
  yookassa: RefundDeps['yookassa'],
  order: Order,
  paymentId: string,
  key: string,
): Promise<Refund> {
  const request = refundRequest(order, paymentId)
  try {
    return await yookassa.createRefund(request, key)
  } catch (error) {
    if (!(error instanceof YookassaError) || !error.retryable) throw error
    return yookassa.createRefund(request, key)
  }
}

/**
 * How many refunds of the order ЮKassa has cancelled, by the operator's entries that met them:
 * what the key of the next request is numbered with (`refundKey`). An entry is written in the
 * transaction that learns of the cancellation; a cancellation whose entry was not written is
 * met again under the same key and counted then.
 */
async function cancelledRefunds(db: Pick<PrismaClient, 'auditLog'>, orderId: string) {
  const entries = await db.auditLog.findMany({
    where: {
      action: refundAuditActions.refund,
      targetType: 'order',
      targetId: orderId,
      meta: { path: ['refundStatus'], equals: 'canceled' },
    },
    select: { meta: true },
  })
  const refundIds = new Set<string>()
  for (const { meta } of entries) {
    const parsed = z.object({ refundId: z.string() }).safeParse(meta)
    if (parsed.success) refundIds.add(parsed.data.refundId)
  }
  return refundIds.size
}

/**
 * The whole payment has gone back and the order keeps no refund: somebody returned it in the
 * cabinet, or an earlier request of ours was served and its answer never stored — and its
 * notification may never come. The request is repeated once under the order's key. Nothing is
 * left of the payment, so no second refund can come of it: for a day ЮKassa answers a request
 * it served with the refund it made, and it refuses a new one. Only a succeeded refund that
 * is recognisably this order's is taken; everything else is a refund made elsewhere.
 */
async function lostRefund(
  yookassa: RefundDeps['yookassa'],
  order: Order,
  paymentId: string,
  key: string,
): Promise<Refund> {
  let refund: Refund
  try {
    refund = await yookassa.createRefund(refundRequest(order, paymentId), key)
  } catch (error) {
    // The shop refused the request itself: it holds no refund under this key.
    if (error instanceof YookassaApiError && !error.retryable) {
      throw conflict(refundRefusals.refundedElsewhere)
    }
    throw error
  }
  const own =
    refund.status === 'succeeded' && refundIsOrders(order, refund) && namesOrder(order, refund)
  if (!own) throw conflict(refundRefusals.refundedElsewhere)
  return refund
}

/** ЮKassa reports the payment the order was paid with: its id, status, currency and amount. */
function paymentIsOrders(order: Order, payment: Payment): boolean {
  return (
    payment.id === order.yookassaPaymentId &&
    payment.status === 'succeeded' &&
    payment.amount.currency === 'RUB' &&
    new Money(payment.amount.value).equals(order.amount)
  )
}

/**
 * The refund of a paid order: the one an earlier call asked for, read back, or a new one. A
 * new one is asked for only when the payment is the order's and nothing of it has gone back.
 * Whether the answer is a refund of this order is checked where it is applied, under the lock
 * of the order.
 */
async function findOrRequestRefund(
  { prisma, yookassa }: RefundDeps,
  order: Order,
): Promise<{ refund: Refund; requested: boolean }> {
  const paymentId = order.yookassaPaymentId
  if (paymentId === null) throw conflict(refundRefusals.noPayment)
  if (order.yookassaRefundId !== null) {
    return { refund: await yookassa.getRefund(order.yookassaRefundId), requested: false }
  }

  const payment = await yookassa.getPayment(paymentId)
  if (!paymentIsOrders(order, payment)) throw conflict(refundRefusals.paymentMismatch)
  const key = refundKey(order.id, await cancelledRefunds(prisma, order.id))
  // ЮKassa keeps a payment `succeeded` after a refund: `refunded_amount` alone tells that money
  // has left. The order knows no refund, so somebody returned it in the cabinet — or an earlier
  // request of ours was served and its answer lost. Of a part nothing more can be learnt here;
  // of the whole amount the shop is asked once more (`lostRefund`).
  const returned = new Money(payment.refunded_amount?.value ?? 0)
  if (returned.greaterThan(0)) {
    if (!returned.equals(order.amount)) throw conflict(refundRefusals.refundedElsewhere)
    return { refund: await lostRefund(yookassa, order, paymentId, key), requested: false }
  }
  return { refund: await requestRefund(yookassa, order, paymentId, key), requested: true }
}

/**
 * `refundedInCabinet`: the operator says the whole payment was returned in the ЮKassa cabinet.
 * It is taken on the shop's word only: the payment is the order's and all of it has gone back,
 * and the order keeps no refund of its own. The shop is asked for nothing but the read-back.
 */
async function confirmCabinetRefund({ yookassa }: RefundDeps, order: Order): Promise<void> {
  const paymentId = order.yookassaPaymentId
  if (paymentId === null) throw conflict(refundRefusals.noPayment)
  if (order.yookassaRefundId !== null) throw conflict(refundRefusals.cabinetOwnRefund)
  const payment = await yookassa.getPayment(paymentId)
  if (!paymentIsOrders(order, payment)) throw conflict(refundRefusals.paymentMismatch)
  if (!new Money(payment.refunded_amount?.value ?? 0).equals(order.amount)) {
    throw conflict(refundRefusals.cabinetNotFull)
  }
}

interface TariffRow {
  id: string
  workspaceId: string
  status: SubscriptionStatus
  currentPeriodStart: Date
  currentPeriodEnd: Date
  cancelledAt: Date | null
}

/**
 * Whether the tariff still stands in the period the order paid for. An order that paid for no
 * period — a renewal the subscription did not wait for — never does, and neither does one of a
 * period the tariff has renewed past: ending the tariff for it would take away a month that
 * another order paid for.
 */
function standsInPaidPeriod(order: Order, tariff: Pick<TariffRow, 'currentPeriodEnd'>): boolean {
  return order.periodEnd !== null && order.periodEnd.getTime() >= tariff.currentPeriodEnd.getTime()
}

/**
 * The status an operator's refund ends the tariff with; null for a status the machine does not
 * end this way (a trial, which has no rules yet).
 */
function endedStatus(status: SubscriptionStatus): SubscriptionStatus | null {
  try {
    return nextSubscriptionStatus(status, 'refunded_by_operator')
  } catch (error) {
    if (isDomainError(error) && error.code === 'CONFLICT') return null
    throw error
  }
}

/** Refuses the options that do not fit the order, before any money moves. */
async function checkOptions(
  prisma: PrismaClient,
  order: Order,
  request: RefundRequest,
): Promise<void> {
  if (request.takeCredits && order.kind !== 'pack') throw conflict(refundRefusals.notPack)
  if (!request.endSubscription) return
  if (order.kind !== 'subscription' || order.subscriptionId === null) {
    throw conflict(refundRefusals.noTariff)
  }
  const tariff = await prisma.subscription.findUnique({
    where: { id: order.subscriptionId },
    select: { status: true, currentPeriodEnd: true },
  })
  // A tariff that is already over is nothing to refuse: there is nothing left to end.
  if (tariff === null || !isLiveSubscription(tariff.status)) return
  if (endedStatus(tariff.status) === null) throw conflict(refundRefusals.noTariff)
  // The period is a refusal only while no money has been asked for. Once the order is refunded,
  // has a refund of its own under way, or is said to be returned in the cabinet, the call goes
  // on to the refund, and a tariff that has moved on is an outcome of it (`endTariff`).
  const moneyAskedFor =
    order.status === 'refunded' || order.yookassaRefundId !== null || request.refundedInCabinet
  if (!moneyAskedFor && !standsInPaidPeriod(order, tariff)) {
    throw conflict(refundRefusals.notCurrentPeriod)
  }
}

/**
 * Ends the tariff of a refunded order now: what is left of its quota expires — the available
 * credits only, a held one stays with its task —, the subscription becomes `cancelled` with
 * auto-renewal off, and its period is cut to this moment, so that `current_period_end` of an
 * ended subscription is when it ended, however it did. Purchased credits are not touched. Locks
 * the subscription, then the tariff account (`expireTariffRemainder`).
 */
async function endTariff(
  tx: BillingTx,
  order: Order,
  { operator, now }: { operator: string; now: Date },
): Promise<TariffEnding> {
  const subscriptionId = order.subscriptionId
  if (subscriptionId === null) throw conflict(refundRefusals.noTariff)
  const [tariff] = await tx.$queryRaw<TariffRow[]>`
    SELECT id, workspace_id AS "workspaceId", status::text AS status,
      current_period_start AS "currentPeriodStart", current_period_end AS "currentPeriodEnd",
      cancelled_at AS "cancelledAt"
    FROM subscriptions WHERE id = ${subscriptionId}::uuid
    FOR NO KEY UPDATE
  `
  if (tariff === undefined || !isLiveSubscription(tariff.status)) {
    return { outcome: 'already_ended', subscriptionId }
  }
  // The money has gone back by now: what `checkOptions` would have refused is an outcome here.
  const status = endedStatus(tariff.status)
  if (status === null || !standsInPaidPeriod(order, tariff)) {
    return { outcome: 'not_current', subscriptionId }
  }
  // Before the subscription is closed: afterwards nothing of its quota may expire.
  const expired = await expireTariffRemainder(tx, {
    workspaceId: tariff.workspaceId,
    subscriptionId,
    periodEnd: tariff.currentPeriodEnd,
  })
  const expiredCredits = expired === null ? 0 : -expired.entry.amount.toNumber()
  // A paid tariff ends now; an overdue one ended with its paid period, which stays as it is.
  // Never at or before the start of the period: the start is ЮKassa's clock, which may be
  // ahead of ours, and the period of a subscription is never empty.
  const cut = new Date(Math.max(now.getTime(), tariff.currentPeriodStart.getTime() + 1))
  const endedAt = cut.getTime() < tariff.currentPeriodEnd.getTime() ? cut : tariff.currentPeriodEnd
  await tx.subscription.update({
    where: { id: subscriptionId },
    data: {
      status,
      ...(endedAt === cut ? { currentPeriodEnd: cut } : {}),
      cancelAtPeriodEnd: true,
      cancelledAt: tariff.cancelledAt ?? now,
      renewalNoticePeriodEnd: null,
    },
  })
  const packCreditsLeft = (await getCreditBalances(tx, tariff.workspaceId)).pack.available
  await writeBillingAudit(tx, {
    actor: { type: 'operator', id: operator },
    workspaceId: tariff.workspaceId,
    action: renewalJobAuditActions.subscriptionEnd,
    target: { type: 'subscription', id: subscriptionId },
    meta: {
      status,
      reason: REFUND_END_REASON,
      orderId: order.id,
      // The end of the period that was paid for, and the moment the tariff ended instead.
      periodEnd: tariff.currentPeriodEnd.toISOString(),
      endedAt: endedAt.toISOString(),
      expiredCredits,
      packCreditsLeft,
      // A refund writes no letter: the operator answers the customer who asked for it.
      notified: false,
    },
  })
  return { outcome: 'ended', subscriptionId, expiredCredits, endedAt }
}

/**
 * Takes the credits of a refunded pack off the account of purchased credits: as many as the pack
 * granted and no more than are available — a credit a task has spent or holds stays where it
 * is, and the balance never goes below what is held. One `adjust` row per order: once it is
 * written, nothing more is taken for the order, whatever becomes available later.
 *
 * Only that account is locked and read. The gift of the registration was not bought with the
 * pack and does not make up for credits of the pack that are spent or held: it is never taken.
 */
async function takePackCredits(
  tx: BillingTx,
  order: Order,
  reason: string,
): Promise<CreditsTaking> {
  const account = await lockCreditAccount(tx, order.workspaceId, 'pack')
  if (account === null) return { outcome: 'nothing_available' }
  const idempotencyKey = ledgerKeys.refundAdjust(order.id)
  const before = await posted(tx, idempotencyKey, { account, kind: 'adjust' })
  if (before !== null) return { outcome: 'already_taken', credits: -before.amount.toNumber() }
  // What this order granted, by its own row: the pack on sale may hold another number now.
  const granted = await tx.creditLedger.findUnique({
    where: { idempotencyKey: ledgerKeys.packGrant(order.id) },
  })
  const grantedCredits =
    granted !== null && granted.accountId === account.id && granted.kind === 'grant'
      ? granted.amount.toNumber()
      : 0
  const credits = Math.min(grantedCredits, account.snapshot.balance - account.snapshot.held)
  if (credits <= 0) return { outcome: 'nothing_available' }
  await post(tx, {
    account,
    kind: 'adjust',
    amount: new Money(credits).negated(),
    orderId: order.id,
    idempotencyKey,
    note: reason,
  })
  return { outcome: 'taken', credits }
}

// What an operator's entry says of the options: asked for, and what came of each.
const optionsMetaSchema = z.object({
  endSubscription: z.boolean(),
  takeCredits: z.boolean(),
  tariff: z.string().nullable(),
  credits: z.string().nullable(),
})

/**
 * The options an operator's entry asked for that were not applied: the refund was still
 * pending, so the rights were left alone (`refundOrder`). null when the entry left nothing open.
 */
function unappliedOptions(
  meta: unknown,
): { endSubscription: boolean; takeCredits: boolean } | null {
  const said = optionsMetaSchema.safeParse(meta)
  if (!said.success) return null
  const endSubscription = said.data.endSubscription && said.data.tariff === null
  const takeCredits = said.data.takeCredits && said.data.credits === null
  return endSubscription || takeCredits ? { endSubscription, takeCredits } : null
}

/**
 * What the operator's entries of the order tell a new call: whether one of them already names
 * this refund (any of them, when the call met no refund), and whether the newest left an
 * option unapplied.
 */
async function operatorEntries(tx: BillingTx, orderId: string, refundId: string | null) {
  const entries = await tx.auditLog.findMany({
    where: { action: refundAuditActions.refund, targetType: 'order', targetId: orderId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { meta: true },
  })
  const names = ({ meta }: { meta: unknown }) =>
    z.object({ refundId: z.literal(refundId) }).safeParse(meta).success
  return {
    known: refundId === null ? entries.length > 0 : entries.some(names),
    optionLeftOpen: unappliedOptions(entries[0]?.meta) !== null,
  }
}

/**
 * Returns the payment of a paid order to the customer, the whole amount, on an operator's
 * decision, and reports where the refund stands. Safe to call again: a second call never makes
 * a second refund — it finds the refund of the first by the id on the order and reads it back.
 *
 * `succeeded` makes the order `refunded` with the moment and the amount; `pending` leaves it
 * paid until the notification (`settleRefund`) or the next call; `canceled` leaves it paid and
 * forgets the refund: the next call asks anew, under a key of its own (`refundKey`).
 *
 * A payment of which money has already gone back is never asked for anew. When all of it has
 * gone back and the order keeps no refund, the request is repeated once under the order's key
 * and the platform's own refund, if that is what returned the money, is taken (`lostRefund`);
 * otherwise the call is refused. `refundedInCabinet` is the operator's word that the whole
 * payment was returned in the ЮKassa cabinet: no refund is asked for, and once the shop
 * confirms that all of it has gone back the order is marked refunded without a refund id.
 *
 * `endSubscription` and `takeCredits` act only once the order is refunded, in the same
 * transaction when this call refunds it, and in a call of their own for an order that was
 * refunded before. Without them only the money moves. Each acts once.
 *
 * Refused with BILLING_ORDER_NOT_FOUND and with a CONFLICT whose message is one of
 * `refundRefusals`; whatever the shop threw is thrown on. A refusal changes nothing.
 * The audit entry `billing.order.refund` names the operator and the reason. It is written by
 * every call that changed something, for every refund the operator's calls have met, and by
 * a call for a refunded order whose newest entry left an option unapplied — so that the newest
 * entry always says what the operator asked for last. A repeat that found nothing to do writes
 * none.
 */
export async function refundOrder(deps: RefundDeps, input: RefundOrderInput): Promise<OrderRefund> {
  const request = refundInputSchema.parse(input)
  const { prisma } = deps
  const order = await prisma.order.findUnique({ where: { id: request.orderId } })
  if (order === null) throw billingOrderNotFound()
  if (order.status !== 'paid' && order.status !== 'refunded') {
    throw conflict(refundRefusals.notPaid)
  }
  await checkOptions(prisma, order, request)

  // Outside the transaction: the shop is never called while a row is locked.
  const viaCabinet = order.status === 'paid' && request.refundedInCabinet
  if (viaCabinet) await confirmCabinetRefund(deps, order)
  const asked =
    order.status === 'paid' && !viaCabinet ? await findOrRequestRefund(deps, order) : null
  const now = deps.now?.() ?? new Date()

  return prisma.$transaction(
    async (tx) => {
      const current = await lockOrder(tx, order.id)
      const refund = asked?.refund ?? null
      const requested = asked?.requested ?? false
      // Whatever happened to the order while the shop was asked, it is settled only with a
      // refund of its own payment and amount, and never with another than the one it keeps.
      const own =
        refund === null ||
        (refundIsOrders(current, refund) &&
          (current.yookassaRefundId === null || current.yookassaRefundId === refund.id))
      if (!own) throw conflict(refundRefusals.refundMismatch)

      // What this call does to the order row: at most one of the four.
      let settled = false
      let kept = false
      let forgotten = false
      let cabinet = false
      if (viaCabinet && current.status === 'paid') {
        // A run that asked for a refund stored it while the shop was read back here.
        if (current.yookassaRefundId !== null) throw conflict(refundRefusals.cabinetOwnRefund)
        cabinet = await markRefundedInCabinet(tx, current, now)
        settled = cabinet
      } else if (refund !== null && current.status === 'paid') {
        if (refund.status === 'succeeded') {
          settled = await markRefunded(tx, current, refund, now)
        } else if (refund.status === 'pending') {
          kept = current.yookassaRefundId === null
          if (kept) {
            await tx.order.update({
              where: { id: current.id },
              data: { yookassaRefundId: refund.id },
            })
          }
        } else if (current.yookassaRefundId !== null) {
          // A cancelled refund moved no money and never will: the order is free to be asked
          // for again, under the next key.
          await tx.order.update({ where: { id: current.id }, data: { yookassaRefundId: null } })
          forgotten = true
        }
      }
      const refunded = settled || current.status === 'refunded'
      const state = refunded ? 'refunded' : refund?.status === 'canceled' ? 'canceled' : 'pending'

      const tariff =
        refunded && request.endSubscription
          ? await endTariff(tx, current, { operator: request.operator, now })
          : null
      const credits =
        refunded && request.takeCredits ? await takePackCredits(tx, current, request.reason) : null

      const refundId = refund?.id ?? current.yookassaRefundId
      const amount = current.amount.toFixed(2)
      const changed =
        settled || kept || forgotten || tariff?.outcome === 'ended' || credits?.outcome === 'taken'
      const before = await operatorEntries(tx, current.id, refundId)
      if (changed || !before.known || (refunded && before.optionLeftOpen)) {
        await writeBillingAudit(tx, {
          actor: { type: 'operator', id: request.operator },
          workspaceId: current.workspaceId,
          action: refundAuditActions.refund,
          target: { type: 'order', id: current.id },
          meta: {
            reason: request.reason,
            refundId: refundId === null ? null : clip(refundId, 64),
            paymentId: current.yookassaPaymentId,
            amount,
            refundStatus: refunded ? 'succeeded' : state,
            orderStatus: refunded ? 'refunded' : current.status,
            requested,
            settled,
            // Marked refunded on the shop's report of a refund made in the cabinet.
            cabinet,
            ...(refund?.cancellation_details === undefined
              ? {}
              : {
                  cancellationParty: clip(refund.cancellation_details.party, 64),
                  cancellationReason: clip(refund.cancellation_details.reason, 64),
                }),
            // What the operator asked for besides the money, and what came of it.
            endSubscription: request.endSubscription,
            takeCredits: request.takeCredits,
            moneyOnly: !request.endSubscription && !request.takeCredits,
            tariff: tariff?.outcome ?? null,
            expiredCredits: tariff?.outcome === 'ended' ? tariff.expiredCredits : 0,
            credits: credits?.outcome ?? null,
            takenCredits: credits?.outcome === 'taken' ? credits.credits : 0,
          },
        })
      }
      return {
        orderId: current.id,
        state,
        refundId,
        amount,
        requested,
        settled,
        cabinet,
        cancellation: state === 'canceled' ? (refund?.cancellation_details ?? null) : null,
        tariff,
        credits,
      } satisfies OrderRefund
    },
    { isolationLevel: 'ReadCommitted' },
  )
}

// ─── A notification of a refund ───────────────────────────────────────────────

/** A refund that is not the platform's own: one entry with its amounts, however often seen. */
async function recordOutsideRefund(tx: BillingTx, order: Order, refund: Refund): Promise<void> {
  const refundId = clip(refund.id, 64)
  const known = await tx.auditLog.findFirst({
    where: {
      action: refundAuditActions.refundOutside,
      targetType: 'order',
      targetId: order.id,
      meta: { path: ['refundId'], equals: refundId },
    },
    select: { id: true },
  })
  if (known !== null) return
  await writeBillingAudit(tx, {
    actor: SYSTEM_ACTOR,
    workspaceId: order.workspaceId,
    action: refundAuditActions.refundOutside,
    target: { type: 'order', id: order.id },
    meta: {
      refundId,
      paymentId: clip(refund.payment_id, 64),
      refundAmount: refund.amount.value,
      refundCurrency: refund.amount.currency,
      orderAmount: order.amount.toFixed(2),
      orderStatus: order.status,
      // The refund of its own the order keeps, when it has one: this one is another.
      ownRefundId: order.yookassaRefundId,
    },
  })
}

/**
 * Reads a refund back and applies it to the order whose payment it returns: what a
 * `refund.succeeded` notification leads to. The id is all a notification is trusted with. Safe
 * to call any number of times and at once.
 *
 * The platform's own refund, once `succeeded`, makes its order `refunded`; nothing else of the
 * order's workspace changes — the customer's rights are the operator's decision
 * (`refundOrder`). A succeeded refund the platform did not ask for — made in the ЮKassa
 * cabinet — changes nothing and leaves one audit entry with its amounts, for an operator to
 * reconcile by hand. `unknown` when ЮKassa does not know the refund or no order holds its
 * payment, which is not an error. Throws whatever the API call threw: the caller decides
 * whether to ask again.
 */
export async function settleRefund(
  deps: RefundSettlementDeps,
  input: { refundId: string },
): Promise<RefundSettlement> {
  const { refundId } = settleRefundInputSchema.parse(input)
  // orders.yookassa_refund_id is varchar(64): a longer id is not a refund of a payment of ours.
  if (refundId.length > 64) return { state: 'unknown' }
  const { prisma, yookassa } = deps
  let refund: Refund
  try {
    refund = await yookassa.getRefund(refundId)
  } catch (error) {
    if (!(error instanceof YookassaApiError && error.status === 404)) throw error
    return { state: 'unknown' }
  }
  // An answer about another refund says nothing of this one.
  if (refund.id !== refundId || refund.payment_id.length > 64) return { state: 'unknown' }
  const order =
    (await prisma.order.findUnique({ where: { yookassaRefundId: refund.id } })) ??
    (await prisma.order.findUnique({ where: { yookassaPaymentId: refund.payment_id } }))
  if (order === null) return { state: 'unknown' }
  // No money has moved, and a cancelled refund never moves any.
  if (refund.status !== 'succeeded') return { state: refund.status, orderId: order.id }

  const now = deps.now?.() ?? new Date()
  return prisma.$transaction(
    async (tx): Promise<RefundSettlement> => {
      const current = await lockOrder(tx, order.id)
      if (!refundIsOwn(current, refund)) {
        await recordOutsideRefund(tx, current, refund)
        return { state: 'outside', orderId: current.id }
      }
      if (current.status === 'paid') {
        const adopted = current.yookassaRefundId === null
        await markRefunded(tx, current, refund, now)
        await writeBillingAudit(tx, {
          actor: SYSTEM_ACTOR,
          workspaceId: current.workspaceId,
          action: refundAuditActions.refundSettled,
          target: { type: 'order', id: current.id },
          meta: {
            refundId: clip(refund.id, 64),
            paymentId: current.yookassaPaymentId,
            amount: refund.amount.value,
            // The notification came before the command had stored the refund it asked for.
            adopted,
          },
        })
      }
      return { state: 'refunded', orderId: current.id }
    },
    { isolationLevel: 'ReadCommitted' },
  )
}

// ─── Money that waits to be returned ──────────────────────────────────────────

/** An order whose money has to go back and has not, by its `billing.order.refund_needed` entry. */
export interface RefundNeeded {
  orderId: string
  workspaceId: string
  orderStatus: OrderStatus
  kind: OrderKind
  /** Why the money was not applied: one of `refundReasons`; null for an entry of another shape. */
  reason: string | null
  paymentId: string | null
  /** RUB, two decimals, like every amount below. */
  orderAmount: string
  /** What the customer paid; null for an entry of another shape. */
  paidAmount: string | null
  /** What had already gone back when the entry was written. */
  refundedBefore: string
  /** What refunds made outside the platform have returned, by their audit entries. */
  refundedOutside: string
  /**
   * What the records know to have gone back: the larger of the two above. Each is a lower bound
   * of the whole, and a refund made in the cabinet before the entry was written is in both
   * once its notification was processed — so they are never added up.
   */
  returned: string
  /**
   * What is still to return, by `returned`; null when the entry does not tell what was paid.
   * Never less than is owed; more when the notification of an early cabinet refund was lost.
   */
  toReturn: string | null
  /**
   * `refundOrder` can return it: the order is paid and nothing of its payment has gone back.
   * false: the order was closed without the money, or a part has been returned — the rest is
   * returned in the ЮKassa cabinet, and its notification closes the entry.
   */
  byCommand: boolean
  flaggedAt: Date
}

/**
 * A renewal charge that was given up without an answer (`billing.renewal.unknown_result`) and
 * that nobody has resolved: the shop may hold the customer's money under a payment whose id
 * the platform never learnt.
 */
export interface UnknownCharge {
  orderId: string
  workspaceId: string
  subscriptionId: string | null
  /** RUB, two decimals: what the charge asked for. */
  amount: string
  /** The Idempotence-Key the shop was asked under: `renew.<subscriptionId>.<period end, ms>`. */
  idempotenceKey: string
  /** The first request was made at this moment; its repeats went on for twelve hours. */
  orderCreatedAt: Date
  /** When the order was given up. */
  flaggedAt: Date
}

/** A refunded order whose operator asked for an option while the refund was still pending. */
export interface UnappliedRefundOption {
  orderId: string
  workspaceId: string
  kind: OrderKind
  /** `endSubscription` was asked for and the tariff was left alone. */
  endSubscription: boolean
  /** `takeCredits` was asked for and the credits were left alone. */
  takeCredits: boolean
  refundedAt: Date | null
  /** When the operator asked. */
  askedAt: Date
}

export interface RefundsNeeded {
  /** The oldest first: the money that has waited longest. */
  items: RefundNeeded[]
  /** There are more open entries than `limit`. */
  more: boolean
  /** The oldest first. An entry is closed by a fact only (`listRefundsNeeded`). */
  unknownCharges: UnknownCharge[]
  moreUnknownCharges: boolean
  /** The oldest request first. */
  unappliedOptions: UnappliedRefundOption[]
  moreUnappliedOptions: boolean
}

/** How many entries one listing holds at most. */
export const MAX_REFUNDS_NEEDED = 500

const listInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(MAX_REFUNDS_NEEDED).default(100),
})

const amountValue = z.string().regex(/^\d{1,10}\.\d{2}$/)
// What `refundEntry` of settlement.ts writes.
const refundNeededMetaSchema = z.object({
  reason: z.string(),
  paidAmount: amountValue,
  refundedAmount: amountValue.nullable(),
})
const refundOutsideMetaSchema = z.object({ refundAmount: amountValue })

interface RefundNeededRow {
  createdAt: Date
  workspaceId: string
  meta: unknown
  orderId: string
  status: string
  kind: string
  amount: { toFixed(digits: number): string }
  paymentId: string | null
}

interface UnknownChargeRow {
  flaggedAt: Date
  workspaceId: string
  orderId: string
  subscriptionId: string | null
  amount: { toFixed(digits: number): string }
  idempotenceKey: string
  orderCreatedAt: Date
}

/** One more row than `limit` is read: the extra one only tells that there is more. */
async function unknownCharges(prisma: PrismaClient, limit: number) {
  const rows = await prisma.$queryRaw<UnknownChargeRow[]>`
    SELECT a.created_at AS "flaggedAt", a.workspace_id AS "workspaceId", o.id AS "orderId",
      o.subscription_id AS "subscriptionId", o.amount, o.idempotence_key AS "idempotenceKey",
      o.created_at AS "orderCreatedAt"
    FROM audit_log a
    JOIN orders o ON o.id::text = a.target_id
    WHERE a.actor_type = 'system' AND a.actor_id = ${SYSTEM_ACTOR.id}
      AND a.action = ${renewalAuditActions.unknownResult} AND a.target_type = 'order'
      AND o.status = 'failed' AND o.failure_reason = ${orderFailureReasons.unknownResult}
      AND o.yookassa_payment_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM audit_log c
        WHERE c.action = ${renewalAuditActions.unknownResultChecked}
          AND c.target_type = 'order' AND c.target_id = a.target_id
      )
    ORDER BY a.created_at, a.id
    LIMIT ${limit + 1}::int
  `
  return {
    unknownCharges: rows.slice(0, limit).map((row): UnknownCharge => ({
      orderId: row.orderId,
      workspaceId: row.workspaceId,
      subscriptionId: row.subscriptionId,
      amount: row.amount.toFixed(2),
      idempotenceKey: row.idempotenceKey,
      orderCreatedAt: row.orderCreatedAt,
      flaggedAt: row.flaggedAt,
    })),
    moreUnknownCharges: rows.length > limit,
  }
}

interface NewestRefundEntryRow {
  orderId: string
  workspaceId: string
  kind: string
  refundedAt: Date | null
  askedAt: Date
  meta: unknown
}

/** The refunded orders whose newest operator's entry left an option unapplied. */
async function unappliedRefundOptions(prisma: PrismaClient, limit: number) {
  const rows = await prisma.$queryRaw<NewestRefundEntryRow[]>`
    SELECT DISTINCT ON (o.id) o.id AS "orderId", o.workspace_id AS "workspaceId",
      o.kind::text AS kind, o.refunded_at AS "refundedAt", a.created_at AS "askedAt", a.meta
    FROM audit_log a
    JOIN orders o ON o.id::text = a.target_id
    WHERE a.actor_type = 'operator' AND a.action = ${refundAuditActions.refund}
      AND a.target_type = 'order' AND o.status = 'refunded'
    ORDER BY o.id, a.created_at DESC, a.id DESC
  `
  const open: UnappliedRefundOption[] = []
  for (const row of rows) {
    const options = unappliedOptions(row.meta)
    if (options === null) continue
    open.push({
      orderId: row.orderId,
      workspaceId: row.workspaceId,
      kind: orderKindSchema.parse(row.kind),
      ...options,
      refundedAt: row.refundedAt,
      askedAt: row.askedAt,
    })
  }
  open.sort(
    (a, b) => a.askedAt.getTime() - b.askedAt.getTime() || a.orderId.localeCompare(b.orderId),
  )
  return { unappliedOptions: open.slice(0, limit), moreUnappliedOptions: open.length > limit }
}

/**
 * What waits for an operator, each kind up to `limit`. Reads only.
 *
 * `items`: the orders whose money waits to be returned — every `billing.order.refund_needed`
 * entry that is still open. An entry is closed by the refund of its order (`refundOrder`), or
 * by refunds made in the ЮKassa cabinet that return what the entry asked for.
 *
 * `unknownCharges`: the renewal charges that were given up without an answer. An entry is
 * closed by a fact only: the payment is attached to its order (a late notification or
 * `settleOrderByPaymentId` by hand — money that came then appears in `items`), or an operator
 * records that the shop holds no such payment (`closeUnknownCharge`).
 *
 * `unappliedOptions`: the refunded orders whose operator asked for `endSubscription` or
 * `takeCredits` while the refund was pending. The notification of the refund moved only the
 * order; the option waits for the operator's next call of `refundOrder`, with it or without.
 */
export async function listRefundsNeeded(
  deps: Pick<BillingDeps, 'prisma'>,
  input: { limit?: number } = {},
): Promise<RefundsNeeded> {
  const { limit } = listInputSchema.parse(input)
  const { prisma } = deps
  const rows = await prisma.$queryRaw<RefundNeededRow[]>`
    SELECT a.created_at AS "createdAt", a.workspace_id AS "workspaceId", a.meta,
      o.id AS "orderId", o.status::text AS status, o.kind::text AS kind, o.amount,
      o.yookassa_payment_id AS "paymentId"
    FROM audit_log a
    JOIN orders o ON o.id::text = a.target_id
    WHERE a.actor_type = 'system' AND a.actor_id = ${SYSTEM_ACTOR.id}
      AND a.action = ${settlementAuditActions.refundNeeded} AND a.target_type = 'order'
      AND o.status <> 'refunded'
    ORDER BY a.created_at, a.id
  `
  const outside = await prisma.auditLog.findMany({
    where: {
      action: refundAuditActions.refundOutside,
      targetType: 'order',
      targetId: { in: rows.map((row) => row.orderId) },
    },
    select: { targetId: true, meta: true },
  })
  const returnedOutside = new Map<string, Decimal>()
  for (const entry of outside) {
    const meta = refundOutsideMetaSchema.safeParse(entry.meta)
    if (entry.targetId === null || !meta.success) continue
    const sum = returnedOutside.get(entry.targetId) ?? new Money(0)
    returnedOutside.set(entry.targetId, sum.plus(meta.data.refundAmount))
  }

  const open: RefundNeeded[] = []
  for (const row of rows) {
    const meta = refundNeededMetaSchema.safeParse(row.meta)
    const refundedBefore = new Money(meta.success ? (meta.data.refundedAmount ?? 0) : 0)
    const refundedOutside = returnedOutside.get(row.orderId) ?? new Money(0)
    // Not the sum: a cabinet refund made before the entry was written is in both numbers.
    const returned = Money.max(refundedBefore, refundedOutside)
    const toReturn = meta.success ? new Money(meta.data.paidAmount).minus(returned) : null
    // Everything the entry asked for has gone back.
    if (toReturn !== null && !toReturn.greaterThan(0)) continue
    const orderStatus = orderStatusSchema.parse(row.status)
    open.push({
      orderId: row.orderId,
      workspaceId: row.workspaceId,
      orderStatus,
      kind: orderKindSchema.parse(row.kind),
      reason: meta.success ? meta.data.reason : null,
      paymentId: row.paymentId,
      orderAmount: row.amount.toFixed(2),
      paidAmount: meta.success ? meta.data.paidAmount : null,
      refundedBefore: refundedBefore.toFixed(2),
      refundedOutside: refundedOutside.toFixed(2),
      returned: returned.toFixed(2),
      toReturn: toReturn === null ? null : toReturn.toFixed(2),
      byCommand: orderStatus === 'paid' && refundedBefore.isZero() && refundedOutside.isZero(),
      flaggedAt: row.createdAt,
    })
  }
  return {
    items: open.slice(0, limit),
    more: open.length > limit,
    ...(await unknownCharges(prisma, limit)),
    ...(await unappliedRefundOptions(prisma, limit)),
  }
}

// ─── A charge without an answer ───────────────────────────────────────────────

/** What `closeUnknownCharge` did. */
export interface UnknownChargeClosed {
  orderId: string
  /** This call closed the entry; false: an earlier call had. */
  recorded: boolean
}

/**
 * Closes the entry of a renewal charge that was given up without an answer, on an operator's
 * word: they looked in the shop and it holds no payment of the order. The order is left as it
 * is; one entry `billing.renewal.unknown_result_checked` with the operator and the reason takes
 * it off the list of `listRefundsNeeded`. Safe to call again.
 *
 * Only for an order that is on that list: BILLING_ORDER_NOT_FOUND, or a CONFLICT with
 * `refundRefusals.notUnknownCharge` — the order is no failed renewal with `unknown_result`, or
 * a payment has been attached to it since (then the payment tells what is owed).
 */
export async function closeUnknownCharge(
  deps: Pick<BillingDeps, 'prisma'>,
  input: { orderId: string; operator: string; reason: string },
): Promise<UnknownChargeClosed> {
  const request = unknownChargeInputSchema.parse(input)
  return deps.prisma.$transaction(
    async (tx) => {
      const order = await tx.order.findUnique({ where: { id: request.orderId } })
      if (order === null) throw billingOrderNotFound()
      const current = await lockOrder(tx, order.id)
      const about = { targetType: 'order', targetId: current.id } as const
      const givenUp =
        current.status === 'failed' &&
        current.failureReason === orderFailureReasons.unknownResult &&
        current.yookassaPaymentId === null &&
        (await tx.auditLog.findFirst({
          where: { action: renewalAuditActions.unknownResult, ...about },
          select: { id: true },
        })) !== null
      if (!givenUp) throw conflict(refundRefusals.notUnknownCharge)
      const closed = await tx.auditLog.findFirst({
        where: { action: renewalAuditActions.unknownResultChecked, ...about },
        select: { id: true },
      })
      if (closed !== null) return { orderId: current.id, recorded: false }
      await writeBillingAudit(tx, {
        actor: { type: 'operator', id: request.operator },
        workspaceId: current.workspaceId,
        action: renewalAuditActions.unknownResultChecked,
        target: { type: 'order', id: current.id },
        meta: {
          reason: request.reason,
          // What the operator found: the shop holds no payment of this order.
          found: false,
          subscriptionId: current.subscriptionId,
          amount: current.amount.toFixed(2),
          idempotenceKey: current.idempotenceKey,
        },
      })
      return { orderId: current.id, recorded: true }
    },
    { isolationLevel: 'ReadCommitted' },
  )
}
