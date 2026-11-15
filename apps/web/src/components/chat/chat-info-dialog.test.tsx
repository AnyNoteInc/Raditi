// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatInfoDialog } from './chat-info-dialog'

const { readInfo } = vi.hoisted(() => ({ readInfo: vi.fn() }))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    task: {
      info: {
        queryOptions: (input: { taskId?: string }) => ({
          queryKey: ['task.info', input],
          queryFn: () => readInfo(input),
        }),
      },
    },
  }),
}))

const taskId = '0199a3f2-0000-7000-8000-0000000000a1'
const info = {
  usage: { plan: 'Старт', total: 120, tariff: 120, gift: 0, pack: 0, week: null, chat: 7 },
  status: {
    title: null,
    status: 'Агент работает',
    project: null,
    model: 'GLM-5.3',
    effort: 'max',
    queued: 0,
    browser: false,
  },
  context: { used: 250_000, window: 1_000_000 },
}

function show(kind: 'usage' | 'status' | 'context', id: string | null = taskId) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ChatInfoDialog kind={kind} taskId={id} onClose={() => {}} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  readInfo.mockResolvedValue(info)
})

describe('`/usage`, `/status` and `/context` in the cabinet (15.11.2026)', () => {
  it('shows the credits of the chat and leads to «Использование»', async () => {
    show('usage')
    expect(await screen.findByText('Этот чат: 7 кредитов.')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Использование' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Открыть «Использование»' }).getAttribute('href')).toBe(
      '/settings/usage',
    )
    expect(readInfo).toHaveBeenCalledWith({ taskId })
  })

  it('asks a new chat for the credits only', async () => {
    show('usage', null)
    await screen.findByText(/Осталось 120 кредитов/u)
    expect(readInfo).toHaveBeenCalledWith({})
  })

  it('tells the state of the chat and its context', async () => {
    show('status')
    expect(await screen.findByText('Модель — GLM-5.3, размышление — максимальное.')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('measures the context', async () => {
    show('context')
    expect(await screen.findByText('Занято 250 тыс. из 1 млн токенов — 25 %.')).toBeTruthy()
  })
})
