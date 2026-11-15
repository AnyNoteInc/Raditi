// @vitest-environment jsdom
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
  type UseMutationOptions,
} from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { plain, serverRefusal } from '@/components/billing/testing'

import type * as Upload from './attachment-upload'
import { composerText } from './chat-texts'
import type { DialogFeed, FeedRow, TurnActivityPage } from './chat-types'
import { DialogView } from './dialog-view'
import { forgetNewDialog, isNewDialog, markNewDialog } from './new-dialog-hint'
import {
  browserAnswer,
  browserQuestionRow,
  ceilingRow,
  commandRow,
  feedAnswer,
  type FeedBrowserHead,
  requestRow,
  resultRow,
  SESSION_ID,
  stepRow,
  TASK_ID,
  verdicts,
} from './testing'

type Press = { taskId: string; requestId: string }
type Posted = { requestEventId: string; repeated: boolean }

const calls = vi.hoisted(() => ({
  feed: vi.fn<(input: { taskId: string; after: string }) => Promise<DialogFeed>>(),
  activity: vi.fn<(input: { after: string }) => Promise<TurnActivityPage>>(),
  message: vi.fn<(input: Press & { text: string }) => Promise<Posted>>(),
  // The queue of the chat (docs/plan/75, ВВ1): empty unless a test fills it.
  queueAdd:
    vi.fn<(input: Press & { text: string }) => Promise<{ id: string | null; repeated: boolean }>>(),
  queueList: vi.fn(async (_input: { taskId: string }) => ({
    items: [] as {
      id: string
      requestId: string
      text: string
      attachments: string[]
      createdAt: Date
    }[],
  })),
  queueSendNow: vi.fn(async (_input: Press) => ({ requestEventId: '99' as string | null })),
  proceed: vi.fn<(input: Press) => Promise<Posted>>(),
  retry: vi.fn<(input: Press & { failureEventId: string }) => Promise<Posted>>(),
  cancel: vi.fn<(input: Press) => Promise<Posted & { state: 'cancelled' | 'stopping' }>>(),
  reset: vi.fn<(input: Press) => Promise<{ requestEventId: string | null; repeated: boolean }>>(),
  update: vi.fn<(input: Press) => Promise<Posted>>(),
  prepare: vi.fn<(input: { taskId: string }) => Promise<unknown>>(),
  candidate: vi.fn<(input: { taskId: string; revision?: number }) => Promise<unknown>>(),
  undoPrepare:
    vi.fn<(input: { taskId: string; releaseId: string }) => Promise<{ planId: string }>>(),
  resumeAgent: vi.fn<(input: Press) => Promise<Posted>>(),
  init: vi.fn<(input: Press) => Promise<Posted>>(),
  compact: vi.fn<(input: Press) => Promise<Posted>>(),
  undoTurn: vi.fn<(input: Press) => Promise<Posted & { words: string | null }>>(),
  redoTurn: vi.fn<(input: Press) => Promise<Posted & { words: string | null }>>(),
  agentNotes:
    vi.fn<(input: { id: string }) => Promise<{ notes: string | null; canManage: boolean }>>(),
  setAgentNotes:
    vi.fn<(input: { id: string; notes: string }) => Promise<{ notes: string | null }>>(),
  attachments: vi.fn(async (_input: { taskId: string }) => [] as unknown[]),
  setEffort: vi.fn<(input: { taskId: string; effort: string }) => Promise<{ effort: string }>>(),
  rename: vi.fn<(input: { taskId: string; title: string }) => Promise<{ title: string }>>(),
  remove: vi.fn<(input: { taskId: string }) => Promise<{ removed: true }>>(),
  replace: vi.fn<(href: string) => void>(),
  push: vi.fn<(href: string) => void>(),
  setPreference: vi.fn<(preference: string) => void>(),
  exported: vi.fn<(input: { taskId: string }) => Promise<{ fileName: string; markdown: string }>>(),
  ticket:
    vi.fn<(input: { taskId: string; to?: string }) => Promise<{ url: string; expiresAt: Date }>>(),
  streamTicket:
    vi.fn<
      (input: { taskId: string }) => Promise<{ url: string; ticket: string; sessionId: string }>
    >(),
  watch: vi.fn(async (_input: { taskId: string }) => ({ watched: true })),
}))

vi.mock('@repo/ui/providers', () => ({
  useThemePreference: () => ({ preference: 'system', setPreference: calls.setPreference }),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: calls.replace, push: calls.push }),
  usePathname: () => `/chats/${TASK_ID}`,
}))

const mutation = <I, O>(fn: (input: I) => Promise<O>) => ({
  mutationOptions: (options?: UseMutationOptions<O, Error, I>) => ({ ...options, mutationFn: fn }),
})
const query = <I, O>(path: string, fn: (input: I) => Promise<O>) => ({
  queryOptions: (input: I) => ({ queryKey: [path, input] as QueryKey, queryFn: () => fn(input) }),
  queryKey: (input?: I) => (input === undefined ? [path] : [path, input]) as QueryKey,
})

// The bytes of a chosen file reach the server at once: the upload itself is the composer's test.
vi.mock('./attachment-upload', async (original) => ({
  ...(await original<typeof Upload>()),
  uploadBytes: vi.fn(async (path: string) => ({ attachmentId: path.split('/').at(-1)!, size: 16 })),
}))

// One client for the whole run, as the provider of the app gives it: the stream of the browser
// starts again whenever its client changes.
const client = vi.hoisted(() => ({
  task: {
    feed: { query: calls.feed },
    activity: { query: calls.activity },
  },
  preview: { ticket: { mutate: calls.ticket } },
  release: {
    prepare: { query: calls.prepare },
    undoPrepare: { mutate: calls.undoPrepare },
    undoPlan: { query: async () => ({ state: 'pending' }) },
  },
  browser: { streamTicket: { mutate: calls.streamTicket } },
  attachment: {
    start: {
      mutate: vi.fn(async () => ({
        attachmentId: '0199a3f2-0000-7000-8000-0000000000f1',
        uploadPath: '/api/attachments/0199a3f2-0000-7000-8000-0000000000f1',
      })),
    },
    remove: { mutate: vi.fn() },
  },
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    task: {
      message: mutation(calls.message),
      queueAdd: mutation(calls.queueAdd),
      queueList: query('task.queueList', calls.queueList),
      queueEdit: mutation(async (input: { text: string }) => ({ text: input.text })),
      queueRemove: mutation(async () => ({ removed: true as const })),
      queueSendNow: mutation(calls.queueSendNow),
      continue: mutation(calls.proceed),
      retry: mutation(calls.retry),
      cancel: mutation(calls.cancel),
      resumeAgent: mutation(calls.resumeAgent),
      init: mutation(calls.init),
      compact: mutation(calls.compact),
      undoTurn: mutation(calls.undoTurn),
      redoTurn: mutation(calls.redoTurn),
      setEffort: mutation(calls.setEffort),
      rename: mutation(calls.rename),
      remove: mutation(calls.remove),
      export: query('task.export', calls.exported),
    },
    project: {
      agentNotes: query('project.agentNotes', calls.agentNotes),
      setAgentNotes: mutation(calls.setAgentNotes),
    },
    attachment: { list: query('attachment.list', calls.attachments) },
    preview: { reset: mutation(calls.reset) },
    candidate: {
      update: mutation(calls.update),
      get: query('candidate.get', calls.candidate),
    },
    release: {
      confirm: mutation(async () => ({})),
      undoConfirm: mutation(async () => ({})),
    },
    browser: { watch: mutation(calls.watch) },
    billing: { usage: query('billing.usage', async () => null) },
    // «Опубликовать как страницу» (docs/plan/69-pages.md, Ст32): not offered in these tests.
    pages: {
      canPublish: query('pages.canPublish', async () => false),
      targets: query('pages.targets', async () => []),
      publishFile: mutation(async () => ({ pageId: '', url: '', version: 1 })),
      list: query('pages.list', async () => ({ enabled: false, pages: [] })),
    },
    // «Терминал» of the chat (06.11.2026): its files are read while it is open.
    siteFiles: {
      list: query('siteFiles.list', async () => ({ state: 'preparing' as const })),
      read: query('siteFiles.read', async () => ({ state: 'preparing' as const })),
      editState: query('siteFiles.editState', async () => ({ state: 'pending' as const })),
      save: mutation(async () => ({ editId: '0199a3f2-0000-7000-8000-0000000000e1' })),
    },
  }),
  useTRPCClient: () => client,
}))

/** A chat that waits for the next words: the request and the answer of its first turn. */
const waiting = (patch: Parameters<typeof feedAnswer>[0] = {}) =>
  feedAnswer({
    status: 'awaiting_user',
    task: { turnNo: 1 },
    events: [requestRow('1'), resultRow('2', 1)],
    cursor: '2',
    ...patch,
  })

const posted: Posted = { requestEventId: '9', repeated: false }

function showDialog(answer: DialogFeed = waiting(), browserStreamUrl: string | null = null) {
  calls.feed.mockResolvedValue(answer)
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <DialogView
        taskId={TASK_ID}
        title="Поменять цену капучино"
        browserStreamUrl={browserStreamUrl}
      />
    </QueryClientProvider>,
  )
}

const field = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Сообщение' })
const type = (text: string) => fireEvent.change(field(), { target: { value: text } })
const option = (name: RegExp) =>
  within(screen.getByRole('listbox', { name: 'Команды' })).getByRole('option', { name })
/** Opens the window of commands by `/` and chooses one. */
async function run(name: RegExp) {
  await screen.findByRole('heading', { level: 1, name: 'Поменять цену капучино' })
  await waitFor(() => expect(field().disabled).toBe(false))
  type('/')
  fireEvent.click(option(name))
}

/** Where the cabinet opens the stream of a task's browser, as the page passes it to the dialog. */
const STREAM_URL = 'ws://127.0.0.1:1/v1/browser/stream'
const PREVIEW_ORIGIN = 'http://site-0a1b2c3d-chat-4e5f6a.localhost:8090'
const TOOLS = 'Инструменты чата'

/** The panel of the tools beside the dialog, when it is drawn. */
const toolsPanel = () => screen.queryByRole('complementary', { name: TOOLS })
const pane = () => screen.getByRole('complementary', { name: TOOLS })
/** «+»: one on the screen, in the head or at the end of the tabs; its dot is said after its name. */
const plus = () => screen.getByRole('button', { name: /^Инструменты/ })
/** The name of «+» says whether it bears the dot (И13). */
const plusName = () => plus().getAttribute('aria-label')
/** The words «+» said for a launched browser before the owner's answer of 30.10.2026: never now. */
const LAUNCH_DOT = 'Инструменты — браузер запущен'
const tabNames = () =>
  within(screen.getByRole('tablist', { name: 'Открытые инструменты' }))
    .getAllByRole('tab')
    .map((tab) => plain(tab.textContent))

/** The tiles of the menu «+», read and closed again by Esc. */
async function menuTiles(): Promise<string[]> {
  fireEvent.click(plus())
  const menu = await screen.findByRole('menu', { name: 'Инструменты' })
  const names = within(menu)
    .getAllByRole('menuitem')
    .map((item) => plain(item.textContent))
  fireEvent.keyDown(menu, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  return names
}

/** Chooses a tool in the menu of «+». */
async function choose(name: RegExp) {
  fireEvent.click(plus())
  const menu = await screen.findByRole('menu', { name: 'Инструменты' })
  fireEvent.click(within(menu).getByRole('menuitem', { name }))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
}

/** From `lg` the panel stands at the right edge: every media query of the layout matches. */
function wideLayout() {
  vi.stubGlobal(
    'matchMedia',
    (query: string): MediaQueryList =>
      ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  )
}

/** The page goes out of sight, or comes back, as a tab of the browser does. */
function showPage(shown: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (shown ? 'visible' : 'hidden'),
  })
  act(() => void document.dispatchEvent(new Event('visibilitychange')))
}

/**
 * The sockets the stream of the browser opened, in order. None of them opens by itself: a test
 * that needs the gateway to answer says so (`connect`).
 */
const sockets: FakeSocket[] = []
class FakeSocket {
  binaryType = 'blob'
  sent: unknown[] = []
  closed = false
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readonly url: string
  constructor(url: string) {
    this.url = url
    sockets.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as unknown)
  }
  close() {
    this.closed = true
  }
}

const VIEWER = '0199a3f2-0000-7000-8000-0000000000aa'
/** The gateway answers a socket: this tab is `VIEWER`, the browser driven by the agent or by it. */
function connect(socket: FakeSocket, controller: 'agent' | 'user') {
  act(() => {
    socket.onopen?.({})
    socket.onmessage?.({ data: JSON.stringify({ t: 'viewer', viewer: VIEWER }) })
    socket.onmessage?.({ data: JSON.stringify(streamState(controller)) })
  })
}
const streamState = (controller: 'agent' | 'user') => ({
  t: 'state',
  session: SESSION_ID,
  status: 'ready',
  controller,
  controlEpoch: 1,
  manualReady: controller === 'user',
  holder: controller === 'user' ? VIEWER : null,
  pageId: 1,
  viewportVersion: 1,
  viewport: { width: 1280, height: 800 },
  url: 'https://kroshka.example/wp-admin/edit.php',
  title: 'Записи',
  tabs: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  calls.activity.mockResolvedValue({ events: [], cursor: '0', more: false })
  calls.message.mockResolvedValue(posted)
  calls.proceed.mockResolvedValue(posted)
  calls.retry.mockResolvedValue(posted)
  calls.cancel.mockResolvedValue({ ...posted, state: 'cancelled' })
  calls.reset.mockResolvedValue(posted)
  calls.update.mockResolvedValue(posted)
  calls.prepare.mockReturnValue(new Promise(() => undefined))
  calls.candidate.mockResolvedValue(null)
  calls.resumeAgent.mockResolvedValue(posted)
  calls.ticket.mockImplementation(async () => ({
    url: `${PREVIEW_ORIGIN}/__raditi/enter?t=${'a'.repeat(43)}&to=%2F`,
    expiresAt: new Date(),
  }))
  calls.streamTicket.mockResolvedValue({ url: STREAM_URL, ticket: 't', sessionId: SESSION_ID })
  sockets.length = 0
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => {
  vi.unstubAllGlobals()
  // The page is shown again as jsdom has it, and no dialog is a new one any more.
  Reflect.deleteProperty(document, 'visibilityState')
  forgetNewDialog(TASK_ID)
})

const network = () => new TypeError('Failed to fetch')
const NETWORK_TEXT = 'Не удалось связаться с сервером. Проверьте подключение и попробуйте ещё раз.'

describe('a dialog', () => {
  // The page passes null from 61.12 on: nothing fails by itself then (docs/plan/61, К18).

  describe('the commands of the page (docs/plan/61-chats-first.md, §5.14)', () => {
    afterEach(() => {
      window.localStorage.clear()
      Reflect.deleteProperty(URL, 'createObjectURL')
      Reflect.deleteProperty(URL, 'revokeObjectURL')
    })

    /** `/models` from the button: a closed field takes no words, and it works there too. */
    const openedEfforts = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
      await screen.findByRole('listbox', { name: 'Команды' })
      fireEvent.click(option(/Модель и размышление/))
      return within(await screen.findByRole('menu', { name: 'Размышление' }))
    }

    it('`/new` starts a new chat', async () => {
      showDialog(waiting(), null)
      await run(/Новый чат/)
      expect(calls.push).toHaveBeenCalledWith('/chats/new')
    })

    // docs/plan/61-chats-first.md, К30, §5.14.
    describe('`/compact`', () => {
      it('asks the server to run it', async () => {
        calls.compact.mockResolvedValue(posted)
        showDialog()
        await run(/Сжать переписку/)
        await waitFor(() => expect(calls.compact).toHaveBeenCalledTimes(1))
        expect(calls.compact.mock.calls[0]![0].taskId).toBe(TASK_ID)
      })
    })

    // docs/plan/61-chats-first.md, К31.

    it('`/export` that fails says so under the field and saves nothing', async () => {
      Object.assign(URL, { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() })
      calls.exported.mockRejectedValue(serverRefusal('Чат не найден', 'NOT_FOUND'))
      showDialog()
      await run(/Скачать переписку/)
      expect((await screen.findByRole('alert')).textContent).toBe('Чат не найден.')
      expect(URL.createObjectURL).not.toHaveBeenCalled()
    })

    it('`/models` opens the menu of the level, which changes it as its button does', async () => {
      showDialog()
      await run(/Модель и размышление/)
      const efforts = within(await screen.findByRole('menu', { name: 'Размышление' }))
      fireEvent.click(efforts.getByRole('menuitemradio', { name: /Максимальное/ }))
      await waitFor(() => expect(calls.setEffort).toHaveBeenCalledTimes(1))
      expect(calls.setEffort.mock.calls[0]![0]).toEqual({ taskId: TASK_ID, effort: 'max' })
    })

    it('`/models` shows the level while the agent works, and says when it can be changed', async () => {
      showDialog(
        feedAnswer({
          status: 'running',
          task: { turnNo: 1 },
          events: [requestRow('1', 'Поменяйте цену')],
          cursor: '1',
        }),
      )
      await screen.findByText('Поменяйте цену')
      const efforts = await openedEfforts()
      expect(efforts.getByText('Уровень можно поменять, пока чат ждёт вас.')).toBeTruthy()
      const levels = efforts.getAllByRole('menuitemradio')
      expect(levels.map((level) => level.getAttribute('aria-disabled'))).toEqual([
        'true',
        'true',
        'true',
      ])
      fireEvent.click(efforts.getByRole('menuitemradio', { name: /Максимальное/ }))
      // The mutation would start on the next tick: nothing is left to run when this is read.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(calls.setEffort).not.toHaveBeenCalled()
    })

    it('`/themes` opens its menu over the field, which takes the choice', async () => {
      showDialog()
      await run(/Оформление/)
      const menu = within(await screen.findByRole('menu', { name: 'Оформление' }))
      fireEvent.click(menu.getByRole('menuitemradio', { name: 'Светлая' }))
      expect(calls.setPreference).toHaveBeenCalledWith('light')
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('`/details` opens «Ход работы» of finished turns, for the next visit too', async () => {
      const worked = waiting({
        events: [
          requestRow('1', 'Поменяйте цену'),
          { ...stepRow('2', 1), at: '2026-10-17T09:00:00.000Z' },
          { ...resultRow('3', 1), at: '2026-10-17T09:02:14.000Z' },
        ],
        cursor: '3',
      })
      showDialog(worked)
      await screen.findByText('Поменяйте цену')
      const line = () => screen.getByText(/Агент работал/).closest('details')!
      expect(line().open).toBe(false)
      await run(/Подробности работы/)
      await waitFor(() => expect(line().open).toBe(true))
      await screen.findByText('Подробности работы показаны')
      cleanup()
      showDialog(worked)
      await screen.findByText('Поменяйте цену')
      await waitFor(() => expect(line().open).toBe(true))
    })

    it('`/thinking` shows what the model thought, in a finished turn too, and hides it again', async () => {
      calls.activity.mockResolvedValue({
        events: [
          { id: '7:0', type: 'reasoning', text: 'Look at the prices first.' },
          { id: '7:1', type: 'command', command: 'ls', exitCode: 0 },
        ],
        cursor: '7',
        more: false,
      })
      window.localStorage.clear()
      showDialog(
        waiting({
          events: [
            requestRow('1', 'Поменяйте цену'),
            { ...stepRow('2', 1), at: '2026-10-17T09:00:00.000Z' },
            { ...resultRow('3', 1), at: '2026-10-17T09:02:14.000Z' },
          ],
          cursor: '3',
        }),
      )
      await screen.findByText('Поменяйте цену')
      const line = () => screen.getByText(/Агент работал/).closest('details')!
      expect(line().open).toBe(false)
      await run(/Размышления агента/)
      await screen.findByText('Размышления агента показаны')
      await waitFor(() => expect(line().open).toBe(true))
      await screen.findByText('Look at the prices first.')
      await run(/Размышления агента/)
      await screen.findByText('Размышления агента скрыты')
      await waitFor(() => expect(screen.queryByText('Look at the prices first.')).toBeNull())
      expect(line().open).toBe(false)
      window.localStorage.clear()
    })

    it('`/details` and `/thinking` together: each says what the page shows', async () => {
      calls.activity.mockResolvedValue({
        events: [
          { id: '7:0', type: 'reasoning', text: 'Look at the prices first.' },
          { id: '7:1', type: 'command', command: 'ls wp-content', exitCode: 0 },
        ],
        cursor: '7',
        more: false,
      })
      window.localStorage.clear()
      showDialog(
        waiting({
          events: [
            requestRow('1', 'Поменяйте цену'),
            { ...stepRow('2', 1), at: '2026-10-17T09:00:00.000Z' },
            { ...resultRow('3', 1), at: '2026-10-17T09:02:14.000Z' },
          ],
          cursor: '3',
        }),
      )
      await screen.findByText('Поменяйте цену')
      const line = () => screen.getByText(/Агент работал/).closest('details')!
      // `/details` alone: the line stands open, and what the model thought stays hidden.
      await run(/Подробности работы/)
      await waitFor(() => expect(line().open).toBe(true))
      await screen.findByText('ls wp-content')
      expect(screen.queryByText('Look at the prices first.')).toBeNull()
      // With `/thinking` on, `/details` off leaves the line open, and says so.
      await run(/Размышления агента/)
      await screen.findByText('Look at the prices first.')
      await run(/Подробности работы/)
      await screen.findByText('Строки работы останутся открытыми, пока показаны размышления агента')
      expect(screen.queryByText('Подробности работы скрыты')).toBeNull()
      expect(line().open).toBe(true)
      // `/thinking` off then closes it: no choice holds it any more.
      await run(/Размышления агента/)
      await waitFor(() => expect(line().open).toBe(false))
      window.localStorage.clear()
    })
  })

  it('asks before `/cancel` closes the dialog', async () => {
    showDialog()
    await run(/Отменить чат/)
    const confirm = screen.getByRole('dialog', { name: 'Отменить чат?' })
    expect(plain(confirm.textContent)).toContain(
      'Чат завершится, а агент остановится, если ещё работает.',
    )
    expect(calls.cancel).not.toHaveBeenCalled()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Отменить чат' }))
    await waitFor(() => expect(calls.cancel).toHaveBeenCalledTimes(1))
    expect(calls.cancel.mock.calls[0]![0]).toMatchObject({ taskId: TASK_ID })
  })

  it('keeps the field open after an answer of a pass that changed nothing (26.10.2026)', async () => {
    showDialog(
      feedAnswer({
        status: 'awaiting_user',
        task: { turnNo: 1 },
        events: [
          requestRow('1'),
          {
            ...resultRow('2', 1, 'Это сайт учебного комбината.'),
            next: 'awaiting_user',
            changeType: 'none',
            needsApproval: false,
          } as FeedRow,
        ],
        cursor: '2',
      }),
    )
    await screen.findByText('Это сайт учебного комбината.')
    expect(field().disabled).toBe(false)
    // Like a chat of Claude Code (owner's answer of 26.10.2026): an answer asks nothing — the
    // field is that of a new message, not of an answer, and the status is said as such.
    expect(field().getAttribute('placeholder')).toBe(composerText.newPlaceholder)
    expect(screen.getByRole('button', { name: composerText.send })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Ответить' })).toBeNull()
    expect(
      screen.getAllByRole('status').some((node) => node.textContent?.includes('Агент ответил')),
    ).toBe(true)
    expect(screen.queryByText('Нужен ваш ответ')).toBeNull()
  })

  it('keeps the field open after a failure and asks again, after an answer too (28.10.2026)', async () => {
    showDialog(
      feedAnswer({
        status: 'awaiting_user',
        task: { turnNo: 2 },
        events: [
          requestRow('1'),
          {
            ...resultRow('2', 1, 'Начинаю публикацию.'),
            next: 'awaiting_user',
            changeType: 'none',
            needsApproval: false,
          } as FeedRow,
          {
            id: '3',
            at: '2026-10-28T19:26:27.000Z',
            type: 'feed.failure',
            turn: 2,
            code: 'technical',
            site: 'check',
            credits: 'returned',
            next: 'awaiting_user',
          },
        ],
        cursor: '3',
      }),
    )
    await screen.findByText(/Чат не закрыт: напишите «продолжи»/)
    // The owner: «пользователь всегда должен иметь возможность ввести промпт».
    expect(field().disabled).toBe(false)
    // The dialog asks: the field is that of an answer to the failure.
    expect(field().getAttribute('placeholder')).toBe('Ваш ответ')
    expect(
      screen.getAllByRole('status').some((node) => node.textContent?.includes('Агент ответил')),
    ).toBe(false)
    // Nothing to confirm or answer (06.11.2026): the status of a failure is «Ошибка».
    expect(screen.queryByText('Нужен ваш ответ')).toBeNull()
    expect(screen.getAllByText('Ошибка').length).toBeGreaterThan(0)
  })

  it('offers «Продолжить» on the question about credits and keeps the field open (28.10.2026)', async () => {
    showDialog(
      feedAnswer({
        status: 'awaiting_user',
        task: { turnNo: 1 },
        events: [requestRow('1'), ceilingRow('2', 1)],
        cursor: '2',
      }),
    )
    const next = await screen.findByRole('button', { name: 'Продолжить' })
    // «пользователь всегда должен иметь возможность ввести промпт»: the words go on too.
    expect(field().disabled).toBe(false)
    expect(field().getAttribute('placeholder')).toBe('Ваш ответ')
    fireEvent.click(next)
    await waitFor(() => expect(calls.proceed).toHaveBeenCalledTimes(1))
    expect(calls.proceed.mock.calls[0]![0]).toMatchObject({ taskId: TASK_ID })
  })

  // docs/plan/53, «Попробовать ещё (18.10)».

  it('says the work is being stopped after `/cancel`, and does not take it again', async () => {
    calls.cancel.mockResolvedValue({ ...posted, state: 'stopping' })
    showDialog(
      feedAnswer({
        status: 'running',
        task: { turnNo: 1, runningSince: '2026-10-17T09:01:00.000Z' },
        events: [requestRow('1')],
        cursor: '1',
      }),
    )
    const commandsButton = await screen.findByRole('button', { name: 'Команды' })
    fireEvent.click(commandsButton)
    fireEvent.click(option(/Отменить чат/))
    const confirm = screen.getByRole('dialog', { name: 'Отменить чат?' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Отменить чат' }))
    expect(await screen.findByText('Останавливаем работу агента…')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
    const again = option(/Отменить чат/)
    expect(again.getAttribute('aria-disabled')).toBe('true')
    expect(again.textContent).toContain('Подождите: агент ещё работает.')
    fireEvent.click(again)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls.cancel).toHaveBeenCalledTimes(1)
  })
})

/** The feed of a dialog reads `answers`, one after another, the last one again and again. */
function queueAnswers(...answers: (DialogFeed | Promise<DialogFeed>)[]) {
  const last = answers.at(-1)!
  for (const answer of answers.slice(0, -1))
    if (answer instanceof Promise) calls.feed.mockReturnValueOnce(answer)
    else calls.feed.mockResolvedValueOnce(answer)
  if (last instanceof Promise) calls.feed.mockReturnValue(last)
  else calls.feed.mockResolvedValue(last)
}

/**
 * The dialog as its page mounts it; `strict` — under Strict Mode, as `next dev` mounts it; `list`
 * — beside the column of the list of dialogs, as the chat of a site draws it (`SiteListFrame`).
 */
function mountDialog({
  streamUrl = null,
  strict = false,
  list = false,
}: { streamUrl?: string | null; strict?: boolean; list?: boolean } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = (
    <QueryClientProvider client={queryClient}>
      <DialogView taskId={TASK_ID} title="Поменять цену капучино" browserStreamUrl={streamUrl} />
    </QueryClientProvider>
  )
  const dialog = list ? (
    <div data-chat-shell="">
      <nav data-chat-list="" aria-label="Чаты">
        <a href={`/chats/${TASK_ID}`}>Поменять цену капучино</a>
      </nav>
      <main>{view}</main>
    </div>
  ) : (
    view
  )
  return render(strict ? <StrictMode>{dialog}</StrictMode> : dialog)
}

/** The feed of a dialog read through `answers`, one after another, the last one again and again. */
function showAnswers(...answers: (DialogFeed | Promise<DialogFeed>)[]) {
  queueAnswers(...answers)
  mountDialog()
}

describe('the five kinds of a chat (docs/plan/61-chats-first.md, §5.6)', () => {
  const NEITHER = { repository: false, browser: false }
  /** What a chat lists: no group «Сайт», no `/retry` (plan 83). */
  const WITHOUT_REPOSITORY = [
    /^\/compactСжать переписку/u,
    /^\/undoОтменить последний запросНедоступна/u,
    /^\/redoВернуть отменённый запросНедоступна/u,
    /^\/cancelОтменить чат/u,
    /^\/newНовый чат/u,
    /^\/sessionsВсе чаты/u,
    /^\/exportСкачать переписку/u,
    /^\/modelsМодель и размышление/u,
    /^\/usageИспользование/u,
    /^\/statusСостояние чата/u,
    /^\/contextКонтекст агента/u,
    /^\/detailsПодробности работы/u,
    /^\/thinkingРазмышления агента/u,
    /^\/themesОформление/u,
    /^\/helpСправка/u,
  ].map((name) => expect.stringMatching(name))
  /** The names of the commands the window lists. */
  const listedCommands = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
    const names = within(screen.getByRole('listbox', { name: 'Команды' }))
      .getAllByRole('option')
      .map((item) => plain(item.textContent))
    fireEvent.keyDown(field(), { key: 'Escape' })
    return names
  }
  const hint = () =>
    (field().getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
  const answered = (requirements: { repository: boolean; browser: boolean }) =>
    feedAnswer({
      status: 'awaiting_user',
      task: { turnNo: 1, requirements },
      commands: verdicts(),
      events: [
        requestRow('1'),
        {
          ...resultRow('2', 1, 'Вот пять вариантов.'),
          next: 'awaiting_user',
          site: 'none',
          filesChanged: 0,
        } as FeedRow,
      ],
      cursor: '2',
    })

  it('a chat with the browser: the browser, /cancel, and where keys go', async () => {
    showDialog(browserAnswer({ events: [requestRow('1', 'Добавьте новость')], cursor: '1' }), null)
    await screen.findByText('Добавьте новость')
    expect(toolsPanel()).toBeNull()
    expect(await menuTiles()).toEqual(['Браузер, Работает агент'])
    expect(listedCommands()).toEqual(WITHOUT_REPOSITORY)
    expect(hint()).toContain('«Настройки → Переменные»')
  })

  it('a chat with neither: no tools, no commands of the site, no word of a project', async () => {
    showDialog(answered(NEITHER), null)
    await screen.findByText('Вот пять вариантов.')
    expect(screen.queryByRole('button', { name: /^Инструменты/ })).toBeNull()
    expect(screen.queryByRole('link', { name: /Открыть проект/ })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Открыть сайт' })).toBeNull()
    expect(screen.getByRole('list', { name: 'Сообщения чата' }).textContent).not.toMatch(
      /сайт|файл/iu,
    )
    expect(listedCommands()).toEqual(WITHOUT_REPOSITORY)
    expect(hint()).toContain('Не отправляйте в чат пароли и ключи')
    // Keys and passwords go to «Настройки → Переменные» (docs/plan/83-remove-projects.md, БП4).
    expect(hint()).toContain('«Настройки → Переменные»')
  })

  describe('`/undo`', () => {
    const open = () =>
      browserAnswer({
        status: 'awaiting_user',
        commands: verdicts({ turn_undo: null }),
        events: [requestRow('1', 'Добавьте новость')],
        cursor: '1',
      })

    const undo = () => {
      type('/')
      fireEvent.click(option(/Отменить последний запрос/))
    }

    it('asks the server to run it, and the words of the request come back to the field', async () => {
      calls.undoTurn.mockResolvedValue({ ...posted, words: 'Добавьте новость' })
      showDialog(open())
      await screen.findByText('Добавьте новость')
      undo()
      await waitFor(() => expect(calls.undoTurn).toHaveBeenCalledTimes(1))
      expect(calls.undoTurn.mock.calls[0]![0].taskId).toBe(TASK_ID)
      await waitFor(() => expect(field().value).toBe('Добавьте новость'))
    })

    it('leaves a draft of the client where it is', async () => {
      calls.undoTurn.mockResolvedValue({ ...posted, words: 'Добавьте новость' })
      showDialog(open())
      await screen.findByText('Добавьте новость')
      type('Свой черновик')
      fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
      fireEvent.click(option(/Отменить последний запрос/))
      await waitFor(() => expect(calls.undoTurn).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(calls.feed.mock.calls.length).toBeGreaterThan(1))
      expect(field().value).toBe('Свой черновик')
    })

    it('brings the same words back after they left the field', async () => {
      calls.undoTurn.mockResolvedValue({ ...posted, words: 'Добавьте новость' })
      showDialog(open())
      await screen.findByText('Добавьте новость')
      undo()
      await waitFor(() => expect(field().value).toBe('Добавьте новость'))
      type('')
      undo()
      await waitFor(() => expect(calls.undoTurn).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(field().value).toBe('Добавьте новость'))
      // A new press: the same id would be a repeat of the first, and nothing would be undone.
      const [first, second] = calls.undoTurn.mock.calls.map(([input]) => input.requestId)
      expect(second).not.toBe(first)
    })

    it('repeats a press after a lost answer under the same id, and takes the words then', async () => {
      calls.undoTurn
        .mockRejectedValueOnce(network())
        .mockResolvedValueOnce({ ...posted, repeated: true, words: 'Добавьте новость' })
      showDialog(open())
      await screen.findByText('Добавьте новость')
      undo()
      expect((await screen.findByRole('alert')).textContent).toBe(NETWORK_TEXT)
      expect(field().value).toBe('')
      type('')
      undo()
      await waitFor(() => expect(calls.undoTurn).toHaveBeenCalledTimes(2))
      const [first, again] = calls.undoTurn.mock.calls.map(([input]) => input.requestId)
      expect(again).toBe(first)
      await waitFor(() => expect(field().value).toBe('Добавьте новость'))
    })

    it('says a refusal in the field and gives nothing back', async () => {
      calls.undoTurn.mockRejectedValue(serverRefusal('Отменять пока нечего.'))
      showDialog(open())
      await screen.findByText('Добавьте новость')
      undo()
      expect((await screen.findByRole('alert')).textContent).toBe('Отменять пока нечего.')
      expect(field().value).toBe('')
    })

    // A failure, words, and the question of the turn on them, taken back: without the row of
    // `/undo` the failure before them would be the last word, and the chat would ask again.
  })

  describe('«Изменить» under the last message (docs/plan/75, ВВ25)', () => {
    const open = () =>
      browserAnswer({
        status: 'awaiting_user',
        commands: verdicts({ turn_undo: null }),
        events: [requestRow('1', 'Добавьте новость')],
        cursor: '1',
      })
    const editor = () =>
      within(screen.getByRole('textbox', { name: 'Изменить сообщение' }).parentElement!)
    const edit = async (words: string) => {
      fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Изменить сообщение' }), {
        target: { value: words },
      })
    }

    it('takes nothing back until «Отправить»', async () => {
      showDialog(open())
      await edit('Добавьте две новости')
      fireEvent.click(editor().getByRole('button', { name: 'Отмена' }))
      expect(calls.undoTurn).not.toHaveBeenCalled()
      expect(calls.message).not.toHaveBeenCalled()
      expect(field().value).toBe('')
    })

    it('takes the turn back, then sends the changed words, waiting for the rewind', async () => {
      calls.undoTurn.mockResolvedValue({ ...posted, words: 'Добавьте новость' })
      calls.message
        .mockRejectedValueOnce(serverRefusal('Подождите', 'TASK_REWINDING'))
        .mockResolvedValue(posted)
      showDialog(open())
      await edit('Добавьте две новости')
      fireEvent.click(editor().getByRole('button', { name: 'Отправить' }))
      await waitFor(() => expect(calls.message).toHaveBeenCalledTimes(2), { timeout: 4000 })
      expect(calls.undoTurn).toHaveBeenCalledTimes(1)
      const [first, again] = calls.message.mock.calls.map(([input]) => input)
      expect(again).toMatchObject({ taskId: TASK_ID, text: 'Добавьте две новости' })
      // One message, knocked twice: the same id.
      expect(again!.requestId).toBe(first!.requestId)
      // The old words do not come back to the field.
      expect(field().value).toBe('')
    })

    it('keeps the changed words in the field when they could not go', async () => {
      calls.undoTurn.mockResolvedValue({ ...posted, words: 'Добавьте новость' })
      calls.message.mockRejectedValue(serverRefusal('Не получилось.'))
      showDialog(open())
      await edit('Добавьте две новости')
      fireEvent.click(editor().getByRole('button', { name: 'Отправить' }))
      expect((await screen.findByRole('alert')).textContent).toBe('Не получилось.')
      await waitFor(() => expect(field().value).toBe('Добавьте две новости'))
    })
  })

  describe('`/redo`', () => {
    const at = '2026-10-17T10:00:00.000Z'
    const row = (fields: Record<string, unknown>) => ({ at, ...fields }) as unknown as FeedRow
    const asked = requestRow('1', 'Добавьте новость')
    const result = row({
      id: '2',
      type: 'feed.result',
      turn: 1,
      message: 'Новость добавлена.',
      site: 'none',
      next: 'awaiting_user',
      filesChanged: null,
      changeType: 'none',
      needsApproval: false,
      risk: 'low',
    })
    const rewind = row({ id: '3', type: 'feed.rewind', turn: 1, files: false, site: 'none' })
    const redone = row({ id: '5', type: 'feed.redo', turn: 1, files: false, open: false })
    const chat = (events: FeedRow[], commands = verdicts({ turn_undo: null, turn_redo: null })) =>
      browserAnswer({
        status: 'awaiting_user',
        commands,
        events,
        cursor: events.at(-1)!.id,
      })
    const undo = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
      fireEvent.click(option(/Отменить последний запрос/))
    }
    const redo = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
      fireEvent.click(option(/Вернуть отменённый запрос/))
    }
    /** `/undo` gave the words to the field, and the next read of the feed shows its row. */
    async function undoneChat() {
      calls.undoTurn.mockResolvedValue({ ...posted, words: 'Добавьте новость' })
      calls.redoTurn.mockResolvedValue({
        ...posted,
        requestEventId: '4',
        words: 'Добавьте новость',
      })
      showDialog(chat([asked, result]))
      await screen.findByText('Новость добавлена.')
      calls.feed.mockResolvedValue(chat([asked, result, rewind]))
      undo()
      await waitFor(() => expect(field().value).toBe('Добавьте новость'))
      await screen.findByText('Последний запрос отменён.')
    }

    it('takes the words out of the field once the turn is back: sent, they would ask twice', async () => {
      await undoneChat()
      calls.feed.mockResolvedValue(chat([asked, result, rewind, redone]))
      redo()
      await waitFor(() => expect(calls.redoTurn).toHaveBeenCalledTimes(1))
      await screen.findByText('Отменённый запрос возвращён.')
      await waitFor(() => expect(field().value).toBe(''))
    })

    it('leaves words the client changed, or wrote in their place', async () => {
      await undoneChat()
      type('Добавьте новость о скидках')
      calls.feed.mockResolvedValue(chat([asked, result, rewind, redone]))
      redo()
      await screen.findByText('Отменённый запрос возвращён.')
      expect(field().value).toBe('Добавьте новость о скидках')
    })

    it('keeps the words until core brought the turn back, and keeps them when it could not', async () => {
      await undoneChat()
      redo()
      await waitFor(() => expect(calls.redoTurn).toHaveBeenCalledTimes(1))
      expect(field().value).toBe('Добавьте новость')
      calls.feed.mockResolvedValue(
        chat([
          asked,
          result,
          rewind,
          row({ id: '5', type: 'feed.update', outcome: 'redo_failed', conflicts: 0 }),
        ]),
      )
      fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
      await screen.findByRole('heading', { name: 'Запрос не возвращён' })
      expect(field().value).toBe('Добавьте новость')
    })

    it('says the chat answered again: `/redo` took the `/undo` back', async () => {
      showDialog(chat([asked, result, rewind, redone]))
      await screen.findByText('Отменённый запрос возвращён.')
      const said = () => screen.getAllByRole('status').map((region) => region.textContent)
      await waitFor(() => expect(said()).toContain('Агент ответил'))
      expect(said()).not.toContain('Запрос отменён')
    })

    it('opens the question of the turn again', async () => {
      const question = row({
        id: '2',
        type: 'feed.question',
        kind: 'agent',
        turn: 1,
        intro: 'Уточните.',
        questions: [{ text: 'Какой адрес?', options: [] }],
      })
      showDialog(chat([asked, question, rewind, redone]))
      await screen.findByText('Отменённый запрос возвращён.')
      await waitFor(() => expect(field().getAttribute('placeholder')).toBe('Ваш ответ'))
    })

    it('shows the refusal of the server', async () => {
      await undoneChat()
      calls.redoTurn.mockRejectedValue(serverRefusal('Возвращать нечего.'))
      redo()
      expect((await screen.findByRole('alert')).textContent).toBe('Возвращать нечего.')
    })
  })

  it('keeps those words for a chat of a project, which has the «Переменные»', async () => {
    const refusal =
      'Похоже, в сообщении есть пароль или ключ. Не отправляйте их в чат — доступы задаются в разделе «Переменные»'
    calls.message.mockRejectedValue(serverRefusal(refusal, 'TASK_TEXT_HAS_SECRET'))
    showDialog(answered({ repository: true, browser: false }))
    await screen.findByText('Вот пять вариантов.')
    type('пароль: hunter2')
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    expect((await screen.findByRole('alert')).textContent).toBe(`${refusal}.`)
  })

  it('asks to sign in on a site, not in the admin of one, without a project', async () => {
    showDialog(
      browserAnswer({
        status: 'awaiting_user',
        browser: { help: { reason: 'login', message: null } },
        events: [requestRow('1'), browserQuestionRow('2', 1, 'login')],
        cursor: '2',
      }),
      null,
    )
    await screen.findByText('Нужно войти на сайт')
    expect(plain(document.body.textContent)).toContain(
      'Агенту нужно, чтобы вы вошли на сайт в браузере задачи.',
    )
    expect(document.body.textContent).not.toContain('админку')
  })
})

describe('a task in the browser', () => {
  /** The card of the open question of the browser, by its title. */
  const card = (title: string) => screen.getByText(title).closest('div')!.parentElement!

  it('keeps the browser of a task that has ended among its tools, with what became of it', async () => {
    showDialog(
      browserAnswer({
        status: 'done',
        events: [requestRow('1', 'Добавьте новость о веранде')],
        cursor: '1',
        browser: null,
      }),
    )
    expect(await screen.findByText('Добавьте новость о веранде')).toBeTruthy()
    expect(toolsPanel()).toBeNull()
    expect(await menuTiles()).toEqual(['Браузер, нет'])
    await choose(/^Браузер/)
    expect(plain(pane().textContent)).toContain('Браузер в этом чате не запускался.')
  })

  it.each([
    ['below the wide layout', false],
    ['from `lg`', true],
  ])(
    'starts with the dialog alone %s while its browser works: of the server, only /cancel',
    async (_width, wide) => {
      if (wide) wideLayout()
      showDialog(
        browserAnswer({ events: [requestRow('1', 'Добавьте новость о веранде')], cursor: '1' }),
        STREAM_URL,
      )
      expect(await screen.findByText('Добавьте новость о веранде')).toBeTruthy()
      // The browser works on the server; the client looks at the dialog alone (И1): no panel, no
      // switch, no stream.
      expect(toolsPanel()).toBeNull()
      expect(screen.queryByRole('tablist')).toBeNull()
      expect(calls.streamTicket).not.toHaveBeenCalled()
      expect(sockets).toHaveLength(0)
      // The agent works: the field waits, and of the server's commands the window of commands has
      // only «Отменить чат» to run; those of the page work all the same.
      fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
      const options = within(screen.getByRole('listbox', { name: 'Команды' })).getAllByRole(
        'option',
      )
      const open = options.filter((option) => option.getAttribute('aria-disabled') === null)
      expect(open.map((option) => plain(option.textContent))).toEqual(
        [
          'Отменить чат',
          'Новый чат',
          'Все чаты',
          'Скачать переписку',
          'Модель и размышление',
          'Использование',
          'Состояние чата',
          'Контекст агента',
          'Подробности работы',
          'Размышления агента',
          'Оформление',
          'Справка',
        ].map((name) => expect.stringContaining(name)),
      )
      expect(
        screen.getByText(
          'Не отправляйте в чат пароли и ключи: сохраните их в «Настройки → Переменные» или войдите сами в окне браузера.',
        ),
      ).toBeTruthy()
    },
  )

  it.each([
    ['below `lg`, in place of the dialog', false],
    ['from `lg`, beside the dialog', true],
  ])('opens the browser %s from «+», and its stream only then', async (_where, wide) => {
    if (wide) wideLayout()
    showDialog(browserAnswer({ events: [requestRow('1')], cursor: '1' }), STREAM_URL)
    await screen.findByRole('status', { name: 'Агент работает' })
    // The live block has no way of its own to the browser (owner's answer of 30.10.2026).
    expect(screen.queryByRole('button', { name: 'Смотреть, что делает агент' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Открыть браузер' })).toBeNull()
    expect(await menuTiles()).toEqual(['Браузер, Работает агент'])
    expect(calls.streamTicket).not.toHaveBeenCalled()
    await choose(/^Браузер/)
    const tab = await screen.findByRole('tab', { name: 'Браузер', selected: true })
    await waitFor(() => expect(document.activeElement).toBe(tab))
    await waitFor(() => expect(sockets).toHaveLength(1))
    expect(calls.streamTicket).toHaveBeenCalledTimes(1)
    expect(calls.streamTicket).toHaveBeenCalledWith({ taskId: TASK_ID })
    expect(sockets[0]!.url).toBe(STREAM_URL)
    // Beside the dialog from `lg`; in its place, the way back in sight, below.
    if (wide) {
      expect(
        screen.getByRole('heading', { level: 1, name: 'Новость о летней веранде' }),
      ).toBeTruthy()
      expect(screen.getByRole('separator', { name: 'Ширина панели' })).toBeTruthy()
    } else {
      expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
      expect(within(pane()).getByRole('button', { name: 'К чату' })).toBeTruthy()
    }
  })

  it('says it cannot show the browser where the platform has none, and keeps the dialog', async () => {
    showDialog(browserAnswer())
    await screen.findByRole('heading', { level: 1, name: 'Новость о летней веранде' })
    const textarea = field()
    await choose(/^Браузер/)
    expect(within(pane()).getByText('Не удалось показать браузер')).toBeTruthy()
    expect(calls.streamTicket).not.toHaveBeenCalled()
    // The dialog is behind the area of the browser, not gone.
    expect(textarea.isConnected).toBe(true)
  })

  it.each([
    ['below the wide layout', false],
    ['from `lg`', true],
  ])(
    'opens the browser %s for «Взять управление» on the question to sign in, and takes the control',
    async (_width, wide) => {
      if (wide) wideLayout()
      showDialog(
        browserAnswer({
          status: 'awaiting_user',
          browser: { help: { reason: 'login', message: null } },
          events: [requestRow('1'), browserQuestionRow('2', 1, 'login')],
          cursor: '2',
        }),
        STREAM_URL,
      )
      expect(await screen.findByText('Нужно войти на сайт')).toBeTruthy()
      // Words in the field answer the question too.
      expect(field().disabled).toBe(false)
      expect(toolsPanel()).toBeNull()
      // «+» says the browser waits, by its dot and its name (И13).
      expect(plusName()).toBe('Инструменты — браузер ждёт вас')
      expect(plus().querySelector('[data-tools-dot]')).not.toBeNull()
      expect(calls.streamTicket).not.toHaveBeenCalled()
      const take = within(card('Нужно войти на сайт')).getByRole('button', {
        name: 'Взять управление',
      })
      take.focus()
      fireEvent.click(take)
      const tab = await screen.findByRole('tab', { name: 'Браузер', selected: true })
      // One ticket, one stream: the control is asked for as soon as the stream stands.
      await waitFor(() => expect(sockets).toHaveLength(1))
      expect(calls.streamTicket).toHaveBeenCalledTimes(1)
      connect(sockets[0]!, 'agent')
      expect(sockets[0]!.sent).toContainEqual({ t: 'take' })
      if (wide) {
        // Beside the dialog the card stays in sight, and the focus on it (И9).
        await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
        expect(document.activeElement).toBe(take)
      } else {
        // The browser takes the place of the dialog, the card with it: the focus is not left
        // behind out of sight, it goes to the tab of the browser.
        await waitFor(() => expect(document.activeElement).toBe(tab))
      }
    },
  )

  it('offers «Взять управление» alone on the question; «+» opens the browser and does nothing else', async () => {
    showDialog(
      browserAnswer({
        status: 'awaiting_user',
        browser: { help: { reason: 'login', message: null } },
        events: [requestRow('1'), browserQuestionRow('2', 1, 'login')],
        cursor: '2',
      }),
      STREAM_URL,
    )
    expect(await screen.findByText('Нужно войти на сайт')).toBeTruthy()
    const question = card('Нужно войти на сайт')
    expect(
      within(question)
        .getAllByRole('button')
        .map((button) => plain(button.textContent)),
    ).toEqual(['Взять управление'])
    await choose(/^Браузер/)
    const tab = await screen.findByRole('tab', { name: 'Браузер', selected: true })
    await waitFor(() => expect(document.activeElement).toBe(tab))
    await waitFor(() => expect(sockets).toHaveLength(1))
    connect(sockets[0]!, 'agent')
    expect(sockets[0]!.sent).not.toContainEqual({ t: 'take' })
  })

  it.each([
    [
      'by the cross of its tab',
      false,
      (tab: HTMLElement) => fireEvent.click(within(tab).getByTitle('Закрыть вкладку «Браузер»')),
    ],
    [
      'by Delete on its tab',
      false,
      (tab: HTMLElement) => fireEvent.keyDown(tab, { key: 'Delete' }),
    ],
    [
      'by «К чату» below `lg`',
      false,
      () => fireEvent.click(within(pane()).getByRole('button', { name: 'К чату' })),
    ],
    [
      'by «Скрыть панель» from `lg`',
      true,
      () => fireEvent.click(within(pane()).getByRole('button', { name: 'Скрыть панель' })),
    ],
  ])(
    'closes the browser %s without stopping the task or giving the control back (И8)',
    async (_how, wide, close) => {
      if (wide) wideLayout()
      showDialog(
        browserAnswer({ browser: { controller: 'user' }, events: [requestRow('1')], cursor: '1' }),
        STREAM_URL,
      )
      // The client drives while the turn runs, and looks at the browser from «+».
      await screen.findByRole('heading', { name: 'Управляете вы' })
      await choose(/^Браузер/)
      const tab = await screen.findByRole('tab', { name: 'Браузер', selected: true })
      await waitFor(() => expect(sockets).toHaveLength(1))
      const socket = sockets[0]!
      connect(socket, 'user')
      close(tab)
      await waitFor(() => expect(toolsPanel()).toBeNull())
      await waitFor(() => expect(document.activeElement).toBe(plus()))
      // Only the picture goes: its stream closes, nothing is said to the browser or to the server.
      expect(socket.closed).toBe(true)
      expect(socket.sent).not.toContainEqual({ t: 'release' })
      expect(calls.cancel).not.toHaveBeenCalled()
      expect(calls.resumeAgent).not.toHaveBeenCalled()
      // The client still drives: the plate keeps «Продолжить работу агента» alone; the browser is
      // in «+».
      expect(screen.getByRole('button', { name: 'Продолжить работу агента' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Открыть браузер' })).toBeNull()
      expect(await menuTiles()).toEqual(['Браузер, Управляете вы'])
    },
  )

  it('gives the browser back with «Продолжить работу агента» while the task waits', async () => {
    showDialog(
      browserAnswer({
        status: 'awaiting_user',
        browser: { controller: 'user' },
        events: [requestRow('1'), browserQuestionRow('2', 1, 'control')],
        cursor: '2',
      }),
      STREAM_URL,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Продолжить работу агента' }))
    await waitFor(() => expect(calls.resumeAgent).toHaveBeenCalledTimes(1))
    expect(calls.resumeAgent.mock.calls[0]![0]).toEqual({
      taskId: TASK_ID,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    // The press goes to the server, not through the stream: nothing is opened or shown for it.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(calls.streamTicket).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(0)
    expect(toolsPanel()).toBeNull()
  })

  it('stays closed when the agent asks for help after the client closed the browser: only «+» says so', async () => {
    wideLayout()
    let later!: (answer: DialogFeed) => void
    const asked = browserAnswer({
      status: 'awaiting_user',
      browser: { help: { reason: 'login', message: null } },
      events: [requestRow('1'), browserQuestionRow('2', 1, 'login')],
      cursor: '2',
    })
    queueAnswers(
      browserAnswer({ events: [requestRow('1')], cursor: '1', more: true }),
      new Promise<DialogFeed>((resolve) => (later = resolve)),
      asked,
    )
    mountDialog({ streamUrl: STREAM_URL })
    await screen.findByRole('status', { name: 'Агент работает' })
    await choose(/^Браузер/)
    await screen.findByRole('tab', { name: 'Браузер', selected: true })
    await waitFor(() => expect(sockets).toHaveLength(1))
    fireEvent.click(within(pane()).getByRole('button', { name: 'Скрыть панель' }))
    await waitFor(() => expect(toolsPanel()).toBeNull())
    expect(sockets[0]!.closed).toBe(true)
    later(asked)
    expect(await screen.findByText('Нужно войти на сайт')).toBeTruthy()
    // The new question is in the dialog; the browser stays where the client put it (И1, И8), and
    // the dot on «+» says it waits (И13). No stream is opened for it.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(toolsPanel()).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
    expect(plusName()).toBe('Инструменты — браузер ждёт вас')
    expect(plus().querySelector('[data-tools-dot]')).not.toBeNull()
    expect(calls.streamTicket).toHaveBeenCalledTimes(1)
    expect(sockets).toHaveLength(1)
  })

  it('takes no words and offers no control while «Остановить» of a waiting task is under way', async () => {
    calls.cancel.mockResolvedValue({ ...posted, state: 'stopping' })
    showDialog(
      browserAnswer({
        status: 'awaiting_user',
        browser: { help: { reason: 'login', message: null } },
        events: [requestRow('1'), browserQuestionRow('2', 1, 'login')],
        cursor: '2',
      }),
    )
    expect(await screen.findByText('Нужно войти на сайт')).toBeTruthy()
    const question = card('Нужно войти на сайт')
    const take = () =>
      within(question).getByRole<HTMLButtonElement>('button', { name: 'Взять управление' })
    expect(field().disabled).toBe(false)
    expect(take().disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
    fireEvent.click(option(/Отменить чат/))
    const confirm = screen.getByRole('dialog', { name: 'Отменить чат?' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Отменить чат' }))
    // core closes the task: until then the field and the control wait, and say why.
    await waitFor(() => expect(field().disabled).toBe(true))
    expect(take().disabled).toBe(true)
    expect(calls.cancel).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Looking is no action: the browser opens from «+» meanwhile and says the same.
    expect(within(question).queryByRole('button', { name: 'Открыть браузер' })).toBeNull()
    await choose(/^Браузер/)
    expect(await within(pane()).findByText('Останавливаем задачу…')).toBeTruthy()
    expect(screen.getAllByText('Останавливаем задачу…')).toHaveLength(2)
  })

  it('reads a press of «Остановить» from the feed: «Продолжить работу агента» waits too', async () => {
    showDialog(
      browserAnswer({
        status: 'awaiting_user',
        browser: { controller: 'user' },
        events: [requestRow('1'), browserQuestionRow('2', 1, 'control'), commandRow('3', 'cancel')],
        cursor: '3',
      }),
    )
    const resume = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Продолжить работу агента',
    })
    expect(resume.disabled).toBe(true)
    fireEvent.click(resume)
    expect(field().disabled).toBe(true)
    await choose(/^Браузер/)
    expect(await within(pane()).findByText('Останавливаем задачу…')).toBeTruthy()
    // «Остановить» is not offered twice.
    expect(
      within(pane())
        .getAllByRole<HTMLButtonElement>('button', { name: 'Остановить' })
        .every((button) => button.disabled),
    ).toBe(true)
    expect(calls.resumeAgent).not.toHaveBeenCalled()
  })
})

describe('the browser that starts while the client looks at the dialog (docs/plan/59, И2, И3)', () => {
  const OTHER_SESSION = '0199a3f2-0000-7000-8000-0000000000e2'
  const WORDS = ['Добавьте новость о веранде', 'И фото с открытия', 'Подпись — «Лето на веранде»']

  /** The dialog of a task in the browser at work, its session as given, with its first rows. */
  const atWork = (
    browser: Partial<FeedBrowserHead> | null,
    rows: number,
    more = false,
  ): DialogFeed =>
    browserAnswer({
      browser,
      events: WORDS.slice(0, rows).map((text, at) => requestRow(String(at + 1), text)),
      cursor: String(rows),
      more,
    })

  /** An answer of the feed the test gives when it says so: the dialog reads it meanwhile. */
  function later() {
    let give!: (answer: DialogFeed) => void
    const answer = new Promise<DialogFeed>((resolve) => (give = resolve))
    return { answer, give: (next: DialogFeed) => give(next) }
  }

  const closeBrowser = () =>
    fireEvent.click(
      within(screen.getByRole('tab', { name: 'Браузер' })).getByTitle('Закрыть вкладку «Браузер»'),
    )

  it('opens the browser beside the dialog once, the focus left where it was', async () => {
    wideLayout()
    const second = later()
    const third = later()
    queueAnswers(
      atWork({ status: 'starting' }, 1, true),
      second.answer,
      third.answer,
      atWork({ status: 'ready', sessionId: OTHER_SESSION }, 3),
    )
    mountDialog({ streamUrl: STREAM_URL })
    await screen.findByText(WORDS[0]!)
    // The agent works, so the words wait; the client is at the commands of the field meanwhile.
    const commands = screen.getByRole('button', { name: 'Команды' })
    commands.focus()
    expect(document.activeElement).toBe(commands)
    expect(toolsPanel()).toBeNull()
    second.give(atWork({ status: 'ready' }, 2, true))
    // It started on the client's eyes: the browser opens by itself, its stream with it.
    expect(await screen.findByRole('tab', { name: 'Браузер', selected: true })).toBeTruthy()
    expect(tabNames()).toEqual(['Браузер'])
    await waitFor(() => expect(sockets).toHaveLength(1))
    // Nothing was pressed: the focus stays where the client had it (И3, И9).
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(document.activeElement).toBe(commands)
    // The client closes it: neither the same session nor the next one opens it again.
    closeBrowser()
    await waitFor(() => expect(toolsPanel()).toBeNull())
    third.give(atWork({ status: 'ready' }, 2, true))
    expect(await screen.findByText(WORDS[2]!)).toBeTruthy()
    expect(toolsPanel()).toBeNull()
    expect(calls.cancel).not.toHaveBeenCalled()
    expect(calls.resumeAgent).not.toHaveBeenCalled()
  })

  /** «+» at the end of the tabs, where it stands while the panel is open (И4). */
  const plusOfTabs = () => within(pane()).getByRole('button', { name: /^Инструменты/ })

  it('gives a focus on «+» of the head to «+» at the end of the tabs as the browser opens by itself', async () => {
    wideLayout()
    const second = later()
    queueAnswers(atWork({ status: 'starting' }, 1, true), second.answer)
    mountDialog({ streamUrl: STREAM_URL })
    await screen.findByText(WORDS[0]!)
    // The client is on «+» of the head — where Esc of its menu leaves them, too (И5).
    const inHead = within(screen.getByRole('banner')).getByRole('button', { name: /^Инструменты/ })
    inHead.focus()
    second.give(atWork({ status: 'ready' }, 2))
    expect(await screen.findByRole('tab', { name: 'Браузер', selected: true })).toBeTruthy()
    // «+» left the head for the end of the tabs: the focus is on it there, in the same corner, never
    // dropped to the start of the page.
    expect(inHead.isConnected).toBe(false)
    await waitFor(() => expect(document.activeElement).toBe(plusOfTabs()))
  })

  it('closes the menu of «+» the browser opens under, the focus on «+» at the end of the tabs', async () => {
    wideLayout()
    const second = later()
    queueAnswers(atWork({ status: 'starting' }, 1, true), second.answer)
    mountDialog({ streamUrl: STREAM_URL })
    await screen.findByText(WORDS[0]!)
    // Opened from the keyboard: the focus on its first tile.
    plus().focus()
    fireEvent.click(plus())
    const menu = await screen.findByRole('menu', { name: 'Инструменты' })
    const tile = within(menu).getByRole('menuitem', { name: /^Браузер/ })
    await waitFor(() => expect(document.activeElement).toBe(tile))
    second.give(atWork({ status: 'ready' }, 2))
    expect(await screen.findByRole('tab', { name: 'Браузер', selected: true })).toBeTruthy()
    // The menu went with «+» of the head, as Esc would close it: the focus on «+» there.
    expect(screen.queryByRole('menu')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(plusOfTabs()))
    expect(plusOfTabs().getAttribute('aria-expanded')).toBe('false')
  })

  it('gives a focus in the list of dialogs, which the panel takes the room of, to «+»', async () => {
    wideLayout()
    const second = later()
    queueAnswers(atWork({ status: 'starting' }, 1, true), second.answer)
    mountDialog({ streamUrl: STREAM_URL, list: true })
    await screen.findByText(WORDS[0]!)
    // The client came from the list: its link keeps the focus. From `lg` the list gives its room
    // to the panel, the link with it.
    const link = within(screen.getByRole('navigation', { name: 'Чаты' })).getByRole('link')
    link.focus()
    second.give(atWork({ status: 'ready' }, 2))
    expect(await screen.findByRole('tab', { name: 'Браузер', selected: true })).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(plusOfTabs()))
  })

  it.each([
    ['«⋯» of the head', () => screen.getByRole('button', { name: /^Действия с чатом/ })],
    ['«Команды» of the field', () => screen.getByRole('button', { name: 'Команды' })],
  ])('leaves a focus on %s where it is as the browser opens by itself', async (_what, target) => {
    wideLayout()
    const second = later()
    queueAnswers(atWork({ status: 'starting' }, 1, true), second.answer)
    mountDialog({ streamUrl: STREAM_URL, list: true })
    await screen.findByText(WORDS[0]!)
    const held = target()
    held.focus()
    second.give(atWork({ status: 'ready' }, 2))
    expect(await screen.findByRole('tab', { name: 'Браузер', selected: true })).toBeTruthy()
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(document.activeElement).toBe(held)
  })

  it('moves no focus for a launch that opens nothing: once the client closed the browser', async () => {
    wideLayout()
    const second = later()
    queueAnswers(atWork({ status: 'starting' }, 1, true), second.answer)
    mountDialog({ streamUrl: STREAM_URL, list: true })
    await screen.findByText(WORDS[0]!)
    await choose(/^Браузер/)
    closeBrowser()
    await waitFor(() => expect(toolsPanel()).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(plus()))
    // The client went on to the list of dialogs meanwhile.
    const link = within(screen.getByRole('navigation', { name: 'Чаты' })).getByRole('link')
    link.focus()
    second.give(atWork({ status: 'ready' }, 2))
    expect(await screen.findByText(WORDS[1]!)).toBeTruthy()
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(toolsPanel()).toBeNull()
    expect(document.activeElement).toBe(link)
  })

  it.each([
    ['«+» of the head', () => plus()],
    ['«⋯» of the head', () => screen.getByRole('button', { name: /^Действия с чатом/ })],
    ['«Команды» of the field', () => screen.getByRole('button', { name: 'Команды' })],
  ])(
    'gives a focus on %s below `lg`, which the browser takes the place of, to «+» over the browser',
    async (_what, target) => {
      const second = later()
      queueAnswers(atWork({ status: 'starting' }, 1, true), second.answer)
      mountDialog({ streamUrl: STREAM_URL, list: true })
      await screen.findByText(WORDS[0]!)
      const held = target()
      held.focus()
      expect(document.activeElement).toBe(held)
      second.give(atWork({ status: 'ready' }, 2))
      expect(await screen.findByRole('tab', { name: 'Браузер', selected: true })).toBeTruthy()
      // «+» beside «К чату», in the same corner, never the start of the page (И4).
      await waitFor(() => expect(document.activeElement).toBe(plusOfTabs()))
      expect(plusOfTabs().id).toBe('dialog-tools')
    },
  )

  it('leaves a focus outside the dialog where it is as the browser opens below `lg`', async () => {
    const second = later()
    queueAnswers(atWork({ status: 'starting' }, 1, true), second.answer)
    mountDialog({ streamUrl: STREAM_URL, list: true })
    await screen.findByText(WORDS[0]!)
    // Below `lg` the shell around the dialog stays: what is in it keeps the focus.
    const link = within(screen.getByRole('navigation', { name: 'Чаты' })).getByRole('link')
    link.focus()
    second.give(atWork({ status: 'ready' }, 2))
    expect(await screen.findByRole('tab', { name: 'Браузер', selected: true })).toBeTruthy()
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(document.activeElement).toBe(link)
  })

  it('opens nothing for a browser at work before the client came, nor for its next answers', async () => {
    wideLayout()
    queueAnswers(atWork({ status: 'ready' }, 1, true), atWork({ status: 'ready' }, 2))
    mountDialog({ streamUrl: STREAM_URL })
    expect(await screen.findByText(WORDS[1]!)).toBeTruthy()
    expect(toolsPanel()).toBeNull()
    expect(calls.streamTicket).not.toHaveBeenCalled()
    expect(await menuTiles()).toEqual(['Браузер, Работает агент'])
  })

  it('opens nothing once the client closed the browser in this showing', async () => {
    wideLayout()
    const second = later()
    queueAnswers(atWork({ status: 'starting' }, 1, true), second.answer)
    mountDialog({ streamUrl: STREAM_URL })
    await screen.findByText(WORDS[0]!)
    // The client looked at the browser being started, and closed it.
    await choose(/^Браузер/)
    closeBrowser()
    await waitFor(() => expect(toolsPanel()).toBeNull())
    second.give(atWork({ status: 'ready' }, 2))
    expect(await screen.findByText(WORDS[1]!)).toBeTruthy()
    expect(toolsPanel()).toBeNull()
  })

  it('opens nothing for a browser that started while the page was out of sight', async () => {
    wideLayout()
    const second = later()
    const third = later()
    queueAnswers(atWork({ status: 'starting' }, 1, true), second.answer, third.answer)
    mountDialog({ streamUrl: STREAM_URL })
    await screen.findByText(WORDS[0]!)
    showPage(false)
    // Read while the page is hidden: the client did not see it start.
    second.give(atWork({ status: 'ready' }, 2, true))
    expect(await screen.findByText(WORDS[1]!)).toBeTruthy()
    showPage(true)
    third.give(atWork({ status: 'ready' }, 3))
    expect(await screen.findByText(WORDS[2]!)).toBeTruthy()
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(toolsPanel()).toBeNull()
    expect(calls.streamTicket).not.toHaveBeenCalled()
  })

  it('opens at the first answer of a dialog the client has just started, once, under Strict Mode', async () => {
    wideLayout()
    markNewDialog(TASK_ID)
    queueAnswers(atWork({ status: 'ready' }, 1))
    const first = mountDialog({ streamUrl: STREAM_URL, strict: true })
    // The client watched it start: a browser ready by the first answer opens by itself.
    expect(await screen.findByRole('tab', { name: 'Браузер', selected: true })).toBeTruthy()
    expect(tabNames()).toEqual(['Браузер'])
    // The start speaks for this showing alone: a reload opens nothing.
    expect(isNewDialog(TASK_ID)).toBe(false)
    first.unmount()
    mountDialog({ streamUrl: STREAM_URL, strict: true })
    expect(await screen.findByText(WORDS[0]!)).toBeTruthy()
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(toolsPanel()).toBeNull()
  })

  it("opens the browser by itself below `lg` too, in place of the dialog, once and with no dot (owner's answer of 30.10.2026)", async () => {
    const second = later()
    const third = later()
    queueAnswers(
      atWork({ status: 'starting' }, 1, true),
      second.answer,
      third.answer,
      atWork({ status: 'ready' }, 3),
    )
    mountDialog({ streamUrl: STREAM_URL })
    await screen.findByText(WORDS[0]!)
    const heading = screen.getByRole('heading', { level: 1, name: 'Новость о летней веранде' })
    expect(plusName()).toBe('Инструменты')
    second.give(atWork({ status: 'ready' }, 2, true))
    // The browser takes the place of the dialog, its stream with it; the dialog is only hidden.
    expect(await screen.findByRole('tab', { name: 'Браузер', selected: true })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
    expect(heading.isConnected).toBe(true)
    expect(within(pane()).getByRole('button', { name: 'К чату' })).toBeTruthy()
    await waitFor(() => expect(sockets).toHaveLength(1))
    // «+» over the browser has no dot: the client sees what started.
    expect(plusName()).toBe('Инструменты')
    // Back to the dialog: no dot «браузер запущен», and the next answer opens nothing again.
    fireEvent.click(within(pane()).getByRole('button', { name: 'К чату' }))
    await waitFor(() => expect(toolsPanel()).toBeNull())
    expect(screen.getByRole('heading', { level: 1, name: 'Новость о летней веранде' })).toBe(
      heading,
    )
    await waitFor(() => expect(document.activeElement).toBe(plus()))
    expect(plusName()).toBe('Инструменты')
    expect(plusName()).not.toBe(LAUNCH_DOT)
    expect(plus().querySelector('[data-tools-dot]')).toBeNull()
    expect(sockets[0]!.closed).toBe(true)
    third.give(atWork({ status: 'ready' }, 2, true))
    expect(await screen.findByText(WORDS[2]!)).toBeTruthy()
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(toolsPanel()).toBeNull()
    expect(calls.cancel).not.toHaveBeenCalled()
    expect(calls.resumeAgent).not.toHaveBeenCalled()
  })

  it('opens nothing where the cabinet cannot show the browser', async () => {
    wideLayout()
    const second = later()
    queueAnswers(atWork({ status: 'starting' }, 1, true), second.answer)
    // No address of the stream: the browser could only say it cannot be shown.
    mountDialog()
    await screen.findByText(WORDS[0]!)
    second.give(atWork({ status: 'ready' }, 2))
    expect(await screen.findByText(WORDS[1]!)).toBeTruthy()
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(toolsPanel()).toBeNull()
  })
})

describe('the browser kept from its idle end while the client looks at the dialog (docs/plan/59, И18)', () => {
  it.each([
    ['the agent drives it', { status: 'ready' as const }],
    ['it is being started', { status: 'starting' as const }],
    ['the client drives it', { controller: 'user' as const }],
    ['it waits for the client', { help: { reason: 'login' as const, message: null } }],
  ])(
    "says the client looks at once while %s, the panel closed (owner's answer of 30.10.2026)",
    async (_what, session) => {
      showDialog(
        browserAnswer({ browser: session, events: [requestRow('1')], cursor: '1' }),
        STREAM_URL,
      )
      await waitFor(() => expect(calls.watch).toHaveBeenCalledTimes(1))
      expect(calls.watch.mock.calls[0]![0]).toEqual({ taskId: TASK_ID })
      // Looking at the dialog opens nothing, and no stream is read for it.
      expect(toolsPanel()).toBeNull()
      expect(calls.streamTicket).not.toHaveBeenCalled()
      expect(sockets).toHaveLength(0)
    },
  )

  it('says it where the cabinet cannot show the browser too: the dialog is on the screen', async () => {
    showDialog(browserAnswer({ events: [requestRow('1')], cursor: '1' }))
    await waitFor(() => expect(calls.watch).toHaveBeenCalledTimes(1))
  })

  it('says it again as the page comes back into sight, and no more once the session closed', async () => {
    let later!: (answer: DialogFeed) => void
    const closed = browserAnswer({
      status: 'awaiting_user',
      browser: { status: 'closed', closeReason: 'idle' },
      events: [requestRow('1'), browserQuestionRow('2', 1, 'login')],
      cursor: '2',
    })
    showAnswers(
      browserAnswer({ events: [requestRow('1')], cursor: '1', more: true }),
      new Promise<DialogFeed>((resolve) => (later = resolve)),
      closed,
    )
    await waitFor(() => expect(calls.watch).toHaveBeenCalledTimes(1))
    showPage(false)
    showPage(true)
    await waitFor(() => expect(calls.watch).toHaveBeenCalledTimes(2))
    later(closed)
    expect(await screen.findByText('Нужно войти на сайт')).toBeTruthy()
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    showPage(false)
    showPage(true)
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(calls.watch).toHaveBeenCalledTimes(2)
  })
})

describe('the queue of the chat while the agent works (docs/plan/75, ВВ1, ВВ4)', () => {
  const running = () =>
    feedAnswer({
      status: 'running',
      task: { turnNo: 1, runningSince: '2026-10-17T09:01:00.000Z' },
      events: [requestRow('1')],
      cursor: '1',
    })

  it('keeps the field open, puts the words into the queue and stops by the same button when empty', async () => {
    calls.queueAdd.mockResolvedValueOnce({
      id: '0199a3f2-0000-7000-8000-0000000000c1',
      repeated: false,
    })
    showDialog(running())
    const stop = await screen.findByRole<HTMLButtonElement>('button', { name: 'Остановить' })
    await waitFor(() => expect(field().disabled).toBe(false))
    expect(stop).toBeTruthy()
    type('И ещё добавьте телефон')
    const queue = screen.getByRole<HTMLButtonElement>('button', { name: 'Поставить в очередь' })
    fireEvent.click(queue)
    await waitFor(() => expect(calls.queueAdd).toHaveBeenCalledTimes(1))
    expect(calls.queueAdd.mock.calls[0]![0]).toMatchObject({
      taskId: TASK_ID,
      text: 'И ещё добавьте телефон',
    })
    expect(calls.message).not.toHaveBeenCalled()
  })

  it('shows the queued words with «Отправить сейчас», which stops the pass for them', async () => {
    calls.queueList.mockResolvedValue({
      items: [
        {
          id: '0199a3f2-0000-7000-8000-0000000000c2',
          requestId: '0199a3f2-0000-7000-8000-0000000000c3',
          text: 'Поменяйте и цену латте',
          attachments: [],
          createdAt: new Date(),
        },
      ],
    })
    showDialog(running())
    const words = await screen.findByText('Поменяйте и цену латте')
    const section = words.closest('section') as HTMLElement
    fireEvent.click(within(section).getByRole('button', { name: 'Отправить сейчас' }))
    await waitFor(() => expect(calls.queueSendNow).toHaveBeenCalledTimes(1))
    expect(calls.queueSendNow.mock.calls[0]![0]).toMatchObject({ taskId: TASK_ID })
    calls.queueList.mockResolvedValue({ items: [] })
  })
})
