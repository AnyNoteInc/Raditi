import type { Page } from '@playwright/test'
import { createPrismaClient, type PrismaClient } from '@repo/db'

import { databaseUrl, fakeYookassa } from '../../fixtures/billing-stand.ts'
import { creditsRow } from '../../fixtures/credit-words.ts'
import { expect, test } from '../../fixtures/credits.ts'
import type { SignedInUser } from '../../fixtures/signed-in.ts'

// Managing a tariff on «Настройки → Тарифы» in a real browser: a signed-in customer switches
// auto-renewal off and on, chooses another tariff for the next period and takes the choice
// back, and pays for a tariff whose renewal charge failed on the page of the fake ЮKassa. What
// only the scheduler does — a charge that fails, a period that ends — the tests write into the
// database of the run. The fixture removes the user with everything the payments created.

// Each step opens a page the development server compiles on first use.
test.describe.configure({ timeout: 180_000 })
const SLOW = { timeout: 60_000 }

/** A command of the fake ЮKassa (infra/dev/billing-verify/README.md, «Команды стенда»). */
async function fake<T = unknown>(command: string, body: object): Promise<T> {
  const response = await fetch(`${fakeYookassa.controlUrl}/${command}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`The fake ЮKassa refused «${command}»: ${response.status}`)
  return (await response.json()) as T
}

let db: PrismaClient
test.beforeAll(() => {
  db = createPrismaClient({ databaseUrl: databaseUrl() })
})
test.afterAll(async () => {
  await db.$disconnect()
})

test.beforeEach(async () => {
  // Payments, cards and withheld notifications of the previous test are gone.
  await fake('reset', {})
})

test.afterEach(async () => {
  // Every notification is answered before the fixture removes the rows of the user.
  await fake('settle', {})
  await fake('reset', {})
})

// A day as the pages print it, «5 ноября» and «5 ноября 2026». The pages bind a number to its
// word with a non-breaking space, and a pattern, unlike a string, is matched as it is written.
const DAY = String.raw`\d{1,2}\s[а-я]+`
const DATE = String.raw`${DAY}\s\d{4}`
const DAY_MS = 24 * 60 * 60_000

/**
 * A pattern for a sentence of a page, written as it reads: the pages bind short words, numbers
 * and dashes to their neighbours with non-breaking spaces, so every space of the sentence may
 * be either kind. What is put in with `${}` — DAY, DATE — is a pattern already.
 */
function sentence(parts: TemplateStringsArray, ...patterns: string[]): string {
  return parts.reduce((all, part, index) => {
    const literal = part
      .replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
      .replace(/ /g, String.raw`\s`)
    return all + (index === 0 ? '' : (patterns[index - 1] ?? '')) + literal
  }, '')
}

const fakePage = `http://127.0.0.1:${fakeYookassa.port}/pay/**`
const returnPage = /\/settings\/billing\/return\?order=[0-9a-f-]{36}$/

const tariff = (page: Page, name: string) =>
  page.locator('section', { has: page.getByRole('heading', { level: 2, name: `Тариф «${name}»` }) })
const renewal = (page: Page) => page.getByRole('region', { name: 'Автопродление' })
const planCard = (page: Page, name: string) =>
  page
    .getByRole('list', { name: 'Тарифы' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { level: 3, name, exact: true }) })

/**
 * The value beside a label in the block of the customer's tariff: its first piece of text that
 * is not a link.
 */
const row = (page: Page, label: string) =>
  page
    .locator('dt', { hasText: label })
    .locator('xpath=following-sibling::dd[1]/descendant-or-self::*[not(self::a) and not(*)][1]')

/** Chooses «Старт» on «Тарифы», pays for it on the page of the fake and comes back to «Тарифы». */
async function payForStart(page: Page, { autoRenew }: { autoRenew: boolean }) {
  await page.goto('/settings/plans')
  await expect(page.getByRole('heading', { level: 2, name: 'Выберите тариф' })).toBeVisible(SLOW)
  await planCard(page, 'Старт').getByRole('button', { name: 'Выбрать «Старт»' }).click()
  const dialog = page.getByRole('dialog', { name: 'Тариф «Старт»' })
  if (autoRenew) await dialog.getByRole('checkbox', { name: 'Продлевать автоматически' }).check()
  await dialog.getByRole('button', { name: 'Перейти к оплате' }).click()
  await page.waitForURL(fakePage, SLOW)
  await page.getByRole('button', { name: 'Оплатить' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Оплата прошла' })).toBeVisible(SLOW)
  await page.getByRole('link', { name: 'К тарифам' }).click()
  await expect(tariff(page, 'Старт')).toBeVisible(SLOW)
}

/** The subscription of the user, as the database holds it. */
async function subscriptionOf(user: SignedInUser) {
  const row = await db.subscription.findFirst({
    where: { workspace: { createdById: user.id } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  if (row === null) throw new Error('The user has no subscription')
  return row
}

test('a customer switches auto-renewal off and on again', async ({ page, signedInUser }) => {
  await test.step('the customer pays for «Старт» and agrees to auto-renewal', async () => {
    await payForStart(page, { autoRenew: true })
    await expect(tariff(page, 'Старт')).toContainText('Активен')
    await expect(renewal(page)).toContainText('Включено.')
  })

  await test.step('the dialog names the last day and the credits, and «Оставить включённым» changes nothing', async () => {
    const opener = renewal(page).getByRole('button', { name: 'Отключить автопродление' })
    await opener.click()
    const dialog = page.getByRole('dialog', { name: 'Отключить автопродление?' })
    await expect(dialog).toContainText(
      new RegExp(sentence`Тариф «Старт» будет действовать до ${DATE}.`),
    )
    await expect(dialog).toContainText('300 кредитов по тарифу можно использовать до этого дня.')
    // The gift of the registration is untouched: tasks are taken on it after the tariff.
    await expect(dialog).toContainText(
      new RegExp(
        sentence`С ${DAY} новые задачи будут приниматься, только пока есть подарочные кредиты. Сайты и история правок сохранятся.`,
      ),
    )
    // The dialog is reached and left from the keyboard: the focus is inside it and comes back.
    await expect(dialog.getByRole('button', { name: 'Оставить включённым' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(opener).toBeFocused()
    expect((await subscriptionOf(signedInUser)).cancelAtPeriodEnd).toBe(false)
  })

  await test.step('the customer switches it off: the tariff ends with its period, the card stays', async () => {
    await renewal(page).getByRole('button', { name: 'Отключить автопродление' }).click()
    await page
      .getByRole('dialog', { name: 'Отключить автопродление?' })
      .getByRole('button', { name: 'Отключить' })
      .click()

    const block = tariff(page, 'Старт')
    const said = block.getByRole('status')
    await expect(said).toContainText(
      new RegExp(
        `^${sentence`Автопродление отключено. Тариф и 300 кредитов по тарифу доступны до ${DATE}. После этого новые задачи принимаются, только пока есть подарочные кредиты. Сайты и история правок сохранятся.`}$`,
      ),
      SLOW,
    )
    await expect(said).toBeFocused()
    await expect(block).toContainText(new RegExp(sentence`До ${DAY}`))
    await expect(row(page, 'Действует до')).toHaveText(new RegExp(`^${DATE}$`))
    await expect(row(page, 'Способ оплаты')).toHaveText('Карта «Мир» •• 4444')
    await expect(page.getByRole('heading', { level: 2, name: 'Автопродление' })).toHaveCount(0)
    await expect(planCard(page, 'Старт')).toContainText(
      new RegExp(String.raw`Действует до\s${DAY}\.`),
    )

    const stored = await subscriptionOf(signedInUser)
    expect(stored).toMatchObject({ status: 'active', cancelAtPeriodEnd: true })
    expect(stored.cancelledAt).not.toBeNull()
    expect(stored.paymentMethodId).not.toBeNull()
  })

  await test.step('it is still off after a reload, with the terms of switching it back on', async () => {
    await page.reload()
    const block = tariff(page, 'Старт')
    await expect(block).toContainText('Автопродление отключено.', SLOW)
    await expect(block).toContainText(
      new RegExp(
        sentence`Если включите, ${DAY} и дальше каждый месяц будем списывать 4 900 ₽ сохранённым способом оплаты — Карта «Мир» •• 4444.`,
      ),
    )
  })

  await test.step('the customer switches it on again with the saved card, without a page of the shop', async () => {
    await tariff(page, 'Старт').getByRole('button', { name: 'Включить автопродление' }).click()

    const said = tariff(page, 'Старт').getByRole('status')
    await expect(said).toHaveText(
      /^Автопродление включено\. Перед списанием пришлём письмо\.$/,
      SLOW,
    )
    await expect(said).toBeFocused()
    await expect(page).toHaveURL('/settings/plans')
    await expect(tariff(page, 'Старт')).toContainText('Активен')
    await expect(row(page, 'Следующее списание')).toHaveText(
      new RegExp(String.raw`^${DATE}\s—\s4\s900\s₽$`),
    )
    await expect(renewal(page)).toContainText(
      `Перед списанием пришлём письмо на ${signedInUser.email}.`,
    )

    expect(await subscriptionOf(signedInUser)).toMatchObject({
      cancelAtPeriodEnd: false,
      cancelledAt: null,
      // The coming charge is announced anew.
      renewalNoticePeriodEnd: null,
    })
  })
})

test('a customer without a saved card switches auto-renewal on through the binding page', async ({
  page,
  signedInUser,
}) => {
  await test.step('the customer pays for «Старт» without the consent: nothing renews', async () => {
    await payForStart(page, { autoRenew: false })
    const block = tariff(page, 'Старт')
    await expect(block).toContainText('Автопродление отключено.')
    await expect(row(page, 'Способ оплаты')).toHaveText('Не сохранён')
    await expect(block).toContainText(
      'Сначала привяжем карту на странице ЮKassa: деньги при этом не спишутся.',
    )
  })

  await test.step('«Включить автопродление» leads to the binding page, where nothing is charged', async () => {
    await fake('card', { last4: '1234', card_type: 'Visa', first6: '411111' })
    await tariff(page, 'Старт').getByRole('button', { name: 'Включить автопродление' }).click()
    await page.waitForURL(fakePage, SLOW)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Привязка способа оплаты')
    // Nothing is switched on before the card is saved.
    expect(await subscriptionOf(signedInUser)).toMatchObject({
      cancelAtPeriodEnd: true,
      paymentMethodId: null,
    })
    await page.getByRole('button', { name: 'Привязать' }).click()
  })

  await test.step('the card is saved and auto-renewal is on', async () => {
    await expect(page).toHaveURL('/settings/billing/return?method=1', SLOW)
    await expect(page.getByRole('heading', { level: 2, name: 'Карта привязана' })).toBeVisible(SLOW)
    const outcome = page.getByRole('main').getByRole('status')
    await expect(outcome).toContainText('Способ оплаты — Карта Visa •• 1234.')
    await expect(outcome).toContainText(
      new RegExp(sentence`${DAY} спишем этим способом 4 900 ₽ за тариф «Старт».`),
    )
    expect(await subscriptionOf(signedInUser)).toMatchObject({
      cancelAtPeriodEnd: false,
      cancelledAt: null,
    })

    await page.goto('/settings/plans')
    await expect(tariff(page, 'Старт')).toContainText('Активен', SLOW)
    await expect(row(page, 'Способ оплаты')).toHaveText('Карта Visa •• 1234')
    await expect(renewal(page)).toContainText('Включено.')
    await expect(page.getByRole('button', { name: 'Включить автопродление' })).toHaveCount(0)
  })
})

test('a customer schedules another tariff for the next period and takes the choice back', async ({
  page,
  signedInUser,
  credits,
}) => {
  await test.step('the customer pays for «Старт» with auto-renewal', async () => {
    await payForStart(page, { autoRenew: true })
  })

  await test.step('the dialog names the day, what stays and what is charged', async () => {
    const opener = planCard(page, 'Бизнес').getByRole('button', {
      name: 'Перейти на тариф «Бизнес»',
    })
    // One word on the button: the card says which tariff, and so does the name of the button.
    await expect(opener).toHaveText('Перейти')
    await opener.click()
    const dialog = page.getByRole('dialog', { name: 'Перейти на тариф «Бизнес»?' })
    await expect(dialog).toContainText(
      new RegExp(sentence`Тариф изменится ${DATE} — с началом нового периода.`),
    )
    await expect(dialog).toContainText('До этого дня действует «Старт».')
    await expect(dialog).toContainText(
      '800 кредитов в месяц, до 10 задач в день · до 3 сайтов на WordPress',
    )
    await expect(dialog).toContainText('12 900 ₽ сохранённым способом оплаты — Карта «Мир» •• 4444')
    await dialog.getByRole('button', { name: 'Не менять' }).click()
    await expect(dialog).toBeHidden()
    await expect(opener).toBeFocused()
    expect((await subscriptionOf(signedInUser)).nextPlanId).toBeNull()
  })

  // The dialogs of the page are siblings: one of another kind, opened after the first was
  // closed, has to open and close like the first.
  await test.step('the dialog of the pack, opened after the dialog of the change, closes by Escape', async () => {
    const opener = page.getByRole('button', { name: 'Купить пакет' })
    await opener.click()
    const dialog = page.getByRole('dialog', { name: /^Пакет из/ })
    await expect(dialog.getByRole('button', { name: 'Перейти к оплате' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(opener).toBeFocused()
  })

  await test.step('the dialog of the change, opened after the dialog of auto-renewal, closes by «Не менять»', async () => {
    await page.reload()
    const off = renewal(page).getByRole('button', { name: 'Отключить автопродление' })
    await off.click(SLOW)
    const question = page.getByRole('dialog', { name: 'Отключить автопродление?' })
    await question.getByRole('button', { name: 'Оставить включённым' }).click()
    await expect(question).toBeHidden()

    const opener = planCard(page, 'Бизнес').getByRole('button', {
      name: 'Перейти на тариф «Бизнес»',
    })
    await opener.click()
    const dialog = page.getByRole('dialog', { name: 'Перейти на тариф «Бизнес»?' })
    await dialog.getByRole('button', { name: 'Не менять' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(opener).toBeFocused()
    // Nothing was changed on the way.
    expect(await subscriptionOf(signedInUser)).toMatchObject({
      nextPlanId: null,
      cancelAtPeriodEnd: false,
    })
  })

  await test.step('the change is scheduled: nothing changes today, the next charge is the new price', async () => {
    await planCard(page, 'Бизнес')
      .getByRole('button', { name: 'Перейти на тариф «Бизнес»' })
      .click()
    await page
      .getByRole('dialog', { name: 'Перейти на тариф «Бизнес»?' })
      .getByRole('button', { name: /^Перейти\sс\s/ })
      .click()

    const block = tariff(page, 'Старт')
    const said = block.getByRole('status')
    await expect(said).toHaveText(
      new RegExp(`^${sentence`Готово: с ${DAY} — тариф «Бизнес».`}$`),
      SLOW,
    )
    await expect(said).toBeFocused()
    const coming = block.getByRole('group', { name: /тариф «Бизнес»$/ })
    await expect(coming).toContainText(
      new RegExp(sentence`${DAY} спишем 12 900 ₽ сохранённым способом оплаты.`),
    )
    await expect(row(page, 'Следующее списание')).toHaveText(
      new RegExp(String.raw`^${DATE}\s—\s12\s900\s₽$`),
    )
    // Today the tariff, its price and its credits are what they were: the accounts hold the
    // quota of «Старт» and the gift.
    await expect(block).toContainText('4 900 ₽ в месяц')
    const accounts = await credits.stored()
    expect([accounts.tariff.left, accounts.gift.left]).toEqual([300, 35])
    await expect(row(page, 'Кредиты')).toHaveText(creditsRow(accounts))
    await expect(planCard(page, 'Старт')).toContainText('Ваш тариф')
    await expect(planCard(page, 'Бизнес')).toContainText(
      new RegExp(sentence`Начнёт действовать ${DAY}.`),
    )
    await expect(planCard(page, 'Бизнес').getByRole('button')).toHaveCount(0)

    const stored = await subscriptionOf(signedInUser)
    const business = await db.plan.findFirstOrThrow({ where: { slug: 'business' } })
    expect(stored).toMatchObject({ nextPlanId: business.id, renewalNoticePeriodEnd: null })
    expect(stored.planId).not.toBe(business.id)
  })

  await test.step('the scheduled change is still there after a reload', async () => {
    await page.reload()
    await expect(tariff(page, 'Старт').getByRole('group', { name: /тариф «Бизнес»$/ })).toBeVisible(
      SLOW,
    )
  })

  await test.step('the customer takes the choice back', async () => {
    await tariff(page, 'Старт').getByRole('button', { name: 'Отменить переход' }).click()

    const said = tariff(page, 'Старт').getByRole('status')
    await expect(said).toHaveText('Переход отменён: остаётся тариф «Старт».', SLOW)
    await expect(said).toBeFocused()
    await expect(tariff(page, 'Старт').getByRole('group')).toHaveCount(0)
    await expect(row(page, 'Следующее списание')).toHaveText(
      new RegExp(String.raw`^${DATE}\s—\s4\s900\s₽$`),
    )
    await expect(
      planCard(page, 'Бизнес').getByRole('button', { name: 'Перейти на тариф «Бизнес»' }),
    ).toBeVisible()
    expect((await subscriptionOf(signedInUser)).nextPlanId).toBeNull()
  })
})

test('a customer whose renewal charge failed pays on the page of the shop and the tariff is active again', async ({
  page,
  signedInUser,
  credits,
}) => {
  await test.step('the customer pays for «Старт» with auto-renewal', async () => {
    await payForStart(page, { autoRenew: true })
  })

  const overdueSince = new Date(Date.now() - DAY_MS)
  await test.step('the period ended a day ago and the charge was declined', async () => {
    // What the scheduler leaves after a declined charge: the tariff is past due.
    const { id } = await subscriptionOf(signedInUser)
    await db.subscription.update({
      where: { id },
      data: {
        status: 'past_due',
        currentPeriodStart: new Date(overdueSince.getTime() - 30 * DAY_MS),
        currentPeriodEnd: overdueSince,
        periodAnchor: new Date(overdueSince.getTime() - 30 * DAY_MS),
        pastDueSince: overdueSince,
      },
    })
  })

  await test.step('«Тарифы» says that the charge failed, until when the tariff waits, and shows no credits as left', async () => {
    await page.reload()
    const block = tariff(page, 'Старт')
    await expect(block).toContainText('Оплата не прошла', SLOW)
    const alert = block.getByRole('alert')
    await expect(alert).toContainText('Не получилось списать 4 900 ₽')
    await expect(alert).toContainText(
      new RegExp(
        sentence`Оплатите тариф: пока оплата не пройдёт, новые задачи принимаются, только пока есть подарочные кредиты. ${DATE} тариф закончится, если оплата не пройдёт раньше. Карту для следующих списаний можно заменить.`,
      ),
    )
    // Replacing the card pays for nothing, and the page does not say that it would.
    await expect(alert).not.toContainText('или замените')
    // Nothing of the tariff is left to the customer; the gift of the registration is.
    await expect(row(page, 'Кредиты')).toHaveText(
      'Осталось 35 подарочных. Кредиты по тарифу начислим после оплаты',
    )
    await expect(block.getByRole('link', { name: 'Заменить карту' })).toHaveAttribute(
      'href',
      '/settings/billing',
    )
    // Nothing is offered that an overdue tariff cannot have.
    await expect(page.getByRole('button', { name: /^(Перейти на|Купить|Включить)/ })).toHaveCount(0)
    await expect(renewal(page)).toContainText(
      'Способ оплаты, которым вы оплатите тариф, сохранится',
    )
  })

  await test.step('the dialog names the amount, the month from today and the card that will be saved', async () => {
    await tariff(page, 'Старт').getByRole('button', { name: 'Оплатить сейчас' }).click()
    const dialog = page.getByRole('dialog', { name: 'Тариф «Старт»' })
    await expect(dialog).toContainText('С сегодняшнего дня на месяц')
    await expect(dialog).toContainText('4 900 ₽')
    await expect(dialog).toContainText(
      'Автопродление включено: сохраним способ оплаты, которым вы заплатите сейчас',
    )
    await fake('card', { last4: '1234', card_type: 'Visa', first6: '411111' })
    await dialog.getByRole('button', { name: 'Перейти к оплате' }).click()
    await page.waitForURL(fakePage, SLOW)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('4900.00')
    await page.getByRole('button', { name: 'Оплатить' }).click()
  })

  await test.step('the return page shows the paid order and the new period', async () => {
    await expect(page).toHaveURL(returnPage, SLOW)
    await expect(page.getByRole('heading', { level: 2, name: 'Оплата прошла' })).toBeVisible(SLOW)
    const outcome = page.getByRole('main').getByRole('status')
    await expect(outcome).toContainText('Тариф «Старт» — 4 900 ₽.')
    await expect(outcome).toContainText(new RegExp(sentence`Тариф действует до ${DATE}.`))
  })

  await test.step('the tariff is active for a month from the payment, with a new quota and the new card', async () => {
    const stored = await subscriptionOf(signedInUser)
    expect(stored).toMatchObject({ status: 'active', pastDueSince: null, cancelAtPeriodEnd: false })
    // A month from the payment, which is the new anchor: not from the period that ended.
    expect(stored.periodAnchor.getTime()).toBeGreaterThan(overdueSince.getTime())
    expect(stored.currentPeriodStart).toEqual(stored.periodAnchor)
    const days = (stored.currentPeriodEnd.getTime() - stored.periodAnchor.getTime()) / DAY_MS
    expect(days).toBeGreaterThanOrEqual(28)
    expect(days).toBeLessThanOrEqual(31)

    await page.getByRole('link', { name: 'К тарифам' }).click()
    const block = tariff(page, 'Старт')
    await expect(block).toContainText('Активен', SLOW)
    await expect(block.getByRole('alert')).toHaveCount(0)
    // The quota of the new period, granted anew, beside the gift.
    const accounts = await credits.stored()
    expect([accounts.tariff.left, accounts.gift.left]).toEqual([300, 35])
    await expect(row(page, 'Кредиты')).toHaveText(creditsRow(accounts))
    await expect(row(page, 'Способ оплаты')).toHaveText('Карта Visa •• 1234')
    await expect(row(page, 'Следующее списание')).toHaveText(
      new RegExp(String.raw`^${DATE}\s—\s4\s900\s₽$`),
    )
    await expect(page.getByRole('button', { name: 'Оплатить сейчас' })).toHaveCount(0)
  })

  await test.step('«Оплата» lists both payments of the tariff', async () => {
    await page
      .getByRole('navigation', { name: 'Разделы настроек' })
      .getByRole('link', { name: 'Оплата' })
      .click()
    await expect(
      page.getByRole('region', { name: 'История платежей' }).getByRole('table').getByRole('row'),
    ).toHaveCount(3, SLOW)
  })
})

test('a customer whose tariff is over sees when it ended and chooses a tariff again', async ({
  page,
  signedInUser,
}) => {
  await test.step('the customer pays for «Старт» without auto-renewal, and the period ends', async () => {
    await payForStart(page, { autoRenew: false })
    // What the scheduler does at the end of a period that is not renewed.
    const { id } = await subscriptionOf(signedInUser)
    const ended = new Date(Date.now() - DAY_MS)
    await db.subscription.update({
      where: { id },
      data: {
        status: 'cancelled',
        currentPeriodStart: new Date(ended.getTime() - 30 * DAY_MS),
        currentPeriodEnd: ended,
      },
    })
  })

  await test.step('«Тарифы» says that the tariff is over and what is kept', async () => {
    await page.reload()
    const block = tariff(page, 'Старт')
    await expect(block).toContainText(new RegExp(sentence`Закончился ${DAY}`), SLOW)
    // The gift of the registration outlives the tariff, and tasks are taken on it.
    await expect(block).toContainText(
      'Новые задачи принимаются, только пока есть подарочные кредиты. Сайты и история правок на месте.',
    )
    // What the gift is enough for is said once — under the heading of the page.
    await expect(block).not.toContainText('Выберите тариф')
    await expect(
      page.getByText(
        'У вас 35 подарочных кредитов — их хватит на семь небольших правок или на две-три задачи побольше. Без тарифа можно поставить до 3 задач в день. Когда кредиты закончатся, понадобится тариф.',
      ),
    ).toBeVisible()
    await expect(page.getByRole('main')).not.toContainText('не принимаются')
    await expect(page.getByRole('heading', { level: 2, name: 'Автопродление' })).toHaveCount(0)
  })

  await test.step('«Выбрать тариф» leads to the tariffs on sale, each with its button', async () => {
    await tariff(page, 'Старт').getByRole('link', { name: 'Выбрать тариф' }).click()
    await expect(page).toHaveURL('/settings/plans#plans')
    await expect(page.getByRole('heading', { level: 2, name: 'Выберите тариф' })).toBeInViewport()
    await expect(
      planCard(page, 'Бизнес').getByRole('button', { name: 'Выбрать «Бизнес»' }),
    ).toBeVisible()
  })
})

test('a user who has not accepted a new edition of the documents sees the coming charge and switches it off', async ({
  page,
  signedInUser,
}) => {
  await test.step('the customer pays for «Старт» with auto-renewal', async () => {
    await payForStart(page, { autoRenew: true })
  })

  await test.step('a new edition is published: the cabinet sends the user to the consent page', async () => {
    // The consents of the user are of an edition before the current one.
    await db.userConsent.deleteMany({ where: { userId: signedInUser.id } })
    await page.goto('/settings/plans')
    await expect(page).toHaveURL('/onboarding/consents', SLOW)
    await expect(page.getByRole('heading', { level: 1, name: 'Примите условия' })).toBeVisible(SLOW)
  })

  await test.step('the page tells of the charge and stops it without the consent', async () => {
    const block = page.getByRole('region', { name: 'Автопродление тарифа' })
    await expect(block).toContainText(
      new RegExp(
        sentence`У вас включено автопродление тарифа «Старт»: ${DAY} спишем 4 900 ₽. Отключить его можно, не принимая документы.`,
      ),
      SLOW,
    )
    // The form of the consent is above it and untouched.
    await expect(page.getByRole('button', { name: 'Продолжить' })).toBeDisabled()

    await block.getByRole('button', { name: 'Отключить автопродление' }).click()

    const said = block.getByRole('status')
    await expect(said).toHaveText(
      new RegExp(`^${sentence`Автопродление отключено. Тариф «Старт» действует до ${DATE}.`}$`),
      SLOW,
    )
    await expect(said).toBeFocused()
    await expect(block.getByRole('button')).toHaveCount(0)
    await expect(page).toHaveURL('/onboarding/consents')
    expect(await subscriptionOf(signedInUser)).toMatchObject({
      status: 'active',
      cancelAtPeriodEnd: true,
    })
    // Nothing was accepted on the way.
    expect(await db.userConsent.count({ where: { userId: signedInUser.id } })).toBe(0)
  })

  await test.step('nothing is said of a charge after a reload: none is coming', async () => {
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Примите условия' })).toBeVisible(SLOW)
    await expect(page.getByRole('region', { name: 'Автопродление тарифа' })).toHaveCount(0)
  })
})
