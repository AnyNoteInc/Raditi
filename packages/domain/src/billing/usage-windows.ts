import { z } from 'zod'

import { badRequest } from '../errors.ts'
import { decimalStringSchema, Money } from '../money.ts'

// The windows of a workspace: how many credits its work may take in 5 hours and in a week
// (owner's decision of 11.11.2026, docs/spec.md §20, «Лимиты 5 часов и недели»; plan 71). They
// share the power of the agent between the customers; the credits themselves do not burn by them.
// A window starts with the first call of the workspace when none of its kind is open and lasts
// its length, as the windows of GLM Coding Plan do (Л3).

export const usageWindowKinds = ['5h', 'week'] as const
export type UsageWindowKind = (typeof usageWindowKinds)[number]
export const usageWindowKindSchema = z.enum(usageWindowKinds)

const hourMs = 3_600_000
/** How long a window lasts from its first call. */
export const usageWindowLengthMs: Readonly<Record<UsageWindowKind, number>> = Object.freeze({
  '5h': 5 * hourMs,
  week: 7 * 24 * hourMs,
})

/**
 * The tier of a workspace for the shared pool: what its live tariff is — the reserve of the pool
 * it starts in, its place in the queue, how many of its turns run at once. `none` — no paid
 * tariff (the gift, a pack).
 */
export const workspaceTiers = ['none', 'start', 'business', 'agency'] as const
export type WorkspaceTier = (typeof workspaceTiers)[number]
export const workspaceTierSchema = z.enum(workspaceTiers)

/**
 * The tier of a paid plan by its slug (Л18): the three tariffs of plan 63; any other paid plan
 * counts as «Старт». null — no paid tariff.
 */
export function workspaceTierOfPlan(slug: string | null): WorkspaceTier {
  if (slug === null) return 'none'
  if (slug === 'business' || slug === 'agency' || slug === 'start') return slug
  return 'start'
}

/** The place in the queue of `turn.run` (lower runs first), by tier. */
export const tierQueuePriority: Readonly<Record<WorkspaceTier, number>> = Object.freeze({
  agency: 1,
  business: 2,
  start: 3,
  none: 4,
})

/**
 * The share of the pool, in percent, a new task of the tier leaves to the higher tiers (Л8): it
 * starts only while more of the pool is free than this, in both windows.
 */
export const tierPoolReservePct: Readonly<Record<WorkspaceTier, number>> = Object.freeze({
  none: 40,
  start: 25,
  business: 15,
  agency: 5,
})

/**
 * The windows of a workspace without a paid tariff (Л4): the rows of `plans` hold the numbers of
 * each tariff. How many turns of a workspace run at once is not bounded: only credits bound the
 * work (owner's answer of 13.11.2026, Л10 removed).
 */
export const noTariffWindowCredits: Readonly<Record<UsageWindowKind, number | null>> =
  Object.freeze({
    // Only the weekly limits stay (owner's answer of 13.11.2026): no limit of 5 hours.
    '5h': null,
    week: 50,
  })

/** Credits of the customer used in a window: fractional, as the calls take them (Л1). */
export const windowCreditsSchema = decimalStringSchema(10, 4)

const windowStateSchema = z.strictObject({
  kind: usageWindowKindSchema,
  /** Credits the window allows; null — no limit (Л16). */
  limit: z.number().int().positive().nullable(),
  /** What the work of the workspace took in the open window; '0' when none is open. */
  used: windowCreditsSchema,
  /** The end of the open window; null — none is open: it starts with the first call. */
  resetsAt: z.date().nullable(),
})
export type UsageWindowState = z.infer<typeof windowStateSchema>
export const usageWindowStatesSchema = z
  .array(windowStateSchema)
  .max(2)
  .refine((windows) => new Set(windows.map((window) => window.kind)).size === windows.length, {
    message: 'One window of each kind',
  })

/** The limits of a workspace: its tariff's, else those without a tariff. */
export function windowLimitsOf(
  terms: { creditsPer5h: number | null; creditsPerWeek: number | null } | null,
): Record<UsageWindowKind, number | null> {
  if (terms === null) return { ...noTariffWindowCredits }
  return { '5h': terms.creditsPer5h, week: terms.creditsPerWeek }
}

/**
 * What is left of a window in whole credits, rounded down; null — no limit. Never below zero: one
 * call may take the window past its limit (Л6).
 */
export function usageWindowRoom(window: Pick<UsageWindowState, 'limit' | 'used'>): number | null {
  if (window.limit === null) return null
  const used = windowCreditsSchema.safeParse(window.used)
  if (!used.success) throw badRequest('Invalid use of a window')
  return Math.max(0, new Money(window.limit).minus(used.data).floor().toNumber())
}

/**
 * Whether a call of the workspace is admitted (Л6): while what the window has taken, with the
 * reserves of its open calls, stays below the limit. The last admitted call may take it over by
 * no more than itself.
 */
export function windowAdmitsCall(input: {
  limit: number | null
  usedCredits: string
  openReservedCredits: string
}): boolean {
  if (input.limit === null) return true
  const used = windowCreditsSchema.safeParse(input.usedCredits)
  const open = windowCreditsSchema.safeParse(input.openReservedCredits)
  if (!used.success || !open.success) throw badRequest('Invalid use of a window')
  return new Money(used.data).plus(open.data).lt(input.limit)
}

/** The share of a window used, 0…1 and beyond after the last call; null without a limit. */
export function usageWindowShare(window: Pick<UsageWindowState, 'limit' | 'used'>): number | null {
  if (window.limit === null) return null
  return new Money(window.used).div(window.limit).toNumber()
}

/**
 * The first window that refuses a placement needing `needed` credits: its room is less than
 * that. The 5 hours are asked first — they reset sooner.
 */
export function refusingWindow(
  windows: readonly UsageWindowState[],
  needed: number,
): UsageWindowState | null {
  const parsed = usageWindowStatesSchema.safeParse(windows)
  if (!parsed.success) throw badRequest('Invalid windows of a workspace')
  for (const kind of usageWindowKinds) {
    const window = parsed.data.find((item) => item.kind === kind)
    if (window === undefined) continue
    const room = usageWindowRoom(window)
    if (room !== null && room < needed) return window
  }
  return null
}
