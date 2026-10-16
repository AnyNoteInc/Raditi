// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PackOffer } from './billing-types'
import { canBuyPack, PackDialog } from './pack-dialog'
import { LEAVING_WAIT_MS } from './payment-dialog'
import { offers, overviewOf, plain, serverRefusal, subscriptionTo } from './testing'

type Checkout = { orderId: string; confirmationUrl: string }

const { startPackCheckout, hardNavigate, invalidated } = vi.hoisted(() => ({
  startPackCheckout: vi.fn<(input: Record<string, never>) => Promise<Checkout>>(),
  hardNavigate: vi.fn<(path: string) => void>(),
  invalidated: [] as unknown[],
}))

vi.mock('@/lib/hard-navigate', () => ({ hardNavigate }))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    billing: {
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
}))

const paymentPage = 'https://yookassa.example/pay/7a1e'
const checkout: Checkout = {
  orderId: '018f0000-0000-7000-8000-0000000000bb',
  confirmationUrl: paymentPage,
}
const { pack } = offers()

const onClose = vi.fn<() => void>()

function showDialog(sold: PackOffer = pack) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const invalidate = queryClient.invalidateQueries.bind(queryClient)
  vi.spyOn(queryClient, 'invalidateQueries').mockImplementation((filters, options) => {
    invalidated.push(filters?.queryKey)
    return invalidate(filters, options)
  })
  render(
    <QueryClientProvider client={queryClient}>
      <PackDialog pack={sold} open onClose={onClose} />
    </QueryClientProvider>,
  )
}

const dialogText = () => plain(screen.getByRole('dialog').textContent)
const pay = () => screen.getByRole('button', { name: 'Перейти к оплате' })
const cancel = () => screen.getByRole('button', { name: 'Отмена' })

/** A request that stays unanswered until the test answers it. */
function pendingCheckout() {
  let answer!: (result: Checkout) => void
  startPackCheckout.mockImplementationOnce(
    () =>
      new Promise<Checkout>((resolve) => {
        answer = resolve
      }),
  )
  return { answer: (result = checkout) => answer(result) }
}

beforeEach(() => {
  vi.clearAllMocks()
  invalidated.length = 0
  startPackCheckout.mockResolvedValue(checkout)
})

describe('who may buy a pack', () => {
  // Auto-renewal decides nothing here: a pack is sold on top of any tariff that takes tasks.
  it.each([
    ['an active tariff that renews', true, 'active', true, true],
    ['an active tariff that ends with its period', true, 'active', false, true],
    ['an overdue tariff that would renew', true, 'past_due', true, false],
    ['an overdue tariff that does not renew', true, 'past_due', false, false],
    ['a trial, which takes no tasks', true, 'trial', false, false],
    ['payments switched off, a tariff that renews', false, 'active', true, false],
    ['payments switched off, a tariff that ends', false, 'active', false, false],
  ] as const)('%s', (_case, paymentsEnabled, status, autoRenewal, allowed) => {
    const subscription = subscriptionTo({ status, autoRenewal })
    expect(subscription).toMatchObject({ status, autoRenewal })
    expect(canBuyPack(overviewOf({ paymentsEnabled, subscription }))).toBe(allowed)
  })

  it('nobody without a tariff', () => {
    expect(canBuyPack(overviewOf())).toBe(false)
    expect(canBuyPack(overviewOf({ paymentsEnabled: false }))).toBe(false)
  })
})

describe('the pack dialog', () => {
  it('names the pack, what it gives and the amount', () => {
    showDialog()

    expect(
      screen.getByRole('dialog', { name: 'Пакет из 100 кредитов' }),
    ).toHaveAccessibleDescription(
      plainPattern(
        'Добавим 100 кредитов сразу после оплаты. Кредиты из пакета не сгорают в конце периода.',
      ),
    )
    expect(plain(screen.getByText('К оплате сегодня').nextElementSibling?.textContent)).toBe(
      '1 990 ₽',
    )
    // A pack has no period of its own and renews nothing: neither is asked about.
    expect(screen.queryByText('Период')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(dialogText()).not.toMatch(/автоматически|Сохраним способ оплаты/)
  })

  it('prints the pack as it is sold, whatever its name, size and price', () => {
    showDialog({ ...pack, name: 'Большой пакет', credits: 22, price: '3490.50' })

    expect(screen.getByRole('dialog', { name: 'Большой пакет' })).toHaveAccessibleDescription(
      plainPattern(
        'Добавим 22 кредита сразу после оплаты. Кредиты из пакета не сгорают в конце периода.',
      ),
    )
    expect(plain(screen.getByText('К оплате сегодня').nextElementSibling?.textContent)).toBe(
      '3 490,50 ₽',
    )
  })

  it('says who can pay and what paying means before the customer pays', () => {
    showDialog()

    expect(dialogText()).toContain(
      'Оплата проходит на странице ЮKassa: картой, через СБП или SberPay. Оплата принимается только с личной карты; счета и закрывающие документы для организаций не выдаём. Оплачивая, вы принимаете условия публичной оферты.',
    )
    expect(screen.getByRole('link', { name: 'публичной оферты' })).toHaveAttribute(
      'href',
      '/terms/public-offer',
    )
    expect(dialogText()).not.toMatch(/НДС|чек/i)
  })

  it('starts the checkout with nothing of its own and leaves for the payment page', async () => {
    showDialog()

    fireEvent.click(pay())

    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith(paymentPage))
    // Neither the pack nor its price is the browser's to name.
    expect(startPackCheckout).toHaveBeenCalledExactlyOnceWith({}, expect.anything())
    expect(invalidated).toEqual([])
  })

  it('sends one request for a double click', async () => {
    const request = pendingCheckout()
    showDialog()

    // Both clicks land before the dialog is drawn again with its button disabled.
    act(() => {
      pay().click()
      pay().click()
    })
    fireEvent.click(pay())

    await waitFor(() => expect(pay()).toBeDisabled())
    expect(startPackCheckout).toHaveBeenCalledTimes(1)
    await act(async () => request.answer())
    expect(startPackCheckout).toHaveBeenCalledTimes(1)
  })

  it('locks the dialog while the request runs and while the browser is leaving', async () => {
    const request = pendingCheckout()
    showDialog()

    fireEvent.click(pay())

    await waitFor(() => expect(pay()).toBeDisabled())
    expect(cancel()).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => request.answer())

    expect(hardNavigate).toHaveBeenCalledWith(paymentPage)
    // A second click now would make a second order and a second payment page.
    expect(pay()).toBeDisabled()
    expect(cancel()).toBeDisabled()
  })

  it('closes on Escape and on «Отмена» while nothing is being sent', () => {
    showDialog()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(cancel())
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(startPackCheckout).not.toHaveBeenCalled()
  })

  it('shows the refusal of the server in its own words, refreshes the page and lets the customer try again', async () => {
    startPackCheckout.mockRejectedValueOnce(
      serverRefusal(
        'Пакет кредитов можно купить только при действующем тарифе. Сначала оформите или оплатите тариф',
        'BILLING_PACK_NEEDS_SUBSCRIPTION',
      ),
    )
    showDialog()

    fireEvent.click(pay())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /^Пакет кредитов можно купить только при действующем тарифе\. Сначала оформите или оплатите тариф\.$/,
    )
    expect(hardNavigate).not.toHaveBeenCalled()
    // The refusal is about what the page behind the dialog shows.
    expect(invalidated).toEqual([
      ['billing', 'overview'],
      ['billing', 'plans'],
    ])
    expect(pay()).toBeEnabled()
    expect(cancel()).toBeEnabled()

    fireEvent.click(pay())

    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith(paymentPage))
    expect(startPackCheckout).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says in its own words that the pack is no longer sold', async () => {
    // The server has one text for «not on sale», and it is about a tariff.
    startPackCheckout.mockRejectedValueOnce(
      serverRefusal(
        'Этот тариф сейчас не продаётся. Обновите страницу и выберите другой',
        'BILLING_PLAN_NOT_FOUND',
      ),
    )
    showDialog()

    fireEvent.click(pay())

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/^Пакет сейчас не продаётся\. Обновите страницу\.$/)
    expect(alert).not.toHaveTextContent('тариф')
  })

  it('says that trying again helps when another request of the customer changed the order', async () => {
    startPackCheckout.mockRejectedValueOnce(serverRefusal('Действие сейчас недоступно', 'CONFLICT'))
    showDialog()

    fireEvent.click(pay())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось начать оплату: заказ только что изменился. Попробуйте ещё раз.',
    )
  })

  it('never shows the browser`s own words for a request that did not reach the server', async () => {
    startPackCheckout.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    showDialog()

    fireEvent.click(pay())

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'Не удалось начать оплату. Проверьте соединение и попробуйте ещё раз.',
    )
    expect(alert).not.toHaveTextContent('Failed to fetch')
    expect(pay()).toBeEnabled()
  })

  it('is ready for another try when the browser brings the page back from its cache', async () => {
    showDialog()
    fireEvent.click(pay())
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledTimes(1))
    expect(pay()).toBeDisabled()

    fireEvent(window, new PageTransitionEvent('pageshow', { persisted: true }))

    await waitFor(() => expect(pay()).toBeEnabled())
    fireEvent.click(pay())
    await waitFor(() => expect(startPackCheckout).toHaveBeenCalledTimes(2))
  })

  describe('when the browser does not leave for the payment page', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    /** Lets the time pass, with everything that is due in it: timers, answers and redraws. */
    async function pass(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
    }

    it('unlocks the dialog after a while, for closing or for another try', async () => {
      showDialog()
      fireEvent.click(pay())
      await pass(10)
      expect(hardNavigate).toHaveBeenCalledTimes(1)

      await pass(LEAVING_WAIT_MS - 1_000)
      expect(pay()).toBeDisabled()
      expect(cancel()).toBeDisabled()

      await pass(1_000)

      expect(pay()).toBeEnabled()
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })
})

/** A sentence with plain spaces as a pattern that also accepts non-breaking ones. */
function plainPattern(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replaceAll(' ', '\\s')}$`)
}
