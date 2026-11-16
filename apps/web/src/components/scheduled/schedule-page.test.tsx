// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ScheduleDetail } from './schedule-model'
import { SchedulePage } from './schedule-page'
import {
  CHAT_ID,
  mediaStyleOf,
  NOW,
  PHONE_MEDIA,
  phoneMatchMedia,
  scheduleDetail,
  scheduleRun,
  SCHEDULE_ID,
  WIDE_MEDIA,
} from './testing'

const { getSchedule, costHint, runNow, remove, push } = vi.hoisted(() => ({
  getSchedule: vi.fn<() => Promise<ScheduleDetail>>(),
  costHint: vi.fn(async () => ({
    averageCredits: 11,
    runsPerWeek: 5,
    creditsPerWeek: 55,
    weeklyLimit: 210,
    overHalf: false,
    nextRunAt: null,
  })),
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
      costHint: query('schedule.costHint', costHint),
      setEnabled: mutation(async () => null),
      runNow: mutation(runNow),
      delete: mutation(remove),
      create: mutation(async () => null),
      update: mutation(async () => null),
    },
  }),
}))

function show() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SchedulePage scheduleId={SCHEDULE_ID} userId="user-1" />
    </QueryClientProvider>,
  )
  return { queryClient, unmount: view.unmount }
}

const GET_KEY = ['schedule.get', { scheduleId: SCHEDULE_ID }]

const goneError = () =>
  Object.assign(new Error('Задачи уже нет'), {
    data: { code: 'NOT_FOUND', domainCode: 'SCHEDULE_NOT_FOUND' },
  })

const hourly = [{ kind: 'hourly' as const, minute: 0 }]
const missed = (id: string, iso: string, missedCount: number, until: string | null = null) =>
  scheduleRun({
    id,
    dueAt: new Date(iso),
    state: {
      kind: 'skipped',
      reason: 'missed',
      missedCount,
      missedUntil: until === null ? null : new Date(until),
    },
    chat: null,
    startedAt: null,
  })

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
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
    expect(
      within(facts)
        .getAllByRole('term')
        .map((term) => term.textContent),
    ).toEqual(['Инструкция', 'Когда запускается', 'Размышление', 'Уведомления', 'Стоимость'])
    expect(facts).toHaveTextContent('Откройте сайт и пройдите главную и важные страницы.')
    expect(facts).toHaveTextContent('По будням в 9:00')
    expect(facts).toHaveTextContent('Низкое')
    expect(facts).toHaveTextContent('Сообщим, когда задача выполнится')
    expect(
      await within(facts).findByText(/в среднем около 11\. Так выйдет примерно 55 в неделю/),
    ).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Включить задачу «Проверка сайта»' })).toBeChecked()
    expect(screen.getByText('Задача ещё не запускалась.')).toBeInTheDocument()
  })

  it('labels its switch with what it is set to, beside the state of the task', async () => {
    getSchedule.mockResolvedValue(scheduleDetail())
    show()
    const toggle = await screen.findByRole('switch', { name: 'Включить задачу «Проверка сайта»' })
    // The words shown are the label of the switch: a press on them turns it.
    const label = toggle.closest('label')
    expect(label).toHaveTextContent('Включена')
    const state = screen.getByText('Следующий запуск: завтра в 9:00')
    expect(state.parentElement).toBe(label?.parentElement)
    // Not among the buttons of the actions any more.
    expect(
      screen.getByRole('button', { name: 'Запустить сейчас' }).parentElement,
    ).not.toContainElement(toggle)
  })

  it('says «На паузе» once for a paused task, and «Выключена» beside a reason', async () => {
    getSchedule.mockResolvedValue(scheduleDetail({ enabled: false, nextRunAt: null }))
    const { unmount } = show()
    await screen.findByRole('heading', { level: 1, name: 'Проверка сайта' })
    expect(screen.getAllByText('На паузе')).toHaveLength(1)
    expect(screen.getByText('На паузе').closest('label')).toContainElement(
      screen.getByRole('switch'),
    )
    unmount()

    getSchedule.mockResolvedValue(
      scheduleDetail({
        enabled: false,
        nextRunAt: null,
        pausedReason: 'completed',
        lastRunAt: new Date('2026-11-14T09:00:00.000Z'),
      }),
    )
    show()
    expect(await screen.findByText('Завершена 14 ноября')).toBeInTheDocument()
    expect(screen.getByText('Выключена').closest('label')).toContainElement(
      screen.getByRole('switch'),
    )
    expect(screen.queryByText('На паузе')).toBeNull()
  })

  it('has «Изменить» in «⋯» on a phone, where «Запустить сейчас» takes the line', async () => {
    vi.stubGlobal('matchMedia', phoneMatchMedia)
    getSchedule.mockResolvedValue(scheduleDetail())
    show()
    await screen.findByRole('heading', { level: 1, name: 'Проверка сайта' })
    // The button of the wide screen is out of sight on a phone from the first paint.
    const edit = screen.getByRole('button', { name: 'Изменить' })
    expect(mediaStyleOf(edit, PHONE_MEDIA)).toContain('display:none')
    expect(
      mediaStyleOf(screen.getByRole('button', { name: 'Запустить сейчас' }), PHONE_MEDIA),
    ).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Ещё действия' }))
    const menu = screen.getByRole('menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Изменить', 'Удалить'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Изменить' }))
    expect(await screen.findByRole('dialog', { name: 'Изменить задачу' })).toBeInTheDocument()
  })

  it('keeps «⋯» to «Удалить» on a wide screen, with «Изменить» beside it', async () => {
    getSchedule.mockResolvedValue(scheduleDetail())
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Ещё действия' }))
    expect(
      within(screen.getByRole('menu'))
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Удалить'])
  })

  it('says the cost as a value of the page, not as a hint', async () => {
    getSchedule.mockResolvedValue(scheduleDetail())
    show()
    const cost = await screen.findByText(/в среднем около 11\. Так выйдет примерно 55 в неделю/)
    expect(cost.closest('[data-cost-tone]')).toHaveAttribute('data-cost-tone', 'value')
    // As the other values of the facts: 15 px.
    expect(getComputedStyle(cost).fontSize).toBe('15px')
  })

  it('lists the runs: when, how, what came of it, its chat; missed in a row as one line', async () => {
    getSchedule.mockResolvedValue(
      scheduleDetail({ triggers: hourly }, [
        scheduleRun({ id: 'a', dueAt: new Date('2026-11-15T08:00:00.000Z'), trigger: 'manual' }),
        missed('b', '2026-11-15T05:00:00.000Z', 3, '2026-11-15T07:00:00.000Z'),
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
    // The end the tick kept with the row, by the clock of the task (Moscow).
    expect(lines[1]).toHaveTextContent('Пропущены запуски с 8:00 по 10:00')
    expect(lines[2]).toHaveTextContent('Чат удалён')
    expect(within(lines[2]!).queryByRole('link')).toBeNull()
    // Five runs are all there are: no word of the last fifty.
    expect(screen.queryByText('Последние 50 запусков.')).toBeNull()
  })

  it('draws the runs in the columns of the list: the date on one line, a line of its own on a phone', async () => {
    getSchedule.mockResolvedValue(
      scheduleDetail({ triggers: hourly }, [
        scheduleRun({ id: 'a', dueAt: new Date('2026-11-09T11:20:00.000Z'), trigger: 'manual' }),
      ]),
    )
    show()
    const runs = await screen.findByRole('list', { name: 'Запуски' })
    const [line] = within(runs).getAllByRole('listitem')
    if (line === undefined) throw new Error('no line')
    // From `md` every line is a row of the columns of the list, the date as wide as the longest.
    expect(mediaStyleOf(runs, WIDE_MEDIA)).toContain(
      'grid-template-columns:max-content max-content minmax(0, 1fr) auto',
    )
    expect(mediaStyleOf(line, WIDE_MEDIA)).toContain('grid-template-columns:subgrid')
    const when = line.querySelector('[data-run-when]')
    if (!(when instanceof HTMLElement)) throw new Error('no date')
    expect(when).toHaveTextContent('понедельник, 9 ноября, в 14:20 · вручную')
    // «·» stays after the time when the line wraps: never at the start of the next one.
    expect(when.textContent).toContain('14:20\u00a0· вручную')
    expect(mediaStyleOf(when, WIDE_MEDIA)).toContain('white-space:nowrap')
    // On a phone the date takes the whole first line; what came of it and the chat — under it.
    // MUI writes the values of `xs` under `(min-width:0px)`.
    expect(mediaStyleOf(when, '(min-width:0px)')).toMatch(/grid-column:1 ?\/ ?-1/)
    const link = within(line).getByRole('link', { name: /^Открыть чат запуска/ })
    expect(when.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // A state that wraps keeps its sign at the first line.
    const sign = line.querySelector('[data-run-sign]')
    if (!(sign instanceof HTMLElement) || sign.parentElement === null) throw new Error('no sign')
    expect(getComputedStyle(sign.parentElement).alignItems).toBe('flex-start')
    expect(getComputedStyle(sign).height).not.toBe('')
  })

  it('keeps «по расписанию» whole when the line of a run wraps on a phone', async () => {
    getSchedule.mockResolvedValue(
      scheduleDetail({ triggers: hourly }, [
        scheduleRun({ id: 'a', dueAt: new Date('2026-11-13T05:00:00.000Z') }),
      ]),
    )
    show()
    const runs = await screen.findByRole('list', { name: 'Запуски' })
    const when = runs.querySelector('[data-run-when]')
    expect(when?.textContent).toBe('пятница, 13 ноября, в 8:00\u00a0· по\u00a0расписанию')
  })

  it('says «Последние 50 запусков» when the page shows as many as it keeps', async () => {
    const fifty = Array.from({ length: 50 }, (_, index) =>
      scheduleRun({
        id: `run-${index}`,
        dueAt: new Date(Date.UTC(2026, 10, 15, 8) - index * 3_600_000),
      }),
    )
    getSchedule.mockResolvedValue(scheduleDetail({ triggers: hourly }, fifty))
    show()
    expect(await screen.findByText('Последние 50 запусков.')).toBeInTheDocument()
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

  // F30: the page stays as it was until it is left, and «Ваши» says «Задача удалена».
  it('keeps the page until it is left, and leaves the notice to «Ваши»', async () => {
    getSchedule.mockResolvedValue(scheduleDetail())
    const { queryClient, unmount } = show()
    fireEvent.click(await screen.findByRole('button', { name: 'Ещё действия' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Удалить' }))
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Удалить задачу «Проверка сайта»?' })).getByRole(
        'button',
        { name: 'Удалить' },
      ),
    )
    await waitFor(() => expect(push).toHaveBeenCalledWith('/scheduled'))
    expect(sessionStorage.getItem('raditi-schedule-notice')).toBe('deleted')
    // Not read again under its eyes: no frame, no «Задачи уже нет».
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('heading', { level: 1, name: 'Проверка сайта' })).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Загрузка задачи' })).toBeNull()
    expect(getSchedule).toHaveBeenCalledOnce()
    expect(queryClient.getQueryData(GET_KEY)).toBeDefined()
    unmount()
    // Left: a way back to the address does not show the deleted task as it was.
    expect(queryClient.getQueryCache().find({ queryKey: GET_KEY })).toBeUndefined()
  })

  // F11: a failed reading of a task already shown keeps the window and what was typed in it.
  it('keeps the page and the open window when reading the task again fails', async () => {
    getSchedule.mockResolvedValue(scheduleDetail())
    const { queryClient } = show()
    fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }))
    const dialog = await screen.findByRole('dialog', { name: 'Изменить задачу' })
    const field = within(dialog).getByRole('textbox', { name: 'Что сделать агенту' })
    fireEvent.change(field, { target: { value: 'Проверьте ещё и корзину' } })

    getSchedule.mockRejectedValueOnce(new Error('offline'))
    await act(() => queryClient.refetchQueries({ queryKey: GET_KEY }))
    expect(
      await screen.findByText(
        'Не удалось обновить задачу — на странице то, что было известно раньше.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Изменить задачу' })).toBe(dialog)
    expect(field).toHaveValue('Проверьте ещё и корзину')
    expect(screen.queryByText('Не удалось загрузить задачу. Попробуйте ещё раз.')).toBeNull()

    // Gone meanwhile: the window stays over the page; closed, the page says so.
    getSchedule.mockRejectedValueOnce(goneError())
    await act(() => queryClient.refetchQueries({ queryKey: GET_KEY }))
    expect(field).toHaveValue('Проверьте ещё и корзину')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))
    expect(await screen.findByRole('heading', { name: 'Задачи уже нет.' })).toBeInTheDocument()
  })

  it('says a task that is gone is gone', async () => {
    getSchedule.mockRejectedValue(goneError())
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
