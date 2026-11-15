import { describe, expect, it } from 'vitest'

import { FEATURED_PLAN_LABEL, featuredPlan } from './featured-plan'

describe('the tariff that is marked', () => {
  it('is the one in the middle of three', () => {
    expect(featuredPlan(['Старт', 'Бизнес', 'Агентство'])).toBe('Бизнес')
    expect(FEATURED_PLAN_LABEL).toBe('Для вас')
  })

  it.each([[[]], [['Старт']], [['Старт', 'Бизнес']], [['Старт', 'Бизнес', 'Агентство', 'Бюро']]])(
    'is none among %j: there is no middle',
    (plans) => {
      expect(featuredPlan(plans)).toBeNull()
    },
  )
})
