// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AutoRenewalCancel, ComingRenewal } from '@/components/billing/billing-types'
import { plain, serverRefusal } from '@/components/billing/testing'

import { AutoRenewalNotice } from './auto-renewal-notice'

type Nothing = Record<string, never>

const { getRenewal, cancelAutoRenew } = vi.hoisted(() => ({
  getRenewal: vi.fn<() => Promise<{ renewal: ComingRenewal | null }>>(),
  cancelAutoRenew: vi.fn<(input: Nothing) => Promise<AutoRenewalCancel>>(),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    billing: {
      autoRenewal: {
        queryKey: () => ['billing', 'autoRenewal'],
        queryOptions: () => ({ queryKey: ['billing', 'autoRenewal'], queryFn: getRenewal }),
      },
      cancelAutoRenew: {
        mutationOptions: (options: UseMutationOptions<AutoRenewalCancel, Error, Nothing>) => ({
          ...options,
          mutationFn: cancelAutoRenew,
        }),
      },
    },
  }),
}))

const PERIOD_END = new Date('2026-10-18T09:00:00Z')

/**
 * «Бизнес» renews on 18 October for 12 900 ₽ at a shop that saves payment methods, unless told
 * otherwise.
 */
const renewal = (patch: Partial<ComingRenewal> = {}): ComingRenewal => ({
  planName: 'Бизнес',
  nextPlanName: null,
  amount: '12900.00',
  chargeAt: PERIOD_END,
  renewalCharge: 'none',
  oneTimeOnly: false,
  ...patch,
})

function showNotice() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <AutoRenewalNotice />
    </QueryClientProvider>,
  )
}

const text = () => plain(document.body.textContent)

beforeEach(() => {
  vi.clearAllMocks()
  getRenewal.mockResolvedValue({ renewal: renewal() })
})

describe('the coming charge on the page that asks for the consent', () => {
  it('names the tariff, the day and the amount, and says that stopping it needs no consent', async () => {
    showNotice()

    expect(await screen.findByRole('region', { name: 'Автопродление тарифа' })).toBeVisible()
    expect(text()).toContain(
      'У вас включено автопродление тарифа «Бизнес»: 18 октября спишем 12 900 ₽. Отключить его можно, не принимая документы.',
    )
    expect(screen.getByRole('button', { name: 'Отключить автопродление' })).toBeEnabled()
    // It can be switched back on at this shop: nothing is said of that.
    expect(text()).not.toContain('Включить автопродление')
  })

  it.each([
    ['none', 'Отключить его можно, не принимая документы.'],
    [
      'at_bank',
      'Отключить автопродление можно, не принимая документы: это списание не отменится, других не будет.',
    ],
  ] as const)(
    'says before the press that it cannot be switched back on at a shop that takes one-time payments only (%s)',
    async (renewalCharge, stops) => {
      getRenewal.mockResolvedValue({ renewal: renewal({ renewalCharge, oneTimeOnly: true }) })
      showNotice()

      await screen.findByRole('button', { name: 'Отключить автопродление' })
      // No dialog asks first here: these are the last words before the button that does it.
      expect(text()).toContain(
        `${stops} Включить автопродление снова пока будет нельзя.Отключить автопродление`,
      )
      expect(cancelAutoRenew).not.toHaveBeenCalled()
    },
  )

  it('names the scheduled tariff and its price when a change is scheduled', async () => {
    getRenewal.mockResolvedValue({
      renewal: renewal({ nextPlanName: 'Агентство', amount: '39900.00' }),
    })
    showNotice()

    await screen.findByRole('button', { name: 'Отключить автопродление' })
    expect(text()).toContain(
      'У вас включено автопродление: 18 октября тариф «Бизнес» сменится на «Агентство», спишем 39 900 ₽. Отключить его можно, не принимая документы.',
    )
  })

  it.each([
    ['at_bank', 'Списание за следующий период уже отправлено в банк.'],
    ['unanswered', 'Списание за следующий период уже отправлялось в банк, ответа пока нет.'],
  ] as const)(
    'promises no day for a charge that has already left (%s)',
    async (renewalCharge, sent) => {
      getRenewal.mockResolvedValue({ renewal: renewal({ renewalCharge }) })
      showNotice()

      await screen.findByRole('button', { name: 'Отключить автопродление' })
      expect(text()).toContain(
        `У вас включено автопродление тарифа «Бизнес». ${sent} Отключить автопродление можно, не принимая документы: это списание не отменится, других не будет.`,
      )
      expect(text()).not.toContain('18 октября спишем')
    },
  )

  it.each([
    ['nobody is charged', () => getRenewal.mockResolvedValue({ renewal: null })],
    ['the answer does not come', () => getRenewal.mockRejectedValue(new Error('Failed to fetch'))],
    ['the answer is on its way', () => getRenewal.mockReturnValue(new Promise(() => undefined))],
  ])('draws nothing when %s', async (_case, arrange) => {
    arrange()
    showNotice()

    await waitFor(() => expect(getRenewal).toHaveBeenCalled())
    await Promise.resolve()
    expect(document.body.textContent).toBe('')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    // A failed look is not repeated behind the form.
    expect(getRenewal).toHaveBeenCalledTimes(1)
  })
})

describe('switching auto-renewal off without accepting the documents', () => {
  it('switches it off in one press, once, and says until when the tariff works', async () => {
    cancelAutoRenew.mockResolvedValue({ renewalCharge: 'none', periodEnd: PERIOD_END })
    showNotice()
    const button = await screen.findByRole('button', { name: 'Отключить автопродление' })
    // What the page reads after the switch: nobody is charged any more.
    getRenewal.mockResolvedValue({ renewal: null })

    fireEvent.click(button)
    fireEvent.click(button)

    const said = await screen.findByRole('status')
    expect(plain(said.textContent)).toBe(
      'Автопродление отключено. Тариф «Бизнес» действует до 18 октября 2026.',
    )
    await waitFor(() => expect(said).toHaveFocus())
    expect(cancelAutoRenew).toHaveBeenCalledExactlyOnceWith({}, expect.anything())
    expect(screen.queryByRole('button')).toBeNull()
    // The words stay after the page has read that nothing is charged.
    await waitFor(() => expect(getRenewal).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('status')).toBeVisible()
    expect(text()).not.toContain('У вас включено автопродление')
  })

  it.each([
    [
      'at_bank',
      'Автопродление отключено. Списание за следующий период уже отправлено в банк: если оно пройдёт, тариф продлится ещё на месяц. Больше списаний не будет.',
    ],
    [
      'unanswered',
      'Автопродление отключено. Списание за следующий период уже отправлялось в банк, ответа пока нет. Мы проверим его: если деньги списаны, тариф продлится ещё на месяц или мы вернём их. Больше списаний не будет.',
    ],
  ] as const)(
    'tells of a charge the switch found under way (%s) instead of a last day',
    async (renewalCharge, said) => {
      cancelAutoRenew.mockResolvedValue({ renewalCharge, periodEnd: PERIOD_END })
      showNotice()

      fireEvent.click(await screen.findByRole('button', { name: 'Отключить автопродление' }))

      expect(plain((await screen.findByRole('status')).textContent)).toBe(said)
    },
  )

  it('shows a refusal and lets the user try again', async () => {
    cancelAutoRenew.mockRejectedValueOnce(new Error('Failed to fetch'))
    cancelAutoRenew.mockResolvedValueOnce({ renewalCharge: 'none', periodEnd: PERIOD_END })
    showNotice()
    const button = await screen.findByRole('button', { name: 'Отключить автопродление' })

    fireEvent.click(button)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось отключить автопродление. Проверьте соединение и попробуйте ещё раз.',
    )
    expect(screen.queryByRole('status')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Отключить автопродление' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Автопродление отключено.')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says the server`s words for a refusal, in Russian', async () => {
    cancelAutoRenew.mockRejectedValue(
      serverRefusal(
        'У вас нет действующего тарифа. Обновите страницу, чтобы увидеть, что изменилось',
        'BILLING_NO_LIVE_SUBSCRIPTION',
      ),
    )
    // The page behind the refusal still says that a charge is coming.
    showNotice()

    fireEvent.click(await screen.findByRole('button', { name: 'Отключить автопродление' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'У вас нет действующего тарифа. Обновите страницу, чтобы увидеть, что изменилось.',
    )
  })
})
