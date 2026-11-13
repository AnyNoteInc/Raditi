import { describe, expect, it } from 'vitest'

import { planWindowLimits } from './plan-windows'

describe('the windows of a tariff in one line (plan 70)', () => {
  it('says both windows, one alone, or nothing', () => {
    expect(planWindowLimits(20, 55)).toBe('До 20 кредитов за 5 часов и 55 в неделю')
    expect(planWindowLimits(21, 700)).toBe('До 21 кредита за 5 часов и 700 в неделю')
    expect(planWindowLimits(70, null)).toBe('До 70 кредитов за 5 часов')
    expect(planWindowLimits(null, 210)).toBe('До 210 кредитов в неделю')
    expect(planWindowLimits(null, null)).toBeNull()
  })
})
