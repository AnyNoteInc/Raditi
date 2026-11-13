import { describe, expect, it } from 'vitest'

import { minContinueCredits, minStartCredits, newTaskVerdict, toCredits } from './credits.ts'
import { taskRefusal } from './errors.ts'
import {
  noTariffWindowCredits,
  refusingWindow,
  tierPoolReservePct,
  tierQueuePriority,
  usageWindowLengthMs,
  usageWindowRoom,
  usageWindowShare,
  windowAdmitsCall,
  windowLimitsOf,
  workspaceTierOfPlan,
  type UsageWindowState,
} from './usage-windows.ts'

// The windows of 5 hours and of the week of a workspace (owner's decision of 11.11.2026, plan 69).

const reset = new Date('2026-11-16T15:40:00.000Z')
const fiveHours = (used: string, limit: number | null = 20): UsageWindowState => ({
  kind: '5h',
  limit,
  used,
  resetsAt: used === '0' ? null : reset,
})
const week = (used: string, limit: number | null = 55): UsageWindowState => ({
  kind: 'week',
  limit,
  used,
  resetsAt: used === '0' ? null : new Date('2026-11-23T07:15:00.000Z'),
})

describe('windows of a workspace', () => {
  it('lasts 5 hours and 7 days', () => {
    expect(usageWindowLengthMs['5h']).toBe(5 * 3_600_000)
    expect(usageWindowLengthMs.week).toBe(7 * 24 * 3_600_000)
  })

  it('takes the limits of the tariff, else those without a tariff (Л4)', () => {
    expect(windowLimitsOf(null)).toEqual({ '5h': 15, week: 50 })
    expect(noTariffWindowCredits).toEqual({ '5h': 15, week: 50 })
    expect(windowLimitsOf({ creditsPer5h: 70, creditsPerWeek: 210 })).toEqual({
      '5h': 70,
      week: 210,
    })
    expect(windowLimitsOf({ creditsPer5h: null, creditsPerWeek: null })).toEqual({
      '5h': null,
      week: null,
    })
  })

  it('leaves whole credits of room, never below zero', () => {
    expect(usageWindowRoom(fiveHours('12.4'))).toBe(7)
    expect(usageWindowRoom(fiveHours('21.0000'))).toBe(0)
    expect(usageWindowRoom(fiveHours('5', null))).toBeNull()
    expect(usageWindowShare(fiveHours('16'))).toBeCloseTo(0.8)
  })

  it('admits a call while the window with its open reserves is below the limit (Л6)', () => {
    expect(windowAdmitsCall({ limit: 20, usedCredits: '19.9', openReservedCredits: '0' })).toBe(
      true,
    )
    expect(windowAdmitsCall({ limit: 20, usedCredits: '19.5', openReservedCredits: '0.5' })).toBe(
      false,
    )
    expect(windowAdmitsCall({ limit: 20, usedCredits: '20', openReservedCredits: '0' })).toBe(false)
    expect(windowAdmitsCall({ limit: null, usedCredits: '9999', openReservedCredits: '0' })).toBe(
      true,
    )
  })

  it('refuses by the 5 hours first, then by the week', () => {
    expect(refusingWindow([fiveHours('20'), week('55')], 1)?.kind).toBe('5h')
    expect(refusingWindow([fiveHours('3'), week('54.5')], 1)?.kind).toBe('week')
    expect(refusingWindow([fiveHours('0'), week('0')], 1)).toBeNull()
    expect(() => refusingWindow([fiveHours('1'), fiveHours('2')], 1)).toThrow()
  })

  it('names the tiers of the tariffs, their reserve and their place in the queue', () => {
    expect(workspaceTierOfPlan(null)).toBe('none')
    expect(workspaceTierOfPlan('start')).toBe('start')
    expect(workspaceTierOfPlan('business')).toBe('business')
    expect(workspaceTierOfPlan('agency')).toBe('agency')
    expect(workspaceTierOfPlan('legacy-plan')).toBe('start')
    expect(tierPoolReservePct).toEqual({ none: 40, start: 25, business: 15, agency: 5 })
    expect(tierQueuePriority).toEqual({ agency: 1, business: 2, start: 3, none: 4 })
  })
})

describe('newTaskVerdict with the windows', () => {
  const ask = (windows: UsageWindowState[], placement: 'new' | 'retry' = 'new') =>
    newTaskVerdict({
      placement,
      accounts: {
        tariff: { balance: toCredits(100), held: toCredits(0) },
        gift: { balance: toCredits(0), held: toCredits(0) },
        pack: { balance: toCredits(0), held: toCredits(0) },
      },
      subscription: { status: 'active', creditsPerMonth: 600, creditsPerDay: null },
      tariffCreditsToday: { charged: toCredits(0), held: toCredits(0) },
      rateUsable: true,
      windows,
    })

  it('takes a task with room in both windows and reports them', () => {
    const verdict = ask([fiveHours('3'), week('10')])
    expect(verdict.allowed).toBe(true)
    expect(verdict.windows).toHaveLength(2)
  })

  it('refuses by a spent window although credits are there, a retry too (Л5)', () => {
    expect(ask([fiveHours('20'), week('20')])).toMatchObject({
      allowed: false,
      reason: 'window_limit',
    })
    expect(ask([fiveHours('3'), week('55')], 'retry')).toMatchObject({
      allowed: false,
      reason: 'window_limit',
    })
    expect(minStartCredits).toBeGreaterThanOrEqual(minContinueCredits)
  })

  it('answers with the window, its limit, what it took and its reset', () => {
    const verdict = ask([fiveHours('20.3'), week('21')])
    if (verdict.allowed) throw new Error('The window should refuse')
    const error = taskRefusal(verdict)
    expect(error).toMatchObject({ code: 'BILLING_WINDOW_LIMIT_REACHED', httpStatus: 429 })
    expect(error.details).toEqual({
      reason: 'window_limit',
      spendable: 100,
      held: 0,
      needed: minStartCredits,
      window: { kind: '5h', limit: 20, used: 21, resetsAt: reset.toISOString() },
    })
  })

  it('is not bounded without limits', () => {
    expect(ask([fiveHours('500', null), week('900', null)]).allowed).toBe(true)
  })
})
