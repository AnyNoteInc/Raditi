import { Decimal } from 'decimal.js'
import { z } from 'zod'

// Isolate money arithmetic from changes to decimal.js's global configuration.
export const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP })

export function decimalStringSchema(integerDigits: number, scale: number) {
  return z
    .string()
    .max(integerDigits + scale + 1)
    .regex(new RegExp(`^\\d{1,${integerDigits}}(?:\\.\\d{1,${scale}})?$`))
    .refine((value) => value === value.trim())
}

/**
 * Customer money in DTOs and the API: RUB as a string with exactly two decimals, "4900.00" —
 * what toFixed(2) prints. Never negative and without leading zeros, so equal amounts are equal
 * strings; the signed amounts of credit_ledger are not customer DTOs and do not pass.
 */
function rubStringSchema(integerDigits: number) {
  return z.string().regex(new RegExp(`^(?:0|[1-9]\\d{0,${integerDigits - 1}})\\.\\d{2}$`))
}

/** Decimal(12,2): plan prices, order amounts and refunds. */
export const amountRubSchema = rubStringSchema(10)
/** Decimal(14,2): balances and holds of the RUB wallet. */
export const balanceRubSchema = rubStringSchema(12)
