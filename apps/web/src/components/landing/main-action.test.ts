import { giftTaskCounts, signupGiftCredits } from '@repo/domain/billing/credit-numbers'
import { describe, expect, it } from 'vitest'

import { MAIN_ACTION_SHORT, mainAction, mainActionNote } from './main-action'

describe('main action of the landing', () => {
  it('leads a guest to the form of a lead and a visitor with an account to the chats', () => {
    // One way in (the owner, 13.11.2026): the landing leads a guest to the lead, not to the
    // registration.
    expect(mainAction(true)).toEqual({ href: '#lead', label: 'Подключить сайт бесплатно' })
    expect(mainAction(false)).toEqual({ href: '/chats', label: 'Открыть чаты' })
  })

  it('shortens the name of the action of a guest without changing its words', () => {
    expect(MAIN_ACTION_SHORT).toBe('Подключить сайт')
    expect(mainAction(true).label).toBe(`${MAIN_ACTION_SHORT} бесплатно`)
  })

  it('tells a guest of the gift of the registration, and of no day without a tariff', () => {
    expect(mainActionNote(true)).toBe(
      'При регистрации — 50 кредитов в подарок: хватит на несколько небольших правок. Тариф выберете позже.',
    )
  })

  it('takes the numbers of the gift from the credits model', () => {
    const note = mainActionNote(true)

    expect(note).toContain(`— ${signupGiftCredits} кредитов в подарок`)
    // «Несколько небольших правок» stands on the gift itself: it holds ten of them.
    expect(giftTaskCounts(signupGiftCredits).small).toBeGreaterThanOrEqual(3)
    // The only count of the line is the gift: it is not turned into a number of tasks, and no
    // limit of a day — of a tariff or without one — is promised with it.
    expect(note.match(/\d+/g)).toEqual([String(signupGiftCredits)])
    expect(note).not.toMatch(/в день|задач/)
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
