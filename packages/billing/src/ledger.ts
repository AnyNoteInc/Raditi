import { lockUserRow, type CreditLedger, type LedgerKind } from '@repo/db'
import {
  billingNoLiveSubscription,
  billingOrderNotFound,
  conflict,
  creditAccountUnits,
  expiringTariffCredits,
  isLiveSubscription,
  Money,
  notFound,
  signupGiftCredits,
  type CreditAccountKind,
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
  /** What was left of the tariff quota when the period ended. */
  tariffExpiry: (subscriptionId: string, periodEnd: Date) =>
    `sub:${subscriptionId}:${periodEnd.getTime()}:expire`,
  /**
   * What a done task is charged on one account, from the credits the account has for it at the
   * moment of the charge: one row per task and account, whatever attempts reserved there.
   */
  taskCharge: (taskId: string, accountId: string) => `task:${taskId}:charge:${accountId}`,
  /**
   * What a done task is charged from a tariff reserve whose period has ended, or whose tariff
   * no longer takes tasks: the task was started on those credits, and the row pays first.
   */
  holdCharge: (holdId: string) => `hold:${holdId}:charge`,
  /**
   * The tariff credits of such a reserve that its task did not use, or gave back: they are not
   * carried over.
   */
  holdExpiry: (holdId: string) => `hold:${holdId}:expire`,
  /** The credits an operator took off the account when returning the payment of a pack. */
  refundAdjust: (orderId: string) => `order:${orderId}:refund:adjust`,
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
    select: { id: true },
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
  return {
    entry: await post(tx, { account, kind: 'grant', amount, orderId, idempotencyKey }),
    applied: true,
  }
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
): Promise<{ status: SubscriptionStatus; currentPeriodEnd: Date } | undefined> {
  const [row] = await tx.$queryRaw<{ status: SubscriptionStatus; currentPeriodEnd: Date }[]>`
    SELECT status::text AS status, current_period_end AS "currentPeriodEnd" FROM subscriptions
    WHERE id = ${subscriptionId}::uuid AND workspace_id = ${workspaceId}::uuid
    FOR NO KEY UPDATE
  `
  return row
}

/**
 * Expires what is left of the tariff quota when its period ends: the available credits only
 * (`balance − held`). Held credits stay until their hold is captured or released; gift and
 * purchased credits never expire, and their accounts are neither locked nor read here. Returns
 * null when there was nothing to expire — no account, or nothing available — and writes nothing
 * then.
 *
 * Call it before the subscription is moved to its next period or closed, in the transaction
 * that does so. A period with nothing available leaves no row and so no key, therefore the
 * subscription itself says whether the period is still open: credits expire only while it is
 * live and `periodEnd` is its `current_period_end`. A repeat after the period moved on or the
 * subscription ended returns the row of the first time, or null when there was none, and never
 * touches the quota granted since. A subscription the workspace does not have is refused with
 * BILLING_NO_LIVE_SUBSCRIPTION. Locks the subscription row, then the tariff account: a
 * transaction that locks the subscription as well does it before any account.
 */
export async function expireTariffRemainder(
  tx: BillingTx,
  input: TariffExpiry,
): Promise<LedgerPosting | null> {
  const { workspaceId, subscriptionId, periodEnd } = expirySchema.parse(input)
  const subscription = await lockSubscriptionPeriod(tx, workspaceId, subscriptionId)
  if (subscription === undefined) throw billingNoLiveSubscription()
  const account = await lockCreditAccount(tx, workspaceId, 'tariff')
  if (account === null) return null
  const idempotencyKey = ledgerKeys.tariffExpiry(subscriptionId, periodEnd)
  const entry = await posted(tx, idempotencyKey, { account, kind: 'expire' })
  if (entry) return { entry, applied: false }
  const periodIsOpen =
    isLiveSubscription(subscription.status) &&
    subscription.currentPeriodEnd.getTime() === periodEnd.getTime()
  if (!periodIsOpen) return null
  const credits = expiringTariffCredits(account.snapshot)
  if (credits === 0) return null
  const amount = new Money(credits).negated()
  return {
    entry: await post(tx, { account, kind: 'expire', amount, orderId: null, idempotencyKey }),
    applied: true,
  }
}
