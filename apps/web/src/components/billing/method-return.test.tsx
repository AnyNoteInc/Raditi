// @vitest-environment jsdom
import {
  focusManager,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MethodBinding } from './billing-types'
import { MethodReturn } from './method-return'
import { RETURN_POLL_MS, RETURN_WAIT_MS } from './return-check'
import { overviewOf, plain, serverRefusal, subscriptionTo } from './testing'

const { syncPaymentMethod, trpc } = vi.hoisted(() => ({
  syncPaymentMethod: vi.fn<(input: Record<string, never>) => Promise<MethodBinding>>(),
  // One object for every render, as the real context gives.
  trpc: { billing: { overview: { queryKey: () => ['billing', 'overview'] } } },
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => trpc,
  useTRPCClient: () => ({ billing: { syncPaymentMethod: { mutate: syncPaymentMethod } } }),
}))

const VISA = `Карта Visa ••${String.fromCharCode(0xa0)}1234`
const binding = (
  state: MethodBinding['state'],
  patch: Partial<MethodBinding> = {},
): MethodBinding => ({
  state,
  renewalCharge: 'none',
  subscription: subscriptionTo(),
  ...patch,
})
const bound = binding('active', {
  subscription: subscriptionTo({ paymentMethod: { label: VISA } }),
})

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

/** The page after its first request has been answered. */
async function showReturn(queryClient = new QueryClient()) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MethodReturn />
    </QueryClientProvider>,
  )
  await pass(0)
  return view
}

const pageText = () => plain(document.body.textContent)
const heading = () => screen.getByRole('heading', { level: 2 }).textContent
const requests = () => syncPaymentMethod.mock.calls.length
const toBilling = (name: string) => screen.getByRole('link', { name })

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  syncPaymentMethod.mockResolvedValue(binding('pending'))
})

afterEach(() => {
  vi.useRealTimers()
  focusManager.setFocused(undefined)
})

describe('the return page of a binding that has no outcome yet', () => {
  it('asks at once, names nothing in the request, and says that it is checking', async () => {
    let answer!: (result: MethodBinding) => void
    syncPaymentMethod.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    await showReturn()

    expect(screen.getByRole('heading', { level: 1, name: 'Оплата' })).toBeInTheDocument()
    // The server knows whose binding it is: the page sends nothing.
    expect(syncPaymentMethod.mock.calls).toEqual([[{}]])
    expect(heading()).toBe('Проверяем привязку карты')
    expect(screen.getByRole('status')).toHaveTextContent('Обычно это занимает несколько секунд.')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()

    await act(async () => answer(bound))
    await pass(0)

    expect(heading()).toBe('Карта привязана')
  })

  it('asks again every three seconds, and stops at the outcome', async () => {
    await showReturn()
    expect(requests()).toBe(1)

    await pass(RETURN_POLL_MS - 1)
    expect(requests()).toBe(1)
    await pass(1)
    expect(requests()).toBe(2)

    syncPaymentMethod.mockResolvedValue(bound)
    await pass(RETURN_POLL_MS)

    expect(requests()).toBe(3)
    expect(heading()).toBe('Карта привязана')
    // The outcome is final: nothing more is asked, on a timer or on coming back to the tab.
    await pass(RETURN_WAIT_MS * 2)
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await pass(0)
    expect(requests()).toBe(3)
  })

  it('stops asking after thirty seconds and leaves the check to the customer', async () => {
    await showReturn()

    await pass(RETURN_WAIT_MS - 1)
    expect(heading()).toBe('Проверяем привязку карты')
    // One request at the start and one every three seconds since.
    expect(requests()).toBe(10)

    await pass(1)
    expect(heading()).toBe('Привязка ещё не подтверждена')
    // What is true then: nothing asks any more until «Оплата» is opened, which settles it.
    expect(pageText()).toContain(
      'ЮKassa ещё не подтвердила карту. Можно закрыть страницу: карта появится в разделе «Оплата», когда вы откроете его после завершения привязки.',
    )
    expect(pageText()).not.toContain('когда привязка завершится')
    expect(toBilling('В раздел «Оплата»')).toHaveAttribute('href', '/settings/billing')
    // The look that fell on the thirtieth second may still be made; none follows it.
    const asked = requests()
    await pass(RETURN_WAIT_MS * 4)
    expect(requests()).toBe(asked)

    syncPaymentMethod.mockResolvedValue(bound)
    fireEvent.click(screen.getByRole('button', { name: 'Проверить ещё раз' }))
    await pass(0)

    expect(requests()).toBe(asked + 1)
    expect(heading()).toBe('Карта привязана')
  })
})

describe('the return page of a binding that ended', () => {
  it('says that the card is bound, names it and what happens to it next', async () => {
    syncPaymentMethod.mockResolvedValue(bound)
    await showReturn()

    expect(heading()).toBe('Карта привязана')
    expect(screen.getByRole('status')).toHaveTextContent('Карта привязана')
    expect(pageText()).toContain('Способ оплаты — Карта Visa •• 1234.')
    expect(pageText()).toContain(
      '18 октября спишем этим способом 12 900 ₽ за тариф «Бизнес». Если его отвязать, автопродление отключится.',
    )
    expect(toBilling('В раздел «Оплата»')).toHaveAttribute('href', '/settings/billing')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(requests()).toBe(1)
  })

  it('does not promise a charge to a tariff that does not renew', async () => {
    syncPaymentMethod.mockResolvedValue(
      binding('active', {
        subscription: subscriptionTo({ autoRenewal: false, paymentMethod: { label: VISA } }),
      }),
    )
    await showReturn()

    expect(pageText()).toContain(
      'Автопродление выключено: списаний не будет. Тариф действует до 18 октября 2026.',
    )
    expect(pageText()).not.toContain('спишем')
  })

  it.each([
    [
      'is at the bank',
      'at_bank',
      true,
      'Списание за следующий период уже отправлено в банк с прежнего способа оплаты; следующие пойдут с новой карты.',
    ],
    [
      'has no answer, on a tariff that does not renew',
      'unanswered',
      false,
      'Списание за следующий период уже отправлялось в банк с прежнего способа оплаты, ответа пока нет. Мы проверим его: если деньги списаны, тариф продлится ещё на месяц или мы вернём их. Автопродление выключено: других списаний не будет.',
    ],
  ] as const)(
    'does not promise the new card for a charge that %s',
    async (_case, renewalCharge, autoRenewal, note) => {
      syncPaymentMethod.mockResolvedValue(
        binding('active', {
          renewalCharge,
          subscription: subscriptionTo({ autoRenewal, paymentMethod: { label: VISA } }),
        }),
      )
      await showReturn()

      expect(heading()).toBe('Карта привязана')
      expect(pageText()).toContain('Способ оплаты — Карта Visa •• 1234.')
      expect(pageText()).toContain(note)
      expect(pageText()).not.toContain('спишем этим способом')
      // The outcome is final all the same: the page asks no more.
      await pass(RETURN_WAIT_MS * 2)
      expect(requests()).toBe(1)
    },
  )

  it('says that the card was not bound, that nothing was charged and which method stays', async () => {
    syncPaymentMethod.mockResolvedValue(binding('inactive'))
    await showReturn()

    expect(heading()).toBe('Не удалось привязать карту')
    expect(pageText()).toContain(
      'ЮKassa не сохранила карту: привязка отменена или время на неё истекло. Денег с карты не списано.',
    )
    expect(pageText()).toContain('Способ оплаты прежний — Карта «Мир» •• 4444.')
    // No «Попробовать ещё раз»: whether a second try is offered is what «Оплата» knows.
    expect(toBilling('В раздел «Оплата»')).toHaveAttribute('href', '/settings/billing')
    expect(screen.queryByRole('link', { name: 'Попробовать ещё раз' })).not.toBeInTheDocument()
    // A refusal of the customer is not a failure of the page.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await pass(RETURN_WAIT_MS * 2)
    expect(requests()).toBe(1)
  })

  it.each([
    ['with a tariff', subscriptionTo()],
    ['without one', null],
  ])(
    'says that nothing is being bound %s, and where the method is',
    async (_case, subscription) => {
      syncPaymentMethod.mockResolvedValue(binding('none', { subscription }))
      await showReturn()

      expect(heading()).toBe('Привязка карты не найдена')
      expect(pageText()).toContain(
        'Сейчас ни одна карта не ждёт привязки. Сохранённый способ оплаты — в разделе «Оплата».',
      )
      expect(toBilling('В раздел «Оплата»')).toHaveAttribute('href', '/settings/billing')
      await pass(RETURN_WAIT_MS * 2)
      expect(requests()).toBe(1)
    },
  )

  it.each([
    ['bound', bound],
    ['not bound', binding('inactive')],
    ['not found', binding('none')],
  ])('tells the pages that show the method to read anew once it is %s', async (_case, result) => {
    syncPaymentMethod.mockResolvedValue(result)
    const queryClient = new QueryClient()
    queryClient.setQueryData(['billing', 'overview'], overviewOf())
    queryClient.setQueryData(['billing', 'plans'], { plans: [] })

    await showReturn(queryClient)

    expect(queryClient.getQueryState(['billing', 'overview'])?.isInvalidated).toBe(true)
    // What a binding does not change is left alone.
    expect(queryClient.getQueryState(['billing', 'plans'])?.isInvalidated).toBe(false)
  })

  it('leaves the data of the other pages alone while the binding has no outcome', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(['billing', 'overview'], overviewOf())

    await showReturn(queryClient)
    await pass(RETURN_WAIT_MS)

    expect(queryClient.getQueryState(['billing', 'overview'])?.isInvalidated).toBe(false)
  })
})

describe('the return page of a binding when a check fails', () => {
  it('asks again after a check that did not reach the server, and reports it only when it stops', async () => {
    syncPaymentMethod.mockRejectedValue(new TypeError('Failed to fetch'))
    await showReturn()

    expect(heading()).toBe('Проверяем привязку карты')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await pass(RETURN_POLL_MS)
    expect(requests()).toBe(2)

    await pass(RETURN_WAIT_MS)

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Не удалось проверить привязку карты. Проверьте соединение и попробуйте ещё раз.',
    )
    expect(pageText()).not.toContain('Failed to fetch')

    syncPaymentMethod.mockResolvedValue(bound)
    fireEvent.click(screen.getByRole('button', { name: 'Проверить ещё раз' }))
    await pass(0)

    expect(heading()).toBe('Карта привязана')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows a refusal of the server in its words, at once, and does not ask about it again', async () => {
    syncPaymentMethod.mockRejectedValue(
      serverRefusal(
        'Оплата сейчас недоступна. Попробуйте ещё раз немного позже',
        'BILLING_PAYMENTS_NOT_CONFIGURED',
      ),
    )
    await showReturn()

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Оплата сейчас недоступна. Попробуйте ещё раз немного позже.',
    )
    await pass(RETURN_WAIT_MS * 2)
    expect(requests()).toBe(1)
  })

  it('goes on to the outcome when a later check gets through', async () => {
    syncPaymentMethod
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(bound)
    await showReturn()
    expect(heading()).toBe('Проверяем привязку карты')

    await pass(RETURN_POLL_MS)

    expect(heading()).toBe('Карта привязана')
    expect(requests()).toBe(2)
  })
})
