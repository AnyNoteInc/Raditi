import { describe, expect, it } from 'vitest'

import type { PlanOffer } from './billing-types'
import { plansDialogLead } from './plans-dialog'

const plan = (name: string, creditsPerMonth: number, current = false) =>
  ({ name, creditsPerMonth, current }) as PlanOffer
const plans = (currentName?: string) =>
  [plan('Старт', 200), plan('Бизнес', 1000), plan('Агентство', 2000)].map((offer) => ({
    ...offer,
    current: offer.name === currentName,
  }))

describe('the lead of the dialog of tariffs', () => {
  it('names the tariff and the next bigger one', () => {
    expect(plansDialogLead(plans('Старт'))).toBe(
      'Ваш тариф — «Старт». Его можно поднять до «Бизнес»: 1 000 кредитов в месяц вместо 200.',
    )
  })

  it('says the biggest tariff has nothing above it', () => {
    expect(plansDialogLead(plans('Агентство'))).toMatch(
      /^Ваш тариф — «Агентство». Это самый большой/,
    )
  })

  it('offers to choose one without a tariff', () => {
    expect(plansDialogLead(plans())).toMatch(/^Тарифа пока нет/)
  })
})
