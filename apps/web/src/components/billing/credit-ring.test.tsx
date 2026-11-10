// @vitest-environment jsdom
import { signupGiftCredits } from '@repo/domain/billing/credit-numbers'
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BillingUsage } from '@/components/billing/billing-types'
import {
  plain,
  subscriptionTo,
  tariffMeter,
  taskCreditsFor,
  type TaskFacts,
} from '@/components/billing/testing'

import { CreditRing, creditRing, creditRows, creditWords, usageNotice } from './credit-ring'

const { usage: usageCall } = vi.hoisted(() => ({
  usage: vi.fn<() => Promise<BillingUsage>>(),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    billing: {
      usage: {
        queryOptions: () => ({ queryKey: ['billing', 'usage'] as QueryKey, queryFn: usageCall }),
      },
    },
  }),
}))

/** A customer without a tariff who has `gift` credits of the gift left. */
function giftOnly(gift: number, facts: TaskFacts = {}): BillingUsage {
  return {
    paymentsEnabled: true,
    autoRenewalAvailable: true,
    packOnSale: {
      id: '018f0000-0000-7000-8000-0000000000cc',
      slug: 'pack',
      name: 'Пакет из 100 кредитов',
      credits: 100,
      price: '1490.00',
      withoutTariff: false,
    },
    subscription: null,
    tariff: null,
    gift: { left: gift, held: 0, granted: true },
    pack: { left: 0, held: 0 },
    history: { items: [], nextCursor: null },
    totalLeft: gift,
    ...taskCreditsFor(
      {
        tariff: { balance: 0, held: 0 },
        gift: { balance: gift, held: 0 },
        pack: { balance: 0, held: 0 },
      },
      null,
      facts,
    ),
  }
}

/**
 * «Бизнес» with `left` of its 600 credits and a pack of 100 bought; `creditsPerDay` gives it a
 * daily limit, which no tariff on sale has since 06.11.2026.
 */
function onBusiness(
  left: number,
  facts: TaskFacts = {},
  creditsPerDay: number | null = null,
): BillingUsage {
  const base = subscriptionTo()
  const subscription = subscriptionTo({ plan: { ...base.plan, creditsPerDay } })
  const credits = taskCreditsFor(
    {
      tariff: { balance: left, held: 0 },
      gift: { balance: 0, held: 0 },
      pack: { balance: 100, held: 0 },
    },
    subscription,
    facts,
  )
  return {
    ...giftOnly(0),
    subscription,
    tariff: {
      credits: tariffMeter({ charged: 600 - left, left }),
      today: credits.today,
      sites: { count: 1, max: 3 },
      bySite: [],
    },
    pack: { left: 100, held: 0 },
    totalLeft: left + 100,
    ...credits,
  }
}

function showRing() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <CreditRing placement="sidebar" />
    </QueryClientProvider>,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('the credit ring over the account menu', () => {
  it('says what is left of the gift and opens the window of the credits', async () => {
    usageCall.mockResolvedValue(giftOnly(20))
    showRing()
    const ring = await screen.findByRole('button', {
      name: `Подарочные кредиты: осталось 20 из ${signupGiftCredits}`,
    })
    fireEvent.click(ring)
    const window = await screen.findByRole('dialog')
    expect(plain(within(window).getByRole('heading').textContent)).toBe('Без тарифа')
    expect(within(window).getByText('Подарок')).toBeTruthy()
    expect(within(window).getByText(`осталось 20 из ${signupGiftCredits}`)).toBeTruthy()
    const manage = within(window).getByRole('link', { name: 'Управлять использованием' })
    expect(manage.getAttribute('href')).toBe('/settings/usage')
  })

  it('tells why a new task would not be taken, in the words of the billing pages', async () => {
    usageCall.mockResolvedValue(giftOnly(signupGiftCredits, { rateUsable: false }))
    showRing()
    const ring = await screen.findByRole('button', {
      name: `Подарочные кредиты: осталось ${signupGiftCredits} из ${signupGiftCredits}. Сейчас новую задачу начать нельзя`,
    })
    fireEvent.click(ring)
    expect(
      await screen.findByText(
        /Задачи сейчас не принимаются: мы обновляем расчёт кредитов\. Попробуйте ещё раз немного позже\./,
      ),
    ).toBeTruthy()
  })

  it('shows the tariff with its period and the pack', async () => {
    usageCall.mockResolvedValue(onBusiness(512))
    showRing()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Кредиты по тарифу: осталось 512 из 600' }),
    )
    const window = await screen.findByRole('dialog')
    expect(plain(within(window).getByRole('heading').textContent)).toBe(
      'Тариф «Бизнес» до 18 октября',
    )
    expect(within(window).getByText('осталось 512 из 600')).toBeTruthy()
  })

  it('says of an unpaid tariff that its period is over, as «Использование» does', async () => {
    usageCall.mockResolvedValue(unpaid())
    showRing()
    fireEvent.click(
      await screen.findByRole('button', { name: /^Кредиты по тарифу: период закончился/ }),
    )
    const window = await screen.findByRole('dialog')
    expect(plain(within(window).getByRole('heading').textContent)).toBe('Тариф «Бизнес» не оплачен')
    expect(within(window).getByText('период закончился')).toBeTruthy()
    expect(within(window).queryByText(/осталось 205/)).toBeNull()
  })

  it('stays out of the way when the credits cannot be read', async () => {
    usageCall.mockRejectedValue(new Error('offline'))
    showRing()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole('button')).toBeNull()
  })
})

/** «Бизнес» whose renewal failed: 205 of its credits on the account, none of them to spend. */
function unpaid(): BillingUsage {
  const subscription = subscriptionTo({
    status: 'past_due',
    pastDueSince: new Date('2026-10-18T09:00:00Z'),
  })
  const credits = taskCreditsFor(
    {
      tariff: { balance: 205, held: 0 },
      gift: { balance: 0, held: 0 },
      pack: { balance: 0, held: 0 },
    },
    subscription,
  )
  return {
    ...giftOnly(0),
    subscription,
    tariff: {
      credits: tariffMeter({ charged: 395, left: 205 }),
      today: credits.today,
      sites: { count: 1, max: 3 },
      bySite: [],
    },
    totalLeft: 205,
    ...credits,
  }
}

describe('creditRing', () => {
  it('is full of the period of the tariff while there is one', () => {
    expect(creditRing(onBusiness(512))).toEqual({
      label: 'Кредиты по тарифу: осталось 512 из 600',
      share: 512 / 600,
      closed: false,
    })
  })

  it('counts what the renewal carried into the period in what the ring is full of', () => {
    const carried = onBusiness(700)
    carried.tariff!.credits = tariffMeter({ carried: 120, charged: 20, left: 700 })
    expect(creditRing(carried)).toMatchObject({
      label: 'Кредиты по тарифу: осталось 700 из 720',
      share: 700 / 720,
    })
    expect(creditRows(carried)).toContainEqual({ label: 'По тарифу', value: 'осталось 700 из 720' })
  })

  it('is full of the gift without a tariff, and closed when a task would not be taken', () => {
    expect(creditRing(giftOnly(0))).toEqual({
      label: `Подарочные кредиты: осталось 0 из ${signupGiftCredits}. Сейчас новую задачу начать нельзя`,
      share: 0,
      closed: true,
    })
  })

  it('is empty and closed while the tariff waits for its payment', () => {
    expect(creditRing(unpaid())).toMatchObject({ share: 0, closed: true })
  })

  it('says «остался» of 21 credits', () => {
    expect(creditRing(giftOnly(21)).label).toBe(
      `Подарочные кредиты: остался 21 из ${signupGiftCredits}`,
    )
  })
})

describe('creditRows', () => {
  it('names the period and the pack of a tariff, and the day of a tariff that has one', () => {
    expect(creditRows(onBusiness(512)).map((row) => row.label)).toEqual(['По тарифу', 'Пакет'])
    expect(creditRows(onBusiness(512, {}, 100)).map((row) => row.label)).toEqual([
      'Сегодня',
      'По тарифу',
      'Пакет',
    ])
  })

  it('names the gift alone without a tariff', () => {
    expect(creditRows(giftOnly(20))).toEqual([
      { label: 'Подарок', value: `осталось 20 из ${signupGiftCredits}` },
    ])
  })

  it('shows no gift that was never granted', () => {
    const none = { ...giftOnly(0), gift: { left: 0, held: 0, granted: false } }
    expect(creditRows(none)).toEqual([])
  })
})

describe('creditWords', () => {
  it('says nothing while a new task would be taken', () => {
    expect(creditWords(giftOnly(signupGiftCredits))).toBeNull()
    expect(usageNotice(giftOnly(signupGiftCredits))).toBeNull()
  })

  it('names the end of the gift', () => {
    expect(creditWords(giftOnly(0))?.text).toBeTruthy()
  })

  it('says that credits come with a tariff when there is no gift to speak of', () => {
    const none = { ...giftOnly(0), gift: { left: 0, held: 0, granted: false } }
    expect(creditWords(none)).toEqual({
      text: 'Кредиты входят в тариф. Выберите тариф, чтобы ставить задачи: здесь появится, сколько кредитов осталось и на что они ушли.',
      action: 'choose_plan',
    })
  })

  it('says of an unpaid tariff what «Использование» says, and leads to the tariffs', () => {
    expect(creditWords(unpaid())?.action).toBe('pay')
  })
})
