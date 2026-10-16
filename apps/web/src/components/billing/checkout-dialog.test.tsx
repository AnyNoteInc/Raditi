// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CheckoutDialog } from './checkout-dialog'
import { LEAVING_WAIT_MS } from './payment-dialog'
import { business, plain, serverRefusal, start } from './testing'

type CheckoutRequest = { planSlug: string; autoRenew: boolean }
type Checkout = { orderId: string; confirmationUrl: string }

const { startCheckout, hardNavigate } = vi.hoisted(() => ({
  startCheckout: vi.fn<(input: CheckoutRequest) => Promise<Checkout>>(),
  hardNavigate: vi.fn<(path: string) => void>(),
}))

vi.mock('@/lib/hard-navigate', () => ({ hardNavigate }))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    billing: {
      overview: { queryKey: () => ['billing', 'overview'] },
      plans: { queryKey: () => ['billing', 'plans'] },
      startCheckout: {
        mutationOptions: (options: UseMutationOptions<Checkout, Error, CheckoutRequest>) => ({
          ...options,
          mutationFn: startCheckout,
        }),
      },
    },
  }),
}))

const paymentPage = 'https://yookassa.example/pay/2f0c'
const checkout: Checkout = {
  orderId: '018f0000-0000-7000-8000-0000000000aa',
  confirmationUrl: paymentPage,
}

const onClose = vi.fn<() => void>()

/** `autoRenewalAvailable` is false at a shop that takes one-time payments only. */
function showDialog(plan = business, { autoRenewalAvailable = true } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <CheckoutDialog
        plan={plan}
        autoRenewalAvailable={autoRenewalAvailable}
        open
        onClose={onClose}
      />
    </QueryClientProvider>,
  )
}

const dialogText = () => plain(screen.getByRole('dialog').textContent)
const consent = () => screen.getByRole('checkbox', { name: 'Продлевать автоматически' })
const pay = () => screen.getByRole('button', { name: 'Перейти к оплате' })
const cancel = () => screen.getByRole('button', { name: 'Отмена' })

/** A request that stays unanswered until the test answers it. */
function pendingCheckout() {
  let answer!: (result: Checkout) => void
  let refuse!: (error: Error) => void
  startCheckout.mockImplementationOnce(
    () =>
      new Promise<Checkout>((resolve, reject) => {
        answer = resolve
        refuse = reject
      }),
  )
  return { answer: (result = checkout) => answer(result), refuse: (error: Error) => refuse(error) }
}

beforeEach(() => {
  vi.clearAllMocks()
  startCheckout.mockResolvedValue(checkout)
})

describe('the checkout dialog', () => {
  it('names the tariff, its limits, the period and the amount', () => {
    showDialog()

    expect(screen.getByRole('dialog', { name: 'Тариф «Бизнес»' })).toHaveAccessibleDescription(
      plainPattern('800 кредитов в месяц, до 10 задач в день · до 3 сайтов на WordPress'),
    )
    expect(dialogText()).toContain(
      '800 кредитов в месяц, до 10 задач в день · до 3 сайтов на WordPress',
    )
    expect(plain(screen.getByText('Период').nextElementSibling?.textContent)).toBe(
      'С сегодняшнего дня на месяц',
    )
    expect(plain(screen.getByText('К оплате сегодня').nextElementSibling?.textContent)).toBe(
      '12 900 ₽',
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

  it('asks for the consent to auto-renewal with the amount of this tariff, unticked', () => {
    showDialog(start)

    expect(consent()).not.toBeChecked()
    expect(consent()).toHaveAccessibleDescription(
      plainPattern(
        'Сохраним способ оплаты, которым вы заплатите сейчас, и каждый месяц будем списывать 4 900 ₽ тем же способом. Перед списанием пришлём письмо. Отключить можно в настройках в любой день.',
      ),
    )
  })

  it('sends the checkout without the consent unless the customer ticks it', async () => {
    showDialog()

    fireEvent.click(pay())

    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith(paymentPage))
    expect(startCheckout).toHaveBeenCalledTimes(1)
    expect(startCheckout).toHaveBeenCalledWith(
      { planSlug: 'business', autoRenew: false },
      expect.anything(),
    )
  })

  it('sends the consent as it is ticked at the moment of paying', async () => {
    showDialog()

    fireEvent.click(consent())
    expect(consent()).toBeChecked()
    fireEvent.click(pay())

    await waitFor(() =>
      expect(startCheckout).toHaveBeenCalledWith(
        { planSlug: 'business', autoRenew: true },
        expect.anything(),
      ),
    )
  })

  it('sends no consent that was ticked and then taken back', async () => {
    showDialog()

    fireEvent.click(consent())
    fireEvent.click(consent())
    expect(consent()).not.toBeChecked()
    fireEvent.click(pay())

    await waitFor(() =>
      expect(startCheckout).toHaveBeenCalledWith(
        { planSlug: 'business', autoRenew: false },
        expect.anything(),
      ),
    )
  })

  it('takes the text beside the checkbox as a part of it', () => {
    showDialog()

    fireEvent.click(screen.getByText('Продлевать автоматически'))

    expect(consent()).toBeChecked()
  })

  describe('at a shop that takes one-time payments only', () => {
    const oneTimeOnly = { autoRenewalAvailable: false }

    it('shows no consent to auto-renewal and says in its place why', () => {
      showDialog(start, oneTimeOnly)

      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
      expect(dialogText()).not.toContain('Продлевать автоматически')
      expect(dialogText()).toContain(
        'Автопродление пока недоступно: тариф будет действовать месяц, потом его можно оформить снова.',
      )
      // Nothing is saved and nothing is charged later: the dialog promises neither.
      expect(dialogText()).not.toMatch(/Сохраним способ оплаты|будем списывать|Перед списанием/)
      // The rest of the dialog is the same: what is bought, for how much, on which terms.
      expect(plain(screen.getByText('К оплате сегодня').nextElementSibling?.textContent)).toBe(
        '4 900 ₽',
      )
      expect(dialogText()).toContain('Оплачивая, вы принимаете условия публичной оферты.')
    })

    it('starts the checkout without the consent', async () => {
      showDialog(business, oneTimeOnly)

      fireEvent.click(pay())

      await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith(paymentPage))
      expect(startCheckout).toHaveBeenCalledExactlyOnceWith(
        { planSlug: 'business', autoRenew: false },
        expect.anything(),
      )
    })
  })

  it('shows what the server says when the shop stopped saving payment methods meanwhile', async () => {
    // The page was read while auto-renewal was on offer: the dialog still has its tick.
    startCheckout.mockRejectedValueOnce(
      serverRefusal(
        'Автопродление пока недоступно. Оформите тариф без него: он будет действовать месяц',
        'BILLING_AUTO_RENEWAL_UNAVAILABLE',
      ),
    )
    showDialog()
    fireEvent.click(consent())
    fireEvent.click(pay())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Автопродление пока недоступно. Оформите тариф без него: он будет действовать месяц.',
    )
    // The way out is in the dialog: the tick is taken back and the same button pays.
    fireEvent.click(consent())
    fireEvent.click(pay())
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith(paymentPage))
    expect(startCheckout).toHaveBeenLastCalledWith(
      { planSlug: 'business', autoRenew: false },
      expect.anything(),
    )
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
    expect(startCheckout).toHaveBeenCalledTimes(1)
    await act(async () => request.answer())
    expect(startCheckout).toHaveBeenCalledTimes(1)
  })

  it('locks the dialog while the request runs', async () => {
    const request = pendingCheckout()
    showDialog()

    fireEvent.click(pay())

    await waitFor(() => expect(pay()).toBeDisabled())
    expect(cancel()).toBeDisabled()
    expect(consent()).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(hardNavigate).not.toHaveBeenCalled()

    await act(async () => request.answer())

    expect(hardNavigate).toHaveBeenCalledWith(paymentPage)
    // The browser is leaving for the payment page: a second payment cannot be started.
    expect(pay()).toBeDisabled()
    expect(cancel()).toBeDisabled()
  })

  it('closes on Escape and on «Отмена» while nothing is being sent', () => {
    showDialog()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(cancel())
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(startCheckout).not.toHaveBeenCalled()
  })

  it('shows the refusal of the server in its own words and lets the customer try again', async () => {
    startCheckout.mockRejectedValueOnce(
      serverRefusal(
        'Оплата сейчас недоступна. Попробуйте ещё раз немного позже',
        'BILLING_PAYMENTS_NOT_CONFIGURED',
      ),
    )
    showDialog()

    fireEvent.click(consent())
    fireEvent.click(pay())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /^Оплата сейчас недоступна\. Попробуйте ещё раз немного позже\.$/,
    )
    expect(hardNavigate).not.toHaveBeenCalled()
    expect(pay()).toBeEnabled()
    expect(cancel()).toBeEnabled()
    // The choice survives the failure.
    expect(consent()).toBeChecked()

    fireEvent.click(pay())

    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith(paymentPage))
    expect(startCheckout).toHaveBeenCalledTimes(2)
    expect(startCheckout).toHaveBeenLastCalledWith(
      { planSlug: 'business', autoRenew: true },
      expect.anything(),
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not repeat the full stop of a message that has one', async () => {
    startCheckout.mockRejectedValueOnce(
      serverRefusal('Что-то пошло не так. Попробуйте ещё раз немного позже.'),
    )
    showDialog()

    fireEvent.click(pay())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /^Что-то пошло не так\. Попробуйте ещё раз немного позже\.$/,
    )
  })

  it('tells in the server`s words to wait while the previous payment is being processed', async () => {
    startCheckout.mockRejectedValueOnce(
      serverRefusal(
        'Предыдущий платёж ещё обрабатывается. Подождите пару минут и обновите страницу',
        'BILLING_PAYMENT_IN_PROGRESS',
      ),
    )
    showDialog()

    fireEvent.click(pay())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /^Предыдущий платёж ещё обрабатывается\. Подождите пару минут и обновите страницу\.$/,
    )
    expect(pay()).toBeEnabled()
  })

  it('says that trying again helps when another request of the customer changed the order', async () => {
    // The plain conflict of the server reads «Действие сейчас недоступно».
    startCheckout.mockRejectedValueOnce(serverRefusal('Действие сейчас недоступно', 'CONFLICT'))
    showDialog()

    fireEvent.click(pay())

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'Не удалось начать оплату: заказ только что изменился. Попробуйте ещё раз.',
    )
    expect(alert).not.toHaveTextContent('Действие сейчас недоступно')
    expect(alert).not.toHaveTextContent('Предыдущий платёж')
  })

  it('never shows the browser`s own words for a request that did not reach the server', async () => {
    startCheckout.mockRejectedValueOnce(new TypeError('Failed to fetch'))
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

    // An ordinary page show changes nothing: only a page restored as it was left is stale.
    fireEvent(window, new PageTransitionEvent('pageshow', { persisted: false }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(pay()).toBeDisabled()

    fireEvent(window, new PageTransitionEvent('pageshow', { persisted: true }))

    await waitFor(() => expect(pay()).toBeEnabled())
    expect(cancel()).toBeEnabled()
    fireEvent.click(pay())
    await waitFor(() => expect(startCheckout).toHaveBeenCalledTimes(2))
  })

  describe('when the browser does not leave for the payment page', () => {
    /** Lets the time pass, with everything that is due in it: timers, answers and redraws. */
    async function pass(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
    }

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('unlocks the dialog after a while, for closing or for another try', async () => {
      expect(LEAVING_WAIT_MS).toBe(15_000)
      showDialog()
      fireEvent.click(consent())
      fireEvent.click(pay())
      await pass(10)
      expect(hardNavigate).toHaveBeenCalledTimes(1)

      // The load of the payment page may take its time: nothing changes meanwhile.
      await pass(LEAVING_WAIT_MS - 1_000)
      expect(pay()).toBeDisabled()
      expect(cancel()).toBeDisabled()
      expect(consent()).toBeDisabled()
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
      expect(onClose).not.toHaveBeenCalled()

      await pass(1_000)

      expect(pay()).toBeEnabled()
      expect(cancel()).toBeEnabled()
      // The choice is still the customer's own.
      expect(consent()).toBeEnabled()
      expect(consent()).toBeChecked()
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)

      fireEvent.click(pay())
      await pass(10)

      expect(startCheckout).toHaveBeenCalledTimes(2)
      expect(startCheckout).toHaveBeenLastCalledWith(
        { planSlug: 'business', autoRenew: true },
        expect.anything(),
      )
      expect(hardNavigate).toHaveBeenCalledTimes(2)
      // The second try locks the dialog for its own wait.
      expect(pay()).toBeDisabled()
      await pass(LEAVING_WAIT_MS)
      expect(pay()).toBeEnabled()
    })

    it('counts the wait anew for a try made after the page came back from the cache', async () => {
      showDialog()
      fireEvent.click(pay())
      await pass(10)
      await pass(LEAVING_WAIT_MS - 5_000)
      fireEvent(window, new PageTransitionEvent('pageshow', { persisted: true }))
      await pass(10)
      expect(pay()).toBeEnabled()

      fireEvent.click(pay())
      await pass(10)
      expect(hardNavigate).toHaveBeenCalledTimes(2)

      // The wait of the first try would be over by now: the second try has its own.
      await pass(LEAVING_WAIT_MS - 1_000)
      expect(pay()).toBeDisabled()
      expect(cancel()).toBeDisabled()
      await pass(1_000)
      expect(pay()).toBeEnabled()
    })
  })
})

/** A sentence with plain spaces as a pattern that also accepts non-breaking ones. */
function plainPattern(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replaceAll(' ', '\\s')}$`)
}
