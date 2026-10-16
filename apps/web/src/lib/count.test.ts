import { describe, expect, it } from 'vitest'

import { formatCount } from './count'
import { nbsp } from './nbsp'

describe('formatCount', () => {
  it.each([
    [0, '0'],
    [5, '5'],
    [100, '100'],
    [800, '800'],
    [999, '999'],
    [1000, '1 000'],
    [2500, '2 500'],
    [12345, '12 345'],
    [100000, '100 000'],
    [1234567, '1 234 567'],
  ])('reads %i as «%s»', (count, text) => {
    expect(formatCount(count)).toBe(text)
  })

  it('groups with plain spaces, which nbsp() binds where the count is shown', () => {
    expect(formatCount(2500)).not.toContain(' ')
    expect(nbsp(formatCount(2500))).toBe('2 500')
    expect(nbsp(`${formatCount(1234567)} кредитов в месяц`)).toBe('1 234 567 кредитов в месяц')
  })
})
