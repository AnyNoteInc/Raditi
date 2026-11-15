import { describe, expect, it } from 'vitest'

import { planDescription } from './plan-description'

describe('planDescription', () => {
  it('names whom each tariff on sale is for', () => {
    expect(planDescription('start')).toBe('Для своего дела')
    expect(planDescription('business')).toBe('Когда задач становится больше')
    expect(planDescription('agency')).toBe('Для команды и ваших клиентов')
  })

  it('gives a neutral line to a tariff it does not know, an inherited key included', () => {
    expect(planDescription('enterprise')).toBe('Для регулярных задач')
    expect(planDescription('toString')).toBe('Для регулярных задач')
    expect(planDescription('')).toBe('Для регулярных задач')
  })
})
