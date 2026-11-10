import { lockUserRow, type CreditLedger, type LedgerKind } from '@repo/db'
import {
  billingNoLiveSubscription,
  billingOrderNotFound,
  carriedTariffCredits,
  conflict,
  creditAccountKinds,
  creditAccountUnits,
  expiringTariffCredits,
  isLiveSubscription,
  Money,
  notFound,
  signupGiftCredits,
  tariffHoldCreatedAt,
  toCredits,
  type CreditAccountKind,
  type Credits,
  type OrderKind,
  type SubscriptionStatus,
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

/**
 * Idempotency keys of credit_ledger (docs/plan/37-billing-plan.md, «Ключи идемпотентности»):
 * one key per thing that may happen once.
 */
export const ledgerKeys = {
  /** The quota of the period a subscription order paid for. */
  tariffGrant: (orderId: string) => `order:${orderId}:grant`,
  /** The credits of a paid pack order. */
  packGrant: (orderId: string) => `order:${orderId}:pack`,
  /**
   * What was available on the tariff account when the period ended: all of it expires, and at a
   * renewal the part that is carried comes back under `tariffCarry`.
   */
  tariffExpiry: (subscriptionId: string, periodEnd: Date) =>
    `sub:${subscriptionId}:${periodEnd.getTime()}:expire`,
  /**
   * What a renewal carried from the period that ended into the next one (decision of 06.11.2026,
   * docs/plan/63-new-pricing.md, §2): a `grant` that no order paid for. The key names the period
   * the credits come from, as the expiry beside it does.
   */
  tariffCarry: (subscriptionId: string, periodEnd: Date) =>
    `sub:${subscriptionId}:${periodEnd.getTime()}:carry`,
  /**
   * What a chain of attempts of a task is charged on one account, from the credits the account
   * has for it at the moment of the charge: one row per chain — named by its first attempt — and
   * account, whatever attempts of the chain reserved there. A task is charged pass by pass since
   * 26.10.2026; a charge before then is one row per task and account, `task:<taskId>:charge:<accountId>`.
   */
  taskCharge: (taskId: string, attempt: number, accountId: string) =>
    `task:${taskId}:${attempt}:charge:${accountId}`,
  /**
   * What a done task is charged from a tariff reserve whose period has ended, or whose tariff
   * no longer takes tasks: the task was started on those credits, and the row pays first.
   */
  holdCharge: (holdId: string) => `hold:${holdId}:charge`,
  /**
   * The tariff credits of such a reserve that its task did not use, or gave back: they are not
   * carried over — what a period carries is decided when it ends, from the credits available
   * then, and these were held.
   */
  holdExpiry: (holdId: string) => `hold:${holdId}:expire`,
  /** The credits an operator took off the account when returning the payment of a pack. */
  refundAdjust: (orderId: string) => `order:${orderId}:refund:adjust`,
  /**
   * What a grant paid of the workspace's debt (КР7): a `charge` of the granted account, linked to
   * the order of the grant and to no task — the passes that ran into debt were charged before.
   */
  debtRepay: (grantKey: string) => `${grantKey}:debt`,
  /** The gift of the registration: one per user, on whichever workspace of theirs it stands. */
  signupGift: (userId: string) => `user:${userId}:signup-gift`,
} as const

/** audit_log actions of the gift. */
export const giftAuditActions = {
  /** The gift of the registration was granted to the gift account of a workspace. */
  grant: 'billing.gift.grant',
} as const

export interface LedgerPosting {
  /** The ledger row of the key: written by this call, or by the earlier one that used the key. */
  entry: CreditLedger
  /** false: the key was already in the ledger, and this call changed nothing. */
  applied: boolean
}

const grantSchema = z.strictObject({
  workspaceId: z.uuid(),
  /** The paid order the credits come from: an order of this workspace, of the account's kind. */
  orderId: z.uuid(),
  credits: z.number().int().positive(),
})
export type CreditGrant = z.infer<typeof grantSchema>

const expirySchema = z.strictObject({
  workspaceId: z.uuid(),
  /** A subscription of this workspace. */
  subscriptionId: z.uuid(),
  /** current_period_end of the period that ended, while the subscription still stands in it. */
  periodEnd: z.date(),
})
export type TariffExpiry = z.infer<typeof expirySchema>

/** What became of the tariff credits that were available when a period ended. */
export interface TariffPeriodEnd {
  /** The `expire` row of all of them; null when none were available. */
  expired: LedgerPosting | null
  /**
   * The `grant` row, without an order, of the part carried into the next period; null when
   * nothing was carried — the tariff ended, nothing was available, or the period had no quota.
   */
  carried: LedgerPosting | null
}

const signupGiftSchema = z.strictObject({
  /** Whose gift it is: a user gets one, whatever workspaces they have. */
  userId: z.uuid(),
  /** A workspace the user owns: the gift goes to its gift account. */
  workspaceId: z.uuid(),
})
export type SignupGift = z.infer<typeof signupGiftSchema>

/**
 * What pays for the credits of an account an order grants to: a tariff period or a pack, never
 * the other one. The gift account is not here: no order pays for a gift.
 */
const grantingOrderKinds = {
  tariff: 'subscription',
  pack: 'pack',
} as const satisfies Partial<Record<CreditAccountKind, OrderKind>>

/**
 * The row an earlier call wrote under this key, or null. A key that stands for another account,
 * kind or amount is a bug of the caller: nothing may be skipped or written in its name.
 */
export async function posted(
  tx: BillingTx,
  idempotencyKey: string,
  expected: { account: LockedCreditAccount; kind: LedgerKind; amount?: Decimal },
): Promise<CreditLedger | null> {
  const entry = await tx.creditLedger.findUnique({ where: { idempotencyKey } })
  if (entry === null) return null
  if (
    entry.accountId !== expected.account.id ||
    entry.kind !== expected.kind ||
    (expected.amount !== undefined && !entry.amount.equals(expected.amount))
  ) {
    throw conflict('The ledger key is already used by a different entry')
  }
  return entry
}

/**
 * Moves the balance and writes the ledger row of the movement. The balance changes in SQL
 * (`balance = balance + amount`) under the lock the caller holds on the account, and the row
 * keeps the balance that came out; the CHECKs of the account refuse a movement below zero or
 * below what is held.
 */
export async function post(
  tx: BillingTx,
  posting: {
    account: LockedCreditAccount
    kind: LedgerKind
    /** Signed, in whole credits: a grant is positive, a charge or an expiry negative. */
    amount: Decimal
    /**
     * Signed change of `held`, made by the same statement as the balance: credits that leave
     * the account through their hold take its share of `held` with them, so `held <= balance`
     * stands after every statement.
     */
    held?: Decimal
    orderId: string | null
    taskId?: string | null
    idempotencyKey: string
    /** Why an operator made the entry, for an `adjust`; at most 500 characters. */
    note?: string
    /**
     * The stamp of the row, `created_at`; the clock of the database unless given. The charge of
     * a task says by it which period of the tariff its credits are of (`settleTaskCharge`).
     */
    createdAt?: Date
  },
): Promise<CreditLedger> {
  const { account, kind, amount, held, orderId, taskId = null, idempotencyKey, note } = posting
  const { createdAt } = posting
  const { balance } = await tx.billingAccount.update({
    where: { id: account.id },
    data: {
      balance: { increment: amount },
      ...(held === undefined ? {} : { held: { increment: held } }),
    },
    select: { balance: true },
  })
  return tx.creditLedger.create({
    data: {
      accountId: account.id,
      unit: account.unit,
      kind,
      amount,
      balanceAfter: balance,
      orderId,
      taskId,
      idempotencyKey,
      ...(note === undefined ? {} : { note }),
      ...(createdAt === undefined ? {} : { createdAt }),
    },
  })
}

async function grant(
  tx: BillingTx,
  kind: keyof typeof grantingOrderKinds,
  key: (orderId: string) => string,
  input: CreditGrant,
): Promise<LedgerPosting> {
  const { workspaceId, orderId, credits } = grantSchema.parse(input)
  // Credits go to the workspace that paid for them and to the account the order paid for,
  // whatever ids the caller holds: the two grant keys of one order never both apply.
  const order = await tx.order.findFirst({
    where: { id: orderId, workspaceId, kind: grantingOrderKinds[kind] },
    select: { id: true, periodStart: true, periodEnd: true },
  })
  if (order === null) throw billingOrderNotFound()
  await ensureAccounts(tx, workspaceId)
  const account = await lockCreditAccount(tx, workspaceId, kind)
  // Only a transaction that does not see rows committed after its start gets here.
  if (account === null) throw conflict('The credit account is not visible to this transaction')
  const amount = new Money(credits)
  const idempotencyKey = key(orderId)
  const entry = await posted(tx, idempotencyKey, { account, kind: 'grant', amount })
  if (entry) return { entry, applied: false }
  const granted = await post(tx, { account, kind: 'grant', amount, orderId, idempotencyKey })
  await repayDebt(tx, {
    workspaceId,
    account,
    orderId,
    grantKey: idempotencyKey,
    period:
      order.periodStart !== null && order.periodEnd !== null
        ? { currentPeriodStart: order.periodStart, currentPeriodEnd: order.periodEnd }
        : null,
  })
  return { entry: granted, applied: true }
}

/**
 * Pays what the workspace owes from the credits a grant has just brought (owner's decision of
 * 10.11.2026, docs/spec.md §20, «Только кредиты», КР7): min(debt, what is free on the granted
 * account), one `charge` row of that account under `ledgerKeys.debtRepay`, and the debt of the
 * pack account goes down by as much. A grant smaller than the debt pays what it brought; the
 * rest waits for the next grant. Nothing when nothing is owed.
 *
 * Called under the lock of the granted account; the pack account is locked after it — the order
 * of `creditAccountKinds` —, or is that account.
 */
async function repayDebt(
  tx: BillingTx,
  input: {
    workspaceId: string
    account: LockedCreditAccount
    orderId: string
    grantKey: string
    /** The period the order paid for, when it has one: what a tariff charge is stamped inside. */
    period: { currentPeriodStart: Date; currentPeriodEnd: Date } | null
  },
): Promise<void> {
  const { workspaceId, orderId, grantKey, period } = input
  const granted = await lockCreditAccount(tx, workspaceId, kindOf(input.account))
  const pack =
    granted?.unit === creditAccountUnits.pack
      ? granted
      : await lockCreditAccount(tx, workspaceId, 'pack')
  if (granted === null || pack === null || pack.debt === 0) return
  const free = granted.snapshot.balance - granted.snapshot.held
  const paid = Math.min(pack.debt, free)
  if (paid <= 0) return
  // The meter of the tariff tells the period of a charge by its stamp alone, like every other
  // charge of the tariff account (`tariffHoldCreatedAt`): the period of a first payment starts
  // when ЮKassa captured it, by ЮKassa's clock, and the clock of this transaction may be behind.
  const createdAt =
    period !== null && granted.unit === creditAccountUnits.tariff
      ? tariffHoldCreatedAt(new Date(), period)
      : undefined
  await post(tx, {
    account: granted,
    kind: 'charge',
    amount: new Money(-paid),
    orderId,
    idempotencyKey: ledgerKeys.debtRepay(grantKey),
    ...(createdAt === undefined ? {} : { createdAt }),
  })
  await tx.billingAccount.update({
    where: { id: pack.id },
    data: { debt: { decrement: new Money(paid) } },
  })
}

const kindOf = (account: LockedCreditAccount): CreditAccountKind => {
  const kind = creditAccountKinds.find((each) => creditAccountUnits[each] === account.unit)
  if (kind === undefined) throw conflict('The account is not a credit account')
  return kind
}

/**
 * Grants the quota of a paid subscription period to the tariff account (`credit_tariff`),
 * creating the accounts of the workspace when it has none. Once per order: a repeated call
 * returns the row of the first one and changes nothing. Whether the order is paid is the
 * caller's business — it settles the order in the same transaction; here the order only has to
 * be a subscription order of the workspace.
 */
export function grantTariffCredits(tx: BillingTx, input: CreditGrant): Promise<LedgerPosting> {
  return grant(tx, 'tariff', ledgerKeys.tariffGrant, input)
}

/**
 * Grants the credits of a paid pack to the account of purchased credits (`credit_pack`); the
 * tariff account is not touched. Once per pack order of the workspace, like `grantTariffCredits`.
 */
export function grantPackCredits(tx: BillingTx, input: CreditGrant): Promise<LedgerPosting> {
  return grant(tx, 'pack', ledgerKeys.packGrant, input)
}

/** Who grants the gift: the platform itself, in the request that made the user's workspace. */
const GIFT_ACTOR = { type: 'system', id: 'billing' } as const

/**
 * Grants the gift of the registration — `signupGiftCredits` — to the gift account
 * (`credit_gift`) of a workspace the user owns, creating the accounts of the workspace when it
 * has none: one `grant` row that no order paid for, under the key `user:<userId>:signup-gift`,
 * and the audit entry `billing.gift.grant` with it.
 *
 * Once per user, on whichever workspace it was first called for. The key is the user's and the
 * account is a workspace's, so the key is looked up across accounts: a repeated call, and a
 * call for another workspace of the same user, return the row of the first one with
 * `applied: false` and change nothing — «already granted», never a conflict. A gift keeps the
 * amount it was granted with when the constant changes later.
 *
 * Takes the lock of the user's row (`lockUserRow`), so concurrent calls for one user grant one
 * gift; a caller that created the workspace with `ensurePersonalWorkspace` holds it already.
 * The transaction must be READ COMMITTED: after the lock it has to see what the previous
 * holder committed. A user who no longer exists and a workspace the user does not own are not
 * found.
 */
export async function grantSignupGift(tx: BillingTx, input: SignupGift): Promise<LedgerPosting> {
  const { userId, workspaceId } = signupGiftSchema.parse(input)
  // Before any account: nothing else that takes this lock holds an account at that moment.
  if (!(await lockUserRow(tx, userId))) throw notFound('User not found')
  // The credits go to a workspace of the user the gift is for, whatever ids the caller holds.
  const workspace = await tx.workspace.findFirst({
    where: { id: workspaceId, members: { some: { userId, role: 'owner' } } },
    select: { id: true },
  })
  if (workspace === null) throw notFound('Workspace not found')

  const idempotencyKey = ledgerKeys.signupGift(userId)
  // Not `posted`: that one refuses a key that stands on another account, and this key may
  // rightly stand on the gift account of another workspace of the user.
  const before = await tx.creditLedger.findUnique({ where: { idempotencyKey } })
  if (before !== null) {
    if (before.kind !== 'grant' || before.unit !== creditAccountUnits.gift) {
      throw conflict('The ledger key is already used by a different entry')
    }
    return { entry: before, applied: false }
  }

  await ensureAccounts(tx, workspaceId)
  const account = await lockCreditAccount(tx, workspaceId, 'gift')
  // Only a transaction that does not see rows committed after its start gets here.
  if (account === null) throw conflict('The credit account is not visible to this transaction')
  const entry = await post(tx, {
    account,
    kind: 'grant',
    amount: new Money(signupGiftCredits),
    orderId: null,
    idempotencyKey,
  })
  await writeBillingAudit(tx, {
    actor: GIFT_ACTOR,
    workspaceId,
    action: giftAuditActions.grant,
    target: { type: 'billing_account', id: account.id },
    meta: { userId, credits: signupGiftCredits },
  })
  return { entry, applied: true }
}

/**
 * The subscription of the workspace, locked until the transaction ends: whoever ends or renews
 * its period waits here for the one before. READ COMMITTED sees the row as that one left it.
 * NO KEY: orders that refer to the subscription are not held up. Undefined when the workspace
 * has no such subscription.
 */
async function lockSubscriptionPeriod(
  tx: Pick<BillingTx, '$queryRaw'>,
  workspaceId: string,
  subscriptionId: string,
): Promise<
  { status: SubscriptionStatus; currentPeriodStart: Date; currentPeriodEnd: Date } | undefined
> {
  const [row] = await tx.$queryRaw<
    { status: SubscriptionStatus; currentPeriodStart: Date; currentPeriodEnd: Date }[]
  >`
    SELECT status::text AS status, current_period_start AS "currentPeriodStart",
      current_period_end AS "currentPeriodEnd"
    FROM subscriptions
    WHERE id = ${subscriptionId}::uuid AND workspace_id = ${workspaceId}::uuid
    FOR NO KEY UPDATE
  `
  return row
}

/**
 * The quota the period that starts at `periodStart` was granted on the tariff account: the
 * `grant` rows of the orders that paid for it — the order whose `period_start` is the start of
 * the period, as «Использование» finds it. Zero when no order paid for it: a period whose dates
 * were changed by hand.
 */
async function periodQuota(
  tx: Pick<BillingTx, '$queryRaw'>,
  account: LockedCreditAccount,
  periodStart: Date,
): Promise<Credits> {
  const [row] = await tx.$queryRaw<{ granted: string }[]>`
    SELECT COALESCE(SUM(l.amount), 0)::text AS granted
    FROM credit_ledger l
    JOIN orders o ON o.id = l.order_id
    WHERE l.account_id = ${account.id}::uuid AND l.kind = 'grant'
      AND o.period_start = ${periodStart}::timestamptz
  `
  return toCredits(row?.granted ?? 0)
}

/**
 * Closes the tariff credits of a period that ends: every available credit (`balance − held`)
 * expires; with `carry` — a renewal — the part `carriedTariffCredits` allows comes back as a
 * `grant` without an order. Held credits stay until their hold is captured or released; gift and
 * purchased credits never expire, and their accounts are neither locked nor read here.
 *
 * A period with nothing available leaves no row and so no key, therefore the subscription
 * itself says whether the period is still open: credits expire only while it is live and
 * `periodEnd` is its `current_period_end`. A repeat after the period moved on or the
 * subscription ended returns the rows of the first time, or nulls when there were none, and
 * never touches the quota granted since. A subscription the workspace does not have is refused
 * with BILLING_NO_LIVE_SUBSCRIPTION. Locks the subscription row, then the tariff account: a
 * transaction that locks the subscription as well does it before any account.
 */
async function closeTariffPeriod(
  tx: BillingTx,
  { workspaceId, subscriptionId, periodEnd }: TariffExpiry,
  carry: boolean,
): Promise<TariffPeriodEnd> {
  const nothing = { expired: null, carried: null }
  const subscription = await lockSubscriptionPeriod(tx, workspaceId, subscriptionId)
  if (subscription === undefined) throw billingNoLiveSubscription()
  const account = await lockCreditAccount(tx, workspaceId, 'tariff')
  if (account === null) return nothing
  const expiryKey = ledgerKeys.tariffExpiry(subscriptionId, periodEnd)
  const carryKey = ledgerKeys.tariffCarry(subscriptionId, periodEnd)
  const expiry = await posted(tx, expiryKey, { account, kind: 'expire' })
  if (expiry) {
    // Both rows are written together, so the first time is told by the expiry alone.
    const carry = await posted(tx, carryKey, { account, kind: 'grant' })
    return {
      expired: { entry: expiry, applied: false },
      carried: carry === null ? null : { entry: carry, applied: false },
    }
  }
  const periodIsOpen =
    isLiveSubscription(subscription.status) &&
    subscription.currentPeriodEnd.getTime() === periodEnd.getTime()
  if (!periodIsOpen) return nothing
  const credits = expiringTariffCredits(account.snapshot)
  if (credits === 0) return nothing
  const carriedCredits = carry
    ? carriedTariffCredits(
        account.snapshot,
        await periodQuota(tx, account, subscription.currentPeriodStart),
      )
    : 0
  const expired = await post(tx, {
    account,
    kind: 'expire',
    amount: new Money(credits).negated(),
    orderId: null,
    idempotencyKey: expiryKey,
  })
  if (carriedCredits === 0) return { expired: { entry: expired, applied: true }, carried: null }
  const carried = await post(tx, {
    account,
    kind: 'grant',
    amount: new Money(carriedCredits),
    orderId: null,
    idempotencyKey: carryKey,
  })
  return { expired: { entry: expired, applied: true }, carried: { entry: carried, applied: true } }
}

/**
 * Expires what is left of the tariff quota when the tariff ends with its period — it is not
 * renewed, its grace is over, or an operator ends it with a refund: the available credits only
 * (`balance − held`), and nothing is carried. Held credits stay until their hold is captured or
 * released; gift and purchased credits never expire, and their accounts are neither locked nor
 * read here. Returns null when there was nothing to expire — no account, or nothing available —
 * and writes nothing then.
 *
 * Call it before the subscription is closed, in the transaction that does so; a renewal calls
 * `carryTariffRemainder` instead. The rest is that of `closeTariffPeriod`: a repeat returns the
 * row of the first time, or null when there was none; a subscription the workspace does not
 * have is refused with BILLING_NO_LIVE_SUBSCRIPTION; the subscription row is locked before the
 * tariff account.
 */
export async function expireTariffRemainder(
  tx: BillingTx,
  input: TariffExpiry,
): Promise<LedgerPosting | null> {
  const { expired } = await closeTariffPeriod(tx, expirySchema.parse(input), false)
  return expired
}

/**
 * Ends the period of the tariff credits at a renewal — a paid renewal or a payment of an overdue
 * tariff: the subscription goes on into a next period. All the available credits expire under
 * `sub:<subscriptionId>:<periodEndMs>:expire`, and the part that stays (`carriedTariffCredits`:
 * no more than the quota the period that ended was granted) is granted back under
 * `sub:<subscriptionId>:<periodEndMs>:carry`, without an order. So each row names the period it
 * comes from — «Использование» counts the carry in the period after the one in its key, the
 * period its renewal opened — and what is lost in fact is the difference: what was left of the
 * carry of the period before, which has lived its one period.
 *
 * Call it before the subscription is moved to its next period, in the transaction that does so
 * and grants the next quota. Once per period, like `expireTariffRemainder`: a repeat returns the
 * rows of the first time and writes nothing; the locks are the same.
 */
export async function carryTariffRemainder(
  tx: BillingTx,
  input: TariffExpiry,
): Promise<TariffPeriodEnd> {
  return closeTariffPeriod(tx, expirySchema.parse(input), true)
}
