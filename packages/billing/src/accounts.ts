import type { Prisma } from '@repo/db'
import {
  creditAccountSnapshot,
  creditAccountUnits,
  type CreditAccountKind,
  type CreditAccountSnapshot,
  type CreditAccountUnit,
} from '@repo/domain'

/**
 * The transaction every write of this package joins: the caller opens it (READ COMMITTED, the
 * default) and decides what else commits with the billing rows.
 */
export type BillingTx = Prisma.TransactionClient

/**
 * After this call the workspace has its three credit accounts: `credit_tariff` for the credits
 * of the tariff, `credit_gift` for the gift of the registration and `credit_pack` for purchased
 * ones, empty when created here. An existing account is left as it is; repeated and concurrent
 * calls are safe.
 */
export async function ensureAccounts(
  tx: Pick<BillingTx, 'billingAccount'>,
  workspaceId: string,
): Promise<void> {
  await tx.billingAccount.createMany({
    data: Object.values(creditAccountUnits).map((unit) => ({ workspaceId, unit })),
    skipDuplicates: true,
  })
}

/** A credit account whose row is locked until the transaction ends. */
export interface LockedCreditAccount {
  id: string
  unit: CreditAccountUnit
  /** `balance` and `held` as they are under the lock, in whole credits. */
  snapshot: CreditAccountSnapshot
}

/**
 * Locks one credit account of the workspace, so that everything the transaction then reads and
 * writes on it is serialized with the other writers of the account. null when the workspace has
 * no such account yet. A transaction that needs more than one account locks them in the order
 * of `creditAccountKinds` — the tariff, then the gift, then the pack — and one that locks the
 * subscription row too (`expireTariffRemainder`, `placeCreditHold`, `settleTaskCharge`,
 * `releaseTask`, `expireTaskHolds` and `extendTaskHolds` do) locks it before any of them; the
 * row of the user (`grantSignupGift`) is locked before all of these. One order for everyone, so
 * two of them never wait for each other.
 */
export async function lockCreditAccount(
  tx: Pick<BillingTx, '$queryRaw'>,
  workspaceId: string,
  kind: CreditAccountKind,
): Promise<LockedCreditAccount | null> {
  const unit = creditAccountUnits[kind]
  const [row] = await tx.$queryRaw<{ id: string; balance: Prisma.Decimal; held: Prisma.Decimal }[]>`
    SELECT id, balance, held FROM billing_accounts
    WHERE workspace_id = ${workspaceId}::uuid AND unit = ${unit}::"BillingUnit"
    FOR UPDATE
  `
  return row ? { id: row.id, unit, snapshot: creditAccountSnapshot(row) } : null
}
