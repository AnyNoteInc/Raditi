// @vitest-environment jsdom
import {
  focusManager,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrderState } from './billing-types'
import { ORDER_POLL_MS, ORDER_WAIT_MS, OrderReturn } from './order-return'
import { offers, overviewOf, plain, serverRefusal, subscriptionTo } from './testing'

const { syncOrder, trpc } = vi.hoisted(() => ({
  syncOrder: vi.fn<(input: { orderId: string }) => Promise<OrderState>>(),
  // One object for every render, as the real context gives.
  trpc: {
    billing: {
      overview: { queryKey: () => ['billing', 'overview'] },
      plans: { queryKey: () => ['billing', 'plans'] },
    },
  },
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => trpc,
  useTRPCClient: () => ({ billing: { syncOrder: { mutate: syncOrder } } }),
}))

const ORDER_ID = '018f0000-0000-7000-8000-0000000000aa'

function orderIn(status: OrderState['status'], patch: Partial<OrderState> = {}): OrderState {
  return {
    orderId: ORDER_ID,
    status,
    kind: 'subscription',
    planName: 'Бизнес',
    packCredits: null,
    amount: '12900.00',
    failureText: null,
    refundNeeded: false,
    subscription: null,
    ...patch,
  }
}

const paid = orderIn('paid', { subscription: subscriptionTo() })
/** What tells a pack order from a tariff one. */
const packOrder = {
  kind: 'pack',
  planName: 'Пакет из 100 кредитов',
  packCredits: 100,
  amount: '1990.00',
} satisfies Partial<OrderState>

// The query client hands its news over through a zero timeout, and the fake clock puts a zero
// timeout that is set while it ticks a millisecond later. With a microtask instead, an answer
// is on the screen in the same instant it arrives, and the checks below can name exact times.
notifyManager.setScheduler(queueMicrotask)

/** Lets the time pass, with everything that is due in it: timers, answers and redraws. */
async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** The page of an order after its first request has been answered. */
async function showReturn(orderId: string | null = ORDER_ID, queryClient = new QueryClient()) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <OrderReturn orderId={orderId} />
    </QueryClientProvider>,
  )
  await pass(0)
  return view
}

const pageText = () => plain(document.body.textContent)
const heading = () => screen.getByRole('heading', { level: 2 }).textContent
const requests = () => syncOrder.mock.calls.length

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  syncOrder.mockResolvedValue(orderIn('pending'))
})

afterEach(() => {
  vi.useRealTimers()
  focusManager.setFocused(undefined)
})

/** The customer looks at another tab or window and comes back to this one. */
function comeBackToTheTab() {
  act(() => {
    focusManager.setFocused(false)
    focusManager.setFocused(true)
  })
}

describe('the return page of an order that cannot be named', () => {
  it.each([null])('shows «not found» without asking the server', async (orderId) => {
    await showReturn(orderId)

    expect(screen.getByRole('heading', { level: 1, name: 'Оплата' })).toBeInTheDocument()
    expect(heading()).toBe('Заказ не найден')
    expect(pageText()).toContain('Проверьте ссылку или откройте «Тарифы» в настройках.')
    expect(screen.getByRole('link', { name: 'К тарифам' })).toHaveAttribute(
      'href',
      '/settings/plans',
    )

    await pass(ORDER_WAIT_MS * 2)
    expect(syncOrder).not.toHaveBeenCalled()
    expect(heading()).toBe('Заказ не найден')
  })

  it('shows the same for an order that is unknown or belongs to someone else', async () => {
    syncOrder.mockRejectedValue(
      serverRefusal(
        'Не нашли такой заказ. Проверьте ссылку или откройте «Тарифы» в настройках',
        'BILLING_ORDER_NOT_FOUND',
      ),
    )
    await showReturn()

    expect(heading()).toBe('Заказ не найден')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'К тарифам' })).toHaveAttribute(
      'href',
      '/settings/plans',
    )

    // Nothing to wait for: the page does not ask again.
    await pass(ORDER_WAIT_MS * 2)
    expect(requests()).toBe(1)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('the return page while the payment has no outcome', () => {
  it('looks every three seconds, for thirty seconds', () => {
    expect(ORDER_POLL_MS).toBe(3_000)
    expect(ORDER_WAIT_MS).toBe(30_000)
  })

  it('asks at once and says that it is checking', async () => {
    let answer!: (order: OrderState) => void
    syncOrder.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    await showReturn()

    expect(syncOrder).toHaveBeenCalledTimes(1)
    expect(syncOrder).toHaveBeenCalledWith({ orderId: ORDER_ID })
    expect(heading()).toBe('Проверяем оплату')
    expect(screen.getByRole('status')).toHaveTextContent('Проверяем оплату')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()

    await act(async () => answer(paid))
    await pass(0)

    expect(heading()).toBe('Оплата прошла')
  })

  it('asks again every three seconds while the order is pending', async () => {
    await showReturn()
    expect(requests()).toBe(1)
    expect(heading()).toBe('Проверяем оплату')

    await pass(ORDER_POLL_MS - 1)
    expect(requests()).toBe(1)
    await pass(1)
    expect(requests()).toBe(2)
    await pass(ORDER_POLL_MS)
    expect(requests()).toBe(3)

    syncOrder.mockResolvedValue(paid)
    await pass(ORDER_POLL_MS)

    expect(requests()).toBe(4)
    expect(heading()).toBe('Оплата прошла')
    // The outcome is final: nothing more is asked.
    await pass(ORDER_WAIT_MS * 2)
    expect(requests()).toBe(4)
  })

  it('stops asking after thirty seconds and leaves the check to the customer', async () => {
    await showReturn()

    await pass(ORDER_WAIT_MS - 1)
    expect(heading()).toBe('Проверяем оплату')
    // One request at the start and one every three seconds since.
    expect(requests()).toBe(10)

    await pass(1)

    expect(heading()).toBe('Оплата ещё не подтверждена')
    expect(pageText()).toContain(
      'Платёж ещё обрабатывается. Можно закрыть страницу: тариф включится, когда оплата пройдёт.',
    )
    expect(screen.getByRole('button', { name: 'Проверить ещё раз' })).toBeEnabled()
    expect(screen.getByRole('link', { name: 'К тарифам' })).toHaveAttribute(
      'href',
      '/settings/plans',
    )

    const asked = requests()
    await pass(ORDER_WAIT_MS * 4)
    expect(requests()).toBe(asked)
  })

  it('tells a customer who waits for a pack what the payment will bring', async () => {
    syncOrder.mockResolvedValue(orderIn('pending', packOrder))
    await showReturn()

    await pass(ORDER_WAIT_MS)

    expect(heading()).toBe('Оплата ещё не подтверждена')
    expect(pageText()).toContain(
      'Платёж ещё обрабатывается. Можно закрыть страницу: кредиты добавятся, когда оплата пройдёт.',
    )
    expect(pageText()).not.toContain('тариф включится')
  })

  it('checks once more when the customer asks, and shows the outcome', async () => {
    await showReturn()
    await pass(ORDER_WAIT_MS)
    const asked = requests()

    // Still pending: the page stays as it is and does not start asking by itself again.
    fireEvent.click(screen.getByRole('button', { name: 'Проверить ещё раз' }))
    await pass(0)
    expect(requests()).toBe(asked + 1)
    expect(heading()).toBe('Оплата ещё не подтверждена')
    await pass(ORDER_WAIT_MS)
    expect(requests()).toBe(asked + 1)

    syncOrder.mockResolvedValue(paid)
    fireEvent.click(screen.getByRole('button', { name: 'Проверить ещё раз' }))
    await pass(0)

    expect(requests()).toBe(asked + 2)
    expect(heading()).toBe('Оплата прошла')
    expect(screen.queryByRole('button', { name: 'Проверить ещё раз' })).not.toBeInTheDocument()
  })

  it('does not send a second check while one is on its way', async () => {
    await showReturn()
    await pass(ORDER_WAIT_MS)
    const asked = requests()
    syncOrder.mockImplementationOnce(() => new Promise(() => undefined))

    fireEvent.click(screen.getByRole('button', { name: 'Проверить ещё раз' }))
    await pass(0)

    expect(screen.getByRole('button', { name: 'Проверить ещё раз' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Проверить ещё раз' }))
    await pass(0)
    expect(requests()).toBe(asked + 1)
  })

  it('checks again when the customer comes back to the tab', async () => {
    await showReturn()
    await pass(ORDER_WAIT_MS)
    const asked = requests()
    expect(heading()).toBe('Оплата ещё не подтверждена')
    syncOrder.mockResolvedValue(paid)

    comeBackToTheTab()
    await pass(0)

    expect(requests()).toBe(asked + 1)
    expect(heading()).toBe('Оплата прошла')
  })

  it('asks nothing after the customer has left the page', async () => {
    const view = await showReturn()
    await pass(ORDER_POLL_MS)
    expect(requests()).toBe(2)

    view.unmount()
    await pass(ORDER_WAIT_MS * 2)

    expect(requests()).toBe(2)
  })
})

describe('the return page of a paid order', () => {
  it('says what was bought, for how much and until when the tariff lasts', async () => {
    syncOrder.mockResolvedValue(paid)
    await showReturn()

    expect(heading()).toBe('Оплата прошла')
    expect(screen.getByRole('status')).toHaveTextContent('Оплата прошла')
    expect(pageText()).toContain('Тариф «Бизнес» — 12 900 ₽.')
    expect(pageText()).toContain('Тариф действует до 18 октября 2026.')
    expect(screen.getByRole('link', { name: 'К тарифам' })).toHaveAttribute(
      'href',
      '/settings/plans',
    )

    await pass(ORDER_WAIT_MS * 2)
    expect(requests()).toBe(1)
    expect(heading()).toBe('Оплата прошла')
  })

  it('names no period when the order has no tariff of its own to show', async () => {
    syncOrder.mockResolvedValue(orderIn('paid'))
    await showReturn()

    expect(heading()).toBe('Оплата прошла')
    expect(pageText()).toContain('Тариф «Бизнес» — 12 900 ₽.')
    expect(pageText()).not.toContain('действует до')
  })

  it('names a paid pack by its own name and says that its credits are already added', async () => {
    syncOrder.mockResolvedValue(
      orderIn('paid', {
        ...packOrder,
        // The live tariff of the workspace comes with every paid order.
        subscription: subscriptionTo(),
      }),
    )
    await showReturn()

    expect(heading()).toBe('Оплата прошла')
    expect(pageText()).toContain('Пакет из 100 кредитов — 1 990 ₽.')
    expect(pageText()).toContain(
      'Добавили 100 кредитов. Кредиты из пакета не сгорают в конце периода.',
    )
    expect(pageText()).not.toContain('Тариф «')
    // The pack did not move the end of the tariff: the page does not name it as bought.
    expect(pageText()).not.toContain('действует до')
    expect(screen.getByRole('link', { name: 'К тарифам' })).toHaveAttribute(
      'href',
      '/settings/plans',
    )

    await pass(ORDER_WAIT_MS * 2)
    expect(requests()).toBe(1)
  })

  it('says the same of a pack bought after the tariff ended, and of one whose size is unknown', async () => {
    syncOrder.mockResolvedValue(orderIn('paid', { ...packOrder, packCredits: 21 }))
    const first = await showReturn()
    expect(pageText()).toContain(
      'Добавили 21 кредит. Кредиты из пакета не сгорают в конце периода.',
    )
    first.unmount()

    syncOrder.mockResolvedValue(orderIn('paid', { ...packOrder, packCredits: null }))
    await showReturn()
    expect(pageText()).toContain('Кредиты из пакета уже добавлены и не сгорают в конце периода.')
    expect(pageText()).not.toContain('Добавили')
  })

  it('promises no added credits for a paid tariff', async () => {
    syncOrder.mockResolvedValue(paid)
    await showReturn()

    expect(pageText()).not.toMatch(/Добавили|из пакета/)
  })

  it('does not call a payment that was not applied a success', async () => {
    syncOrder.mockResolvedValue(
      orderIn('paid', { refundNeeded: true, subscription: subscriptionTo() }),
    )
    await showReturn()

    expect(heading()).toBe('Платёж не зачислен')
    expect(pageText()).toContain(
      'Деньги поступили, но зачислить их не получилось: тариф к этому времени уже был оплачен или закончился. Мы вернём этот платёж.',
    )
    expect(pageText()).not.toContain('Оплата прошла')
    expect(screen.queryByRole('link', { name: 'Попробовать ещё раз' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'К тарифам' })).toBeInTheDocument()
  })

  it('tells the truth about a payment by hand that came after the overdue tariff had ended', async () => {
    // The order stays paid with a refund entry and no tariff is live: neither «the tariff is
    // on» nor «the order was closed» would be true.
    syncOrder.mockResolvedValue(orderIn('paid', { refundNeeded: true, subscription: null }))
    await showReturn()

    expect(heading()).toBe('Платёж не зачислен')
    expect(pageText()).toContain(
      'Деньги поступили, но зачислить их не получилось: тариф к этому времени уже был оплачен или закончился. Мы вернём этот платёж.',
    )
    expect(pageText()).not.toMatch(/тариф уже оформлен|заказ был закрыт|Тариф действует/)
    expect(pageText()).not.toContain('Оплата прошла')
    expect(screen.getByRole('link', { name: 'К тарифам' })).toHaveAttribute(
      'href',
      '/settings/plans',
    )
  })

  it('says that the money of a refunded order went back', async () => {
    syncOrder.mockResolvedValue(orderIn('refunded'))
    await showReturn()

    expect(heading()).toBe('Платёж возвращён')
    expect(pageText()).toContain('Деньги за этот заказ возвращены.')
  })
})

describe('the return page of an order that was not paid', () => {
  it('gives the reason of the bank and the way back to the tariffs', async () => {
    syncOrder.mockResolvedValue(
      orderIn('failed', { failureText: 'Время на оплату истекло. Оформите оплату заново.' }),
    )
    await showReturn()

    expect(heading()).toBe('Оплата не прошла')
    expect(pageText()).toContain('Время на оплату истекло. Оформите оплату заново.')
    expect(screen.getByRole('link', { name: 'Попробовать ещё раз' })).toHaveAttribute(
      'href',
      '/settings/plans',
    )
    expect(pageText()).not.toContain('Тариф действует')

    await pass(ORDER_WAIT_MS * 2)
    expect(requests()).toBe(1)
  })

  it('stops waiting as soon as a pending payment is declined', async () => {
    await showReturn()
    syncOrder.mockResolvedValue(
      orderIn('failed', {
        failureText: 'Недостаточно средств. Пополните счёт или выберите другой способ оплаты.',
      }),
    )
    await pass(ORDER_POLL_MS)

    expect(heading()).toBe('Оплата не прошла')
    expect(pageText()).toContain('Недостаточно средств.')
    await pass(ORDER_WAIT_MS * 2)
    expect(requests()).toBe(2)
    // The thirty seconds are over, and the page still shows the outcome, not the waiting.
    expect(heading()).toBe('Оплата не прошла')
  })

  it('treats an order we closed ourselves as unpaid', async () => {
    syncOrder.mockResolvedValue(orderIn('cancelled'))
    await showReturn()

    expect(heading()).toBe('Оплата не прошла')
    expect(pageText()).toContain(
      'Этот заказ закрыт, оплата по нему не прошла. Оформите оплату заново.',
    )
    expect(screen.getByRole('link', { name: 'Попробовать ещё раз' })).toBeInTheDocument()
  })

  it('does not offer to pay again for money that came and was not applied', async () => {
    syncOrder.mockResolvedValue(
      orderIn('failed', {
        refundNeeded: true,
        failureText: 'Платёж не удалось зачислить. Напишите нам — мы разберёмся.',
      }),
    )
    await showReturn()

    expect(heading()).toBe('Платёж не зачислен')
    expect(pageText()).toContain('Платёж не удалось зачислить. Напишите нам — мы разберёмся.')
    expect(screen.queryByRole('link', { name: 'Попробовать ещё раз' })).not.toBeInTheDocument()

    syncOrder.mockResolvedValue(orderIn('cancelled', { refundNeeded: true }))
    await showReturn()
    expect(screen.getAllByRole('heading', { level: 2, name: 'Платёж не зачислен' })).toHaveLength(2)
    // A tariff order we closed before its money came: closed is all that is known of it.
    expect(pageText()).toContain(
      'Деньги поступили, но зачислить их не получилось: заказ был закрыт. Мы вернём этот платёж.',
    )
  })

  it('does not blame a tariff for the money of a pack that came after its order was closed', async () => {
    syncOrder.mockResolvedValue(orderIn('cancelled', { ...packOrder, refundNeeded: true }))
    await showReturn()

    expect(heading()).toBe('Платёж не зачислен')
    expect(pageText()).toContain(
      'Деньги поступили, но зачислить их не получилось: заказ был закрыт. Мы вернём этот платёж.',
    )
    expect(pageText()).not.toMatch(/тариф (уже оформлен|к этому времени)/)
    expect(pageText()).not.toMatch(/Добавили|уже добавлены/)
  })
})

describe('the return page of an order that has its outcome', () => {
  const failed = orderIn('failed', { failureText: 'Время на оплату истекло.' })

  it.each([
    ['paid', paid],
    ['failed', failed],
    ['refunded', orderIn('refunded')],
  ])('does not ask about a %s order when the customer comes back to the tab', async (_, order) => {
    syncOrder.mockResolvedValue(order)
    await showReturn()

    comeBackToTheTab()
    await pass(ORDER_POLL_MS)

    expect(requests()).toBe(1)
  })

  // What «Тарифы» keeps from before the payment, as its page left it in the cache.
  const overviewKey = trpc.billing.overview.queryKey()
  const plansKey = trpc.billing.plans.queryKey()
  function cacheOfPlans() {
    const queryClient = new QueryClient()
    queryClient.setQueryData(overviewKey, overviewOf())
    queryClient.setQueryData(plansKey, offers())
    return queryClient
  }
  const outdated = (queryClient: QueryClient) =>
    [overviewKey, plansKey].map((key) => queryClient.getQueryState(key)?.isInvalidated)

  it.each([
    ['paid', paid],
    ['failed', failed],
    ['refunded', orderIn('refunded')],
  ])('tells «Тарифы» to read its data anew once the order is %s', async (_, order) => {
    const queryClient = cacheOfPlans()
    await showReturn(ORDER_ID, queryClient)
    // Nothing has changed while the payment has no outcome.
    await pass(ORDER_POLL_MS)
    expect(outdated(queryClient)).toEqual([false, false])

    syncOrder.mockResolvedValue(order)
    await pass(ORDER_POLL_MS)

    expect(outdated(queryClient)).toEqual([true, true])
  })

  it('leaves the data of «Тарифы» alone for an order that never gets an outcome here', async () => {
    const queryClient = cacheOfPlans()
    await showReturn(ORDER_ID, queryClient)
    await pass(ORDER_WAIT_MS * 2)

    expect(heading()).toBe('Оплата ещё не подтверждена')
    expect(outdated(queryClient)).toEqual([false, false])
  })
})

describe('the return page when the check itself fails', () => {
  it('shows the server`s words and checks again on request', async () => {
    syncOrder.mockRejectedValueOnce(
      serverRefusal(
        'Оплата сейчас недоступна. Попробуйте ещё раз немного позже',
        'BILLING_PAYMENTS_NOT_CONFIGURED',
      ),
    )
    await showReturn()

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Оплата сейчас недоступна. Попробуйте ещё раз немного позже.',
    )
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()
    // A failed check is not repeated by itself.
    await pass(ORDER_POLL_MS * 3)
    expect(requests()).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Проверить ещё раз' }))
    await pass(0)

    expect(requests()).toBe(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(heading()).toBe('Проверяем оплату')
    // Within the thirty seconds the page goes on asking by itself.
    await pass(ORDER_POLL_MS)
    expect(requests()).toBe(3)
  })

  it('never shows the browser`s own words for a request that did not reach the server', async () => {
    syncOrder.mockRejectedValue(new TypeError('Failed to fetch'))
    await showReturn()
    await pass(ORDER_WAIT_MS)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(
      'Не удалось проверить оплату. Проверьте соединение и попробуйте ещё раз.',
    )
    expect(alert).not.toHaveTextContent('Failed to fetch')
  })

  it('asks again after a check that the server could not answer', async () => {
    await showReturn()
    // No code of a refusal: the order is as likely pending as it was.
    syncOrder.mockRejectedValueOnce(serverRefusal('Сервис временно недоступен'))
    await pass(ORDER_POLL_MS)
    expect(requests()).toBe(2)
    // The page is still checking, and says that, not that the check failed.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(heading()).toBe('Проверяем оплату')

    syncOrder.mockResolvedValue(paid)
    await pass(ORDER_POLL_MS - 1)
    expect(requests()).toBe(2)
    await pass(1)

    expect(requests()).toBe(3)
    expect(heading()).toBe('Оплата прошла')
  })

  it('asks again when the very first check did not reach the server', async () => {
    syncOrder.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await showReturn()
    expect(requests()).toBe(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(heading()).toBe('Проверяем оплату')

    syncOrder.mockResolvedValue(paid)
    await pass(ORDER_POLL_MS - 1)
    expect(requests()).toBe(1)
    await pass(1)

    expect(requests()).toBe(2)
    expect(heading()).toBe('Оплата прошла')
  })

  it('reports a check that keeps failing when the thirty seconds are over, and asks no more', async () => {
    await showReturn()
    syncOrder.mockRejectedValue(serverRefusal('Сервис временно недоступен'))

    await pass(ORDER_WAIT_MS - 1)
    // As often as for an order that stays pending: once at the start, then every three seconds.
    expect(requests()).toBe(10)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(heading()).toBe('Проверяем оплату')

    await pass(1)

    expect(screen.getByRole('alert')).toHaveTextContent('Сервис временно недоступен.')
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()
    const asked = requests()
    await pass(ORDER_WAIT_MS * 4)
    expect(requests()).toBe(asked)

    syncOrder.mockResolvedValue(paid)
    fireEvent.click(screen.getByRole('button', { name: 'Проверить ещё раз' }))
    await pass(0)

    expect(requests()).toBe(asked + 1)
    expect(heading()).toBe('Оплата прошла')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reports a first check that keeps failing in the same way', async () => {
    syncOrder.mockRejectedValue(new TypeError('Failed to fetch'))
    await showReturn()

    await pass(ORDER_WAIT_MS - 1)
    expect(requests()).toBe(10)
    expect(heading()).toBe('Проверяем оплату')
    await pass(1)

    expect(screen.getByRole('alert')).toHaveTextContent('Не удалось проверить оплату.')
    const asked = requests()
    await pass(ORDER_WAIT_MS * 4)
    expect(requests()).toBe(asked)
  })

  it('checks a failed check again when the customer comes back to the tab', async () => {
    syncOrder.mockRejectedValue(new TypeError('Failed to fetch'))
    await showReturn()
    await pass(ORDER_WAIT_MS)
    const asked = requests()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    syncOrder.mockResolvedValue(paid)

    comeBackToTheTab()
    await pass(0)

    expect(requests()).toBe(asked + 1)
    expect(heading()).toBe('Оплата прошла')
  })

  it('does not ask about a refusal again when the customer comes back to the tab', async () => {
    syncOrder.mockRejectedValue(
      serverRefusal(
        'Оплата сейчас недоступна. Попробуйте ещё раз немного позже',
        'BILLING_PAYMENTS_NOT_CONFIGURED',
      ),
    )
    await showReturn()

    comeBackToTheTab()
    await pass(ORDER_POLL_MS)

    expect(requests()).toBe(1)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
