import type { Page } from '@playwright/test'

import { fakeYookassa } from '../../fixtures/billing-stand.ts'
import { expect, test } from '../../fixtures/signed-in.ts'

// «Настройки → Оплата» in a real browser: a signed-in customer pays for a tariff on the page of
// the fake ЮKassa, sees the payment and the saved card, replaces the card on the binding page
// of the fake, where nothing is charged, and unlinks it. The fixture removes the user with
// everything the payment and the bindings created.

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
async function fake<T = unknown>(command: string, body: object): Promise<T> {
  const response = await fetch(`${fakeYookassa.controlUrl}/${command}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`The fake ЮKassa refused «${command}»: ${response.status}`)
  return (await response.json()) as T
}

/** Every notification sent so far has been answered; the journal of all of them. */
async function deliveries(): Promise<{ event: string; status?: number; withheld?: boolean }[]> {
  const sent = (await fake<{ deliveries: Delivery[] }>('settle', {})).deliveries
  return sent.map(({ event, status, withheld }) => ({
    event,
    ...(status === undefined ? {} : { status }),
    ...(withheld ? { withheld } : {}),
  }))
}

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

const section = (page: Page, name: string) => page.getByRole('region', { name })
const method = (page: Page) => section(page, 'Способ оплаты')
const fakePage = `http://127.0.0.1:${fakeYookassa.port}/pay/**`
const bindingReturn = '/settings/billing/return?method=1'

/**
 * The value beside a label in the block of the customer's tariff on «Тарифы»: its first piece
 * of text that is not a link.
 */
const row = (page: Page, label: string) =>
  page
    .locator('dt', { hasText: label })
    .locator('xpath=following-sibling::dd[1]/descendant-or-self::*[not(self::a) and not(*)][1]')

/** Chooses «Старт» on «Тарифы», pays for it on the page of the fake and waits for the order. */
async function payForStart(page: Page, { autoRenew }: { autoRenew: boolean }) {
  await page.goto('/settings/plans')
  await expect(page.getByRole('heading', { level: 2, name: 'Выберите тариф' })).toBeVisible(SLOW)
  await page
    .getByRole('list', { name: 'Тарифы' })
    .getByRole('button', { name: 'Выбрать «Старт»' })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Тариф «Старт»' })
  if (autoRenew) await dialog.getByRole('checkbox', { name: 'Продлевать автоматически' }).check()
  await dialog.getByRole('button', { name: 'Перейти к оплате' }).click()
  await page.waitForURL(fakePage, SLOW)
  await page.getByRole('button', { name: 'Оплатить' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Оплата прошла' })).toBeVisible(SLOW)
}

/** Opens «Оплата» from the sidebar, the way a customer gets there. */
async function openBilling(page: Page) {
  await page
    .getByRole('navigation', { name: 'Разделы настроек' })
    .getByRole('link', { name: 'Оплата' })
    .click()
  await expect(page).toHaveURL('/settings/billing')
  await expect(page.getByRole('heading', { level: 1, name: 'Оплата' })).toBeVisible(SLOW)
  await expect(method(page)).toBeVisible(SLOW)
}

/** Leaves «Оплата» for the binding page of the fake by the button with this name. */
async function startBinding(page: Page, button: 'Заменить' | 'Привязать карту') {
  await method(page).getByRole('button', { name: button }).click()
  await page.waitForURL(fakePage, SLOW)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Привязка способа оплаты')
  // Nothing is charged for a binding, and the page of the shop says so.
  await expect(page.getByText('Списаний не будет')).toBeVisible()
}

test('a customer sees the payment and the saved card, replaces the card and unlinks it', async ({
  page,
  // Asking for the user is what signs the page in.
  signedInUser: _signedIn,
}) => {
  await test.step('the customer pays for «Старт» and agrees to auto-renewal', async () => {
    await payForStart(page, { autoRenew: true })
  })

  await test.step('«Оплата» is a section of the settings', async () => {
    await openBilling(page)
    await expect(
      page.getByRole('navigation', { name: 'Разделы настроек' }).getByRole('link', {
        name: 'Оплата',
      }),
    ).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('navigation', { name: 'Хлебные крошки' })).toHaveText(
      /^Настройки\s*\/\s*Оплата$/,
    )
    await expect(page).toHaveTitle(/^Оплата/)
  })

  await test.step('the card of the payment is saved and will be charged next', async () => {
    const saved = method(page)
    await expect(saved).toContainText('Карта «Мир» •• 4444')
    await expect(saved).toContainText(
      new RegExp(String.raw`${DAY}\sспишем этим способом\s4\s900\s₽\sза\sтариф «Старт»\.`),
    )
    await expect(saved).toContainText('Данные карты хранит ЮKassa.')
    await expect(saved.getByRole('button', { name: 'Заменить' })).toBeVisible()
    await expect(saved.getByRole('button', { name: 'Отвязать' })).toBeVisible()
  })

  await test.step('the history lists the payment with its period, amount and status', async () => {
    const history = section(page, 'История платежей')
    const rows = history.getByRole('table', { name: 'История платежей' }).getByRole('row')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0).getByRole('columnheader')).toHaveText([
      'Дата',
      'За что',
      'Сумма',
      'Статус',
    ])
    const cells = rows.nth(1).getByRole('cell')
    await expect(cells.nth(0)).toHaveText(new RegExp(`^${DATE}$`))
    await expect(cells.nth(1)).toHaveText(new RegExp(String.raw`^Тариф «Старт»${DAY}\s—\s${DAY}$`))
    await expect(cells.nth(2)).toHaveText(/^4\s900\s₽$/)
    await expect(cells.nth(3)).toHaveText('Оплачено')
    await expect(history.getByRole('button', { name: 'Показать ещё' })).toHaveCount(0)
    // The table is reachable from the keyboard when it scrolls.
    await expect(history.getByRole('group', { name: 'История платежей' })).toHaveAttribute(
      'tabindex',
      '0',
    )
  })

  await test.step('the customer replaces the card on the binding page of the fake', async () => {
    await fake('card', { last4: '1234', card_type: 'Visa', first6: '411111' })
    await startBinding(page, 'Заменить')
    await page.getByRole('button', { name: 'Привязать' }).click()

    await expect(page).toHaveURL(bindingReturn, SLOW)
    await expect(page.getByRole('heading', { level: 2, name: 'Карта привязана' })).toBeVisible(SLOW)
    const outcome = page.getByRole('main').getByRole('status')
    await expect(outcome).toContainText('Способ оплаты — Карта Visa •• 1234.')
    // Auto-renewal is as it was: the new card is the one that is charged.
    await expect(outcome).toContainText(
      new RegExp(String.raw`${DAY}\sспишем этим способом\s4\s900\s₽\sза\sтариф «Старт»\.`),
    )
  })

  await test.step('both notifications of ЮKassa reached web and were accepted', async () => {
    expect(await deliveries()).toEqual([
      { event: 'payment.succeeded', status: 200 },
      { event: 'payment_method.active', status: 200 },
    ])
  })

  await test.step('«Оплата» shows the new card, and the binding is no payment', async () => {
    await page.getByRole('link', { name: 'В раздел «Оплата»' }).click()
    await expect(page).toHaveURL('/settings/billing')
    await expect(method(page)).toContainText('Карта Visa •• 1234', SLOW)
    await expect(method(page)).not.toContainText('4444')
    await expect(section(page, 'История платежей').getByRole('table').getByRole('row')).toHaveCount(
      2,
    )
  })

  await test.step('the dialog says what unlinking does, and «Не отвязывать» unlinks nothing', async () => {
    const opener = method(page).getByRole('button', { name: 'Отвязать' })
    await opener.click()
    const dialog = page.getByRole('dialog', { name: 'Отвязать способ оплаты?' })
    await expect(dialog).toContainText('Карта Visa •• 1234')
    await expect(dialog).toContainText(
      new RegExp(
        // The gift of the registration is untouched: tasks are taken on it after the tariff.
        String.raw`Автопродление отключится\. Тариф «Старт» будет работать до\s${DATE}; после этого новые задачи принимаются, только пока есть подарочные кредиты\.`,
      ),
    )
    await dialog.getByRole('button', { name: 'Не отвязывать' }).click()
    await expect(dialog).toBeHidden()
    await expect(opener).toBeFocused()
    await expect(method(page)).toContainText('Карта Visa •• 1234')
  })

  await test.step('the customer unlinks the card: no method, auto-renewal off', async () => {
    await method(page).getByRole('button', { name: 'Отвязать' }).click()
    await page
      .getByRole('dialog', { name: 'Отвязать способ оплаты?' })
      .getByRole('button', { name: 'Отвязать' })
      .click()

    await expect(page.getByRole('dialog')).toBeHidden(SLOW)
    const saved = method(page)
    await expect(saved).toContainText('Способ оплаты не сохранён: автопродление выключено.')
    await expect(saved).not.toContainText('Карта Visa')
    const said = saved.getByRole('status')
    await expect(said).toHaveText(/^Способ оплаты отвязан, автопродление выключено\.$/)
    // The button that opened the dialog is gone: the focus is on what happened.
    await expect(said).toBeFocused()
    await expect(saved.getByRole('button', { name: 'Отвязать' })).toHaveCount(0)
    await expect(saved.getByRole('button', { name: 'Привязать карту' })).toBeVisible()
  })

  await test.step('«Тарифы» shows auto-renewal off and leads back to «Оплата»', async () => {
    await page
      .getByRole('navigation', { name: 'Разделы настроек' })
      .getByRole('link', { name: 'Тарифы' })
      .click()
    await expect(page).toHaveURL('/settings/plans')
    const block = page.locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Тариф «Старт»' }),
    })
    await expect(block).toBeVisible(SLOW)
    await expect(block).toContainText('Автопродление отключено.')
    await expect(block).toContainText(new RegExp(String.raw`До\s${DAY}`))
    await expect(row(page, 'Способ оплаты')).toHaveText('Не сохранён')
    await expect(row(page, 'Действует до')).toHaveText(new RegExp(`^${DATE}$`))
    await expect(page.getByText('Следующее списание')).toHaveCount(0)
    await expect(page.getByRole('heading', { level: 2, name: 'Автопродление' })).toHaveCount(0)

    await page.getByRole('link', { name: 'Изменить способ оплаты' }).click()
    await expect(page).toHaveURL('/settings/billing')
  })

  await test.step('nothing comes back after a reload', async () => {
    await page.reload()
    await expect(method(page)).toContainText(
      'Способ оплаты не сохранён: автопродление выключено.',
      SLOW,
    )
    // The notice of what was just done does not outlive the page.
    await expect(method(page).getByRole('status')).toHaveCount(0)
    await expect(section(page, 'История платежей').getByRole('table').getByRole('row')).toHaveCount(
      2,
    )
  })
})

test('a customer who refuses the binding keeps the card they had', async ({
  page,
  signedInUser: _signedIn,
}) => {
  await payForStart(page, { autoRenew: true })
  await openBilling(page)
  await fake('card', { last4: '1234', card_type: 'Visa' })

  await startBinding(page, 'Заменить')
  await page.getByRole('button', { name: 'Отказаться' }).click()

  await expect(page).toHaveURL(bindingReturn, SLOW)
  await expect(
    page.getByRole('heading', { level: 2, name: 'Не удалось привязать карту' }),
  ).toBeVisible(SLOW)
  const outcome = page.getByRole('main').getByRole('status')
  await expect(outcome).toContainText('Денег с карты не списано.')
  await expect(outcome).toContainText('Способ оплаты прежний — Карта «Мир» •• 4444.')
  // A refusal is no failure of the page. Inside `main`: Next keeps an alert of its own.
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0)

  await page.getByRole('link', { name: 'В раздел «Оплата»' }).click()

  await expect(page).toHaveURL('/settings/billing')
  await expect(method(page)).toContainText('Карта «Мир» •• 4444', SLOW)
  await expect(method(page)).toContainText('спишем этим способом')
  // The return page tells the same after the binding is over.
  await page.goto(bindingReturn)
  await expect(
    page.getByRole('heading', { level: 2, name: 'Не удалось привязать карту' }),
  ).toBeVisible(SLOW)
})

test('a card bound to a tariff without auto-renewal is saved by the return page and switches nothing on', async ({
  page,
  signedInUser: _signedIn,
}) => {
  await payForStart(page, { autoRenew: false })
  await openBilling(page)

  await test.step('nothing is saved after a payment without the consent', async () => {
    const saved = method(page)
    await expect(saved).toContainText('Способ оплаты не сохранён: автопродление выключено.')
    await expect(saved).toContainText('Автопродление при этом не включится')
    await expect(saved.getByRole('button', { name: 'Заменить' })).toHaveCount(0)
    await expect(saved.getByRole('button', { name: 'Отвязать' })).toHaveCount(0)
  })

  await test.step('the customer binds a card while the notification is withheld', async () => {
    await fake('webhooks', { enabled: false })
    await startBinding(page, 'Привязать карту')
    await page.getByRole('button', { name: 'Привязать' }).click()

    await expect(page).toHaveURL(bindingReturn, SLOW)
    await expect(page.getByRole('heading', { level: 2, name: 'Карта привязана' })).toBeVisible(SLOW)
    const outcome = page.getByRole('main').getByRole('status')
    await expect(outcome).toContainText('Способ оплаты — Карта «Мир» •• 4444.')
    await expect(outcome).toContainText('Автопродление выключено: списаний не будет.')
    // Nothing was sent to web: the page alone read the method back and stored it.
    expect(await deliveries()).toEqual([
      { event: 'payment.succeeded', status: 200 },
      { event: 'payment_method.active', withheld: true },
    ])
  })

  await test.step('the card is saved and the tariff still ends with its period', async () => {
    await page.getByRole('link', { name: 'В раздел «Оплата»' }).click()
    await expect(page).toHaveURL('/settings/billing')
    const saved = method(page)
    await expect(saved).toContainText('Карта «Мир» •• 4444', SLOW)
    await expect(saved).toContainText(
      new RegExp(
        String.raw`Автопродление выключено: списаний не\sбудет\. Тариф действует до\s${DATE}\.`,
      ),
    )
    await expect(saved).not.toContainText('спишем')

    await page
      .getByRole('navigation', { name: 'Разделы настроек' })
      .getByRole('link', { name: 'Тарифы' })
      .click()
    await expect(row(page, 'Способ оплаты')).toHaveText('Карта «Мир» •• 4444', SLOW)
    await expect(row(page, 'Действует до')).toHaveText(new RegExp(`^${DATE}$`))
    await expect(page.getByText('Следующее списание')).toHaveCount(0)
    await expect(page.getByRole('heading', { level: 2, name: 'Автопродление' })).toHaveCount(0)
  })
})

test('a customer who has paid for nothing sees an empty history and the way to the tariffs', async ({
  page,
  signedInUser: _signedIn,
}) => {
  await page.goto('/settings/billing')
  await expect(page.getByRole('heading', { level: 1, name: 'Оплата' })).toBeVisible(SLOW)

  const saved = method(page)
  await expect(saved).toBeVisible(SLOW)
  await expect(saved).toContainText('Способ оплаты не сохранён.')
  await expect(saved).toContainText('Он сохраняется, когда вы оплачиваете тариф с автопродлением.')
  await expect(saved.getByRole('button')).toHaveCount(0)

  const empty = section(page, 'Платежей пока нет')
  await expect(empty).toContainText('Здесь появятся платежи за тариф и пакеты кредитов.')
  await expect(page.getByRole('table')).toHaveCount(0)
  // No horizontal scrolling on a phone, once the sidebar has folded into its rail.
  await page.setViewportSize({ width: 390, height: 800 })
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390)

  await empty.getByRole('link', { name: 'Выбрать тариф' }).click()

  await expect(page).toHaveURL('/settings/plans')
  await expect(page.getByRole('heading', { level: 2, name: 'Выберите тариф' })).toBeVisible(SLOW)

  // A binding that never was: the return page says so and asks nothing of the shop.
  await page.goto(bindingReturn)
  await expect(
    page.getByRole('heading', { level: 2, name: 'Привязка карты не найдена' }),
  ).toBeVisible(SLOW)
  await expect(page.getByRole('link', { name: 'В раздел «Оплата»' })).toHaveAttribute(
    'href',
    '/settings/billing',
  )
})
