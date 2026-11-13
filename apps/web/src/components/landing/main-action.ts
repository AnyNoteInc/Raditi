// No 'use client' here: the server page and the client islands ask the same function.

import { signupGiftCredits } from '@repo/domain/billing/credit-numbers'

import { pluralCredits } from './pricing-calculator'

/**
 * The main action of the landing, wherever it stands: a guest is led to the form of a lead (one
 * way in, the owner, 13.11.2026: we connect the site, the registration comes after), a visitor
 * with an account to the chats. Written once, so every place calls it by one name.
 */
export const mainAction = (isGuest: boolean) =>
  isGuest
    ? ({ href: '#lead', label: 'Подключить сайт бесплатно' } as const)
    : ({ href: '/chats', label: 'Открыть чаты' } as const)

/**
 * The same action where a row has no room for the whole name — the header — and where the words
 * around it have said «бесплатно» already: the section of the systems.
 */
export const MAIN_ACTION_SHORT = 'Подключить сайт'

/** When a tariff is chosen: the last words under the action, whoever reads them. */
const PLAN_LATER = 'Тариф выберете позже.'

/**
 * The line under the main action where it stands below the tariffs: what the action gives before
 * a tariff is chosen. A guest is told of the gift of the registration — a number of the credits
 * model, written once in the domain; without a tariff there is no daily limit, the gift is the
 * bound. A visitor with an account is not offered the registration again, and the page does not
 * know what is left of their gift: they read only when the tariff is chosen. Plain spaces: the
 * component passes the line through nbsp().
 */
export function mainActionNote(isGuest: boolean): string {
  if (!isGuest) return PLAN_LATER
  const gift = `${signupGiftCredits} ${pluralCredits(signupGiftCredits)}`
  return `При регистрации — ${gift} в подарок: хватит на несколько небольших правок. ${PLAN_LATER}`
}
