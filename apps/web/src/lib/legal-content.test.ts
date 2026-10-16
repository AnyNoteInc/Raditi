import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

import { Prisma } from '@repo/db'
import {
  attemptStepCredits,
  legalDocuments,
  minStartCredits,
  minTaskChargeCredits,
} from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { webEnvFromEnv } from '@/server/web-env'

import { consentDocumentLinks, formatEditionDate, legalDocumentHref } from './legal'

const contentDir = fileURLToPath(new URL('../../content/legal/', import.meta.url))
const appDir = fileURLToPath(new URL('../app/', import.meta.url))
const sourceDir = fileURLToPath(new URL('../', import.meta.url))
/** .env.example of the repository: the settings a new installation starts from. */
const exampleEnv = parseEnv(
  readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8'),
)

const text = (slug: string) => readFileSync(`${contentDir}${slug}.md`, 'utf8')

/** Routes of the app that have a page: route groups such as `(protected)` are not in the path. */
function pageRoutes(directory = appDir, route = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory())
      return pageRoutes(
        `${directory}${entry.name}/`,
        entry.name.startsWith('(') ? route : `${route}/${entry.name}`,
      )
    return entry.name === 'page.tsx' ? [route || '/'] : []
  })
}

describe('legal documents', () => {
  it('every document of the registry has a text and every text is in the registry', () => {
    const files = readdirSync(contentDir)
      .filter((file) => file.endsWith('.md') && file !== 'README.md')
      .map((file) => file.slice(0, -'.md'.length))
      .sort()
    const slugs = legalDocuments.map((document) => document.slug).sort()

    expect(files).toEqual(slugs)
  })

  it('consent checkboxes link to the documents of the registry', () => {
    const hrefs = new Set(legalDocuments.map((document) => legalDocumentHref(document.slug)))
    for (const href of Object.values(consentDocumentLinks())) expect(hrefs).toContain(href)
    expect(consentDocumentLinks().piiProcessing).toBe('/terms/consent')
  })

  it('carries in every text the edition date of the registry', () => {
    for (const document of legalDocuments)
      expect(text(document.slug), document.slug).toContain(
        `**Редакция от ${formatEditionDate(document.version)}**`,
      )
  })

  it('links only to pages of the site that exist', () => {
    const routes = new Set(pageRoutes())
    const documents = new Set(legalDocuments.map((document) => legalDocumentHref(document.slug)))
    expect(routes).toContain('/terms/[document]')
    for (const document of legalDocuments) {
      const links = [...text(document.slug).matchAll(/raditi\.ru(\/[\w\-./]*)?/g)]
      expect(links.length, document.slug).toBeGreaterThan(0)
      for (const [link, path = '/'] of links) {
        const route = path.replace(/(?<=.)\/$/, '')
        expect(routes.has(route) || documents.has(route), `${document.slug}: ${link}`).toBe(true)
      }
    }
  })

  it('names the real switch of the settings page as the way to withdraw the mailing consent', () => {
    const consent = text('marketing-consent')
    const [, label] = /переключатель «([^»]+)»/.exec(consent) ?? []
    expect(label).toBeDefined()
    expect(consent).toContain('(https://raditi.ru/settings)')
    expect(readFileSync(`${sourceDir}components/account/settings-panel.tsx`, 'utf8')).toContain(
      label,
    )
  })

  it('names the profile photo among the account data while the profile stores one (152-FZ)', () => {
    // The upload route is what makes the category real: both texts list the data and its term.
    expect(existsSync(`${appDir}api/profile/avatar/route.ts`)).toBe(true)
    const data = 'изображение профиля (фото), если Пользователь загрузил его добровольно'
    const term = 'изображение профиля — до его замены или удаления Пользователем'
    for (const slug of ['consent', 'privacy-policy']) {
      expect(text(slug), slug).toContain(data)
      expect(text(slug), slug).toContain(term)
    }
  })

  // The seller is self-employed, sells tariffs and packs of credits only and is paid by
  // individuals only (the owner's decisions of 04.10.2026 and 10.10.2026): none of this may
  // come back with a later edit. The bare «счет» is not searched for: the offer and the
  // agreement say «счета, акты … не оформляет», and «за счет» is an idiom.
  const gone =
    /[Оо]плат[а-я]+ за действие|[Бб]аланс|[Кк]ошел|с учетом НДС|[Кк]ассов|сч[её]т-фактур|сч[её]та-фактуры|сч[её]т[а-яё]* на оплату|выстав[а-яё]* сч[её]т|[Оо]бществ[а-яё]* с ограниченной|ОБЩЕСТВ[А-ЯЁ]* С ОГРАНИЧЕННОЙ|ООО/

  it('names no wallet, no pay-per-action tariff, no price with VAT, no cash receipt, no invoice and no company', () => {
    for (const document of legalDocuments)
      expect(text(document.slug), document.slug).not.toMatch(gone)

    // «НДС» stands once in the six texts: where the offer says the price carries none.
    const sentences = legalDocuments.flatMap(
      (document) => text(document.slug).match(/[^.]*НДС[^.]*\./g) ?? [],
    )
    expect(sentences.map((sentence) => sentence.trim())).toEqual([
      'Стоимость услуг НДС не облагается.',
    ])
  })

  it('knows a company by the full name of its form, in any case of the noun', () => {
    // The first sentence is clause 5.7 of the offer as it stood before 11.10.2026: the
    // nominative in small letters alone would let it back in.
    for (const sentence of [
      'Исполнитель является обществом с ограниченной ответственностью, применяет общую систему налогообложения.',
      'Общество с ограниченной ответственностью «Ромашка» вправе присоединиться к Оферте.',
      'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ «РОМАШКА»',
      'ООО «Ромашка»',
    ])
      expect(sentence).toMatch(gone)
  })

  it('states in the offer and the agreement the numbers the code reserves and charges by', () => {
    // Appendix 1 of the offer and clause 13.3 of the agreement repeat constants of the credits
    // model. A constant that moves needs a new edition of the text, and the reverse.
    const offer = text('public-offer')
    const number = (pattern: RegExp) => Number(pattern.exec(offer)?.[1])

    expect(number(/резервируются Кредиты — не более (\d+) и не более доступного остатка/)).toBe(
      attemptStepCredits.standard,
    )
    expect(number(/при продолжении под Задачу дополнительно резервируется не более (\d+) /)).toBe(
      attemptStepCredits.standard,
    )
    expect(
      number(/в усиленном режиме: под нее и при ее продолжении резервируется не более (\d+) /),
    ).toBe(attemptStepCredits.heavy)
    expect(number(/но не менее (\d+) и не более зарезервированного/)).toBe(minTaskChargeCredits)
    expect(number(/Если доступных Кредитов меньше (\d+) или достигнут дневной лимит/)).toBe(
      minStartCredits,
    )
    expect(Number(/но не меньше (\d+) за задачу/.exec(text('user-agreement'))?.[1])).toBe(
      minTaskChargeCredits,
    )
  })

  it('names in the offer the days the renewal runs by unless it is set otherwise', () => {
    // Clauses 5.5.3 and 5.5.7 state as terms what the product reads as settings. .env.example
    // carries the defaults of core (its config test holds the file to them) and of web: a
    // production value that differs from the offer needs a new edition of the offer first.
    const offer = text('public-offer')
    const noticeDays = /Уведомление направляется за (\d+) (?:день|дня|дней) до списания/.exec(offer)
    const pastDueDays = /В течение (\d+) (?:дня|дней) Подписка ожидает оплаты/.exec(offer)

    expect(noticeDays?.[1]).toBe(exampleEnv.BILLING_RENEWAL_NOTICE_DAYS)
    expect(pastDueDays?.[1]).toBe(exampleEnv.BILLING_PAST_DUE_DAYS)
    expect(Number(pastDueDays?.[1])).toBe(
      webEnvFromEnv({ APP_ENV: 'development', APP_URL: 'http://localhost:3000' }).pastDueDays,
    )
  })

  it('says of the card binding page of ЮKassa only what the platform itself does', () => {
    // Binding a card makes no payment for the tariff: that much is ours to promise. Whether the
    // page of ЮKassa debits and returns a checking amount is not, and nobody has asked the shop.
    const clause = /^\*\*5\.5\.5\.\*\* .*$/m.exec(text('public-offer'))?.[0]
    expect(clause).toContain(
      'Привязка и замена банковской карты производятся на странице ЮKassa и оплатой Тарифа не являются: стоимость Подписки при этом не списывается.',
    )
    for (const document of legalDocuments)
      expect(text(document.slug), document.slug).not.toMatch(/без списания денежных средств/)
  })

  it('lists in the policy and the consent everything stored of a saved payment method', () => {
    // The texts enumerate the data, so each column `subscriptions.payment_method_*` has its
    // words in them. A column that is added needs the three lists rewritten, in a new edition.
    // The title is whatever ЮKassa calls the method: for a wallet it carries the wallet's number.
    const named: Record<string, RegExp> = {
      paymentMethodId: /идентификатор/,
      paymentMethodType: /его вид|вид способа оплаты/,
      paymentMethodCardType: /платежн(?:ая система|ую систему)/,
      paymentMethodLast4: /последние четыре цифры номера карты/,
      paymentMethodTitle: /название способа оплаты, сообщенное платежным сервисом/,
    }
    const stored = Object.keys(Prisma.SubscriptionScalarFieldEnum).filter((field) =>
      field.startsWith('paymentMethod'),
    )
    expect(stored.sort()).toEqual(Object.keys(named).sort())

    const policy = text('privacy-policy')
    const bound = 'привязал банковскую карту в личном кабинете'
    const lists = {
      'policy, purpose 6': new RegExp(`^\\| 6 \\|.* ${bound} — (.*?), данные чека`, 'm').exec(
        policy,
      ),
      'policy 6.5': /^6\.5\. .* Оператор хранит (.*?), чтобы показывать Пользователю/m.exec(policy),
      'consent 4.3': new RegExp(`^- если .* ${bound} — (.*)\\.$`, 'm').exec(text('consent')),
    }
    for (const [place, list] of Object.entries(lists))
      for (const words of Object.values(named)) expect(list?.[1], place).toMatch(words)
  })

  it('formats the edition date in Russian', () => {
    expect(formatEditionDate('2026-09-26')).toBe('26 сентября 2026 г.')
    expect(formatEditionDate('not a date')).toBe('not a date')
  })
})
