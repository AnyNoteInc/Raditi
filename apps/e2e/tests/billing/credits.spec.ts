import { randomUUID } from 'node:crypto'

import type { Locator, Page } from '@playwright/test'

import { fakeYookassa } from '../../fixtures/billing-stand.ts'
import {
  credits,
  creditsRow,
  giftCredits,
  leftHeadline,
  leftHeadlineOf,
  plural,
  said,
  saidWhole,
  totalLeft,
} from '../../fixtures/credit-words.ts'
import { expect, test, type Credits } from '../../fixtures/credits.ts'
import { addSiteInWizard, type SiteFiles } from '../../fixtures/site-files.ts'

// The credits model on «Тарифы» and «Использование», from the registration to the limits, in a
// real browser: a new user reads the gift as promised, gets it with the first site and spends
// it on tasks without a tariff; a gift that is used up leaves one way, a tariff; the credits of
// a tariff run out — «Лимиты закончились» — and «Купить пакет» is the way out; a task takes the
// gift before the pack, and a pack waits for a tariff that has ended; a chat without a project is
// charged like any task and «Использование» names it «Без проекта». No tariff limits its credits
// of a day since 06.11.2026 (docs/plan/63-new-pricing.md, Ц6): the tasks that use up a tariff are
// queued today, one after another.
//
// Every number a page is expected to show is read from the database first: the sentences are
// written here, in the words of the credits design, and filled with what the accounts hold.
// Tasks are what nothing of the product queues yet (P12): the fixture sets credits aside and
// charges a task with the functions the queue will call (fixtures/credits.ts), from the cost of
// its model calls — the examples of the design: 22.09 RUB is a small edit, 101.37 a block.

// Each step opens a page the development server compiles on first use.
test.describe.configure({ timeout: 240_000 })
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

// ─── The sentences of the pages, as the credits design writes them ────────────

const MOSCOW_DAY = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  timeZone: 'Europe/Moscow',
})
/** «18 октября»: the Moscow calendar day of an instant. */
const day = (instant: Date) => MOSCOW_DAY.format(instant)

/** «Использование» without a tariff, while a task would be taken on gift credits. */
const usageOnGift = (gift: number) =>
  `У вас ${giftCredits(gift)}. ${plural(gift, 'Он не сгорает', 'Они не сгорают', 'Они не сгорают')}, а задачи принимаются, пока кредиты не закончатся. Здесь видно, сколько кредитов осталось и на что они ушли.`
/** Said of the day of a tariff without a daily limit — every tariff on sale since 06.11.2026. */
const NO_DAILY_LIMIT = 'Дневного лимита на вашем тарифе нет.'
/** Nothing is left of the gift, and there is no tariff (A2). */
const giftUsedUp = 'Подарочные кредиты закончились. Чтобы ставить новые задачи, выберите тариф.'
/** Nothing is left on a tariff that renews (A7), with the pack on sale. */
const limitsRanOut = (nextGrant: Date) =>
  `Лимиты закончились: кредиты по тарифу и из пакета израсходованы. ${day(nextGrant)} начислим 200 кредитов по тарифу «Старт». Чтобы продолжить сейчас, купите пакет — 100 кредитов за 1 490 ₽. Кредиты из пакета не сгорают.`
/** The tariff ended and credits of a pack carry the tasks on, as the gift does (A13). */
const packWaits = (pack: number) =>
  `У вас ${credits(pack)} из пакета. Они не сгорают, а задачи принимаются, пока кредиты не закончатся.`

// ─── The pages ────────────────────────────────────────────────────────────────

const section = (page: Page, name: string) => page.getByRole('region', { name })
const tariffBlock = (page: Page, name: string) =>
  page.locator('section', { has: page.getByRole('heading', { level: 2, name: `Тариф «${name}»` }) })
/** The value beside a label in the block of the customer's tariff. */
const row = (page: Page, label: string) =>
  page
    .locator('dt', { hasText: label })
    .locator('xpath=following-sibling::dd[1]/descendant-or-self::*[not(self::a) and not(*)][1]')
/** The lines of «История списаний», newest first, each as its cells read. */
const historyLines = (page: Page) =>
  section(page, 'История списаний').getByRole('table').locator('tbody tr')

/** The line under the heading of «Тарифы»: what the customer has and what to do about it. */
const plansLead = (page: Page) =>
  page
    .getByRole('heading', { level: 1, name: 'Тарифы', exact: true })
    .locator('xpath=following-sibling::*[1]')

const fakePage = `http://127.0.0.1:${fakeYookassa.port}/pay/**`

/**
 * Adds the first site of the customer through the wizard «Добавить проект», as they would: it
 * makes the workspace. The page of the new site then says that the site is being set up.
 */
async function addFirstSite(page: Page, files: SiteFiles, name: string) {
  await addSiteInWizard(page, files, { name, url: `https://gift-${randomUUID()}.example.ru` })
}

/** Chooses «Старт» on «Тарифы» and pays for it on the page of the fake. */
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

/** Pays for the pack in the dialog that is open and comes back to the page of the order. */
async function payForPack(page: Page, dialog: Locator) {
  await expect(dialog).toContainText('1 490 ₽')
  await dialog.getByRole('button', { name: 'Перейти к оплате' }).click()
  await page.waitForURL(fakePage, SLOW)
  await page.getByRole('button', { name: 'Оплатить' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Оплата прошла' })).toBeVisible(SLOW)
  await expect(page.getByRole('main').getByRole('status')).toContainText('Добавили 100 кредитов.')
}

/**
 * A large task in the strong mode, queued now; `costRub` is what its work came to, 6.00 RUB a
 * credit.
 */
const large = async (queue: Credits, title: string, costRub: string) => {
  const task = await queue.task({ title, modelClass: 'heavy' })
  return { reserved: task.reserved, charged: await task.done(costRub), id: task.id }
}

test('a new user gets the gift with the first site and spends it on tasks without a tariff', async ({
  page,
  signedInUser,
  credits: queue,
  siteFiles,
}) => {
  const noTariff = section(page, 'Тариф не выбран')
  const giftKey = `user:${signedInUser.id}:signup-gift`

  await test.step('registered, no site yet: the gift is promised, and nothing is stored', async () => {
    await page.goto('/settings/usage')
    await expect(noTariff).toContainText(said(usageOnGift(50)), SLOW)
    expect(await queue.workspaceId()).toBeNull()
    expect(await queue.journal()).toEqual([])
    await page.goto('/settings/plans')
    await expect(
      page.getByText(
        said(
          'У вас 50 подарочных кредитов — их хватит на десять небольших правок или на три-пять задач побольше.',
        ),
      ),
    ).toBeVisible(SLOW)
  })

  await test.step('the first site makes the workspace, and the gift is granted with it, once', async () => {
    await addFirstSite(page, siteFiles, 'Кофейня')

    expect(await queue.stored()).toEqual({
      tariff: { balance: 0, held: 0, left: 0 },
      gift: { balance: 50, held: 0, left: 50 },
      pack: { balance: 0, held: 0, left: 0 },
    })
    expect(await queue.journal()).toEqual([
      { account: 'gift', kind: 'grant', amount: 50, key: giftKey, orderId: null, taskId: null },
    ])
    // The promise is kept to the credit: the pages say what they said, now of the account.
    const { gift } = await queue.stored()
    await page.goto('/settings/usage')
    await expect(noTariff).toContainText(said(usageOnGift(gift.left)), SLOW)
    await expect(noTariff.getByRole('link', { name: 'Выбрать тариф' })).toHaveAttribute(
      'href',
      '/settings/plans',
    )
  })

  // Only credits bound a task (КР5–КР8): one credit starts it and is its reserve, and a pass is
  // charged its work rounded up, with no minimum and no cap of the reserve.
  await test.step('a small edit is done on gift credits: what its work took, rounded up', async () => {
    const edit = await queue.task({ title: 'Поменять телефон в шапке' })
    // Nothing but the gift can be set aside without a tariff: one credit of it.
    expect(edit.reserved).toEqual({ tariff: 0, gift: 1, pack: 0 })
    // 22.09 RUB of work is 3.68 credits: 4.
    const charged = await edit.done('22.09')
    expect(charged.credits).toBe(4)

    const { gift } = await queue.stored()
    expect(gift).toEqual({ balance: 46, held: 0, left: 46 })
    await page.goto('/settings/usage')
    await expect(noTariff).toContainText(said(usageOnGift(gift.left)), SLOW)
    // Without a tariff the history is whole: its dates name their year.
    await expect(historyLines(page)).toHaveText([
      said(`${new Date().getFullYear()}Поменять телефон в шапкеКофейня${credits(4)}`),
    ])
    await page.goto('/settings/plans')
    await expect(
      page.getByText(said(`У вас ${giftCredits(gift.left)} — их хватит на`)),
    ).toBeVisible(SLOW)
  })

  await test.step('a task in work sets one credit aside: the rest of the gift takes the next one', async () => {
    const block = await queue.task({ title: 'Добавить блок с отзывами' })
    const { gift } = await queue.stored()
    expect(gift).toEqual({ balance: 46, held: 1, left: 45 })
    expect(block.reserved.gift).toBe(gift.held)

    await page.goto('/settings/usage')
    await expect(noTariff).toContainText(said(usageOnGift(gift.left)), SLOW)
    const inWork = historyLines(page).first()
    await expect(inWork).toContainText('В работе')
    await expect(inWork).toContainText(said('Отложено до 1 кредита — спишем по факту'))

    // The block is done: 101.37 RUB of work is 16.9 credits, 17 — far above its reserve.
    expect((await block.done('101.37')).credits).toBe(17)
    expect((await queue.stored()).gift).toEqual({ balance: 29, held: 0, left: 29 })
  })

  await test.step('a task that costs more than is left: the rest is owed, and both pages lead to the tariffs', async () => {
    const prices = await queue.task({ title: 'Обновить цены в каталоге' })
    // 210 RUB of work is 35 credits: the 29 of the gift pay, 6 are owed.
    const charged = await prices.done('210.00')
    expect(charged.credits).toBe(35)
    expect(charged.from).toEqual({ tariff: 0, gift: 29, pack: 0 })
    expect(charged.debt).toBe(6)
    expect((await queue.stored()).gift).toEqual({ balance: 0, held: 0, left: 0 })
    expect(await queue.debt()).toBe(6)

    await page.goto('/settings/usage')
    await expect(noTariff).toContainText(said(giftUsedUp), SLOW)
    await expect(noTariff.getByRole('link', { name: 'Выбрать тариф' })).toBeVisible()
    // The three tasks, newest first, each with what the accounts paid of it.
    await expect(historyLines(page)).toHaveText([
      said(`Обновить цены в каталогеКофейня${credits(29)}`),
      said(`Добавить блок с отзывамиКофейня${credits(17)}`),
      said(`Поменять телефон в шапкеКофейня${credits(4)}`),
    ])
    await page.goto('/settings/plans')
    await expect(plansLead(page)).toHaveText(saidWhole(giftUsedUp), SLOW)
    // What the journal holds is what the pages counted: one grant, three charges of the gift.
    expect(
      (await queue.journal()).map(({ account, kind, amount }) => [account, kind, amount]),
    ).toEqual([
      ['gift', 'grant', 50],
      ['gift', 'charge', -4],
      ['gift', 'charge', -17],
      ['gift', 'charge', -29],
    ])
  })

  await test.step('the customer chooses a tariff: its credits pay the debt first', async () => {
    await payForStart(page, { autoRenew: false })
    const stored = await queue.stored()
    expect(stored.tariff.left).toBe(194)
    expect(stored.gift.left).toBe(0)
    expect(await queue.debt()).toBe(0)
    // The debt is paid by a charge of the tariff account, linked to the order and to no task.
    const repaid = (await queue.journal()).filter(({ key }) => key.endsWith(':debt'))
    expect(
      repaid.map(({ account, kind, amount, taskId }) => [account, kind, amount, taskId]),
    ).toEqual([['tariff', 'charge', -6, null]])

    await page.getByRole('link', { name: 'К тарифам' }).click()
    await expect(row(page, 'Кредиты')).toHaveText(saidWhole(creditsRow(stored)), SLOW)
    await page.goto('/settings/usage')
    const creditsSection = section(page, 'Кредиты')
    await expect(leftHeadlineOf(creditsSection)).toHaveText(leftHeadline(totalLeft(stored)), SLOW)
    // A task would be taken: nothing stands in its way, and nothing is said.
    await expect(creditsSection.getByRole('status')).toHaveCount(0)
    // The day counts tariff credits only — the work of today was paid by the gift —, and the
    // tariff has no daily limit.
    const limits = section(page, 'Лимиты тарифа')
    await expect(limits).toContainText(/Сегодня\s*0\s+кредитов/)
    await expect(limits).toContainText(said(NO_DAILY_LIMIT))
    await expect(limits).not.toContainText('Сегодня можно потратить')
  })
})

test('a chat without a project is charged, and «Использование» names it «Без проекта»', async ({
  page,
  credits: queue,
}) => {
  const titles = { gift: 'Идеи для названия пекарни', tariff: 'Письмо постоянным гостям' }

  await test.step('no project, no tariff: the gift pays, and the history says whose work it was', async () => {
    const chat = await queue.task({ title: titles.gift, withProject: false })
    expect(chat.reserved).toEqual({ tariff: 0, gift: 1, pack: 0 })
    const { credits: charged } = await chat.done('22.09')
    expect(charged).toBe(4)

    await page.goto('/settings/usage')
    await expect(historyLines(page)).toHaveText(
      [said(`${titles.gift}Без проекта${credits(charged)}`)],
      SLOW,
    )
  })

  await test.step('on a tariff: «По проектам» has a line for it and the history a row', async () => {
    await payForStart(page, { autoRenew: false })
    const chat = await queue.task({ title: titles.tariff, withProject: false })
    const { credits: charged } = await chat.done('60.00')
    expect(charged).toBe(10)

    await page.goto('/settings/usage')
    await expect(section(page, 'По проектам').getByRole('listitem')).toHaveText(
      [said(`Без проекта${credits(charged)}`)],
      SLOW,
    )
    await expect(historyLines(page).first()).toHaveText(
      said(`${titles.tariff}Без проекта${credits(charged)}`),
    )
  })
})

test('the gift is used up without a tariff: both pages say so and lead to the tariffs', async ({
  page,
  signedInUser: _signedIn,
  credits: queue,
  siteFiles,
}) => {
  const noTariff = section(page, 'Тариф не выбран')

  await test.step('one large task takes the whole gift', async () => {
    await addFirstSite(page, siteFiles, 'Кофейня')
    // One credit is set aside, whatever the mode.
    const landing = await queue.task({ title: 'Собрать страницу', modelClass: 'heavy' })
    expect(landing.reserved).toEqual({ tariff: 0, gift: 1, pack: 0 })
    // 300 RUB of work is 50 credits: all there is.
    const charged = await landing.done('300.00')
    expect(charged.credits).toBe(50)
    expect(charged.from).toEqual({ tariff: 0, gift: 50, pack: 0 })
    expect(await queue.stored()).toEqual({
      tariff: { balance: 0, held: 0, left: 0 },
      gift: { balance: 0, held: 0, left: 0 },
      pack: { balance: 0, held: 0, left: 0 },
    })
  })

  await test.step('«Использование» says that the gift is used up, with the way to the tariffs', async () => {
    await page.goto('/settings/usage')
    // The block says this and nothing else: no gift is counted as on hand or promised again.
    await expect(noTariff).toHaveText(saidWhole(`Тариф не выбран${giftUsedUp}Выбрать тариф`), SLOW)
    await expect(noTariff.getByRole('link', { name: 'Выбрать тариф' })).toHaveAttribute(
      'href',
      '/settings/plans',
    )
    await expect(historyLines(page)).toHaveText([said(`Собрать страницуКофейня${credits(50)}`)])
  })

  await test.step('«Тарифы» says the same above the tariffs, and offers the pack at twice its price', async () => {
    await page.goto('/settings/plans')
    await expect(plansLead(page)).toHaveText(saidWhole(giftUsedUp), SLOW)
    await expect(page.getByRole('heading', { level: 2, name: 'Выберите тариф' })).toBeVisible()
    // A pack is sold without a tariff too, at twice its price (КР9).
    await expect(page.getByRole('button', { name: 'Купить пакет' })).toBeVisible()
    await expect(page.getByText(said('Пакет из 100 кредитов — 2 980 ₽'))).toBeVisible()
    // The gift was granted once and spent once: it is not granted anew for the asking.
    expect(
      (await queue.journal()).map(({ account, kind, amount }) => [account, kind, amount]),
    ).toEqual([
      ['gift', 'grant', 50],
      ['gift', 'charge', -50],
    ])
  })
})

test('the credits of a tariff run out: «Лимиты закончились», and «Купить пакет» is the way out', async ({
  page,
  signedInUser: _signedIn,
  credits: queue,
}) => {
  const creditsSection = section(page, 'Кредиты')
  const notice = creditsSection.getByRole('status')

  await test.step('the customer pays for «Старт» with auto-renewal and has a site', async () => {
    await payForStart(page, { autoRenew: true })
    await queue.site('Кофейня')
    const stored = await queue.stored()
    expect([stored.tariff.left, stored.gift.left, stored.pack.left]).toEqual([200, 50, 0])
  })

  // No daily limit (Ц6): two large tasks of today use up the 200 of «Старт» and the 50 of the
  // gift. Each sets aside one credit of the tariff; the first takes 120, the next the 80 left of
  // the tariff and the gift.
  await test.step('two large tasks use up the tariff and the gift', async () => {
    const first = await large(queue, 'Собрать страницу «О нас»', '720.00')
    expect(first.reserved).toEqual({ tariff: 1, gift: 0, pack: 0 })
    expect(first.charged.from).toEqual({ tariff: 120, gift: 0, pack: 0 })
    const next = await large(queue, 'Добавить форму заявки', '780.00')
    expect(next.reserved).toEqual({ tariff: 1, gift: 0, pack: 0 })
    expect(next.charged.from).toEqual({ tariff: 80, gift: 50, pack: 0 })
    expect(await queue.stored()).toEqual({
      tariff: { balance: 0, held: 0, left: 0 },
      gift: { balance: 0, held: 0, left: 0 },
      pack: { balance: 0, held: 0, left: 0 },
    })
  })

  const { currentPeriodEnd } = await queue.subscription()

  await test.step('«Использование» says that the limits ran out, when credits come and what to do', async () => {
    await page.goto('/settings/usage')
    await expect(notice).toHaveText(saidWhole(limitsRanOut(currentPeriodEnd)), SLOW)
    await expect(creditsSection.getByRole('button', { name: 'Купить пакет' })).toBeVisible()
    await expect(creditsSection.getByRole('link', { name: 'Сменить тариф' })).toHaveAttribute(
      'href',
      '/settings/plans',
    )
    await expect(creditsSection).toContainText(
      said('Новый тариф начнёт действовать со следующего периода.'),
    )
    // The offer of the pack stands in the notice, not twice.
    await expect(page.getByRole('button', { name: /^Купить ещё/ })).toHaveCount(0)
    await expect(leftHeadlineOf(creditsSection)).toHaveText(leftHeadline(0))
    await expect(
      creditsSection.getByRole('img', {
        name: 'Из 200 кредитов по тарифу: 200 списано, 0 отложено под задачи в работе, 0 осталось',
      }),
    ).toBeVisible()
    // A gift that is used up is not shown as an account with nothing on it.
    await expect(creditsSection.getByRole('heading', { level: 3 })).toHaveText([
      /^По тарифу\s—\s0\sиз\s200$/,
      /^Из пакета\s—\s0$/,
    ])
    // The day: today took all 200 of the tariff, and no daily limit stands beside them.
    const limits = section(page, 'Лимиты тарифа')
    await expect(limits).toContainText(/Сегодня\s*200\s+кредитов/)
    await expect(limits).toContainText(said(NO_DAILY_LIMIT))
    await expect(limits).not.toContainText('Сегодня можно потратить')
    await expect(limits.getByRole('img', { name: /^Сегодня/ })).toHaveCount(0)
    // All 250 credits went to the one site; the last task took them from two accounts.
    await expect(section(page, 'По проектам').getByRole('listitem')).toHaveText([
      said(`Кофейня250 кредитов`),
    ])
    await expect(historyLines(page)).toHaveText([
      said(`Добавить форму заявкиКофейня${credits(130)}80 по тарифу и 50 подарочных`),
      said(`Собрать страницу «О нас»Кофейня${credits(120)}`),
    ])
  })

  await test.step('«Тарифы» says the same in the block of the tariff, above the pack and the tariffs', async () => {
    await page.goto('/settings/plans')
    const block = tariffBlock(page, 'Старт')
    await expect(block.getByRole('status')).toHaveText(
      saidWhole(limitsRanOut(currentPeriodEnd)),
      SLOW,
    )
    await expect(block).toContainText(said('Новый тариф начнёт действовать со следующего периода.'))
    await expect(row(page, 'Кредиты')).toHaveText('Закончились')
    // The way out the notice names is on the page: the pack.
    await expect(page.getByRole('button', { name: 'Купить пакет' })).toBeVisible()
  })

  await test.step('«Купить пакет» of the notice leads to the payment, and the pack is added', async () => {
    await page.goto('/settings/usage')
    await creditsSection.getByRole('button', { name: 'Купить пакет' }).click(SLOW)
    await payForPack(page, page.getByRole('dialog', { name: 'Пакет из 100 кредитов' }))
    await fake('settle', {})
    const stored = await queue.stored()
    expect(stored.pack).toEqual({ balance: 100, held: 0, left: 100 })

    await page.goto('/settings/usage')
    await expect(leftHeadlineOf(creditsSection)).toHaveText(leftHeadline(totalLeft(stored)), SLOW)
    // Nothing stands in the way of a task any more.
    await expect(notice).toHaveCount(0)
    await expect(creditsSection.getByRole('heading', { level: 3 })).toHaveText([
      /^По тарифу\s—\s0\sиз\s200$/,
      /^Из пакета\s—\s100$/,
    ])
    await expect(creditsSection).toContainText(
      said('Кредиты из пакета не сгорают. Сейчас задачи тратят их: кредиты по тарифу закончились.'),
    )
    await expect(
      page.getByRole('button', { name: 'Купить ещё 100 кредитов — 1 490 ₽' }),
    ).toBeVisible()
    await page.goto('/settings/plans')
    await expect(tariffBlock(page, 'Старт').getByRole('status')).toHaveCount(0)
    await expect(row(page, 'Кредиты')).toHaveText(saidWhole(creditsRow(stored)), SLOW)
  })

  await test.step('the next task is paid for from the pack', async () => {
    const banner = await queue.task({ title: 'Добавить баннер акции' })
    expect(banner.reserved).toEqual({ tariff: 0, gift: 0, pack: 1 })
    expect((await banner.done('101.37')).from).toEqual({ tariff: 0, gift: 0, pack: 17 })
    const stored = await queue.stored()
    expect(stored.pack).toEqual({ balance: 83, held: 0, left: 83 })

    await page.goto('/settings/usage')
    await expect(leftHeadlineOf(creditsSection)).toHaveText(leftHeadline(totalLeft(stored)), SLOW)
    await expect(historyLines(page).first()).toHaveText(
      said(`Добавить баннер акцииКофейня${credits(17)}`),
    )
    // Work paid by the pack is not work of the tariff: today's 200 stay as they were.
    await expect(section(page, 'Лимиты тарифа')).toContainText(/Сегодня\s*200\s+кредитов/)
  })
})

test('a task takes the gift before the pack, and a pack carries tasks after the tariff ended', async ({
  page,
  signedInUser: _signedIn,
  credits: queue,
}) => {
  const creditsSection = section(page, 'Кредиты')

  await test.step('the customer has all three accounts: a tariff, the gift and a pack', async () => {
    await payForStart(page, { autoRenew: false })
    await page.getByRole('link', { name: 'К тарифам' }).click()
    await page.getByRole('button', { name: 'Купить пакет' }).click(SLOW)
    await payForPack(page, page.getByRole('dialog', { name: 'Пакет из 100 кредитов' }))
    await fake('settle', {})
    await queue.site('Кофейня')
    const stored = await queue.stored()
    expect([stored.tariff.left, stored.gift.left, stored.pack.left]).toEqual([200, 50, 100])
    // The fixture ends a tariff by its row alone: with credits on the tariff account it would
    // leave what the product never does, and it refuses.
    await expect(queue.tariffEnded()).rejects.toThrow(/does not expire a remainder/)
    expect((await queue.subscription()).status).toBe('active')
  })

  await test.step('a large task sets aside one credit of the tariff, and the tariff pays it', async () => {
    const about = await large(queue, 'Собрать страницу «О нас»', '900.00')
    expect(about.reserved).toEqual({ tariff: 1, gift: 0, pack: 0 })
    expect(about.charged.from).toEqual({ tariff: 150, gift: 0, pack: 0 })
    const stored = await queue.stored()
    expect([stored.tariff.left, stored.gift.left, stored.pack.left]).toEqual([50, 50, 100])
  })

  await test.step('a task that reaches past the tariff is paid by the gift, not by the pack', async () => {
    // The reserve of the next task is one credit of the tariff. Its work comes to 80 credits:
    // the 50 of the tariff, then the gift; the pack pays none.
    const catalogue = await queue.task({ title: 'Переделать каталог', modelClass: 'heavy' })
    expect(catalogue.reserved).toEqual({ tariff: 1, gift: 0, pack: 0 })
    const charged = await catalogue.done('480.00')
    expect(charged.credits).toBe(80)
    expect(charged.from).toEqual({ tariff: 50, gift: 30, pack: 0 })

    const stored = await queue.stored()
    expect(stored).toEqual({
      tariff: { balance: 0, held: 0, left: 0 },
      gift: { balance: 20, held: 0, left: 20 },
      pack: { balance: 100, held: 0, left: 100 },
    })
    expect(
      (await queue.journal())
        .filter(({ taskId }) => taskId === catalogue.id)
        .map(({ account, kind, amount }) => [account, kind, amount]),
    ).toEqual([
      ['tariff', 'charge', -50],
      ['gift', 'charge', -30],
    ])

    await page.goto('/settings/plans')
    await expect(row(page, 'Кредиты')).toHaveText(saidWhole(creditsRow(stored)), SLOW)
    await page.goto('/settings/usage')
    await expect(leftHeadlineOf(creditsSection)).toHaveText(leftHeadline(totalLeft(stored)), SLOW)
    // The accounts stand in the order their credits are spent in.
    await expect(creditsSection.getByRole('heading', { level: 3 })).toHaveText([
      /^По тарифу\s—\s0\sиз\s200$/,
      /^Подарочные\s—\s20$/,
      /^Из пакета\s—\s100$/,
    ])
    await expect(creditsSection).toContainText(
      said('Кредиты из пакета не сгорают. Начнут тратиться, когда закончатся подарочные кредиты.'),
    )
    await expect(historyLines(page).first()).toHaveText(
      said(`Переделать каталогКофейня${credits(80)}50 по тарифу и 30 подарочных`),
    )
    // No daily limit: the month is spent, weeks before the period ends, and nothing is
    // promised of tomorrow.
    const limits = section(page, 'Лимиты тарифа')
    await expect(limits).toContainText(said(NO_DAILY_LIMIT))
    await expect(limits).not.toContainText('завтра')
  })

  await test.step('the next task takes what is left of the gift first', async () => {
    const banner = await queue.task({ title: 'Добавить баннер акции' })
    expect(banner.reserved).toEqual({ tariff: 0, gift: 1, pack: 0 })
    expect((await banner.done('120.00')).from).toEqual({ tariff: 0, gift: 20, pack: 0 })
    const stored = await queue.stored()
    expect([stored.gift.left, stored.pack.left]).toEqual([0, 100])
  })

  await test.step('the tariff ends: the pack is kept and carries the tasks on', async () => {
    await queue.tariffEnded()
    const { pack } = await queue.stored()

    await page.goto('/settings/usage')
    const noTariff = section(page, 'Тариф не выбран')
    await expect(noTariff).toContainText(said(packWaits(pack.left)), SLOW)
    await expect(noTariff.getByRole('link', { name: 'Выбрать тариф' })).toHaveAttribute(
      'href',
      '/settings/plans',
    )
    // No credits are measured without a tariff, and the history is whole: the only meter is that
    // of the week of the work, which a workspace has without a tariff too (plan 71; no window of
    // 5 hours since weekly_limits_only).
    await expect(page.getByRole('main').getByRole('img')).toHaveCount(1)
    await expect(section(page, 'Лимиты').getByRole('img')).toHaveCount(1)
    await expect(historyLines(page)).toHaveCount(3)

    await page.goto('/settings/plans')
    const block = tariffBlock(page, 'Старт')
    await expect(block).toContainText(
      said(
        `Новые задачи принимаются, только пока есть подарочные кредиты или кредиты из пакета. ${credits(pack.left)} из пакета, сайты и история правок на месте.`,
      ),
      SLOW,
    )
    await expect(plansLead(page)).toHaveText(
      saidWhole(
        `У вас ${credits(pack.left)} из пакета. Когда кредиты закончатся, понадобится тариф.`,
      ),
    )
    // A pack is sold without a tariff too, at twice its price (КР9).
    await expect(page.getByRole('button', { name: 'Купить пакет' })).toBeVisible()
    await expect(page.getByText(said('Пакет из 100 кредитов — 2 980 ₽'))).toBeVisible()
  })
})
