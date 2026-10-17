import { randomUUID } from 'node:crypto'

import type { Page } from '@playwright/test'

import { fakeYookassa } from '../../fixtures/billing-stand.ts'
import { creditsRow } from '../../fixtures/credit-words.ts'
import { expect, test } from '../../fixtures/credits.ts'

// «Настройки → Тарифы» in a real browser: a signed-in customer picks a tariff, confirms it in
// the dialog, pays (or refuses to) on the page of the fake ЮKassa and comes back to the page
// of the order. The row of the credits is compared with what the accounts hold in the database.
// The fixture removes the user with everything the payment created.

// Each step opens a page the development server compiles on first use.
test.describe.configure({ timeout: 180_000 })
const SLOW = { timeout: 60_000 }

interface Delivery {
  event: string
  /** The HTTP status web answered with; absent while the notification was withheld. */
  status?: number
  withheld?: boolean
}

/** A command of the fake ЮKassa (infra/dev/billing-verify/README.md, «Команды стенда»). */
async function fake<T = unknown>(command: string, body?: object): Promise<T> {
  const response = await fetch(`${fakeYookassa.controlUrl}/${command}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(`The fake ЮKassa refused «${command}»: ${response.status}`)
  return (await response.json()) as T
}

/** Every notification sent so far has been answered; returns the journal of all of them. */
async function deliveries(): Promise<Delivery[]> {
  return (await fake<{ deliveries: Delivery[] }>('settle', {})).deliveries
}

test.beforeEach(async () => {
  // Payments, cards and withheld notifications of the previous test are gone.
  await fake('reset', {})
})

test.afterEach(async () => {
  // No notification is on its way to web when the fixture removes the rows of the user.
  await fake('reset', {})
})

const plansHeading = (page: Page) => page.getByRole('heading', { level: 1, name: 'Тарифы' })

/** The card of a tariff in the grid. */
const planCard = (page: Page, name: string) =>
  page
    .getByRole('list', { name: 'Тарифы' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { level: 3, name, exact: true }) })

/**
 * The value beside a label in the block of the customer's tariff: the text of the row, or its
 * first piece of text that is not a link when the row ends with one («Подробнее»).
 */
const row = (page: Page, label: string) =>
  page
    .locator('dt', { hasText: label })
    .locator('xpath=following-sibling::dd[1]/descendant-or-self::*[not(self::a) and not(*)][1]')

/** Opens «Тарифы», chooses a tariff and leaves for the payment page of the fake. */
async function checkout(page: Page, plan: string, { autoRenew }: { autoRenew: boolean }) {
  await page.goto('/settings/plans')
  await expect(plansHeading(page)).toBeVisible(SLOW)
  await expect(page.getByRole('heading', { level: 2, name: 'Выберите тариф' })).toBeVisible(SLOW)

  await planCard(page, plan)
    .getByRole('button', { name: `Выбрать «${plan}»` })
    .click()
  const dialog = page.getByRole('dialog', { name: `Тариф «${plan}»` })
  const consent = dialog.getByRole('checkbox', { name: 'Продлевать автоматически' })
  // The consent is the customer's to give: the box is never ticked for them.
  await expect(consent).not.toBeChecked()
  if (autoRenew) await consent.check()
  await dialog.getByRole('button', { name: 'Перейти к оплате' }).click()

  await page.waitForURL(`http://127.0.0.1:${fakeYookassa.port}/pay/**`, SLOW)
  await expect(page.getByRole('button', { name: 'Оплатить' })).toBeVisible()
}

const returnPage = /\/settings\/billing\/return\?order=[0-9a-f-]{36}$/

// A day as the pages print it, «5 ноября» and «5 ноября 2026». The pages bind a number to its
// word with a non-breaking space, and a pattern, unlike a string, is matched as it is written.
const DAY = String.raw`\d{1,2}\s[а-я]+`
const DATE = String.raw`${DAY}\s\d{4}`

/**
 * The line under the heading of «Тарифы» for a customer without a tariff who has the whole gift
 * of the registration — promised before the first site or checkout, on the account after it.
 */
const GIFT_LEAD =
  'У вас 35 подарочных кредитов — их хватит на семь небольших правок или на две-три задачи побольше. Когда кредиты закончатся, понадобится тариф.'

test('a customer picks a tariff, pays for it and sees it active', async ({
  page,
  signedInUser,
  credits,
}) => {
  await page.goto('/settings/plans')
  await expect(plansHeading(page)).toBeVisible(SLOW)

  await test.step('the page of a customer without a tariff', async () => {
    const sidebar = page.getByRole('navigation', { name: 'Разделы настроек' })
    await expect(sidebar.getByRole('link', { name: 'Тарифы' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(page.getByRole('navigation', { name: 'Хлебные крошки' })).toHaveText(
      /^Настройки\s*\/\s*Тарифы$/,
    )
    await expect(page).toHaveTitle(/^Тарифы/)
    // A new user has no workspace yet: the gift of the registration is shown as promised.
    await expect(page.getByText(GIFT_LEAD)).toBeVisible(SLOW)
    await expect(page.getByRole('main')).not.toContainText('Выберите тариф, чтобы')
    // The seeded tariffs, each with its button: the customer has no site yet, so all fit.
    for (const name of ['Старт', 'Бизнес', 'Агентство']) {
      await expect(
        planCard(page, name).getByRole('button', { name: `Выбрать «${name}»` }),
      ).toBeVisible()
    }
    await expect(planCard(page, 'Старт')).toContainText('4 900 ₽')
    await expect(planCard(page, 'Старт')).toContainText('Подходит вам')
    // What a task costs and what a tariff holds, in the numbers of the credits model: the
    // credits come from the seeds, the minimum, the examples and the average from the domain.
    await expect(page.getByRole('main')).toContainText(
      'Задача стоит столько кредитов, сколько работы она потребовала, но не меньше 5: небольшая правка текста, цены или фото — обычно 5 кредитов, добавить блок или страницу — 15–25. Кредиты списываются только за выполненную задачу.',
    )
    for (const [name, lines] of [
      ['Старт', ['300 кредитов в месяц', 'В среднем около 27 задач', 'До 50 кредитов в день']],
      ['Бизнес', ['800 кредитов в месяц', 'В среднем около 73 задач', 'До 100 кредитов в день']],
      [
        'Агентство',
        ['2 500 кредитов в месяц', 'В среднем около 230 задач', 'До 300 кредитов в день'],
      ],
    ] as const) {
      for (const line of lines) await expect(planCard(page, name)).toContainText(line)
    }
    await expect(page.getByRole('main')).not.toContainText('один кредит')
    await expect(page.getByRole('link', { name: 'Публичная оферта' })).toHaveAttribute(
      'href',
      '/terms/public-offer',
    )
  })

  await test.step('the dialog names the tariff and the amount, and «Отмена» pays nothing', async () => {
    const opener = planCard(page, 'Старт').getByRole('button', { name: 'Выбрать «Старт»' })
    await opener.click()
    const dialog = page.getByRole('dialog', { name: 'Тариф «Старт»' })
    await expect(dialog).toContainText(
      '300 кредитов в месяц, до 50 кредитов в день · один сайт на WordPress',
    )
    await expect(dialog).toContainText('К оплате сегодня')
    await expect(dialog).toContainText('4 900 ₽')
    await expect(dialog).toContainText('Оплата принимается только с личной карты')
    await dialog.getByRole('button', { name: 'Отмена' }).click()
    await expect(dialog).toBeHidden()
    await expect(opener).toBeFocused()
    await expect(page).toHaveURL('/settings/plans')
  })

  await test.step('the customer agrees to auto-renewal and pays', async () => {
    await checkout(page, 'Старт', { autoRenew: true })
    await expect(page.getByRole('heading', { level: 1 })).toContainText('4900.00')
    await page.getByRole('button', { name: 'Оплатить' }).click()
  })

  await test.step('the return page shows the paid order', async () => {
    await expect(page).toHaveURL(returnPage, SLOW)
    await expect(page.getByRole('heading', { level: 2, name: 'Оплата прошла' })).toBeVisible(SLOW)
    await expect(page.getByRole('navigation', { name: 'Хлебные крошки' })).toHaveText(
      /^Настройки\s*\/\s*Оплата$/,
    )
    const outcome = page.getByRole('main').getByRole('status')
    await expect(outcome).toContainText('Тариф «Старт» — 4 900 ₽.')
    await expect(outcome).toContainText(new RegExp(String.raw`Тариф действует до\s${DATE}\.`))
  })

  await test.step('the notification of ЮKassa reached web and was accepted', async () => {
    const sent = await deliveries()
    expect(sent.map(({ event, status }) => ({ event, status }))).toEqual([
      { event: 'payment.succeeded', status: 200 },
    ])
  })

  await test.step('«Тарифы» shows the tariff as active, with its credits', async () => {
    await page.getByRole('link', { name: 'К тарифам' }).click()
    await expect(page).toHaveURL('/settings/plans')
    const block = page.locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Тариф «Старт»' }),
    })
    await expect(block).toBeVisible(SLOW)
    await expect(block).toContainText('Активен')
    await expect(block).toContainText('4 900 ₽ в месяц')
    await expect(row(page, 'Следующее списание')).toHaveText(
      new RegExp(String.raw`^${DATE}\s—\s4\s900\s₽$`),
    )
    // The card of the fake, saved because the customer agreed to it.
    await expect(row(page, 'Способ оплаты')).toHaveText('Карта «Мир» •• 4444')
    // The quota of the tariff beside the gift, which the checkout granted with the workspace:
    // what the two accounts hold.
    const stored = await credits.stored()
    expect([stored.tariff.left, stored.gift.left, stored.pack.left]).toEqual([300, 35, 0])
    await expect(row(page, 'Кредиты')).toHaveText(creditsRow(stored))

    await expect(planCard(page, 'Старт')).toContainText('Ваш тариф')
    await expect(planCard(page, 'Старт')).toContainText(new RegExp(String.raw`Продлится\s${DAY}\.`))
    await expect(page.getByRole('button', { name: /^Выбрать/ })).toHaveCount(0)
    const renewal = page.locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Автопродление' }),
    })
    await expect(renewal).toContainText('Включено.')
    await expect(renewal).toContainText(`Перед списанием пришлём письмо на ${signedInUser.email}.`)
  })

  await test.step('the tariff is still there after a reload', async () => {
    await page.reload()
    await expect(page.getByRole('heading', { level: 2, name: 'Тариф «Старт»' })).toBeVisible(SLOW)
    await expect(row(page, 'Кредиты')).toHaveText(creditsRow(await credits.stored()))
  })
})

test('a customer who refuses to pay comes back without a tariff', async ({
  page,
  // Asking for the user is what signs the page in.
  signedInUser: _signedIn,
}) => {
  await checkout(page, 'Старт', { autoRenew: false })
  await page.getByRole('button', { name: 'Отказаться' }).click()

  await expect(page).toHaveURL(returnPage, SLOW)
  await expect(page.getByRole('heading', { level: 2, name: 'Оплата не прошла' })).toBeVisible(SLOW)
  // The reason of the cancelled payment, in the words of the order.
  await expect(page.getByRole('main').getByRole('status')).toContainText(
    'Время на оплату истекло. Оформите оплату заново.',
  )
  await expect(page.getByRole('heading', { name: 'Оплата прошла' })).toHaveCount(0)

  await page.getByRole('link', { name: 'Попробовать ещё раз' }).click()

  await expect(page).toHaveURL('/settings/plans')
  await expect(page.getByRole('heading', { level: 2, name: 'Выберите тариф' })).toBeVisible(SLOW)
  await expect(page.getByRole('heading', { level: 2, name: /^Тариф «/ })).toHaveCount(0)
  await expect(
    planCard(page, 'Старт').getByRole('button', { name: 'Выбрать «Старт»' }),
  ).toBeVisible()
  await expect(page.getByText('Способ оплаты')).toHaveCount(0)
  // The checkout made the workspace and granted the gift with it: a payment that did not go
  // through takes nothing of it back, and the page says the same as before the checkout.
  await expect(page.getByText(GIFT_LEAD)).toBeVisible()
})

test('the return page switches the tariff on when the notification never comes', async ({
  page,
  signedInUser: _signedIn,
  credits,
}) => {
  await fake('webhooks', { enabled: false })
  await checkout(page, 'Бизнес', { autoRenew: false })
  await page.getByRole('button', { name: 'Оплатить' }).click()

  await expect(page).toHaveURL(returnPage, SLOW)
  await expect(page.getByRole('heading', { level: 2, name: 'Оплата прошла' })).toBeVisible(SLOW)
  await expect(page.getByRole('main').getByRole('status')).toContainText(
    'Тариф «Бизнес» — 12 900 ₽.',
  )
  // Nothing was sent to web: the page alone read the payment back and settled the order.
  expect(await deliveries()).toEqual([
    expect.objectContaining({ event: 'payment.succeeded', withheld: true }),
  ])

  await page.getByRole('link', { name: 'К тарифам' }).click()

  await expect(page).toHaveURL('/settings/plans')
  const block = page.locator('section', {
    has: page.getByRole('heading', { level: 2, name: 'Тариф «Бизнес»' }),
  })
  await expect(block).toBeVisible(SLOW)
  // No consent to auto-renewal: the tariff lasts to the end of the paid month.
  await expect(block).toContainText(new RegExp(String.raw`До\s${DAY}`))
  await expect(block).toContainText('Автопродление отключено.')
  await expect(row(page, 'Действует до')).toHaveText(new RegExp(`^${DATE}$`))
  await expect(row(page, 'Способ оплаты')).toHaveText('Не сохранён')
  const stored = await credits.stored()
  expect([stored.tariff.left, stored.gift.left]).toEqual([800, 35])
  await expect(row(page, 'Кредиты')).toHaveText(creditsRow(stored))
  await expect(page.getByRole('heading', { level: 2, name: 'Автопродление' })).toHaveCount(0)
  await expect(planCard(page, 'Бизнес')).toContainText('Ваш тариф')
})

test('a link that names no order of the customer shows «Заказ не найден»', async ({
  page,
  signedInUser: _signedIn,
}) => {
  const asked: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('billing.syncOrder')) asked.push(request.url())
  })
  const notFound = page.getByRole('heading', { level: 2, name: 'Заказ не найден' })

  // Not the id of an order: the page says so without asking the server.
  await page.goto('/settings/billing/return?order=nope')
  await expect(notFound).toBeVisible(SLOW)
  await expect(page.getByRole('link', { name: 'К тарифам' })).toHaveAttribute(
    'href',
    '/settings/plans',
  )
  expect(asked).toEqual([])

  // An id that is nobody's order: the server is asked and answers «not found».
  await page.goto(`/settings/billing/return?order=${randomUUID()}`)
  await expect(notFound).toBeVisible(SLOW)
  // Not a failed check either. Inside `main`: Next keeps an alert of its own for route changes.
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0)
  expect(asked.length).toBeGreaterThan(0)
})

test('a customer with an active tariff buys a pack and sees its credits beside the quota', async ({
  page,
  signedInUser: _signedIn,
  credits,
}) => {
  const buyPack = page.getByRole('button', { name: 'Купить пакет' })
  const packDialog = page.getByRole('dialog', { name: 'Пакет из 100 кредитов' })

  await test.step('no pack is offered before a tariff is on', async () => {
    await page.goto('/settings/plans')
    await expect(page.getByRole('heading', { level: 2, name: 'Выберите тариф' })).toBeVisible(SLOW)
    await expect(buyPack).toHaveCount(0)
    await expect(page.getByText(/Пакет из/)).toHaveCount(0)
  })

  await test.step('the customer pays for «Старт» without auto-renewal', async () => {
    await checkout(page, 'Старт', { autoRenew: false })
    await page.getByRole('button', { name: 'Оплатить' }).click()
    await expect(page).toHaveURL(returnPage, SLOW)
    await expect(page.getByRole('heading', { level: 2, name: 'Оплата прошла' })).toBeVisible(SLOW)
    await page.getByRole('link', { name: 'К тарифам' }).click()
    await expect(page).toHaveURL('/settings/plans')
    await expect(row(page, 'Кредиты')).toContainText(creditsRow(await credits.stored()), SLOW)
  })

  await test.step('«Тарифы» offers the pack of the seeds under the tariffs', async () => {
    // The pages bind a number to its word with a non-breaking space: a pattern, not a string.
    await expect(
      page.getByRole('heading', { level: 3, name: /^Пакет\sиз\s100\sкредитов\s—\s1\s990\s₽$/ }),
    ).toBeVisible()
    await expect(page.getByRole('main')).toContainText(
      'Пригодится, если кредиты по тарифу закончатся на сегодня или до конца периода: это в среднем около 9 задач. Добавим 100 кредитов сразу после оплаты. Кредиты из пакета не сгорают в конце периода.',
    )
    await expect(buyPack).toBeVisible()
  })

  await test.step('the dialog names the pack and the amount, and «Отмена» pays nothing', async () => {
    await buyPack.click()
    await expect(packDialog).toContainText('К оплате сегодня')
    await expect(packDialog).toContainText('1 990 ₽')
    await expect(packDialog).toContainText('Оплата принимается только с личной карты')
    await expect(packDialog.getByRole('link', { name: 'публичной оферты' })).toHaveAttribute(
      'href',
      '/terms/public-offer',
    )
    // A pack renews nothing: there is no consent to give.
    await expect(packDialog.getByRole('checkbox')).toHaveCount(0)
    await packDialog.getByRole('button', { name: 'Отмена' }).click()
    await expect(packDialog).toBeHidden()
    await expect(buyPack).toBeFocused()
    await expect(page).toHaveURL('/settings/plans')
  })

  await test.step('the customer pays for the pack on the page of the fake', async () => {
    await buyPack.click()
    await packDialog.getByRole('button', { name: 'Перейти к оплате' }).click()
    await page.waitForURL(`http://127.0.0.1:${fakeYookassa.port}/pay/**`, SLOW)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('1990.00')
    await expect(page.getByText('Радити: «Пакет из 100 кредитов»')).toBeVisible()
    await page.getByRole('button', { name: 'Оплатить' }).click()
  })

  await test.step('the return page says what was bought and that the credits are added', async () => {
    await expect(page).toHaveURL(returnPage, SLOW)
    await expect(page.getByRole('heading', { level: 2, name: 'Оплата прошла' })).toBeVisible(SLOW)
    const outcome = page.getByRole('main').getByRole('status')
    await expect(outcome).toContainText('Пакет из 100 кредитов — 1 990 ₽.')
    await expect(outcome).toContainText(
      'Добавили 100 кредитов. Кредиты из пакета не сгорают в конце периода.',
    )
    // The pack moved no period: the page names no end of the tariff as bought.
    await expect(outcome).not.toContainText('действует до')
  })

  await test.step('both notifications of ЮKassa reached web and were accepted', async () => {
    const sent = await deliveries()
    expect(sent.map(({ event, status }) => ({ event, status }))).toEqual([
      { event: 'payment.succeeded', status: 200 },
      { event: 'payment.succeeded', status: 200 },
    ])
  })

  await test.step('«Тарифы» shows the pack credits beside the quota, and the tariff as it was', async () => {
    await page.getByRole('link', { name: 'К тарифам' }).click()
    await expect(page).toHaveURL('/settings/plans')
    // The three accounts, in the order their credits are spent in, as the database holds them.
    const stored = await credits.stored()
    expect([stored.tariff.left, stored.gift.left, stored.pack.left]).toEqual([300, 35, 100])
    expect(creditsRow(stored)).toBe('Осталось 435: 300 по тарифу, 35 подарочных и 100 из пакета')
    await expect(row(page, 'Кредиты')).toContainText(creditsRow(stored), SLOW)
    // No auto-renewal was agreed to with the tariff, and the pack saved no card either.
    await expect(row(page, 'Способ оплаты')).toHaveText('Не сохранён')
    await expect(row(page, 'Действует до')).toHaveText(new RegExp(`^${DATE}$`))
    await expect(page.getByRole('heading', { level: 2, name: 'Автопродление' })).toHaveCount(0)
    const block = page.locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Тариф «Старт»' }),
    })
    // The gift credits take tasks after the tariff as well; the pack waits for a tariff.
    await expect(block).toContainText(
      'После этого новые задачи принимаются, только пока есть подарочные кредиты. 100 кредитов из пакета, сайты и история правок сохранятся.',
    )
    // One more pack can be bought.
    await expect(buyPack).toBeVisible()
  })

  await test.step('the credits are still there after a reload', async () => {
    await page.reload()
    await expect(row(page, 'Кредиты')).toContainText(creditsRow(await credits.stored()), SLOW)
  })
})
