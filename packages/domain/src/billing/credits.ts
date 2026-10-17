import type { Decimal } from 'decimal.js'
import { z } from 'zod'
import { badRequest } from '../errors.ts'
import type { ModelClass } from '../llm/model-class.ts'
import { decimalStringSchema, Money } from '../money.ts'
import { normalizeSiteHost } from '../policies/site-address.ts'
import type { TaskStatus } from '../tasks/task-status.ts'
import { attemptStepCredits, minStartCredits, minTaskChargeCredits } from './credit-numbers.ts'
import { rubPerCreditSchema } from './credit-rate.ts'
import type { TaskRefusalReason } from './errors.ts'
import {
  subscriptionAllowsTasks,
  subscriptionStatusSchema,
  type SubscriptionStatus,
} from './subscription.ts'

// The numbers of the model that the customer is told — the minimum of a task, the average, the
// typical examples, the steps — are written in a module of their own, which the pages of the
// browser can take without this one.
export * from './credit-numbers.ts'

// The numbers of the model that no text prints stay here. Like the others they are defaults of
// the design, in force until the owner says otherwise, and each is written once.

/**
 * «Продолжить» needs this many credits that can be spent: the work is in progress, its earlier
 * reserves stay, and the next attempt only has to reserve something. A new task and a retry need
 * `minStartCredits`.
 */
export const minContinueCredits = 1

/**
 * The most attempts one task may have. A new task is the first; «Продолжить» and «Попробовать
 * ещё» each start the next one; after the third the task is handed to a specialist or stopped.
 */
export const maxTaskAttempts = 3

/**
 * The bound on unpaid work of a workspace without a paid tariff, in credits: twice the gift of
 * the registration, counted from the end of its last tariff or from its creation. With a paid
 * tariff the bound is the monthly credits of the plan (`unpaidWork`, `newTaskVerdict`).
 */
export const trialUnpaidWorkCredits = 70

/**
 * A workspace keeps credits on three accounts. Tariff credits are granted anew every period and
 * the unspent ones expire; gift credits are granted once per user, at registration, and never
 * expire; pack credits are bought separately and never expire.
 *
 * The array is the order credits are spent in — the tariff, then the gift, then the pack: what
 * expires soonest goes first, and what was given goes before what was paid for. It is also the
 * order the accounts are locked in by a transaction that needs more than one.
 *
 * Tariff credits are also spent within a day: a paid plan says how many of them a Moscow day
 * may take (`dailyTariffCredits`), and a reserve or a charge takes no more of them than is left
 * of that day (`tariffDayRoom`). Gift and pack credits are outside the day.
 */
export const creditAccountKinds = ['tariff', 'gift', 'pack'] as const
export type CreditAccountKind = (typeof creditAccountKinds)[number]

/** billing_accounts.unit of each account; a hold and a ledger entry copy the unit. */
export const creditAccountUnits = Object.freeze({
  tariff: 'credit_tariff',
  gift: 'credit_gift',
  pack: 'credit_pack',
} as const satisfies Record<CreditAccountKind, string>)
export type CreditAccountUnit = (typeof creditAccountUnits)[CreditAccountKind]

// Credits are counts, not money: plans.credits_per_month and pack_credits are integers as well.
const wholeCountSchema = z.number().int().nonnegative()

/**
 * A whole count of the customer's credits, never negative. The type is branded: the credits of
 * a model provider, a count of tokens or a sum of roubles is not passed where the customer's
 * credits are expected. `toCredits` reads one from a number or from a column; the rules below
 * return them.
 */
export const creditsSchema = wholeCountSchema.brand<'Credits'>()
export type Credits = z.infer<typeof creditsSchema>

// The columns are Decimal(14,2) with a CHECK that keeps the three units whole; twelve integer
// digits fit a safe integer.
const columnCountSchema = wholeCountSchema.max(999_999_999_999)
const accountCreditsSchema = columnCountSchema.brand<'Credits'>()

export const creditAccountSnapshotSchema = z
  .strictObject({ balance: accountCreditsSchema, held: accountCreditsSchema })
  .refine((account) => account.held <= account.balance)

/**
 * `balance` and `held` of one credit account, read in one transaction, in whole credits.
 * held = Σ active holds and never exceeds balance.
 */
export type CreditAccountSnapshot = z.infer<typeof creditAccountSnapshotSchema>

export const creditAccountsSchema = z.strictObject({
  tariff: creditAccountSnapshotSchema,
  gift: creditAccountSnapshotSchema,
  pack: creditAccountSnapshotSchema,
})

/** The three accounts of a workspace; a missing row is `emptyCreditAccount`. */
export type CreditAccounts = z.infer<typeof creditAccountsSchema>

/** Frozen: count holds on a copy, `{ ...emptyCreditAccount }`. */
export const emptyCreditAccount: Readonly<CreditAccountSnapshot> = Object.freeze(
  creditAccountSnapshotSchema.parse({ balance: 0, held: 0 }),
)

/** A Decimal(14,2) column as the database client returns it, a decimal string or a number. */
export type CreditAmountValue = string | number | { toFixed(): string }

// What the column prints. decimal.js alone also reads hexadecimal, binary, octal, exponents,
// digit separators, a leading plus, a bare point and BigInt.
const plainDecimal = /^-?\d+(?:\.\d+)?$/

/** The whole number a value prints; null for a fraction and for what is not a plain decimal. */
function wholeNumber(value: CreditAmountValue): number | null {
  try {
    const printed: unknown = typeof value === 'object' ? value.toFixed() : value
    if (
      (typeof printed === 'number' && Number.isFinite(printed)) ||
      (typeof printed === 'string' && plainDecimal.test(printed))
    ) {
      const amount = new Money(printed)
      if (amount.isInteger()) return amount.isZero() ? 0 : amount.toNumber()
    }
  } catch {
    // null, or an object that cannot print itself
  }
  return null
}

function wholeCredits(value: CreditAmountValue): number {
  const whole = wholeNumber(value)
  if (whole === null) throw badRequest('Invalid credit account')
  return whole
}

/**
 * A count of credits from a number, or from an amount as the database prints it — the `amount`
 * of a hold or of a ledger row, a term of a plan. A fraction, a negative value and anything that
 * is not a plain decimal is refused.
 */
export function toCredits(value: CreditAmountValue): Credits {
  const result = creditsSchema.safeParse(wholeNumber(value))
  if (!result.success) throw badRequest('Invalid count of credits')
  return result.data
}

function requireAccount(
  account: z.input<typeof creditAccountSnapshotSchema>,
): CreditAccountSnapshot {
  const result = creditAccountSnapshotSchema.safeParse(account)
  if (!result.success) throw badRequest('Invalid credit account')
  return result.data
}

function requireAccounts(accounts: CreditAccounts): CreditAccounts {
  const result = creditAccountsSchema.safeParse(accounts)
  if (!result.success) throw badRequest('Invalid credit accounts')
  return result.data
}

/**
 * The snapshot of a billing_accounts row of unit `credit_tariff`, `credit_gift` or
 * `credit_pack`. A fraction, a negative value or held above balance is refused: such a row is
 * a RUB wallet or a bug upstream.
 */
export function creditAccountSnapshot(row: {
  balance: CreditAmountValue
  held: CreditAmountValue
}): CreditAccountSnapshot {
  return requireAccount({ balance: wholeCredits(row.balance), held: wholeCredits(row.held) })
}

export interface AvailableCredits {
  tariff: Credits
  gift: Credits
  pack: Credits
  /** What the customer sees as «осталось кредитов». */
  total: Credits
}

/** What is free on each account — balance minus held — and the sum of the three. */
export function availableCredits(accounts: CreditAccounts): AvailableCredits {
  const { tariff, gift, pack } = requireAccounts(accounts)
  const fromTariff = tariff.balance - tariff.held
  const fromGift = gift.balance - gift.held
  const fromPack = pack.balance - pack.held
  return {
    tariff: toCredits(fromTariff),
    gift: toCredits(fromGift),
    pack: toCredits(fromPack),
    total: toCredits(fromTariff + fromGift + fromPack),
  }
}

const tariffRoomSchema = accountCreditsSchema.nullable()

const tariffDaySchema = z.strictObject({
  limit: columnCountSchema.positive().nullable(),
  used: accountCreditsSchema,
})

/**
 * How many tariff credits a Moscow day still gives: max(0, limit − used); null when the day has
 * no limit. `limit` is `dailyTariffCredits` of the plan live now, `used` what the day has taken
 * of the tariff — reserves placed that day and what charges moved onto free tariff credits that
 * day. A renewal onto a smaller plan can leave `used` above the limit: nothing is left then.
 */
export function tariffDayRoom(day: { limit: Credits | null; used: Credits }): Credits | null {
  const result = tariffDaySchema.safeParse(day)
  if (!result.success) throw badRequest('Invalid tariff day')
  const { limit, used } = result.data
  return limit === null ? null : toCredits(Math.max(0, limit - used))
}

/**
 * What a task may take from each account now, and the sum: gift credits always, tariff and pack
 * credits only while the tariff is paid (`subscriptionAllowsTasks`). On each account it is what
 * is free there, balance minus held; on the tariff no more than `tariffRoom`, what is left of the
 * day (`tariffDayRoom`) — null, the default, when the day sets no limit.
 */
export function spendableCredits(
  accounts: CreditAccounts,
  tariffTakesTasks: boolean,
  tariffRoom: Credits | null = null,
): AvailableCredits {
  if (typeof tariffTakesTasks !== 'boolean') throw badRequest('Invalid state of the tariff')
  const room = tariffRoomSchema.safeParse(tariffRoom)
  if (!room.success) throw badRequest('Invalid room of the tariff day')
  const free = availableCredits(accounts)
  if (!tariffTakesTasks) {
    return { tariff: toCredits(0), gift: free.gift, pack: toCredits(0), total: free.gift }
  }
  if (room.data === null || room.data >= free.tariff) return free
  const tariff = room.data
  return { ...free, tariff, total: toCredits(tariff + free.gift + free.pack) }
}

/**
 * How many tariff credits expire when a period ends: the available balance. Held credits stay
 * on the account until their hold is captured or released.
 */
export function expiringTariffCredits(tariff: CreditAccountSnapshot): Credits {
  const { balance, held } = requireAccount(tariff)
  return toCredits(balance - held)
}

const isInstant = (value: Date): boolean =>
  value instanceof Date && Number.isFinite(value.getTime())

/**
 * `credit_holds.created_at` of a hold placed on the tariff account at `placedAt`: a moment of
 * the period the credit is taken from, because that stamp is all `returnedTariffCreditsExpire`
 * has to tell the period by when the hold gives the credit back.
 *
 * Never earlier than the start of the period: it starts when ЮKassa captured its payment, by
 * ЮKassa's clock, and the clock that queues the task may be behind. And never at or after its
 * end: a subscription stays active past `currentPeriodEnd` until its renewal is settled, the
 * credits on the account are still those of the period that ended, and the next period starts
 * exactly at that end — so a hold placed in between is stamped with the last millisecond of
 * the period it takes its credit from. The stamp tells the period and nothing else: the day a
 * reserve was placed on is told by `credit_holds.placed_at`, which keeps the moment itself.
 */
export function tariffHoldCreatedAt(
  placedAt: Date,
  period: { currentPeriodStart: Date; currentPeriodEnd: Date },
): Date {
  if (!isInstant(placedAt)) throw badRequest('Invalid hold placement time')
  const start = period.currentPeriodStart
  const end = period.currentPeriodEnd
  if (!isInstant(start) || !isInstant(end) || end.getTime() <= start.getTime()) {
    throw badRequest('Invalid subscription period')
  }
  return new Date(Math.max(start.getTime(), Math.min(placedAt.getTime(), end.getTime() - 1)))
}

/**
 * Whether a tariff credit that a hold gives back is gone with its period instead of returning
 * to the account. Tariff credits are not carried over, so the credit returns only into the
 * period it was reserved in, while that period is still paid for: the subscription takes tasks
 * and the hold is not older than its current period. It expires when the hold is of an earlier
 * period, when the subscription is past_due — its period is over and the next one starts with a
 * new quota — and when the workspace has no live subscription any more (`subscription` null).
 * `holdCreatedAt` is the stamp `tariffHoldCreatedAt` gave the hold. Gift and purchased credits
 * are not asked about here: they always return.
 */
export function returnedTariffCreditsExpire(
  holdCreatedAt: Date,
  subscription: { status: SubscriptionStatus; currentPeriodStart: Date } | null,
): boolean {
  if (!isInstant(holdCreatedAt)) throw badRequest('Invalid hold creation time')
  if (subscription === null) return true
  if (!isInstant(subscription.currentPeriodStart)) throw badRequest('Invalid period start')
  return (
    !subscriptionAllowsTasks(subscription.status) ||
    holdCreatedAt.getTime() < subscription.currentPeriodStart.getTime()
  )
}

// A reserve is at least one credit and fits an account.
const positiveCreditsSchema = columnCountSchema.positive()

/**
 * How many credits an attempt of a task sets aside when it is queued: the step of its class
 * (`attemptStepCredits`), or everything that can be spent when that is less. `spendable` is the
 * total of `spendableCredits`; nothing to spend gives zero, and such a placement is refused
 * before it comes to a reserve (`newTaskVerdict`).
 */
export function attemptReserveCredits(modelClass: ModelClass, spendable: Credits): Credits {
  if (!Object.hasOwn(attemptStepCredits, modelClass)) throw badRequest('Invalid model class')
  return toCredits(Math.min(attemptStepCredits[modelClass], toCredits(spendable)))
}

const reserveSchema = z.strictObject({
  accounts: creditAccountsSchema,
  amount: positiveCreditsSchema,
  tariffTakesTasks: z.boolean(),
  tariffRoom: tariffRoomSchema.default(null),
})

export interface CreditReserveInput {
  /** The three accounts as they are under their locks. */
  accounts: CreditAccounts
  /** The whole reserve of the attempt, `attemptReserveCredits`. */
  amount: Credits
  /** Whether the tariff is paid: without it only gift credits are reserved. */
  tariffTakesTasks: boolean
  /**
   * What is left of the day's tariff credits (`tariffDayRoom`): the tariff part of the reserve
   * is no larger. Null or left out — the day sets no limit.
   */
  tariffRoom?: Credits | null
}

/** The part of a reserve that stands on one account: one row of `credit_holds`. */
export interface CreditReservePart {
  account: CreditAccountKind
  amount: Credits
}

/**
 * The parts of a reserve by account, in the order credits are spent — the tariff, then the
 * gift, then the pack. Each account gives what a task may take from it (`spendableCredits`:
 * the tariff no more than is left of the day) until the amount is covered; an account that
 * gives nothing has no part. The amount must be spendable in full: a reserve is never larger
 * than what the accounts have free and the day leaves of the tariff.
 *
 * A reserve only says that the task can be paid for. Which credits pay is decided again when
 * the task is charged (`distributeCharge`).
 */
export function splitReserve(input: CreditReserveInput): CreditReservePart[] {
  const result = reserveSchema.safeParse(input)
  if (!result.success) throw badRequest('Invalid reserve')
  const { accounts, amount, tariffTakesTasks, tariffRoom } = result.data
  const spendable = spendableCredits(accounts, tariffTakesTasks, tariffRoom)
  if (amount > spendable.total) throw badRequest('The reserve exceeds the spendable credits')
  const parts: CreditReservePart[] = []
  let rest = amount
  for (const account of creditAccountKinds) {
    const part = Math.min(rest, spendable[account])
    if (part > 0) parts.push({ account, amount: toCredits(part) })
    rest -= part
  }
  return parts
}

const costAtRateSchema = z.strictObject({
  costRub: decimalStringSchema(12, 10),
  rubPerCredit: rubPerCreditSchema,
})

/**
 * The accounting cost of model calls that started under one credit rate — a sum of
 * `token_usage.cost_rub`, as the database prints it — and that rate.
 */
export type CostAtRate = z.infer<typeof costAtRateSchema>

// A quotient is taken with digits to spare and the sum is cut to the precision of Money, so the
// thirds and sixths of several divisions add up to the half they make and not to a hair below it.
const Quotient = Money.clone({ precision: 2 * Money.precision })

/**
 * The work of model calls in credits, not rounded: Σ cost ÷ K, every sum divided by the credit
 * rate its calls started under, so work that crosses a change of the rate needs no special
 * case. The caller sums the cost per attempt and per rate row and leaves out what is not
 * counted. Nothing is rounded here, per call or per attempt: a task is rounded once, when it is
 * charged (`taskCharge`) — and how the caller split the cost does not change that charge.
 */
export function creditsFromCost(sums: readonly CostAtRate[]): Decimal {
  const result = z.array(costAtRateSchema).safeParse(sums)
  if (!result.success) throw badRequest('Invalid cost of model calls')
  const credits = result.data.reduce<Decimal>(
    (sum, { costRub, rubPerCredit }) => sum.plus(new Quotient(costRub).div(rubPerCredit)),
    new Quotient(0),
  )
  return new Money(credits.toSignificantDigits(Money.precision, Money.ROUND_HALF_UP))
}

// Credits that are not rounded yet: a Decimal of any decimal.js constructor, never negative.
const unroundedCreditsSchema = z.custom<Decimal>(
  (value) => Money.isDecimal(value) && value.isFinite() && (value.isZero() || value.isPositive()),
)

/** What a done task is charged, and how the two bounds of the charge came into it. */
export interface TaskCharge {
  /** Whole credits. */
  credits: Credits
  /** The work came to less than the minimum of a done task, and the minimum is what counts. */
  minimumApplied: boolean
  /** The charge was cut to the reserve; what the work cost above it is the platform's. */
  capped: boolean
}

const chargedWorkSchema = z.strictObject({
  used: unroundedCreditsSchema,
  reserved: positiveCreditsSchema,
})

/** The work of a task's chain of attempts and what its reserves hold. */
export interface ChargedWork {
  /** The billable work of the attempts that have an active reserve, `creditsFromCost`. */
  used: Decimal
  /** Σ amount of the task's active reserve rows. */
  reserved: Credits
}

/**
 * What a done task costs: min(reserved, max(minTaskChargeCredits, round(used))). The work is
 * rounded once per task, HALF_UP, to a whole credit; then the minimum, then the cap of the
 * reserve — a task never costs more than was set aside for it, and an overrun of calls already
 * admitted is the platform's.
 */
export function taskCharge(work: ChargedWork): TaskCharge {
  const result = chargedWorkSchema.safeParse(work)
  if (!result.success) throw badRequest('Invalid work of a task')
  const { used, reserved } = result.data
  const rounded = new Money(used).toDecimalPlaces(0, Money.ROUND_HALF_UP)
  const due = Money.max(minTaskChargeCredits, rounded)
  return {
    credits: toCredits(Money.min(reserved, due).toNumber()),
    minimumApplied: rounded.lt(minTaskChargeCredits),
    capped: due.gt(reserved),
  }
}

/** How a task ends: its terminal statuses. */
export const taskOutcomes = [
  'done',
  'failed',
  'rolled_back',
  'cancelled',
] as const satisfies readonly TaskStatus[]
export type TaskOutcome = (typeof taskOutcomes)[number]

// What each ending costs — the one place that says it.
// - done: the result is on the site, the work is charged.
// - failed: the agent or the platform could not do it, the checks rejected the result or the
//   changes touched forbidden paths — nothing changed on the site.
// - rolled_back: the check after deployment failed and the site was restored.
// - cancelled: by the customer before the result is applied — «Остановиться» at a question and
//   declining «Что изменится» included — or by the platform, when no account of the pool came
//   free or the waiting time of a question ran out.
const chargedOutcomes = Object.freeze({
  done: true,
  failed: false,
  rolled_back: false,
  cancelled: false,
} as const satisfies Record<TaskOutcome, boolean>)

type ChargedOutcome = {
  [Outcome in TaskOutcome]: (typeof chargedOutcomes)[Outcome] extends true ? Outcome : never
}[TaskOutcome]

/** An ending of a task; one that is charged comes with the work of the task. */
export type TaskEnding =
  | ({ outcome: ChargedOutcome } & ChargedWork)
  | ({ outcome: Exclude<TaskOutcome, ChargedOutcome> } & Partial<ChargedWork>)

/**
 * What an ending of a task costs the customer. Only a done task is charged, by `taskCharge`; a
 * task that failed, was rolled back or was cancelled costs nothing, whatever work it took and
 * whoever stopped it: every reserve returns, and neither the minimum nor the cap applies.
 */
export function chargeForOutcome(ending: TaskEnding): TaskCharge {
  const outcome: unknown = (ending as TaskEnding | null)?.outcome
  if (typeof outcome !== 'string' || !Object.hasOwn(chargedOutcomes, outcome)) {
    throw badRequest('Invalid ending of a task')
  }
  if (!chargedOutcomes[outcome as TaskOutcome]) {
    return { credits: toCredits(0), minimumApplied: false, capped: false }
  }
  const { used, reserved } = ending as ChargedWork
  return taskCharge({ used, reserved })
}

const instantSchema = z.date().refine((value) => isInstant(value))

const reserveRowSchema = z.strictObject({
  id: z.string().min(1),
  account: z.enum(creditAccountKinds),
  amount: positiveCreditsSchema,
  createdAt: instantSchema,
  placedAt: instantSchema,
})

const chargeDistributionSchema = z.strictObject({
  charge: wholeCountSchema,
  rows: z.array(reserveRowSchema),
  accounts: creditAccountsSchema,
  subscription: z
    .strictObject({ status: subscriptionStatusSchema, currentPeriodStart: instantSchema })
    .nullable(),
  tariffRoom: tariffRoomSchema.default(null),
})

/** An active reserve row of the task that is charged. */
export interface CreditReserveRow {
  /** `credit_holds.id`. */
  id: string
  account: CreditAccountKind
  amount: Credits
  /** `credit_holds.created_at`: on a tariff row, the stamp of the period its credits are of. */
  createdAt: Date
  /**
   * `credit_holds.placed_at`: the moment the reserve was placed — on a tariff row, the day whose
   * tariff credits it takes. The rows of an account are paid from oldest first.
   */
  placedAt: Date
}

export interface ChargeDistributionInput {
  /** What the task costs, `taskCharge`; zero when it ends without a charge. */
  charge: Credits
  /**
   * Every active reserve row of the task, of all its attempts, by attempt: rows placed at one
   * moment are paid from in the order they are given.
   */
  rows: readonly CreditReserveRow[]
  /** The three accounts as they are under their locks, the task's rows still held on them. */
  accounts: CreditAccounts
  /** The live subscription of the workspace under its lock, null when none is live. */
  subscription: { status: SubscriptionStatus; currentPeriodStart: Date } | null
  /**
   * What is left of the tariff credits of the day of the charge (`tariffDayRoom`), read under
   * the locks: free tariff credits pay above the task's own rows no more than that. Null or left
   * out — the day sets no limit; a charge of zero moves nothing and needs none.
   */
  tariffRoom?: Credits | null
}

/** What a tariff row of an ended period pays; the rest of it expires, nothing returns. */
export interface EndedRowCharge {
  id: string
  paid: Credits
  expired: Credits
}

/** What an account pays from its credits of now. */
export interface AccountCharge {
  paid: Credits
  /**
   * The task's rows on the account that leave `held` together with this payment — all of them
   * but the tariff rows of an ended period, which are settled one by one. What they hold above
   * `paid` returns to the account.
   */
  reserved: Credits
}

/** What one reserve row of the task paid of the charge. */
export interface RowCharge {
  id: string
  /** Never above the row's amount; `credit_holds.charged` when the row is captured. */
  charged: Credits
}

export interface ChargeDistribution {
  /** Tariff rows of an ended period in the order they pay, oldest first. */
  endedRows: EndedRowCharge[]
  accounts: Record<CreditAccountKind, AccountCharge>
  /** The charge by the account it came from: on the tariff, ended rows and credits of now. */
  from: Record<CreditAccountKind, Credits>
  /** Tariff credits of an ended period that the charge did not take. */
  expired: Credits
  /**
   * What each row of the task paid, in the order the rows are given. On an account,
   * min(paid, reserved) is spread over its rows oldest first, each up to its amount; what the
   * account paid above its rows came from its free credits and is no row's. An ended row pays
   * what `endedRows` says.
   */
  rows: RowCharge[]
}

/**
 * Which credits pay for a task, decided at the moment of the charge and not copied from the
 * reserve: the reserve only guaranteed that the task could be paid for.
 *
 * 1. Tariff rows of an ended period pay first, oldest first, each up to its amount — the task
 *    was started on those credits — and what such a row does not pay expires. A row is of an
 *    ended period when it is stamped before the current one, and every tariff row is when the
 *    tariff no longer takes tasks (`returnedTariffCreditsExpire`).
 * 2. Then the accounts in the order credits are spent — the tariff, the gift, the pack — each
 *    paying as much of the rest as it has for the task: its other rows of the task and what is
 *    free on it now (`spendableCredits`: free tariff and pack credits only while the tariff is
 *    paid, free tariff credits no more than `tariffRoom`). So credits that came free since the
 *    reserve move the charge towards the front of the order, within what is left of the day;
 *    credits another task still holds are never taken. The task's own rows always pay, whatever
 *    the day: the work was started on them.
 *
 * The charge never exceeds the rows, so it is always covered. On each account
 * `paid <= reserved + free`, which keeps `held <= balance` when both leave the account in one
 * statement. A charge of zero settles a task that ends without one: ended rows expire, the
 * other rows return.
 */
export function distributeCharge(input: ChargeDistributionInput): ChargeDistribution {
  const result = chargeDistributionSchema.safeParse(input)
  if (!result.success) throw badRequest('Invalid charge of a task')
  const { charge, rows, accounts, subscription, tariffRoom } = result.data
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw badRequest('A reserve row is given twice')
  }

  const ended: (typeof rows)[number][] = []
  const reserved: Record<CreditAccountKind, number> = { tariff: 0, gift: 0, pack: 0 }
  const held: Record<CreditAccountKind, number> = { tariff: 0, gift: 0, pack: 0 }
  for (const row of rows) {
    held[row.account] += row.amount
    if (row.account === 'tariff' && returnedTariffCreditsExpire(row.createdAt, subscription)) {
      ended.push(row)
    } else {
      reserved[row.account] += row.amount
    }
  }
  if (creditAccountKinds.some((kind) => held[kind] > accounts[kind].held)) {
    throw badRequest('The reserve rows exceed what their account holds')
  }
  if (charge > held.tariff + held.gift + held.pack) {
    throw badRequest('The charge exceeds the reserve of the task')
  }

  let rest = charge
  // Array.prototype.sort is stable: rows of one stamp pay in the order they were given.
  const endedRows = ended
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((row) => {
      const paid = Math.min(rest, row.amount)
      rest -= paid
      return { id: row.id, paid: toCredits(paid), expired: toCredits(row.amount - paid) }
    })

  const tariffTakesTasks = subscription !== null && subscriptionAllowsTasks(subscription.status)
  const free = spendableCredits(accounts, tariffTakesTasks, tariffRoom)
  const paidNow: Record<CreditAccountKind, number> = { tariff: 0, gift: 0, pack: 0 }
  for (const kind of creditAccountKinds) {
    paidNow[kind] = Math.min(rest, reserved[kind] + free[kind])
    rest -= paidNow[kind]
  }

  // What each row paid: the ended rows by `endedRows`; on an account, what it paid from the
  // task's rows — up to their sum — is spread over them oldest first, each up to its amount.
  // An older row pays first, so a charge frees the room of a later day before an earlier one.
  const rowCharged = new Map<string, number>(endedRows.map((ended) => [ended.id, ended.paid]))
  const endedIds = new Set(rowCharged.keys())
  for (const kind of creditAccountKinds) {
    let own = Math.min(paidNow[kind], reserved[kind])
    const current = rows
      .filter((row) => row.account === kind && !endedIds.has(row.id))
      .sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime())
    for (const row of current) {
      const paid = Math.min(own, row.amount)
      rowCharged.set(row.id, paid)
      own -= paid
    }
  }

  const fromEnded = endedRows.reduce((sum, row) => sum + row.paid, 0)
  const share = (kind: CreditAccountKind): AccountCharge => ({
    paid: toCredits(paidNow[kind]),
    reserved: toCredits(reserved[kind]),
  })
  return {
    endedRows,
    accounts: { tariff: share('tariff'), gift: share('gift'), pack: share('pack') },
    from: {
      tariff: toCredits(fromEnded + paidNow.tariff),
      gift: toCredits(paidNow.gift),
      pack: toCredits(paidNow.pack),
    },
    expired: toCredits(endedRows.reduce((sum, row) => sum + row.expired, 0)),
    rows: rows.map((row) => ({ id: row.id, charged: toCredits(rowCharged.get(row.id) ?? 0) })),
  }
}

const budgetLeftSchema = z.strictObject({
  reserved: columnCountSchema,
  used: unroundedCreditsSchema,
  rubPerCredit: rubPerCreditSchema,
})

export interface CustomerBudgetInput {
  /** Σ amount of the task's active reserve rows, the whole chain; zero when it has none. */
  reserved: Credits
  /** The billable work of the chain's attempts, `creditsFromCost`: lost calls are not in it. */
  used: Decimal
  /** The credit rate in force now. */
  rubPerCredit: string
}

/**
 * What the reserves of a task still hold for the customer, in RUB of accounting cost at the
 * credit rate of now: max(0, reserved − used) × K. It is what bounds the next turn key of the
 * task from the customer's side; the step of the attempt bounds it from the platform's.
 *
 * A string in the precision of `token_usage.cost_rub`, rounded down: the key is never given
 * what the reserve does not hold.
 */
export function customerBudgetLeftRub(input: CustomerBudgetInput): string {
  const result = budgetLeftSchema.safeParse(input)
  if (!result.success) throw badRequest('Invalid budget of a task')
  const { reserved, used, rubPerCredit } = result.data
  const left = Money.max(0, new Money(reserved).minus(used))
    .mul(rubPerCredit)
    .toDecimalPlaces(10, Money.ROUND_DOWN)
  if (left.gte('100000000')) throw badRequest('The budget of a task exceeds its supported range')
  return left.toFixed(10)
}

const unpaidWorkSchema = z.strictObject({
  work: unroundedCreditsSchema,
  charged: wholeCountSchema,
})

export interface UnpaidWorkInput {
  /**
   * Everything the billable tasks of the workspace spent of the pool since the bound is counted
   * from, in credits (`creditsFromCost`) — billable calls or not: a lost call spent the pool
   * too. Work in progress is in it until it is charged.
   */
  work: Decimal
  /** The credits charged to the three accounts of the workspace since the same moment. */
  charged: Credits
}

/**
 * The work a workspace got without a charge, in credits, not rounded: max(0, work − charged).
 * Failed, cancelled and rolled-back tasks cost the customer nothing, so this is what bounds
 * them: new tasks and retries stop when it reaches the monthly credits of the paid tariff —
 * counted from the start of its current period — or `trialUnpaidWorkCredits` without a paid
 * tariff, counted from the end of the last tariff or from the creation of the workspace
 * (`newTaskVerdict`).
 */
export function unpaidWork(input: UnpaidWorkInput): Decimal {
  const result = unpaidWorkSchema.safeParse(input)
  if (!result.success) throw badRequest('Invalid unpaid work')
  const { work, charged } = result.data
  return Money.max(0, new Money(work).minus(charged))
}

/**
 * What asks for a reserve. `new`: the first attempt of a task. `continuation`: «Продолжить» —
 * the next attempt of a task whose earlier reserves are active. `retry`: «Попробовать ещё» —
 * a later attempt after a failure released every reserve.
 *
 * Each places reserve rows stamped with the moment they are placed (`credit_holds.placed_at`):
 * the tariff part of a continuation and of a retry takes credits of the day it is placed on,
 * like that of a new task (`tariffDayRoom`).
 */
export const taskPlacements = ['new', 'continuation', 'retry'] as const
export type TaskPlacement = (typeof taskPlacements)[number]

// What the active reserve rows of one task hold on each account.
const taskReserveSchema = z.strictObject({
  tariff: accountCreditsSchema,
  gift: accountCreditsSchema,
  pack: accountCreditsSchema,
})
const noTaskReserve: Readonly<Record<CreditAccountKind, number>> = Object.freeze({
  tariff: 0,
  gift: 0,
  pack: 0,
})

const tariffCreditsTodaySchema = z.strictObject({
  charged: accountCreditsSchema,
  held: accountCreditsSchema,
})

const newTaskSchema = z.strictObject({
  placement: z.enum(taskPlacements),
  accounts: creditAccountsSchema,
  heldByTask: taskReserveSchema.optional(),
  subscription: z
    .strictObject({
      status: subscriptionStatusSchema,
      creditsPerMonth: positiveCreditsSchema,
      creditsPerDay: positiveCreditsSchema.nullable(),
    })
    .nullable(),
  tariffCreditsToday: tariffCreditsTodaySchema,
  unpaidWork: unroundedCreditsSchema,
  rateUsable: z.boolean(),
  giftSiteClaimedElsewhere: z.boolean().default(false),
})

/** What the tariff of a workspace gave the Moscow day so far, in whole credits. */
export interface TariffCreditsToday {
  /**
   * Paid: what the charged reserve rows placed in the day paid, and what the charges settled in
   * the day took from free tariff credits above the task's own tariff rows.
   */
  charged: Credits
  /** Set aside: the tariff rows placed in the day that are still active, in full. */
  held: Credits
}

export interface NewTaskInput {
  placement: TaskPlacement
  /** The three accounts of the workspace, read together. */
  accounts: CreditAccounts
  /**
   * What the active reserve rows of the task itself hold on each account — part of `held` of
   * the accounts. A continuation has such rows and must say what they hold; a new task and a
   * retry have none and leave it out.
   */
  heldByTask?: Record<CreditAccountKind, Credits>
  /** The live subscription of the workspace with the terms of its plan; null when none is live. */
  subscription: {
    status: SubscriptionStatus
    /** `plans.credits_per_month`: the bound on unpaid work of a period. */
    creditsPerMonth: number
    /** `plans.credits_per_day`: the tariff credits a Moscow day may take; null — no limit. */
    creditsPerDay: number | null
  } | null
  /**
   * The tariff credits the Moscow day of the placement has taken so far (`tariffCreditsOfDay`
   * of @repo/billing), for every placement: a continuation and a retry take credits of the day
   * like a new task.
   */
  tariffCreditsToday: TariffCreditsToday
  /** `unpaidWork` of the workspace. */
  unpaidWork: Decimal
  /** Whether a usable credit rate is in force (`creditRateVerdict`). */
  rateUsable: boolean
  /**
   * The site of the task has spent gift credits in another workspace (`siteHostKey`). Known
   * only when a reserve is placed: a page of the workspace does not know the site and leaves
   * it out.
   */
  giftSiteClaimedElsewhere?: boolean
}

// The subscription of the workspace with the terms of its plan; other fields are not asked about.
const dailyTariffSchema = z
  .object({
    status: subscriptionStatusSchema,
    creditsPerDay: columnCountSchema.positive().nullable(),
  })
  .nullable()

/**
 * How many tariff credits a Moscow day may take (`plans.credits_per_day`) while the tariff is
 * paid; null when the plan sets no daily limit, and without a paid tariff — tariff credits are
 * not spent then, and gift and pack credits are outside the day.
 */
export function dailyTariffCredits(
  subscription: { status: SubscriptionStatus; creditsPerDay: number | null } | null,
): Credits | null {
  const result = dailyTariffSchema.safeParse(subscription)
  if (!result.success) throw badRequest('Invalid daily limit of a plan')
  const live = result.data
  if (live === null || !subscriptionAllowsTasks(live.status) || live.creditsPerDay === null) {
    return null
  }
  return toCredits(live.creditsPerDay)
}

/**
 * The tariff credits of the Moscow day of a paid tariff, as the pages and the refusals tell
 * them. `used` = `charged` + `held` can stand above `limit` after a renewal onto a smaller plan;
 * `room` = max(0, `limit` − `used`) is then nothing. `left` = min(`room`, free tariff credits) is
 * what the tariff can still give today: the room, or less when the account itself has less.
 */
export interface TariffDay {
  /** `plans.credits_per_day`; null — the plan sets no daily limit. */
  limit: Credits | null
  charged: Credits
  held: Credits
  used: Credits
  /** null exactly when `limit` is. */
  room: Credits | null
  left: Credits
}

/** Whether a task is taken; the numbers stand in both answers. */
export type NewTaskVerdict = {
  /**
   * The credits a task may spend by the accounts, `spendableCredits` without the day: what
   * «осталось» and «отложено» say. A refusal for credits (step 2 below) is told by it.
   */
  spendable: Credits
  /**
   * What a task may take now: `spendable` with the tariff part no larger than what is left of
   * the day. The reserve of an attempt is the step or this, whichever is less.
   */
  spendableNow: Credits
  /**
   * What other tasks in work hold on the accounts a task may spend: the reserve of the task
   * that asks (`heldByTask`) is not in it.
   */
  held: Credits
  /** How many spendable credits this placement needs. */
  needed: Credits
  /** The tariff credits of the day; null without a paid tariff — there is no day then. */
  today: TariffDay | null
} & ({ allowed: true; reason: null } | { allowed: false; reason: TaskRefusalReason })

/**
 * Whether a task is taken, and why not — computed once: the queue refuses by it
 * (`taskRefusal`) and the pages report it, so they never disagree.
 *
 * The checks come in one order, and the first that fails is the reason:
 * 1. a usable credit rate — `rate_missing`;
 * 2. credits on the accounts, the limit a payment lifts. A new task and a retry need
 *    `minStartCredits` that can be spent, a continuation `minContinueCredits`. Below that:
 *    `held` when the accounts hold that much and other tasks in work have it set aside; with a
 *    paid tariff `empty` or, with a few credits left, `below_start`; without one `past_due` for
 *    an overdue tariff, `ended` when credits of a pack wait for a tariff, otherwise `gift_spent`
 *    or `gift_below_start`;
 * 3. the day, for every placement: the tariff credits free within what is left of the day,
 *    with the gift and pack credits, cannot cover what the placement needs although the
 *    accounts can — `daily_limit`. Only a paid tariff whose plan has a daily limit gets here; a
 *    pack bought today lifts it;
 * 4. unpaid work, for a new task and a retry: against the monthly credits of the plan —
 *    `unpaid_limit` — or `trialUnpaidWorkCredits` — `trial_unpaid_limit`;
 * 5. without a paid tariff, the gift of the site: `gift_site_used` when another workspace has
 *    spent gift credits on it.
 *
 * A continuation is never refused by unpaid work: the work is in progress and will be charged
 * if it is done. It is refused by the day like a new task — it would take tariff credits of
 * the day otherwise — and waits for the next day or a pack.
 *
 * The reserve of the task that asks is not «tasks in work» to wait for: it stays held whatever
 * the answer is. So a continuation — the one placement of a task that has a reserve — says what
 * its rows hold (`heldByTask`), and when they hold everything it is told that the credits ran
 * out (`empty`, `gift_spent`), not to wait. The accounts do not say whose rows hold them: a
 * continuation without its reserve is refused as a bad request rather than answered by a guess,
 * and so is a new task or a retry that names one.
 */
export function newTaskVerdict(input: NewTaskInput): NewTaskVerdict {
  const result = newTaskSchema.safeParse(input)
  if (!result.success) throw badRequest('Invalid check of a new task')
  const { placement, accounts, subscription, tariffCreditsToday, rateUsable } = result.data
  const own = result.data.heldByTask ?? noTaskReserve
  if (creditAccountKinds.some((kind) => own[kind] > accounts[kind].held)) {
    throw badRequest('The reserve of the task exceeds what its account holds')
  }
  const hasReserve = own.tariff + own.gift + own.pack > 0
  if ((placement === 'continuation') !== hasReserve) {
    throw badRequest('The placement does not agree with the reserve of the task')
  }
  const paid = subscription !== null && subscriptionAllowsTasks(subscription.status)
  const free = spendableCredits(accounts, paid)
  const today = paid ? tariffDay(subscription.creditsPerDay, tariffCreditsToday, free.tariff) : null
  const heldByOthers = (kind: CreditAccountKind): number => accounts[kind].held - own[kind]
  const numbers = {
    spendable: free.total,
    spendableNow: spendableCredits(accounts, paid, today?.room ?? null).total,
    held: toCredits(
      heldByOthers('gift') + (paid ? heldByOthers('tariff') + heldByOthers('pack') : 0),
    ),
    needed: toCredits(placement === 'continuation' ? minContinueCredits : minStartCredits),
    today,
  }
  const refused = (reason: TaskRefusalReason): NewTaskVerdict => ({
    ...numbers,
    allowed: false,
    reason,
  })

  if (!rateUsable) return refused('rate_missing')

  if (numbers.spendable < numbers.needed) {
    if (numbers.spendable + numbers.held >= numbers.needed) return refused('held')
    const nothing = numbers.spendable === 0
    if (paid) return refused(nothing ? 'empty' : 'below_start')
    if (subscription?.status === 'past_due') return refused('past_due')
    if (accounts.pack.balance > accounts.pack.held) return refused('ended')
    return refused(nothing ? 'gift_spent' : 'gift_below_start')
  }

  if (numbers.spendableNow < numbers.needed) return refused('daily_limit')

  if (placement !== 'continuation') {
    const unpaidLimit = paid ? subscription.creditsPerMonth : trialUnpaidWorkCredits
    if (new Money(result.data.unpaidWork).gte(unpaidLimit)) {
      return refused(paid ? 'unpaid_limit' : 'trial_unpaid_limit')
    }
  }

  if (!paid && result.data.giftSiteClaimedElsewhere) return refused('gift_site_used')
  return { ...numbers, allowed: true, reason: null }
}

/** The day of a paid tariff: its limit, what the day took, and what is left of it. */
function tariffDay(
  creditsPerDay: number | null,
  taken: TariffCreditsToday,
  freeTariff: Credits,
): TariffDay {
  const limit = creditsPerDay === null ? null : toCredits(creditsPerDay)
  const used = toCredits(taken.charged + taken.held)
  const room = tariffDayRoom({ limit, used })
  return {
    limit,
    charged: taken.charged,
    held: taken.held,
    used,
    room,
    left: toCredits(room === null ? freeTariff : Math.min(room, freeTariff)),
  }
}

/**
 * The key a site is known by when its gift is claimed (`gift_site_claims.host_key`): one site
 * spends gift credits in one workspace only. Built from the address a site is stored with, an
 * http or https origin: the host as the platform normalises it (`normalizeSiteHost` — lower
 * case, punycode, no trailing dot) without one leading `www.`, and the port when the origin
 * has one — without it every local site would be one key. The scheme is not in the key:
 * `http://`, `https://` and `www.` of one host are one site.
 */
export function siteHostKey(siteOrigin: string): string {
  const url = parseOrigin(siteOrigin)
  const host = url === null ? null : normalizeSiteHost(url.hostname)
  if (url === null || host === null) throw badRequest('Invalid site address')
  const name = host.replace(/^www\.(?=.)/, '')
  if (url.port === '') return name
  // An IPv6 literal keeps its brackets before a port: `::1:8080` is another address.
  return `${name.includes(':') ? `[${name}]` : name}:${url.port}`
}

/** An http(s) origin, with or without the closing slash; null for anything else. */
function parseOrigin(text: string): URL | null {
  // Refused before parsing: URL drops tabs and line breaks and reads `\` as `/`.
  if (typeof text !== 'string' || /[\s\\]/.test(text)) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  const isOrigin =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === ''
  return isOrigin ? url : null
}
