import type { Page } from '@playwright/test'

import { fakeYookassa } from '../../fixtures/billing-stand.ts'
import { leftHeadline, leftHeadlineOf, totalLeft } from '../../fixtures/credit-words.ts'
import { expect, test } from '../../fixtures/credits.ts'

// «Настройки → Использование» in a real browser: a signed-in customer pays for a tariff on the page
// of the fake ЮKassa, sees its quota untouched and an empty history, and reads on «Тарифы» how
// credits are counted. The fixture removes the user with everything the payment created, and
// keeps a credit rate in force for the run: without one the pages would say only that no task is
// taken.

// Each step opens a page the development server compiles on first use.
test.describe.configure({ timeout: 180_000 })
const SLOW = { timeout: 60_000 }

/** A command of the fake ЮKassa (infra/dev/billing-verify/README.md, «Команды стенда»). */
async function fake(command: string, body: object): Promise<void> {
  const response = await fetch(`${fakeYookassa.controlUrl}/${command}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`The fake ЮKassa refused «${command}»: ${response.status}`)
}

test.beforeEach(async () => {
  // Payments and withheld notifications of the previous test are gone.
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

/** Chooses the tariff on «Тарифы», pays for it on the page of the fake and waits for the order. */
async function payFor(page: Page, plan: string) {
  await page.goto('/settings/plans')
  await expect(page.getByRole('heading', { level: 2, name: 'Выберите тариф' })).toBeVisible(SLOW)
  await page
    .getByRole('list', { name: 'Тарифы' })
    .getByRole('button', { name: `Выбрать «${plan}»` })
    .click()
  await page
    .getByRole('dialog', { name: `Тариф «${plan}»` })
    .getByRole('button', { name: 'Перейти к оплате' })
    .click()
  await page.waitForURL(`http://127.0.0.1:${fakeYookassa.port}/pay/**`, SLOW)
  await page.getByRole('button', { name: 'Оплатить' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Оплата прошла' })).toBeVisible(SLOW)
}

test('a customer who paid for a tariff sees its full quota and an empty history', async ({
  page,
  // Asking for the user is what signs the page in.
  signedInUser: _signedIn,
  credits: stored,
}) => {
  const sidebar = page.getByRole('navigation', { name: 'Разделы настроек' })

  await test.step('without a tariff the page leads to the tariffs', async () => {
    await page.goto('/settings/usage')
    await expect(page.getByRole('heading', { level: 1, name: 'Использование' })).toBeVisible(SLOW)
    await expect(page).toHaveTitle(/^Использование/)
    await expect(sidebar.getByRole('link', { name: 'Использование' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(page.getByRole('navigation', { name: 'Хлебные крошки' })).toHaveText(
      /^Настройки\s*\/\s*Использование$/,
    )
    const state = section(page, 'Тариф не выбран')
    await expect(state).toBeVisible(SLOW)
    // A new user has no workspace yet: the gift of the registration is shown as promised.
    await expect(state).toContainText(
      'У вас 50 подарочных кредитов. Они не сгорают, а задачи принимаются, пока кредиты не закончатся. Здесь видно, сколько кредитов осталось и на что они ушли.',
    )
    await expect(state).not.toContainText('Кредиты входят в тариф')
    await expect(state.getByRole('link', { name: 'Выбрать тариф' })).toHaveAttribute(
      'href',
      '/settings/plans',
    )
    // Nothing is measured without a tariff.
    await expect(page.getByRole('main').getByRole('img')).toHaveCount(0)
    // The history is shown without a tariff as well: it has no period then, and nothing yet.
    await expect(section(page, 'История списаний')).toContainText(
      /Списаний пока нет\. Здесь появятся задачи и\sсколько кредитов ушло на\sкаждую\./,
    )
    // No table of charges; the chart of the days has its own table for screen readers.
    await expect(
      page.getByRole('table').filter({ hasNot: page.getByText('Расход кредитов по дням') }),
    ).toHaveCount(0)
  })

  await test.step('the customer pays for «Бизнес»', async () => {
    await payFor(page, 'Бизнес')
  })

  await test.step('«Тарифы» explains how credits are counted, collapsed under the tariffs', async () => {
    await page.getByRole('link', { name: 'К тарифам' }).click()
    await expect(page).toHaveURL('/settings/plans')
    const explainer = page.locator('details', { hasText: 'Как считаются кредиты' }).first()
    const definition = explainer.getByText(
      /Кредит\s—\sэто единица, в\sкоторой мы считаем работу Радити/,
    )
    await expect(definition).toBeHidden()
    await explainer.getByText('Как считаются кредиты').click()
    await expect(definition).toBeVisible()
    await expect(explainer).toContainText(/небольшая задача обычно стоит 5\sкредитов/)
    // Only credits bound a task (КР5–КР8): one credit starts it, every pass pays its work.
    await expect(explainer).toContainText(
      /Кредиты\sсписываются\sпосле\sкаждого\sответа\sагента\s—\sровно\sстолько,\sсколько\sушло\sна\sработу,\sс\sокруглением\sвверх\sдо\sцелого\sкредита\./,
    )
    await expect(explainer).toContainText(
      /Задача\sначинается,\sесли\sу\sвас\sесть\sхотя\sбы\sодин\sкредит\./,
    )
    await expect(explainer).not.toContainText('не меньше 5')
    // The rule of the charge stands once, above the block (Ц14).
    await expect(page.getByRole('main')).toContainText(
      /Списываем\sтолько\sза\sвыполненную\sработу:\sпопытка,\sкоторая\sоборвалась\sиз-за\sсбоя,\sничего\sне\sстоит\./,
    )
    // No tariff on sale has a daily limit: the block does not explain one.
    await expect(explainer).not.toContainText('дневной лимит')
    // No model has an approved price in this database: there is no table to print, and the
    // unit of a model's work is named nowhere.
    await expect(explainer.getByText('Точный расчёт')).toHaveCount(0)
    await expect(page.getByRole('main')).not.toContainText(/токен/i)
  })

  await test.step('«Тарифы» leads to the usage from the row of the credits', async () => {
    await page.getByRole('link', { name: 'Подробнее о кредитах' }).click()
    await expect(page).toHaveURL('/settings/usage')
  })

  await test.step('the whole quota is left and nothing is spent', async () => {
    const credits = section(page, 'Кредиты')
    await expect(credits).toBeVisible(SLOW)
    await expect(credits).toContainText(
      new RegExp(String.raw`Тариф «Бизнес»\s·\s${DAY}\s—\s${DATE}`),
    )
    // The quota of the tariff and the gift, which the checkout granted with the workspace: what
    // the accounts hold.
    const accounts = await stored.stored()
    expect([accounts.tariff.left, accounts.gift.left, accounts.pack.left]).toEqual([1000, 50, 0])
    await expect(leftHeadlineOf(credits)).toHaveText(leftHeadline(totalLeft(accounts)))
    await expect(credits.getByRole('heading', { level: 3, name: /^По тарифу/ })).toHaveText(
      /^По тарифу\s—\s1\s000\sиз\s1\s000$/,
    )
    await expect(
      credits.getByRole('img', {
        name: /^Из 1\s000 кредитов по тарифу: 0 списано, 0 отложено под задачи в работе, 1\s000 осталось$/,
      }),
    ).toBeVisible()
    for (const entry of [/^Списано\s—\s0$/, /^Отложено\s—\s0$/, /^Осталось\s—\s1\s000$/]) {
      await expect(credits.getByRole('listitem').filter({ hasText: entry })).toHaveCount(1)
    }
    // The consent to auto-renewal was not given: no new quota is promised.
    await expect(credits).toContainText(
      new RegExp(String.raw`Тариф действует до\s${DAY} и\sне\sпродлится\.`),
    )
    // The three accounts, in the order their credits are spent in.
    await expect(credits.getByRole('heading', { level: 3 })).toHaveText([
      /^По тарифу\s—\s1\s000\sиз\s1\s000$/,
      /^Подарочные\s—\s50$/,
      /^Из пакета\s—\s0$/,
    ])
    await expect(credits).toContainText(
      'Не сгорают. Тратятся после кредитов по тарифу и раньше кредитов из пакета.',
    )
    await expect(credits).toContainText(
      'Кредиты из пакета не сгорают и тратятся последними — после кредитов по тарифу и подарочных.',
    )
    // A new task would be taken: nothing stands in its way, and nothing is said.
    await expect(credits.getByRole('status')).toHaveCount(0)
  })

  await test.step('the limits of the tariff are untouched', async () => {
    const limits = section(page, 'Лимиты тарифа')
    // The day counts tariff credits, and «Бизнес» has no daily limit (Ц6): no meter of a day.
    await expect(limits).toContainText(/Сегодня\s*0\s+кредитов/)
    await expect(limits.getByRole('img', { name: /^Сегодня/ })).toHaveCount(0)
    await expect(limits).toContainText(/Дневного\sлимита\sна\sвашем\sтарифе\sнет\./)
    await expect(limits).not.toContainText('Сегодня можно потратить')
    // No sites of projects since plan 83: the limits name none.
    await expect(limits).not.toContainText('сайт')
  })

  await test.step('more credits are offered: the dialog of the pack opens and closes', async () => {
    const buyMore = page.getByRole('button', { name: 'Купить ещё 100 кредитов — 1 490 ₽' })
    await buyMore.click()
    const dialog = page.getByRole('dialog', { name: 'Пакет из 100 кредитов' })
    await expect(dialog).toContainText('К оплате сегодня')
    await dialog.getByRole('button', { name: 'Отмена' }).click()
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL('/settings/usage')
  })

  await test.step('the numbers are still there after a reload', async () => {
    await page.reload()
    await expect(leftHeadlineOf(section(page, 'Кредиты'))).toHaveText(
      leftHeadline(totalLeft(await stored.stored())),
      SLOW,
    )
  })
})
