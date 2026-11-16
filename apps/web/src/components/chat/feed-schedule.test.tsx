// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { serverRefusal } from '@/components/billing/testing'
import type * as UseBrowserPush from '@/components/notifications/use-browser-push'
import { browserPushText, type BrowserPush } from '@/components/notifications/use-browser-push'

import type { FeedRow, ScheduledTaskItem } from './chat-types'
import { schedulePushRowId } from './feed-list'
import { FeedScheduleChange, FeedScheduleLeft, SHORT_INSTRUCTIONS } from './feed-schedule'
import { SCHEDULE_ID, scheduleChangeRow, scheduleLeftRow } from './testing'

const RUN_CHAT_ID = '0199a3f2-0000-7000-8000-0000000000a8'

const { list, runNow, push, browserPush } = vi.hoisted(() => ({
  list: vi.fn<() => Promise<{ schedules: unknown[]; timezone: string }>>(),
  runNow: vi.fn<(input: { scheduleId: string }) => Promise<{ taskId: string }>>(),
  push: vi.fn(),
  browserPush: { current: null as unknown as BrowserPush },
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    schedule: {
      list: {
        queryKey: () => ['schedule.list'],
        queryOptions: () => ({ queryKey: ['schedule.list'], queryFn: list }),
      },
      runNow: {
        mutationOptions: (
          options: UseMutationOptions<{ taskId: string }, Error, { scheduleId: string }>,
        ) => ({ ...options, mutationFn: runNow }),
      },
    },
  }),
}))
vi.mock('@/components/notifications/use-browser-push', async (importOriginal) => ({
  ...(await importOriginal<typeof UseBrowserPush>()),
  useBrowserPush: () => browserPush.current,
}))

function pushState(state: BrowserPush['state']) {
  browserPush.current = {
    state,
    device: null,
    endpoint: null,
    otherBrowsers: 0,
    working: false,
    problem: null,
    enable: vi.fn(async () => true),
    disable: vi.fn(async () => true),
  }
}

/** Sunday, 15 November 2026, 15:00 in Moscow. */
const now = new Date('2026-11-15T12:00:00.000Z')

function task(patch: Partial<ScheduledTaskItem> = {}): ScheduledTaskItem {
  return {
    id: SCHEDULE_ID,
    name: 'Сводка курсов',
    project: null,
    instructions: 'Пришли курс доллара, евро и юаня по ЦБ и насколько он изменился со вчера.',
    effort: 'low',
    triggers: [{ kind: 'weekdays', time: '08:00' }],
    timezone: 'Europe/Moscow',
    enabled: true,
    notify: true,
    pausedReason: null,
    lastRefusalReason: null,
    // Monday, 8:00 in Moscow.
    nextRunAt: new Date('2026-11-16T05:00:00.000Z'),
    lastRunAt: null,
    createdVia: 'chat',
    templateSlug: null,
    createdAt: now,
    updatedAt: now,
    lastRun: null,
    ...patch,
  }
}

function show(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

const card = (name = 'Сводка курсов') =>
  screen.findByRole('article', { name: `Запланированная задача «${name}»` })

beforeEach(() => {
  vi.clearAllMocks()
  list.mockResolvedValue({ schedules: [task()], timezone: 'Europe/Moscow' })
  pushState('on')
})

describe('the card of a scheduled task the agent created (docs/plan/82, Зп35)', () => {
  it('says what was set up: the name as a link, the schedule, the next run and its details', async () => {
    show(<FeedScheduleChange row={scheduleChangeRow('1')} now={now} />)
    const shown = within(await card())
    expect(shown.getByRole('heading', { level: 2, name: 'Запланированная задача создана' }))
    const link = await shown.findByRole('link', { name: 'Сводка курсов' })
    expect(link.getAttribute('href')).toBe(`/scheduled/${SCHEDULE_ID}`)
    expect(shown.getByText('По будням в 8:00')).toBeTruthy()
    expect(shown.getByText('Следующий запуск: завтра в 8:00')).toBeTruthy()
    expect(shown.getByText('Размышление: низкое · Уведомит, когда выполнится')).toBeTruthy()
    // Short instructions stand in the card as written.
    expect(
      shown.getByText('Пришли курс доллара, евро и юаня по ЦБ и насколько он изменился со вчера.'),
    ).toBeTruthy()
    expect(shown.queryByRole('button', { name: 'Показать инструкцию' })).toBeNull()
  })

  it('folds long instructions under «Показать инструкцию»', async () => {
    const instructions = `${'Проверьте главную, каталог и контакты. '.repeat(6)}\nФормы не отправляйте.`
    expect(instructions.length).toBeGreaterThan(SHORT_INSTRUCTIONS)
    show(<FeedScheduleChange row={scheduleChangeRow('1', { instructions })} now={now} />)
    const shown = within(await card())
    const toggle = shown.getByRole('button', { name: 'Показать инструкцию' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(shown.queryByText(/Формы не отправляйте/)).toBeNull()
    fireEvent.click(toggle)
    const hide = shown.getByRole('button', { name: 'Скрыть инструкцию' })
    expect(hide.getAttribute('aria-expanded')).toBe('true')
    const words = shown.getByText(/Формы не отправляйте/)
    expect(words.textContent).toBe(instructions)
    expect(hide.getAttribute('aria-controls')).toBe(words.id)
  })

  it('names the level and a task that does not notify', async () => {
    list.mockResolvedValue({
      schedules: [task({ effort: 'max', notify: false })],
      timezone: 'Europe/Moscow',
    })
    show(
      <FeedScheduleChange
        row={scheduleChangeRow('1', { effort: 'max', notify: false })}
        now={now}
      />,
    )
    const shown = within(await card())
    expect(
      await shown.findByText('Размышление: максимальное · Без уведомления о выполнении'),
    ).toBeTruthy()
  })

  it('tells the next run as the task has it now, or why it does not run', async () => {
    list.mockResolvedValue({
      schedules: [task({ nextRunAt: new Date('2026-11-17T05:00:00.000Z') })],
      timezone: 'Europe/Moscow',
    })
    const { unmount } = show(<FeedScheduleChange row={scheduleChangeRow('1')} now={now} />)
    expect(await screen.findByText('Следующий запуск: вторник, 17 ноября, в 8:00')).toBeTruthy()
    unmount()

    list.mockResolvedValue({
      schedules: [task({ enabled: false, nextRunAt: null })],
      timezone: 'Europe/Moscow',
    })
    const paused = show(<FeedScheduleChange row={scheduleChangeRow('2')} now={now} />)
    expect(await screen.findByText('На паузе')).toBeTruthy()
    paused.unmount()

    list.mockResolvedValue({
      schedules: [task({ enabled: false, nextRunAt: null, pausedReason: 'refused' })],
      timezone: 'Europe/Moscow',
    })
    show(<FeedScheduleChange row={scheduleChangeRow('3')} now={now} />)
    expect(await screen.findByText('Остановлена после трёх отказов подряд')).toBeTruthy()
  })

  it('keeps the words of the row for a task that is not the client’s to open, asking once more first', async () => {
    list.mockResolvedValue({ schedules: [], timezone: 'Europe/Moscow' })
    show(<FeedScheduleChange row={scheduleChangeRow('1')} now={now} />)
    const shown = within(await card())
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(shown.queryByRole('link')).toBeNull()
    expect(shown.getByText('Сводка курсов')).toBeTruthy()
    expect(shown.getByText('Следующий запуск: завтра в 8:00')).toBeTruthy()
    expect(
      shown.queryByRole('button', { name: 'Запустить сейчас задачу «Сводка курсов»' }),
    ).toBeNull()
    expect(shown.getByText('Размышление: низкое · Уведомит, когда выполнится')).toBeTruthy()
  })

  it('says nothing of a next run the row named that has passed', async () => {
    list.mockResolvedValue({ schedules: [], timezone: 'Europe/Moscow' })
    show(
      <FeedScheduleChange
        row={scheduleChangeRow('1', { nextRunAt: '2026-11-13T05:00:00.000Z' })}
        now={now}
      />,
    )
    const shown = within(await card())
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(shown.queryByText(/Следующий запуск/)).toBeNull()
  })

  it('opens the task, and names each of its buttons by it (Зп35)', async () => {
    show(<FeedScheduleChange row={scheduleChangeRow('1')} now={now} onEdit={vi.fn()} />)
    const shown = within(await card())
    const open = await shown.findByRole('link', { name: 'Открыть задачу «Сводка курсов»' })
    expect(open.getAttribute('href')).toBe(`/scheduled/${SCHEDULE_ID}`)
    expect(open.textContent).toBe('Открыть задачу')
    // The words shown stand first in the name: «Изменить» of the last message is another one.
    expect(shown.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(
      ['Изменить задачу «Сводка курсов»', 'Запустить сейчас задачу «Сводка курсов»'],
    )
    expect(shown.getByRole('button', { name: /^Изменить задачу/ }).textContent).toBe('Изменить')
  })

  it('runs the task now and opens the chat of the run', async () => {
    runNow.mockResolvedValue({ taskId: RUN_CHAT_ID })
    show(<FeedScheduleChange row={scheduleChangeRow('1')} now={now} />)
    const shown = within(await card())
    fireEvent.click(
      await shown.findByRole('button', { name: 'Запустить сейчас задачу «Сводка курсов»' }),
    )
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/chats/${RUN_CHAT_ID}`))
    expect(runNow).toHaveBeenCalledWith({ scheduleId: SCHEDULE_ID }, expect.anything())
  })

  it('opens the window of the task with what the list has of it now', async () => {
    const onEdit = vi.fn()
    show(<FeedScheduleChange row={scheduleChangeRow('1')} now={now} onEdit={onEdit} />)
    const shown = within(await card())
    fireEvent.click(await shown.findByRole('button', { name: 'Изменить задачу «Сводка курсов»' }))
    expect(onEdit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: SCHEDULE_ID, name: 'Сводка курсов' }),
    )
  })

  it('offers no window where the chat has none to open', async () => {
    show(<FeedScheduleChange row={scheduleChangeRow('1')} now={now} />)
    const shown = within(await card())
    await shown.findByRole('button', { name: 'Запустить сейчас задачу «Сводка курсов»' })
    expect(shown.queryByRole('button', { name: 'Изменить задачу «Сводка курсов»' })).toBeNull()
  })

  it('tells why the task did not start, in the server’s words, and stays', async () => {
    runNow.mockRejectedValue(serverRefusal('Задача уже выполняется', 'SCHEDULE_RUN_BUSY'))
    show(<FeedScheduleChange row={scheduleChangeRow('1')} now={now} />)
    const shown = within(await card())
    fireEvent.click(
      await shown.findByRole('button', { name: 'Запустить сейчас задачу «Сводка курсов»' }),
    )
    expect((await shown.findByRole('alert')).textContent).toBe('Задача уже выполняется.')
    expect(push).not.toHaveBeenCalled()
  })

  it('offers notifications in this browser on the card that carries them, while they are off', async () => {
    pushState('off')
    const { unmount } = show(<FeedScheduleChange row={scheduleChangeRow('1')} now={now} push />)
    const shown = within(await card())
    expect(shown.getByRole('button', { name: browserPushText.enable })).toBeTruthy()
    unmount()

    show(<FeedScheduleChange row={scheduleChangeRow('2')} now={now} />)
    expect(within(await card()).queryByRole('button', { name: browserPushText.enable })).toBeNull()
  })

  it('says why notifications cannot come here, and nothing once they are on', async () => {
    pushState('denied')
    const { unmount } = show(<FeedScheduleChange row={scheduleChangeRow('1')} now={now} push />)
    expect(within(await card()).getByText(browserPushText.denied)).toBeTruthy()
    unmount()

    pushState('on')
    show(<FeedScheduleChange row={scheduleChangeRow('2')} now={now} push />)
    const shown = within(await card())
    expect(shown.queryByText(browserPushText.denied)).toBeNull()
    expect(shown.queryByRole('button', { name: browserPushText.enable })).toBeNull()
  })

  it('is one line for a deleted task, which it does not look for', () => {
    show(
      <FeedScheduleChange
        row={scheduleChangeRow('1', { action: 'deleted', nextRunAt: null })}
        now={now}
        push
      />,
    )
    expect(screen.getByText('Запланированная задача удалена: «Сводка курсов»')).toBeTruthy()
    expect(screen.queryByRole('article')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(list).not.toHaveBeenCalled()
  })

  it('titles each change of a task', async () => {
    for (const [action, title] of [
      ['updated', 'Запланированная задача изменена'],
      ['paused', 'Запланированная задача приостановлена'],
      ['resumed', 'Запланированная задача возобновлена'],
    ] as const) {
      const { unmount } = show(
        <FeedScheduleChange row={scheduleChangeRow('1', { action })} now={now} />,
      )
      expect(within(await card()).getByRole('heading', { level: 2, name: title })).toBeTruthy()
      unmount()
    }
  })

  it('says the schedule without words when the row has none this code reads', async () => {
    show(<FeedScheduleChange row={scheduleChangeRow('1', { triggers: null })} now={now} />)
    const shown = within(await card())
    expect(shown.queryByText(/По будням/)).toBeNull()
    expect(await shown.findByRole('link', { name: 'Сводка курсов' })).toBeTruthy()
  })
})

describe('a change of a task that did not come true (Зп35)', () => {
  it('opens the window of a new task to set it up by hand', () => {
    const onSetUp = vi.fn()
    show(<FeedScheduleLeft row={scheduleLeftRow('1', { reason: 'failed' })} onSetUp={onSetUp} />)
    expect(screen.getByText('Задачу не удалось сохранить: ответ агента оборвался.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Настроить вручную' }))
    expect(onSetUp).toHaveBeenCalledOnce()
  })

  it('tells a place of a template left unfilled in the words of the domain (Зп59)', () => {
    show(
      <FeedScheduleLeft row={scheduleLeftRow('1', { reason: 'placeholder' })} onSetUp={vi.fn()} />,
    )
    expect(
      screen.getByText(
        'Задачу не удалось сохранить: в инструкции остался текст в квадратных скобках.',
      ),
    ).toBeTruthy()
  })

  it('tells why and leads to «Расписание» where the chat has no window to open', () => {
    show(<FeedScheduleLeft row={scheduleLeftRow('1')} />)
    expect(
      screen.getByText('Задачу не удалось сохранить: включено 20 задач — больше нельзя.'),
    ).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Настроить вручную' }).getAttribute('href')).toBe(
      '/scheduled',
    )
  })
})

describe('the card that offers notifications (Зп36)', () => {
  it('is the newest card of a task that stays', () => {
    const rows: FeedRow[] = [
      scheduleChangeRow('1'),
      scheduleChangeRow('2', { action: 'updated' }),
      scheduleChangeRow('3', { action: 'deleted', nextRunAt: null }),
      scheduleLeftRow('4'),
    ]
    expect(schedulePushRowId(rows)).toBe('2')
    expect(schedulePushRowId([scheduleLeftRow('5')])).toBeNull()
  })
})
