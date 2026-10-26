import { classProfile, type CreditHold, type CreditLedger } from '@repo/db'
import {
  attemptReserveCredits,
  attemptStepCredits,
  billingDay,
  conflict,
  creditAccountKinds,
  creditAccountSnapshot,
  creditAccountUnits,
  customerBudgetLeftRub,
  dailyTariffCredits,
  distributeCharge,
  DomainError,
  emptyCreditAccount,
  firstCallReserveRub,
  liveSubscriptionStatuses,
  llmPriceMissing,
  maxTaskAttempts,
  modelClassSchema,
  Money,
  newTaskVerdict,
  notFound,
  placementTariffRoom,
  siteHostKey,
  spendableCredits,
  splitReserve,
  subscriptionAllowsTasks,
  tariffHoldCreatedAt,
  tariffDayRoom,
  taskCharge,
  taskRefusal,
  toCredits,
  unpaidWork,
  type ChargeDistribution,
  type CreditAccountKind,
  type CreditAccounts,
  type Credits,
  type ModelClass,
  type NewTaskVerdict,
  type RowCharge,
  type SubscriptionStatus,
  type TaskPlacement,
} from '@repo/domain'
import type { Decimal } from 'decimal.js'
import { z } from 'zod'

import {
  ensureAccounts,
  lockCreditAccount,
  type BillingTx,
  type LockedCreditAccount,
} from './accounts.ts'
import { writeBillingAudit } from './audit.ts'
import {
  creditRateStatus,
  requireUsableCreditRate,
  taskRawCredits,
  TURN_KEY_LIMIT_RUB,
  workspaceWorkCredits,
} from './credit-rate.ts'
import { ledgerKeys, post } from './ledger.ts'

// Reserves of the task queue in credits (spec §17, «Правила списания»). When a task is queued,
// continued or tried again, its attempt sets credits aside — the step of its class, or what can
// be spent when that is less — on the accounts in the order credits are spent: the tariff, the
// gift, the pack; one `credit_holds` row per account the reserve touches. The active rows of a
// task are one pool, a chain: they are charged together when a pass of the task ends (since
// 26.10.2026 pass by pass: the next words open a new chain), and returned together when the pass
// failed, was cancelled, was rolled back or got stuck past their expiry.
//
// A reserve says that the task can be paid for. Which credits pay is decided when the task is
// charged (`distributeCharge` of @repo/domain), over what each account then has for the task.
// What a chain costs comes from the model calls its attempts recorded: `chargeTask` reads them
// itself, so a caller cannot pass a wrong sum. `attemptCreditBudget` gives the numbers the
// next turn key of an attempt is bounded by.
//
// Every function joins the caller's transaction and changes `balance` and `held` in SQL, in
// the transaction that writes the reserve or the ledger row. Locks are taken in one order — the
// live subscription, the tariff account, the gift account, the pack account — and a reserve row
// changes only under the lock of its account. A workspace without a live subscription has no
// first lock; every placement and every charge takes the three accounts, so what they count —
// the tariff credits of the day, the unpaid work — is read after them. `attemptCreditBudget`,
// `newTaskCheck` and `firstTaskCheck` only read and take no lock.
//
// Tariff credits are also spent within a Moscow day (`plans.credits_per_day`): the tariff part
// of a reserve, and what a charge takes from free tariff credits above the task's own rows, is
// no larger than what is left of the day (`tariffCreditsOfDay`, `tariffDayRoom`). The reserve
// of «Попробовать ещё» is the exception: the day does not bound it (`placementTariffRoom`), and
// what it holds and pays counts on the day all the same. Gift and pack credits are outside the
// day.

const CREDIT_UNITS = Object.values(creditAccountUnits)

// credit_holds.attempt is an integer checked to be at least 1.
const attemptSchema = z.number().int().min(1).max(2_147_483_647)

const placementSchema = z
  .strictObject({
    workspaceId: z.uuid(),
    /** A task of this workspace. */
    taskId: z.uuid(),
    /** tasks.attempt the reserve is for: «Продолжить» and «Попробовать ещё» are next attempts. */
    attempt: attemptSchema,
    now: z.date(),
    /** When the reserve of a stuck task may be expired by cron; later than `now`. */
    expiresAt: z.date(),
    /**
     * «Попробовать ещё»: set by the server code that decided the press is a retry and gave the
     * chain of the failed pass back (`releaseTask`) in the same transaction — never by what a
     * client sends. The day does not bound a retry (`placementTariffRoom`). A later attempt with
     * no active reserve before it is placed only so, and a retry only so.
     */
    retry: z.literal(true).optional(),
    /**
     * A new chain of a task whose last pass was charged (owner's answer of 26.10.2026: every
     * completed pass is charged): `message` — the client's next words in the open dialog,
     * `continue` — «Продолжить» or «Продолжить работу агента». Set by the server code that found
     * no active reserve of the task, never by what a client sends.
     */
    follows: z.enum(['message', 'continue']).optional(),
  })
  .refine(({ now, expiresAt }) => expiresAt.getTime() > now.getTime(), { path: ['expiresAt'] })
  .refine(({ retry, follows }) => retry === undefined || follows === undefined, {
    path: ['follows'],
  })
export type CreditHoldPlacement = z.infer<typeof placementSchema>

const extensionSchema = z.strictObject({
  taskId: z.uuid(),
  /** The new `expires_at` of every active reserve row of the task. */
  expiresAt: z.date(),
})
export type TaskHoldsExtension = z.infer<typeof extensionSchema>

const endingSchema = z.strictObject({ taskId: z.uuid(), now: z.date() })
/** A task whose reserve is given back, and the moment it is. */
export type TaskHoldsEnding = z.infer<typeof endingSchema>

const chargeSchema = z.strictObject({
  taskId: z.uuid(),
  /**
   * What the task costs, in whole credits: the answer of `taskCharge` of @repo/domain, at
   * least one and never more than the active reserve rows of the task hold.
   */
  credits: z.number().int().positive(),
  now: z.date(),
})
export type TaskChargeSettlement = z.infer<typeof chargeSchema>

const dayQuerySchema = z.strictObject({ workspaceId: z.uuid(), now: z.date() })
/** A workspace and a moment of the Moscow day whose tariff credits are asked about. */
export type TariffDayQuery = z.infer<typeof dayQuerySchema>

/** A workspace and the moment it is asked whether it could queue a new task. */
export type NewTaskQuery = TariffDayQuery

/**
 * The answer about a new task: the verdict of the rule with its numbers, the tariff credits of
 * the Moscow day among them (`today`: null without a paid tariff — there is no day then).
 */
export type NewTaskAnswer = NewTaskVerdict

const firstTaskQuerySchema = z.strictObject({
  /** The gift the user is promised: what the gift account will hold when it is made. */
  giftCredits: z.number().int().nonnegative(),
  now: z.date(),
})
export type FirstTaskQuery = z.infer<typeof firstTaskQuerySchema>

const budgetQuerySchema = z.strictObject({
  taskId: z.uuid(),
  /** tasks.attempt the next turn key is for. */
  attempt: attemptSchema,
  now: z.date(),
})
export type AttemptBudgetQuery = z.infer<typeof budgetQuerySchema>

export interface PlacedCreditHold {
  /**
   * The reserve rows of the attempt in the order credits are spent, one per account: placed by
   * this call, or by the earlier one, as they are now.
   */
  holds: CreditHold[]
  /** Σ amount of those rows: what the attempt set aside. */
  reserved: Credits
  /** false: the attempt already had its reserve, and this call changed nothing. */
  applied: boolean
}

/** What `releaseTask` and `expireTaskHolds` return. */
export interface ReturnedTaskHolds {
  /**
   * The reserve rows this call gave back; when it changed nothing, the rows of the task that
   * were given back before, released or expired.
   */
  holds: CreditHold[]
  /** The ledger rows of tariff credits that did not come back: their period had ended. */
  expiries: CreditLedger[]
  /** false: the task had no active reserve, and this call changed nothing. */
  applied: boolean
}

export interface SettledTaskCharge {
  /** What the task was charged. */
  credits: Credits
  /** The charge by the account it came from. */
  from: Record<CreditAccountKind, Credits>
  /** Tariff credits of an ended period that the task had reserved and did not use. */
  expired: Credits
  /** The `charge` rows of the task in the ledger. */
  entries: CreditLedger[]
  /** The reserve rows the charge settled, `captured`. */
  holds: CreditHold[]
  /** false: the task was charged before, and this call changed nothing. */
  applied: boolean
}

/** What `chargeTask` returns: the charge as it was posted, and what it was taken from. */
export interface ChargedTask extends SettledTaskCharge {
  /**
   * Σ amount of the reserve rows the charge settled: what was set aside for the task. A charge
   * equal to it took everything that was set aside.
   */
  reserved: Credits
}

/**
 * The numbers the next turn key of an attempt is bounded by (`attemptCreditBudget`). Credits are
 * the customer's; RUB are accounting cost, strings with ten decimals but for the budget itself.
 */
export interface AttemptCreditBudget {
  /** The attempt the numbers are for. */
  attempt: number
  /**
   * How many attempts the chain holds — those with an active reserve, this one among them; zero
   * when the task holds none. «Продолжить» is offered while it is below `maxTaskAttempts`.
   */
  chainAttempts: number
  /** The step of the attempt: the most it sets aside, by the class of the task's model. */
  step: Credits
  /** Σ amount of the active reserve rows of the task — its whole chain; zero when it has none. */
  reserved: Credits
  /**
   * The billable work the chain answers for in credits, not rounded: what a charge would round
   * now — its own and that of the chains «Попробовать ещё» gave back before it, which built the
   * candidate the dialog kept (`workAttemptsOf`). Calls that are still open are not in it.
   */
  used: Decimal
  /**
   * What the workspace could set aside for one more attempt of the chain now
   * (`spendableCredits`): the tariff part no larger than what is left of the Moscow day, as
   * «Продолжить» would count it — the next attempt of a chain is a continuation, which the day
   * bounds.
   */
  spendableNow: Credits
  /** What the reserves still hold for the customer: max(0, reserved − used) × K, rounded down. */
  customerLeftRub: string
  /**
   * What the step still leaves to the attempt: step × K less every recorded call of the
   * attempt, billable or not — a lost call spent the pool too. Never below zero.
   */
  ceilingLeftRub: string
  /**
   * The reserve of one first call (`firstCallReserveRub`): what a key holds above the reserves
   * of the customer, so that the last task of a balance can finish.
   */
  finishRub: string
  /** The reserves of the calls of the attempt that are still open, on whichever of its keys. */
  openReservedRub: string
  /**
   * What the next turn key of the attempt may hold, RUB rounded down to kopecks: nothing when
   * the reserves hold nothing for the customer, else
   * max(0, min(750, min(customerLeft + finish, ceilingLeft) − openReserved)).
   */
  budgetRub: string
}

interface LiveSubscription {
  planId: string
  status: SubscriptionStatus
  currentPeriodStart: Date
  currentPeriodEnd: Date
}

/**
 * The live subscription of the workspace, locked until the transaction ends, or null when none
 * is live. Whoever ends or renews its period takes the same lock first
 * (`expireTariffRemainder`), so a reserve is placed or given back either wholly before the
 * period moves or wholly after it, and never reads one period while it writes into the next.
 * NO KEY: orders that refer to the subscription are not held up.
 */
async function lockLiveSubscription(
  tx: Pick<BillingTx, '$queryRaw'>,
  workspaceId: string,
): Promise<LiveSubscription | null> {
  const [row] = await tx.$queryRaw<LiveSubscription[]>`
    SELECT plan_id AS "planId", status::text AS status,
      current_period_start AS "currentPeriodStart", current_period_end AS "currentPeriodEnd"
    FROM subscriptions
    WHERE workspace_id = ${workspaceId}::uuid
      AND status = ANY(${[...liveSubscriptionStatuses]}::"SubscriptionStatus"[])
    FOR NO KEY UPDATE
  `
  return row ?? null
}

type LockedAccounts = Record<CreditAccountKind, LockedCreditAccount | null>

/** The live subscription and the three credit accounts of a workspace under their locks. */
interface LockedWorkspace {
  subscription: LiveSubscription | null
  accounts: LockedAccounts
}

/**
 * Takes the locks every function here works under, in the one order: the live subscription,
 * then the accounts as credits are spent. `create` makes the accounts first when the workspace
 * has none — after the subscription lock, which a renewal holds while it grants its quota.
 */
async function lockWorkspace(
  tx: BillingTx,
  workspaceId: string,
  { create }: { create: boolean },
): Promise<LockedWorkspace> {
  const subscription = await lockLiveSubscription(tx, workspaceId)
  if (create) await ensureAccounts(tx, workspaceId)
  const tariff = await lockCreditAccount(tx, workspaceId, 'tariff')
  const gift = await lockCreditAccount(tx, workspaceId, 'gift')
  const pack = await lockCreditAccount(tx, workspaceId, 'pack')
  return { subscription, accounts: { tariff, gift, pack } }
}

const snapshots = (accounts: LockedAccounts): CreditAccounts => ({
  tariff: accounts.tariff?.snapshot ?? emptyCreditAccount,
  gift: accounts.gift?.snapshot ?? emptyCreditAccount,
  pack: accounts.pack?.snapshot ?? emptyCreditAccount,
})

function accountOf(accounts: LockedAccounts, kind: CreditAccountKind): LockedCreditAccount {
  const account = accounts[kind]
  // Only a transaction that does not see rows committed after its start gets here.
  if (account === null) throw conflict('The credit account is not visible to this transaction')
  return account
}

const kindOfUnit = (unit: string): CreditAccountKind | undefined =>
  creditAccountKinds.find((kind) => creditAccountUnits[kind] === unit)

/** A reserve row with the account it stands on. */
interface ReserveRow {
  hold: CreditHold
  account: CreditAccountKind
  credits: Credits
}

/**
 * Every reserve row of a task as it stands under the locks of the accounts, by attempt and then
 * in the order credits are spent. A row of the RUB wallet is not a reserve of credits — such a
 * hold is settled by its price —, and a row on an account of another workspace is nobody's to
 * settle here: both are a conflict, and nothing is changed.
 */
async function reserveRows(
  tx: BillingTx,
  taskId: string,
  accounts: LockedAccounts,
): Promise<ReserveRow[]> {
  const holds = await tx.creditHold.findMany({ where: { taskId } })
  const rows = holds.map((hold) => {
    const account = kindOfUnit(hold.unit)
    if (account === undefined) throw conflict('The hold of the task is not a hold of credits')
    if (accounts[account]?.id !== hold.accountId) {
      throw conflict('A reserve of the task is not on a credit account of its workspace')
    }
    return { hold, account, credits: toCredits(hold.amount) }
  })
  const order = (kind: CreditAccountKind) => creditAccountKinds.indexOf(kind)
  return rows.sort((a, b) => a.hold.attempt - b.hold.attempt || order(a.account) - order(b.account))
}

const sumCredits = (rows: readonly ReserveRow[]): Credits =>
  toCredits(rows.reduce((sum, row) => sum + row.credits, 0))

/** The attempts that hold the given reserve rows, in order: the chain of the task. */
const chainOf = (rows: readonly { hold: { attempt: number } }[]): number[] =>
  [...new Set(rows.map((row) => row.hold.attempt))].sort((a, b) => a - b)

/**
 * The attempts whose work a task pays for (`chargeTask`, `attemptCreditBudget`): those of its
 * chain and those of every chain «Попробовать ещё» gave back before it — the released rows of a
 * task that went on (docs/plan/53, «Попробовать ещё (18.10)»). A retry returns the reserve of
 * the attempt whose pass failed, but the candidate the dialog kept was built by that attempt and
 * the earlier ones, and it is released with the dialog: that work is charged then, from the
 * reserves that stand, and the keys of the retry are bounded by it. The calls of the pass that
 * failed stay out by their turn (`task_turns.rejected_at`, `taskRawCredits`), which is what keeps
 * the failure free. A task whose rows were given back by its end — failed, cancelled, expired,
 * rolled back — is neither charged nor asked about a key again.
 */
const workAttemptsOf = (rows: readonly { hold: Pick<CreditHold, 'attempt' | 'status'> }[]) => {
  // A charge took the work of every attempt before it (26.10.2026: a task is charged pass by
  // pass): what was given back before the last capture was counted then.
  const charged = Math.max(
    0,
    ...rows.filter(({ hold }) => hold.status === 'captured').map(({ hold }) => hold.attempt),
  )
  return chainOf(
    rows.filter(
      ({ hold }) =>
        hold.status === 'active' || (hold.status === 'released' && hold.attempt > charged),
    ),
  )
}

/**
 * The attempts of the chain of a task: those that hold an active reserve, in order. Read without
 * a lock — what the procedures of a dialog tell the client before they place anything, the bound
 * itself is checked again by `placeCreditHold` under its locks.
 */
export async function taskChainAttempts(
  tx: Pick<BillingTx, 'creditHold'>,
  taskId: string,
): Promise<number[]> {
  const rows = await tx.creditHold.findMany({
    where: { taskId, status: 'active' },
    select: { attempt: true },
  })
  return chainOf(rows.map((hold) => ({ hold })))
}

/** The workspace of a task: what never changes, read without a lock. */
async function workspaceOfTask(tx: BillingTx, taskId: string): Promise<string> {
  const task = await tx.task.findUnique({ where: { id: taskId }, select: { workspaceId: true } })
  if (task === null) throw notFound('Task not found')
  return task.workspaceId
}

/** What the tariff of a workspace gave a Moscow day so far, in whole credits. */
export interface TariffCreditsOfDay {
  /**
   * Paid: what the charged rows placed in the day paid (`credit_holds.charged`), and what the
   * charges settled in the day took from free tariff credits above the task's own tariff rows.
   */
  charged: Credits
  /** Set aside: the tariff rows placed in the day that are still active, in full. */
  held: Credits
}

/** A sum of the day as PostgreSQL prints it, read as whole credits. */
function creditsOfDay(printed: string): Credits {
  const value = new Money(printed)
  if (value.isNegative() || !value.isInteger())
    throw conflict('The tariff credits of the day do not add up')
  return toCredits(value.toNumber())
}

/**
 * The tariff credits the Moscow calendar day of `now` has taken from a workspace — what its
 * daily limit (`plans.credits_per_day`) is compared with (docs/plan/37-billing-plan.md,
 * «Дневной лимит в кредитах»; spec §17). Only the tariff account counts: gift and pack credits,
 * operator adjustments and the expiry of a period are outside the day.
 *
 * A reserve row counts on the day it was placed (`placed_at`, not `created_at`, which is the
 * stamp of its period): in full while it is active, what it paid once its task is charged
 * (`credit_holds.charged`), nothing once it is given back. A task that waits for days takes only
 * the day it was placed, and a reserve placed late in the evening and charged after midnight
 * leaves the new day untouched. What a charge took from free tariff credits in place of the
 * chain's gift or pack reserve — the tariff entry of the charge above what the chain's own tariff
 * rows paid — counts on the day the charge was settled (`settled_at` of its rows); a task is
 * charged pass by pass, each charge on its own day. A tariff row of
 * an ended period is charged under a key of its own, and its `charged` equals that entry: it
 * cancels out of the difference and stays on the day it was placed.
 *
 * «Попробовать ещё» gives the chain of the failed pass back, so a failed pass and its retries
 * take the day once — by the reserve of the last retry, and by what it paid when the task is
 * charged, the work of the candidate among it (`workAttemptsOf`). The day does not bound that
 * reserve (`placementTariffRoom`), so it can take the day past its limit; the placements after
 * it then find nothing left of the day.
 *
 * Read it after `lockWorkspace` where its answer bounds a write: under the lock of the tariff
 * account the reserves and the charges of the workspace are serialized.
 */
export async function tariffCreditsOfDay(
  db: Pick<BillingTx, '$queryRaw'>,
  input: TariffDayQuery,
): Promise<TariffCreditsOfDay> {
  const { workspaceId, now } = dayQuerySchema.parse(input)
  const day = billingDay(now)
  const [row] = await db.$queryRaw<{ held: string; placed: string; transfer: string }[]>`
    WITH tariff AS (
      SELECT a.id FROM billing_accounts a
      WHERE a.workspace_id = ${workspaceId}::uuid
        AND a.unit = ${creditAccountUnits.tariff}::"BillingUnit"
    ),
    settled AS (
      SELECT h.id, h.task_id, h.attempt, h.settled_at, h.account_id, h.charged
      FROM credit_holds h
      JOIN billing_accounts a ON a.id = h.account_id
      WHERE a.workspace_id = ${workspaceId}::uuid
        AND a.unit = ANY(${CREDIT_UNITS}::"BillingUnit"[])
        AND h.status = 'captured'
        AND h.settled_at >= ${day.start}::timestamptz
        AND h.settled_at < ${day.end}::timestamptz
    ),
    -- The entries on the tariff account of the charges settled in the day: of a chain, named by
    -- its first attempt — the rows of a chain settle together, so its first attempt is among
    -- the rows of the day and no other attempt names a charge —, of a tariff row of an ended
    -- period, and of a charge written before 26.10.2026, one per task.
    entries AS (
      SELECT DISTINCT 'task:' || s.task_id || ':' || s.attempt || ':charge:' || t.id AS key
      FROM settled s CROSS JOIN tariff t
      UNION ALL
      SELECT DISTINCT 'task:' || s.task_id || ':charge:' || t.id FROM settled s CROSS JOIN tariff t
      UNION ALL
      SELECT 'hold:' || s.id || ':charge' FROM settled s
    )
    SELECT
      COALESCE((
        SELECT SUM(h.amount) FROM credit_holds h
        WHERE h.account_id IN (SELECT id FROM tariff) AND h.status = 'active'
          AND h.placed_at >= ${day.start}::timestamptz AND h.placed_at < ${day.end}::timestamptz
      ), 0)::text AS held,
      COALESCE((
        SELECT SUM(h.charged) FROM credit_holds h
        WHERE h.account_id IN (SELECT id FROM tariff) AND h.status = 'captured'
          AND h.placed_at >= ${day.start}::timestamptz AND h.placed_at < ${day.end}::timestamptz
      ), 0)::text AS placed,
      (
        COALESCE((
          SELECT -SUM(l.amount) FROM credit_ledger l
          WHERE l.account_id IN (SELECT id FROM tariff) AND l.kind = 'charge'
            AND l.idempotency_key IN (SELECT key FROM entries)
        ), 0)
        - COALESCE((
          SELECT SUM(s.charged) FROM settled s
          WHERE s.account_id IN (SELECT id FROM tariff)
        ), 0)
      )::text AS transfer
  `
  if (row === undefined) throw conflict('The tariff credits of the day were not read')
  const held = creditsOfDay(row.held)
  const charged = creditsOfDay(new Money(row.placed).plus(row.transfer).toFixed())
  // Each part is a sum of its own: a transfer below zero would hide behind the rows.
  creditsOfDay(row.transfer)
  return { charged, held }
}

/**
 * The moment the bound on unpaid work of a workspace without a paid tariff is counted from: the
 * end of its last tariff — of the paid period of a tariff that is overdue or has ended —, or
 * the creation of the workspace when it never had one.
 */
async function lastTariffEnd(tx: BillingTx, workspaceId: string): Promise<Date> {
  const last = await tx.subscription.findFirst({
    where: { workspaceId, status: { in: ['past_due', 'cancelled', 'expired'] } },
    orderBy: { currentPeriodEnd: 'desc' },
    select: { currentPeriodEnd: true },
  })
  if (last !== null) return last.currentPeriodEnd
  const { createdAt } = await tx.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { createdAt: true },
  })
  return createdAt
}

/**
 * The work the workspace got without a charge since `since`, in credits: what bounds its new
 * tasks and retries (`unpaidWork` of @repo/domain).
 */
async function unpaidWorkSince(tx: BillingTx, workspaceId: string, since: Date): Promise<Decimal> {
  const { work, charged } = await workspaceWorkCredits(tx, { workspaceId, since })
  return unpaidWork({ work, charged })
}

/** The status of the live subscription with the terms of its plan a placement is checked by. */
async function tariffTerms(
  tx: Pick<BillingTx, 'plan'>,
  subscription: Pick<LiveSubscription, 'planId' | 'status'> | null,
) {
  if (subscription === null) return null
  const { creditsPerMonth, creditsPerDay } = await tx.plan.findUniqueOrThrow({
    where: { id: subscription.planId },
    select: { creditsPerMonth: true, creditsPerDay: true },
  })
  // A tariff is a plan with a monthly quota (CHECK plans_kind_fields_check).
  if (creditsPerMonth === null)
    throw conflict('The plan of the subscription has no monthly credits')
  return { status: subscription.status, creditsPerMonth, creditsPerDay }
}

/**
 * What is left of the tariff credits of the Moscow day of `now` for a workspace whose live
 * subscription is `subscription` (`tariffDayRoom`): null when the tariff is not paid or its plan
 * sets no daily limit. The plan is that of the subscription at `now`. Read after
 * `lockWorkspace` where the answer bounds a write.
 */
async function tariffRoomNow(
  tx: BillingTx,
  input: {
    workspaceId: string
    subscription: Pick<LiveSubscription, 'planId' | 'status'> | null
    now: Date
  },
): Promise<Credits | null> {
  const limit = dailyTariffCredits(await tariffTerms(tx, input.subscription))
  if (limit === null) return null
  const { charged, held } = await tariffCreditsOfDay(tx, {
    workspaceId: input.workspaceId,
    now: input.now,
  })
  return tariffDayRoom({ limit, used: toCredits(charged + held) })
}

/**
 * The moment a placement of `now` takes its credits. Never earlier than the start of the period
 * the reserve is placed in: a period starts when ЮKassa captured its payment, by ЮKassa's
 * clock, and the clock that queues the task may be behind it. The day and the credit rate are
 * asked about this moment, which is the one the rows of the reserve are then stamped with
 * (`credit_holds.placed_at`) and counted on the day of.
 */
const placementMoment = (now: Date, subscription: LiveSubscription | null): Date =>
  subscription !== null && subscriptionAllowsTasks(subscription.status)
    ? new Date(Math.max(now.getTime(), subscription.currentPeriodStart.getTime()))
    : now

/**
 * What a placement is checked by beside the accounts — the facts `newTaskVerdict` of
 * @repo/domain asks for: whether a usable credit rate is in force, the terms of the tariff, the
 * tariff credits of the Moscow day and the work the workspace got without a charge. Read in one
 * place for the queue (`placeCreditHold`) and for the pages (`newTaskCheck`), so that both ask
 * the rule about the same things.
 *
 * The day is read for every placement: a continuation takes tariff credits of the day like a
 * new task, and a retry, which the day does not bound, is still told what the day has taken. A
 * continuation is not asked about unpaid work — the work is in progress and will be charged if it
 * is done —, so that is not read for it.
 */
async function placementFacts(
  tx: BillingTx,
  input: {
    workspaceId: string
    subscription: LiveSubscription | null
    placedAt: Date
    continues: boolean
  },
) {
  const { workspaceId, subscription, placedAt, continues } = input
  const paid = subscription !== null && subscriptionAllowsTasks(subscription.status)
  const rate = await creditRateStatus(tx, placedAt)
  const tariff = await tariffTerms(tx, subscription)
  const tariffCreditsToday = await tariffCreditsOfDay(tx, { workspaceId, now: placedAt })
  const unpaid = continues
    ? new Money(0)
    : await unpaidWorkSince(
        tx,
        workspaceId,
        paid ? subscription.currentPeriodStart : await lastTariffEnd(tx, workspaceId),
      )
  return {
    subscription: tariff,
    tariffCreditsToday,
    unpaidWork: unpaid,
    rateUsable: rate.verdict === 'usable',
  }
}

/**
 * Sets credits aside for an attempt of a task: `min(step of its class, what can be spent now)`,
 * split over the accounts in the order credits are spent — the tariff, the gift, the pack —,
 * one reserve row and one `held += part` per account it touches. Gift credits can always be
 * spent, tariff and pack credits only while the tariff is paid, and tariff credits no more than
 * is left of the Moscow day (`plans.credits_per_day`).
 *
 * The attempt is a new task (`attempt` 1), a continuation — an earlier attempt of the task
 * still has its reserve, which stays and from now on lives as long as the new one —, a retry
 * («Попробовать ещё», `retry`: a later attempt of a task whose chain was given back, so it has
 * no active reserve) or a new chain after a charged pass (`follows`, owner's answer of
 * 26.10.2026: every completed pass is charged — `next` for the client's next words, `resume`
 * for «Продолжить»). Whether it is taken is decided once, by `newTaskVerdict` of @repo/domain,
 * and a refusal is its error (`taskRefusal`) with the reason and the numbers in the details;
 * the checks come in this order:
 *
 * 1. a usable credit rate — BILLING_CREDIT_RATE_MISSING;
 * 2. credits: 5 that can be spent for a new task, a retry and the next words, 1 for a
 *    continuation and a resume —
 *    BILLING_CREDITS_HELD when other tasks in work hold them, BILLING_NOT_ENOUGH_CREDITS on a
 *    paid tariff, BILLING_TASK_NEEDS_SUBSCRIPTION without one;
 * 3. the tariff credits of the Moscow day, for every placement but a retry: what is left of
 *    the day on the tariff, with the gift and pack credits, cannot cover the start although the
 *    accounts can — BILLING_DAILY_LIMIT_REACHED. The daily limit does not apply to a retry (the
 *    owner, 19.10.2026): its tariff part is bounded by the free tariff credits alone, and what it
 *    holds counts on the day it is placed on for the placements after it;
 * 4. unpaid work, for a new task, a retry and the next words: what the workspace got without a
 *    charge since the
 *    start of its paid period against the monthly credits of the plan —
 *    BILLING_UNPAID_WORK_LIMIT —, without a paid tariff since the end of its last tariff
 *    against `trialUnpaidWorkCredits` — BILLING_TASK_NEEDS_SUBSCRIPTION;
 * 5. without a paid tariff, the gift of the site: one site spends gift credits in one workspace
 *    only (`gift_site_claims`) — BILLING_TASK_NEEDS_SUBSCRIPTION.
 *
 * A task of another workspace is not found. A conflict, before any of the above: a task that
 * is not billable or has no class of its model takes no reserve, a chain has at most
 * `maxTaskAttempts` attempts — a continuation of a third is refused, a retry and a charged pass
 * start a new chain —, an attempt is not placed below one that has a reserve, a retry is placed
 * only after its chain was given back, a new chain after a charge only when no chain is active
 * and a charge stands, and a later attempt without an active reserve only as one of those two.
 * A refusal writes no reserve, no claim and moves no
 * balance; a workspace that had no credit accounts is left with its three empty ones, which are
 * what a placement locks.
 *
 * One reserve per attempt: a repeated call returns the rows of the first one, whatever became
 * of them and of the tariff since, and changes nothing.
 */
export async function placeCreditHold(
  tx: BillingTx,
  input: CreditHoldPlacement,
): Promise<PlacedCreditHold> {
  const { workspaceId, taskId, attempt, now, expiresAt, retry, follows } =
    placementSchema.parse(input)
  // Credits are reserved on the accounts of the workspace the task belongs to, whatever ids the
  // caller holds.
  const task = await tx.task.findFirst({
    where: { id: taskId, workspaceId },
    select: { billable: true, modelClass: true, site: { select: { url: true } } },
  })
  if (task === null) throw notFound('Task not found')
  // tasks.billable is false for «Отменить» and operator retries: no reserve, no charge.
  if (!task.billable) throw conflict('A task that is not billable takes no reserve')
  const modelClass = modelClassSchema.safeParse(task.modelClass)
  if (!modelClass.success) throw conflict('A task without a class of its model takes no reserve')

  const locked = await lockWorkspace(tx, workspaceId, { create: true })
  const { subscription } = locked
  const accounts = {
    tariff: accountOf(locked.accounts, 'tariff'),
    gift: accountOf(locked.accounts, 'gift'),
    pack: accountOf(locked.accounts, 'pack'),
  }

  // Under the locks: a concurrent call for the same attempt has either not started or is done.
  const rows = await reserveRows(tx, taskId, accounts)
  const placed = rows.filter((row) => row.hold.attempt === attempt)
  if (placed.length > 0) {
    return { holds: placed.map((row) => row.hold), reserved: sumCredits(placed), applied: false }
  }

  // The kind of the placement, from the rows of the task itself.
  const active = rows.filter((row) => row.hold.status === 'active')
  if (rows.some((row) => row.hold.attempt >= attempt)) {
    throw conflict('A later attempt of the task already holds a reserve')
  }
  const charged = rows.some((row) => row.hold.status === 'captured')
  let placement: TaskPlacement
  if (active.length > 0) placement = 'continuation'
  else if (attempt === 1) placement = 'new'
  else if (retry === true) placement = 'retry'
  else if (follows === 'message') placement = 'next'
  else if (follows === 'continue') placement = 'resume'
  else throw conflict('A later attempt without an active reserve is placed only by a retry')
  // Only the caller knows a press of «Попробовать ещё» or that a pass was charged, and the rows
  // must agree with it: a retry follows a chain that was given back, a new chain after a charge
  // follows a charge, and nothing else places a later attempt without an active reserve.
  if (retry === true && placement !== 'retry') {
    throw conflict('A retry is a later attempt of a task whose chain was given back')
  }
  if (follows !== undefined && (placement === 'continuation' || placement === 'new')) {
    throw conflict('The chain of the task is not charged: its next words go on with it')
  }
  if ((placement === 'next' || placement === 'resume') && !charged) {
    throw conflict('A new chain of a task follows a charge of the one before')
  }
  const continues = placement === 'continuation'
  // The attempts of a chain are bounded; a retry after a failure gave its chain back and starts
  // a new one, and so does every charged pass (`maxTaskAttempts`).
  if (continues && chainOf(active).length >= maxTaskAttempts) {
    throw conflict(`A chain of a task has at most ${maxTaskAttempts} attempts`)
  }

  const paid = subscription !== null && subscriptionAllowsTasks(subscription.status)
  // The moment the credits are taken (`placementMoment`).
  const placedAt = placementMoment(now, subscription)
  const facts = await placementFacts(tx, {
    workspaceId,
    subscription,
    placedAt,
    // A resume goes on with work as a continuation does: it is not asked about unpaid work.
    continues: continues || placement === 'resume',
  })
  // Without a paid tariff a reserve stands on gift credits alone, and a site spends those in
  // one workspace only.
  const hostKey = paid ? null : siteHostKey(task.site.url)
  const claim =
    hostKey === null
      ? null
      : await tx.giftSiteClaim.findUnique({ where: { hostKey }, select: { workspaceId: true } })

  const balances = snapshots(accounts)
  const verdict = newTaskVerdict({
    placement,
    accounts: balances,
    // What the rows that make it a continuation hold, so that they are not «tasks in work».
    ...(continues ? { heldByTask: heldByAccount(active) } : {}),
    ...facts,
    giftSiteClaimedElsewhere: claim !== null && claim.workspaceId !== workspaceId,
  })
  if (!verdict.allowed) throw taskRefusal(verdict)

  if (hostKey !== null && claim === null) {
    // The first reserve of the site on gift credits claims it. A claim another workspace
    // commits at this very moment makes the statement wait and then write nothing.
    await tx.giftSiteClaim.createMany({ data: [{ hostKey, workspaceId }], skipDuplicates: true })
    const written = await tx.giftSiteClaim.findUnique({
      where: { hostKey },
      select: { workspaceId: true },
    })
    if (written?.workspaceId !== workspaceId) {
      const { spendable, held, needed } = verdict
      throw taskRefusal({ reason: 'gift_site_used', spendable, held, needed })
    }
  }

  const reserved = attemptReserveCredits(modelClass.data, verdict.spendableNow)
  const parts = splitReserve({
    accounts: balances,
    amount: reserved,
    tariffTakesTasks: paid,
    // The room the verdict counted `spendableNow` by: none for a retry.
    tariffRoom: placementTariffRoom(placement, verdict.today),
  })
  const holds: CreditHold[] = []
  for (const part of parts) {
    const account = accounts[part.account]
    const credits = new Money(part.amount)
    // The stamp of a tariff row says which period its credits are of when the task is settled
    // (`distributeCharge`), so it stays inside the period they are taken from: the subscription
    // is active past the end of its period until the renewal is settled, the credits on the
    // account are then still those of the period that ended, and a row placed in that time is
    // stamped with its last millisecond — or its credits would pass for those of the next
    // period and be carried over. Gift and pack credits belong to no period and keep the moment.
    const createdAt =
      part.account === 'tariff' && subscription !== null
        ? tariffHoldCreatedAt(placedAt, subscription)
        : placedAt
    holds.push(
      await tx.creditHold.create({
        data: {
          accountId: account.id,
          unit: account.unit,
          taskId,
          attempt,
          amount: credits,
          expiresAt,
          createdAt,
          placedAt,
        },
      }),
    )
    await tx.billingAccount.update({
      where: { id: account.id },
      data: { held: { increment: credits } },
    })
  }
  // The reserves of a chain live and expire together: the earlier rows take the new expiry.
  if (continues) await moveExpiry(tx, active, expiresAt)
  return { holds, reserved, applied: true }
}

function heldByAccount(rows: readonly ReserveRow[]): Record<CreditAccountKind, Credits> {
  const of = (kind: CreditAccountKind) => sumCredits(rows.filter((row) => row.account === kind))
  return { tariff: of('tariff'), gift: of('gift'), pack: of('pack') }
}

async function moveExpiry(
  tx: BillingTx,
  active: readonly ReserveRow[],
  expiresAt: Date,
): Promise<void> {
  await tx.creditHold.updateMany({
    where: { id: { in: active.map((row) => row.hold.id) }, status: 'active' },
    data: { expiresAt },
  })
}

/** The three credit accounts of a workspace as they stand, read in one statement, no lock. */
async function accountsNow(
  tx: Pick<BillingTx, 'billingAccount'>,
  workspaceId: string,
): Promise<CreditAccounts> {
  const rows = await tx.billingAccount.findMany({
    where: { workspaceId, unit: { in: CREDIT_UNITS } },
    select: { unit: true, balance: true, held: true },
  })
  const of = (kind: CreditAccountKind) => {
    const row = rows.find((account) => account.unit === creditAccountUnits[kind])
    return row === undefined ? emptyCreditAccount : creditAccountSnapshot(row)
  }
  return { tariff: of('tariff'), gift: of('gift'), pack: of('pack') }
}

/**
 * Whether a new task of the workspace would be taken at `now`, and why not — what
 * `placeCreditHold` would answer to the first attempt of a task, asked without placing
 * anything: the same facts (`placementFacts`) and the same rule (`newTaskVerdict` of
 * @repo/domain), so a page that reports the answer and the queue that acts on it never
 * disagree. The numbers of the verdict come with it: what a task could spend by the accounts and
 * now, what other tasks in work hold, how many credits a new task needs, and the tariff credits
 * of the Moscow day.
 *
 * Read only, no lock, nothing written — not even the accounts a placement would create: a
 * workspace without them has nothing on them. The answer is of the moment; a placement checks
 * again under its locks. One thing is not known here: the site. A workspace without a paid
 * tariff whose site has spent its gift in another workspace is refused only when the reserve is
 * placed (`gift_site_used`).
 */
export async function newTaskCheck(tx: BillingTx, input: NewTaskQuery): Promise<NewTaskAnswer> {
  const { workspaceId, now } = dayQuerySchema.parse(input)
  // Not findUnique: the unique index on workspace_id covers live rows only.
  const subscription = await tx.subscription.findFirst({
    where: { workspaceId, status: { in: [...liveSubscriptionStatuses] } },
    select: { planId: true, status: true, currentPeriodStart: true, currentPeriodEnd: true },
  })
  const placedAt = placementMoment(now, subscription)
  // The accounts last, as a placement reads them: after everything it is checked by.
  const facts = await placementFacts(tx, { workspaceId, subscription, placedAt, continues: false })
  return newTaskVerdict({
    placement: 'new',
    accounts: await accountsNow(tx, workspaceId),
    ...facts,
  })
}

/**
 * The same answer for a user who has no workspace yet, about the task they could queue once
 * they add a site: nothing is held, no tariff gives a day and nothing is unpaid, and the gift
 * account will hold `giftCredits` — the gift of the registration, granted with the workspace.
 * Only the credit rate is read.
 */
export async function firstTaskCheck(
  tx: Pick<BillingTx, 'creditRate' | 'llmModelPrice'>,
  input: FirstTaskQuery,
): Promise<NewTaskAnswer> {
  const { giftCredits, now } = firstTaskQuerySchema.parse(input)
  const rate = await creditRateStatus(tx, now)
  return newTaskVerdict({
    placement: 'new',
    accounts: {
      tariff: emptyCreditAccount,
      gift: creditAccountSnapshot({ balance: giftCredits, held: 0 }),
      pack: emptyCreditAccount,
    },
    subscription: null,
    tariffCreditsToday: { charged: toCredits(0), held: toCredits(0) },
    unpaidWork: new Money(0),
    rateUsable: rate.verdict === 'usable',
  })
}

/**
 * Moves `expires_at` of every active reserve row of a task — for a task that waits longer than
 * its reserve lives: for a free account of the pool, for an answer of the customer. The rows of
 * a task have one expiry and move together. Returns the rows as they are now; none when the
 * task has no active reserve — it was charged or given back —, and nothing changes then.
 */
export async function extendTaskHolds(
  tx: BillingTx,
  input: TaskHoldsExtension,
): Promise<CreditHold[]> {
  const { taskId, expiresAt } = extensionSchema.parse(input)
  const { accounts } = await lockWorkspace(tx, await workspaceOfTask(tx, taskId), { create: false })
  const active = (await reserveRows(tx, taskId, accounts)).filter(
    (row) => row.hold.status === 'active',
  )
  await moveExpiry(tx, active, expiresAt)
  return active.map((row) => ({ ...row.hold, expiresAt }))
}

const negated = (credits: Credits): Decimal => new Money(credits).negated()

/**
 * Writes what a distribution says: the ledger rows and the changes of `balance` and `held`.
 *
 * A tariff row of an ended period pays under `hold:<holdId>:charge` and expires what it did
 * not pay under `hold:<holdId>:expire`; both rows take their share off `held` with them. Then
 * each account pays from its credits of now under `task:<taskId>:<attempt>:charge:<accountId>`,
 * and the same statement takes the other rows of the chain on that account off `held` — on every
 * account `paid <= reserved + free`, so `held <= balance` stands after it. An account that
 * pays nothing only loses the rows from `held`. The key of an account's charge names the chain
 * by its first attempt (`task:<taskId>:<attempt>:charge:<accountId>`): a task is charged pass
 * by pass.
 *
 * The rows are stamped with `now`, the charge of the tariff account like a tariff reserve —
 * inside the period whose credits it takes (`tariffHoldCreatedAt`) —, so the period of every
 * charge is told by a stamp and never by the clock of the database.
 */
async function postDistribution(
  tx: BillingTx,
  settlement: {
    taskId: string
    /** The first attempt of the chain the rows are of: what names its charge in the ledger. */
    attempt: number
    locked: LockedWorkspace
    distribution: ChargeDistribution
    now: Date
  },
): Promise<{ charges: CreditLedger[]; expiries: CreditLedger[] }> {
  const { taskId, attempt, locked, distribution, now } = settlement
  const charges: CreditLedger[] = []
  const expiries: CreditLedger[] = []
  const entry = { orderId: null, taskId, createdAt: now }
  for (const row of distribution.endedRows) {
    const account = accountOf(locked.accounts, 'tariff')
    if (row.paid > 0) {
      const amount = negated(row.paid)
      const idempotencyKey = ledgerKeys.holdCharge(row.id)
      charges.push(
        await post(tx, { ...entry, account, kind: 'charge', amount, held: amount, idempotencyKey }),
      )
    }
    if (row.expired > 0) {
      const amount = negated(row.expired)
      const idempotencyKey = ledgerKeys.holdExpiry(row.id)
      expiries.push(
        await post(tx, { ...entry, account, kind: 'expire', amount, held: amount, idempotencyKey }),
      )
    }
  }
  for (const kind of creditAccountKinds) {
    const { paid, reserved } = distribution.accounts[kind]
    if (paid === 0 && reserved === 0) continue
    const account = accountOf(locked.accounts, kind)
    if (paid === 0) {
      await tx.billingAccount.update({
        where: { id: account.id },
        data: { held: { decrement: new Money(reserved) } },
      })
      continue
    }
    const createdAt =
      kind === 'tariff' && locked.subscription !== null
        ? tariffHoldCreatedAt(now, locked.subscription)
        : now
    charges.push(
      await post(tx, {
        ...entry,
        account,
        kind: 'charge',
        amount: negated(paid),
        // An account that pays from free credits alone has no row of the task to let go of.
        ...(reserved === 0 ? {} : { held: negated(reserved) }),
        idempotencyKey: ledgerKeys.taskCharge(taskId, attempt, account.id),
        createdAt,
      }),
    )
  }
  return { charges, expiries }
}

/**
 * Moves the active rows of a task to the status they end in, all together. A captured row
 * records what it paid (`credit_holds.charged`, from `rows` of `distributeCharge`) in the same
 * statement that captures it — the database refuses a captured row of credits without it —:
 * one statement per row, since each row paid its own number. A returned row records nothing.
 */
async function settleRows(
  tx: BillingTx,
  active: readonly ReserveRow[],
  ending:
    { status: 'captured'; charged: readonly RowCharge[] } | { status: 'released' | 'expired' },
  now: Date,
): Promise<CreditHold[]> {
  const { status } = ending
  // The rows were read under the locks of their accounts: nobody else settles them.
  const changed = () => conflict('The reserve of the task changed while it was settled')
  if (ending.status !== 'captured') {
    const { count } = await tx.creditHold.updateMany({
      where: { id: { in: active.map((row) => row.hold.id) }, status: 'active' },
      data: { status, settledAt: now },
    })
    if (count !== active.length) throw changed()
    return active.map((row) => ({ ...row.hold, status, settledAt: now }))
  }
  const paid = new Map(ending.charged.map((row) => [row.id, row.charged]))
  for (const row of active) {
    const credits = paid.get(row.hold.id)
    if (credits === undefined) throw conflict('The charge of the task has no share for a row')
    const { count } = await tx.creditHold.updateMany({
      where: { id: row.hold.id, status: 'active' },
      data: { status, settledAt: now, charged: new Money(credits) },
    })
    if (count !== 1) throw changed()
  }
  // Read back, so that the answer is the rows as stored — and as a repeated charge reads them.
  const stored = new Map(
    (await tx.creditHold.findMany({ where: { id: { in: active.map((row) => row.hold.id) } } })).map(
      (hold) => [hold.id, hold],
    ),
  )
  return active.map((row) => {
    const hold = stored.get(row.hold.id)
    if (hold === undefined) throw changed()
    return hold
  })
}

const distributionInput = (
  locked: LockedWorkspace,
  active: readonly ReserveRow[],
  charge: Credits,
  tariffRoom: Credits | null,
) => ({
  charge,
  tariffRoom,
  rows: active.map((row) => ({
    id: row.hold.id,
    account: row.account,
    amount: row.credits,
    createdAt: row.hold.createdAt,
    placedAt: row.hold.placedAt,
  })),
  accounts: snapshots(locked.accounts),
  subscription:
    locked.subscription === null
      ? null
      : {
          status: locked.subscription.status,
          currentPeriodStart: locked.subscription.currentPeriodStart,
        },
})

/** The ledger rows that say tariff credits of these reserve rows were not carried over. */
const expiriesOf = (tx: BillingTx, rows: readonly ReserveRow[]): Promise<CreditLedger[]> =>
  tx.creditLedger.findMany({
    where: { idempotencyKey: { in: rows.map((row) => ledgerKeys.holdExpiry(row.hold.id)) } },
    orderBy: { id: 'asc' },
  })

/**
 * The posting half of the charge of a chain of a task: `credits` — what its work costs, the
 * caller's to compute (`chargeTask` reads the usage and calls this; tests of other packages
 * reach it through `@repo/billing/testing`) — are distributed over the accounts at this moment, not
 * copied from the reserve (`distributeCharge` of @repo/domain): a tariff row of an ended period
 * pays first and expires what it does not pay, then the tariff, the gift and the pack pay in
 * that order from the rows of the task and from what is free on them now — free tariff credits
 * no more than is left of the Moscow day of the charge, read under the locks
 * (`tariffCreditsOfDay`); that part counts on this day. The rows of the task pay whatever the
 * day — the reserve of a retry, which the day did not bound, among them —, so the day never cuts
 * a charge: it only decides how much of it moves onto free tariff credits. Every active reserve
 * row of the task becomes `captured` with what it paid; what the rows held above the charge
 * returns to its account — it simply stops being held.
 *
 * A task is charged pass by pass (owner's answer of 26.10.2026): each chain of active rows is
 * charged on its own, under keys that name it (`ledgerKeys.taskCharge`), and its rows are then
 * captured. A call that finds no active row finds the charges of the task in the ledger and
 * returns them all — what every call so far did; asked for another sum, it is a conflict. A task
 * with no active row and no charge is a conflict, never a silent zero. A charge above the reserve
 * of the chain is refused.
 */
export async function settleTaskCharge(
  tx: BillingTx,
  input: TaskChargeSettlement,
): Promise<SettledTaskCharge> {
  const { taskId, credits, now } = chargeSchema.parse(input)
  const workspaceId = await workspaceOfTask(tx, taskId)
  const locked = await lockWorkspace(tx, workspaceId, { create: false })
  const rows = await reserveRows(tx, taskId, locked.accounts)
  const active = rows.filter((row) => row.hold.status === 'active')
  const charged = () =>
    tx.creditLedger.findMany({ where: { taskId, kind: 'charge' }, orderBy: { id: 'asc' } })
  const before = await charged()

  if (active.length === 0) {
    if (before.length === 0) throw conflict('The task has no active reserve to charge')
    const captured = rows.filter((row) => row.hold.status === 'captured')
    const paidFrom = (kind: CreditAccountKind) =>
      toCredits(
        before
          .filter((entry) => entry.unit === creditAccountUnits[kind])
          .reduce((sum, entry) => sum.minus(entry.amount), new Money(0)),
      )
    const from = { tariff: paidFrom('tariff'), gift: paidFrom('gift'), pack: paidFrom('pack') }
    const total = toCredits(from.tariff + from.gift + from.pack)
    if (total !== credits) throw conflict('The task is already charged another amount')
    const expired = (await expiriesOf(tx, captured)).reduce(
      (sum, entry) => sum.minus(entry.amount),
      new Money(0),
    )
    return {
      credits: total,
      from,
      expired: toCredits(expired),
      entries: before,
      holds: captured.map((row) => row.hold),
      applied: false,
    }
  }
  // After the locks: the reserves and the charges of the workspace are serialized under them.
  const tariffRoom = await tariffRoomNow(tx, {
    workspaceId,
    subscription: locked.subscription,
    now,
  })
  const distribution = distributeCharge(
    distributionInput(locked, active, toCredits(credits), tariffRoom),
  )
  const { charges } = await postDistribution(tx, {
    taskId,
    attempt: Math.min(...chainOf(active)),
    locked,
    distribution,
    now,
  })
  const holds = await settleRows(
    tx,
    active,
    { status: 'captured', charged: distribution.rows },
    now,
  )
  return {
    credits: toCredits(credits),
    from: distribution.from,
    expired: distribution.expired,
    entries: charges,
    holds,
    applied: true,
  }
}

/**
 * What a charge took from free tariff credits above the task's own tariff rows — what counts on
 * the day of the charge (`tariffCreditsOfDay`): the tariff part of the charge less what the
 * captured tariff rows paid. A row of an ended period paid its own entry and cancels out.
 */
function freeTariffOf(charge: SettledTaskCharge): Credits {
  const byRows = charge.holds
    .filter((hold) => hold.unit === creditAccountUnits.tariff)
    .reduce((sum, hold) => sum.plus(hold.charged ?? 0), new Money(0))
  return toCredits(new Money(charge.from.tariff).minus(byRows))
}

/**
 * The statuses a task is charged in: a pass ended and the task waits for the client — an answer,
 * a question, a decision on its changes — or it is done (owner's answer of 26.10.2026: every
 * completed pass is charged, not the done task alone).
 */
const chargedTaskStatuses: ReadonlySet<string> = new Set([
  'awaiting_user',
  'awaiting_approval',
  'done',
])

/** audit_log actions of the charge of a task. */
export const taskChargeAuditActions = {
  /** A chain of a task was charged: what its work came to and which accounts paid. */
  charge: 'billing.task.charge',
} as const

/** Who charges a task: the platform itself, in the transaction that ends the task. */
const SYSTEM_ACTOR = { type: 'system', id: 'billing' } as const

/**
 * Why a task is not charged now — `details.charge` of the conflict, for the queue to act on.
 * `usage_open` passes by itself: the accounting of a turn key closes within minutes, and the
 * charge is asked again. `not_convertible` does not pass by itself, and `billing:rates` cannot
 * lift it: the command writes no rate in the past, and a call is converted only at the rate of
 * its own start. It is not expected — prices and the rate are written with one instant — and is
 * an operator's to resolve by hand. The other two say that the call does not belong: the task is
 * not done, or holds no reserve.
 */
export const taskChargeRefusals = [
  'not_done',
  'no_reserve',
  'usage_open',
  'not_convertible',
] as const
export type TaskChargeRefusal = (typeof taskChargeRefusals)[number]

const chargeRefused = (charge: TaskChargeRefusal, message: string): DomainError =>
  new DomainError('CONFLICT', message, 409, { charge })

/**
 * The billable work of the named attempts of a task in credits, not rounded (`taskRawCredits`).
 * While one counted call cannot be converted — no credit rate was in force at its start, or the
 * rate is older than the price the call was costed with — the work has no number: a conflict,
 * never a sum that leaves the call out.
 */
async function convertibleWork(tx: BillingTx, taskId: string, attempts: readonly number[]) {
  const work = await taskRawCredits(tx, { taskId, attempts })
  if (!work.convertible) {
    throw chargeRefused(
      'not_convertible',
      'A model call of the task has no credit rate to count by',
    )
  }
  return work
}

/**
 * How many turn keys of the named attempts of a task still have their accounting open, among
 * those whose calls a charge counts: a key of a turn that was lost or whose pass failed records
 * nothing `taskRawCredits` reads, so it holds nothing up. A key without a turn row counts.
 */
async function openCountedKeys(
  tx: BillingTx,
  taskId: string,
  attempts: readonly number[],
): Promise<number> {
  const [row] = await tx.$queryRaw<{ open: number }[]>`
    SELECT COUNT(*)::int AS open
    FROM llm_keys k
    LEFT JOIN task_turns t ON t.task_id = k.task_id AND t.turn_no = k.turn_no
    WHERE k.task_id = ${taskId}::uuid
      AND k.task_attempt = ANY(${[...attempts]}::int[])
      AND k.usage_closed_at IS NULL
      AND t.status IS DISTINCT FROM 'lost'::"TurnStatus"
      AND t.rejected_at IS NULL
  `
  return row?.open ?? 0
}

/**
 * The accounting cost of the counted work that stands above the reserve, RUB: a task is never
 * charged more than was set aside for it, so this part is the platform's. Zero while the work
 * fits the reserve. The cost is split in the proportion of the credits — exactly while the
 * calls started under one credit rate, by their average rate otherwise.
 */
function absorbedCostRub(work: { credits: Decimal; costRub: string }, reserved: Credits): string {
  if (work.credits.lte(reserved)) return new Money(0).toFixed(10)
  return new Money(work.costRub).mul(work.credits.minus(reserved)).div(work.credits).toFixed(10)
}

/**
 * Charges the active chain of a task whose pass ended (owner's answer of 26.10.2026: «любой
 * успешный запрос от LLM должен тарифицироваться» — a task is charged pass by pass, not once it
 * is done): what its work came to is read here, from the recorded model calls of the attempts it
 * pays for — those of its chain, which hold an active reserve, and those of the chains given
 * back since the last charge, by «Попробовать ещё» or as too small to charge (`workAttemptsOf`)
 * —, so a caller cannot pass a wrong sum. The billable calls are turned into credits at the rate
 * of their own start (`taskRawCredits`, which leaves out a lost turn and the turn of a pass that
 * failed), rounded once and bounded by the reserve of the chain and, for the first charge of the
 * task, by its minimum (`taskCharge`): min(reserved, max(5, round(used))) first, then
 * min(reserved, round(used)). A later charge of nothing gives the chain back: its work goes
 * with the next charge. The charge is then posted by `settleTaskCharge` — which accounts pay is
 * decided at this moment —, with one audit row `billing.task.charge` that keeps how the number
 * came about.
 *
 * Call it in the transaction that moves the task out of its pass — to wait for the client or to
 * `done` —, after that move: a task at work is not charged. The charge is final only when
 * the usage is: while a turn key whose calls it counts has its accounting open
 * (`usage_closed_at`), or a counted call cannot be converted into credits, the task is not
 * charged and nothing is written. Every refusal is a conflict that names its reason in
 * `details.charge` (`TaskChargeRefusal`); the queue asks again when the usage is closed.
 *
 * A call that finds no active reserve finds the charges of the task in the ledger and returns
 * their sum — what the calls so far did —, writing nothing. A task with no active reserve and no
 * charge — it never had one, as a task that is not billable, or gave it back — is a conflict,
 * never a silent zero. `tasks.cost_rub` is the queue's to write, not this function's.
 */
export async function chargeTask(tx: BillingTx, input: TaskHoldsEnding): Promise<ChargedTask> {
  const { taskId, now } = endingSchema.parse(input)
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: { workspaceId: true, status: true },
  })
  if (task === null) throw notFound('Task not found')
  // A pass is charged once it ends: the task waits for the client or is done, never at work.
  if (!chargedTaskStatuses.has(task.status))
    throw chargeRefused('not_done', 'A task at work is not charged')

  // The locks `settleTaskCharge` takes again: the rows read here are the rows it settles.
  const locked = await lockWorkspace(tx, task.workspaceId, { create: false })
  const rows = await reserveRows(tx, taskId, locked.accounts)
  const active = rows.filter((row) => row.hold.status === 'active')
  if (active.length === 0) {
    const { _sum: sum } = await tx.creditLedger.aggregate({
      where: { taskId, kind: 'charge' },
      _sum: { amount: true },
    })
    if (sum.amount === null) {
      throw chargeRefused('no_reserve', 'The task has no active reserve to charge')
    }
    // A charge is a negative amount of the journal.
    const credits = toCredits(new Money(0).minus(sum.amount))
    const settled = await settleTaskCharge(tx, { taskId, credits, now })
    return {
      ...settled,
      reserved: sumCredits(rows.filter((row) => row.hold.status === 'captured')),
    }
  }

  const attempts = workAttemptsOf(rows)
  // The keys before the usage: a key whose accounting is closed records no further call, so
  // the calls read after this check are all there will be.
  if ((await openCountedKeys(tx, taskId, attempts)) > 0)
    throw chargeRefused('usage_open', 'The usage of the task is not closed yet')
  const work = await convertibleWork(tx, taskId, attempts)

  const reserved = sumCredits(active)
  // The minimum of a task is its first charge's: a later pass pays its work, rounded.
  const first = rows.every((row) => row.hold.status !== 'captured')
  const charge = taskCharge({ used: work.credits, reserved, minimum: first })
  if (charge.credits === 0) {
    // Less than half a credit of work: nothing is charged now, the chain is given back, and its
    // work is counted with the next charge of the task (`workAttemptsOf`).
    const returned = await giveBack(tx, { taskId, now }, 'released')
    return {
      credits: toCredits(0),
      from: { tariff: toCredits(0), gift: toCredits(0), pack: toCredits(0) },
      expired: toCredits(0),
      entries: [],
      holds: returned.holds,
      applied: returned.applied,
      reserved,
    }
  }
  // What is left of the day, for the audit: the charge reads the same under the same locks.
  const tariffRoom = await tariffRoomNow(tx, {
    workspaceId: task.workspaceId,
    subscription: locked.subscription,
    now,
  })
  const settled = await settleTaskCharge(tx, { taskId, credits: charge.credits, now })
  await writeBillingAudit(tx, {
    actor: SYSTEM_ACTOR,
    workspaceId: task.workspaceId,
    action: taskChargeAuditActions.charge,
    target: { type: 'task', id: taskId },
    meta: {
      // The attempts whose work is in the charge; `givenBack` of them returned their reserve
      // to «Попробовать ещё» or to a pass too small to charge, the rest are the chain whose
      // reserve is captured. `first` — the first charge of the task, the one with its minimum.
      first,
      attempts: attempts.length,
      givenBack: attempts.length - chainOf(active).length,
      firstAttempt: Math.min(...attempts),
      lastAttempt: Math.max(...attempts),
      reserved,
      charged: settled.credits,
      fromTariff: settled.from.tariff,
      fromGift: settled.from.gift,
      fromPack: settled.from.pack,
      expired: settled.expired,
      tariffRoom,
      freeTariff: freeTariffOf(settled),
      costRub: work.costRub,
      rawCredits: work.credits.toFixed(),
      absorbedRub: absorbedCostRub(work, reserved),
      minimumApplied: charge.minimumApplied,
    },
  })
  return { ...settled, reserved }
}

/**
 * Takes every active reserve row of a task off `held` without a charge — what `releaseTask` and
 * `expireTaskHolds` both do; `settled` is the status the rows end in. Gift and pack credits
 * always return to their account.
 *
 * Tariff credits return only into the period they were reserved in (default «л» of
 * docs/plan/37-billing-plan.md, the rule is `returnedTariffCreditsExpire`): when a row is
 * stamped before the current period of the subscription, when the subscription no longer takes
 * tasks or the workspace has none, its credits expire instead — `balance` falls with `held` and
 * the ledger gets an `expire` row under the key `hold:<holdId>:expire`, linked to the task.
 *
 * A task whose reserve was already given back, either way, or that never had one, is answered
 * with what was given back before, and nothing changes. What was charged stays charged: only
 * the active chain is given back — the passes charged before it are the client's (26.10.2026).
 */
async function giveBack(
  tx: BillingTx,
  input: TaskHoldsEnding,
  settled: 'released' | 'expired',
): Promise<ReturnedTaskHolds> {
  const { taskId, now } = endingSchema.parse(input)
  const locked = await lockWorkspace(tx, await workspaceOfTask(tx, taskId), { create: false })
  // The chains charged before — a task is charged pass by pass — stay as they are.
  const rows = (await reserveRows(tx, taskId, locked.accounts)).filter(
    (row) => row.hold.status !== 'captured',
  )
  const active = rows.filter((row) => row.hold.status === 'active')
  if (active.length === 0) {
    return {
      holds: rows.map((row) => row.hold),
      expiries: await expiriesOf(tx, rows),
      applied: false,
    }
  }
  // Until the last `expires_at` the reserve answers for a task that may still be done and
  // charged: the rows of a task expire only together.
  if (settled === 'expired' && active.some((row) => now.getTime() < row.hold.expiresAt.getTime())) {
    throw conflict('The reserve of the task has not reached its expiry')
  }

  // A charge of nothing moves nothing onto free tariff credits: the day is not asked.
  const distribution = distributeCharge(distributionInput(locked, active, toCredits(0), null))
  const { expiries } = await postDistribution(tx, {
    taskId,
    attempt: Math.min(...chainOf(active)),
    locked,
    distribution,
    now,
  })
  // A charge of nothing: the shares of the rows are all zero, and a returned row records none.
  return { holds: await settleRows(tx, active, { status: settled }, now), expiries, applied: true }
}

/**
 * Gives back the reserve of a task that failed, was cancelled or was rolled back: every active
 * row becomes `released` and leaves `held` of its account. Gift and pack credits return; tariff
 * credits return only into the period they were reserved in and expire otherwise, with an
 * `expire` row under the key `hold:<holdId>:expire` (`giveBack`). The trusted undo of content
 * the task has written is the caller's to run first (P12).
 *
 * A repeated call changes nothing and returns what was given back, and so does a call for a
 * task that `expireTaskHolds` has expired or that never had a reserve. The passes charged before
 * stay charged.
 */
export function releaseTask(tx: BillingTx, input: TaskHoldsEnding): Promise<ReturnedTaskHolds> {
  return giveBack(tx, input, 'released')
}

/**
 * Gives back the reserve of a task that is stuck past `expires_at` (for example in
 * awaiting_user) — what the cron of the task queue calls: every active row becomes `expired`,
 * and the credits go where `releaseTask` would send them, by the same rule and under the same
 * ledger keys. Whoever expires a reserve does it here: taking credits off `held` by hand would
 * carry tariff credits of an ended period into the next one.
 *
 * The rows of a task expire only together and only when all of them are past `expires_at` by
 * `now`: while one is not, a conflict — with several attempts in a chain the rows of the first
 * would otherwise expire while the second works. A repeated call and a call for a released
 * task change nothing; the passes charged before stay charged.
 */
export function expireTaskHolds(tx: BillingTx, input: TaskHoldsEnding): Promise<ReturnedTaskHolds> {
  return giveBack(tx, input, 'expired')
}

/**
 * The reserve of one first call for the class of a task, RUB: `firstCallReserveRub` of the
 * enabled models of the class at their prices in force at `now`. With several such models the
 * greatest — a key must cover a first call whichever of them the pool gives the task. Without a
 * model that has a price no key can be issued at all: LLM_PRICE_MISSING.
 */
async function firstCallReserve(
  tx: Pick<BillingTx, 'llmModel'>,
  modelClass: ModelClass,
  now: Date,
): Promise<Decimal> {
  const models = await tx.llmModel.findMany({
    where: { enabled: true, modelClass },
    select: {
      reserveOutputTokens: true,
      prices: {
        where: { effectiveFrom: { lte: now } },
        orderBy: { effectiveFrom: 'desc' },
        take: 1,
        select: {
          inputPer1m: true,
          cacheReadPer1m: true,
          cacheWritePer1m: true,
          outputPer1m: true,
        },
      },
    },
  })
  const reserves = models.flatMap(({ reserveOutputTokens, prices: [price] }) =>
    price === undefined
      ? []
      : [
          new Money(
            firstCallReserveRub(reserveOutputTokens, {
              inputPer1m: price.inputPer1m.toFixed(6),
              cacheReadPer1m: price.cacheReadPer1m?.toFixed(6) ?? null,
              cacheWritePer1m: price.cacheWritePer1m?.toFixed(6) ?? null,
              outputPer1m: price.outputPer1m.toFixed(6),
            }),
          ),
        ],
  )
  if (reserves.length === 0) throw llmPriceMissing()
  return Money.max(...reserves)
}

/**
 * Whether a pass of the class could run at `now`: the planner finds its profile — the query it
 * asks itself (`classProfile` of @repo/db: an enabled model with a provider model id under an
 * enabled subscription provider among `backends`, the backends the caller knows) — and that
 * model has a price in force, so a key of it can be issued (`firstCallReserve`). Asked before a
 * dialog is moved to a class it has not run in — «Попробовать ещё» moves it to `heavy` —, so
 * that the press is refused at once instead of failing the pass `unavailable` with a reserve
 * held. Read only.
 */
export async function modelClassPriced(
  tx: Pick<BillingTx, 'llmModel' | 'llmModelPrice'>,
  input: { modelClass: ModelClass; backends: readonly string[]; now: Date },
): Promise<boolean> {
  const modelClass = modelClassSchema.parse(input.modelClass)
  const profile = await classProfile(tx, { modelClass, backends: input.backends })
  if (profile === null) return false
  const price = await tx.llmModelPrice.findFirst({
    where: { modelId: profile.modelId, effectiveFrom: { lte: input.now } },
    select: { id: true },
  })
  return price !== null
}

/**
 * What the workspace could set aside for one more attempt of a chain now, read without a lock:
 * the accounts as a continuation counts them, the tariff no more than is left of the Moscow day
 * of the moment a placement would take its credits at (`placementMoment`).
 */
async function spendableNow(tx: BillingTx, workspaceId: string, now: Date): Promise<Credits> {
  const subscription = await tx.subscription.findFirst({
    where: { workspaceId, status: { in: [...liveSubscriptionStatuses] } },
    select: { planId: true, status: true, currentPeriodStart: true, currentPeriodEnd: true },
  })
  const tariffRoom = await tariffRoomNow(tx, {
    workspaceId,
    subscription,
    now: placementMoment(now, subscription),
  })
  return spendableCredits(
    await accountsNow(tx, workspaceId),
    subscriptionAllowsTasks(subscription?.status ?? null),
    tariffRoom,
  ).total
}

/**
 * The numbers the next turn key of an attempt is bounded by, read only (design §3.3; spec §17,
 * «Правила списания», «Числа бюджета ключа хода»). The queue asks before each turn and after
 * the gateway refused a call for the budget, and decides by them whether the task goes on, asks
 * «Продолжить?» or tells that the credits ran out.
 *
 * Three limits line up. The customer's side: what the reserves of the chain — one pool — still
 * hold, max(0, reserved − used) × K, where `used` counts billable calls only, of the chain and of
 * the chains a retry gave back before it (`workAttemptsOf`). The platform's side: the step of
 * the class × K less everything the attempt itself has spent of the pool, billable or not. And
 * one first-call reserve above the customer's side, so that the last task of a balance can
 * finish; the charge never exceeds the reserve, so that much the platform may absorb. The key
 * gets the smaller side, less the reserves of the calls of the attempt that are still open, at
 * most 750 RUB — and nothing once the reserves hold nothing for the customer. K is the rate in
 * force at `now`; each call was turned into credits at the rate of its own start.
 *
 * The attempt must hold an active reserve of the task: a reserve is placed before a key is
 * asked for. A task that holds none — it is not billable, or its reserve was charged or given
 * back — gets `reserved` 0 and a budget of nothing; an attempt outside the chain of a task that
 * holds a reserve is a conflict. So are a task without a class of its model, a hold of the
 * rouble wallet and a counted call that cannot be converted into credits. Without a usable
 * credit rate — BILLING_CREDIT_RATE_MISSING, without an enabled model of the class that has a
 * price — LLM_PRICE_MISSING: no key is issued then.
 *
 * Takes no lock and writes nothing: the numbers are those of the moment, and the reserve is
 * checked again under its locks when it is placed, charged or given back.
 */
export async function attemptCreditBudget(
  tx: BillingTx,
  input: AttemptBudgetQuery,
): Promise<AttemptCreditBudget> {
  const { taskId, attempt, now } = budgetQuerySchema.parse(input)
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: { workspaceId: true, modelClass: true },
  })
  if (task === null) throw notFound('Task not found')
  const modelClass = modelClassSchema.safeParse(task.modelClass)
  if (!modelClass.success) throw conflict('A task without a class of its model has no step')

  const rows = await tx.creditHold.findMany({
    where: { taskId, status: { in: ['active', 'released'] } },
    select: { unit: true, attempt: true, amount: true, status: true },
  })
  if (rows.some((hold) => kindOfUnit(hold.unit) === undefined)) {
    throw conflict('The hold of the task is not a hold of credits')
  }
  const holds = rows.filter((hold) => hold.status === 'active')
  const chain = chainOf(holds.map((hold) => ({ hold })))
  if (chain.length > 0 && !chain.includes(attempt)) {
    throw conflict('The attempt holds no reserve of the task')
  }
  const reserved = toCredits(holds.reduce((sum, hold) => sum.plus(hold.amount), new Money(0)))

  const rate = await requireUsableCreditRate(tx, now)
  // What the chain answers for: its own work and that of the chains a retry gave back.
  const used =
    chain.length === 0
      ? new Money(0)
      : (await convertibleWork(tx, taskId, workAttemptsOf(rows.map((hold) => ({ hold }))))).credits
  const customerLeftRub = customerBudgetLeftRub({
    reserved,
    used,
    rubPerCredit: rate.rubPerCredit,
  })

  const step = toCredits(attemptStepCredits[modelClass.data])
  const [spent, opened] = await Promise.all([
    tx.tokenUsage.aggregate({ where: { taskId, taskAttempt: attempt }, _sum: { costRub: true } }),
    tx.llmCall.aggregate({
      where: { state: 'open', key: { taskId, taskAttempt: attempt } },
      _sum: { reservedRub: true },
    }),
  ])
  const ceilingLeft = Money.max(
    0,
    new Money(step).mul(rate.rubPerCredit).minus(spent._sum.costRub ?? 0),
  )
  const finish = await firstCallReserve(tx, modelClass.data, now)
  const openReserved = new Money(opened._sum.reservedRub ?? 0)

  const customerLeft = new Money(customerLeftRub)
  const budget = customerLeft.isZero()
    ? customerLeft
    : Money.max(
        0,
        Money.min(
          TURN_KEY_LIMIT_RUB,
          Money.min(customerLeft.plus(finish), ceilingLeft).minus(openReserved),
        ),
      )
  return {
    attempt,
    chainAttempts: chain.length,
    step,
    reserved,
    used,
    spendableNow: await spendableNow(tx, task.workspaceId, now),
    customerLeftRub,
    ceilingLeftRub: ceilingLeft.toFixed(10),
    finishRub: finish.toFixed(10),
    openReservedRub: openReserved.toFixed(10),
    budgetRub: budget.toFixed(2, Money.ROUND_DOWN),
  }
}
