import { badRequest } from '../errors.ts'

// Moscow keeps a fixed UTC+3 offset with no daylight saving: no time zone database is needed.
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000
// A century of monthly periods; anything longer is a caller's bug, not a subscription.
const MAX_BILLING_MONTHS = 1200

/** One paid month of a subscription: from `start` up to, but not including, `end`. */
export interface BillingPeriod {
  start: Date
  end: Date
}

function isInstant(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime())
}

/** The Moscow wall clock of an instant, readable through the UTC getters. */
function moscowClock(instant: Date): Date {
  return new Date(instant.getTime() + MOSCOW_OFFSET_MS)
}

/** `month` may run past December: it is counted from January of `year`. */
function daysInMonth(year: number, month: number): number {
  const lastDay = new Date(0)
  lastDay.setUTCFullYear(year, month + 1, 0)
  return lastDay.getUTCDate()
}

/**
 * The instant `months` billing months after the anchor. The anchor is the payment the current
 * run of periods is counted from: the first payment, or the payment that brought a past_due
 * subscription back — that one starts `billingPeriod(paidAt, 0)` and replaces the stored
 * period_anchor. Months are counted on the Moscow calendar. The anchor's day of month and time
 * of day are kept; a shorter month takes its last day. Every boundary is counted from the
 * anchor, never from the previous one, so the day comes back: 31 January → 28 February →
 * 31 March.
 */
export function addBillingMonths(anchor: Date, months: number): Date {
  if (!isInstant(anchor)) throw badRequest('Invalid billing period anchor')
  if (!Number.isInteger(months) || months < 0 || months > MAX_BILLING_MONTHS) {
    throw badRequest('Invalid number of billing months')
  }
  const clock = moscowClock(anchor)
  const year = clock.getUTCFullYear()
  const month = clock.getUTCMonth() + months
  clock.setUTCFullYear(year, month, Math.min(clock.getUTCDate(), daysInMonth(year, month)))
  const result = new Date(clock.getTime() - MOSCOW_OFFSET_MS)
  if (!isInstant(result)) throw badRequest('Billing period is out of range')
  return result
}

/**
 * Period `index` of the anchor's run. Period 0 starts at the anchor; each next one starts where
 * the previous ended.
 */
export function billingPeriod(anchor: Date, index: number): BillingPeriod {
  return { start: addBillingMonths(anchor, index), end: addBillingMonths(anchor, index + 1) }
}

/**
 * The period that starts at `periodEnd`. The value must be the end of one of the anchor's
 * periods: a renewal continues the months of its anchor and never drifts from them. A payment
 * of a past_due subscription starts a new run, `billingPeriod(paidAt, 0)`, whose end belongs
 * to `paidAt` only: the caller must store `paidAt` as the new period_anchor together with that
 * period, otherwise the next renewal is refused here.
 */
export function nextBillingPeriod(anchor: Date, periodEnd: Date): BillingPeriod {
  if (!isInstant(anchor)) throw badRequest('Invalid billing period anchor')
  if (!isInstant(periodEnd)) throw badRequest('Invalid billing period end')
  const from = moscowClock(anchor)
  const to = moscowClock(periodEnd)
  // A boundary always falls in the Moscow month it was counted for, so the month distance is
  // the index of the period it starts.
  const index =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth()
  if (
    index < 1 ||
    index >= MAX_BILLING_MONTHS ||
    addBillingMonths(anchor, index).getTime() !== periodEnd.getTime()
  ) {
    throw badRequest('Billing period end does not belong to the anchor')
  }
  return billingPeriod(anchor, index)
}
