import { z } from 'zod'
import { badRequest } from '../errors.ts'
import { Money } from '../money.ts'

/**
 * A workspace keeps edits on two accounts. Tariff edits are granted anew every period and the
 * unspent ones expire; pack edits are bought separately and never expire.
 */
export const editAccountKinds = ['tariff', 'pack'] as const
export type EditAccountKind = (typeof editAccountKinds)[number]

/** billing_accounts.unit of each account; a hold and a ledger entry copy the unit. */
export const editAccountUnits = Object.freeze({
  tariff: 'edit',
  pack: 'edit_pack',
} as const satisfies Record<EditAccountKind, string>)
export type EditAccountUnit = (typeof editAccountUnits)[EditAccountKind]

// Edits are counts, not money: plans.edits_per_month and pack_edits are integers as well. The
// columns are Decimal(14,2) with a CHECK that keeps both units whole; twelve integer digits
// fit a safe integer.
const wholeEditsSchema = z.number().int().nonnegative().max(999_999_999_999)

export const editAccountSnapshotSchema = z
  .strictObject({ balance: wholeEditsSchema, held: wholeEditsSchema })
  .refine((account) => account.held <= account.balance)

/**
 * `balance` and `held` of one edit account, read in one transaction, in whole edits.
 * held = Σ active holds and never exceeds balance.
 */
export type EditAccountSnapshot = z.infer<typeof editAccountSnapshotSchema>

export const editAccountsSchema = z.strictObject({
  tariff: editAccountSnapshotSchema,
  pack: editAccountSnapshotSchema,
})

/** Both accounts of a workspace; a missing row is `emptyEditAccount`. */
export type EditAccounts = z.infer<typeof editAccountsSchema>

/** Frozen: count holds on a copy, `{ ...emptyEditAccount }`. */
export const emptyEditAccount: Readonly<EditAccountSnapshot> = Object.freeze({
  balance: 0,
  held: 0,
})

/** A Decimal(14,2) column as the database client returns it, a decimal string or a number. */
export type EditAmountValue = string | number | { toFixed(): string }

// What the column prints. decimal.js alone also reads hexadecimal, binary, octal, exponents,
// digit separators, a leading plus, a bare point and BigInt.
const plainDecimal = /^-?\d+(?:\.\d+)?$/

function wholeEdits(value: EditAmountValue): number {
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
  throw badRequest('Invalid edit account')
}

function requireAccount(account: EditAccountSnapshot): EditAccountSnapshot {
  const result = editAccountSnapshotSchema.safeParse(account)
  if (!result.success) throw badRequest('Invalid edit account')
  return result.data
}

function requireAccounts(accounts: EditAccounts): EditAccounts {
  const result = editAccountsSchema.safeParse(accounts)
  if (!result.success) throw badRequest('Invalid edit accounts')
  return result.data
}

/**
 * The snapshot of a billing_accounts row of unit `edit` or `edit_pack`. A fraction, a negative
 * value or held above balance is refused: such a row is a RUB wallet or a bug upstream.
 */
export function editAccountSnapshot(row: {
  balance: EditAmountValue
  held: EditAmountValue
}): EditAccountSnapshot {
  return requireAccount({ balance: wholeEdits(row.balance), held: wholeEdits(row.held) })
}

export interface AvailableEdits {
  tariff: number
  pack: number
  /** What the customer sees as «осталось правок». */
  total: number
}

/** What new holds may still take: balance minus held on each account, and the sum of both. */
export function availableEdits(accounts: EditAccounts): AvailableEdits {
  const { tariff, pack } = requireAccounts(accounts)
  const fromTariff = tariff.balance - tariff.held
  const fromPack = pack.balance - pack.held
  return { tariff: fromTariff, pack: fromPack, total: fromTariff + fromPack }
}

/**
 * The account a new hold of one edit goes to: the tariff while it has an available edit
 * (those expire with the period), then the pack; null when both are empty or held out.
 */
export function chooseHoldAccount(accounts: EditAccounts): EditAccountKind | null {
  const available = availableEdits(accounts)
  if (available.tariff > 0) return 'tariff'
  if (available.pack > 0) return 'pack'
  return null
}

/**
 * How many tariff edits expire when a period ends: the available balance. Held edits stay on
 * the account until their hold is captured or released.
 */
export function expiringTariffEdits(tariff: EditAccountSnapshot): number {
  const { balance, held } = requireAccount(tariff)
  return balance - held
}
