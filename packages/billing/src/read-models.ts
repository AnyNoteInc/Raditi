import type { Prisma } from '@repo/db'
import {
  availableCredits,
  creditAccountSnapshot,
  creditAccountUnits,
  emptyCreditAccount,
  liveSubscriptionStatuses,
  paymentMethodLabel,
  signupGiftCredits,
  type CreditAccountKind,
} from '@repo/domain'

import {
  creditBalancesSchema,
  creditsOverviewSchema,
  endedSubscriptionSchema,
  paymentsPageSchema,
  paymentsQuerySchema,
  planListSchema,
  planOverviewSchema,
  subscriptionWaitsSchema,
  type CreditBalancesDto,
  type CreditsOverviewDto,
  type EndedSubscriptionDto,
  type PaymentsPageDto,
  type PaymentsQuery,
  type PlanListDto,
  type PlanOverviewDto,
  type SubscriptionEndReason,
  type SubscriptionWaitsDto,
  type TaskCreditsDto,
} from './dto.ts'
import { paymentFailureText } from './failure-text.ts'
import { firstTaskCheck, newTaskCheck, type NewTaskAnswer } from './holds.ts'
import { ledgerKeys } from './ledger.ts'
import { renewalChargeUnderWay } from './renewal-order.ts'

// Read models of the settings pages: plain functions over the Prisma client (or a transaction
// client) that return DTOs. Every DTO passes its schema on the way out, so a row the schema
// does not describe fails here and not in the page.

type Reader = Prisma.TransactionClient

const planSelect = {
  id: true,
  slug: true,
  name: true,
  kind: true,
  price: true,
  creditsPerMonth: true,
  tasksPerDay: true,
  maxSites: true,
  packCredits: true,
} satisfies Prisma.PlanSelect

type PlanRow = Prisma.PlanGetPayload<{ select: typeof planSelect }>

const planDto = (row: PlanRow) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  price: row.price.toFixed(2),
  creditsPerMonth: row.creditsPerMonth,
  tasksPerDay: row.tasksPerDay,
  maxSites: row.maxSites,
})

/**
 * The live subscription of the workspace — its plan, period, auto-renewal, scheduled plan and
 * saved payment method — or «no subscription». `workspaceId` is null for a user who has no
 * workspace yet: nothing is subscribed either.
 */
export async function getPlanOverview(
  db: Pick<Reader, 'subscription'>,
  workspaceId: string | null,
): Promise<PlanOverviewDto> {
  if (workspaceId === null) return { subscription: null }
  // Not findUnique: the unique index on workspace_id covers live rows only, so the status
  // belongs to the key.
  const row = await db.subscription.findFirst({
    where: { workspaceId, status: { in: [...liveSubscriptionStatuses] } },
    select: {
      id: true,
      status: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
      pastDueSince: true,
      paymentMethodId: true,
      paymentMethodType: true,
      paymentMethodCardType: true,
      paymentMethodLast4: true,
      plan: { select: planSelect },
      nextPlan: { select: planSelect },
    },
  })
  if (row === null) return { subscription: null }
  const saved = row.paymentMethodId !== null
  return planOverviewSchema.parse({
    subscription: {
      id: row.id,
      status: row.status,
      plan: planDto(row.plan),
      period: { start: row.currentPeriodStart, end: row.currentPeriodEnd },
      autoRenewal: saved && !row.cancelAtPeriodEnd,
      nextPlan: row.nextPlan === null ? null : planDto(row.nextPlan),
      paymentMethod: saved
        ? {
            label: paymentMethodLabel({
              type: row.paymentMethodType,
              cardType: row.paymentMethodCardType,
              last4: row.paymentMethodLast4,
            }),
          }
        : null,
      pastDueSince: row.status === 'past_due' ? row.pastDueSince : null,
    },
  })
}

/**
 * What the live subscription of the workspace waits for beside what its overview shows: a
 * binding of a payment method that has not been read back, and the renewal charge of the
 * current period that has no outcome. A page that shows the payment method settles the first
 * and must not promise a charge to come while the second is under way. Nothing is waited for
 * without a live subscription.
 */
export async function getSubscriptionWaits(
  db: Pick<Reader, 'subscription' | 'order'>,
  workspaceId: string | null,
): Promise<SubscriptionWaitsDto> {
  const row =
    workspaceId === null
      ? null
      : await db.subscription.findFirst({
          where: { workspaceId, status: { in: [...liveSubscriptionStatuses] } },
          select: { id: true, currentPeriodEnd: true, pendingPaymentMethodId: true },
        })
  if (row === null) return { bindingPending: false, renewalCharge: 'none' }
  return subscriptionWaitsSchema.parse({
    bindingPending: row.pendingPaymentMethodId !== null,
    renewalCharge: await renewalChargeUnderWay(db, row),
  } satisfies SubscriptionWaitsDto)
}

/**
 * `meta.reason` of the entry `billing.subscription.end` an operator's refund writes (`refund.ts`,
 * `REFUND_END_REASON`), and the action itself (`renewalJobAuditActions.subscriptionEnd`). Named
 * here by their values: both modules import this one.
 */
const SUBSCRIPTION_END_ACTION = 'billing.subscription.end'
const ENDED_BY_REFUND = 'refund'

/**
 * The tariff the workspace had last, for a page that says «закончился» — only while it has no
 * live one, else null: a customer who bought a tariff again is not told of the one before it.
 * Why it ended is told by its status and, for a tariff an operator ended when returning its
 * payment, by the entry written with that end.
 *
 * `endedAt` is `current_period_end` — the end of the paid period, or the moment an operator
 * ended the tariff — except for a tariff that ended unpaid. That one was overdue for the whole
 * grace after its paid period, and its customer was told the day the grace runs out («… тариф
 * закончится, если оплата не пройдёт раньше»): its end is the moment the pass ended it
 * (`endPeriods`), which is when the entry of that end was written. The day the page named is
 * then the day it says the tariff ended on. Without the entry — a row closed by hand — the end
 * of the paid period stands.
 */
export async function getEndedSubscription(
  db: Pick<Reader, 'subscription' | 'auditLog'>,
  workspaceId: string | null,
): Promise<EndedSubscriptionDto | null> {
  if (workspaceId === null) return null
  // A workspace has one subscription at a time, so the newest row is the last tariff.
  const row = await db.subscription.findFirst({
    where: { workspaceId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, status: true, currentPeriodEnd: true, plan: { select: { name: true } } },
  })
  if (row === null || (row.status !== 'cancelled' && row.status !== 'expired')) return null
  let reason: SubscriptionEndReason = row.status === 'expired' ? 'not_paid' : 'not_renewed'
  let endedAt = row.currentPeriodEnd
  if (row.status === 'cancelled') {
    const end = await db.auditLog.findFirst({
      where: {
        action: SUBSCRIPTION_END_ACTION,
        targetType: 'subscription',
        targetId: row.id,
        meta: { path: ['reason'], equals: ENDED_BY_REFUND },
      },
      select: { id: true },
    })
    if (end !== null) reason = 'refunded'
  } else {
    // A subscription ends once: the entry of an expired one is the end of its grace.
    const end = await db.auditLog.findFirst({
      where: { action: SUBSCRIPTION_END_ACTION, targetType: 'subscription', targetId: row.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true },
    })
    if (end !== null) endedAt = end.createdAt
  }
  return endedSubscriptionSchema.parse({
    planName: row.plan.name,
    endedAt,
    reason,
  } satisfies EndedSubscriptionDto)
}

/**
 * What is on sale: the active tariffs with a quota in the order of `sort_order`, and the credit
 * pack. Pay-per-action is not sold yet and is never returned.
 */
export async function listPlans(db: Pick<Reader, 'plan'>): Promise<PlanListDto> {
  const rows = await db.plan.findMany({
    where: { isActive: true, kind: { in: ['quota', 'pack'] } },
    orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }],
    select: planSelect,
  })
  const pack = rows.find((row) => row.kind === 'pack')
  return planListSchema.parse({
    plans: rows.filter((row) => row.kind === 'quota').map(planDto),
    pack: pack
      ? {
          id: pack.id,
          slug: pack.slug,
          name: pack.name,
          price: pack.price.toFixed(2),
          credits: pack.packCredits,
        }
      : null,
  })
}

/**
 * The credits of the workspace on its three accounts — balance, held and available, read in one
 * statement — and whether the gift of the registration was granted to it. An account that does
 * not exist yet counts as empty, and nothing was granted to it.
 */
export async function getCreditBalances(
  db: Pick<Reader, 'billingAccount' | 'creditLedger'>,
  workspaceId: string,
): Promise<CreditBalancesDto> {
  const rows = await db.billingAccount.findMany({
    where: { workspaceId, unit: { in: Object.values(creditAccountUnits) } },
    select: { id: true, unit: true, balance: true, held: true },
  })
  const row = (kind: CreditAccountKind) =>
    rows.find(({ unit }) => unit === creditAccountUnits[kind])
  const account = (kind: CreditAccountKind) => {
    const found = row(kind)
    return found ? creditAccountSnapshot(found) : emptyCreditAccount
  }
  const accounts = { tariff: account('tariff'), gift: account('gift'), pack: account('pack') }
  const available = availableCredits(accounts)
  // The only grant the journal of the gift account ever holds is the gift of the registration
  // (`grantSignupGift`); it is found by the index of the account. Asked after the balances: a
  // gift granted between the two reads shows as granted with the balance of a moment before,
  // never as credits that nothing granted. It is the account that is asked, not the user: a
  // gift that stands on another workspace of the same user is not seen from here.
  const giftAccount = row('gift')
  const granted =
    giftAccount !== undefined &&
    (await db.creditLedger.findFirst({
      where: { accountId: giftAccount.id, kind: 'grant' },
      select: { id: true },
    })) !== null
  return creditBalancesSchema.parse({
    tariff: { ...accounts.tariff, available: available.tariff },
    gift: { ...accounts.gift, available: available.gift, granted },
    pack: { ...accounts.pack, available: available.pack },
    totalAvailable: available.total,
  })
}

/**
 * Whether the gift of the registration was granted to the user: its key stands in the ledger,
 * on whichever workspace of the user (`grantSignupGift`). One indexed read.
 */
export async function isSignupGiftGranted(
  db: Pick<Reader, 'creditLedger'>,
  userId: string,
): Promise<boolean> {
  const granted = await db.creditLedger.findUnique({
    where: { idempotencyKey: ledgerKeys.signupGift(userId) },
    select: { id: true },
  })
  return granted !== null
}

/**
 * The credits of a user who has no personal workspace: no account holds anything, and the gift
 * of the registration is shown as promised — `signupGiftCredits` as the balance and as
 * available on the gift account, `granted: false`. The promise is kept by the transaction that
 * makes the workspace (`ensurePersonalWorkspaceWithGift`): the gift is on its account before
 * anything can be spent.
 *
 * `giftGranted` is what `isSignupGiftGranted` answered for the user. Nothing is promised to a
 * user whose key already stands in the ledger: a gift is granted once, on whichever workspace
 * of the user, and `grantSignupGift` would answer «already granted». The caller who learns that
 * looks for the personal workspace again before it answers with these zeros: the workspace and
 * its gift may have been made since it looked (`billing.overview`).
 */
export function promisedCredits(giftGranted: boolean): CreditBalancesDto {
  const promised = giftGranted ? 0 : signupGiftCredits
  const empty = { ...emptyCreditAccount, available: 0 }
  return creditBalancesSchema.parse({
    tariff: empty,
    gift: { balance: promised, held: 0, available: promised, granted: false },
    pack: empty,
    totalAvailable: promised,
  })
}

/** The answer of the queue about a new task as the pages read it. */
const taskCredits = (answer: NewTaskAnswer): TaskCreditsDto => ({
  spendable: answer.spendable,
  setAside: answer.held,
  minToStart: answer.needed,
  today: { used: answer.day.launches, limit: answer.day.limit },
  newTask: { allowed: answer.allowed, reason: answer.reason },
})

/** A workspace, or a user without one, and the moment a page is read at. */
export interface CreditsOverviewInput {
  workspaceId: string
  now: Date
}

/**
 * The credits of the workspace as the settings pages read them: the three accounts
 * (`getCreditBalances`) and whether a new task would be taken at `now` — the answer the queue
 * itself would give (`newTaskCheck`), with its numbers: what a task could spend, what tasks in
 * work have set aside, and how many credits a new task needs.
 *
 * The accounts and the answer are two reads and may be a moment apart; pass a snapshot
 * transaction to read them as of one instant.
 */
export async function getCreditsOverview(
  db: Reader,
  input: CreditsOverviewInput,
): Promise<CreditsOverviewDto> {
  const [balances, verdict] = await Promise.all([
    getCreditBalances(db, input.workspaceId),
    newTaskCheck(db, input),
  ])
  return creditsOverviewSchema.parse({ ...balances, ...taskCredits(verdict) })
}

/**
 * The same for a user who has no personal workspace: the gift of the registration as
 * `promisedCredits` tells it, and whether the first task could be queued on it at `now`
 * (`firstTaskCheck`) — with the gift promised it could, while a credit rate is in force.
 * `giftGranted` is what `isSignupGiftGranted` answered for the user.
 */
export async function getPromisedCreditsOverview(
  db: Pick<Reader, 'creditRate' | 'llmModelPrice'>,
  input: { giftGranted: boolean; now: Date },
): Promise<CreditsOverviewDto> {
  const balances = promisedCredits(input.giftGranted)
  const verdict = await firstTaskCheck(db, {
    giftCredits: balances.gift.available,
    now: input.now,
  })
  return creditsOverviewSchema.parse({ ...balances, ...taskCredits(verdict) })
}

interface PaymentRow {
  id: string
  kind: string
  planName: string | null
  periodStart: Date | null
  periodEnd: Date | null
  amount: Prisma.Decimal
  status: string
  failureReason: string | null
  refundedAmount: Prisma.Decimal | null
  refundedAt: Date | null
  paidAt: Date | null
  createdAt: Date
}

/**
 * The orders of the workspace, newest first, one page at a time: the payment history. A failed
 * order carries the sentence that tells the customer why (`paymentFailureText`). The order is
 * `(created_at, id)`; the cursor is the id of the last order of the previous page, and the
 * database compares the next page with that row itself, so the microseconds a Date would lose
 * do not skip or repeat an order. A cursor that is not an order of this workspace gives an
 * empty page.
 */
export async function listPayments(
  db: Pick<Reader, '$queryRaw'>,
  workspaceId: string,
  query: PaymentsQuery = {},
): Promise<PaymentsPageDto> {
  const { cursor = null, limit } = paymentsQuerySchema.parse(query)
  const rows = await db.$queryRaw<PaymentRow[]>`
    SELECT o.id, o.kind::text AS kind, p.name AS "planName",
      o.period_start AS "periodStart", o.period_end AS "periodEnd", o.amount,
      o.status::text AS status, o.failure_reason AS "failureReason",
      o.refunded_amount AS "refundedAmount", o.refunded_at AS "refundedAt",
      o.paid_at AS "paidAt", o.created_at AS "createdAt"
    FROM orders o
    LEFT JOIN plans p ON p.id = o.plan_id
    WHERE o.workspace_id = ${workspaceId}::uuid
      AND (${cursor}::uuid IS NULL OR (o.created_at, o.id) < (
        SELECT last.created_at, last.id FROM orders last
        WHERE last.id = ${cursor}::uuid AND last.workspace_id = ${workspaceId}::uuid
      ))
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT ${limit + 1}::int
  `
  const items = rows.slice(0, limit)
  return paymentsPageSchema.parse({
    items: items.map(({ periodStart, periodEnd, amount, refundedAmount, ...row }) => ({
      ...row,
      failureText: row.status === 'failed' ? paymentFailureText(row.failureReason) : null,
      period: periodStart && periodEnd ? { start: periodStart, end: periodEnd } : null,
      amount: amount.toFixed(2),
      refundedAmount: refundedAmount === null ? null : refundedAmount.toFixed(2),
    })),
    nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
  })
}
