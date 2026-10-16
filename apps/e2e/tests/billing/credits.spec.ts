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

// The credits model on «Тарифы» and «Использование», from the registration to the limits, in a
// real browser: a new user reads the gift as promised, gets it with the first site and spends
// it on tasks without a tariff; a gift that is used up leaves one way, a tariff; the credits of
// a tariff run out — «Лимиты закончились» — and «Купить пакет» is the way out; a task takes the
// gift before the pack, and a pack waits for a tariff that has ended.
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
  `У вас ${giftCredits(gift)}. Без тарифа можно поставить до 3 задач в день. Здесь видно, сколько кредитов осталось и на что они ушли.`
/** The gift is set aside for the task in work (A10б of the design). */
const giftSetAside = (held: number) =>
  `Подарочные кредиты заняты задачей в работе: под неё отложено ${held}. Когда она закончится, спишем только то, что ушло на работу, остальное вернётся — и можно будет поставить следующую.`
/** Less of the gift is left than a task needs (A3). */
const giftBelowStart = (gift: number) =>
  `${plural(gift, 'Остался', 'Осталось', 'Осталось')} ${giftCredits(gift)}, а на новую задачу нужно не меньше 5. Выберите тариф — подарочные кредиты сохранятся и прибавятся к кредитам тарифа.`
/** Nothing is left of the gift, and there is no tariff (A2). */
const giftUsedUp = 'Подарочные кредиты закончились. Чтобы ставить новые задачи, выберите тариф.'
/** Nothing is left on a tariff that renews (A7), with the pack on sale. */
const limitsRanOut = (nextGrant: Date) =>
  `Лимиты закончились: кредиты по тарифу и из пакета израсходованы. ${day(nextGrant)} начислим 300 кредитов по тарифу «Старт». Чтобы продолжить сейчас, купите пакет — 100 кредитов за 1 990 ₽. Кредиты из пакета не сгорают.`
/** The tariff ended and credits of a pack wait for the next one (A13). */
const packWaits = (pack: number) =>
  `Тариф закончился. У вас ${credits(pack)} из пакета: они не сгорают и снова будут доступны, когда вы выберете тариф.`

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

/** Adds the first site of the customer in the form of «Проекты»: it makes the workspace. */
async function addFirstSite(page: Page, name: string) {
  await page.goto('/projects')
  await expect(page.getByRole('heading', { level: 1, name: 'Проекты' })).toBeVisible(SLOW)
  await page.getByRole('button', { name: 'Добавить сайт' }).first().click()
  const form = page.getByRole('form', { name: 'Новый проект' })
  await form.getByLabel('Название проекта').fill(name)
  await form.getByLabel('Адрес сайта').fill(`https://gift-${randomUUID()}.example.ru`)
  await form.getByRole('button', { name: 'Создать проект' }).click()
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    `Проект «${name}» добавлен.`,
    SLOW,
  )
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
  await expect(dialog).toContainText('1 990 ₽')
  await dialog.getByRole('button', { name: 'Перейти к оплате' }).click()
  await page.waitForURL(fakePage, SLOW)
  await page.getByRole('button', { name: 'Оплатить' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Оплата прошла' })).toBeVisible(SLOW)
  await expect(page.getByRole('main').getByRole('status')).toContainText('Добавили 100 кредитов.')
}

/** A large task in the strong mode, whose work comes to the whole step: 120 credits. */
const large = async (queue: Credits, title: string) =>
  (await queue.task({ title, modelClass: 'heavy' })).done('720.00')

test('a new user gets the gift with the first site and spends it on tasks without a tariff', async ({
  page,
  signedInUser,
  credits: queue,
}) => {
  const noTariff = section(page, 'Тариф не выбран')
  const giftKey = `user:${signedInUser.id}:signup-gift`

  await test.step('registered, no site yet: the gift is promised, and nothing is stored', async () => {
    await page.goto('/settings/usage')
    await expect(noTariff).toContainText(said(usageOnGift(35)), SLOW)
    expect(await queue.workspaceId()).toBeNull()
    expect(await queue.journal()).toEqual([])
    await page.goto('/settings/plans')
    await expect(
      page.getByText(
        said(
          'У вас 35 подарочных кредитов — их хватит на семь небольших правок или на две-три задачи побольше.',
        ),
      ),
    ).toBeVisible(SLOW)
  })

  await test.step('the first site makes the workspace, and the gift is granted with it, once', async () => {
    await addFirstSite(page, 'Кофейня')

    expect(await queue.stored()).toEqual({
      tariff: { balance: 0, held: 0, left: 0 },
      gift: { balance: 35, held: 0, left: 35 },
      pack: { balance: 0, held: 0, left: 0 },
    })
    expect(await queue.journal()).toEqual([
      { account: 'gift', kind: 'grant', amount: 35, key: giftKey, orderId: null, taskId: null },
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

  await test.step('a small edit is done on gift credits: five of them, the least a task costs', async () => {
    const edit = await queue.task({ title: 'Поменять телефон в шапке' })
    // Nothing but the gift can be set aside without a tariff: the whole of it.
    expect(edit.reserved).toEqual({ tariff: 0, gift: 35, pack: 0 })
    const charged = await edit.done('22.09')
    expect(charged.credits).toBe(5)

    const { gift } = await queue.stored()
    expect(gift).toEqual({ balance: 30, held: 0, left: 30 })
    await page.goto('/settings/usage')
    await expect(noTariff).toContainText(said(usageOnGift(gift.left)), SLOW)
    // Without a tariff the history is whole: its dates name their year.
    await expect(historyLines(page)).toHaveText([
      said(`${new Date().getFullYear()}Поменять телефон в шапкеКофейня${credits(5)}`),
    ])
    await page.goto('/settings/plans')
    await expect(
      page.getByText(said(`У вас ${giftCredits(gift.left)} — их хватит на`)),
    ).toBeVisible(SLOW)
  })

  await test.step('a task in work sets the rest of the gift aside: the next one waits for it', async () => {
    const block = await queue.task({ title: 'Добавить блок с отзывами' })
    const { gift } = await queue.stored()
    expect(gift).toEqual({ balance: 30, held: 30, left: 0 })
    expect(block.reserved.gift).toBe(gift.held)

    await page.goto('/settings/usage')
    await expect(noTariff).toContainText(said(giftSetAside(gift.held)), SLOW)
    const inWork = historyLines(page).first()
    await expect(inWork).toContainText('В работе')
    await expect(inWork).toContainText(said(`Отложено до ${gift.held} кредитов — спишем по факту`))
    await page.goto('/settings/plans')
    await expect(page.getByText(said(giftSetAside(gift.held)))).toBeVisible(SLOW)

    // The block is done: 101.37 RUB of work is 17 credits, and what was set aside above it
    // is back on the account.
    expect((await block.done('101.37')).credits).toBe(17)
    expect((await queue.stored()).gift).toEqual({ balance: 13, held: 0, left: 13 })
  })

  await test.step('less is left than a task needs: both pages say so and lead to the tariffs', async () => {
    const prices = await queue.task({ title: 'Обновить цены в каталоге' })
    expect((await prices.done('60.00')).credits).toBe(10)
    const { gift } = await queue.stored()
    expect(gift).toEqual({ balance: 3, held: 0, left: 3 })

    await page.goto('/settings/usage')
    await expect(noTariff).toContainText(said(giftBelowStart(gift.left)), SLOW)
    await expect(noTariff.getByRole('link', { name: 'Выбрать тариф' })).toBeVisible()
    // The three tasks, newest first, each with what it was charged.
    await expect(historyLines(page)).toHaveText([
      said(`Обновить цены в каталогеКофейня${credits(10)}`),
      said(`Добавить блок с отзывамиКофейня${credits(17)}`),
      said(`Поменять телефон в шапкеКофейня${credits(5)}`),
    ])
    await page.goto('/settings/plans')
    await expect(page.getByText(said(giftBelowStart(gift.left)))).toBeVisible(SLOW)
    // What the journal holds is what the pages counted: one grant, three charges of the gift.
    expect(
      (await queue.journal()).map(({ account, kind, amount }) => [account, kind, amount]),
    ).toEqual([
      ['gift', 'grant', 35],
      ['gift', 'charge', -5],
      ['gift', 'charge', -17],
      ['gift', 'charge', -10],
    ])
  })

  await test.step('the customer chooses a tariff: the gift credits are kept and add to its credits', async () => {
    await payForStart(page, { autoRenew: false })
    const stored = await queue.stored()
    expect(stored.tariff.left).toBe(300)
    expect(stored.gift.left).toBe(3)

    await page.getByRole('link', { name: 'К тарифам' }).click()
    await expect(row(page, 'Кредиты')).toHaveText(saidWhole(creditsRow(stored)), SLOW)
    await page.goto('/settings/usage')
    const creditsSection = section(page, 'Кредиты')
    await expect(leftHeadlineOf(creditsSection)).toHaveText(leftHeadline(totalLeft(stored)), SLOW)
    // A task would be taken: nothing stands in its way, and nothing is said.
    await expect(creditsSection.getByRole('status')).toHaveCount(0)
    // The day counts tasks taken into work, whatever paid for them: the three of today.
    await expect(section(page, 'Лимиты тарифа')).toContainText(/Сегодня\s*3\s+из\s5\sзадач/)
  })
})

test('the gift is used up without a tariff: both pages say so and lead to the tariffs', async ({
  page,
  signedInUser: _signedIn,
  credits: queue,
}) => {
  const noTariff = section(page, 'Тариф не выбран')

  await test.step('one task takes the whole gift', async () => {
    await addFirstSite(page, 'Кофейня')
    const landing = await queue.task({ title: 'Собрать страницу' })
    expect(landing.reserved).toEqual({ tariff: 0, gift: 35, pack: 0 })
    // 210 RUB of work is 35 credits: all that was set aside, and all there is.
    const charged = await landing.done('210.00')
    expect(charged.credits).toBe(35)
    expect(charged.from).toEqual({ tariff: 0, gift: 35, pack: 0 })
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
    await expect(historyLines(page)).toHaveText([said(`Собрать страницуКофейня${credits(35)}`)])
  })

  await test.step('«Тарифы» says the same above the tariffs, and sells no pack', async () => {
    await page.goto('/settings/plans')
    await expect(plansLead(page)).toHaveText(saidWhole(giftUsedUp), SLOW)
    await expect(page.getByRole('heading', { level: 2, name: 'Выберите тариф' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Купить пакет' })).toHaveCount(0)
    // The gift was granted once and spent once: it is not granted anew for the asking.
    expect(
      (await queue.journal()).map(({ account, kind, amount }) => [account, kind, amount]),
    ).toEqual([
      ['gift', 'grant', 35],
      ['gift', 'charge', -35],
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
    expect([stored.tariff.left, stored.gift.left, stored.pack.left]).toEqual([300, 35, 0])
  })

  await test.step('three large tasks use up the tariff and then the gift', async () => {
    expect((await large(queue, 'Собрать страницу «О нас»')).from).toEqual({
      tariff: 120,
      gift: 0,
      pack: 0,
    })
    expect((await large(queue, 'Добавить форму заявки')).from).toEqual({
      tariff: 120,
      gift: 0,
      pack: 0,
    })
    // The third one has 95 credits to set aside, and its work comes to more: it is charged
    // what was set aside, the tariff first.
    const last = await queue.task({ title: 'Переделать каталог', modelClass: 'heavy' })
    expect(last.reserved).toEqual({ tariff: 60, gift: 35, pack: 0 })
    expect((await last.done('720.00')).from).toEqual({ tariff: 60, gift: 35, pack: 0 })
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
        name: 'Из 300 кредитов по тарифу: 300 списано, 0 отложено под задачи в работе, 0 осталось',
      }),
    ).toBeVisible()
    // A gift that is used up is not shown as an account with nothing on it.
    await expect(creditsSection.getByRole('heading', { level: 3 })).toHaveText([
      /^По тарифу\s—\s0\sиз\s300$/,
      /^Из пакета\s—\s0$/,
    ])
    // The day is another limit, and it is not reached: three of five.
    const limits = section(page, 'Лимиты тарифа')
    await expect(limits).toContainText(/Сегодня\s*3\s+из\s5\sзадач/)
    await expect(limits).toContainText(said('Сегодня можно поставить ещё 2 задачи.'))
    // All 335 credits went to the one site; the last task took them from two accounts.
    await expect(section(page, 'По сайтам').getByRole('listitem')).toHaveText([
      said(`Кофейня335 кредитов`),
    ])
    await expect(historyLines(page)).toHaveText([
      said(`Переделать каталогКофейня${credits(95)}60 по тарифу и 35 подарочных`),
      said(`Добавить форму заявкиКофейня${credits(120)}`),
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
      /^По тарифу\s—\s0\sиз\s300$/,
      /^Из пакета\s—\s100$/,
    ])
    await expect(creditsSection).toContainText(
      said('Кредиты из пакета не сгорают. Сейчас задачи тратят их: кредиты по тарифу закончились.'),
    )
    await expect(
      page.getByRole('button', { name: 'Купить ещё 100 кредитов — 1 990 ₽' }),
    ).toBeVisible()
    await page.goto('/settings/plans')
    await expect(tariffBlock(page, 'Старт').getByRole('status')).toHaveCount(0)
    await expect(row(page, 'Кредиты')).toHaveText(saidWhole(creditsRow(stored)), SLOW)
  })

  await test.step('the next task is paid for from the pack', async () => {
    const banner = await queue.task({ title: 'Добавить баннер акции' })
    expect(banner.reserved).toEqual({ tariff: 0, gift: 0, pack: 45 })
    expect((await banner.done('101.37')).from).toEqual({ tariff: 0, gift: 0, pack: 17 })
    const stored = await queue.stored()
    expect(stored.pack).toEqual({ balance: 83, held: 0, left: 83 })

    await page.goto('/settings/usage')
    await expect(leftHeadlineOf(creditsSection)).toHaveText(leftHeadline(totalLeft(stored)), SLOW)
    await expect(historyLines(page).first()).toHaveText(
      said(`Добавить баннер акцииКофейня${credits(17)}`),
    )
    await expect(section(page, 'Лимиты тарифа')).toContainText(/Сегодня\s*4\s+из\s5\sзадач/)
  })
})

test('a task takes the gift before the pack, and a pack waits for a tariff that has ended', async ({
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
    expect([stored.tariff.left, stored.gift.left, stored.pack.left]).toEqual([300, 35, 100])
    // The fixture ends a tariff by its row alone: with credits on the tariff account it would
    // leave what the product never does, and it refuses.
    await expect(queue.tariffEnded()).rejects.toThrow(/does not expire a remainder/)
    expect((await queue.subscription()).status).toBe('active')
  })

  await test.step('a task that reaches past the tariff is paid by the gift, not by the pack', async () => {
    await large(queue, 'Собрать страницу «О нас»')
    await large(queue, 'Добавить форму заявки')
    // 60 credits of the tariff are left. The reserve of the next task stands on all three
    // accounts; its work comes to 80 credits, and the pack pays none of them.
    const catalogue = await queue.task({ title: 'Переделать каталог', modelClass: 'heavy' })
    expect(catalogue.reserved).toEqual({ tariff: 60, gift: 35, pack: 25 })
    const charged = await catalogue.done('480.00')
    expect(charged.credits).toBe(80)
    expect(charged.from).toEqual({ tariff: 60, gift: 20, pack: 0 })

    const stored = await queue.stored()
    expect(stored).toEqual({
      tariff: { balance: 0, held: 0, left: 0 },
      gift: { balance: 15, held: 0, left: 15 },
      pack: { balance: 100, held: 0, left: 100 },
    })
    expect(
      (await queue.journal())
        .filter(({ taskId }) => taskId === catalogue.id)
        .map(({ account, kind, amount }) => [account, kind, amount]),
    ).toEqual([
      ['tariff', 'charge', -60],
      ['gift', 'charge', -20],
    ])

    await page.goto('/settings/plans')
    await expect(row(page, 'Кредиты')).toHaveText(saidWhole(creditsRow(stored)), SLOW)
    await page.goto('/settings/usage')
    await expect(leftHeadlineOf(creditsSection)).toHaveText(leftHeadline(totalLeft(stored)), SLOW)
    // The accounts stand in the order their credits are spent in.
    await expect(creditsSection.getByRole('heading', { level: 3 })).toHaveText([
      /^По тарифу\s—\s0\sиз\s300$/,
      /^Подарочные\s—\s15$/,
      /^Из пакета\s—\s100$/,
    ])
    await expect(creditsSection).toContainText(
      said('Кредиты из пакета не сгорают. Начнут тратиться, когда закончатся подарочные кредиты.'),
    )
    await expect(historyLines(page).first()).toHaveText(
      said(`Переделать каталогКофейня${credits(80)}60 по тарифу и 20 подарочных`),
    )
  })

  await test.step('the next task takes what is left of the gift first', async () => {
    const banner = await queue.task({ title: 'Добавить баннер акции' })
    expect(banner.reserved).toEqual({ tariff: 0, gift: 15, pack: 30 })
    expect((await banner.done('90.00')).from).toEqual({ tariff: 0, gift: 15, pack: 0 })
    const stored = await queue.stored()
    expect([stored.gift.left, stored.pack.left]).toEqual([0, 100])
  })

  await test.step('the tariff ends: the pack is kept and waits for the next tariff', async () => {
    await queue.tariffEnded()
    const { pack } = await queue.stored()

    await page.goto('/settings/usage')
    const noTariff = section(page, 'Тариф не выбран')
    await expect(noTariff).toContainText(said(packWaits(pack.left)), SLOW)
    await expect(noTariff.getByRole('link', { name: 'Выбрать тариф' })).toHaveAttribute(
      'href',
      '/settings/plans',
    )
    // Nothing is measured without a tariff, and the history is whole.
    await expect(page.getByRole('main').getByRole('img')).toHaveCount(0)
    await expect(historyLines(page)).toHaveCount(4)

    await page.goto('/settings/plans')
    const block = tariffBlock(page, 'Старт')
    await expect(block).toContainText(
      said(
        `Новые задачи сейчас не принимаются. ${credits(pack.left)} из пакета, сайты и история правок на месте.`,
      ),
      SLOW,
    )
    await expect(page.getByRole('main')).toContainText(
      said('Выберите тариф, чтобы снова ставить задачи.'),
    )
    // A pack is not sold without a tariff.
    await expect(page.getByRole('button', { name: 'Купить пакет' })).toHaveCount(0)
  })
})
