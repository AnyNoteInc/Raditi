// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ScheduleDetail } from './schedule-model'
import { SchedulePage } from './schedule-page'
import { CHAT_ID, NOW, scheduleDetail, scheduleRun, SCHEDULE_ID } from './testing'

const { getSchedule, runNow, remove, push } = vi.hoisted(() => ({
  getSchedule: vi.fn<() => Promise<ScheduleDetail>>(),
  runNow: vi.fn(async (_input: unknown) => ({ taskId: '019f2a00-0000-7000-8000-0000000000c9' })),
  remove: vi.fn(async (_input: unknown) => ({ deleted: true as const })),
  push: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/components/notifications/browser-push-control', () => ({
  BrowserPushControl: () => <span data-testid="browser-push" />,
}))

const query = (key: string, fn: () => Promise<unknown>) => ({
  queryKey: (input?: unknown) => (input === undefined ? [key] : [key, input]),
  queryOptions: (input?: unknown) => ({
    queryKey: input === undefined ? [key] : [key, input],
    queryFn: fn,
  }),
})
const mutation = (fn: (input: never) => Promise<unknown>) => ({
  mutationOptions: (options: object = {}) => ({ mutationFn: fn, ...options }),
})

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    schedule: {
      list: query('schedule.list', async () => ({ schedules: [], timezone: 'Europe/Moscow' })),
      get: query('schedule.get', getSchedule),
      costHint: query('schedule.costHint', async () => ({
        averageCredits: 11,
        runsPerWeek: 5,
        creditsPerWeek: 55,
        weeklyLimit: 210,
        overHalf: false,
        nextRunAt: null,
      })),
      setEnabled: mutation(async () => null),
      runNow: mutation(runNow),
      delete: mutation(remove),
      create: mutation(async () => null),
      update: mutation(async () => null),
    },
    project: { list: query('project.list', async () => []) },
  }),
}))

function show() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <SchedulePage scheduleId={SCHEDULE_ID} userId="user-1" />
    </QueryClientProvider>,
  )
}

const hourly = [{ kind: 'hourly' as const, minute: 0 }]
const missed = (id: string, iso: string, missedCount: number) =>
  scheduleRun({
    id,
    dueAt: new Date(iso),
    state: { kind: 'skipped', reason: 'missed', missedCount },
    chat: null,
    startedAt: null,
  })

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the page of a scheduled task (plan 82, Зп6)', () => {
  it('shows the task, its facts and the way back', async () => {
    getSchedule.mockResolvedValue(scheduleDetail())
    show()
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Проверка сайта' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Запланированные задачи' })).toHaveAttribute(
      'href',
      '/scheduled',
    )
    expect(screen.getByText('Следующий запуск: завтра в 9:00')).toBeInTheDocument()
    const facts = screen.getAllByRole('term')[0]?.closest('dl')
    if (!(facts instanceof HTMLElement)) throw new Error('no facts')
    expect(facts).toHaveTextContent('Откройте сайт и пройдите главную и важные страницы.')
    expect(facts).toHaveTextContent('По будням в 9:00')
    expect(within(facts).getByRole('link', { name: 'Кофейня «Крошка»' })).toBeInTheDocument()
    expect(facts).toHaveTextContent('Низкое')
    expect(facts).toHaveTextContent('Сообщим, когда задача выполнится')
    expect(
      await within(facts).findByText(/в среднем около 11\. Так выйдет примерно 55 в неделю/),
    ).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Включить задачу «Проверка сайта»' })).toBeChecked()
    expect(screen.getByText('Задача ещё не запускалась.')).toBeInTheDocument()
  })

  it('lists the runs: when, how, what came of it, its chat; missed in a row as one line', async () => {
    getSchedule.mockResolvedValue(
      scheduleDetail({ triggers: hourly }, [
        scheduleRun({ id: 'a', dueAt: new Date('2026-11-15T08:00:00.000Z'), trigger: 'manual' }),
        missed('b', '2026-11-15T05:00:00.000Z', 3),
        scheduleRun({
          id: 'c',
          dueAt: new Date('2026-11-15T04:00:00.000Z'),
          state: { kind: 'chat_deleted' },
          chat: null,
        }),
      ]),
    )
    show()
    const runs = await screen.findByRole('list', { name: 'Запуски' })
    const lines = within(runs).getAllByRole('listitem')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toHaveTextContent('сегодня в 11:00')
    expect(lines[0]).toHaveTextContent('вручную')
    expect(lines[0]).toHaveTextContent('Выполнена')
    expect(
      within(lines[0]!).getByRole('link', { name: 'Открыть чат запуска: сегодня в 11:00' }),
    ).toHaveAttribute('href', `/chats/${CHAT_ID}`)
    expect(lines[1]).toHaveTextContent('Пропущены запуски с 8:00 по 10:00')
    expect(lines[2]).toHaveTextContent('Чат удалён')
    expect(within(lines[2]!).queryByRole('link')).toBeNull()
  })

  it('runs the task now and opens its chat', async () => {
    getSchedule.mockResolvedValue(scheduleDetail())
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Запустить сейчас' }))
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith('/chats/019f2a00-0000-7000-8000-0000000000c9'),
    )
  })

  it('deletes the task after the question and goes back to the list', async () => {
    getSchedule.mockResolvedValue(scheduleDetail())
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Ещё действия' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Удалить' }))
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Удалить задачу «Проверка сайта»?' })).getByRole(
        'button',
        { name: 'Удалить' },
      ),
    )
    await waitFor(() => expect(push).toHaveBeenCalledWith('/scheduled'))
  })

  it('says a task that is gone is gone', async () => {
    getSchedule.mockRejectedValue(
      Object.assign(new Error('Задачи уже нет'), {
        data: { code: 'NOT_FOUND', domainCode: 'SCHEDULE_NOT_FOUND' },
      }),
    )
    show()
    expect(await screen.findByRole('heading', { name: 'Задачи уже нет.' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'К запланированным задачам' })).toHaveAttribute(
      'href',
      '/scheduled',
    )
  })

  it('offers «Повторить» when the task could not be read', async () => {
    getSchedule.mockRejectedValueOnce(new Error('offline'))
    show()
    expect(
      await screen.findByText('Не удалось загрузить задачу. Попробуйте ещё раз.'),
    ).toBeInTheDocument()
    getSchedule.mockResolvedValue(scheduleDetail())
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Проверка сайта' }),
    ).toBeInTheDocument()
  })
})
