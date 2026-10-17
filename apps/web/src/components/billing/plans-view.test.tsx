// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AutoRenewalCancel,
  AutoRenewalResume,
  BillingOverview,
  MethodBinding,
  PackOffer,
  Subscription,
} from './billing-types'
import { PlansView } from './plans-view'
import {
  agencyPlan,
  creditBalances,
  offers,
  ONE_TIME_ONLY,
  overviewOf,
  plain,
  serverRefusal,
  subscriptionTo,
} from './testing'

/** What `billing.plans` answers; the pack is null when none is on sale. */
type Offers = Omit<ReturnType<typeof offers>, 'pack'> & { pack: PackOffer | null }
type CheckoutRequest = { planSlug: string; autoRenew: boolean }
type Checkout = { orderId: string; confirmationUrl: string }

type Nothing = Record<string, never>

const {
  getOverview,
  getOffers,
  startCheckout,
  startPackCheckout,
  startPastDuePayment,
  cancelAutoRenew,
  resumeAutoRenew,
  schedulePlanChange,
  cancelPlanChange,
  syncMethod,
  hardNavigate,
} = vi.hoisted(() => ({
  getOverview: vi.fn<() => Promise<BillingOverview>>(),
  getOffers: vi.fn<() => Promise<Offers>>(),
  startCheckout: vi.fn<(input: CheckoutRequest) => Promise<Checkout>>(),
  startPackCheckout: vi.fn<(input: Nothing) => Promise<Checkout>>(),
  startPastDuePayment: vi.fn<(input: Nothing) => Promise<Checkout>>(),
  cancelAutoRenew: vi.fn<(input: Nothing) => Promise<AutoRenewalCancel>>(),
  resumeAutoRenew: vi.fn<(input: Nothing) => Promise<AutoRenewalResume>>(),
  schedulePlanChange: vi.fn<(input: { planSlug: string }) => Promise<Subscription>>(),
  cancelPlanChange: vi.fn<(input: Nothing) => Promise<Subscription>>(),
  syncMethod: vi.fn<(input: Nothing) => Promise<MethodBinding>>(),
  hardNavigate: vi.fn<(path: string) => void>(),
}))

vi.mock('@/lib/hard-navigate', () => ({ hardNavigate }))

/** A mutation of the router that runs `mutationFn` with the options the page gives it. */
const mutation =
  <Answer, Input>(mutationFn: (input: Input) => Promise<Answer>) =>
  (options: UseMutationOptions<Answer, Error, Input>) => ({ ...options, mutationFn })

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    billing: {
      overview: {
        queryKey: () => ['billing', 'overview'],
        queryOptions: () => ({ queryKey: ['billing', 'overview'], queryFn: getOverview }),
      },
      plans: {
        queryKey: () => ['billing', 'plans'],
        queryOptions: () => ({ queryKey: ['billing', 'plans'], queryFn: getOffers }),
      },
      usage: { queryKey: () => ['billing', 'usage'] },
      startCheckout: { mutationOptions: mutation(startCheckout) },
      startPackCheckout: { mutationOptions: mutation(startPackCheckout) },
      startPastDuePayment: { mutationOptions: mutation(startPastDuePayment) },
      cancelAutoRenew: { mutationOptions: mutation(cancelAutoRenew) },
      resumeAutoRenew: { mutationOptions: mutation(resumeAutoRenew) },
      schedulePlanChange: { mutationOptions: mutation(schedulePlanChange) },
      cancelPlanChange: { mutationOptions: mutation(cancelPlanChange) },
    },
  }),
  useTRPCClient: () => ({ billing: { syncPaymentMethod: { mutate: syncMethod } } }),
}))

function showPlansOnce() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <PlansView email="anna@example.ru" />
    </QueryClientProvider>,
  )
}
/** Shows the page; a test that shows it twice takes the view of `showPlansOnce` to unmount. */
function showPlans() {
  showPlansOnce()
}

/** The card of a tariff in the grid. */
async function planCard(name: string): Promise<HTMLElement> {
  const grid = await screen.findByRole('list', { name: 'Тарифы' })
  const card = within(grid).getByRole('heading', { level: 3, name }).closest('li')
  if (!card) throw new Error(`no card for the tariff ${name}`)
  return card
}

/** The value of a row of the customer's tariff, as it reads; a link beside it is not the value. */
function row(label: string): string {
  const value = screen.getByText(label).nextElementSibling?.cloneNode(true) as Element | undefined
  if (!value) throw new Error(`the row «${label}» has no value`)
  for (const link of value.querySelectorAll('a')) link.remove()
  return plain(value.textContent)
}

const pageText = () => plain(document.body.textContent)

/** A button as a screen reader names it: its `aria-label` when it has one, else its text. */
const buttonName = (button: HTMLElement) =>
  plain(button.getAttribute('aria-label') ?? button.textContent)

beforeEach(() => {
  vi.clearAllMocks()
  getOverview.mockResolvedValue(overviewOf())
  getOffers.mockResolvedValue(offers())
})

describe('the «Тарифы» page while its data is on the way', () => {
  it('shows a placeholder until both answers arrive', async () => {
    let answer!: (offers: Offers) => void
    getOffers.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    showPlans()

    expect(screen.getByRole('heading', { level: 1, name: 'Тарифы' })).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Загрузка тарифов' })).toBeInTheDocument()
    // The tariff of the customer is not shown before the tariffs on sale: one page, one state.
    await waitFor(() => expect(getOverview).toHaveBeenCalled())
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()

    answer(offers())

    expect(await screen.findByRole('heading', { level: 2, name: 'Выберите тариф' })).toBeVisible()
    expect(screen.queryByRole('status', { name: 'Загрузка тарифов' })).not.toBeInTheDocument()
  })

  it('offers a retry when an answer fails, and shows the page after it', async () => {
    getOverview.mockRejectedValueOnce(new Error('Network unavailable'))
    showPlans()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось загрузить тарифы. Попробуйте ещё раз.',
    )
    expect(screen.queryByRole('list', { name: 'Тарифы' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Выбрать/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))

    expect(await screen.findByRole('list', { name: 'Тарифы' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // Only the answer that failed is asked for again.
    expect(getOverview).toHaveBeenCalledTimes(2)
    expect(getOffers).toHaveBeenCalledTimes(1)
  })
})

describe('the «Тарифы» page of a customer without a tariff', () => {
  it('lists the tariffs on sale with a button for each', async () => {
    showPlans()

    expect(await screen.findByRole('heading', { level: 2, name: 'Выберите тариф' })).toBeVisible()
    expect(pageText()).toContain('Выберите тариф, чтобы начать ставить задачи.')
    // What a task costs, in the numbers of the credits model.
    expect(pageText()).toContain(
      'Задача стоит столько кредитов, сколько работы она потребовала, но не меньше 5: небольшая правка текста, цены или фото — обычно 5 кредитов, добавить блок или страницу — 15–25. Кредиты списываются только за выполненную задачу. Уточнения и «Изменить» — часть той же задачи: работа над ними добавляется к её стоимости. «Отменить» — бесплатно.',
    )
    expect(pageText()).not.toMatch(/один кредит/)

    const grid = screen.getByRole('list', { name: 'Тарифы' })
    expect(
      within(grid)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(['Старт', 'Бизнес', 'Агентство'])

    const card = await planCard('Бизнес')
    expect(plain(card.textContent)).toContain('Когда задач становится больше')
    expect(plain(card.textContent)).toContain('12 900 ₽/ месяц')
    expect(
      within(card)
        .getAllByRole('listitem')
        .map((item) => plain(item.textContent)),
    ).toEqual([
      '800 кредитов в месяц',
      'В среднем около 73 задач',
      'До 100 кредитов в день',
      'До 3 сайтов на WordPress',
    ])
    expect(
      within(await planCard('Старт'))
        .getAllByRole('listitem')
        .map((item) => plain(item.textContent)),
    ).toEqual([
      '300 кредитов в месяц',
      'В среднем около 27 задач',
      'До 50 кредитов в день',
      'Один сайт на WordPress',
    ])
    // A count of four digits is grouped, and a line never parts its groups.
    const largest = within(await planCard('Агентство')).getAllByRole('listitem')
    expect(largest.map((item) => plain(item.textContent))).toEqual([
      '2 500 кредитов в месяц',
      'В среднем около 230 задач',
      'До 300 кредитов в день',
      'До 15 сайтов на WordPress',
    ])
    expect(largest[0]?.textContent).toBe('2\u00a0500\u00a0кредитов в\u00a0месяц')

    for (const name of ['Старт', 'Бизнес', 'Агентство']) {
      expect(
        within(await planCard(name)).getByRole('button', { name: `Выбрать «${name}»` }),
      ).toBeEnabled()
    }
    // No tariff of the customer's own: none of its rows.
    expect(screen.queryByText('Способ оплаты')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Автопродление' })).not.toBeInTheDocument()
  })

  it('suggests the cheapest tariff and makes its button the main one', async () => {
    showPlans()

    const suggested = await planCard('Старт')
    expect(within(suggested).getByText('Подходит вам')).toBeInTheDocument()
    expect(within(suggested).getByRole('button')).toHaveClass('MuiButton-contained')
    for (const name of ['Бизнес', 'Агентство']) {
      const card = await planCard(name)
      expect(within(card).queryByText('Подходит вам')).not.toBeInTheDocument()
      expect(within(card).getByRole('button')).toHaveClass('MuiButton-outlined')
    }
    expect(screen.queryByText('Ваш тариф')).not.toBeInTheDocument()
  })

  it('explains instead of a button why a tariff does not fit the sites', async () => {
    getOffers.mockResolvedValue(offers({ siteCount: 2 }))
    showPlans()

    const tooSmall = await planCard('Старт')
    expect(plain(tooSmall.textContent)).toContain(
      'Не подойдёт: у вас два сайта, а тариф рассчитан на один.',
    )
    expect(within(tooSmall).queryByRole('button')).not.toBeInTheDocument()
    expect(within(tooSmall).queryByText('Подходит вам')).not.toBeInTheDocument()

    // The suggestion moves to the first tariff that holds the sites.
    const suggested = await planCard('Бизнес')
    expect(within(suggested).getByText('Подходит вам')).toBeInTheDocument()
    expect(within(suggested).getByRole('button', { name: 'Выбрать «Бизнес»' })).toHaveClass(
      'MuiButton-contained',
    )
    expect(
      within(await planCard('Агентство')).getByRole('button', { name: 'Выбрать «Агентство»' }),
    ).toHaveClass('MuiButton-outlined')
  })

  it('suggests nothing when no tariff holds the sites', async () => {
    getOffers.mockResolvedValue(offers({ siteCount: 16 }))
    showPlans()

    expect(plain((await planCard('Агентство')).textContent)).toContain(
      'Не подойдёт: у вас 16 сайтов, а тариф рассчитан на 15.',
    )
    expect(screen.queryByText('Подходит вам')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Выбрать/ })).not.toBeInTheDocument()
  })

  it('says who can pay, how, and links the public offer', async () => {
    showPlans()
    await screen.findByRole('list', { name: 'Тарифы' })

    expect(pageText()).toContain(
      'Цены в рублях. Оплата проходит на странице ЮKassa: картой, через СБП или SberPay. Оплата принимается только с личной карты; счета и закрывающие документы для организаций не выдаём.',
    )
    expect(screen.getByRole('link', { name: 'Публичная оферта' })).toHaveAttribute(
      'href',
      '/terms/public-offer',
    )
    expect(pageText()).not.toMatch(/НДС|чек/i)
  })

  it('draws nothing that cannot be bought yet', async () => {
    showPlans()
    await screen.findByRole('list', { name: 'Тарифы' })

    // A pack is sold on top of a tariff, and pay-per-action comes with a later slice: no rows
    // and no dead buttons.
    expect(pageText()).not.toMatch(/Пакет|Оплата за действие|Купить/)
    expect(
      screen
        .getAllByRole('button')
        .map((button) => button.textContent)
        .sort(),
    ).toEqual(['Выбрать «Агентство»', 'Выбрать «Бизнес»', 'Выбрать «Старт»'])
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Публичная оферта',
    ])
  })

  it('says so when no tariff is on sale', async () => {
    getOffers.mockResolvedValue({ ...offers(), plans: [] })
    showPlans()

    expect(await screen.findByText(/Сейчас тарифы не продаются/)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Тарифы' })).not.toBeInTheDocument()
  })
})

describe('the «Тарифы» page while payments are switched off', () => {
  it('shows the tariffs without buttons and says once that nothing can be paid for', async () => {
    getOverview.mockResolvedValue(overviewOf({ paymentsEnabled: false }))
    showPlans()

    expect(await screen.findByRole('list', { name: 'Тарифы' })).toBeInTheDocument()
    expect(screen.getAllByText('Оплата пока недоступна.')).toHaveLength(1)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Все тарифы' })).toBeInTheDocument()
    expect(pageText()).not.toContain('Выберите тариф')
    expect(pageText()).toContain('12 900 ₽')
  })
})

describe('the «Тарифы» page of a customer with a tariff', () => {
  function subscribed(patch: Parameters<typeof subscriptionTo>[0] = {}, credits = [45, 10]) {
    getOverview.mockResolvedValue(
      overviewOf({
        subscription: subscriptionTo(patch),
        credits: creditBalances(credits[0] ?? 0, credits[1] ?? 0),
      }),
    )
    getOffers.mockResolvedValue(offers({ siteCount: 2, current: 'business' }))
  }

  it('shows an active tariff with the next charge, the payment method and the credits', async () => {
    subscribed()
    showPlans()

    const block = (
      await screen.findByRole('heading', { level: 2, name: 'Тариф «Бизнес»' })
    ).closest('section')
    if (!block) throw new Error('the tariff has no section')
    expect(plain(block.textContent)).toContain(
      '800 кредитов в месяц, до 100 кредитов в день · до 3 сайтов на WordPress',
    )
    expect(plain(block.textContent)).toContain('12 900 ₽ в месяц')
    // The status is words and an icon, never a colour alone.
    const chip = within(block).getByText('Активен').closest('.MuiChip-root')
    expect(chip?.querySelector('svg')).not.toBeNull()

    expect(row('Следующее списание')).toBe('18 октября 2026 — 12 900 ₽')
    expect(row('Способ оплаты')).toBe('Карта «Мир» •• 4444')
    expect(row('Кредиты')).toBe('Осталось 55: 45 по тарифу и 10 из пакета')
    expect(screen.queryByText('Действует до')).not.toBeInTheDocument()
    expect(pageText()).toContain('Ваш тариф и автопродление.')
  })

  it('tells what auto-renewal will do and where the letter goes', async () => {
    subscribed()
    showPlans()

    const section = (await screen.findByRole('heading', { level: 2, name: 'Автопродление' }))
      .parentElement
    expect(plain(section?.textContent)).toContain(
      'Включено. 18 октября спишем 12 900 ₽ сохранённым способом оплаты и начислим 800 кредитов на новый период. Перед списанием пришлём письмо на anna@example.ru.',
    )
  })

  it('marks the tariff in the grid as the customer`s own and offers no tariff to buy again', async () => {
    subscribed()
    showPlans()

    const own = await planCard('Бизнес')
    expect(within(own).getByText('Ваш тариф')).toBeInTheDocument()
    expect(plain(own.textContent)).toContain('Продлится 18 октября.')
    expect(screen.getAllByText('Ваш тариф')).toHaveLength(1)
    expect(screen.queryByText('Подходит вам')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Все тарифы' })).toBeInTheDocument()
    // A tariff the sites do not fit says so here as well.
    expect(plain((await planCard('Старт')).textContent)).toContain('Не подойдёт: у вас два сайта')
    // Nothing is bought again: the other tariff that fits is offered for the next period, the
    // pack on top of this one, and auto-renewal can be switched off.
    expect(screen.getAllByRole('button').map(buttonName)).toEqual([
      'Перейти на тариф «Агентство»',
      'Купить пакет',
      'Отключить автопродление',
    ])
    expect(pageText()).not.toMatch(/Выбрать «/)
    // «Оплата» and «Использование» are one step away, each from the row it is about.
    expect(
      screen.getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')]),
    ).toEqual([
      ['Изменить', '/settings/billing'],
      ['Подробнее', '/settings/usage'],
      ['Публичная оферта', '/terms/public-offer'],
    ])
    expect(
      within(screen.getByText('Способ оплаты').parentElement as HTMLElement).getByRole('link', {
        name: 'Изменить способ оплаты',
      }),
    ).toHaveAttribute('href', '/settings/billing')
    expect(
      within(screen.getByText('Кредиты').parentElement as HTMLElement).getByRole('link', {
        name: 'Подробнее о кредитах',
      }),
    ).toHaveAttribute('href', '/settings/usage')
  })

  it('leads a customer without a saved payment method to «Оплата» as well', async () => {
    subscribed({ autoRenewal: false, paymentMethod: null })
    showPlans()

    await screen.findByRole('heading', { level: 2, name: 'Тариф «Бизнес»' })
    expect(row('Способ оплаты')).toBe('Не сохранён')
    expect(screen.getByRole('link', { name: 'Изменить способ оплаты' })).toHaveAttribute(
      'href',
      '/settings/billing',
    )
  })

  it('leads such a customer there while payments are off as well: no shop has said what it saves', async () => {
    subscribed()
    // The link goes only where a shop takes one-time payments only; without a shop it stays.
    getOverview.mockResolvedValue(
      overviewOf({
        paymentsEnabled: false,
        subscription: subscriptionTo({ autoRenewal: false, paymentMethod: null }),
      }),
    )
    showPlans()

    await screen.findByRole('heading', { level: 2, name: 'Тариф «Бизнес»' })
    expect(row('Способ оплаты')).toBe('Не сохранён')
    expect(screen.getByRole('link', { name: 'Изменить способ оплаты' })).toHaveAttribute(
      'href',
      '/settings/billing',
    )
  })

  it('suggests no other tariff to a customer who has one', async () => {
    subscribed()
    // No sites: «Старт» would be the suggestion of a customer without a tariff.
    getOffers.mockResolvedValue(offers({ siteCount: 0, current: 'business' }))
    showPlans()

    expect(within(await planCard('Бизнес')).getByText('Ваш тариф')).toBeInTheDocument()
    expect(screen.queryByText('Подходит вам')).not.toBeInTheDocument()
    expect(within(await planCard('Старт')).queryByText(/Ваш тариф|Подходит/)).toBeNull()
  })

  it('counts as left only the credits that no task has reserved', async () => {
    getOverview.mockResolvedValue(
      overviewOf({
        subscription: subscriptionTo(),
        credits: {
          tariff: { balance: 45, held: 5, available: 40 },
          gift: { balance: 0, held: 0, available: 0, granted: false },
          pack: { balance: 10, held: 2, available: 8 },
          totalAvailable: 48,
        },
      }),
    )
    getOffers.mockResolvedValue(offers({ current: 'business' }))
    showPlans()

    await screen.findByRole('heading', { level: 2, name: 'Тариф «Бизнес»' })
    expect(row('Кредиты')).toBe('Осталось 48: 40 по тарифу и 8 из пакета')
  })

  it('charges the price of the scheduled tariff at the next renewal', async () => {
    subscribed({ nextPlan: agencyPlan })
    showPlans()

    await screen.findByRole('heading', { level: 2, name: 'Тариф «Бизнес»' })
    expect(row('Следующее списание')).toBe('18 октября 2026 — 39 900 ₽')
    expect(pageText()).toContain(
      'Включено. С 18 октября — тариф «Агентство»: спишем 39 900 ₽ сохранённым способом оплаты и начислим 2 500 кредитов на новый период.',
    )
    // The card of the tariff that gives way promises no renewal of its own.
    const own = plain((await planCard('Бизнес')).textContent)
    expect(own).toContain('Действует до 18 октября.')
    expect(own).not.toContain('Продлится')
    expect(plain((await planCard('Агентство')).textContent)).not.toMatch(/Продлится|Действует до/)
  })

  it('shows until when a tariff without auto-renewal lasts and what stays after it', async () => {
    subscribed({ autoRenewal: false, paymentMethod: null })
    showPlans()

    const block = (
      await screen.findByRole('heading', { level: 2, name: 'Тариф «Бизнес»' })
    ).closest('section')
    if (!block) throw new Error('the tariff has no section')
    const chip = within(block)
      .getByText(/^До 18.октября$/)
      .closest('.MuiChip-root')
    expect(chip?.querySelector('svg')).not.toBeNull()
    expect(plain(block.textContent)).toContain(
      'Автопродление отключено. Тариф и 45 кредитов по тарифу доступны до 18 октября 2026. После этого новые задачи не принимаются, пока вы снова не выберете тариф. 10 кредитов из пакета, сайты и история правок сохранятся.',
    )
    expect(row('Действует до')).toBe('18 октября 2026')
    expect(row('Способ оплаты')).toBe('Не сохранён')
    expect(screen.queryByText('Следующее списание')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Автопродление' })).not.toBeInTheDocument()
    expect(plain((await planCard('Бизнес')).textContent)).toContain('Действует до 18 октября.')
    // The tariff still takes tasks, so a pack can be bought, and another tariff chosen.
    expect(screen.getAllByRole('button').map(buttonName)).toEqual([
      'Включить автопродление',
      'Перейти на тариф «Агентство»',
      'Купить пакет',
    ])
  })

  it('offers no purchase while payments are switched off either: only the way to stop the charges', async () => {
    subscribed()
    getOverview.mockResolvedValue(
      overviewOf({ paymentsEnabled: false, subscription: subscriptionTo() }),
    )
    showPlans()

    await screen.findByRole('heading', { level: 2, name: 'Тариф «Бизнес»' })
    // Switching auto-renewal off asks nothing of the shop.
    expect(screen.getAllByRole('button').map((button) => plain(button.textContent))).toEqual([
      'Отключить автопродление',
    ])
    // The line is for a customer who came to buy: this one has a tariff.
    expect(screen.queryByText('Оплата пока недоступна.')).not.toBeInTheDocument()
  })
})

describe('choosing a tariff', () => {
  it('opens the checkout of the chosen tariff and returns the focus to its button on close', async () => {
    showPlans()
    const opener = within(await planCard('Бизнес')).getByRole('button', {
      name: 'Выбрать «Бизнес»',
    })
    opener.focus()
    fireEvent.click(opener)

    const dialog = await screen.findByRole('dialog', { name: 'Тариф «Бизнес»' })
    expect(plain(dialog.textContent)).toContain('12 900 ₽')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(opener).toHaveFocus()
    expect(startCheckout).not.toHaveBeenCalled()
  })

  it('starts every checkout with the consent to auto-renewal unticked', async () => {
    showPlans()
    fireEvent.click(
      within(await planCard('Бизнес')).getByRole('button', { name: 'Выбрать «Бизнес»' }),
    )
    let dialog = await screen.findByRole('dialog', { name: 'Тариф «Бизнес»' })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Продлевать автоматически' }))
    expect(within(dialog).getByRole('checkbox')).toBeChecked()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // Another tariff, and then the same one again: the tick is never carried over.
    for (const name of ['Агентство', 'Бизнес']) {
      fireEvent.click(
        within(await planCard(name)).getByRole('button', { name: `Выбрать «${name}»` }),
      )
      dialog = await screen.findByRole('dialog', { name: `Тариф «${name}»` })
      expect(within(dialog).getByRole('checkbox')).not.toBeChecked()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    }
  })

  it('pays for the tariff whose button was pressed', async () => {
    startCheckout.mockResolvedValue({
      orderId: '018f0000-0000-7000-8000-0000000000aa',
      confirmationUrl: 'https://yookassa.example/pay/1',
    })
    showPlans()
    fireEvent.click(
      within(await planCard('Агентство')).getByRole('button', { name: 'Выбрать «Агентство»' }),
    )
    const dialog = await screen.findByRole('dialog', { name: 'Тариф «Агентство»' })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Перейти к оплате' }))

    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('https://yookassa.example/pay/1'))
    expect(startCheckout).toHaveBeenCalledWith(
      { planSlug: 'agency', autoRenew: false },
      expect.anything(),
    )
  })

  it('refreshes the page behind the dialog when the checkout is refused', async () => {
    startCheckout.mockRejectedValue(
      serverRefusal(
        'Тариф уже оформлен. Обновите страницу, чтобы увидеть его',
        'BILLING_SUBSCRIPTION_EXISTS',
      ),
    )
    showPlans()
    fireEvent.click(
      within(await planCard('Бизнес')).getByRole('button', { name: 'Выбрать «Бизнес»' }),
    )
    const dialog = await screen.findByRole('dialog', { name: 'Тариф «Бизнес»' })
    getOverview.mockResolvedValue(overviewOf({ subscription: subscriptionTo() }))
    getOffers.mockResolvedValue(offers({ current: 'business' }))

    fireEvent.click(within(dialog).getByRole('button', { name: 'Перейти к оплате' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Тариф уже оформлен. Обновите страницу, чтобы увидеть его.',
    )
    // The tariff that is on already shows up without a reload.
    await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(2))
    expect(getOffers).toHaveBeenCalledTimes(2)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('heading', { level: 2, name: 'Тариф «Бизнес»' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Выбрать/ })).not.toBeInTheDocument()
    expect(hardNavigate).not.toHaveBeenCalled()
  })
})

describe('buying a pack of credits', () => {
  const packPage = 'https://yookassa.example/pay/pack'

  function subscribed(patch: Parameters<typeof subscriptionTo>[0] = {}) {
    getOverview.mockResolvedValue(
      overviewOf({ subscription: subscriptionTo(patch), credits: creditBalances(3, 0) }),
    )
    getOffers.mockResolvedValue(offers({ current: 'business' }))
  }

  const buy = () => screen.findByRole('button', { name: 'Купить пакет' })

  /** The row of the pack under the tariffs: its button and what stands beside it. */
  async function packRow(): Promise<HTMLElement> {
    const row = (await buy()).parentElement
    if (!row) throw new Error('the pack has no row')
    return row
  }

  beforeEach(() => {
    startPackCheckout.mockResolvedValue({
      orderId: '018f0000-0000-7000-8000-0000000000bb',
      confirmationUrl: packPage,
    })
  })

  it('offers the pack on sale to a customer whose tariff takes tasks', async () => {
    subscribed()
    showPlans()

    const row = await packRow()
    // The name and the price as the server sends them.
    expect(plain(within(row).getByRole('heading', { level: 3 }).textContent)).toBe(
      'Пакет из 100 кредитов — 1 990 ₽',
    )
    expect(plain(row.textContent)).toContain(
      'Пригодится, если кредиты по тарифу закончатся на сегодня или до конца периода: это в среднем около 9 задач. Добавим 100 кредитов сразу после оплаты. Кредиты из пакета не сгорают в конце периода.',
    )
    expect(within(row).getByRole('button', { name: 'Купить пакет' })).toBeEnabled()
    // In the section of the tariffs, under their grid.
    const section = screen.getByRole('heading', { level: 2, name: 'Все тарифы' }).closest('section')
    expect(section).toContainElement(row)
    expect(
      screen.getByRole('list', { name: 'Тарифы' }).compareDocumentPosition(row) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(pageText()).not.toMatch(/НДС|чек/i)
  })

  it('prints the pack that is on sale, whatever its name, size and price', async () => {
    subscribed()
    getOffers.mockResolvedValue({
      ...offers({ current: 'business' }),
      pack: {
        id: '018f0000-0000-7000-8000-000000000005',
        slug: 'pack-21',
        name: 'Большой пакет',
        price: '3490.00',
        credits: 21,
      },
    })
    showPlans()

    const row = await packRow()
    expect(plain(row.textContent)).toContain('Большой пакет — 3 490 ₽')
    expect(plain(row.textContent)).toContain('Добавим 21 кредит сразу после оплаты.')
  })

  it.each([
    ['has no tariff', () => getOverview.mockResolvedValue(overviewOf())],
    ['is overdue with the tariff', () => subscribed({ status: 'past_due' })],
    ['is on a trial, which takes no tasks', () => subscribed({ status: 'trial' })],
    [
      'cannot pay because payments are off',
      () =>
        getOverview.mockResolvedValue(
          overviewOf({ paymentsEnabled: false, subscription: subscriptionTo() }),
        ),
    ],
  ])('does not offer the pack to a customer who %s', async (_case, arrange) => {
    subscribed()
    arrange()
    showPlans()

    await screen.findByRole('list', { name: 'Тарифы' })
    expect(pageText()).not.toMatch(/Пакет из|Купить пакет/)
    expect(screen.queryByRole('button', { name: 'Купить пакет' })).not.toBeInTheDocument()
  })

  it('draws no row when no pack is on sale', async () => {
    subscribed()
    getOffers.mockResolvedValue({ ...offers({ current: 'business' }), pack: null })
    showPlans()

    await screen.findByRole('list', { name: 'Тарифы' })
    expect(screen.queryByRole('button', { name: /Купить/ })).not.toBeInTheDocument()
    expect(pageText()).not.toMatch(/Купить/)
  })

  it('opens the dialog of the pack and returns the focus to the button on close', async () => {
    subscribed()
    showPlans()
    const opener = await buy()
    opener.focus()
    fireEvent.click(opener)

    const dialog = await screen.findByRole('dialog', { name: 'Пакет из 100 кредитов' })
    expect(plain(dialog.textContent)).toContain('1 990 ₽')
    // Nothing to choose: a pack renews nothing.
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(opener).toHaveFocus()
    expect(startPackCheckout).not.toHaveBeenCalled()
    expect(startCheckout).not.toHaveBeenCalled()
  })

  it('starts the pack checkout and leaves for the payment page', async () => {
    subscribed()
    showPlans()
    fireEvent.click(await buy())
    const dialog = await screen.findByRole('dialog', { name: 'Пакет из 100 кредитов' })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Перейти к оплате' }))

    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith(packPage))
    // Neither the pack nor the price is the browser's to name.
    expect(startPackCheckout).toHaveBeenCalledExactlyOnceWith({}, expect.anything())
    expect(startCheckout).not.toHaveBeenCalled()
  })

  it('keeps the refusal on the screen when the tariff ended meanwhile and the row is gone', async () => {
    startPackCheckout.mockRejectedValue(
      serverRefusal(
        'Пакет кредитов можно купить только при действующем тарифе. Сначала оформите или оплатите тариф',
        'BILLING_PACK_NEEDS_SUBSCRIPTION',
      ),
    )
    subscribed()
    showPlans()
    fireEvent.click(await buy())
    const dialog = await screen.findByRole('dialog', { name: 'Пакет из 100 кредитов' })
    // What the page reads after the refusal: no tariff any more.
    getOverview.mockResolvedValue(overviewOf())
    getOffers.mockResolvedValue(offers())

    fireEvent.click(within(dialog).getByRole('button', { name: 'Перейти к оплате' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /^Пакет кредитов можно купить только при действующем тарифе\. Сначала оформите или оплатите тариф\.$/,
    )
    await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(2))
    expect(getOffers).toHaveBeenCalledTimes(2)
    // The page behind shows the tariffs to choose from; the dialog still says why.
    await screen.findByRole('heading', { level: 2, name: 'Выберите тариф', hidden: true })
    expect(screen.queryByRole('button', { name: 'Купить пакет', hidden: true })).toBeNull()
    expect(within(dialog).getByRole('alert')).toBeInTheDocument()
    expect(plain(dialog.textContent)).toContain('Пакет из 100 кредитов')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(hardNavigate).not.toHaveBeenCalled()
  })

  it('opens the dialog anew, without the refusal of the previous try', async () => {
    startPackCheckout.mockRejectedValueOnce(
      serverRefusal(
        'Оплата сейчас недоступна. Попробуйте ещё раз немного позже',
        'BILLING_PAYMENTS_NOT_CONFIGURED',
      ),
    )
    subscribed()
    showPlans()
    fireEvent.click(await buy())
    let dialog = await screen.findByRole('dialog', { name: 'Пакет из 100 кредитов' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Перейти к оплате' }))
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    fireEvent.click(await buy())

    dialog = await screen.findByRole('dialog', { name: 'Пакет из 100 кредитов' })
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Перейти к оплате' }))
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith(packPage))
  })
})

/** A customer on «Бизнес» with two sites, 45 credits of the tariff and 10 purchased ones. */
function onBusiness(
  patch: Parameters<typeof subscriptionTo>[0] = {},
  overview: Partial<BillingOverview> = {},
) {
  const subscription = subscriptionTo(patch)
  getOverview.mockResolvedValue(
    overviewOf({ subscription, credits: creditBalances(45, 10), ...overview }),
  )
  getOffers.mockResolvedValue(offers({ siteCount: 2, current: 'business' }))
  return subscription
}

const tariffBlock = async () => {
  const block = (await screen.findByRole('heading', { level: 2, name: /^Тариф «/ })).closest(
    'section',
  )
  if (!block) throw new Error('the tariff has no section')
  return block
}
const renewalSection = async () => {
  const section = (await screen.findByRole('heading', { level: 2, name: 'Автопродление' })).closest(
    'section',
  )
  if (!section) throw new Error('auto-renewal has no section')
  return section
}
const dialogText = () => plain(screen.getByRole('dialog').textContent)
const noCard = { autoRenewal: false, paymentMethod: null } as const
const cardKept = { autoRenewal: false } as const

describe('switching auto-renewal off', () => {
  it('asks first, with the numbers of the customer, and «Оставить включённым» changes nothing', async () => {
    onBusiness()
    showPlans()
    const opener = within(await renewalSection()).getByRole('button', {
      name: 'Отключить автопродление',
    })
    opener.focus()

    fireEvent.click(opener)

    const dialog = await screen.findByRole('dialog', { name: 'Отключить автопродление?' })
    expect(dialogText()).toContain(
      'Тариф «Бизнес» будет действовать до 18 октября 2026. 45 кредитов по тарифу можно использовать до этого дня.',
    )
    expect(dialogText()).toContain(
      'С 18 октября новые задачи не будут приниматься, пока вы снова не выберете тариф. 10 кредитов из пакета, сайты и история правок сохранятся.',
    )
    // The description of the dialog is what it confirms.
    expect(
      plain(document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent),
    ).toContain('Тариф «Бизнес» будет действовать')
    // It can be switched back on from this page: nothing says that it cannot.
    expect(dialogText()).not.toContain('Включить автопродление снова')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Оставить включённым' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(cancelAutoRenew).not.toHaveBeenCalled()
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('switches it off once, shows the tariff as ending and gives the focus to the words that say so', async () => {
    onBusiness()
    cancelAutoRenew.mockResolvedValue({
      renewalCharge: 'none',
      periodEnd: new Date('2026-10-18T09:00:00Z'),
    })
    showPlans()
    fireEvent.click(
      within(await renewalSection()).getByRole('button', { name: 'Отключить автопродление' }),
    )
    const confirm = within(await screen.findByRole('dialog')).getByRole('button', {
      name: 'Отключить',
    })
    // What the page reads after the switch.
    onBusiness(cardKept)

    fireEvent.click(confirm)
    fireEvent.click(confirm)

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(cancelAutoRenew).toHaveBeenCalledExactlyOnceWith({}, expect.anything())
    const said = screen.getByRole('status')
    expect(plain(said.textContent)).toBe(
      'Автопродление отключено. Тариф и 45 кредитов по тарифу доступны до 18 октября 2026. После этого новые задачи не принимаются, пока вы снова не выберете тариф. 10 кредитов из пакета, сайты и история правок сохранятся.',
    )
    await waitFor(() => expect(said).toHaveFocus())
    expect(screen.queryByRole('heading', { name: 'Автопродление' })).not.toBeInTheDocument()
    expect(row('Действует до')).toBe('18 октября 2026')
    // The card stays, so it comes back in one press.
    expect(screen.getByRole('button', { name: 'Включить автопродление' })).toBeEnabled()
  })

  it.each([
    [
      'at_bank',
      'Автопродление отключено. Списание за следующий период уже отправлено в банк: если оно пройдёт, тариф продлится ещё на месяц. Других списаний не будет.',
    ],
    [
      'unanswered',
      'Автопродление отключено. Списание за следующий период уже отправлялось в банк, ответа пока нет. Мы проверим его: если деньги списаны, тариф продлится ещё на месяц или мы вернём их. Других списаний не будет.',
    ],
  ] as const)(
    'tells of a renewal charge the switch found under way (%s) instead of a last day',
    async (renewalCharge, text) => {
      onBusiness()
      cancelAutoRenew.mockResolvedValue({
        renewalCharge,
        periodEnd: new Date('2026-10-18T09:00:00Z'),
      })
      showPlans()
      fireEvent.click(
        within(await renewalSection()).getByRole('button', { name: 'Отключить автопродление' }),
      )
      onBusiness(cardKept, { renewalCharge })
      fireEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Отключить' }),
      )

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(plain(screen.getByRole('status').textContent)).toBe(text)
      expect(pageText()).not.toContain('доступны до')
    },
  )

  it('warns in the dialog of a charge the page already knows to be under way', async () => {
    onBusiness({}, { renewalCharge: 'at_bank' })
    showPlans()

    fireEvent.click(
      within(await renewalSection()).getByRole('button', { name: 'Отключить автопродление' }),
    )

    await screen.findByRole('dialog')
    expect(dialogText()).toContain(
      'Автопродление отключится. Списание за следующий период уже отправлено в банк: если оно пройдёт, тариф продлится ещё на месяц. Отключение это списание не отменит; других списаний не будет.',
    )
    expect(dialogText()).not.toContain('будет действовать до')
  })

  it('says that a scheduled change will not happen', async () => {
    onBusiness({ nextPlan: agencyPlan })
    showPlans()

    fireEvent.click(
      within(await renewalSection()).getByRole('button', { name: 'Отключить автопродление' }),
    )

    await screen.findByRole('dialog')
    expect(dialogText()).toContain(
      'Переход на тариф «Агентство» не состоится, пока автопродление отключено.',
    )
  })

  it('keeps a refusal inside the dialog and refreshes the page behind it', async () => {
    onBusiness()
    cancelAutoRenew.mockRejectedValue(
      serverRefusal(
        'Это уже сделано. Обновите страницу, чтобы увидеть изменения',
        'BILLING_NOTHING_TO_CHANGE',
      ),
    )
    showPlans()
    fireEvent.click(
      within(await renewalSection()).getByRole('button', { name: 'Отключить автопродление' }),
    )
    const dialog = await screen.findByRole('dialog')
    const reads = getOverview.mock.calls.length

    fireEvent.click(within(dialog).getByRole('button', { name: 'Отключить' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Это уже сделано. Обновите страницу, чтобы увидеть изменения.',
    )
    await waitFor(() => expect(getOverview.mock.calls.length).toBeGreaterThan(reads))
    // The dialog is not locked: the customer may close it or try again.
    expect(within(dialog).getByRole('button', { name: 'Оставить включённым' })).toBeEnabled()
  })

  it('reports a request that never reached the server in its own words', async () => {
    onBusiness()
    cancelAutoRenew.mockRejectedValue(new Error('Failed to fetch'))
    showPlans()
    fireEvent.click(
      within(await renewalSection()).getByRole('button', { name: 'Отключить автопродление' }),
    )

    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Отключить' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось отключить автопродление. Проверьте соединение и попробуйте ещё раз.',
    )
  })
})

describe('switching auto-renewal on', () => {
  it('names the amount, the day and the saved card before the customer presses', async () => {
    onBusiness(cardKept)
    showPlans()

    const block = await tariffBlock()

    expect(within(block).getByRole('button', { name: 'Включить автопродление' })).toBeEnabled()
    expect(plain(block.textContent)).toContain(
      'Если включите, 18 октября и дальше каждый месяц будем списывать 12 900 ₽ сохранённым способом оплаты — Карта «Мир» •• 4444. Перед списанием пришлём письмо.',
    )
  })

  it('switches it on with the saved card and says so, with the focus on the words', async () => {
    onBusiness(cardKept)
    resumeAutoRenew.mockResolvedValue({ needsPaymentMethod: false, renewalCharge: 'none' })
    showPlans()
    const button = within(await tariffBlock()).getByRole('button', {
      name: 'Включить автопродление',
    })
    onBusiness()

    fireEvent.click(button)
    fireEvent.click(button)

    const said = await screen.findByRole('status')
    expect(plain(said.textContent)).toBe('Автопродление включено. Перед списанием пришлём письмо.')
    await waitFor(() => expect(said).toHaveFocus())
    expect(resumeAutoRenew).toHaveBeenCalledExactlyOnceWith({}, expect.anything())
    expect(hardNavigate).not.toHaveBeenCalled()
    expect(row('Следующее списание')).toBe('18 октября 2026 — 12 900 ₽')
    expect(within(await renewalSection()).getByRole('button')).toHaveTextContent(
      'Отключить автопродление',
    )
    expect(screen.queryByRole('button', { name: 'Включить автопродление' })).toBeNull()
  })

  it('says that a card comes first when none is saved, and leaves for the page that binds it', async () => {
    onBusiness(noCard)
    resumeAutoRenew.mockResolvedValue({
      needsPaymentMethod: true,
      confirmationUrl: 'https://yookassa.example/bind/1',
    })
    showPlans()
    const block = await tariffBlock()
    expect(plain(block.textContent)).toContain(
      'Сначала привяжем карту на странице ЮKassa: деньги при этом не спишутся. Когда карта сохранится, автопродление включится: 18 октября и дальше каждый месяц будем списывать 12 900 ₽ с этой карты. Перед списанием пришлём письмо.',
    )
    const button = within(block).getByRole('button', { name: 'Включить автопродление' })

    fireEvent.click(button)

    await waitFor(() =>
      expect(hardNavigate).toHaveBeenCalledExactlyOnceWith('https://yookassa.example/bind/1'),
    )
    // Nothing is on yet, and the page does not say that it is.
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(pageText()).toContain('Автопродление отключено.')
    // The button waits for the browser to leave: a second press starts no second binding.
    fireEvent.click(button)
    expect(resumeAutoRenew).toHaveBeenCalledTimes(1)
  })

  it('names the scheduled tariff and its price when a change is scheduled', async () => {
    onBusiness({ ...cardKept, nextPlan: agencyPlan })
    showPlans()

    expect(plain((await tariffBlock()).textContent)).toContain(
      'Если включите, 18 октября тариф сменится на «Агентство»: в этот день и дальше каждый месяц будем списывать 39 900 ₽ сохранённым способом оплаты — Карта «Мир» •• 4444.',
    )
  })

  it('names no day of a charge while one that was started before is under way', async () => {
    onBusiness(cardKept, { renewalCharge: 'at_bank' })
    showPlans()

    const text = plain((await tariffBlock()).textContent)
    expect(text).toContain(
      'Автопродление отключено. Списание за следующий период уже отправлено в банк: если оно пройдёт, тариф продлится ещё на месяц. Других списаний не будет.',
    )
    expect(text).toContain('Если включите, каждый месяц будем списывать 12 900 ₽')
    expect(text).not.toContain('18 октября и дальше')
  })

  it('shows a refusal under the button and lets the customer try again', async () => {
    onBusiness(cardKept)
    resumeAutoRenew.mockRejectedValueOnce(
      serverRefusal('Оплата сейчас недоступна. Попробуйте ещё раз немного позже'),
    )
    resumeAutoRenew.mockResolvedValueOnce({ needsPaymentMethod: false, renewalCharge: 'none' })
    showPlans()
    const button = within(await tariffBlock()).getByRole('button', {
      name: 'Включить автопродление',
    })

    fireEvent.click(button)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Оплата сейчас недоступна. Попробуйте ещё раз немного позже.',
    )
    onBusiness()
    fireEvent.click(button)
    expect(await screen.findByRole('status')).toHaveTextContent('Автопродление включено.')
    expect(resumeAutoRenew).toHaveBeenCalledTimes(2)
  })

  it('offers no switch while payments are off: a card could not be bound or charged', async () => {
    onBusiness(cardKept, { paymentsEnabled: false })
    showPlans()

    const block = await tariffBlock()
    expect(plain(block.textContent)).toContain('Автопродление отключено.')
    expect(screen.queryByRole('button', { name: 'Включить автопродление' })).toBeNull()
    expect(plain(block.textContent)).not.toContain('Если включите')
  })

  it('settles a binding the customer came back from before the return page had an answer', async () => {
    onBusiness(noCard, { bindingPending: true })
    syncMethod.mockResolvedValue({ state: 'active', renewalCharge: 'none', subscription: null })
    showPlans()

    await tariffBlock()

    await waitFor(() => expect(syncMethod).toHaveBeenCalledExactlyOnceWith({}))
    // The outcome is read anew.
    await waitFor(() => expect(getOverview.mock.calls.length).toBeGreaterThan(1))
  })
})

describe('choosing another tariff for the next period', () => {
  it('offers every other tariff the sites fit, and none they do not', async () => {
    onBusiness()
    showPlans()

    const change = within(await planCard('Агентство')).getByRole('button', {
      name: 'Перейти на тариф «Агентство»',
    })
    expect(change).toBeEnabled()
    // One word on the button, whatever the tariff is called: the buttons of a row stay one line
    // tall. Which tariff is said by the card and by the name of the button.
    expect(change).toHaveTextContent(/^Перейти$/)
    expect(within(await planCard('Бизнес')).queryByRole('button')).toBeNull()
    // Two sites do not fit «Старт»: its note stays and it has no button.
    const small = await planCard('Старт')
    expect(within(small).queryByRole('button')).toBeNull()
    expect(plain(small.textContent)).toContain('Не подойдёт: у вас два сайта')
  })

  it('names the day, what stays and what is charged, and «Не менять» changes nothing', async () => {
    onBusiness()
    showPlans()
    const opener = within(await planCard('Агентство')).getByRole('button')
    opener.focus()

    fireEvent.click(opener)

    const dialog = await screen.findByRole('dialog', { name: 'Перейти на тариф «Агентство»?' })
    expect(dialogText()).toContain(
      'Тариф изменится 18 октября 2026 — с началом нового периода. До этого дня действует «Бизнес». Кредиты по тарифу можно использовать до 18 октября, на новый период они не переносятся. Кредиты из пакета остаются.',
    )
    expect(dialogText()).toContain(
      'С 18 октября2 500 кредитов в месяц, до 300 кредитов в день · до 15 сайтов на WordPress',
    )
    expect(dialogText()).toContain(
      'Спишем 18 октября39 900 ₽ сохранённым способом оплаты — Карта «Мир» •• 4444',
    )

    fireEvent.click(within(dialog).getByRole('button', { name: 'Не менять' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(schedulePlanChange).not.toHaveBeenCalled()
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('schedules the tariff whose button was pressed, once, and shows what is coming', async () => {
    const current = onBusiness()
    const scheduled = { ...current, nextPlan: agencyPlan }
    schedulePlanChange.mockResolvedValue(scheduled)
    showPlans()
    fireEvent.click(within(await planCard('Агентство')).getByRole('button'))
    const confirm = within(await screen.findByRole('dialog')).getByRole('button', {
      name: /^Перейти.с.18.октября$/,
    })
    onBusiness({ nextPlan: agencyPlan })

    fireEvent.click(confirm)
    fireEvent.click(confirm)

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(schedulePlanChange).toHaveBeenCalledExactlyOnceWith(
      { planSlug: 'agency' },
      expect.anything(),
    )
    const said = screen.getByRole('status')
    expect(plain(said.textContent)).toBe('Готово: с 18 октября — тариф «Агентство».')
    await waitFor(() => expect(said).toHaveFocus())
    const coming = screen.getByRole('group', { name: /^С.18.октября.— тариф «Агентство»$/ })
    expect(plain(coming.textContent)).toContain(
      '2 500 кредитов в месяц, до 300 кредитов в день · до 15 сайтов на WordPress. 18 октября спишем 39 900 ₽ сохранённым способом оплаты.',
    )
    expect(within(coming).getByRole('button', { name: 'Отменить переход' })).toBeEnabled()
    // The card of the chosen tariff has its note instead of the button.
    const card = await planCard('Агентство')
    expect(within(card).queryByRole('button')).toBeNull()
    expect(plain(card.textContent)).toContain('Начнёт действовать 18 октября.')
  })

  it('says that the tariff changes only if it is renewed when auto-renewal is off', async () => {
    const current = onBusiness(cardKept)
    schedulePlanChange.mockResolvedValue({ ...current, nextPlan: agencyPlan })
    showPlans()

    fireEvent.click(within(await planCard('Агентство')).getByRole('button'))

    const dialog = await screen.findByRole('dialog')
    expect(dialogText()).toContain(
      'ОплатаАвтопродление отключено: тариф сменится, только если его продлить. Включите автопродление на этой странице, и 18 октября мы спишем 39 900 ₽.',
    )
    expect(dialogText()).not.toContain('Спишем 18 октября')

    onBusiness({ ...cardKept, nextPlan: agencyPlan })
    fireEvent.click(within(dialog).getByRole('button', { name: /^Перейти с/ }))

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Тариф «Агентство» выбран. Он начнёт действовать, если включить автопродление.',
    )
    const coming = screen.getByRole('group', { name: 'Выбран тариф «Агентство»' })
    expect(plain(coming.textContent)).toContain(
      'Автопродление отключено, поэтому 18 октября тариф закончится и переход не состоится. Чтобы перейти, включите автопродление: 18 октября спишем 39 900 ₽.',
    )
    // The way to switch it on is on the same page.
    expect(screen.getByRole('button', { name: 'Включить автопродление' })).toBeEnabled()
    expect(plain((await planCard('Агентство')).textContent)).toContain(
      'Выбран на следующий период.',
    )
  })

  it('says which earlier choice the new one replaces', async () => {
    const current = onBusiness({ nextPlan: agencyPlan })
    getOffers.mockResolvedValue(offers({ siteCount: 1, current: 'business' }))
    schedulePlanChange.mockResolvedValue({ ...current, nextPlan: agencyPlan })
    showPlans()

    fireEvent.click(
      within(await planCard('Старт')).getByRole('button', { name: 'Перейти на тариф «Старт»' }),
    )

    await screen.findByRole('dialog', { name: 'Перейти на тариф «Старт»?' })
    expect(dialogText()).toContain('Переход на «Агентство», выбранный раньше, отменится.')
  })

  it.each([
    [
      'a renewal charge that has just left',
      serverRefusal(
        'Предыдущий платёж ещё обрабатывается. Подождите пару минут и обновите страницу',
        'BILLING_PAYMENT_IN_PROGRESS',
      ),
      'Списание за следующий период уже отправлено в банк. Сменить тариф можно будет, когда оно завершится: обновите страницу через пару минут.',
    ],
    [
      'one more site',
      serverRefusal(
        'У вас больше сайтов, чем входит в этот тариф. Выберите тариф, в который они помещаются',
        'BILLING_PLAN_SITE_LIMIT',
      ),
      'У вас больше сайтов, чем входит в этот тариф. Выберите тариф, в который они помещаются.',
    ],
    [
      'a request that never arrived',
      new Error('Failed to fetch'),
      'Не удалось сменить тариф. Проверьте соединение и попробуйте ещё раз.',
    ],
  ])('keeps the refusal for %s inside the dialog', async (_case, refusal, text) => {
    onBusiness()
    schedulePlanChange.mockRejectedValue(refusal)
    showPlans()
    fireEvent.click(within(await planCard('Агентство')).getByRole('button'))
    const dialog = await screen.findByRole('dialog')

    fireEvent.click(within(dialog).getByRole('button', { name: /^Перейти с/ }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(text)
    // The words of the dialog are those it was opened with, whatever the page reads meanwhile.
    expect(dialogText()).toContain('До этого дня действует «Бизнес».')
    expect(within(dialog).getByRole('button', { name: 'Не менять' })).toBeEnabled()
  })

  it.each([
    ['the renewal charge of the period is under way', {}, { renewalCharge: 'at_bank' as const }],
    ['the tariff waits for its payment', { status: 'past_due' as const }, {}],
    ['payments are off', {}, { paymentsEnabled: false }],
  ])('offers no change while %s', async (_case, patch, overview) => {
    onBusiness(patch, overview)
    showPlans()

    await planCard('Агентство')
    expect(screen.queryByRole('button', { name: /^Перейти на/ })).toBeNull()
  })
})

describe('a change of tariff that is scheduled', () => {
  it('is taken back in one press, and the page says which tariff stays', async () => {
    const current = onBusiness({ nextPlan: agencyPlan })
    cancelPlanChange.mockResolvedValue({ ...current, nextPlan: null })
    showPlans()
    const button = within(
      await screen.findByRole('group', { name: /тариф «Агентство»/ }),
    ).getByRole('button', { name: 'Отменить переход' })
    onBusiness()

    fireEvent.click(button)
    fireEvent.click(button)

    const said = await screen.findByRole('status')
    expect(plain(said.textContent)).toBe('Переход отменён: остаётся тариф «Бизнес».')
    await waitFor(() => expect(said).toHaveFocus())
    expect(cancelPlanChange).toHaveBeenCalledExactlyOnceWith({}, expect.anything())
    expect(screen.queryByRole('group', { name: /тариф «Агентство»/ })).toBeNull()
    expect(row('Следующее списание')).toBe('18 октября 2026 — 12 900 ₽')
    // The tariff can be chosen again.
    expect(within(await planCard('Агентство')).getByRole('button')).toHaveAccessibleName(
      'Перейти на тариф «Агентство»',
    )
  })

  it('cannot be taken back while its charge is at the bank, and says why', async () => {
    onBusiness({ nextPlan: agencyPlan }, { renewalCharge: 'at_bank' })
    showPlans()

    const coming = await screen.findByRole('group', { name: /тариф «Агентство»/ })

    expect(plain(coming.textContent)).toContain(
      'Списание за следующий период уже отправлено в банк. Отменить переход можно будет после него.',
    )
    expect(within(coming).queryByRole('button')).toBeNull()
    expect(row('Следующее списание')).toBe('Уже отправлено в банк, ждём ответа')
  })

  it('shows a refusal in the block itself', async () => {
    onBusiness({ nextPlan: agencyPlan })
    cancelPlanChange.mockRejectedValue(
      serverRefusal(
        'Это уже сделано. Обновите страницу, чтобы увидеть изменения',
        'BILLING_NOTHING_TO_CHANGE',
      ),
    )
    showPlans()
    const coming = await screen.findByRole('group', { name: /тариф «Агентство»/ })

    fireEvent.click(within(coming).getByRole('button', { name: 'Отменить переход' }))

    expect(await within(coming).findByRole('alert')).toHaveTextContent(
      'Это уже сделано. Обновите страницу, чтобы увидеть изменения.',
    )
  })
})

describe('a renewal charge that is under way', () => {
  it.each([
    [
      'at_bank',
      'Уже отправлено в банк, ждём ответа',
      'Включено. Списание за следующий период уже отправлено в банк: когда оно пройдёт, тариф продлится ещё на месяц. Перед каждым следующим списанием пришлём письмо на anna@example.ru.',
    ],
    [
      'unanswered',
      'Уже отправлялось в банк, ответа пока нет',
      'Включено. Списание за следующий период уже отправлялось в банк, ответа пока нет. Мы проверим его: если деньги списаны, тариф продлится ещё на месяц или мы вернём их. Перед каждым следующим списанием пришлём письмо на anna@example.ru.',
    ],
  ] as const)('is not promised as a charge to come (%s)', async (renewalCharge, value, text) => {
    onBusiness({}, { renewalCharge })
    showPlans()

    const section = await renewalSection()

    expect(row('Следующее списание')).toBe(value)
    expect(plain(section.textContent)).toContain(text)
    expect(pageText()).not.toMatch(/18 октября (2026 — |спишем)/)
    // Switching off is still offered: it stops the charges after this one.
    expect(within(section).getByRole('button', { name: 'Отключить автопродление' })).toBeEnabled()
  })
})

describe('a tariff whose renewal charge failed', () => {
  const overdue = { status: 'past_due', pastDueSince: new Date('2026-10-18T09:00:05Z') } as const
  const endsAt = { pastDueEndsAt: new Date('2026-10-25T09:00:05Z') }

  it('says what to do and when the tariff ends, and shows none of its credits as left', async () => {
    onBusiness(overdue, endsAt)
    showPlans()

    const alert = await screen.findByRole('alert')
    expect(plain(alert.textContent)).toContain('Не получилось списать 12 900 ₽')
    expect(plain(alert.textContent)).toContain(
      'Оплатите тариф: пока оплата не пройдёт, новые задачи не принимаются. 25 октября 2026 тариф закончится, если оплата не пройдёт раньше. Карту для следующих списаний можно заменить.',
    )
    // Replacing the card pays for nothing: the sentence does not offer it as a way out.
    expect(plain(alert.textContent)).not.toMatch(/или замените/)
    const chip = screen.getByText('Оплата не прошла').closest('.MuiChip-root')
    expect(chip?.querySelector('svg')).not.toBeNull()
    expect(row('Способ оплаты')).toBe('Карта «Мир» •• 4444')
    // 45 credits of the period that ended are not the customer's any more.
    expect(row('Кредиты')).toBe(
      'Недоступны, пока тариф не оплачен. После оплаты — новые кредиты по тарифу и 10 из пакета',
    )
    expect(pageText()).not.toMatch(/Осталось \d/)
    expect(screen.queryByText('Следующее списание')).not.toBeInTheDocument()
    expect(screen.queryByText('Действует до')).not.toBeInTheDocument()
    expect(plain((await planCard('Бизнес')).textContent)).not.toMatch(/Продлится|Действует до/)
    const block = await tariffBlock()
    expect(within(block).getByRole('button', { name: 'Оплатить сейчас' })).toBeEnabled()
    expect(within(block).getByRole('link', { name: 'Заменить карту' })).toHaveAttribute(
      'href',
      '/settings/billing',
    )
  })

  it('says only that the credits wait when none were purchased', async () => {
    const subscription = subscriptionTo(overdue)
    getOverview.mockResolvedValue(overviewOf({ subscription, credits: creditBalances(45, 0) }))
    getOffers.mockResolvedValue(offers({ current: 'business' }))
    showPlans()

    await tariffBlock()
    expect(row('Кредиты')).toBe('Недоступны, пока тариф не оплачен')
  })

  it('names the amount, the month from today and the card that will be saved before the payment page', async () => {
    onBusiness(overdue, endsAt)
    startPastDuePayment.mockResolvedValue({
      orderId: '018f0000-0000-7000-8000-0000000000aa',
      confirmationUrl: 'https://yookassa.example/pay/1',
    })
    showPlans()
    const opener = within(await tariffBlock()).getByRole('button', { name: 'Оплатить сейчас' })

    fireEvent.click(opener)

    const dialog = await screen.findByRole('dialog', { name: 'Тариф «Бизнес»' })
    expect(dialogText()).toContain('ПериодС сегодняшнего дня на месяц')
    expect(dialogText()).toContain('К оплате сегодня12 900 ₽')
    expect(dialogText()).toContain(
      'Автопродление включено: сохраним способ оплаты, которым вы заплатите сейчас, и каждый месяц будем списывать 12 900 ₽ тем же способом. Перед списанием пришлём письмо. Отключить можно в настройках в любой день.',
    )
    expect(dialogText()).toContain('Оплата принимается только с личной карты')
    expect(startPastDuePayment).not.toHaveBeenCalled()

    const pay = within(dialog).getByRole('button', { name: 'Перейти к оплате' })
    // The tariff is read anew first: see «reads the tariff anew» below.
    await waitFor(() => expect(pay).toBeEnabled())
    fireEvent.click(pay)
    fireEvent.click(pay)

    await waitFor(() =>
      expect(hardNavigate).toHaveBeenCalledExactlyOnceWith('https://yookassa.example/pay/1'),
    )
    expect(startPastDuePayment).toHaveBeenCalledExactlyOnceWith({}, expect.anything())
  })

  it('pays for the scheduled tariff at its price, and lets the change be taken back first', async () => {
    onBusiness({ ...overdue, nextPlan: agencyPlan }, endsAt)
    showPlans()

    const alert = await screen.findByRole('alert')
    expect(plain(alert.textContent)).toContain('Не получилось списать 39 900 ₽')
    const coming = screen.getByRole('group', { name: /^После оплаты.— тариф «Агентство»$/ })
    expect(plain(coming.textContent)).toContain(
      'К оплате — 39 900 ₽: тариф сменится, как только оплата пройдёт.',
    )
    expect(within(coming).getByRole('button', { name: 'Отменить переход' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Оплатить сейчас' }))

    await screen.findByRole('dialog', { name: 'Тариф «Агентство»' })
    expect(dialogText()).toContain(
      '2 500 кредитов в месяц, до 300 кредитов в день · до 15 сайтов на WordPress',
    )
    expect(dialogText()).toContain('К оплате сегодня39 900 ₽')
  })

  it('says that no card is saved when auto-renewal is off, and offers no card to replace', async () => {
    onBusiness({ ...overdue, ...noCard }, endsAt)
    showPlans()

    const alert = await screen.findByRole('alert')
    expect(plain(alert.textContent)).toContain(
      'Оплатите тариф: пока оплата не пройдёт, новые задачи не принимаются.',
    )
    expect(screen.queryByRole('link', { name: 'Заменить карту' })).toBeNull()
    const section = await renewalSection()
    expect(plain(section.textContent)).toContain(
      'Отключено. После оплаты тариф будет действовать месяц и сам не продлится.',
    )
    expect(within(section).queryByRole('button')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Включить автопродление' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Оплатить сейчас' }))

    await screen.findByRole('dialog')
    expect(dialogText()).toContain(
      'Автопродление отключено: способ оплаты мы не сохраним, тариф будет действовать месяц и сам не продлится.',
    )
  })

  it('lets auto-renewal be switched off before the payment, and says what that means', async () => {
    onBusiness(overdue, endsAt)
    cancelAutoRenew.mockResolvedValue({
      renewalCharge: 'none',
      periodEnd: new Date('2026-10-18T09:00:00Z'),
    })
    showPlans()
    const section = await renewalSection()
    expect(plain(section.textContent)).toContain(
      'Включено. Способ оплаты, которым вы оплатите тариф, сохранится, и дальше тариф будет продлеваться сам.',
    )

    fireEvent.click(within(section).getByRole('button', { name: 'Отключить автопродление' }))

    await screen.findByRole('dialog', { name: 'Отключить автопродление?' })
    expect(dialogText()).toContain(
      'Тариф «Бизнес» по-прежнему ждёт оплаты. После оплаты он будет действовать месяц и сам не продлится.',
    )
    expect(dialogText()).toContain('Способ оплаты, которым вы заплатите, мы не сохраним.')
    onBusiness({ ...overdue, ...cardKept }, endsAt)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Отключить' }))

    const said = await screen.findByRole('status')
    expect(plain(said.textContent)).toBe(
      'Автопродление отключено: способ оплаты, которым вы оплатите тариф, мы не сохраним.',
    )
    await waitFor(() => expect(said).toHaveFocus())
  })

  it('tells that the tariff is paid already when the payment is refused for that', async () => {
    onBusiness(overdue, endsAt)
    startPastDuePayment.mockRejectedValue(
      serverRefusal(
        'Это уже сделано. Обновите страницу, чтобы увидеть изменения',
        'BILLING_NOTHING_TO_CHANGE',
      ),
    )
    showPlans()
    fireEvent.click(within(await tariffBlock()).getByRole('button', { name: 'Оплатить сейчас' }))

    const pay = within(await screen.findByRole('dialog')).getByRole('button', {
      name: 'Перейти к оплате',
    })
    await waitFor(() => expect(pay).toBeEnabled())
    fireEvent.click(pay)

    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(
      'Тариф уже оплачен. Обновите страницу, чтобы увидеть его.',
    )
    expect(hardNavigate).not.toHaveBeenCalled()
  })

  it('keeps «Заменить карту» and says nothing of the card when auto-renewal is off with a card saved', async () => {
    onBusiness({ ...overdue, ...cardKept }, endsAt)
    showPlans()

    const alert = await screen.findByRole('alert')
    expect(plain(alert.textContent)).toContain(
      'Оплатите тариф: пока оплата не пройдёт, новые задачи не принимаются. 25 октября 2026 тариф закончится, если оплата не пройдёт раньше.',
    )
    // No charge is coming to that card: the sentence about the coming charges is not said.
    expect(plain(alert.textContent)).not.toMatch(/Карту|замените/)
    expect(
      within(await tariffBlock()).getByRole('link', { name: 'Заменить карту' }),
    ).toHaveAttribute('href', '/settings/billing')
  })

  /** An answer of `billing.overview` that comes when the test says so. */
  function overviewOnItsWay() {
    let answer!: (overview: BillingOverview) => void
    let fail!: (error: Error) => void
    getOverview.mockImplementationOnce(
      () =>
        new Promise<BillingOverview>((resolve, reject) => {
          answer = resolve
          fail = reject
        }),
    )
    return {
      answer: (overview: BillingOverview) => answer(overview),
      fail: () => fail(new Error('Failed to fetch')),
    }
  }
  const overdueOverview = (patch: Parameters<typeof subscriptionTo>[0] = {}) =>
    overviewOf({
      subscription: subscriptionTo({ ...overdue, ...patch }),
      credits: creditBalances(45, 10),
      ...endsAt,
    })

  it('reads the tariff anew when the dialog opens and starts no payment before the answer is in', async () => {
    onBusiness(overdue, endsAt)
    startPastDuePayment.mockResolvedValue({
      orderId: '018f0000-0000-7000-8000-0000000000aa',
      confirmationUrl: 'https://yookassa.example/pay/1',
    })
    showPlans()
    const opener = within(await tariffBlock()).getByRole('button', { name: 'Оплатить сейчас' })
    expect(getOverview).toHaveBeenCalledTimes(1)
    const fresh = overviewOnItsWay()

    fireEvent.click(opener)

    const dialog = await screen.findByRole('dialog', { name: 'Тариф «Бизнес»' })
    // What the page showed stays on the screen while the answer is on its way.
    expect(dialogText()).toContain('К оплате сегодня12 900 ₽')
    await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(2))
    const pay = within(dialog).getByRole('button', { name: /Перейти к оплате/ })
    expect(pay).toBeDisabled()
    fireEvent.click(pay)
    expect(startPastDuePayment).not.toHaveBeenCalled()
    // Waiting is not a failure: the button shows that it waits, and nothing is reported.
    expect(pay).toHaveClass('MuiButton-loading')
    expect(within(dialog).queryByRole('alert')).toBeNull()
    // Leaving is not held up by the check.
    expect(within(dialog).getByRole('button', { name: 'Отмена' })).toBeEnabled()

    fresh.answer(overdueOverview())

    await waitFor(() => expect(pay).toBeEnabled())
    expect(dialogText()).toContain('К оплате сегодня12 900 ₽')
    fireEvent.click(pay)
    await waitFor(() =>
      expect(hardNavigate).toHaveBeenCalledExactlyOnceWith('https://yookassa.example/pay/1'),
    )
    expect(startPastDuePayment).toHaveBeenCalledExactlyOnceWith({}, expect.anything())
  })

  it('shows the tariff and the amount of the fresh answer when a scheduled change was taken back elsewhere', async () => {
    // The page still shows the change to «Агентство»; in another tab it was cancelled.
    onBusiness({ ...overdue, nextPlan: agencyPlan }, endsAt)
    showPlans()
    const opener = within(await tariffBlock()).getByRole('button', { name: 'Оплатить сейчас' })
    const fresh = overviewOnItsWay()

    fireEvent.click(opener)

    const dialog = await screen.findByRole('dialog', { name: 'Тариф «Агентство»' })
    expect(dialogText()).toContain('К оплате сегодня39 900 ₽')
    const pay = within(dialog).getByRole('button', { name: /Перейти к оплате/ })
    expect(pay).toBeDisabled()

    fresh.answer(overdueOverview())

    // The same dialog, now with what the payment will be started for.
    await waitFor(() => expect(dialog).toHaveAccessibleName('Тариф «Бизнес»'))
    expect(dialogText()).toContain(
      '800 кредитов в месяц, до 100 кредитов в день · до 3 сайтов на WordPress',
    )
    expect(dialogText()).toContain('К оплате сегодня12 900 ₽')
    expect(dialogText()).toContain('каждый месяц будем списывать 12 900 ₽ тем же способом')
    expect(dialogText()).not.toMatch(/Агентство|39 900/)
    await waitFor(() => expect(pay).toBeEnabled())
    // The page behind the dialog got the same answer.
    expect(screen.queryByRole('group', { name: /тариф «Агентство»/, hidden: true })).toBeNull()
  })

  it('shows the tariff and the amount of the fresh answer when a change was scheduled elsewhere, and the consent as it stands', async () => {
    onBusiness(overdue, endsAt)
    showPlans()
    const opener = within(await tariffBlock()).getByRole('button', { name: 'Оплатить сейчас' })
    const fresh = overviewOnItsWay()

    fireEvent.click(opener)
    const dialog = await screen.findByRole('dialog', { name: 'Тариф «Бизнес»' })
    expect(dialogText()).toContain('Автопродление включено: сохраним способ оплаты')

    // «Агентство» was chosen and auto-renewal switched off in another tab.
    fresh.answer(overdueOverview({ nextPlan: agencyPlan, ...cardKept }))

    await waitFor(() => expect(dialog).toHaveAccessibleName('Тариф «Агентство»'))
    expect(dialogText()).toContain('К оплате сегодня39 900 ₽')
    expect(dialogText()).toContain(
      'Автопродление отключено: способ оплаты мы не сохраним, тариф будет действовать месяц и сам не продлится.',
    )
    expect(dialogText()).not.toMatch(/12 900|Автопродление включено/)
  })

  it('starts no payment when the fresh answer does not come, and checks again on «Повторить»', async () => {
    onBusiness(overdue, endsAt)
    startPastDuePayment.mockResolvedValue({
      orderId: '018f0000-0000-7000-8000-0000000000aa',
      confirmationUrl: 'https://yookassa.example/pay/1',
    })
    showPlans()
    const opener = within(await tariffBlock()).getByRole('button', { name: 'Оплатить сейчас' })
    const fresh = overviewOnItsWay()

    fireEvent.click(opener)
    const dialog = await screen.findByRole('dialog', { name: 'Тариф «Бизнес»' })
    fresh.fail()

    const alert = await within(dialog).findByRole('alert')
    expect(plain(alert.textContent)).toContain(
      'Не удалось проверить тариф и сумму. Проверьте соединение и попробуйте ещё раз.',
    )
    const pay = within(dialog).getByRole('button', { name: /Перейти к оплате/ })
    expect(pay).toBeDisabled()
    fireEvent.click(pay)
    expect(startPastDuePayment).not.toHaveBeenCalled()
    // The page behind keeps what it showed: a refresh that failed is not its error.
    expect(document.getElementById('plan-title')).toHaveTextContent('Тариф «Бизнес»')
    expect(screen.queryByText('Не удалось загрузить тарифы. Попробуйте ещё раз.')).toBeNull()

    fireEvent.click(within(alert).getByRole('button', { name: 'Повторить' }))

    await waitFor(() => expect(pay).toBeEnabled())
    expect(within(dialog).queryByRole('alert')).toBeNull()
    fireEvent.click(pay)
    await waitFor(() => expect(startPastDuePayment).toHaveBeenCalledTimes(1))
  })

  it('reads the tariff anew at every opening of the dialog', async () => {
    onBusiness(overdue, endsAt)
    showPlans()
    const opener = within(await tariffBlock()).getByRole('button', { name: 'Оплатить сейчас' })

    for (const opening of [1, 2]) {
      fireEvent.click(opener)
      const dialog = await screen.findByRole('dialog', { name: 'Тариф «Бизнес»' })
      await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(1 + opening))
      await waitFor(() =>
        expect(within(dialog).getByRole('button', { name: 'Перейти к оплате' })).toBeEnabled(),
      )
      fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    }
    expect(startPastDuePayment).not.toHaveBeenCalled()
  })

  it('names no last day and offers no payment while payments are off', async () => {
    onBusiness(overdue, { paymentsEnabled: false, pastDueEndsAt: null })
    showPlans()

    const alert = await screen.findByRole('alert')
    expect(plain(alert.textContent)).toContain(
      'Оплата сейчас недоступна: пока оплата не пройдёт, новые задачи не принимаются.',
    )
    expect(plain(alert.textContent)).not.toContain('закончится')
    expect(screen.queryByRole('button', { name: 'Оплатить сейчас' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Заменить карту' })).toBeNull()
    // What auto-renewal means is told as at a shop that saves payment methods. «Не сохранится»
    // is the sentence of a shop that takes one-time payments only, and here there is no shop.
    expect(plain((await renewalSection()).textContent)).toContain(
      'Включено. Способ оплаты, которым вы оплатите тариф, сохранится, и дальше тариф будет продлеваться сам. Перед каждым списанием пришлём письмо.',
    )
    // Nor does its confirmation say that auto-renewal cannot be switched back on.
    fireEvent.click(
      within(await renewalSection()).getByRole('button', { name: 'Отключить автопродление' }),
    )
    await screen.findByRole('dialog', { name: 'Отключить автопродление?' })
    expect(dialogText()).toContain('Тариф «Бизнес» по-прежнему ждёт оплаты.')
    expect(dialogText()).not.toContain('снова пока будет нельзя')
  })
})

describe('the «Тарифы» page of a customer whose tariff is over', () => {
  const ended = (reason: 'not_renewed' | 'not_paid' | 'refunded', pack = 0) =>
    getOverview.mockResolvedValue(
      overviewOf({
        credits: creditBalances(0, pack),
        ended: { planName: 'Бизнес', endedAt: new Date('2026-10-18T09:00:00Z'), reason },
      }),
    )

  it('says when it ended and what is kept, and leads to the tariffs on sale', async () => {
    ended('not_renewed', 10)
    showPlans()

    const block = await tariffBlock()
    expect(within(block).getByRole('heading', { level: 2 })).toHaveTextContent('Тариф «Бизнес»')
    const chip = within(block)
      .getByText(/^Закончился 18.октября$/)
      .closest('.MuiChip-root')
    expect(chip?.querySelector('svg')).not.toBeNull()
    expect(plain(block.textContent)).toContain(
      'Новые задачи сейчас не принимаются. 10 кредитов из пакета, сайты и история правок на месте.',
    )
    const choose = within(block).getByRole('link', { name: 'Выбрать тариф' })
    expect(choose).toHaveAttribute('href', '#plans')
    expect(document.getElementById('plans')).toContainElement(
      screen.getByRole('heading', { level: 2, name: 'Выберите тариф' }),
    )
    expect(pageText()).toContain('Выберите тариф, чтобы снова ставить задачи.')
    // The instruction is given once in a sentence: by the line under the heading of the page.
    expect(pageText().match(/Выберите тариф, чтобы/g)).toHaveLength(1)
    expect(pageText()).not.toContain('чтобы продолжить')
    // A tariff is chosen as by anybody without one.
    expect(
      within(await planCard('Старт')).getByRole('button', { name: 'Выбрать «Старт»' }),
    ).toBeEnabled()
    expect(screen.queryByRole('heading', { name: 'Автопродление' })).toBeNull()
    expect(pageText()).not.toMatch(/Способ оплаты|Следующее списание|Осталось/)
  })

  it.each([
    [
      'not_paid',
      'Оплата за следующий период не прошла, и тариф закончился. Новые задачи сейчас не принимаются. Сайты и история правок на месте.',
    ],
    [
      'refunded',
      'Мы вернули оплату за этот тариф, и он закончился. Новые задачи сейчас не принимаются. Сайты и история правок на месте.',
    ],
  ] as const)('says why it ended: %s', async (reason, text) => {
    ended(reason)
    showPlans()

    expect(plain((await tariffBlock()).textContent)).toContain(text)
  })

  it('offers nothing to choose while payments are off', async () => {
    getOverview.mockResolvedValue(
      overviewOf({
        paymentsEnabled: false,
        ended: {
          planName: 'Бизнес',
          endedAt: new Date('2026-10-18T09:00:00Z'),
          reason: 'not_renewed',
        },
      }),
    )
    showPlans()

    const block = await tariffBlock()
    expect(plain(block.textContent)).toContain(
      'Новые задачи сейчас не принимаются. Сайты и история правок на месте.',
    )
    expect(within(block).queryByRole('link', { name: 'Выбрать тариф' })).toBeNull()
    expect(pageText()).toContain('Оплата пока недоступна.')
  })

  it('shows the tariff the customer has instead, once there is one', async () => {
    getOverview.mockResolvedValue(
      overviewOf({
        subscription: subscriptionTo(),
        // The server sends none with a live tariff; one that slipped through is not shown.
        ended: { planName: 'Старт', endedAt: new Date('2026-09-01T09:00:00Z'), reason: 'not_paid' },
      }),
    )
    getOffers.mockResolvedValue(offers({ current: 'business' }))
    showPlans()

    await screen.findByRole('heading', { level: 2, name: 'Тариф «Бизнес»' })
    expect(pageText()).not.toMatch(/Закончился|Тариф «Старт»/)
  })
})

// YOOKASSA_AUTOPAYMENTS=off: payments are on, and the shop saves no payment method.
describe('the «Тарифы» page of a shop that takes one-time payments only', () => {
  const overdue = { status: 'past_due', pastDueSince: new Date('2026-10-18T09:00:05Z') } as const
  const endsAt = { pastDueEndsAt: new Date('2026-10-25T09:00:05Z') }
  const promises = /Сохраним способ оплаты|будем списывать|привяжем карту|Если включите/

  it('sells a tariff without asking for the consent to auto-renewal', async () => {
    getOverview.mockResolvedValue(overviewOf(ONE_TIME_ONLY))
    startCheckout.mockResolvedValue({
      orderId: '018f0000-0000-7000-8000-0000000000aa',
      confirmationUrl: 'https://yookassa.example/pay/1',
    })
    showPlans()
    // The tariffs are on sale as at any shop.
    fireEvent.click(
      within(await planCard('Бизнес')).getByRole('button', { name: 'Выбрать «Бизнес»' }),
    )

    const dialog = await screen.findByRole('dialog', { name: 'Тариф «Бизнес»' })
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    expect(dialogText()).toContain(
      'Автопродление пока недоступно: тариф будет действовать месяц, потом его можно оформить снова.',
    )
    expect(dialogText()).not.toMatch(promises)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Перейти к оплате' }))

    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('https://yookassa.example/pay/1'))
    expect(startCheckout).toHaveBeenCalledExactlyOnceWith(
      { planSlug: 'business', autoRenew: false },
      expect.anything(),
    )
  })

  it.each([
    ['without a saved card', noCard, 'Не сохранён', 0],
    ['with a card saved before', cardKept, 'Карта «Мир» •• 4444', 1],
  ])(
    'offers no «Включить автопродление» to a tariff %s, and promises no charge',
    async (_case, patch, methodRow, methodLinks) => {
      onBusiness(patch, ONE_TIME_ONLY)
      showPlans()

      const block = await tariffBlock()
      expect(plain(block.textContent)).toContain(
        'Автопродление отключено. Тариф и 45 кредитов по тарифу доступны до 18 октября 2026.',
      )
      expect(screen.queryByRole('button', { name: 'Включить автопродление' })).toBeNull()
      expect(plain(block.textContent)).toContain(
        'Автопродление пока недоступно: когда тариф закончится, его можно оформить снова.',
      )
      expect(pageText()).not.toMatch(promises)
      expect(row('Действует до')).toBe('18 октября 2026')
      expect(resumeAutoRenew).not.toHaveBeenCalled()
      // A tariff that ends with its period has no next period to choose another tariff for;
      // the pack is still sold on top of it.
      expect(screen.getAllByRole('button').map(buttonName)).toEqual(['Купить пакет'])
      // «Изменить» leads to «Оплата» only where that page has something to do: a card saved
      // before can be unlinked there, and a tariff without one is offered nothing.
      expect(row('Способ оплаты')).toBe(methodRow)
      expect(screen.queryAllByRole('link', { name: 'Изменить способ оплаты' })).toHaveLength(
        methodLinks,
      )
      expect(screen.getByRole('link', { name: 'Подробнее о кредитах' })).toBeInTheDocument()
    },
  )

  it('does not tell a tariff with a scheduled change to switch auto-renewal on', async () => {
    onBusiness({ ...cardKept, nextPlan: agencyPlan }, ONE_TIME_ONLY)
    showPlans()

    const coming = await screen.findByRole('group', { name: 'Выбран тариф «Агентство»' })
    expect(plain(coming.textContent)).toContain(
      'Автопродление отключено, поэтому 18 октября тариф закончится и переход не состоится.',
    )
    expect(plain(coming.textContent)).not.toMatch(/включите автопродление|спишем/)
    // The choice can still be taken back.
    expect(within(coming).getByRole('button', { name: 'Отменить переход' })).toBeEnabled()
  })

  it('leaves a tariff that renews with a card saved before as it is, with the way to stop it', async () => {
    // The switch was turned off after this card had been saved: the charge is still made.
    onBusiness({}, ONE_TIME_ONLY)
    showPlans()

    expect(plain((await renewalSection()).textContent)).toContain(
      'Включено. 18 октября спишем 12 900 ₽ сохранённым способом оплаты и начислим 800 кредитов на новый период.',
    )
    expect(row('Следующее списание')).toBe('18 октября 2026 — 12 900 ₽')
    expect(screen.getAllByRole('button').map(buttonName)).toEqual([
      'Перейти на тариф «Агентство»',
      'Купить пакет',
      'Отключить автопродление',
    ])
    // The saved card can be unlinked on «Оплата»: the way there stays.
    expect(screen.getByRole('link', { name: 'Изменить способ оплаты' })).toBeInTheDocument()

    // Stopping it cannot be taken back here — no «Включить автопродление» follows —, and the
    // customer reads that before the step, as the last thing the dialog confirms.
    fireEvent.click(
      within(await renewalSection()).getByRole('button', { name: 'Отключить автопродление' }),
    )
    const dialog = await screen.findByRole('dialog', { name: 'Отключить автопродление?' })
    const confirmed = plain(
      document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent,
    )
    expect(confirmed).toContain('Тариф «Бизнес» будет действовать до 18 октября 2026.')
    expect(confirmed).toMatch(/сохранятся\.Включить автопродление снова пока будет нельзя\.$/)
    expect(cancelAutoRenew).not.toHaveBeenCalled()
  })

  it('offers an overdue tariff the payment by hand, and no card to replace', async () => {
    onBusiness(overdue, { ...ONE_TIME_ONLY, ...endsAt })
    showPlans()

    const alert = await screen.findByRole('alert')
    expect(plain(alert.textContent)).toContain(
      'Оплатите тариф: пока оплата не пройдёт, новые задачи не принимаются. 25 октября 2026 тариф закончится, если оплата не пройдёт раньше.',
    )
    expect(plain(alert.textContent)).not.toContain('Карту для следующих списаний')
    const block = await tariffBlock()
    expect(within(block).getByRole('button', { name: 'Оплатить сейчас' })).toBeEnabled()
    expect(within(block).queryByRole('link', { name: 'Заменить карту' })).toBeNull()
    // Auto-renewal is on with the card saved before: the payment by hand saves no other.
    expect(plain((await renewalSection()).textContent)).toContain(
      'Включено. Способ оплаты, которым вы оплатите тариф, не сохранится: дальше тариф будет продлеваться со способа оплаты, сохранённого раньше. Перед каждым списанием пришлём письмо.',
    )
  })

  it.each([
    [
      'auto-renewal is on',
      {},
      'Способ оплаты, которым вы заплатите сейчас, мы не сохраним. Автопродление включено: каждый месяц будем списывать 12 900 ₽ способом оплаты, сохранённым раньше. Перед списанием пришлём письмо. Отключить можно в настройках в любой день.',
    ],
    [
      'auto-renewal is off',
      cardKept,
      'Автопродление отключено: способ оплаты мы не сохраним, тариф будет действовать месяц и сам не продлится.',
    ],
  ])(
    'does not promise in «Оплатить сейчас» to save the method when %s',
    async (_case, patch, terms) => {
      onBusiness({ ...overdue, ...patch }, { ...ONE_TIME_ONLY, ...endsAt })
      showPlans()

      fireEvent.click(within(await tariffBlock()).getByRole('button', { name: 'Оплатить сейчас' }))

      const dialog = await screen.findByRole('dialog', { name: 'Тариф «Бизнес»' })
      await waitFor(() =>
        expect(within(dialog).getByRole('button', { name: /Перейти к оплате/ })).toBeEnabled(),
      )
      expect(dialogText()).toContain(terms)
      expect(dialogText()).not.toMatch(/сохраним способ оплаты, которым вы заплатите сейчас, и/i)
    },
  )

  it('tells «Оплатить сейчас» what the shop does now, not what the page knew', async () => {
    // The page was read while the shop still saved payment methods.
    onBusiness(overdue, endsAt)
    showPlans()
    const opener = within(await tariffBlock()).getByRole('button', { name: 'Оплатить сейчас' })
    // The dialog reads the overview anew: the switch has been turned off meanwhile.
    onBusiness(overdue, { ...ONE_TIME_ONLY, ...endsAt })

    fireEvent.click(opener)

    const dialog = await screen.findByRole('dialog', { name: 'Тариф «Бизнес»' })
    await waitFor(() =>
      expect(plain(dialog.textContent)).toContain(
        'Способ оплаты, которым вы заплатите сейчас, мы не сохраним.',
      ),
    )
  })

  it('says in its own words why a stale «Включить автопродление» was refused', async () => {
    // The page still offers the switch: the shop stopped saving methods after it was read.
    onBusiness(cardKept)
    resumeAutoRenew.mockRejectedValue(
      serverRefusal(
        'Автопродление пока недоступно. Оформите тариф без него: он будет действовать месяц',
        'BILLING_AUTO_RENEWAL_UNAVAILABLE',
      ),
    )
    showPlans()
    const block = await tariffBlock()

    fireEvent.click(within(block).getByRole('button', { name: 'Включить автопродление' }))

    // Not the server's sentence, which is about buying a tariff: this customer has one.
    expect(await within(block).findByRole('alert')).toHaveTextContent(
      'Автопродление пока недоступно: включить его сейчас нельзя.',
    )
    expect(hardNavigate).not.toHaveBeenCalled()
  })
})

describe('two kinds of dialogs opened on one page', () => {
  // Every dialog counts its own openings from 1. Keyed by that count alone, two dialogs that
  // were each opened once were siblings with one key, and the second of them could not be
  // closed — in the orders below, where it stands earlier among the siblings than the first.
  const reported: string[] = []
  let consoleError: { mockRestore: () => void }

  beforeEach(() => {
    reported.length = 0
    // React reports two children with one key through console.error.
    consoleError = vi.spyOn(console, 'error').mockImplementation((...said: unknown[]) => {
      reported.push(said.map(String).join(' '))
    })
  })
  afterEach(() => {
    consoleError.mockRestore()
  })

  const noDialog = () => waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  const sameKeyWarnings = () => reported.filter((said) => said.includes('same key'))

  it('closes the pack dialog by Escape after the change dialog was opened and closed', async () => {
    onBusiness()
    showPlans()

    fireEvent.click(
      within(await planCard('Агентство')).getByRole('button', {
        name: 'Перейти на тариф «Агентство»',
      }),
    )
    const change = await screen.findByRole('dialog', { name: 'Перейти на тариф «Агентство»?' })
    fireEvent.keyDown(change, { key: 'Escape' })
    await noDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Купить пакет' }))
    const pack = await screen.findByRole('dialog', { name: 'Пакет из 100 кредитов' })
    fireEvent.keyDown(pack, { key: 'Escape' })

    await noDialog()
    // And once more: the second opening of a kind has a count the others have not reached.
    fireEvent.click(screen.getByRole('button', { name: 'Купить пакет' }))
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Пакет из 100 кредитов' })).getByRole(
        'button',
        { name: 'Отмена' },
      ),
    )
    await noDialog()
    expect(sameKeyWarnings()).toEqual([])
    expect(schedulePlanChange).not.toHaveBeenCalled()
    expect(startPackCheckout).not.toHaveBeenCalled()
  })

  it('closes the change dialog by «Не менять» after the auto-renewal dialog was opened and closed', async () => {
    onBusiness()
    showPlans()

    fireEvent.click(
      within(await renewalSection()).getByRole('button', { name: 'Отключить автопродление' }),
    )
    const renewal = await screen.findByRole('dialog', { name: 'Отключить автопродление?' })
    fireEvent.click(within(renewal).getByRole('button', { name: 'Оставить включённым' }))
    await noDialog()

    fireEvent.click(
      within(await planCard('Агентство')).getByRole('button', {
        name: 'Перейти на тариф «Агентство»',
      }),
    )
    const change = await screen.findByRole('dialog', { name: 'Перейти на тариф «Агентство»?' })
    fireEvent.click(within(change).getByRole('button', { name: 'Не менять' }))

    await noDialog()
    // Back to the first kind: it opens and closes as before.
    fireEvent.click(
      within(await renewalSection()).getByRole('button', { name: 'Отключить автопродление' }),
    )
    fireEvent.keyDown(await screen.findByRole('dialog', { name: 'Отключить автопродление?' }), {
      key: 'Escape',
    })
    await noDialog()
    expect(sameKeyWarnings()).toEqual([])
    expect(cancelAutoRenew).not.toHaveBeenCalled()
    expect(schedulePlanChange).not.toHaveBeenCalled()
  })

  it('closes the dialog of «Оплатить сейчас» after the auto-renewal dialog was opened and closed', async () => {
    onBusiness(
      { status: 'past_due', pastDueSince: new Date('2026-10-18T09:00:05Z') },
      { pastDueEndsAt: new Date('2026-10-25T09:00:05Z') },
    )
    showPlans()

    fireEvent.click(
      within(await renewalSection()).getByRole('button', { name: 'Отключить автопродление' }),
    )
    const renewal = await screen.findByRole('dialog', { name: 'Отключить автопродление?' })
    fireEvent.keyDown(renewal, { key: 'Escape' })
    await noDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Оплатить сейчас' }))
    const pay = await screen.findByRole('dialog', { name: 'Тариф «Бизнес»' })
    fireEvent.click(within(pay).getByRole('button', { name: 'Отмена' }))

    await noDialog()
    expect(sameKeyWarnings()).toEqual([])
    expect(startPastDuePayment).not.toHaveBeenCalled()
  })
})

describe('the gift of the registration on «Тарифы»', () => {
  const A1 =
    'У вас 35 подарочных кредитов — их хватит на семь небольших правок или на две-три задачи побольше. Когда кредиты закончатся, понадобится тариф.'
  const offTariff = 'новые задачи принимаются, только пока есть подарочные кредиты'
  const noTariff = (gift: number, granted = gift > 0, patch: Partial<BillingOverview> = {}) =>
    getOverview.mockResolvedValue(
      overviewOf({ credits: creditBalances(0, 0, gift, granted), ...patch }),
    )
  /** The line under the heading of the page. */
  const lead = async () => {
    await screen.findByRole('list', { name: 'Тарифы' })
    return plain(
      screen.getByRole('heading', { level: 1, name: 'Тарифы' }).nextElementSibling?.textContent,
    )
  }

  it('tells a new user, who has no workspace yet, of the gift they are promised', async () => {
    // Not granted yet: it is granted with the workspace, which the first site makes.
    noTariff(35, false)
    showPlans()

    expect(await lead()).toBe(A1)
    // The tariffs are offered as to anybody without one.
    expect(screen.getByRole('heading', { level: 2, name: 'Выберите тариф' })).toBeVisible()
    expect(
      within(await planCard('Старт')).getByRole('button', { name: 'Выбрать «Старт»' }),
    ).toBeEnabled()
    expect(pageText()).not.toContain('Выберите тариф, чтобы')
    // No tariff, so no row of balances; and «Оплата за действие» is named nowhere.
    expect(screen.queryByText('Кредиты')).not.toBeInTheDocument()
    expect(pageText()).not.toMatch(/за действие|кошел/i)
  })

  it('says the same once the gift is on the account', async () => {
    noTariff(35)
    showPlans()

    expect(await lead()).toBe(A1)
  })

  it.each([
    [
      'a gift that was partly spent',
      20,
      'У вас 20 подарочных кредитов — их хватит на четыре небольшие правки или на одну-две задачи побольше. Когда кредиты закончатся, понадобится тариф.',
    ],
    [
      'a gift that starts no task',
      3,
      'Осталось 3 подарочных кредита, а на новую задачу нужно не меньше 5. Выберите тариф — подарочные кредиты сохранятся и прибавятся к кредитам тарифа.',
    ],
  ])('counts what is left of %s', async (_case, gift, text) => {
    noTariff(gift)
    showPlans()

    expect(await lead()).toBe(text)
  })

  it('says that the gift is used up and sends the customer to a tariff', async () => {
    noTariff(0, true)
    showPlans()
    expect(await lead()).toBe(
      'Подарочные кредиты закончились. Чтобы ставить новые задачи, выберите тариф.',
    )
  })

  it('keeps the gift and the missing payments in one line while payments are off', async () => {
    noTariff(35, true, { paymentsEnabled: false })
    showPlans()

    expect(await lead()).toBe(`${A1} Оплата пока недоступна.`)
    expect(pageText().match(/Оплата пока недоступна\./g)).toHaveLength(1)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  /** «Бизнес» with 800 credits of the tariff, the gift and, when told, a pack. */
  function onTariff(
    patch: Parameters<typeof subscriptionTo>[0] = {},
    {
      gift = 35,
      pack = 0,
      ...overview
    }: Partial<BillingOverview> & { gift?: number; pack?: number } = {},
  ) {
    getOverview.mockResolvedValue(
      overviewOf({
        subscription: subscriptionTo(patch),
        credits: creditBalances(800, pack, gift, true),
        ...overview,
      }),
    )
    getOffers.mockResolvedValue(offers({ siteCount: 1, current: 'business' }))
  }

  it('names the gift credits of a customer with a tariff in the row of balances', async () => {
    onTariff()
    showPlans()
    await tariffBlock()

    expect(row('Кредиты')).toBe('Осталось 835: 800 по тарифу и 35 подарочных')
    expect(await lead()).toBe('Ваш тариф и автопродление.')
  })

  it('names the three accounts in the order their credits are spent in', async () => {
    onTariff({}, { pack: 100 })
    showPlans()
    await tariffBlock()

    expect(row('Кредиты')).toBe('Осталось 935: 800 по тарифу, 35 подарочных и 100 из пакета')
  })

  it('does not name a gift that is used up as a part of what is left', async () => {
    onTariff({}, { gift: 0, pack: 100 })
    showPlans()
    await tariffBlock()

    expect(row('Кредиты')).toBe('Осталось 900: 800 по тарифу и 100 из пакета')
  })

  it('says of a tariff that does not renew that tasks are taken after it on gift credits', async () => {
    onTariff({ autoRenewal: false, paymentMethod: null }, { pack: 100 })
    showPlans()

    expect(plain((await tariffBlock()).textContent)).toContain(
      `Автопродление отключено. Тариф и 800 кредитов по тарифу доступны до 18 октября 2026. После этого ${offTariff}. 100 кредитов из пакета, сайты и история правок сохранятся.`,
    )
    expect(pageText()).not.toContain('новые задачи не принимаются')
  })

  it('says so before auto-renewal is switched off, and after it', async () => {
    onTariff({}, { pack: 100 })
    cancelAutoRenew.mockResolvedValue({
      renewalCharge: 'none',
      periodEnd: new Date('2026-10-18T09:00:00Z'),
    })
    showPlans()
    fireEvent.click(
      within(await renewalSection()).getByRole('button', { name: 'Отключить автопродление' }),
    )

    const dialog = await screen.findByRole('dialog', { name: 'Отключить автопродление?' })
    expect(dialogText()).toContain(
      `С 18 октября новые задачи будут приниматься, только пока есть подарочные кредиты. 100 кредитов из пакета, сайты и история правок сохранятся.`,
    )
    expect(dialogText()).not.toContain('не будут приниматься')

    // What the page reads after the switch.
    onTariff({ autoRenewal: false }, { pack: 100 })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Отключить' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(plain(screen.getByRole('status').textContent)).toContain(`После этого ${offTariff}.`)
  })

  it('keeps the old words where the gift cannot start a task', async () => {
    onTariff({ autoRenewal: false, paymentMethod: null }, { gift: 4 })
    showPlans()

    expect(plain((await tariffBlock()).textContent)).toContain(
      'После этого новые задачи не принимаются, пока вы снова не выберете тариф.',
    )
    expect(row('Кредиты')).toBe('Осталось 804: 800 по тарифу и 4 подарочных')
  })

  it('shows the gift credits of an overdue tariff as left, and the rest as coming with the payment', async () => {
    onTariff(
      { status: 'past_due', pastDueSince: new Date('2026-10-18T09:00:05Z') },
      { pack: 100, pastDueEndsAt: new Date('2026-10-25T09:00:05Z') },
    )
    showPlans()

    const alert = await screen.findByRole('alert')
    expect(plain(alert.textContent)).toContain(
      `Оплатите тариф: пока оплата не пройдёт, ${offTariff}. 25 октября 2026 тариф закончится, если оплата не пройдёт раньше.`,
    )
    expect(row('Кредиты')).toBe(
      'Осталось 35 подарочных. После оплаты — новые кредиты по тарифу и 100 из пакета',
    )
    // The credits of the period that ended are still not the customer's.
    expect(pageText()).not.toMatch(/800 по тарифу/)
  })

  it('tells a customer whose tariff is over what the gift is still enough for', async () => {
    getOverview.mockResolvedValue(
      overviewOf({
        credits: creditBalances(0, 100, 35, true),
        ended: {
          planName: 'Бизнес',
          endedAt: new Date('2026-10-18T09:00:00Z'),
          reason: 'not_renewed',
        },
      }),
    )
    showPlans()

    const block = await tariffBlock()
    expect(plain(block.textContent)).toContain(
      'Новые задачи принимаются, только пока есть подарочные кредиты. 100 кредитов из пакета, сайты и история правок на месте.',
    )
    expect(await lead()).toBe(A1)
    // The page does not say both that tasks are taken and that they are not.
    expect(pageText()).not.toMatch(/не принимаются|чтобы снова ставить/)
    expect(within(block).getByRole('link', { name: 'Выбрать тариф' })).toHaveAttribute(
      'href',
      '#plans',
    )
  })

  it('says of a tariff that is over and a gift that is used up that tasks are not taken', async () => {
    getOverview.mockResolvedValue(
      overviewOf({
        credits: creditBalances(0, 0, 0, true),
        ended: {
          planName: 'Бизнес',
          endedAt: new Date('2026-10-18T09:00:00Z'),
          reason: 'not_paid',
        },
      }),
    )
    showPlans()

    expect(plain((await tariffBlock()).textContent)).toContain(
      'Оплата за следующий период не прошла, и тариф закончился. Новые задачи сейчас не принимаются. Сайты и история правок на месте.',
    )
    expect(await lead()).toBe(
      'Подарочные кредиты закончились. Чтобы ставить новые задачи, выберите тариф.',
    )
  })
})

describe('what stands in the way of a new task on «Тарифы»', () => {
  /** The notice of the block of the tariff, as it reads; null when the block gives none. */
  const noticeOf = async () => {
    const block = (await screen.findByRole('heading', { level: 2, name: /^Тариф «/ })).closest(
      'section',
    )
    if (!block) throw new Error('the tariff has no block')
    const notice = within(block).queryByRole('status')
    return notice === null ? null : plain(notice.textContent)
  }
  const onTariff = (
    credits: NonNullable<Parameters<typeof overviewOf>[0]>['credits'],
    patch: Parameters<typeof subscriptionTo>[0] = {},
    facts: Parameters<typeof overviewOf>[1] = {},
  ) => {
    getOverview.mockResolvedValue(
      overviewOf({ subscription: subscriptionTo(patch), credits }, facts),
    )
    getOffers.mockResolvedValue(offers({ current: 'business' }))
  }

  it('says nothing while a task would be taken', async () => {
    onTariff(creditBalances(765, 100))
    showPlans()

    expect(await noticeOf()).toBeNull()
    expect(row('Кредиты')).toBe('Осталось 865: 765 по тарифу и 100 из пакета')
  })

  it('says that the limits ran out, when the next credits come and that a pack helps now', async () => {
    onTariff(creditBalances(0, 0))
    showPlans()

    expect(await noticeOf()).toBe(
      'Лимиты закончились: кредиты по тарифу и из пакета израсходованы. 18 октября начислим 800 кредитов по тарифу «Бизнес». Чтобы продолжить сейчас, купите пакет — 100 кредитов за 1 990 ₽. Кредиты из пакета не сгорают.',
    )
    expect(row('Кредиты')).toBe('Закончились')
    // Another tariff does not help today, and the page says so.
    expect(pageText()).toContain('Новый тариф начнёт действовать со следующего периода.')
    // The pack is offered once, by its row under the tariffs.
    expect(screen.getAllByRole('button', { name: 'Купить пакет' })).toHaveLength(1)
  })

  it('says «Закончились» in the row of the credits when the few that are left start no task', async () => {
    onTariff(creditBalances(3, 0))
    showPlans()

    expect(await noticeOf()).toMatch(
      /^Лимиты закончились: осталось 3 кредита, а на новую задачу нужно не меньше 5\. /,
    )
    expect(row('Кредиты')).toBe('Закончились')
  })

  it('keeps the credits in the row while they are set aside for tasks in work', async () => {
    onTariff({
      tariff: { balance: 47, held: 45, available: 2 },
      gift: { balance: 0, held: 0, available: 0, granted: false },
      pack: { balance: 0, held: 0, available: 0 },
      totalAvailable: 2,
    })
    showPlans()

    expect(await noticeOf()).toBe(
      'Кредиты заняты задачами в работе: под них отложено 45. Когда задачи закончатся, спишем только то, что ушло на работу, остальное вернётся — и можно будет поставить новую. Чтобы не ждать, купите пакет — 100 кредитов за 1 990 ₽.',
    )
    expect(row('Кредиты')).toBe('Осталось 2 по тарифу')
    // Waiting is the other way out: no other tariff is spoken of.
    expect(pageText()).not.toContain('Новый тариф начнёт действовать')
  })

  it('does not say «Закончились» in the row when every credit is set aside for tasks in work', async () => {
    onTariff({
      tariff: { balance: 45, held: 45, available: 0 },
      gift: { balance: 0, held: 0, available: 0, granted: false },
      pack: { balance: 0, held: 0, available: 0 },
      totalAvailable: 0,
    })
    showPlans()

    expect(await noticeOf()).toMatch(
      /^Кредиты заняты задачами в работе: под них отложено 45\. Когда задачи закончатся, .+ остальное вернётся/,
    )
    // The row agrees with the notice above it: the credits wait, they did not run out.
    expect(row('Кредиты')).toBe('Отложено под задачи в работе: 45')
    expect(pageText()).not.toContain('Закончились')
  })

  it('offers auto-renewal beside the pack to a tariff that does not renew', async () => {
    onTariff(creditBalances(0, 0), { autoRenewal: false, paymentMethod: null })
    showPlans()

    expect(await noticeOf()).toBe(
      'Лимиты закончились, а тариф «Бизнес» действует до 18 октября и не продлится. Купите пакет — 100 кредитов за 1 990 ₽, они не сгорают, — или включите автопродление: тогда 18 октября начислим 800 кредитов.',
    )
    // The switch is in the same block.
    expect(screen.getByRole('button', { name: 'Включить автопродление' })).toBeVisible()
  })

  it('tells of the tariff credits of the day and of work that ended without a charge', async () => {
    onTariff(creditBalances(765, 0), {}, { today: { charged: 100 } })
    const first = showPlansOnce()
    expect(await noticeOf()).toBe(
      'Кредиты по тарифу на сегодня закончились: потрачено 100 из 100. Завтра снова можно будет потратить до 100 кредитов. Чтобы продолжить сегодня, купите пакет — 100 кредитов за 1 990 ₽. Кредиты из пакета не сгорают и дневным лимитом не ограничены.',
    )
    first.unmount()

    onTariff(creditBalances(765, 0), {}, { unpaidWork: 800 })
    showPlans()
    expect(await noticeOf()).toBe(
      'В этом периоде слишком много задач остановилось без результата, поэтому новые задачи временно не принимаются. Кредиты за них не списаны. Напишите нам — разберёмся, в чём дело.',
    )
  })

  it('names no payment while payments are off', async () => {
    getOverview.mockResolvedValue(
      overviewOf({
        paymentsEnabled: false,
        subscription: subscriptionTo(),
        credits: creditBalances(0, 0),
      }),
    )
    getOffers.mockResolvedValue(offers({ current: 'business' }))
    showPlans()

    expect(await noticeOf()).toBe(
      'Лимиты закончились: кредиты по тарифу и из пакета израсходованы. 18 октября начислим 800 кредитов по тарифу «Бизнес».',
    )
    expect(pageText()).not.toContain('Новый тариф начнёт действовать')
  })

  it('leaves the unpaid tariff to the block of its failed charge, and adds what else refuses', async () => {
    // Not paid, and nothing of the gift: the block of the failed charge says it all.
    onTariff(creditBalances(765, 100), { status: 'past_due' })
    const first = showPlansOnce()
    expect(await noticeOf()).toBeNull()
    expect(pageText()).toContain('пока оплата не пройдёт, новые задачи не принимаются.')
    first.unmount()

    // The gift is left, and too much work ended without a charge: only the payment helps.
    onTariff(creditBalances(765, 100, 15), { status: 'past_due' }, { unpaidWork: 70 })
    showPlans()
    expect(await noticeOf()).toBe(
      'Пробные задачи закончились: несколько задач остановились без результата, и без тарифа мы больше не можем их принимать. Оплатите тариф, чтобы продолжить; оставшиеся 15 подарочных кредитов сохранятся.',
    )
    expect(pageText()).toContain('пока оплата не пройдёт, новые задачи не принимаются.')
  })

  it('does not say of an unpaid tariff that no task is taken beside a refusal of the moment', async () => {
    const onGift =
      'Оплатите тариф: пока оплата не пройдёт, новые задачи принимаются, только пока есть подарочные кредиты.'
    // The gift carries a task whatever the day took: an unpaid tariff has no day.
    onTariff(creditBalances(765, 100, 20), { status: 'past_due' }, { today: { charged: 500 } })
    const first = showPlansOnce()
    expect(await noticeOf()).toBeNull()
    // The block of the failed charge says that tasks are taken on the gift.
    expect(pageText()).toContain(onGift)
    expect(pageText()).not.toContain('новые задачи не принимаются')
    expect(row('Кредиты')).toBe(
      'Осталось 20 подарочных. После оплаты — новые кредиты по тарифу и 100 из пакета',
    )
    first.unmount()

    // The gift is set aside for the task in work: what it does not use comes back.
    onTariff(
      {
        tariff: { balance: 765, held: 0, available: 765 },
        gift: { balance: 35, held: 35, available: 0, granted: true },
        pack: { balance: 100, held: 0, available: 100 },
        totalAvailable: 865,
      },
      { status: 'past_due' },
    )
    showPlans()
    expect(await noticeOf()).toBe(
      'Подарочные кредиты заняты задачей в работе: под неё отложено 35. Когда она закончится, спишем только то, что ушло на работу, остальное вернётся — и можно будет поставить следующую.',
    )
    expect(pageText()).toContain(onGift)
    expect(pageText()).not.toContain('новые задачи не принимаются')
    // The row agrees with both: the gift waits for the task in work, it is not out of reach.
    expect(row('Кредиты')).toBe(
      'Отложено под задачу в работе: 35 подарочных. После оплаты — новые кредиты по тарифу и 100 из пакета',
    )
    expect(pageText()).not.toContain('Недоступны')
  })

  it('says of an unpaid tariff that tasks are taken on the gift only while the server takes one', async () => {
    onTariff(creditBalances(765, 100, 35), { status: 'past_due' })
    showPlans()

    expect(await noticeOf()).toBeNull()
    expect(pageText()).toContain(
      'пока оплата не пройдёт, новые задачи принимаются, только пока есть подарочные кредиты.',
    )
  })

  it('says that tasks are paused while the calculation of credits is being updated', async () => {
    onTariff(creditBalances(765, 100), {}, { rateUsable: false })
    showPlans()

    expect(await noticeOf()).toBe(
      'Задачи сейчас не принимаются: мы обновляем расчёт кредитов. Попробуйте ещё раз немного позже.',
    )
    expect(row('Кредиты')).toBe('Осталось 865: 765 по тарифу и 100 из пакета')
  })

  describe('of a customer without a tariff', () => {
    const lead = async () => {
      await screen.findByRole('heading', { level: 2, name: 'Выберите тариф' })
      return plain(
        screen.getByRole('heading', { level: 1, name: 'Тарифы' }).nextElementSibling?.textContent,
      )
    }

    it('tells of no day without a tariff, and of the trial that is over', async () => {
      getOverview.mockResolvedValue(
        overviewOf({ credits: creditBalances(0, 0, 20) }, { today: { charged: 500 } }),
      )
      const first = showPlansOnce()
      expect(await lead()).toBe(
        'У вас 20 подарочных кредитов — их хватит на четыре небольшие правки или на одну-две задачи побольше. Когда кредиты закончатся, понадобится тариф.',
      )
      first.unmount()

      getOverview.mockResolvedValue(
        overviewOf({ credits: creditBalances(0, 0, 15) }, { unpaidWork: 70 }),
      )
      showPlans()
      expect(await lead()).toBe(
        'Пробные задачи закончились: несколько задач остановились без результата, и без тарифа мы больше не можем их принимать. Выберите тариф, чтобы продолжить; оставшиеся 15 подарочных кредитов сохранятся.',
      )
    })

    it('says what the customer has before the pause of the platform', async () => {
      getOverview.mockResolvedValue(
        overviewOf({ credits: creditBalances(0, 0, 35) }, { rateUsable: false }),
      )
      showPlans()

      expect(await lead()).toBe(
        'У вас 35 подарочных кредитов. Задачи сейчас не принимаются: мы обновляем расчёт кредитов. Попробуйте ещё раз немного позже.',
      )
    })
  })
})

describe('«Как считаются кредиты» on «Тарифы»', () => {
  const SOL = {
    model: null,
    input: '38.75',
    cacheRead: '3.88',
    cacheWrite: '38.75',
    output: '193.75',
  }
  const explainer = async () => {
    const details = (await screen.findByText('Как считаются кредиты')).closest('details')
    if (!details) throw new Error('the block is not collapsed in a details element')
    return details
  }

  it('stands collapsed under the rule of the tariffs, for a customer with a tariff and without one', async () => {
    showPlans()

    const block = await explainer()
    expect(block.open).toBe(false)
    const section = screen
      .getByRole('heading', { level: 2, name: 'Выберите тариф' })
      .closest('section')
    expect(section).toContainElement(block)
    // Above the tariffs themselves.
    expect(
      block.compareDocumentPosition(screen.getByRole('list', { name: 'Тарифы' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(plain(block.textContent)).toContain(
      'В дневной лимит входят кредиты по тарифу, отложенные под задачи за день, — в том числе на продолжение задачи и повторную попытку. Когда задача закончится, в лимите дня останется только то, что за неё списано, а остальное вернётся. Если при списании задачу оплатят кредиты по тарифу вместо отложенных под неё подарочных кредитов или кредитов из пакета, эти кредиты по тарифу войдут в лимит дня списания. Подарочные кредиты и кредиты из пакета дневным лимитом не ограничены. День считается по московскому времени.',
    )
  })

  it('shows no «Точный расчёт» while the server sends no table: no credit rate is usable', async () => {
    showPlans()

    await explainer()
    expect(screen.queryByText('Точный расчёт')).not.toBeInTheDocument()
    expect(pageText()).not.toMatch(/токен/i)
  })

  it('shows «Точный расчёт» with the table the server sends', async () => {
    getOffers.mockResolvedValue(offers({ creditConversion: { rows: [SOL] } }))
    showPlans()

    const block = await explainer()
    const exact = within(block).getByText('Точный расчёт').closest('details')
    expect(exact).not.toBeNull()
    expect(plain(exact?.textContent)).toContain(
      'За 1 млн токенов нового текста — 38,75 кредита, повторно прочитанного — 3,88, написанного — 193,75.',
    )
    // The word for the unit of a model stands nowhere on the page but in that block.
    const rest = document.body.cloneNode(true) as HTMLElement
    for (const nested of rest.querySelectorAll('details details')) nested.remove()
    expect(plain(rest.textContent)).not.toMatch(/токен/i)
  })
})
