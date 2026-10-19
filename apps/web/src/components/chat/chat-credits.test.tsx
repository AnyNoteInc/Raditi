// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BillingUsage } from '@/components/billing/billing-types'
import { plain, subscriptionTo, taskCreditsFor, type TaskFacts } from '@/components/billing/testing'

import { ChatCredits, creditsNotice } from './chat-credits'

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
      price: '1990.00',
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

/** «Бизнес» is overdue: 20 credits of the tariff and 100 of a pack are on the accounts. */
function overdueWithPack(): BillingUsage {
  const subscription = subscriptionTo({
    status: 'past_due',
    pastDueSince: new Date('2026-10-18T09:00:00Z'),
  })
  return {
    ...giftOnly(0),
    subscription,
    gift: { left: 0, held: 0, granted: true },
    pack: { left: 100, held: 0 },
    totalLeft: 120,
    ...taskCreditsFor(
      {
        tariff: { balance: 20, held: 0 },
        gift: { balance: 0, held: 0 },
        pack: { balance: 100, held: 0 },
      },
      subscription,
    ),
  }
}

function showCredits() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ChatCredits />
    </QueryClientProvider>,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('the credits under the list', () => {
  it('says how many credits are left and links to the details', async () => {
    usageCall.mockResolvedValue(giftOnly(35))
    showCredits()
    expect(plain((await screen.findByText(/Осталось/)).textContent)).toBe('Осталось 35 кредитов')
    expect(screen.getByRole('link', { name: 'Подробнее о кредитах' }).getAttribute('href')).toBe(
      '/settings/usage',
    )
  })

  it('tells why a new task would not be taken, in the words of the billing pages', async () => {
    usageCall.mockResolvedValue(giftOnly(35, { rateUsable: false }))
    showCredits()
    expect(
      await screen.findByText(
        'Задачи сейчас не принимаются: мы обновляем расчёт кредитов. Попробуйте ещё раз немного позже.',
      ),
    ).toBeTruthy()
  })

  it('counts what a new dialog can spend as the server does, never on its own', async () => {
    // An overdue tariff leaves only the gift to spend: the pack waits for the payment.
    const usage = overdueWithPack()
    expect(usage.spendable).toBe(0)
    usageCall.mockResolvedValue(usage)
    showCredits()
    expect(plain((await screen.findByText(/Осталось/)).textContent)).toBe('Осталось 0 кредитов')
    expect(creditsNotice(usage)).not.toBeNull()
  })

  it('stays out of the way when the credits cannot be read', async () => {
    usageCall.mockRejectedValue(new Error('offline'))
    showCredits()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByText(/Осталось/)).toBeNull()
  })
})

describe('creditsNotice', () => {
  it('is null while a new task would be taken', () => {
    expect(creditsNotice(giftOnly(35))).toBeNull()
  })

  it('names the end of the gift', () => {
    expect(creditsNotice(giftOnly(0))).not.toBeNull()
  })
})
