// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { UsageActivity as Activity } from './billing-types'
import { plain } from './testing'
import { UsageActivity } from './usage-activity'

const { getActivity } = vi.hoisted(() => ({
  getActivity: vi.fn<(input: { days: number }) => Promise<Activity>>(),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    billing: {
      usageActivity: {
        queryOptions: (input: { days: number }) => ({
          queryKey: ['billing', 'usageActivity', input],
          queryFn: () => getActivity(input),
        }),
      },
    },
  }),
}))

const week: Activity = {
  days: [
    { date: '2026-11-09', actions: 2, credits: { tariff: 9, gift: 3, pack: 1 } },
    { date: '2026-11-10', actions: 5, credits: { tariff: 0, gift: 0, pack: 0 } },
  ],
}

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <UsageActivity />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  getActivity.mockResolvedValue(week)
})

describe('«Активность» on «Использование»', () => {
  it('reads a week first and shows both charts with their totals, legend and words', async () => {
    show()
    const actions = await screen.findByRole('figure', { name: /действий/ })
    expect(getActivity).toHaveBeenCalledWith({ days: 7 })
    expect(plain(actions.textContent)).toContain('7 действий')
    const credits = screen.getByRole('figure', { name: /кредитов/ })
    expect(plain(credits.textContent)).toContain('13 кредитов')
    expect(texts(within(credits).getAllByRole('listitem'))).toEqual([
      'Из пакета',
      'Подарочные',
      'По тарифу',
    ])
    // A column per day; a day without anything draws no segment.
    expect(document.querySelectorAll('[data-day="2026-11-10"] [data-part]')).toHaveLength(2 - 1)
    expect(
      [...document.querySelectorAll('[data-day="2026-11-09"] [data-part]')]
        .filter((part) => part.closest('figure') === credits)
        .map((part) => part.getAttribute('data-part')),
    ).toEqual(['tariff', 'gift', 'pack'])
  })

  it('gives the numbers as a table to assistive technology', async () => {
    show()
    const table = await screen.findByRole('table', { name: 'Действия и расход кредитов по дням' })
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    expect(plain(within(table).getAllByRole('row')[1]?.textContent)).toBe('пн, 9 ноября2931')
  })

  it('reads a month when the span is switched', async () => {
    show()
    await screen.findByRole('table')
    fireEvent.click(screen.getByRole('button', { name: '30 дней' }))
    await waitFor(() => expect(getActivity).toHaveBeenCalledWith({ days: 30 }))
    expect(screen.getByRole('button', { name: '30 дней' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('offers to read again when the numbers did not come', async () => {
    getActivity.mockRejectedValue(new Error('down'))
    show()
    expect(await screen.findByText('Не удалось загрузить активность.')).toBeInTheDocument()
    getActivity.mockResolvedValue(week)
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(await screen.findByRole('table')).toBeInTheDocument()
  })
})

const texts = (elements: HTMLElement[]) => elements.map((element) => plain(element.textContent))
