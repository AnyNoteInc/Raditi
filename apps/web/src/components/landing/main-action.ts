// No 'use client' here: the server page and the client islands ask the same function.

import { signupGiftCredits, tasksPerDayWithoutTariff } from '@repo/domain/billing/credit-numbers'

import { pluralCredits, tasksOf } from './pricing-calculator'

/**
 * The main action of the landing, wherever it stands: a guest is led to the registration, a
 * visitor with an account to the projects. Written once, so every place calls it by one name.
 */
export const mainAction = (isGuest: boolean) =>
  isGuest
    ? ({ href: '/sign-up', label: 'Зарегистрироваться' } as const)
    : ({ href: '/projects', label: 'Открыть проекты' } as const)

/** When a tariff is chosen: the last words under the action, whoever reads them. */
const PLAN_LATER = 'Тариф выберете позже.'

/**
 * The line under the main action where it stands below the tariffs: what the action gives before
 * a tariff is chosen. A guest is told of the gift of the registration and of the day without a
 * tariff — numbers of the credits model, written once in the domain. A visitor with an account is
 * not offered the registration again, and the page does not know what is left of their gift: they
 * read only when the tariff is chosen. Plain spaces: the component passes the line through nbsp().
 */
export function mainActionNote(isGuest: boolean): string {
  if (!isGuest) return PLAN_LATER
  const gift = `${signupGiftCredits} ${pluralCredits(signupGiftCredits)}`
  const perDay = `${tasksPerDayWithoutTariff} ${tasksOf(tasksPerDayWithoutTariff)}`
  return `При регистрации — ${gift} в подарок: хватит на несколько небольших правок. Без тарифа — до ${perDay} в день. ${PLAN_LATER}`
}
