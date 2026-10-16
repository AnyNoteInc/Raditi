import type { Locator } from '@playwright/test'

// The words the billing pages count credits with, as the browser checks expect them: written
// here from the texts of the credits design, not taken from the code of the pages, and filled
// with numbers a check has read from the database. A page that counts another number than the
// accounts hold, or names the accounts in another order, says another sentence.

/** The form of a Russian noun that goes with the number: 1 кредит, 2 кредита, 5 кредитов. */
export function plural(count: number, one: string, few: string, many: string): string {
  const lastTwo = count % 100
  if (lastTwo >= 11 && lastTwo <= 14) return many
  if (count % 10 === 1) return one
  return count % 10 >= 2 && count % 10 <= 4 ? few : many
}

/** «2 500»: a count with its digits in groups of three. */
export const counted = (count: number) => String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

/** «5 кредитов», «1 кредит». */
export const credits = (count: number) =>
  `${counted(count)} ${plural(count, 'кредит', 'кредита', 'кредитов')}`

/** «35 подарочных кредитов», «3 подарочных кредита». */
export const giftCredits = (count: number) =>
  `${counted(count)} ${plural(count, 'подарочный кредит', 'подарочных кредита', 'подарочных кредитов')}`

/** What is left on the three accounts, as a check has read it from the database. */
export interface CreditsLeft {
  tariff: { left: number }
  gift: { left: number }
  pack: { left: number }
}

/**
 * The row «Кредиты» of «Тарифы»: «Осталось 435: 300 по тарифу, 35 подарочных и 100 из пакета».
 * The accounts go in the order their credits are spent in, an account with nothing left is not
 * named, and one account alone is named without a total.
 */
export function creditsRow({ tariff, gift, pack }: CreditsLeft): string {
  const parts = [
    tariff.left > 0 ? `${counted(tariff.left)} по тарифу` : null,
    gift.left > 0
      ? `${counted(gift.left)} ${plural(gift.left, 'подарочный', 'подарочных', 'подарочных')}`
      : null,
    pack.left > 0 ? `${counted(pack.left)} из пакета` : null,
  ].filter((part) => part !== null)
  const last = parts.at(-1)
  if (last === undefined) throw new Error('No credit is left: the row says something else')
  if (parts.length === 1) return `Осталось ${last}`
  const total = tariff.left + gift.left + pack.left
  return `Осталось ${counted(total)}: ${parts.slice(0, -1).join(', ')} и ${last}`
}

/** What is left in all, on the three accounts. */
export const totalLeft = ({ tariff, gift, pack }: CreditsLeft) =>
  tariff.left + gift.left + pack.left

/**
 * The headline of «Использование», «835 кредитов осталось», whole: the figure and its words
 * stand in two elements, with or without a space between them. The pattern takes the text of
 * the headline alone (`leftHeadlineOf`), from its first digit: among other text «300 кредитов
 * осталось» would pass for nothing left, and «1 835» for 835.
 */
export function leftHeadline(count: number): RegExp {
  const words = plural(count, 'кредит остался', 'кредита осталось', 'кредитов осталось')
  const spaced = (text: string) => text.replaceAll(' ', String.raw`\s`)
  return new RegExp(String.raw`^${spaced(counted(count))}\s*${spaced(words)}$`)
}

/**
 * The headline itself in the section «Кредиты» of «Использование»: the one paragraph that ends
 * with «осталось». Compared whole — `toHaveText(leftHeadline(…))`.
 */
export const leftHeadlineOf = (section: Locator) =>
  section.locator('p').filter({ hasText: /остал(ся|ось)$/ })

/**
 * A pattern for a sentence of a page, written as it reads: the pages bind short words, numbers
 * and dashes to their neighbours with non-breaking spaces, so every space of the sentence may
 * be either kind.
 */
export function said(sentence: string): RegExp {
  return new RegExp(
    sentence.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`).replace(/ /g, String.raw`\s`),
  )
}

/** The same for the whole text of an element. */
export const saidWhole = (sentence: string) => new RegExp(`^${said(sentence).source}$`)
