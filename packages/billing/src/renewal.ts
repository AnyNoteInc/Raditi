import { Prisma, type Order, type PrismaClient } from '@repo/db'
import { nextSubscriptionStatus, paymentMethodLabel } from '@repo/domain'
import { enqueueNotification, notificationCatalog } from '@repo/notifications'
import { YookassaApiError, YookassaError, type Payment, type YookassaClient } from '@repo/yookassa'
import { z } from 'zod'

import type { BillingTx } from './accounts.ts'
import { writeBillingAudit } from './audit.ts'
import { orderFailureReasons } from './failure-text.ts'
import { expireTariffRemainder } from './ledger.ts'
import { getCreditBalances } from './read-models.ts'
import { renewalKey, renewedPeriodEnd } from './renewal-order.ts'
import {
  applyPayment,
  enqueueFailureLetter,
  failRenewal,
  findWorkspaceOwner,
  periodAfter,
  recordLatePayment,
  renewalAuditActions,
  settleOrderRow,
  storedSettlement,
  type RenewalFailure,
  type SettledOrder,
} from './settlement.ts'

// Renewal: what keeps a subscription moving when nobody opens the cabinet. Four passes, run
// by the scheduler of the core role on every tick, each over the rows that are due:
//
//   sendRenewalNotices  — tells the owner of the coming charge, once per period;
//   chargeRenewals      — charges the saved payment method when the period has ended;
//   settleStuckOrders   — finishes orders whose payment has had no outcome for a while;
//   endPeriods          — ends the tariffs that are not renewed, and the overdue ones.
//
// A pass reads its due rows in ordered batches and gives every row a transaction of its own,
// in which the row is locked with FOR UPDATE SKIP LOCKED and checked again. Two ticks at once,
// or two core processes, pass each other's rows by, and whatever a pass did is on the row when
// the next one looks: nothing happens twice. The shop is never called inside a transaction.

/** The four passes. */
export const renewalJobs = ['notices', 'charges', 'stuck_orders', 'period_ends'] as const
export type RenewalJob = (typeof renewalJobs)[number]

export interface RenewalSettings {
  /** BILLING_RENEWAL_NOTICE_DAYS: how long before the end of a period its notice goes out. */
  noticeDays: number
  /** BILLING_PAST_DUE_DAYS: how long an overdue tariff waits for a payment before it ends. */
  pastDueDays: number
  /** Rows of one batch; 50 unless given. */
  batchSize?: number
  /** Batches of one pass; what is still due after them waits for the next tick. 20 unless given. */
  maxBatches?: number
}

/** A row a pass could not finish. The pass goes on; the next tick meets the row again. */
export interface RenewalFailureReport {
  job: RenewalJob
  /** The subscription, or for `stuck_orders` the order. */
  id: string
  error: unknown
}

export interface RenewalDeps {
  /** The process-wide client: every row gets a transaction of its own. */
  prisma: PrismaClient
  /**
   * The shop; null while payments are off. Then nobody is charged or told of a charge and no
   * order is touched: only the tariffs without auto-renewal still end.
   */
  yookassa: Pick<YookassaClient, 'chargeWithSavedMethod' | 'getPayment'> | null
  /** Public origin of the app (APP_URL), no trailing slash: the letters link to it. */
  appUrl: string
  /** The clock; the system one unless given. */
  now?: () => Date
  settings: RenewalSettings
  /** Called for every row a pass could not finish, for the log. Must not throw. */
  onError?: (report: RenewalFailureReport) => void
  /**
   * Aborted when the process is shutting down: the pass finishes the row it is at and stops.
   * Whatever it left is done by the next tick.
   */
  signal?: AbortSignal
}

export interface RenewalPass<Outcome extends string> {
  /** How many rows ended each way; `failed` — the row threw and was reported. */
  counts: Record<Outcome | 'failed', number>
  /** false: the pass stopped before it ran out of due rows; the next tick goes on. */
  complete: boolean
}

/** audit_log actions the passes write themselves; a renewal's own are `renewalAuditActions`. */
export const renewalJobAuditActions = {
  /** The notice of the coming charge was put into the outbox. */
  notice: 'billing.renewal.notice',
  /**
   * Auto-renewal was switched off by the platform: the customer cannot be told of the charge,
   * or there is nothing to charge for. The tariff ends with its period.
   */
  autoRenewalStop: 'billing.auto_renewal.stop',
  /** The tariff ended: not renewed at the end of its period, or overdue for too long. */
  subscriptionEnd: 'billing.subscription.end',
} as const

/** Why the platform switched auto-renewal off: `meta.reason` of the entry. */
export const autoRenewalStopReasons = {
  /** The workspace has no owner to write to. */
  noRecipient: 'no_recipient',
  /** The letter cannot be written to this owner. */
  letterRefused: 'letter_refused',
  /** The plan of the coming period cannot be charged for: no price or no monthly quota. */
  planUnavailable: 'plan_unavailable',
  /**
   * The period the charge would pay for is already over: nobody could charge for longer than
   * a whole period. Charging now would take the money for a month that has passed, and then
   * for the next one at once.
   */
  periodMissed: 'period_missed',
} as const
type AutoRenewalStopReason = (typeof autoRenewalStopReasons)[keyof typeof autoRenewalStopReasons]

/** The key of the «tariff ended» letter in the outbox: a subscription ends once. */
export const subscriptionEndedLetterKey = (subscriptionId: string) =>
  `billing.subscription_ended:${subscriptionId}`

/** An unfinished order is left alone until its payment has had this long to end by itself. */
export const STUCK_ORDER_AFTER_MS = 5 * 60_000
/**
 * How long a checkout that never stored a payment is left to its customer. A ЮKassa payment
 * page lives one hour: a request that was on its way when the checkout broke off has ended by
 * then, whatever became of it.
 */
export const ABANDONED_CHECKOUT_AFTER_MS = 60 * 60_000
/**
 * How long a renewal charge that got no answer is repeated under its key. ЮKassa keeps an
 * Idempotence-Key for 24 hours; a repeat after that would be a second charge.
 */
export const RENEWAL_RETRY_WINDOW_MS = 12 * 60 * 60_000
/**
 * A charge without an answer is given up this long after the last moment it could be
 * repeated: longer than a request may still be on its way.
 */
export const RENEWAL_GIVE_UP_MARGIN_MS = 5 * 60_000
/** A pass stops calling the shop after this many requests in a row got no answer. */
const MAX_UNANSWERED = 3

const DAY_MS = 24 * 60 * 60_000
const DEFAULT_BATCH_SIZE = 50
const DEFAULT_MAX_BATCHES = 20
const SYSTEM_ACTOR = { type: 'system', id: 'billing' } as const

// ЮKassa keeps the description with the payment and takes at most 128 characters.
const chargeDescription = (planName: string) =>
  `Радити: продление тарифа «${planName}»`.slice(0, 128)

const clock = (deps: Pick<RenewalDeps, 'now'>) => deps.now?.() ?? new Date()

// ─── What is due ──────────────────────────────────────────────────────────────

/** A saved method and no «do not renew»: the period is paid for automatically when it ends. */
const AUTO_RENEWAL = Prisma.sql`(s.payment_method_id IS NOT NULL AND NOT s.cancel_at_period_end)`

/**
 * An order of the subscription whose payment may still be made: nothing is decided past it.
 * Either the order holds a payment without an outcome, or it is a renewal whose charge got no
 * answer — `settleStuckOrders` ends both in a bounded time. An order that never got a payment
 * and is not a renewal holds nothing up: its checkout broke off, and nobody can pay it.
 */
const PAYMENT_ON_ITS_WAY = Prisma.sql`EXISTS (
  SELECT 1 FROM orders o
  WHERE o.subscription_id = s.id AND o.kind = 'subscription' AND o.status = 'pending'
    AND (o.yookassa_payment_id IS NOT NULL OR o.idempotence_key LIKE 'renew.%')
)`

/** The period ends soon, or has ended, and its notice is not in the outbox. */
const noticeDue = (before: Date) => Prisma.sql`
  s.status = 'active' AND ${AUTO_RENEWAL}
  AND s.current_period_end <= ${before}::timestamptz
  AND s.renewal_notice_period_end IS DISTINCT FROM s.current_period_end`

/** The period has ended, its notice is recorded and no charge has been started for it. */
const chargeDue = (now: Date) => Prisma.sql`
  s.status = 'active' AND ${AUTO_RENEWAL}
  AND s.current_period_end <= ${now}::timestamptz
  AND s.renewal_notice_period_end = s.current_period_end
  AND NOT ${PAYMENT_ON_ITS_WAY}`

/**
 * The tariff is over: its period ended and is not renewed, or it has been overdue for the
 * whole grace. Not while a payment for it is on its way — that payment decides. `overdueSince`
 * is null while payments are off: an overdue customer who has no way to pay is not expired.
 */
const endDue = (now: Date, overdueSince: Date | null) => Prisma.sql`
  ((s.status = 'active' AND s.current_period_end <= ${now}::timestamptz AND NOT ${AUTO_RENEWAL})
    OR (s.status = 'past_due' AND ${overdueSince}::timestamptz IS NOT NULL
      AND COALESCE(s.past_due_since, s.current_period_end) <= ${overdueSince}::timestamptz))
  AND NOT ${PAYMENT_ON_ITS_WAY}`

interface DueSubscription {
  id: string
  workspaceId: string
  status: 'active' | 'past_due'
  planId: string
  nextPlanId: string | null
  currentPeriodEnd: Date
  periodAnchor: Date
  paymentMethodId: string | null
  paymentMethodType: string | null
  paymentMethodCardType: string | null
  paymentMethodLast4: string | null
}

/** The ids of the next batch of due subscriptions, the earliest period end first. */
async function dueSubscriptions(
  prisma: PrismaClient,
  due: Prisma.Sql,
  seen: readonly string[],
  limit: number,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT s.id FROM subscriptions s
    WHERE ${due} AND NOT (s.id = ANY(${[...seen]}::uuid[]))
    ORDER BY s.current_period_end, s.id
    LIMIT ${limit}::int
  `
  return rows.map(({ id }) => id)
}

/**
 * The subscription, locked for the rest of the transaction, if it is still due and nobody
 * else holds it. Undefined otherwise: another pass is at it, or it is not due any more.
 */
async function lockDue(
  tx: Pick<BillingTx, '$queryRaw'>,
  id: string,
  due: Prisma.Sql,
): Promise<DueSubscription | undefined> {
  const [row] = await tx.$queryRaw<DueSubscription[]>`
    SELECT s.id, s.workspace_id AS "workspaceId", s.status::text AS status,
      s.plan_id AS "planId", s.next_plan_id AS "nextPlanId",
      s.current_period_end AS "currentPeriodEnd", s.period_anchor AS "periodAnchor",
      s.payment_method_id AS "paymentMethodId", s.payment_method_type AS "paymentMethodType",
      s.payment_method_card_type AS "paymentMethodCardType",
      s.payment_method_last4 AS "paymentMethodLast4"
    FROM subscriptions s
    WHERE s.id = ${id}::uuid AND ${due}
    FOR UPDATE OF s SKIP LOCKED
  `
  return row
}

// ─── A pass ───────────────────────────────────────────────────────────────────

type Counts<Outcome extends string> = { [K in Outcome | 'failed']: number }

const zeroCounts = <Outcome extends string>(outcomes: readonly Outcome[]) =>
  Object.fromEntries([...outcomes, 'failed'].map((outcome) => [outcome, 0])) as Counts<Outcome>

/**
 * Runs one pass: batch after batch of due ids, each handled on its own, until a batch comes
 * back short, the batch limit is reached or `stopped` says the pass cannot go on. An id is
 * looked at once per pass, so a row that stays due — skipped, failed, waiting — never holds
 * the pass in place. A row that throws is counted as `failed` and reported; the pass goes on.
 */
async function runPass<Outcome extends string>(
  deps: RenewalDeps,
  job: RenewalJob,
  outcomes: readonly Outcome[],
  page: (seen: readonly string[], limit: number) => Promise<string[]>,
  handle: (id: string) => Promise<Outcome>,
  stopped: () => boolean = () => false,
): Promise<RenewalPass<Outcome>> {
  const batchSize = deps.settings.batchSize ?? DEFAULT_BATCH_SIZE
  const maxBatches = deps.settings.maxBatches ?? DEFAULT_MAX_BATCHES
  const counts = zeroCounts(outcomes)
  if (deps.signal?.aborted) return { counts, complete: false }
  const seen: string[] = []
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const ids = await page(seen, batchSize)
    for (const id of ids) {
      seen.push(id)
      try {
        counts[await handle(id)] += 1
      } catch (error) {
        counts.failed += 1
        deps.onError?.({ job, id, error })
      }
      if (stopped() || deps.signal?.aborted) return { counts, complete: false }
    }
    if (ids.length < batchSize) return { counts, complete: true }
  }
  return { counts, complete: false }
}

/**
 * The shop did not serve the request: no connection, a timeout, a 5xx or 429 answer — or a
 * refusal that is not about this payment: 401 (the key is not taken) and 403.
 *
 * 403 is not only «the shop does not let us in». A real shop with valid credentials answered
 * 403 `forbidden` to an operation it had no right to: saving a payment method while ЮKassa had
 * not approved its autopayments (AnyNote, 13.05.2026). A charge of a saved method was tried on
 * no such shop, so for a charge this reading is an assumption: the shop has lost, or never had,
 * the right to autopayments, most likely no payment was made, and none will be until ЮKassa
 * gives the right back. Nothing proves that no payment exists, so the order is held like any
 * other request without an answer: it stays pending and the same key is repeated while that is
 * safe. If the right comes back within that time the charge goes through; otherwise the order
 * ends as `unknown_result`, with an entry for an operator — whose hint says that after a 403
 * `forbidden` in the log there is no payment to look for and ЮKassa is the one to ask.
 */
const shopAway = (error: YookassaError): boolean =>
  error.retryable ||
  (error instanceof YookassaApiError && (error.status === 401 || error.status === 403))

/**
 * The shop refused the request itself — a 4xx that is not about our access: it made no
 * payment for this request, and would refuse the same request again.
 */
const refusedByShop = (error: YookassaError): error is YookassaApiError =>
  error instanceof YookassaApiError && error.status >= 400 && error.status < 500 && !shopAway(error)

/**
 * Counts the requests in a row that the shop did not serve. When it is down, or refuses us
 * altogether, a pass costs a few requests, not one per row: the rest waits for the next tick,
 * and the rows behind are not started. A request the shop refused for what it asked — a 4xx
 * about this payment — is an answer: one bad row does not hold up the others.
 */
function shopWatch() {
  let unserved = 0
  return {
    answered() {
      unserved = 0
    },
    failed(error: YookassaError) {
      unserved = shopAway(error) ? unserved + 1 : 0
    },
    silent: () => unserved >= MAX_UNANSWERED,
  }
}
type ShopWatch = ReturnType<typeof shopWatch>

// ─── The coming period ────────────────────────────────────────────────────────

interface ComingPlan {
  id: string
  slug: string
  name: string
  price: Prisma.Decimal
}

/**
 * The plan the next period is paid for: the scheduled one, else the current one. null when it
 * cannot be charged for — it has no price or no monthly quota. A plan taken off sale still
 * renews for those who have it.
 */
async function comingPlan(
  tx: Pick<BillingTx, 'plan'>,
  subscription: Pick<DueSubscription, 'planId' | 'nextPlanId'>,
): Promise<ComingPlan | null> {
  const plan = await tx.plan.findUnique({
    where: { id: subscription.nextPlanId ?? subscription.planId },
    select: { id: true, slug: true, name: true, kind: true, price: true, creditsPerMonth: true },
  })
  if (plan === null || plan.kind !== 'quota' || plan.creditsPerMonth === null) return null
  // orders.amount is positive.
  if (!plan.price.greaterThan(0)) return null
  return { id: plan.id, slug: plan.slug, name: plan.name, price: plan.price }
}

/** What a notice tells of the charge it announces: `meta` of its audit entry. */
const announcementSchema = z.object({
  planSlug: z.string(),
  amount: z.string(),
  chargeAt: z.string(),
})
type Announcement = z.infer<typeof announcementSchema>

/** The charge that ends the subscription's period, as its notice names it. */
const announcementOf = (
  subscription: Pick<DueSubscription, 'currentPeriodEnd'>,
  plan: Pick<ComingPlan, 'slug' | 'price'>,
): Announcement => ({
  planSlug: plan.slug,
  amount: plan.price.toFixed(2),
  chargeAt: subscription.currentPeriodEnd.toISOString(),
})

/**
 * Whether the newest notice written for the subscription announced exactly this charge: the
 * plan, the amount and the moment. The mark `renewal_notice_period_end` only says that a
 * letter was written for the period; what the letter said is in its audit entry, written in
 * the same transaction. No entry, or one that says anything else, announced nothing.
 */
async function announced(
  db: Pick<BillingTx, 'auditLog'>,
  subscriptionId: string,
  charge: Announcement,
): Promise<boolean> {
  const entry = await db.auditLog.findFirst({
    where: {
      action: renewalJobAuditActions.notice,
      targetType: 'subscription',
      targetId: subscriptionId,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { meta: true },
  })
  const said = announcementSchema.safeParse(entry?.meta)
  return (
    said.success &&
    said.data.planSlug === charge.planSlug &&
    said.data.amount === charge.amount &&
    said.data.chargeAt === charge.chargeAt
  )
}

/**
 * Whether the period a charge would pay for has already passed whole. The period runs from
 * the end of the current one, whenever the charge is made; a charge that comes a few hours or
 * days late still buys most of it. One that comes later than the period lasts would buy
 * nothing, and the next tick would charge again for the period after it.
 */
function comingPeriodMissed(
  subscription: Pick<DueSubscription, 'periodAnchor' | 'currentPeriodEnd'>,
  now: Date,
): boolean {
  const { period } = periodAfter(subscription.periodAnchor, subscription.currentPeriodEnd)
  return period.end.getTime() <= now.getTime()
}

/**
 * Switches auto-renewal off on the platform's own decision, when the charge cannot be
 * announced or made. Nothing hangs then: the tariff ends with its period like any tariff
 * without auto-renewal, and the customer can switch it on again.
 */
async function stopAutoRenewal(
  tx: BillingTx,
  subscription: DueSubscription,
  reason: AutoRenewalStopReason,
  now: Date,
): Promise<void> {
  await tx.subscription.update({
    where: { id: subscription.id },
    data: { cancelAtPeriodEnd: true, cancelledAt: now },
  })
  await writeBillingAudit(tx, {
    actor: SYSTEM_ACTOR,
    workspaceId: subscription.workspaceId,
    action: renewalJobAuditActions.autoRenewalStop,
    target: { type: 'subscription', id: subscription.id },
    meta: { reason, periodEnd: subscription.currentPeriodEnd.toISOString() },
  })
}

// ─── A period whose charge has failed ─────────────────────────────────────────

const closedUnpaid = (order: Pick<Order, 'status'>) =>
  order.status === 'failed' || order.status === 'cancelled'

/**
 * Reasons of ours after which «не получилось списать» may be untrue: the money came and has
 * to go back, or nobody can tell. The owner is not written to then.
 */
const MONEY_MAY_HAVE_MOVED: ReadonlySet<string> = new Set([
  orderFailureReasons.amountMismatch,
  orderFailureReasons.paymentRefunded,
  orderFailureReasons.unknownResult,
])

/**
 * The charge of the subscription's period has been made and did not bring the money, and the
 * subscription is active with auto-renewal on all the same: its order failed while
 * auto-renewal was off — the tariff was to end with its period, so nobody was told of a debt —
 * and auto-renewal has been switched on again since, or the order was closed by hand. A period
 * is charged once (the key is the period): nothing more is announced or charged for it. The
 * tariff is past due from now, and the owner is told that the charge did not go through,
 * unless the money may have moved.
 */
async function overdueAfterFailedCharge(
  tx: BillingTx,
  subscription: DueSubscription,
  order: Order,
  { now, appUrl }: { now: Date; appUrl: string },
): Promise<void> {
  const amount = order.amount.toFixed(2)
  const reason = order.failureReason ?? 'canceled'
  await tx.subscription.update({
    where: { id: subscription.id },
    data: {
      status: nextSubscriptionStatus(subscription.status, 'renewal_declined'),
      pastDueSince: now,
    },
  })
  // Nor when the money came after the order was closed: an operator is to return it.
  const moneyMoved =
    MONEY_MAY_HAVE_MOVED.has(reason) || (await storedSettlement(tx, order)).refundNeeded
  const notified = moneyMoved
    ? false
    : await enqueueFailureLetter(tx, { order, subscription, amount, appUrl })
  await writeBillingAudit(tx, {
    actor: SYSTEM_ACTOR,
    workspaceId: subscription.workspaceId,
    action: renewalAuditActions.pastDue,
    target: { type: 'subscription', id: subscription.id },
    meta: { orderId: order.id, reason, amount, pastDueSince: now.toISOString(), notified },
  })
}

// ─── Notices ──────────────────────────────────────────────────────────────────

const noticeOutcomes = ['notified', 'auto_renewal_stopped', 'past_due', 'skipped'] as const
export type NoticeOutcome = (typeof noticeOutcomes)[number]

/**
 * Tells the owner of every subscription that is about to be charged: the amount and the plan
 * of the coming period, the day and the payment method. Once per period: the letter and the
 * mark `renewal_notice_period_end` are written in one transaction, and the charge waits for
 * that mark. Whoever changes what the notice said — another plan, another payment method,
 * auto-renewal switched on again — clears the mark, and the next pass writes a new letter;
 * the charge itself compares the plan and the amount with what the letter said (`announced`).
 * A period that ended without its notice gets it here first and is charged afterwards: the
 * offer asks for a notice before each charge, not for a number of days between them. A period
 * whose charge has already failed gets no notice: its tariff is past due (`past_due`).
 */
export async function sendRenewalNotices(deps: RenewalDeps): Promise<RenewalPass<NoticeOutcome>> {
  if (deps.yookassa === null) return { counts: zeroCounts(noticeOutcomes), complete: true }
  const { prisma, appUrl } = deps
  const now = clock(deps)
  const due = noticeDue(new Date(now.getTime() + deps.settings.noticeDays * DAY_MS))
  return runPass(
    deps,
    'notices',
    noticeOutcomes,
    (seen, limit) => dueSubscriptions(prisma, due, seen, limit),
    (id) =>
      prisma.$transaction(
        async (tx): Promise<NoticeOutcome> => {
          const subscription = await lockDue(tx, id, due)
          if (subscription === undefined) return 'skipped'
          // The charge of this period has been made and failed: a letter about a charge to
          // come would not be true. The tariff is past due instead.
          const charged = await tx.order.findUnique({
            where: { idempotenceKey: renewalKey(subscription.id, subscription.currentPeriodEnd) },
          })
          if (charged !== null && closedUnpaid(charged)) {
            await overdueAfterFailedCharge(tx, subscription, charged, { now, appUrl })
            return 'past_due'
          }
          const stop = async (reason: AutoRenewalStopReason): Promise<NoticeOutcome> => {
            await stopAutoRenewal(tx, subscription, reason, now)
            return 'auto_renewal_stopped'
          }
          if (comingPeriodMissed(subscription, now)) {
            return stop(autoRenewalStopReasons.periodMissed)
          }
          const plan = await comingPlan(tx, subscription)
          if (plan === null) return stop(autoRenewalStopReasons.planUnavailable)
          const owner = await findWorkspaceOwner(tx, subscription.workspaceId)
          if (owner === null) return stop(autoRenewalStopReasons.noRecipient)
          const announcement = announcementOf(subscription, plan)
          const payload = {
            planName: plan.name,
            amount: announcement.amount,
            chargeAt: announcement.chargeAt,
            paymentMethod: paymentMethodLabel({
              type: subscription.paymentMethodType,
              cardType: subscription.paymentMethodCardType,
              last4: subscription.paymentMethodLast4,
            }),
            appUrl,
            to: owner.email,
          }
          // No charge without its notice: an owner the letter cannot be written to is not
          // charged at all.
          if (!notificationCatalog['billing.renewal_notice'].payload.safeParse(payload).success) {
            return stop(autoRenewalStopReasons.letterRefused)
          }
          // No dedupe key: the lock and the mark make it one letter per mark, and a mark that
          // was cleared asks for a letter of its own.
          await enqueueNotification('billing.renewal_notice', payload, { db: tx })
          // In SQL, column to column: a Date would lose the microseconds of the period end,
          // and the charge compares the two columns.
          await tx.$executeRaw`
            UPDATE subscriptions
            SET renewal_notice_period_end = current_period_end, updated_at = now()
            WHERE id = ${subscription.id}::uuid
          `
          // What the letter said: the charge is made only for this (`announced`).
          await writeBillingAudit(tx, {
            actor: SYSTEM_ACTOR,
            workspaceId: subscription.workspaceId,
            action: renewalJobAuditActions.notice,
            target: { type: 'subscription', id: subscription.id },
            meta: announcement,
          })
          return 'notified'
        },
        { isolationLevel: 'ReadCommitted' },
      ),
  )
}

// ─── Charges ──────────────────────────────────────────────────────────────────

/** How one charge request ended. */
type ChargeResult = 'renewed' | 'declined' | 'pending' | 'unanswered' | 'refund_needed' | 'skipped'

const chargeOutcomes = [
  'renewed',
  'declined',
  'pending',
  'unanswered',
  'refund_needed',
  'auto_renewal_stopped',
  'notice_outdated',
  'blocked',
  'skipped',
] as const
export type ChargeOutcome = (typeof chargeOutcomes)[number]

type Shop = NonNullable<RenewalDeps['yookassa']>

/** What an unfinished renewal order is charged with. */
interface Charge {
  order: Order
  paymentMethodId: string
  planName: string
  /** The order was made a moment ago: nothing has been asked under its key yet. */
  first: boolean
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

function chargeResultOf(settlement: SettledOrder): ChargeResult {
  if (settlement.refundNeeded) return 'refund_needed'
  if (settlement.state === 'paid') return 'renewed'
  return settlement.state === 'pending' ? 'pending' : 'declined'
}

/**
 * Charges the saved method for a pending renewal order under the order's own key and applies
 * what the shop answered. Outside any transaction. The outcome is read from the payment
 * object: a request the shop did not serve — no connection, a timeout, a 5xx answer, no
 * access or no right to autopayments (`shopAway`) — decides nothing; the order stays pending
 * and the same request may be sent again (`unanswered`). One exception: the shop refused the
 * first request under the key itself (`refusedByShop`). Then no payment exists and none will:
 * the order fails at once as `charge_rejected`, the tariff is past due and the owner is told,
 * as after a refusal of the bank. A refusal of a repeat decides nothing: the request before it
 * may have been served, and a repeat is not always the same request — the payment method may
 * have been replaced.
 */
async function chargeOrder(
  deps: RenewalDeps,
  shop: Shop,
  watch: ShopWatch,
  { order, paymentMethodId, planName, first }: Charge,
  report: Pick<RenewalFailureReport, 'job' | 'id'>,
): Promise<ChargeResult> {
  let payment: Payment
  try {
    payment = await shop.chargeWithSavedMethod(
      {
        amount: { value: order.amount.toFixed(2), currency: 'RUB' },
        payment_method_id: paymentMethodId,
        description: chargeDescription(planName),
        metadata: {
          order_id: order.id,
          workspace_id: order.workspaceId,
          ...(order.subscriptionId === null ? {} : { subscription_id: order.subscriptionId }),
        },
      },
      order.idempotenceKey,
    )
  } catch (error) {
    if (!(error instanceof YookassaError)) throw error
    watch.failed(error)
    if (first && refusedByShop(error)) {
      // Only while the order has no payment: an answer another pass got meanwhile wins.
      const closed = await failRenewal(deps, order, {
        failureReason: orderFailureReasons.chargeRejected,
        letter: true,
        onlyWithoutPayment: true,
        shopRefusal: { status: error.status, message: error.message },
      })
      return closed ? 'declined' : 'skipped'
    }
    deps.onError?.({ ...report, error })
    return 'unanswered'
  }
  watch.answered()

  // orders.yookassa_payment_id is varchar(64); an id of ЮKassa has 36 characters.
  if (payment.id.length > 64) throw new Error('The payment id does not fit the order')
  const stored = await deps.prisma.order.updateMany({
    where: {
      id: order.id,
      status: 'pending',
      OR: [{ yookassaPaymentId: null }, { yookassaPaymentId: payment.id }],
    },
    data: { yookassaPaymentId: payment.id },
  })
  if (stored.count === 0) {
    // The order was closed while the request was on its way. If the money came all the same,
    // it has to go back.
    const current = await deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    return (await recordLatePayment(deps.prisma, current, payment)) ? 'refund_needed' : 'skipped'
  }
  return chargeResultOf(
    await applyPayment(deps, { ...order, yookassaPaymentId: payment.id }, payment),
  )
}

/**
 * The period already has its renewal order, and the subscription is due all the same. A
 * period is charged once (the key is the period), so nothing is charged here; an order that
 * failed makes the tariff past due (`overdueAfterFailedCharge`).
 */
async function chargedBefore(
  tx: BillingTx,
  subscription: DueSubscription,
  order: Order,
  at: { now: Date; appUrl: string },
): Promise<ChargeOutcome> {
  // Committed a moment ago by another pass, which is charging it now.
  if (order.status === 'pending') return 'skipped'
  // Paid, yet the period did not move: an operator already holds a refund entry for it.
  if (!closedUnpaid(order)) return 'blocked'
  await overdueAfterFailedCharge(tx, subscription, order, at)
  return 'declined'
}

/**
 * Charges the saved payment method of every subscription whose period has ended and whose
 * notice for that period is recorded. The order of the charge is created under the lock of
 * the subscription with the key `renew.<subscriptionId>.<period end>`, for the plan and the
 * price of the coming period — only when they are the ones the notice named, else the notice
 * is written again first; then the shop is asked, outside the transaction, and its answer
 * is applied: the money came — the next period starts; the bank said no — the tariff is past
 * due; no outcome yet, or no answer — the order stays pending for `settleStuckOrders`.
 */
export async function chargeRenewals(deps: RenewalDeps): Promise<RenewalPass<ChargeOutcome>> {
  const shop = deps.yookassa
  if (shop === null) return { counts: zeroCounts(chargeOutcomes), complete: true }
  const { prisma } = deps
  const now = clock(deps)
  const due = chargeDue(now)
  const watch = shopWatch()

  /** The pending order of the charge, made under the lock of the subscription. */
  const startCharge = (id: string): Promise<Charge | ChargeOutcome> =>
    prisma.$transaction(
      async (tx) => {
        const subscription = await lockDue(tx, id, due)
        if (subscription === undefined || subscription.paymentMethodId === null) return 'skipped'
        const stop = async (reason: AutoRenewalStopReason): Promise<ChargeOutcome> => {
          await stopAutoRenewal(tx, subscription, reason, now)
          return 'auto_renewal_stopped'
        }
        if (comingPeriodMissed(subscription, now)) {
          return stop(autoRenewalStopReasons.periodMissed)
        }
        const plan = await comingPlan(tx, subscription)
        if (plan === null) return stop(autoRenewalStopReasons.planUnavailable)
        const idempotenceKey = renewalKey(subscription.id, subscription.currentPeriodEnd)
        const existing = await tx.order.findUnique({ where: { idempotenceKey } })
        if (existing !== null) {
          return chargedBefore(tx, subscription, existing, { now, appUrl: deps.appUrl })
        }
        if (!(await announced(tx, subscription.id, announcementOf(subscription, plan)))) {
          // The notice of this period named another plan or amount — the price was changed
          // since, or a change of plan was scheduled and the mark left in place — or nothing
          // records what it said. Nobody is charged what they were not told: the mark is
          // cleared, the notice pass writes a letter with what is true now, and the charge
          // follows that letter on a later tick.
          await tx.subscription.update({
            where: { id: subscription.id },
            data: { renewalNoticePeriodEnd: null },
          })
          return 'notice_outdated'
        }
        const owner = await findWorkspaceOwner(tx, subscription.workspaceId)
        const order = await tx.order.create({
          data: {
            workspaceId: subscription.workspaceId,
            userId: owner?.userId ?? null,
            kind: 'subscription',
            planId: plan.id,
            subscriptionId: subscription.id,
            amount: plan.price,
            status: 'pending',
            idempotenceKey,
            savePaymentMethod: false,
            // By the clock of the pass: the repeats of the charge are counted from it.
            createdAt: now,
          },
        })
        return {
          order,
          paymentMethodId: subscription.paymentMethodId,
          planName: plan.name,
          first: true,
        }
      },
      { isolationLevel: 'ReadCommitted' },
    )

  return runPass(
    deps,
    'charges',
    chargeOutcomes,
    (seen, limit) => dueSubscriptions(prisma, due, seen, limit),
    async (id) => {
      let started: Charge | ChargeOutcome
      try {
        started = await startCharge(id)
      } catch (error) {
        // Another unfinished subscription order of the workspace stands in the way (there is
        // one at most), or the key was taken a moment ago.
        if (isUniqueViolation(error)) return 'blocked'
        throw error
      }
      if (typeof started === 'string') return started
      return chargeOrder(deps, shop, watch, started, { job: 'charges', id })
    },
    watch.silent,
  )
}

// ─── Stuck orders ─────────────────────────────────────────────────────────────

const stuckOutcomes = [
  'paid',
  'failed',
  'pending',
  'cancelled',
  'unanswered',
  'gave_up',
  'refund_needed',
  'waiting',
  'skipped',
] as const
export type StuckOrderOutcome = (typeof stuckOutcomes)[number]

function stuckOutcomeOf(settlement: SettledOrder): StuckOrderOutcome {
  if (settlement.refundNeeded) return 'refund_needed'
  return settlement.state === 'refunded' ? 'skipped' : settlement.state
}

const stuckOutcomeOfCharge: Record<ChargeResult, StuckOrderOutcome> = {
  renewed: 'paid',
  declined: 'failed',
  pending: 'pending',
  unanswered: 'unanswered',
  refund_needed: 'refund_needed',
  skipped: 'skipped',
}

/** Nobody can tell whether the charge of the order was made: an operator looks. */
const unknownResult = (onlyWithoutPayment: boolean): RenewalFailure => ({
  failureReason: orderFailureReasons.unknownResult,
  letter: false,
  unknown: true,
  onlyWithoutPayment,
})

/**
 * Whether the order is a checkout nobody will finish: a pack, a first tariff payment or a
 * payment by hand of an overdue tariff — any order the customer starts on a page, which a
 * renewal is not — that has been without a payment for an hour. `age`: how long ago the order
 * was made, in milliseconds. The pass reads only such orders among those without a payment;
 * this is the rule itself, asked of the row before it is closed.
 */
export function abandonedCheckout(
  order: Pick<Order, 'kind' | 'subscriptionId' | 'idempotenceKey' | 'yookassaPaymentId'>,
  age: number,
): boolean {
  return (
    (order.kind === 'subscription' || order.kind === 'pack') &&
    renewedPeriodEnd(order) === null &&
    order.yookassaPaymentId === null &&
    age >= ABANDONED_CHECKOUT_AFTER_MS
  )
}

/**
 * Cancels a checkout that broke off before a payment was stored — only while it still has
 * none: a request that stores its payment at this very moment keeps its order, and one that
 * comes later finds the order closed and gives nobody a page (`requestPayment`).
 */
async function closeAbandoned(prisma: PrismaClient, order: Order): Promise<StuckOrderOutcome> {
  const closed = await prisma.order.updateMany({
    where: { id: order.id, status: 'pending', yookassaPaymentId: null },
    data: { status: 'cancelled' },
  })
  return closed.count === 1 ? 'cancelled' : 'skipped'
}

/**
 * The charge a renewal order may be repeated with, or null. A repeat is a charge like the
 * first one: the subscription has to stand where the order found it — active, in that period,
 * with auto-renewal on and its notice recorded — and the newest notice has to name the plan
 * and the amount of the order. A customer who switched auto-renewal off or replaced the
 * payment method meanwhile, or who has been told of another charge since, is not charged
 * under the old request.
 */
async function repeatableCharge(
  prisma: PrismaClient,
  order: Order,
  renewed: Date,
): Promise<Charge | null> {
  const { subscriptionId } = order
  if (subscriptionId === null || order.planId === null) return null
  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    select: {
      status: true,
      currentPeriodEnd: true,
      renewalNoticePeriodEnd: true,
      cancelAtPeriodEnd: true,
      paymentMethodId: true,
    },
  })
  const plan = await prisma.plan.findUnique({
    where: { id: order.planId },
    select: { name: true, slug: true },
  })
  if (subscription === null || plan === null) return null
  const { paymentMethodId } = subscription
  if (
    subscription.status !== 'active' ||
    subscription.cancelAtPeriodEnd ||
    paymentMethodId === null ||
    subscription.currentPeriodEnd.getTime() !== renewed.getTime() ||
    subscription.renewalNoticePeriodEnd?.getTime() !== renewed.getTime()
  ) {
    return null
  }
  const charge = announcementOf(
    { currentPeriodEnd: renewed },
    { slug: plan.slug, price: order.amount },
  )
  if (!(await announced(prisma, subscriptionId, charge))) return null
  return { order, paymentMethodId, planName: plan.name, first: false }
}

/**
 * Finishes the orders whose payment has had no outcome for a few minutes — whatever the order
 * pays for, whoever started the payment. With a payment: it is read back and applied, as a
 * notification or the return page would have done. A renewal order without one — its charge
 * got no answer — is charged again under the same key while that is safe, twelve hours; after
 * that the order fails with `unknown_result`, the subscription is past due and an operator is
 * asked to look in the shop. The order of a pack, of a first tariff payment or of a payment by
 * hand of an overdue tariff whose checkout broke off before a payment was stored is cancelled
 * after an hour: nobody holds a page to pay it on, a pack checkout never comes back to it, and
 * until it is closed it stands in the payment history as unfinished and, for a tariff, limits
 * the sites of the workspace.
 */
export async function settleStuckOrders(
  deps: RenewalDeps,
): Promise<RenewalPass<StuckOrderOutcome>> {
  const shop = deps.yookassa
  if (shop === null) return { counts: zeroCounts(stuckOutcomes), complete: true }
  const { prisma } = deps
  const now = clock(deps)
  const before = new Date(now.getTime() - STUCK_ORDER_AFTER_MS)
  const abandonedBefore = new Date(now.getTime() - ABANDONED_CHECKOUT_AFTER_MS)
  const settlementDeps = { ...deps, yookassa: shop }
  const watch = shopWatch()

  /** An order whose payment is stored: what became of the payment? */
  async function readBack(order: Order, givenUp: boolean): Promise<StuckOrderOutcome> {
    try {
      const { settlement } = await settleOrderRow(settlementDeps, order)
      watch.answered()
      return stuckOutcomeOf(settlement)
    } catch (error) {
      if (!(error instanceof YookassaError)) throw error
      if (!(error instanceof YookassaApiError && error.status === 404)) {
        watch.failed(error)
        deps.onError?.({ job: 'stuck_orders', id: order.id, error })
        return 'unanswered'
      }
    }
    // The shop does not know the payment (another shop, a stand that was restarted): nobody
    // can pay the order or learn what became of it.
    watch.answered()
    if (renewedPeriodEnd(order) === null) {
      await prisma.order.updateMany({
        where: { id: order.id, status: 'pending' },
        data: { status: 'cancelled' },
      })
      return 'cancelled'
    }
    if (!givenUp) return 'waiting'
    return (await failRenewal(deps, order, unknownResult(false))) ? 'gave_up' : 'skipped'
  }

  return runPass(
    deps,
    'stuck_orders',
    stuckOutcomes,
    async (seen, limit) => {
      // Only what the pass can move: an order that holds a payment, a renewal, or a checkout
      // the customer started on a page — a pack, a first tariff payment, a payment by hand of
      // an overdue tariff — that has been without a payment for an hour. A younger one stays
      // pending and must not fill the batches ahead of the others.
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT o.id FROM orders o
        WHERE o.status = 'pending' AND o.created_at <= ${before}::timestamptz
          AND (o.yookassa_payment_id IS NOT NULL
            OR (o.kind = 'subscription' AND o.subscription_id IS NOT NULL
              AND o.idempotence_key LIKE 'renew.%')
            OR (o.kind IN ('subscription', 'pack') AND o.idempotence_key NOT LIKE 'renew.%'
              AND o.created_at <= ${abandonedBefore}::timestamptz))
          AND NOT (o.id = ANY(${[...seen]}::uuid[]))
        ORDER BY o.created_at, o.id
        LIMIT ${limit}::int
      `
      return rows.map(({ id }) => id)
    },
    async (id) => {
      const order = await prisma.order.findUnique({ where: { id } })
      if (order === null || order.status !== 'pending') return 'skipped'
      const age = now.getTime() - order.createdAt.getTime()
      const givenUp = age >= RENEWAL_RETRY_WINDOW_MS + RENEWAL_GIVE_UP_MARGIN_MS
      if (order.yookassaPaymentId !== null) return readBack(order, givenUp)

      // No payment was ever stored: a renewal whose charge got no answer, or a checkout that
      // broke off.
      const renewed = renewedPeriodEnd(order)
      if (renewed === null) {
        return abandonedCheckout(order, age) ? closeAbandoned(prisma, order) : 'skipped'
      }
      if (givenUp) {
        return (await failRenewal(deps, order, unknownResult(true))) ? 'gave_up' : 'skipped'
      }
      if (age >= RENEWAL_RETRY_WINDOW_MS) return 'waiting'
      const charge = await repeatableCharge(prisma, order, renewed)
      if (charge === null) return 'waiting'
      const result = await chargeOrder(deps, shop, watch, charge, { job: 'stuck_orders', id })
      return stuckOutcomeOfCharge[result]
    },
    watch.silent,
  )
}

// ─── Period ends ──────────────────────────────────────────────────────────────

const periodEndOutcomes = ['cancelled', 'expired', 'skipped'] as const
export type PeriodEndOutcome = (typeof periodEndOutcomes)[number]

export interface PeriodEndPass extends RenewalPass<PeriodEndOutcome> {
  /**
   * Subscriptions with auto-renewal on whose period has ended while payments are off. They
   * stay active: nothing irreversible is decided without the shop. Zero while it is on.
   */
  waitingForShop: number
}

/**
 * Every way a row of each pass may end, `failed` included: what the counts of a pass are
 * keyed by, and the label values of a metric that counts them.
 */
export const renewalOutcomes = {
  notices: [...noticeOutcomes, 'failed'],
  charges: [...chargeOutcomes, 'failed'],
  stuck_orders: [...stuckOutcomes, 'failed'],
  period_ends: [...periodEndOutcomes, 'failed'],
} as const satisfies Record<RenewalJob, readonly string[]>

/**
 * Ends the tariffs that are over. An active subscription whose period ended and is not renewed
 * automatically becomes `cancelled`; one that has been past due for BILLING_PAST_DUE_DAYS
 * becomes `expired`. Either way what is left of the tariff quota expires — the available
 * credits only — and the owner is told, with the purchased and the gift credits that stay:
 * those are never touched. A subscription whose payment is on its way is not ended; that
 * payment decides.
 *
 * While payments are off only the first kind ends: that was the customer's choice. One who
 * would be charged, or who owes a payment and cannot make it, waits for the shop.
 */
export async function endPeriods(deps: RenewalDeps): Promise<PeriodEndPass> {
  const { prisma, appUrl } = deps
  const now = clock(deps)
  const due = endDue(
    now,
    deps.yookassa === null ? null : new Date(now.getTime() - deps.settings.pastDueDays * DAY_MS),
  )
  const pass = await runPass(
    deps,
    'period_ends',
    periodEndOutcomes,
    (seen, limit) => dueSubscriptions(prisma, due, seen, limit),
    (id) =>
      prisma.$transaction(
        async (tx): Promise<PeriodEndOutcome> => {
          const subscription = await lockDue(tx, id, due)
          if (subscription === undefined) return 'skipped'
          const { workspaceId, currentPeriodEnd } = subscription
          const overdue = subscription.status === 'past_due'
          const status = nextSubscriptionStatus(
            subscription.status,
            overdue ? 'past_due_grace_ended' : 'period_ended_without_renewal',
          )
          // Before the subscription is closed: afterwards nothing of its quota may expire.
          const expired = await expireTariffRemainder(tx, {
            workspaceId,
            subscriptionId: subscription.id,
            periodEnd: currentPeriodEnd,
          })
          await tx.subscription.update({ where: { id: subscription.id }, data: { status } })
          const left = await getCreditBalances(tx, workspaceId)
          const packCreditsLeft = left.pack.available
          const notified = await enqueueEndLetter(tx, {
            subscription,
            // A tariff that is not renewed ended with its paid period. An overdue one ends now,
            // a grace later: the day its customer was told it would end, and the day «Тарифы»
            // shows (`getEndedSubscription`).
            endedAt: overdue ? now : currentPeriodEnd,
            packCreditsLeft,
            // Gift credits take tasks without a tariff: the letter says so while they can.
            giftCreditsLeft: left.gift.available,
            appUrl,
          })
          await writeBillingAudit(tx, {
            actor: SYSTEM_ACTOR,
            workspaceId,
            action: renewalJobAuditActions.subscriptionEnd,
            target: { type: 'subscription', id: subscription.id },
            meta: {
              status,
              reason: overdue ? 'past_due_grace' : 'auto_renewal_off',
              periodEnd: currentPeriodEnd.toISOString(),
              expiredCredits: expired === null ? 0 : -expired.entry.amount.toNumber(),
              packCreditsLeft,
              notified,
            },
          })
          return overdue ? 'expired' : 'cancelled'
        },
        { isolationLevel: 'ReadCommitted' },
      ),
  )
  const waitingForShop = deps.yookassa === null ? await countWaitingForShop(prisma, now) : 0
  return { ...pass, waitingForShop }
}

async function countWaitingForShop(prisma: PrismaClient, now: Date): Promise<number> {
  const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
    SELECT count(*)::int AS waiting FROM subscriptions s
    WHERE s.status = 'active' AND ${AUTO_RENEWAL} AND s.current_period_end <= ${now}::timestamptz
  `
  return row?.waiting ?? 0
}

/**
 * Puts the «tariff ended» letter to the owner into the outbox; false when there is nobody to
 * write to or the letter cannot be written. The tariff ends all the same.
 */
async function enqueueEndLetter(
  tx: BillingTx,
  letter: {
    subscription: DueSubscription
    endedAt: Date
    packCreditsLeft: number
    giftCreditsLeft: number
    appUrl: string
  },
): Promise<boolean> {
  const { subscription } = letter
  const owner = await findWorkspaceOwner(tx, subscription.workspaceId)
  const plan = await tx.plan.findUnique({
    where: { id: subscription.planId },
    select: { name: true },
  })
  if (owner === null || plan === null) return false
  const payload = {
    planName: plan.name,
    endedAt: letter.endedAt.toISOString(),
    packCreditsLeft: letter.packCreditsLeft,
    giftCreditsLeft: letter.giftCreditsLeft,
    appUrl: letter.appUrl,
    to: owner.email,
  }
  if (!notificationCatalog['billing.subscription_ended'].payload.safeParse(payload).success) {
    return false
  }
  return enqueueNotification('billing.subscription_ended', payload, {
    db: tx,
    dedupeKey: subscriptionEndedLetterKey(subscription.id),
  })
}
