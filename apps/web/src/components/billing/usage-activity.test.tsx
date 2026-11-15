// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { UsageActivity as Activity, UsageActivityDay } from './billing-types'
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

const none = { tariff: 0, gift: 0, pack: 0 }
const day = (date: string, actions: number, credits = none): UsageActivityDay => ({
  date,
  actions,
  credits,
})

const week: Activity = {
  days: [day('2026-11-09', 2, { tariff: 9, gift: 3, pack: 1 }), day('2026-11-10', 5)],
}
/** A year ending on Sunday 15 November 2026, with actions on three days. */
const year: Activity = {
  days: Array.from({ length: 365 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 10, 16 + index)).toISOString().slice(0, 10)
    const actions = { '2026-11-10': 8, '2026-11-11': 2, '2026-10-01': 4 }[date] ?? 0
    return day(date, actions)
  }),
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
  getActivity.mockImplementation(({ days }) => Promise.resolve(days === 365 ? year : week))
})

describe('«Активность» on «Использование»', () => {
  it('draws a year of actions in weeks, Monday on top, coloured against the busiest day', async () => {
    show()
    const actions = await screen.findByRole('figure', { name: /действий/ })
    expect(getActivity).toHaveBeenCalledWith({ days: 365 })
    expect(plain(actions.textContent)).toContain('14 действий за год')
    const cells = actions.querySelectorAll('[data-day]')
    expect(cells).toHaveLength(365)
    const level = (date: string) =>
      actions.querySelector(`[data-day="${date}"]`)?.getAttribute('data-level')
    expect([
      level('2026-11-10'),
      level('2026-10-01'),
      level('2026-11-11'),
      level('2026-11-12'),
    ]).toEqual(['4', '2', '1', '0'])
    // The year starts on Sunday 16 November 2025: six empty places before it in its week.
    const firstWeek = cells[0]?.parentElement
    expect(firstWeek?.children).toHaveLength(7)
    expect(firstWeek?.lastElementChild?.getAttribute('data-day')).toBe('2025-11-16')
    expect(plain(actions.textContent)).toContain('нояб.')
  })

  it('shows a week of credits first, by account, and a month when the span is switched', async () => {
    show()
    const credits = await screen.findByRole('figure', { name: /списано/ })
    expect(getActivity).toHaveBeenCalledWith({ days: 7 })
    expect(plain(credits.textContent)).toContain('13 кредитов')
    expect(
      [...credits.querySelectorAll('[data-day="2026-11-09"] [data-part]')].map((part) =>
        part.getAttribute('data-part'),
      ),
    ).toEqual(['tariff', 'gift', 'pack'])
    const table = screen.getByRole('table', { name: 'Расход кредитов по дням' })
    expect(plain(within(table).getAllByRole('row')[1]?.textContent)).toBe('пн, 9 ноября931')

    fireEvent.click(screen.getByRole('button', { name: '30 дней' }))
    await waitFor(() => expect(getActivity).toHaveBeenCalledWith({ days: 30 }))
    expect(screen.getByRole('button', { name: '30 дней' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('offers to read again when the numbers did not come', async () => {
    getActivity.mockRejectedValue(new Error('down'))
    show()
    const failed = await screen.findAllByText('Не удалось загрузить активность.')
    expect(failed).toHaveLength(2)
    getActivity.mockImplementation(({ days }) => Promise.resolve(days === 365 ? year : week))
    for (const retry of screen.getAllByRole('button', { name: 'Повторить' })) fireEvent.click(retry)
    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(await screen.findByRole('figure', { name: /действий/ })).toBeInTheDocument()
  })
})
