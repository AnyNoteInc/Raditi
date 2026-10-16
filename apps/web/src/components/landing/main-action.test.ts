import {
  giftTaskCounts,
  signupGiftCredits,
  tasksPerDayWithoutTariff,
} from '@repo/domain/billing/credit-numbers'
import { describe, expect, it } from 'vitest'

import { mainAction, mainActionNote } from './main-action'

describe('main action of the landing', () => {
  it('leads a guest to the registration and a visitor with an account to the projects', () => {
    expect(mainAction(true)).toEqual({ href: '/sign-up', label: 'Зарегистрироваться' })
    expect(mainAction(false)).toEqual({ href: '/projects', label: 'Открыть проекты' })
  })

  it('tells a guest of the gift of the registration and of the day without a tariff', () => {
    expect(mainActionNote(true)).toBe(
      'При регистрации — 35 кредитов в подарок: хватит на несколько небольших правок. Без тарифа — до 3 задач в день. Тариф выберете позже.',
    )
  })

  it('takes the numbers of the gift from the credits model', () => {
    const note = mainActionNote(true)

    expect(note).toContain(`— ${signupGiftCredits} кредитов в подарок`)
    expect(note).toContain(`до ${tasksPerDayWithoutTariff} задач в день`)
    // «Несколько небольших правок» stands on the gift itself: it holds seven of them.
    expect(giftTaskCounts(signupGiftCredits).small).toBeGreaterThanOrEqual(3)
    // The only counts of the line are the gift and the tasks of a day: the gift is not turned
    // into a number of tasks, and no limit of a tariff is promised with it.
    expect(note.match(/\d+/g)).toEqual([
      String(signupGiftCredits),
      String(tasksPerDayWithoutTariff),
    ])
    expect(note).not.toMatch(/30 задач|10 задач/)
  })

  it('does not offer the registration or its gift to a visitor with an account', () => {
    const note = mainActionNote(false)

    expect(note).toBe('Тариф выберете позже.')
    // The same last words as a guest reads.
    expect(mainActionNote(true).endsWith(` ${note}`)).toBe(true)
    expect(note).not.toMatch(/регистрац|подар|кредит/i)
  })

  it('writes the line with plain spaces: the component binds its words', () => {
    for (const isGuest of [true, false]) expect(mainActionNote(isGuest)).not.toContain('\u00a0')
  })
})
