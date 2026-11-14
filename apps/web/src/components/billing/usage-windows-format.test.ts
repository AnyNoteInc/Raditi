import { describe, expect, it } from 'vitest'

import {
  ofWindowLimit,
  usageWindowHint,
  usageWindowMeterLabel,
  usageWindowNote,
  usageWindowsExplained,
} from './usage-windows-format'

// 18:40 and Monday 10:15 by the Moscow clock (UTC+3).
const fiveHoursReset = new Date('2026-11-16T15:40:00.000Z')
const weekReset = new Date('2026-11-16T07:15:00.000Z')

describe('the words of the windows (plan 71)', () => {
  it('names the reset by the Moscow clock, or that the window has not started', () => {
    expect(usageWindowNote({ kind: '5h', resetsAt: fiveHoursReset })).toBe('Сбросится в 18:40.')
    expect(usageWindowNote({ kind: 'week', resetsAt: weekReset })).toBe('Сбросится в пн, 10:15.')
    expect(usageWindowNote({ kind: '5h', resetsAt: null })).toBe('Начнётся с первой задачи.')
  })

  it('counts «12 из 20 кредитов» and says why the limits exist', () => {
    expect(ofWindowLimit(20)).toBe('из 20 кредитов')
    expect(ofWindowLimit(21)).toBe('из 21 кредита')
    expect(
      usageWindowMeterLabel({ kind: '5h', limit: 20, used: 12, left: 8, resetsAt: null }),
    ).toBe('5 часов: занято 12 из 20 кредитов')
    expect(usageWindowsExplained).toMatch(/не сгорают/)
  })

  it('hints in the chat from 80 % of a window, the fuller one first', () => {
    expect(
      usageWindowHint([
        { kind: '5h', limit: 20, used: 15, left: 5, resetsAt: fiveHoursReset },
        { kind: 'week', limit: 55, used: 20, left: 35, resetsAt: weekReset },
      ]),
    ).toBeNull()
    expect(
      usageWindowHint([
        { kind: '5h', limit: 20, used: 16, left: 4, resetsAt: fiveHoursReset },
        { kind: 'week', limit: 55, used: 20, left: 35, resetsAt: weekReset },
      ]),
    ).toBe('Лимит на 5 часов почти исчерпан: осталось 4 из 20 кредитов. Сброс — в 18:40.')
    expect(
      usageWindowHint([
        { kind: '5h', limit: 20, used: 3, left: 17, resetsAt: fiveHoursReset },
        { kind: 'week', limit: 55, used: 55, left: 0, resetsAt: weekReset },
      ]),
    ).toBe('Лимит на неделю исчерпан. Сброс — в пн, 10:15.')
    expect(
      usageWindowHint([{ kind: '5h', limit: null, used: 900, left: null, resetsAt: null }]),
    ).toBeNull()
  })
})
