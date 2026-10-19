// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BillingUsage, Checkout, TariffUsage, UsageEntry } from './billing-types'
import { plain, serverRefusal, subscriptionTo, taskCreditsFor, type TaskFacts } from './testing'
import { UsageView } from './usage-view'

type HistoryPage = BillingUsage['history']

const { getUsage, getHistory, startPackCheckout, hardNavigate } = vi.hoisted(() => ({
  getUsage: vi.fn<() => Promise<BillingUsage>>(),
  getHistory: vi.fn<(input: { cursor: string }) => Promise<HistoryPage>>(),
  startPackCheckout: vi.fn<(input: Record<string, never>) => Promise<Checkout>>(),
  hardNavigate: vi.fn<(path: string) => void>(),
}))

vi.mock('@/lib/hard-navigate', () => ({ hardNavigate }))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    billing: {
      usage: {
        queryKey: () => ['billing', 'usage'],
        queryOptions: () => ({ queryKey: ['billing', 'usage'], queryFn: getUsage }),
      },
      overview: { queryKey: () => ['billing', 'overview'] },
      plans: { queryKey: () => ['billing', 'plans'] },
      startPackCheckout: {
        mutationOptions: (options: UseMutationOptions<Checkout, Error, Record<string, never>>) => ({
          ...options,
          mutationFn: startPackCheckout,
        }),
      },
    },
  }),
  useTRPCClient: () => ({ billing: { usageHistory: { query: getHistory } } }),
}))

const ID = (n: number) => `018f0000-0000-7000-8000-${String(n).padStart(12, '0')}`
const bakery = { id: ID(101), name: 'Пекарня «Добро»' }
const cafe = { id: ID(102), name: 'Кофейня на Лесной' }
const pack100 = {
  id: ID(4),
  slug: 'pack',
  name: 'Пакет из 100 кредитов',
  price: '1990.00',
  credits: 100,
}

let nextEntry = 0
function entry(patch: Partial<UsageEntry> = {}): UsageEntry {
  nextEntry += 1
  return {
    id: ID(1000 + nextEntry),
    at: new Date('2026-10-03T08:00:00Z'),
    outcome: 'charged',
    credits: 5,
    from: { tariff: 5, gift: 0, pack: 0 },
    task: { id: ID(2000 + nextEntry), title: 'Заменил фото на главной', status: 'done' },
    site: cafe,
    ...patch,
  }
}
/** A line that took nothing: a task without a charge, an undo. */
const nothing = { credits: null, from: null }

/**
 * The history of the mockup: a task in work, a small edit, an undo, a task that failed and a
 * block charged on two accounts.
 */
const mockupHistory = (): UsageEntry[] => [
  entry({
    at: new Date('2026-10-04T08:00:00Z'),
    outcome: 'held',
    credits: 45,
    from: { tariff: 45, gift: 0, pack: 0 },
    task: { id: ID(11), title: 'Обновить цены в разделе «Торты на заказ»', status: 'running' },
    site: bakery,
  }),
  entry({ task: { id: ID(12), title: 'Заменить фото на главной', status: 'done' } }),
  entry({
    outcome: 'free',
    ...nothing,
    task: { id: ID(13), title: 'Вернуть прежний баннер', status: 'done' },
  }),
  entry({
    at: new Date('2026-10-02T08:00:00Z'),
    outcome: 'unpaid',
    ...nothing,
    task: { id: ID(14), title: 'Добавить страницу «Доставка»', status: 'failed' },
    site: bakery,
  }),
  entry({
    at: new Date('2026-10-01T08:00:00Z'),
    credits: 17,
    from: { tariff: 5, gift: 0, pack: 12 },
    task: { id: ID(15), title: 'Поправить часы работы в контактах', status: 'done' },
    site: bakery,
  }),
]
const noHistory: HistoryPage = { items: [], nextCursor: null }

type Meter = TariffUsage['credits']
/** A meter that adds up: what was granted is what was charged, set aside, expired and left. */
function meterOf(patch: Partial<Meter>): Meter {
  const parts = { charged: 0, held: 0, expired: 0, left: 0, heldEarlier: 0, ...patch }
  return {
    ...parts,
    granted: patch.granted ?? parts.charged + parts.held + parts.expired + parts.left,
  }
}

/**
 * «Бизнес» in the middle of its period: 765 of its 800 credits are left. Its day is the one the
 * answer about a new task tells (`usageOf`).
 */
function tariffOf(patch: Partial<Omit<TariffUsage, 'today'>> = {}): TariffUsage {
  return {
    credits: meterOf({ charged: 34, held: 1, left: 765 }),
    today: null,
    sites: { count: 2, max: 3 },
    bySite: [
      { siteId: bakery.id, name: bakery.name, credits: 21 },
      { siteId: cafe.id, name: cafe.name, credits: 13 },
    ],
    ...patch,
  }
}

/** The gift of the registration was never granted to the workspace, and none is promised. */
const noGift = { left: 0, held: 0, granted: false }
/** The gift of the registration on its account, with `held` of it set aside for tasks in work. */
const giftOf = (left: number, held = 0) => ({ left, held, granted: true })

type UsagePatch = Partial<
  Pick<
    BillingUsage,
    | 'paymentsEnabled'
    | 'autoRenewalAvailable'
    | 'packOnSale'
    | 'subscription'
    | 'tariff'
    | 'gift'
    | 'pack'
    | 'history'
  >
>

/**
 * «Бизнес» with 100 credits of a pack beside it: 865 credits left; today 4 of the tariff were
 * charged and 1 is set aside. Whether a new task would be taken is what the server answers for
 * these accounts, this tariff and this day (`taskCreditsFor`); `facts` add another day, the
 * unpaid work and the credit rate.
 */
function usageOf(patch: UsagePatch = {}, facts: TaskFacts = {}): BillingUsage {
  const usage = {
    paymentsEnabled: true,
    autoRenewalAvailable: patch.paymentsEnabled !== false,
    packOnSale: pack100,
    subscription: subscriptionTo(),
    tariff: tariffOf(),
    // No gift is spoken of unless a test gives the customer one.
    gift: noGift,
    pack: { left: 100, held: 0 },
    history: { items: mockupHistory(), nextCursor: null },
    ...patch,
  }
  const credits = usage.tariff?.credits
  const heldOfTariff = (credits?.held ?? 0) + (credits?.heldEarlier ?? 0)
  const account = ({ left, held }: { left: number; held: number }) => ({
    balance: left + held,
    held,
  })
  const task = taskCreditsFor(
    {
      tariff: { balance: (credits?.left ?? 0) + heldOfTariff, held: heldOfTariff },
      gift: account(usage.gift),
      pack: account(usage.pack),
    },
    usage.subscription,
    { today: { charged: 4, held: 1 }, ...facts },
  )
  return {
    ...usage,
    // The meter of the tariff tells the day the answer tells.
    tariff: usage.tariff === null ? null : { ...usage.tariff, today: task.today },
    totalLeft: (credits?.left ?? 0) + usage.gift.left + usage.pack.left,
    ...task,
  }
}

/** A customer whose quota is used up and who has bought nothing. */
const outOfCredits = (patch: UsagePatch = {}, facts: TaskFacts = {}) =>
  usageOf(
    {
      tariff: tariffOf({ credits: meterOf({ charged: 800 }) }),
      pack: { left: 0, held: 0 },
      ...patch,
    },
    facts,
  )

const noTariff = (
  purchased = 0,
  gift: BillingUsage['gift'] = noGift,
  history: HistoryPage = noHistory,
  facts: TaskFacts = {},
) =>
  usageOf(
    { subscription: null, tariff: null, gift, pack: { left: purchased, held: 0 }, history },
    facts,
  )

const newClient = (staleTime = 0) =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime }, mutations: { retry: false } },
  })

function showUsage(queryClient = newClient()) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <UsageView />
    </QueryClientProvider>,
  )
  return { queryClient, unmount: view.unmount }
}

const section = (name: string) => screen.findByRole('region', { name })
const pageText = () => plain(document.body.textContent)
/** The parts a meter draws, by what they stand for. */
const tones = (meter: HTMLElement) =>
  [...meter.querySelectorAll('[data-tone]')].map((part) => part.getAttribute('data-tone'))
const texts = (elements: HTMLElement[]) => elements.map((element) => plain(element.textContent))

beforeEach(() => {
  vi.clearAllMocks()
  nextEntry = 0
  getUsage.mockResolvedValue(usageOf())
})

describe('the «Использование» page while its data is on the way', () => {
  it('shows a placeholder until the answer arrives', async () => {
    let answer!: (usage: BillingUsage) => void
    getUsage.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    showUsage()

    expect(screen.getByRole('heading', { level: 1, name: 'Использование' })).toBeInTheDocument()
    expect(pageText()).toContain('Сколько кредитов осталось и на какие задачи они ушли.')
    expect(screen.getByRole('status', { name: 'Загрузка использования' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()

    answer(usageOf())

    expect(await screen.findByRole('heading', { level: 2, name: 'Кредиты' })).toBeVisible()
    expect(screen.queryByRole('status', { name: 'Загрузка использования' })).not.toBeInTheDocument()
  })

  it('offers a retry when the answer fails, and shows the page after it', async () => {
    getUsage.mockRejectedValueOnce(new Error('Network unavailable'))
    showUsage()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось загрузить данные об использовании. Попробуйте ещё раз.',
    )
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))

    expect(await screen.findByRole('heading', { level: 2, name: 'Кредиты' })).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(getUsage).toHaveBeenCalledTimes(2)
  })

  it('keeps the numbers on the screen when a refresh in the background fails', async () => {
    const { queryClient } = showUsage()
    await section('Кредиты')
    getUsage.mockRejectedValueOnce(new Error('Network unavailable'))

    await queryClient.invalidateQueries({ queryKey: ['billing', 'usage'] })

    await waitFor(() => expect(getUsage).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('region', { name: 'Кредиты' })).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reads the numbers anew every time the page is opened, showing the known ones meanwhile', async () => {
    // The cache of the application keeps an answer fresh for half a minute.
    const queryClient = newClient(30_000)
    const first = showUsage(queryClient)
    await section('Кредиты')
    first.unmount()
    let answer!: (usage: BillingUsage) => void
    getUsage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )

    showUsage(queryClient)

    // No placeholder: the numbers of the last visit are on the screen at once.
    expect(plain(screen.getByRole('region', { name: 'Кредиты' }).textContent)).toContain(
      '865кредитов осталось',
    )
    await waitFor(() => expect(getUsage).toHaveBeenCalledTimes(2))
    answer(usageOf({ pack: { left: 20, held: 0 } }))
    await waitFor(() =>
      expect(plain(screen.getByRole('region', { name: 'Кредиты' }).textContent)).toContain(
        '785кредитов осталось',
      ),
    )
  })
})

describe('the «Использование» page of a customer without a tariff', () => {
  it('says that no tariff is chosen and leads to the tariffs', async () => {
    getUsage.mockResolvedValue(noTariff())
    showUsage()

    const state = await section('Тариф не выбран')
    expect(plain(state.textContent)).toContain(
      'Кредиты входят в тариф. Выберите тариф, чтобы ставить задачи: здесь появится, сколько кредитов осталось и на что они ушли.',
    )
    expect(within(state).getByRole('link', { name: 'Выбрать тариф' })).toHaveAttribute(
      'href',
      '/settings/plans',
    )
    expect(plain(state.textContent)).not.toContain('из пакета')
    // Nothing is measured without a tariff, and nothing is offered but the tariffs.
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    // The history stands below: of a customer without a tariff it has no period.
    expect(texts(screen.getAllByRole('heading', { level: 2 }))).toEqual([
      'Тариф не выбран',
      'История списаний',
    ])
    expect(plain((await section('История списаний')).textContent)).toContain(
      'Списаний пока нет. Здесь появятся задачи и сколько кредитов ушло на каждую.',
    )
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('tells the customer whose tariff has ended that the credits they bought wait for a tariff', async () => {
    getUsage.mockResolvedValue(noTariff(100))
    showUsage()

    const state = plain((await section('Тариф не выбран')).textContent)
    expect(state).toContain(
      'Тариф закончился. У вас 100 кредитов из пакета: они не сгорают и снова будут доступны, когда вы выберете тариф.',
    )
    // Said once.
    expect(state.match(/из пакета/g)).toHaveLength(1)
  })

  it('shows the history of a customer without a tariff: tasks done on gift credits', async () => {
    getUsage.mockResolvedValue(
      noTariff(0, giftOf(30), {
        items: [
          entry({
            outcome: 'unpaid',
            ...nothing,
            task: { id: ID(61), title: 'Добавить форму заявки', status: 'failed' },
          }),
          entry({
            from: { tariff: 0, gift: 5, pack: 0 },
            task: { id: ID(62), title: 'Заменить телефон в шапке', status: 'done' },
          }),
        ],
        nextCursor: null,
      }),
    )
    showUsage()

    const history = await section('История списаний')
    const rows = within(within(history).getByRole('table'))
      .getAllByRole('row')
      .slice(1)
      .map((row) => texts(within(row).getAllByRole('cell')))
    expect(rows).toEqual([
      ['3 октября 2026', 'Добавить форму заявкиНе получилось', 'Кофейня на Лесной', 'Не списано'],
      ['3 октября 2026', 'Заменить телефон в шапке', 'Кофейня на Лесной', '5 кредитов'],
    ])
    // Still nothing of a tariff: no meter, no limits, no sites.
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Лимиты тарифа' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'По сайтам' })).not.toBeInTheDocument()
  })

  it('prints the year of every line: the history has no period, and the same day comes round again', async () => {
    const dates = (history: HTMLElement) =>
      within(within(history).getByRole('table'))
        .getAllByRole('row')
        .slice(1)
        .map((row) => plain(within(row).getAllByRole('cell')[0]?.textContent))
    getUsage.mockResolvedValue(
      noTariff(0, giftOf(20), {
        items: [
          entry({ at: new Date('2027-10-05T08:00:00Z') }),
          // 23:30 in Moscow on 31 December: the year is the Moscow one.
          entry({ at: new Date('2026-12-31T20:30:00Z') }),
          entry({ at: new Date('2026-10-05T08:00:00Z') }),
        ],
        nextCursor: ID(701),
      }),
    )
    getHistory.mockResolvedValue({
      items: [entry({ at: new Date('2026-03-14T08:00:00Z') })],
      nextCursor: null,
    })
    showUsage()

    const history = await section('История списаний')
    expect(dates(history)).toEqual(['5 октября 2027', '31 декабря 2026', '5 октября 2026'])

    // The lines «Показать ещё» adds go further back, and say how far.
    fireEvent.click(within(history).getByRole('button', { name: 'Показать ещё' }))
    await waitFor(() => expect(dates(history)).toHaveLength(4))
    expect(dates(history).at(-1)).toBe('14 марта 2026')
  })
})

describe('the credits of a customer on a tariff', () => {
  it('shows what is left as one figure, with the tariff and its period', async () => {
    showUsage()

    const credits = await section('Кредиты')
    expect(plain(credits.textContent)).toContain('Тариф «Бизнес» · 18 сентября — 18 октября 2026')
    expect(plain(within(credits).getByText('865').parentElement?.textContent)).toBe(
      '865кредитов осталось',
    )
    expect(within(credits).getByText('865')).toHaveStyle({
      fontVariantNumeric: 'proportional-nums',
    })
  })

  it('divides the quota into charged, in work and left, in the meter and in its legend', async () => {
    showUsage()

    const credits = await section('Кредиты')
    expect(
      plain(within(credits).getByRole('heading', { level: 3, name: /По тарифу/ }).textContent),
    ).toBe('По тарифу — 765 из 800')
    const meter = within(credits).getByRole('img', {
      name: 'Из 800 кредитов по тарифу: 34 списано, 1 отложено под задачи в работе, 765 осталось',
    })
    expect(tones(meter)).toEqual(['spent', 'held', 'left'])
    // The parts are as wide as their numbers.
    expect(
      [...meter.querySelectorAll('[data-tone]')].map((part) => getComputedStyle(part).flexGrow),
    ).toEqual(['34', '1', '765'])
    const legend = meter.parentElement?.nextElementSibling as HTMLElement
    expect(texts(within(legend).getAllByRole('listitem'))).toEqual([
      'Списано — 34',
      'Отложено — 1',
      'Осталось — 765',
    ])
    // What becomes of the credits that are set aside is said under the meter.
    expect(plain(credits.textContent)).toContain(
      'Отложенное спишем по факту: сколько уйдёт на работу, но не меньше 5 кредитов за выполненную задачу. Остальное вернётся.',
    )
    expect(plain(credits.textContent)).toContain(
      '18 октября начислим новые 800. Остаток по тарифу на новый период не переносится.',
    )
  })

  it('draws no part for a number that is zero', async () => {
    getUsage.mockResolvedValue(usageOf({ tariff: tariffOf({ credits: meterOf({ left: 800 }) }) }))
    showUsage()

    const meter = await screen.findByRole('img', {
      name: 'Из 800 кредитов по тарифу: 0 списано, 0 отложено под задачи в работе, 800 осталось',
    })
    expect(tones(meter)).toEqual(['left'])
    // The legend still names the three, and nothing that did not happen.
    expect(pageText()).toContain('Списано — 0')
    expect(pageText()).toContain('Отложено — 0')
    expect(pageText()).not.toContain('Сгорело')
    // Nothing is set aside: nothing is said of what becomes of it.
    expect(pageText()).not.toContain('Отложенное спишем по факту')
  })

  it('shows what expired of the period as a part of its own, only when something did', async () => {
    getUsage.mockResolvedValue(
      usageOf({
        tariff: tariffOf({ credits: meterOf({ charged: 65, held: 45, expired: 24, left: 166 }) }),
      }),
    )
    showUsage()

    const credits = await section('Кредиты')
    const meter = within(credits).getByRole('img', {
      name: 'Из 300 кредитов по тарифу: 65 списано, 45 отложено под задачи в работе, 166 осталось, 24 сгорело',
    })
    expect(tones(meter)).toEqual(['spent', 'expired', 'held', 'left'])
    expect(
      [...meter.querySelectorAll('[data-tone]')].map((part) => getComputedStyle(part).flexGrow),
    ).toEqual(['65', '24', '45', '166'])
    const legend = meter.parentElement?.nextElementSibling as HTMLElement
    expect(texts(within(legend).getAllByRole('listitem'))).toEqual([
      'Списано — 65',
      'Сгорело — 24',
      'Отложено — 45',
      'Осталось — 166',
    ])
  })

  it('tells of credits of the period before that are still set aside, beside the meter', async () => {
    // The period was renewed while a task was in work: 45 credits of the old one wait for it.
    getUsage.mockResolvedValue(
      usageOf({
        tariff: tariffOf({ credits: meterOf({ left: 800, heldEarlier: 45 }) }),
        pack: { left: 0, held: 0 },
      }),
    )
    showUsage()

    const credits = await section('Кредиты')
    // They are not of this period: the meter adds up without them.
    expect(
      within(credits).getByRole('img', {
        name: 'Из 800 кредитов по тарифу: 0 списано, 0 отложено под задачи в работе, 800 осталось',
      }),
    ).toBeVisible()
    expect(plain(credits.textContent)).toContain(
      'Ещё 45 кредитов прошлого периода отложено под задачу в работе. Что не уйдёт на неё, в новый период не перейдёт.',
    )
    expect(plain(credits.textContent)).toContain('Отложенное спишем по факту')
    expect(plain(within(credits).getByText('800').parentElement?.textContent)).toBe(
      '800кредитов осталось',
    )
  })

  // A tariff larger than any on sale, in the middle of its period and with several packs bought,
  // so that every count of the section has four digits — what is charged and what is in work
  // too: each is grouped as an amount of money is, and no line parts the groups.
  it('groups the digits of the counts of four digits', async () => {
    getUsage.mockResolvedValue(
      usageOf({
        tariff: tariffOf({ credits: meterOf({ charged: 1200, held: 1000, left: 2800 }) }),
        pack: { left: 1200, held: 0 },
      }),
    )
    showUsage()

    const credits = await section('Кредиты')
    const figure = within(credits).getByText('4 000', { normalizer: plain })
    expect(figure.textContent).toBe('4\u00a0000')
    expect(plain(figure.parentElement?.textContent)).toBe('4 000кредитов осталось')
    const heading = within(credits).getByRole('heading', { level: 3, name: /По тарифу/ })
    expect(heading.textContent).toBe('По тарифу\u00a0— 2\u00a0800 из\u00a05\u00a0000')
    // The name of the meter keeps plain spaces: it is looked up and read as it is.
    const meter = within(credits).getByRole('img', {
      name: 'Из 5 000 кредитов по тарифу: 1 200 списано, 1 000 отложено под задачи в работе, 2 800 осталось',
    })
    const legend = meter.parentElement?.nextElementSibling as HTMLElement
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Списано\u00a0— 1\u00a0200',
      'Отложено\u00a0— 1\u00a0000',
      'Осталось\u00a0— 2\u00a0800',
    ])
    expect(within(credits).getByRole('heading', { level: 3, name: /Из пакета/ }).textContent).toBe(
      'Из пакета\u00a0— 1\u00a0200',
    )
  })

  it('shows the purchased credits beside the tariff', async () => {
    showUsage()

    const credits = await section('Кредиты')
    const heading = within(credits).getByRole('heading', { level: 3, name: /Из пакета/ })
    expect(plain(heading.textContent)).toBe('Из пакета — 100')
    expect(plain(heading.parentElement?.textContent)).toContain(
      'Кредиты из пакета не сгорают. Начнут тратиться, когда закончатся кредиты по тарифу.',
    )
  })

  it('says that a tariff without auto-renewal brings no new quota', async () => {
    getUsage.mockResolvedValue(
      usageOf({ subscription: subscriptionTo({ autoRenewal: false, paymentMethod: null }) }),
    )
    showUsage()

    expect(plain((await section('Кредиты')).textContent)).toContain(
      'Тариф действует до 18 октября и не продлится. Остаток по тарифу после этого сгорит.',
    )
    expect(pageText()).not.toContain('начислим')
  })
})

describe('the pack on the «Использование» page', () => {
  const buyMore = 'Купить ещё 100 кредитов — 1 990 ₽'

  it('offers more credits and opens the dialog of the pack', async () => {
    startPackCheckout.mockResolvedValue({
      orderId: ID(77),
      confirmationUrl: 'https://yookassa.example/pay/77',
    })
    showUsage()

    fireEvent.click(await screen.findByRole('button', { name: buyMore }))

    const dialog = await screen.findByRole('dialog', { name: 'Пакет из 100 кредитов' })
    expect(plain(dialog.textContent)).toContain('1 990 ₽')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Перейти к оплате' }))

    await waitFor(() =>
      expect(hardNavigate).toHaveBeenCalledExactlyOnceWith('https://yookassa.example/pay/77'),
    )
    expect(startPackCheckout).toHaveBeenCalledExactlyOnceWith({}, expect.anything())
  })

  it('reads the page anew when the dialog closes: a refusal may be about what it shows', async () => {
    startPackCheckout.mockRejectedValueOnce(
      serverRefusal(
        'Пакет кредитов можно купить только при действующем тарифе. Сначала оформите или оплатите тариф',
        'BILLING_PACK_NEEDS_SUBSCRIPTION',
      ),
    )
    showUsage()
    fireEvent.click(await screen.findByRole('button', { name: buyMore }))
    const dialog = await screen.findByRole('dialog', { name: 'Пакет из 100 кредитов' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Перейти к оплате' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Пакет кредитов можно купить только при действующем тарифе.',
    )
    // The tariff has ended meanwhile.
    getUsage.mockResolvedValue(noTariff(100))
    expect(getUsage).toHaveBeenCalledTimes(1)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))

    expect(await section('Тариф не выбран')).toBeVisible()
    expect(getUsage).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: buyMore })).not.toBeInTheDocument()
    expect(hardNavigate).not.toHaveBeenCalled()
  })

  it.each([
    ['payments are off', usageOf({ paymentsEnabled: false })],
    ['no pack is on sale', usageOf({ packOnSale: null })],
    [
      'the payment of the tariff is overdue',
      usageOf({ subscription: subscriptionTo({ status: 'past_due' }) }),
    ],
  ])('offers no pack while %s', async (_case, usage) => {
    getUsage.mockResolvedValue(usage)
    showUsage()

    await section('Кредиты')
    expect(screen.queryByRole('button', { name: /Купить/ })).not.toBeInTheDocument()
  })
})

describe('a customer whose credits are used up', () => {
  it('shows the meter as spent to the end and the two ways out', async () => {
    getUsage.mockResolvedValue(outOfCredits())
    showUsage()

    const credits = await section('Кредиты')
    expect(plain(within(credits).getByText('0').parentElement?.textContent)).toBe(
      '0кредитов осталось',
    )
    const meter = within(credits).getByRole('img', {
      name: 'Из 800 кредитов по тарифу: 800 списано, 0 отложено под задачи в работе, 0 осталось',
    })
    expect(tones(meter)).toEqual(['out'])
    const notice = within(credits).getByRole('status')
    expect(plain(notice.textContent)).toBe(
      'Лимиты закончились: кредиты по тарифу и из пакета израсходованы. 18 октября начислим 800 кредитов по тарифу «Бизнес». Чтобы продолжить сейчас, купите пакет — 100 кредитов за 1 990 ₽. Кредиты из пакета не сгорают.',
    )
    // The notice stands above the meter: what stands in the way is read first.
    expect(notice.compareDocumentPosition(meter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(credits).getByRole('link', { name: 'Сменить тариф' })).toHaveAttribute(
      'href',
      '/settings/plans',
    )
    // Only a pack helps today.
    expect(plain(credits.textContent)).toContain(
      'Новый тариф начнёт действовать со следующего периода.',
    )
    // One offer of the pack, as the way out; not a second one in the corner.
    expect(texts(within(credits).getAllByRole('button'))).toEqual(['Купить пакет'])
  })

  it('opens the dialog of the pack from the notice', async () => {
    getUsage.mockResolvedValue(outOfCredits())
    showUsage()

    fireEvent.click(await screen.findByRole('button', { name: 'Купить пакет' }))

    expect(await screen.findByRole('dialog', { name: 'Пакет из 100 кредитов' })).toBeVisible()
  })

  it('names no payment where nothing can be paid for', async () => {
    getUsage.mockResolvedValue(outOfCredits({ paymentsEnabled: false }))
    showUsage()

    const credits = await section('Кредиты')
    expect(plain(within(credits).getByRole('status').textContent)).toBe(
      'Лимиты закончились: кредиты по тарифу и из пакета израсходованы. 18 октября начислим 800 кредитов по тарифу «Бизнес».',
    )
    expect(within(credits).queryByRole('button')).not.toBeInTheDocument()
    expect(within(credits).queryByRole('link')).not.toBeInTheDocument()
  })

  it('leaves only the change of the tariff when no pack is on sale', async () => {
    getUsage.mockResolvedValue(outOfCredits({ packOnSale: null }))
    showUsage()

    const credits = await section('Кредиты')
    expect(plain(within(credits).getByRole('status').textContent)).toBe(
      'Лимиты закончились: кредиты по тарифу и из пакета израсходованы. 18 октября начислим 800 кредитов по тарифу «Бизнес».',
    )
    expect(within(credits).queryByRole('button')).not.toBeInTheDocument()
    expect(within(credits).getByRole('link', { name: 'Сменить тариф' })).toBeVisible()
  })

  it('says how many credits are left when they are too few to start a task', async () => {
    getUsage.mockResolvedValue(
      outOfCredits({ tariff: tariffOf({ credits: meterOf({ charged: 797, left: 3 }) }) }),
    )
    showUsage()

    const credits = await section('Кредиты')
    expect(plain(within(credits).getByRole('status').textContent)).toBe(
      'Лимиты закончились: осталось 3 кредита, а на новую задачу нужно не меньше 5. 18 октября начислим 800 кредитов по тарифу «Бизнес». Чтобы продолжить сейчас, купите пакет — 100 кредитов за 1 990 ₽.',
    )
    // Three are still left, and the page says so in its headline.
    expect(plain(within(credits).getByText('3').parentElement?.textContent)).toBe(
      '3кредита осталось',
    )
  })

  it('offers the pack and auto-renewal to a tariff that does not renew', async () => {
    getUsage.mockResolvedValue(
      outOfCredits({ subscription: subscriptionTo({ autoRenewal: false, paymentMethod: null }) }),
    )
    showUsage()

    const credits = await section('Кредиты')
    expect(plain(within(credits).getByRole('status').textContent)).toBe(
      'Лимиты закончились, а тариф «Бизнес» действует до 18 октября и не продлится. Купите пакет — 100 кредитов за 1 990 ₽, они не сгорают, — или включите автопродление: тогда 18 октября начислим 800 кредитов.',
    )
    expect(within(credits).getByRole('button', { name: 'Купить пакет' })).toBeVisible()
    expect(within(credits).getByRole('link', { name: 'Включить автопродление' })).toHaveAttribute(
      'href',
      '/settings/plans',
    )
    expect(within(credits).queryByRole('link', { name: 'Сменить тариф' })).not.toBeInTheDocument()
  })

  it('keeps the credits in work in the meter', async () => {
    getUsage.mockResolvedValue(
      outOfCredits({ tariff: tariffOf({ credits: meterOf({ charged: 798, held: 2 }) }) }),
    )
    showUsage()

    const meter = await screen.findByRole('img', {
      name: 'Из 800 кредитов по тарифу: 798 списано, 2 отложено под задачи в работе, 0 осталось',
    })
    expect(tones(meter)).toEqual(['out', 'held'])
    expect(screen.getByRole('status')).toHaveTextContent('Лимиты закончились:')
  })

  it('gives no notice while purchased credits are left', async () => {
    getUsage.mockResolvedValue(outOfCredits({ pack: { left: 7, held: 0 } }))
    showUsage()

    const credits = await section('Кредиты')
    expect(within(credits).queryByRole('status')).not.toBeInTheDocument()
    // The quota is spent, but no task is stopped: the meter is not drawn as an end.
    expect(
      tones(
        within(credits).getByRole('img', {
          name: 'Из 800 кредитов по тарифу: 800 списано, 0 отложено под задачи в работе, 0 осталось',
        }),
      ),
    ).toEqual(['spent'])
    expect(plain(within(credits).getByText('7').parentElement?.textContent)).toBe(
      '7кредитов осталось',
    )
    expect(plain(credits.textContent)).toContain(
      'Сейчас задачи тратят их: кредиты по тарифу закончились.',
    )
    // More credits are offered in the corner, as usual.
    expect(
      within(credits).getByRole('button', { name: 'Купить ещё 100 кредитов — 1 990 ₽' }),
    ).toBeVisible()
  })
})

describe('a customer whose tariff is not paid', () => {
  it('says that no tasks are taken and leads to the tariffs', async () => {
    getUsage.mockResolvedValue(
      outOfCredits({ subscription: subscriptionTo({ status: 'past_due', autoRenewal: false }) }),
    )
    showUsage()

    const credits = await section('Кредиты')
    // One notice: the unpaid tariff, not the credits that ran out.
    expect(within(credits).getAllByRole('status')).toHaveLength(1)
    expect(plain(within(credits).getByRole('status').textContent)).toBe(
      'Тариф «Бизнес» не оплачен, поэтому новые задачи не принимаются. Оплатите тариф — кредиты нового периода начислим сразу.',
    )
    expect(within(credits).getByRole('link', { name: 'К тарифам' })).toHaveAttribute(
      'href',
      '/settings/plans',
    )
    expect(within(credits).queryByRole('link', { name: 'Сменить тариф' })).not.toBeInTheDocument()
    expect(plain(credits.textContent)).toContain(
      'Период тарифа закончился 18 октября. Новые кредиты начислим после оплаты',
    )
    expect(plain((await section('Лимиты тарифа')).textContent)).toContain(
      'Новые задачи не принимаются, пока не оплачен тариф.',
    )
  })

  it('does not count the rest of the period that ended as credits the customer has', async () => {
    // 765 of 800 credits of the tariff were not used, nothing was bought.
    getUsage.mockResolvedValue(
      usageOf({
        subscription: subscriptionTo({ status: 'past_due' }),
        pack: { left: 0, held: 0 },
      }),
    )
    showUsage()

    const credits = await section('Кредиты')
    expect(plain(within(credits).getByText('0').parentElement?.textContent)).toBe(
      '0кредитов осталось',
    )
    expect(
      plain(within(credits).getByRole('heading', { level: 3, name: /По тарифу/ }).textContent),
    ).toBe('По тарифу — период закончился')
    const meter = within(credits).getByRole('img', {
      name: 'Из 800 кредитов по тарифу: 34 списано, 1 отложено под задачи в работе, 765 не использовано',
    })
    // The meter still shows what the period went to.
    expect(tones(meter)).toEqual(['spent', 'held', 'left'])
    const legend = meter.parentElement?.nextElementSibling as HTMLElement
    expect(texts(within(legend).getAllByRole('listitem'))).toEqual([
      'Списано — 34',
      'Отложено — 1',
      'Не использовано — 765',
    ])
    // Nothing on the page contradicts «остаток прошлого периода не переносится».
    expect(plain(credits.textContent)).toContain(
      'Период тарифа закончился 18 октября. Новые кредиты начислим после оплаты, остаток прошлого периода не переносится.',
    )
    expect(plain(credits.textContent)).not.toMatch(/Осталось|765 из 800|765\s?кредитов осталось/)
  })

  it('keeps the purchased credits for the customer and ties them to the payment', async () => {
    getUsage.mockResolvedValue(
      outOfCredits({
        subscription: subscriptionTo({ status: 'past_due' }),
        pack: { left: 7, held: 0 },
      }),
    )
    showUsage()

    const credits = await section('Кредиты')
    expect(plain(within(credits).getByText('7').parentElement?.textContent)).toBe(
      '7кредитов осталось',
    )
    const heading = within(credits).getByRole('heading', { level: 3, name: /Из пакета/ })
    expect(plain(heading.textContent)).toBe('Из пакета — 7')
    expect(plain(heading.parentElement?.textContent)).toContain(
      'Кредиты из пакета не сгорают. Станут доступны после оплаты тарифа.',
    )
    // No task is taken: nothing spends the purchased credits now.
    expect(plain(credits.textContent)).not.toContain('Сейчас задачи тратят их')
    expect(plain(within(credits).getByRole('status').textContent)).toBe(
      'Тариф «Бизнес» не оплачен, поэтому новые задачи не принимаются. Оплатите тариф — кредиты нового периода начислим сразу.',
    )
  })

  it('counts the purchased credits alone in the headline when both accounts hold some', async () => {
    getUsage.mockResolvedValue(usageOf({ subscription: subscriptionTo({ status: 'past_due' }) }))
    showUsage()

    const credits = await section('Кредиты')
    // 765 of the tariff and 100 from a pack: only those of the pack outlive the period.
    expect(plain(within(credits).getByText('100').parentElement?.textContent)).toBe(
      '100кредитов осталось',
    )
    expect(plain(credits.textContent)).not.toContain('865')
  })
})

describe('the limits of the tariff', () => {
  const outside = 'Подарочные кредиты и кредиты из пакета дневным лимитом не ограничены.'

  // What the tile promises of tomorrow depends on whether the period of «Бизнес» in the fixtures
  // (until 09:00 UTC on 18.10.2026) ends before the next Moscow midnight: the clock stands inside
  // that period, so the answers do not change with the calendar. Only `Date` is faked.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-17T09:00:00Z') })
    return () => {
      vi.useRealTimers()
    }
  })

  it('measures the day and the sites, each with a named meter and a line', async () => {
    showUsage()

    const limits = await section('Лимиты тарифа')
    const [today, sites] = within(limits)
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.parentElement as HTMLElement)
    // The day counts the tariff credits of «Бизнес»: 4 charged and 1 set aside of 100.
    expect(plain(today!.textContent)).toContain('Сегодня5 из 100 кредитов')
    expect(
      tones(
        within(today!).getByRole('img', {
          name: 'Сегодня из 100 кредитов: 4 списано, 1 отложено под задачи в работе, 95 осталось',
        }),
      ),
    ).toEqual(['spent', 'held', 'left'])
    expect(plain(today!.textContent)).toContain(
      'Сегодня потрачено 5 кредитов из 100: 4 списано и 1 отложено под задачи в работе.',
    )
    expect(plain(today!.textContent)).toContain(
      `Сегодня можно потратить ещё 95 кредитов. ${outside}`,
    )

    expect(plain(sites!.textContent)).toContain('Сайты2 из 3 сайтов')
    expect(tones(within(sites!).getByRole('img', { name: 'Добавлено 2 сайта из 3' }))).toEqual([
      'spent',
      'left',
    ])
    expect(plain(sites!.textContent)).toContain('Можно добавить ещё один сайт.')
  })

  it('fills the meters of a day and of a tariff that are full', async () => {
    getUsage.mockResolvedValue(
      usageOf(
        { tariff: tariffOf({ sites: { count: 4, max: 3 } }), pack: { left: 0, held: 0 } },
        { today: { charged: 100 } },
      ),
    )
    showUsage()

    const limits = await section('Лимиты тарифа')
    expect(
      tones(
        within(limits).getByRole('img', {
          name: 'Сегодня из 100 кредитов: 100 списано, 0 отложено под задачи в работе, 0 осталось',
        }),
      ),
    ).toEqual(['spent'])
    expect(tones(within(limits).getByRole('img', { name: 'Добавлено 4 сайта из 3' }))).toEqual([
      'spent',
    ])
    expect(plain(limits.textContent)).toContain(
      `Кредиты по тарифу на сегодня закончились — завтра снова можно будет потратить до 100. ${outside}`,
    )
    expect(plain(limits.textContent)).toContain(
      'Сайтов больше, чем входит в тариф: новый добавить нельзя.',
    )
    // The server refuses a new task for the day, and the page says so above the meter.
    expect(plain(within(await section('Кредиты')).getByRole('status').textContent)).toBe(
      'Кредиты по тарифу на сегодня закончились: потрачено 100 из 100. Завтра снова можно будет потратить до 100 кредитов. Чтобы продолжить сегодня, купите пакет — 100 кредитов за 1 990 ₽. Кредиты из пакета не сгорают и дневным лимитом не ограничены.',
    )
    // A pack lifts the day: the notice offers it.
    expect(screen.getByRole('button', { name: 'Купить пакет' })).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Купить ещё 100 кредитов — 1 990 ₽' }),
    ).not.toBeInTheDocument()
  })

  it('promises nothing of tomorrow when the day is spent and the rest of the tariff is held', async () => {
    // Review of M5.33f: the day is spent and every tariff credit left is set aside for tasks in
    // work, so no credit of the tariff is free for tomorrow's day. The server does not refuse with
    // `daily_limit` then (that refusal implies a free tariff credit); the tile drops «завтра…».
    getUsage.mockResolvedValue(
      usageOf(
        { tariff: tariffOf({ credits: meterOf({ charged: 700, held: 100, left: 0 }) }) },
        { today: { charged: 0, held: 100 } },
      ),
    )
    showUsage()

    const limits = await section('Лимиты тарифа')
    expect(plain(limits.textContent)).toContain(
      `Кредиты по тарифу на сегодня закончились. ${outside}`,
    )
    expect(plain(limits.textContent)).not.toContain('завтра')
  })

  it('takes a task on a pack when the day of the tariff is spent', async () => {
    getUsage.mockResolvedValue(usageOf({}, { today: { charged: 100 } }))
    showUsage()

    const limits = await section('Лимиты тарифа')
    expect(plain(limits.textContent)).toContain('Сегодня100 из 100 кредитов')
    expect(within(await section('Кредиты')).queryByRole('status')).not.toBeInTheDocument()
  })

  it('says nothing of the day when the tariff has nothing left: the credits say so', async () => {
    getUsage.mockResolvedValue(outOfCredits({}, { today: { charged: 0, held: 0 } }))
    showUsage()

    const limits = await section('Лимиты тарифа')
    expect(plain(limits.textContent)).toContain('Сегодня0 из 100 кредитов')
    expect(plain(limits.textContent)).not.toContain('Сегодня можно потратить')
    expect(plain(limits.textContent)).toContain(outside)
    // Review of M5.33d: the meter says what the tariff can give today — nothing — and fills none.
    expect(
      tones(
        within(limits).getByRole('img', {
          name: 'Сегодня из 100 кредитов: 0 списано, 0 отложено под задачи в работе, 0 осталось',
        }),
      ),
    ).toEqual([])
  })

  // Review of M5.33d: with the month spent, tomorrow gives nothing until the next period.
  it('promises nothing of tomorrow once the day and the month are both spent', async () => {
    getUsage.mockResolvedValue(outOfCredits({}, { today: { charged: 100 } }))
    showUsage()

    const limits = await section('Лимиты тарифа')
    expect(plain(limits.textContent)).toContain('Сегодня100 из 100 кредитов')
    expect(plain(limits.textContent)).toContain(
      `Кредиты по тарифу на сегодня закончились. ${outside}`,
    )
    expect(plain(limits.textContent)).not.toContain('завтра')
  })

  it('draws no meter for a day without a limit', async () => {
    getUsage.mockResolvedValue(
      usageOf({
        subscription: subscriptionTo({ plan: { ...subscriptionTo().plan, creditsPerDay: null } }),
      }),
    )
    showUsage()

    const limits = await section('Лимиты тарифа')
    expect(plain(limits.textContent)).toContain('Сегодня5 кредитов')
    expect(plain(limits.textContent)).toContain('Дневного лимита на вашем тарифе нет.')
    expect(texts(within(limits).getAllByRole('img'))).toHaveLength(1)
    expect(within(limits).getByRole('img', { name: 'Добавлено 2 сайта из 3' })).toBeVisible()
  })
})

describe('the credits by site', () => {
  it('draws a bar for each site with its number beside it', async () => {
    showUsage()

    const bySite = await section('По сайтам')
    expect(plain(bySite.textContent)).toContain('Кредиты, списанные за текущий период.')
    const rows = within(within(bySite).getByRole('list', { name: 'По сайтам' })).getAllByRole(
      'listitem',
    )
    expect(texts(rows)).toEqual(['Пекарня «Добро»21 кредит', 'Кофейня на Лесной13 кредитов'])
    // The widest bar is the busiest site; the others are measured against it.
    const widths = rows.map((row) => {
      const bar = row.querySelector('[aria-hidden="true"] > span')
      return bar ? getComputedStyle(bar).width : ''
    })
    expect(widths[0]).toBe('100%')
    expect(Number.parseFloat(widths[1] ?? '')).toBeCloseTo((13 / 21) * 100, 5)
  })

  it('says in one line that nothing is charged yet', async () => {
    getUsage.mockResolvedValue(usageOf({ tariff: tariffOf({ bySite: [] }) }))
    showUsage()

    const bySite = await section('По сайтам')
    expect(plain(bySite.textContent)).toBe('По сайтамВ этом периоде кредиты ещё не списывались.')
    expect(within(bySite).queryByRole('list')).not.toBeInTheDocument()
  })
})

describe('the history of charges', () => {
  const rowsOf = (history: HTMLElement) =>
    within(within(history).getByRole('table', { name: 'История списаний' }))
      .getAllByRole('row')
      .map((row) =>
        texts(within(row).getAllByRole(row.querySelector('th') ? 'columnheader' : 'cell')),
      )

  it('lists the tasks of the period with what each one cost', async () => {
    showUsage()

    const history = await section('История списаний')
    expect(plain(history.textContent)).toContain(
      'Сколько кредитов ушло на каждую задачу. Списываем только за выполненные задачи; уточнения и «Изменить» считаются вместе с задачей. «Отменить» — бесплатно.',
    )
    expect(rowsOf(history)).toEqual([
      ['Дата', 'Задача', 'Сайт', 'Списано'],
      [
        '4 октября',
        'Обновить цены в разделе «Торты на заказ»',
        'Пекарня «Добро»',
        'В работеОтложено до 45 кредитов — спишем по факту',
      ],
      ['3 октября', 'Заменить фото на главной', 'Кофейня на Лесной', '5 кредитов'],
      ['3 октября', 'Вернуть прежний баннерОтмена правки', 'Кофейня на Лесной', 'Бесплатно'],
      ['2 октября', 'Добавить страницу «Доставка»Не получилось', 'Пекарня «Добро»', 'Не списано'],
      [
        '1 октября',
        'Поправить часы работы в контактах',
        'Пекарня «Добро»',
        '17 кредитов5 по тарифу и 12 из пакета',
      ],
    ])
    // The lines are of the period named above them with its year: a date needs none.
    expect(plain(history.textContent)).not.toMatch(/октября 2026/)
    // In work is a label with a sign of its own, not only a word among the others.
    const labels = [...history.querySelectorAll('.MuiChip-root')]
    expect(labels.map((label) => label.textContent)).toEqual(['В работе'])
    expect(labels[0]?.querySelector('svg')).not.toBeNull()
    // The whole history of the period is here: nothing more to ask for.
    expect(within(history).queryByRole('button', { name: 'Показать ещё' })).not.toBeInTheDocument()
    expect(getHistory).not.toHaveBeenCalled()
  })

  it('names a task that has no description yet, and every way a task ends without a charge', async () => {
    getUsage.mockResolvedValue(
      usageOf({
        history: {
          items: [
            entry({
              outcome: 'held',
              credits: 21,
              from: { tariff: 0, gift: 0, pack: 21 },
              task: { id: ID(21), title: null, status: 'queued' },
            }),
            // Paid by one account, whichever: the line names no account.
            entry({ credits: 1200, from: { tariff: 0, gift: 0, pack: 1200 } }),
            entry({ credits: 43, from: { tariff: 5, gift: 35, pack: 3 } }),
            entry({
              outcome: 'unpaid',
              ...nothing,
              task: { id: ID(22), title: 'Обновить меню', status: 'cancelled' },
            }),
            entry({
              outcome: 'unpaid',
              ...nothing,
              task: { id: ID(23), title: 'Новая шапка', status: 'rolled_back' },
            }),
          ],
          nextCursor: null,
        },
      }),
    )
    showUsage()

    expect(rowsOf(await section('История списаний')).slice(1)).toEqual([
      [
        '3 октября',
        'Задача без описания',
        'Кофейня на Лесной',
        'В работеОтложено до 21 кредита — спишем по факту',
      ],
      ['3 октября', 'Заменил фото на главной', 'Кофейня на Лесной', '1 200 кредитов'],
      [
        '3 октября',
        'Заменил фото на главной',
        'Кофейня на Лесной',
        '43 кредита5 по тарифу, 35 подарочных и 3 из пакета',
      ],
      ['3 октября', 'Обновить менюЗадача отменена', 'Кофейня на Лесной', 'Не списано'],
      ['3 октября', 'Новая шапкаВернули сайт как было', 'Кофейня на Лесной', 'Не списано'],
    ])
    // A credit that came back or expired with its period is no line of the history.
    expect(pageText()).not.toMatch(/Кредит вернули|Кредит сгорел|Период тарифа закончился/)
  })

  it('says that nothing is charged yet instead of an empty table', async () => {
    getUsage.mockResolvedValue(usageOf({ tariff: tariffOf({ bySite: [] }), history: noHistory }))
    showUsage()

    const history = await section('История списаний')
    expect(plain(history.textContent)).toContain(
      'Списаний пока нет. Здесь появятся задачи и сколько кредитов ушло на каждую.',
    )
    expect(within(history).queryByRole('table')).not.toBeInTheDocument()
    expect(within(history).queryByRole('button')).not.toBeInTheDocument()
  })

  it('lets the keyboard reach the frame the table scrolls in', async () => {
    showUsage()

    const history = await section('История списаний')
    const frame = within(history).getByRole('group', { name: 'История списаний' })
    expect(frame).toHaveAttribute('tabindex', '0')
    expect(within(frame).getByRole('table')).toBeInTheDocument()
  })

  describe('«Показать ещё»', () => {
    const first = () => [entry({ task: { id: ID(31), title: 'Первая', status: 'done' } })]
    const page = (title: string, nextCursor: string | null): HistoryPage => ({
      items: [entry({ task: { id: ID(40 + nextEntry), title, status: 'done' } })],
      nextCursor,
    })
    const titles = (history: HTMLElement) =>
      rowsOf(history)
        .slice(1)
        .map((row) => row[1])

    beforeEach(() => {
      getUsage.mockResolvedValue(usageOf({ history: { items: first(), nextCursor: ID(501) } }))
    })

    it('asks for the page after the cursor and adds its lines, a page at a time', async () => {
      getHistory
        .mockResolvedValueOnce(page('Вторая', ID(502)))
        .mockResolvedValueOnce(page('Третья', null))
      showUsage()
      const history = await section('История списаний')
      expect(titles(history)).toEqual(['Первая'])
      // Nothing is asked before the customer asks.
      expect(getHistory).not.toHaveBeenCalled()

      fireEvent.click(within(history).getByRole('button', { name: 'Показать ещё' }))

      await waitFor(() => expect(titles(history)).toEqual(['Первая', 'Вторая']))
      expect(getHistory).toHaveBeenLastCalledWith({ cursor: ID(501) })

      fireEvent.click(within(history).getByRole('button', { name: 'Показать ещё' }))

      await waitFor(() => expect(titles(history)).toEqual(['Первая', 'Вторая', 'Третья']))
      expect(getHistory).toHaveBeenLastCalledWith({ cursor: ID(502) })
      expect(getHistory).toHaveBeenCalledTimes(2)
      // The last page: nothing more to show.
      expect(
        within(history).queryByRole('button', { name: 'Показать ещё' }),
      ).not.toBeInTheDocument()
    })

    it('says that the next page did not load and asks for it again', async () => {
      getHistory
        .mockRejectedValueOnce(new Error('Network unavailable'))
        .mockResolvedValueOnce(page('Вторая', null))
      showUsage()
      const history = await section('История списаний')

      fireEvent.click(within(history).getByRole('button', { name: 'Показать ещё' }))

      expect(await within(history).findByRole('alert')).toHaveTextContent(
        'Не удалось загрузить продолжение истории. Попробуйте ещё раз.',
      )
      // What is on the screen stays, and the button is there for another try.
      expect(titles(history)).toEqual(['Первая'])

      fireEvent.click(within(history).getByRole('button', { name: 'Показать ещё' }))

      await waitFor(() => expect(titles(history)).toEqual(['Первая', 'Вторая']))
      expect(getHistory.mock.calls).toEqual([[{ cursor: ID(501) }], [{ cursor: ID(501) }]])
      expect(within(history).queryByRole('alert')).not.toBeInTheDocument()
    })

    it('drops the lines it added when the summary is read anew, though the first page ends where it did', async () => {
      const inWork = 'В работеОтложено до 45 кредитов — спишем по факту'
      getHistory.mockResolvedValueOnce({
        items: [
          entry({
            outcome: 'held',
            credits: 45,
            from: { tariff: 45, gift: 0, pack: 0 },
            task: { id: ID(51), title: 'Вторая', status: 'running' },
          }),
        ],
        nextCursor: null,
      })
      const { queryClient } = showUsage()
      const history = await section('История списаний')
      fireEvent.click(within(history).getByRole('button', { name: 'Показать ещё' }))
      await waitFor(() => expect(titles(history)).toEqual(['Первая', 'Вторая']))
      expect(rowsOf(history).at(-1)?.[3]).toBe(inWork)

      // The task is done meanwhile. The summary is read anew a moment later — the dialog of
      // the pack was closed, the page was opened again — and brings the same first page.
      await new Promise((resolve) => setTimeout(resolve, 5))
      await queryClient.invalidateQueries({ queryKey: ['billing', 'usage'] })

      await waitFor(() => expect(titles(history)).toEqual(['Первая']))
      expect(getUsage).toHaveBeenCalledTimes(2)
      expect(history).not.toHaveTextContent('В работе')

      // Asked for again, the next page is read as it is now.
      getHistory.mockResolvedValueOnce(page('Вторая', null))
      fireEvent.click(within(history).getByRole('button', { name: 'Показать ещё' }))

      await waitFor(() => expect(titles(history)).toEqual(['Первая', 'Вторая']))
      expect(rowsOf(history).at(-1)?.[3]).toBe('5 кредитов')
      expect(getHistory.mock.calls).toEqual([[{ cursor: ID(501) }], [{ cursor: ID(501) }]])
    })

    it('keeps the lines it added while a refresh of the summary in the background fails', async () => {
      getHistory.mockResolvedValueOnce(page('Вторая', null))
      const { queryClient } = showUsage()
      const history = await section('История списаний')
      fireEvent.click(within(history).getByRole('button', { name: 'Показать ещё' }))
      await waitFor(() => expect(titles(history)).toEqual(['Первая', 'Вторая']))
      getUsage.mockRejectedValueOnce(new Error('Network unavailable'))

      await new Promise((resolve) => setTimeout(resolve, 5))
      await queryClient.invalidateQueries({ queryKey: ['billing', 'usage'] })

      await waitFor(() => expect(getUsage).toHaveBeenCalledTimes(2))
      // The summary on the screen is the one the lines continue.
      expect(titles(history)).toEqual(['Первая', 'Вторая'])
      expect(getHistory).toHaveBeenCalledTimes(1)
    })
  })
})

describe('the gift credits on «Использование»', () => {
  const headings = (region: HTMLElement) =>
    texts(within(region).getAllByRole('heading', { level: 3 }))

  it('shows them between the credits of the tariff and those of the pack, and counts them in what is left', async () => {
    getUsage.mockResolvedValue(usageOf({ gift: giftOf(35) }))
    showUsage()

    const credits = await section('Кредиты')
    // 765 of the tariff, 35 of the gift and 100 from a pack.
    expect(plain(within(credits).getByText('900').parentElement?.textContent)).toBe(
      '900кредитов осталось',
    )
    expect(headings(credits)).toEqual([
      'По тарифу — 765 из 800',
      'Подарочные — 35',
      'Из пакета — 100',
    ])
    const gift = within(credits).getByRole('heading', { level: 3, name: /Подарочные/ })
    expect(plain(gift.parentElement?.textContent)).toBe(
      'Подарочные — 35Не сгорают. Тратятся после кредитов по тарифу и раньше кредитов из пакета.',
    )
    // The pack waits for both.
    expect(plain(credits.textContent)).toContain(
      'Кредиты из пакета не сгорают. Начнут тратиться, когда закончатся кредиты по тарифу и подарочные.',
    )
    // The gift is no part of the quota of the period.
    expect(
      within(credits).getByRole('img', {
        name: 'Из 800 кредитов по тарифу: 34 списано, 1 отложено под задачи в работе, 765 осталось',
      }),
    ).toBeVisible()
  })

  it('says how many of them tasks in work have set aside', async () => {
    getUsage.mockResolvedValue(usageOf({ gift: giftOf(30, 5) }))
    showUsage()

    const gift = within(await section('Кредиты')).getByRole('heading', {
      level: 3,
      name: /Подарочные/,
    })
    expect(plain(gift.parentElement?.textContent)).toBe(
      'Подарочные — 30Не сгорают. Тратятся после кредитов по тарифу и раньше кредитов из пакета. Ещё 5 отложено под задачи в работе.',
    )
  })

  it('still shows a gift that is all set aside, and none that is used up or was never granted', async () => {
    getUsage.mockResolvedValue(usageOf({ gift: giftOf(0, 35) }))
    const first = showUsage()
    expect(headings(await section('Кредиты'))).toContain('Подарочные — 0')
    first.unmount()

    for (const gift of [giftOf(0), noGift]) {
      getUsage.mockResolvedValue(usageOf({ gift }))
      const view = showUsage()
      const credits = await section('Кредиты')
      expect(headings(credits)).toEqual(['По тарифу — 765 из 800', 'Из пакета — 100'])
      expect(plain(credits.textContent)).not.toMatch(/[Пп]одарочн/)
      view.unmount()
    }
  })

  it('tells where the pack stands once the tariff is used up and gift credits remain', async () => {
    getUsage.mockResolvedValue(outOfCredits({ gift: giftOf(35), pack: { left: 7, held: 0 } }))
    showUsage()

    const credits = await section('Кредиты')
    expect(plain(credits.textContent)).toContain(
      'Кредиты из пакета не сгорают. Начнут тратиться, когда закончатся подарочные кредиты.',
    )
    expect(plain(credits.textContent)).not.toContain('Сейчас задачи тратят их')
    // Credits are left: no notice of an end.
    expect(within(credits).queryByRole('status')).not.toBeInTheDocument()
  })

  it('counts the gift credits of an unpaid tariff as left, and says that tasks are taken on them', async () => {
    getUsage.mockResolvedValue(
      usageOf({ subscription: subscriptionTo({ status: 'past_due' }), gift: giftOf(35) }),
    )
    showUsage()

    const credits = await section('Кредиты')
    // 765 of the tariff are over with its period; the gift and the pack outlive it.
    expect(plain(within(credits).getByText('135').parentElement?.textContent)).toBe(
      '135кредитов осталось',
    )
    expect(headings(credits)).toEqual([
      'По тарифу — период закончился',
      'Подарочные — 35',
      'Из пакета — 100',
    ])
    expect(plain(within(credits).getByRole('status').textContent)).toBe(
      'Оплата тарифа не прошла. Пока она не пройдёт, новые задачи принимаются, только пока есть подарочные кредиты.',
    )
    expect(within(credits).getByRole('link', { name: 'К тарифам' })).toHaveAttribute(
      'href',
      '/settings/plans',
    )
    expect(plain(credits.textContent)).toContain(
      'Кредиты из пакета не сгорают. Станут доступны после оплаты тарифа.',
    )
    expect(plain((await section('Лимиты тарифа')).textContent)).toContain(
      'Пока тариф не оплачен, новые задачи принимаются, только пока есть подарочные кредиты.',
    )
    expect(pageText()).not.toContain('новые задачи не принимаются')
  })

  it('keeps the words of an unpaid tariff where the gift starts no task', async () => {
    getUsage.mockResolvedValue(
      usageOf({ subscription: subscriptionTo({ status: 'past_due' }), gift: giftOf(4) }),
    )
    showUsage()

    const credits = await section('Кредиты')
    expect(plain(within(credits).getByText('104').parentElement?.textContent)).toBe(
      '104кредита осталось',
    )
    expect(plain(within(credits).getByRole('status').textContent)).toBe(
      'Тариф «Бизнес» не оплачен, поэтому новые задачи не принимаются. Оплатите тариф — кредиты нового периода начислим сразу.',
    )
  })

  describe('of a customer without a tariff', () => {
    const state = async () => plain((await section('Тариф не выбран')).textContent)
    const onGift =
      'У вас 35 подарочных кредитов. Они не сгорают, а задачи принимаются, пока подарочные кредиты не закончатся. Здесь видно, сколько кредитов осталось и на что они ушли.'

    it('tells a new user, who has no workspace yet, of the gift they are promised', async () => {
      // Not granted yet: it is granted with the workspace, which the first site makes.
      getUsage.mockResolvedValue(noTariff(0, { left: 35, held: 0, granted: false }))
      showUsage()

      expect(await state()).toContain(onGift)
      expect(await state()).not.toContain('Кредиты входят в тариф')
      // The way to a tariff stays, and nothing is measured.
      expect(
        within(await section('Тариф не выбран')).getByRole('link', { name: 'Выбрать тариф' }),
      ).toHaveAttribute('href', '/settings/plans')
      expect(screen.queryByRole('img')).not.toBeInTheDocument()
      expect(texts(screen.getAllByRole('heading', { level: 2 }))).toEqual([
        'Тариф не выбран',
        'История списаний',
      ])
    })

    it('says the same once the gift is on the account, beside the credits of a pack', async () => {
      getUsage.mockResolvedValue(noTariff(100, giftOf(35)))
      showUsage()

      expect(await state()).toContain(onGift)
      expect(await state()).toContain(
        'У вас 100 кредитов из пакета. Они не сгорают и снова будут доступны, когда вы выберете тариф.',
      )
    })

    it.each([
      [
        'a gift that starts no task',
        giftOf(3),
        'Осталось 3 подарочных кредита, а на новую задачу нужно не меньше 5. Выберите тариф — подарочные кредиты сохранятся и прибавятся к кредитам тарифа.',
      ],
      [
        'a gift that is used up',
        giftOf(0),
        'Подарочные кредиты закончились. Чтобы ставить новые задачи, выберите тариф.',
      ],
      [
        'no gift at all',
        noGift,
        'Кредиты входят в тариф. Выберите тариф, чтобы ставить задачи: здесь появится, сколько кредитов осталось и на что они ушли.',
      ],
    ])('says of %s what the customer can do', async (_case, gift, text) => {
      getUsage.mockResolvedValue(noTariff(0, gift))
      showUsage()

      expect(await state()).toContain(text)
      expect(await state()).not.toContain('Без тарифа можно поставить')
    })
  })
})

describe('what stands in the way of a new task on «Использование»', () => {
  const noticeOf = async () =>
    plain(within(await section('Кредиты')).getByRole('status').textContent)

  it('says nothing while a task would be taken', async () => {
    showUsage()

    expect(within(await section('Кредиты')).queryByRole('status')).not.toBeInTheDocument()
  })

  it('says that the credits are set aside for tasks in work, and offers the pack to go on now', async () => {
    getUsage.mockResolvedValue(
      usageOf({
        tariff: tariffOf({ credits: meterOf({ charged: 710, held: 90 }) }),
        pack: { left: 0, held: 0 },
      }),
    )
    showUsage()

    expect(await noticeOf()).toBe(
      'Кредиты заняты задачами в работе: под них отложено 90. Когда задачи закончатся, спишем только то, что ушло на работу, остальное вернётся — и можно будет поставить новую. Чтобы не ждать, купите пакет — 100 кредитов за 1 990 ₽.',
    )
    const credits = await section('Кредиты')
    expect(texts(within(credits).getAllByRole('button'))).toEqual(['Купить пакет'])
    // Waiting is the other way out: no other tariff is offered for it.
    expect(within(credits).queryByRole('link', { name: 'Сменить тариф' })).not.toBeInTheDocument()
    // The credits did not run out: the meter is not drawn as an end.
    expect(tones(within(credits).getByRole('img'))).toEqual(['spent', 'held'])
  })

  it('counts credits of the period before among those that are set aside', async () => {
    getUsage.mockResolvedValue(
      usageOf({
        tariff: tariffOf({ credits: meterOf({ charged: 798, left: 2, heldEarlier: 45 }) }),
        pack: { left: 0, held: 0 },
      }),
    )
    showUsage()

    expect(await noticeOf()).toMatch(/^Кредиты заняты задачами в работе: под них отложено 45\./)
  })

  it('asks the customer to write when too much work of the period ended without a charge', async () => {
    getUsage.mockResolvedValue(usageOf({}, { unpaidWork: 800 }))
    showUsage()

    expect(await noticeOf()).toBe(
      'В этом периоде слишком много задач остановилось без результата, поэтому новые задачи временно не принимаются. Кредиты за них не списаны. Напишите нам — разберёмся, в чём дело.',
    )
    const credits = await section('Кредиты')
    expect(within(credits).queryByRole('button', { name: 'Купить пакет' })).not.toBeInTheDocument()
    expect(within(credits).queryByRole('link')).not.toBeInTheDocument()
  })

  it('says that tasks are paused while the calculation of credits is being updated', async () => {
    getUsage.mockResolvedValue(usageOf({}, { rateUsable: false }))
    showUsage()

    expect(await noticeOf()).toBe(
      'Задачи сейчас не принимаются: мы обновляем расчёт кредитов. Попробуйте ещё раз немного позже.',
    )
    // Nothing the customer pays for lifts it; the credits are shown as they are.
    const credits = await section('Кредиты')
    expect(within(credits).queryByRole('link')).not.toBeInTheDocument()
    expect(plain(within(credits).getByText('865').parentElement?.textContent)).toBe(
      '865кредитов осталось',
    )
  })

  it('counts no day for an unpaid tariff: the gift carries the tasks', async () => {
    getUsage.mockResolvedValue(
      usageOf(
        { subscription: subscriptionTo({ status: 'past_due' }), gift: giftOf(20) },
        { today: { charged: 500 } },
      ),
    )
    showUsage()

    // No refusal: the notice is that of the tariff that is not paid.
    expect(await noticeOf()).toBe(
      'Оплата тарифа не прошла. Пока она не пройдёт, новые задачи принимаются, только пока есть подарочные кредиты.',
    )
    const limits = plain((await section('Лимиты тарифа')).textContent)
    expect(limits).toContain(
      'Пока тариф не оплачен, новые задачи принимаются, только пока есть подарочные кредиты.',
    )
    // The tile has no number and no meter of the day.
    expect(limits).not.toMatch(/из 100 кредитов/)
    expect(pageText()).not.toContain('Новые задачи не принимаются')
  })

  it('tells an unpaid tariff that the gift is set aside, and not that no task is taken until the payment', async () => {
    getUsage.mockResolvedValue(
      usageOf({ subscription: subscriptionTo({ status: 'past_due' }), gift: giftOf(0, 35) }),
    )
    showUsage()

    expect(await noticeOf()).toBe(
      'Подарочные кредиты заняты задачей в работе: под неё отложено 35. Когда она закончится, спишем только то, что ушло на работу, остальное вернётся — и можно будет поставить следующую.',
    )
    expect(plain((await section('Лимиты тарифа')).textContent)).toContain(
      'Пока тариф не оплачен, новые задачи принимаются, только пока есть подарочные кредиты.',
    )
    expect(pageText()).not.toContain('Новые задачи не принимаются')
  })

  it('tells an unpaid tariff that no task is taken until the payment when only the payment helps', async () => {
    // The gift is left, and too much work ended without a charge.
    getUsage.mockResolvedValue(
      usageOf(
        { subscription: subscriptionTo({ status: 'past_due' }), gift: giftOf(15) },
        { unpaidWork: 70 },
      ),
    )
    showUsage()

    expect(await noticeOf()).toMatch(
      /^Пробные задачи закончились: .+ Оплатите тариф, чтобы продолжить; /,
    )
    expect(plain((await section('Лимиты тарифа')).textContent)).toContain(
      'Новые задачи не принимаются, пока не оплачен тариф.',
    )
  })

  describe('without a tariff', () => {
    const state = async () => plain((await section('Тариф не выбран')).textContent)

    it('tells of no day: the gift is the bound', async () => {
      getUsage.mockResolvedValue(noTariff(0, giftOf(20), noHistory, { today: { charged: 500 } }))
      showUsage()

      expect(await state()).toContain(
        'У вас 20 подарочных кредитов. Они не сгорают, а задачи принимаются, пока подарочные кредиты не закончатся.',
      )
      expect(await state()).not.toMatch(/в день/)
    })

    it('tells that the trial is over, and what a tariff keeps', async () => {
      getUsage.mockResolvedValue(noTariff(0, giftOf(15), noHistory, { unpaidWork: 70 }))
      showUsage()

      expect(await state()).toContain(
        'Пробные задачи закончились: несколько задач остановились без результата, и без тарифа мы больше не можем их принимать. Выберите тариф, чтобы продолжить; оставшиеся 15 подарочных кредитов сохранятся.',
      )
    })

    it('tells that the gift is set aside for the task in work', async () => {
      getUsage.mockResolvedValue(noTariff(0, giftOf(0, 35)))
      showUsage()

      expect(await state()).toContain(
        'Подарочные кредиты заняты задачей в работе: под неё отложено 35. Когда она закончится, спишем только то, что ушло на работу, остальное вернётся — и можно будет поставить следующую.',
      )
      expect(await state()).not.toContain('закончились')
    })

    it('says what the customer has before the pause of the platform', async () => {
      getUsage.mockResolvedValue(noTariff(0, giftOf(35), noHistory, { rateUsable: false }))
      showUsage()

      expect(await state()).toContain(
        'У вас 35 подарочных кредитов. Задачи сейчас не принимаются: мы обновляем расчёт кредитов. Попробуйте ещё раз немного позже.',
      )
      expect(await state()).not.toContain('Без тарифа можно поставить')
    })
  })
})
