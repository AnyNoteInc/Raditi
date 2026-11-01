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

import { AppIcon, type AppIconName } from '@/components/application/app-icon'
import { plain, serverRefusal } from '@/components/billing/testing'

import type * as Upload from './attachment-upload'
import { composerText } from './chat-texts'
import type { CandidateView, DialogFeed, FeedRow, PreparedRelease } from './chat-types'
import { DialogView } from './dialog-view'
import { forgetNewDialog, isNewDialog, markNewDialog } from './new-dialog-hint'
import {
  ATTACHMENT_ID,
  AUTHOR_ID,
  browserAnswer,
  browserQuestionRow,
  browserResultRow,
  CANDIDATE_ID,
  candidateHead,
  candidateRow,
  ceilingRow,
  commandRow,
  feedAnswer,
  type FeedBrowserHead,
  requestRow,
  resultRow,
  resumeRow,
  SESSION_ID,
  SITE_ID,
  stepRow,
  TASK_ID,
  verdicts,
} from './testing'

type Press = { taskId: string; requestId: string }
type Posted = { requestEventId: string; repeated: boolean }

const calls = vi.hoisted(() => ({
  feed: vi.fn<(input: { taskId: string; after: string }) => Promise<DialogFeed>>(),
  message: vi.fn<(input: Press & { text: string }) => Promise<Posted>>(),
  proceed: vi.fn<(input: Press) => Promise<Posted>>(),
  retry: vi.fn<(input: Press & { failureEventId: string }) => Promise<Posted>>(),
  cancel: vi.fn<(input: Press) => Promise<Posted & { state: 'cancelled' | 'stopping' }>>(),
  reset: vi.fn<(input: Press) => Promise<{ requestEventId: string | null; repeated: boolean }>>(),
  update: vi.fn<(input: Press) => Promise<Posted>>(),
  prepare: vi.fn<(input: { taskId: string }) => Promise<PreparedRelease>>(),
  candidate:
    vi.fn<(input: { taskId: string; revision?: number }) => Promise<CandidateView | null>>(),
  undoPrepare:
    vi.fn<(input: { taskId: string; releaseId: string }) => Promise<{ planId: string }>>(),
  resumeAgent: vi.fn<(input: Press) => Promise<Posted>>(),
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
    activity: { query: async () => ({ events: [], cursor: '0', more: false }) },
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
      continue: mutation(calls.proceed),
      retry: mutation(calls.retry),
      cancel: mutation(calls.cancel),
      resumeAgent: mutation(calls.resumeAgent),
      setEffort: mutation(calls.setEffort),
      rename: mutation(calls.rename),
      remove: mutation(calls.remove),
      export: query('task.export', calls.exported),
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
  }),
  useTRPCClient: () => client,
}))

/** A dialog that waits with changes: the request, the result, the candidate of revision 1. */
const waiting = (patch: Parameters<typeof feedAnswer>[0] = {}) =>
  feedAnswer({
    status: 'awaiting_approval',
    task: { turnNo: 1 },
    candidate: candidateHead,
    events: [requestRow('1'), resultRow('2', 1), candidateRow('3', 1)],
    cursor: '3',
    ...patch,
  })

const posted: Posted = { requestEventId: '9', repeated: false }

/** What the server says of the commands of a chat of a closed project (К39). */
const closedVerdicts = () =>
  verdicts({
    release: 'project_closed',
    preview: 'project_closed',
    reset: 'project_closed',
    update: 'project_closed',
    retry: 'project_closed',
  })

/** The project of the chat, as `task.get` gives it. */
const PROJECT = {
  id: SITE_ID,
  name: 'Кофейня «Крошка»',
  url: 'https://kroshka.example',
  closed: false,
}
const projectOf = (url: string | null) => (url === null ? null : { ...PROJECT, url })

function showDialog(
  answer: DialogFeed = waiting(),
  browserStreamUrl: string | null = null,
  siteUrl: string | null = 'https://kroshka.example',
) {
  calls.feed.mockResolvedValue(answer)
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <DialogView
        project={projectOf(siteUrl)}
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
const readyPreview = {
  status: 'ready' as const,
  unavailableReason: null,
  origin: PREVIEW_ORIGIN,
  revision: 1,
  dirty: false,
}
const FRAME = 'Предпросмотр сайта с изменениями чата'
const TOOLS = 'Инструменты чата'

/** The panel of the tools beside the dialog, when it is drawn. */
const toolsPanel = () => screen.queryByRole('complementary', { name: TOOLS })
const pane = () => screen.getByRole('complementary', { name: TOOLS })
/** «+»: one on the screen, in the head or at the end of the tabs; its dot is said after its name. */
const plus = () => screen.getByRole('button', { name: /^Инструменты/ })
/** The name of «+» says whether it bears the dot (И13). */
const plusName = () => plus().getAttribute('aria-label')
const DOT = {
  changes: 'Инструменты — есть новые изменения',
  browser: 'Инструменты — браузер ждёт вас',
}
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

/**
 * A window the test makes wider or narrower than `lg` as it goes: every media query of the layout
 * follows it, and whoever listens to one hears the change, as in a browser being resized.
 */
function resizableLayout(wide: boolean): (wide: boolean) => void {
  let matches = wide
  const heard = new Set<() => void>()
  vi.stubGlobal(
    'matchMedia',
    (query: string): MediaQueryList =>
      ({
        get matches() {
          return matches
        },
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => void heard.add(listener),
        removeEventListener: (_type: string, listener: () => void) => void heard.delete(listener),
        addListener: (listener: () => void) => void heard.add(listener),
        removeListener: (listener: () => void) => void heard.delete(listener),
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  )
  return (next) => {
    matches = next
    act(() => {
      for (const listener of [...heard]) listener()
    })
  }
}

/** The outline of the sign an element draws: two signs are the same when their outlines are. */
const outline = (element: Element) => element.querySelector('svg path')?.getAttribute('d') ?? null
/** The outline `AppIcon` draws for `name`, drawn aside from the page. */
const outlineOf = (name: AppIconName) =>
  outline(render(<AppIcon name={name} />, { container: document.createElement('div') }).container)

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

/** The words of the client on top of the changes, as the feed shows them once taken. */
const revisionRow = (id: string, requestId: string, text: string): FeedRow => ({
  id,
  at: '2026-10-17T10:00:00.000Z',
  type: 'feed.request',
  kind: 'revision',
  text,
  authorId: AUTHOR_ID,
  requestId,
  candidateRevision: 1,
})

/** The changes of revision 1 with one check in the given status. */
const candidateWith = (status: 'pending' | 'passed'): CandidateView => ({
  id: CANDIDATE_ID,
  taskId: TASK_ID,
  revision: 1,
  status: 'current',
  turnNo: 1,
  createdAt: new Date('2026-10-17T09:00:00Z'),
  baseVersion: 'v1.3.2',
  files: [],
  media: [],
  database: [],
  databaseView: null,
  databaseReview: false,
  checks: [
    {
      id: '0199a3f2-0000-7000-8000-0000000000c1',
      kind: 'php_lint',
      status,
      finishedAt: null,
      screenshot: false,
    },
  ],
  proposal: { base: 'v1.3.2', version: 'v1.4.0', bump: 'minor', choices: [] },
  runtime: null,
})
const checksOf = (status: 'pending' | 'passed') => ({
  ...candidateHead,
  checks: { pending: 0, passed: 0, failed: 0, stale: 0, [status]: 1 },
})

const network = () => new TypeError('Failed to fetch')
const NETWORK_TEXT = 'Не удалось связаться с сервером. Проверьте подключение и попробуйте ещё раз.'

describe('a dialog', () => {
  // The page passes null from 61.12 on: nothing fails by itself then (docs/plan/61, К18).
  it.each([
    ['in the queue', { status: 'queued', task: { waiting: 'site' } }, 'Агент скоро возьмётся'],
    ['held', { status: 'running', task: { turnNo: 1, held: true } }, 'Произошёл сбой, мы'],
  ] as const)('says nothing of a site without a project, %s', async (_what, state, words) => {
    showDialog(feedAnswer({ ...state, events: [requestRow('1')], cursor: '1' }), null, null)
    expect(await screen.findByText(new RegExp(`^${words}`, 'u'))).toBeTruthy()
    expect(document.body.textContent).not.toContain('На сайте')
    expect(document.body.textContent).not.toContain('При работе с сайтом')
  })

  it('reads its head and rows: its name, its project in the middle, its menu', async () => {
    showDialog()
    expect(await screen.findByText('Изменения готовы')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'Поменять цену капучино' })).toBeTruthy()
    expect(calls.feed).toHaveBeenCalledWith({ taskId: TASK_ID, after: '0' })
    expect(
      screen.getByRole('button', { name: 'Действия с чатом: Поменять цену капучино' }),
    ).toBeTruthy()
    const link = screen.getByRole('link', { name: `Открыть проект «${PROJECT.name}»` })
    expect(link.getAttribute('href')).toBe(`/projects/${SITE_ID}`)
    expect(screen.queryByRole('navigation', { name: /Режим/ })).toBeNull()
    expect(field().getAttribute('placeholder')).toBe('Что поправить?')
    // No standing words under the field (owner, 26.10.2026): the reminder is read aloud only.
    expect(screen.queryByText('ИИ может допускать ошибки. Проверяйте важное.')).toBeNull()
  })

  it('has no way to a project in a chat without one', async () => {
    showDialog(waiting(), null, null)
    await screen.findByText('Изменения готовы')
    expect(screen.queryByRole('link', { name: /^Открыть проект/ })).toBeNull()
  })

  it('reads a chat of a closed project, its field closed with the reason', async () => {
    calls.feed.mockResolvedValue(waiting())
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DialogView project={{ ...PROJECT, closed: true }} taskId={TASK_ID} title={null} />
      </QueryClientProvider>,
    )
    await screen.findByText('Изменения готовы')
    expect(field().disabled).toBe(true)
    expect(field().getAttribute('placeholder')).toBe('Сайт на паузе или отключён.')
    // The head still leads to the project, where the client sees why.
    expect(screen.getByRole('link', { name: `Открыть проект «${PROJECT.name}»` })).toBeTruthy()
  })

  it('offers nothing on the changes of a closed project and says why, by the server’s verdicts', async () => {
    calls.feed.mockResolvedValue(waiting({ commands: closedVerdicts() }))
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DialogView project={{ ...PROJECT, closed: true }} taskId={TASK_ID} title={null} />
      </QueryClientProvider>,
    )
    await screen.findByText('Изменения готовы')
    const feed = screen.getByRole('list', { name: 'Сообщения чата' })
    expect(within(feed).getByText('Сайт на паузе или отключён.')).toBeTruthy()
    expect(within(feed).queryByRole('button', { name: 'Выпустить новую версию' })).toBeNull()
    expect(within(feed).queryByRole('button', { name: 'Обновить рабочую копию' })).toBeNull()
    expect(within(feed).getByRole('button', { name: 'Посмотреть изменения' })).toBeTruthy()
  })

  it('keeps `/cancel` in the window of commands of a closed project: the one way to stop a chat that waits', async () => {
    calls.feed.mockResolvedValue(waiting({ commands: closedVerdicts() }))
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DialogView project={{ ...PROJECT, closed: true }} taskId={TASK_ID} title={null} />
      </QueryClientProvider>,
    )
    await screen.findByText('Изменения готовы')
    expect(field().disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Остановить' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
    const release = option(/^Выпустить/u)
    expect(release.getAttribute('aria-disabled')).toBe('true')
    expect(release.textContent).toContain('Сайт на паузе или отключён.')
    fireEvent.click(option(/^Отменить чат/u))
    const confirm = await screen.findByRole('dialog', { name: 'Отменить чат?' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Отменить чат' }))
    await waitFor(() => expect(calls.cancel).toHaveBeenCalledTimes(1))
  })

  it.each([
    ['step', 'Остановиться', null],
    ['credits', 'Остановить задачу', 'Купить пакет'],
  ] as const)(
    'offers no «Продолжить» on the question (%s) of a project closed since the page opened (К39)',
    async (reason, stop, buy) => {
      showDialog(
        feedAnswer({
          status: 'awaiting_user',
          task: { turnNo: 1 },
          commands: closedVerdicts(),
          events: [requestRow('1'), ceilingRow('2', 1, reason)],
          cursor: '2',
        }),
      )
      const stopButton = await screen.findByRole('button', { name: stop })
      expect(screen.queryByRole('button', { name: 'Продолжить' })).toBeNull()
      if (buy !== null) expect(screen.getByRole('link', { name: buy })).toBeTruthy()
      // The page was loaded with the project open: the feed closes the field all the same.
      expect(field().disabled).toBe(true)
      fireEvent.click(stopButton)
      expect(await screen.findByRole('dialog', { name: 'Отменить чат?' })).toBeTruthy()
      expect(calls.proceed).not.toHaveBeenCalled()
    },
  )

  it('still stops a turn under way in a chat of a closed project (К39): only words are closed', async () => {
    calls.feed.mockResolvedValue(
      feedAnswer({
        status: 'running',
        task: { turnNo: 1, runningSince: '2026-10-17T09:01:00.000Z' },
        events: [requestRow('1')],
        cursor: '1',
      }),
    )
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DialogView project={{ ...PROJECT, closed: true }} taskId={TASK_ID} title={null} />
      </QueryClientProvider>,
    )
    const stop = await screen.findByRole<HTMLButtonElement>('button', { name: 'Остановить' })
    await waitFor(() => expect(stop.disabled).toBe(false))
    expect(field().disabled).toBe(true)
    fireEvent.click(stop)
    const confirm = screen.getByRole('dialog', { name: 'Отменить чат?' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Отменить чат' }))
    await waitFor(() => expect(calls.cancel).toHaveBeenCalledTimes(1))
    expect(calls.cancel.mock.calls[0]![0]).toMatchObject({ taskId: TASK_ID })
  })

  it('changes how hard the model thinks from the agent’s next turn', async () => {
    calls.setEffort.mockResolvedValueOnce({ effort: 'max' })
    showDialog()
    await screen.findByText('Изменения готовы')
    fireEvent.click(screen.getByRole('button', { name: 'Размышление: Высокое' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Максимальное/ }))
    await waitFor(() => expect(calls.setEffort).toHaveBeenCalledTimes(1))
    expect(calls.setEffort.mock.calls[0]![0]).toEqual({ taskId: TASK_ID, effort: 'max' })
    expect(screen.getByRole('button', { name: 'Размышление: Максимальное' })).toBeTruthy()
  })

  it('renames the dialog in place, and deletes it after asking', async () => {
    calls.rename.mockResolvedValueOnce({ title: 'Цена латте' })
    calls.remove.mockResolvedValueOnce({ removed: true })
    showDialog()
    await screen.findByText('Изменения готовы')
    const menu = () =>
      screen.getByRole('button', { name: 'Действия с чатом: Поменять цену капучино' })

    fireEvent.click(menu())
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Переименовать' }))
    const name = screen.getByRole('textbox', { name: 'Название чата' })
    fireEvent.change(name, { target: { value: '  Цена   латте ' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    await waitFor(() => expect(calls.rename).toHaveBeenCalledTimes(1))
    expect(calls.rename.mock.calls[0]![0]).toEqual({ taskId: TASK_ID, title: 'Цена латте' })

    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Название чата' })).toBeNull())
    fireEvent.click(menu())
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Удалить' }))
    const ask = await screen.findByRole('dialog', { name: 'Удалить чат?' })
    expect(plain(ask.textContent)).toContain('То, что агент уже сделал на сайте, останется.')
    fireEvent.click(within(ask).getByRole('button', { name: 'Удалить' }))
    await waitFor(() => expect(calls.remove).toHaveBeenCalledTimes(1))
    expect(calls.remove.mock.calls[0]![0]).toEqual({ taskId: TASK_ID })
    // The page of a deleted dialog leaves for the root of «Чаты».
    await waitFor(() => expect(calls.replace).toHaveBeenCalledWith('/chats'))
  })

  it('sends words as a new pass on top of the changes and reads the dialog again', async () => {
    showDialog()
    await screen.findByText('Изменения готовы')
    type('А ещё поменяйте цену латте')
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    await waitFor(() => expect(calls.message).toHaveBeenCalledTimes(1))
    expect(calls.message.mock.calls[0]![0]).toEqual({
      taskId: TASK_ID,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      text: 'А ещё поменяйте цену латте',
    })
    await waitFor(() => expect(calls.feed).toHaveBeenCalledTimes(2))
    expect(calls.feed.mock.calls[1]![0]).toEqual({ taskId: TASK_ID, after: '3' })
    await waitFor(() => expect(field().value).toBe(''))
  })

  it('sends files with the words of a dialog on the copy of the site, as in the browser', async () => {
    showDialog()
    await screen.findByText('Изменения готовы')
    fireEvent.change(screen.getByTestId('composer-files'), {
      target: { files: [new File([new Uint8Array(16)], 'Фото.jpg', { type: 'image/jpeg' })] },
    })
    await screen.findByRole('list', { name: 'Файлы к сообщению' })
    type('Поставьте это фото на главную')
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Отправить' })
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(calls.message).toHaveBeenCalledTimes(1))
    expect(calls.message.mock.calls[0]![0]).toMatchObject({
      text: 'Поставьте это фото на главную',
      attachments: [ATTACHMENT_ID],
    })
  })

  it('runs `/reset` without sending its words', async () => {
    showDialog()
    await run(/Сбросить данные предпросмотра/)
    await waitFor(() => expect(calls.reset).toHaveBeenCalledTimes(1))
    expect(calls.reset.mock.calls[0]![0]).toEqual({
      taskId: TASK_ID,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect(calls.message).not.toHaveBeenCalled()
    expect(field().value).toBe('')
  })

  it('runs `/update`, and says a refusal of the server in its words', async () => {
    calls.update.mockRejectedValueOnce(
      serverRefusal('Сначала ответьте на вопрос в чате', 'CHAT_COMMAND_UNAVAILABLE'),
    )
    showDialog()
    await run(/Обновить рабочую копию/)
    // Opening the window reads the verdicts again.
    await waitFor(() => expect(calls.feed).toHaveBeenCalledTimes(2))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Сначала ответьте на вопрос в чате.',
    )
    expect(calls.update).toHaveBeenCalledTimes(1)
    // The verdicts may have changed with the refusal: the dialog is read once more.
    await waitFor(() => expect(calls.feed).toHaveBeenCalledTimes(3))
  })

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

    it('`/new` starts a chat of the same project, without one where the chat has none', async () => {
      showDialog()
      await run(/Новый чат/)
      expect(calls.push).toHaveBeenCalledWith(`/chats/new?project=${SITE_ID}`)
      cleanup()
      calls.push.mockClear()
      showDialog(waiting(), null, null)
      await run(/Новый чат/)
      expect(calls.push).toHaveBeenCalledWith('/chats/new')
    })

    it('`/sessions` leads to the list of chats, and its other words do too', async () => {
      showDialog()
      await screen.findByText('Изменения готовы')
      type('/resume')
      fireEvent.keyDown(field(), { key: 'Enter' })
      expect(calls.push).toHaveBeenCalledWith('/chats')
      expect(calls.message).not.toHaveBeenCalled()
    })

    it('`/export` saves what the server wrote out as a file, and says so', async () => {
      const blobs: Blob[] = []
      const clicked: { name: string; href: string }[] = []
      Object.assign(URL, {
        createObjectURL: (blob: Blob) => {
          blobs.push(blob)
          return 'blob:chat'
        },
        revokeObjectURL: vi.fn(),
      })
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        clicked.push({ name: this.download, href: this.href })
      })
      calls.exported.mockResolvedValue({ fileName: 'Цена капучино.md', markdown: '# Цена\n' })
      showDialog()
      await run(/Скачать переписку/)
      await waitFor(() =>
        expect(clicked).toEqual([{ name: 'Цена капучино.md', href: 'blob:chat' }]),
      )
      expect(calls.exported).toHaveBeenCalledWith({ taskId: TASK_ID })
      expect(await blobs[0]!.text()).toBe('# Цена\n')
      expect(blobs[0]!.type).toBe('text/markdown;charset=utf-8')
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:chat')
      await screen.findByText('Переписка сохранена')
      click.mockRestore()
    })

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

    it('`/models` of a chat that has ended promises no change of the level', async () => {
      showDialog(
        waiting({ status: 'done', commands: verdicts({ undo: null, cancel: 'finished' }) }),
      )
      await screen.findByText('Изменения готовы')
      const efforts = await openedEfforts()
      expect(efforts.getByText('Чат завершён: уровень уже не поменять.')).toBeTruthy()
      expect(efforts.queryByText('Уровень можно поменять, пока чат ждёт вас.')).toBeNull()
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
      await screen.findByRole('heading', { name: 'Ход работы' })
      await screen.findByText('Подробности работы показаны')
      cleanup()
      showDialog(worked)
      await screen.findByText('Поменяйте цену')
      await waitFor(() => expect(line().open).toBe(true))
    })

    it('`/help` opens the whole list and sends nothing', async () => {
      showDialog()
      await screen.findByText('Изменения готовы')
      type('/help')
      fireEvent.keyDown(field(), { key: 'Enter' })
      expect(
        within(screen.getByRole('listbox', { name: 'Команды' })).getAllByRole('option').length,
      ).toBeGreaterThan(10)
      expect(field().value).toBe('')
      expect(calls.message).not.toHaveBeenCalled()
    })

    it('stay with a closed project: it is read, and it refuses only what works on it', async () => {
      showDialog(waiting({ commands: verdicts({ release: 'project_closed' }) }))
      await screen.findByText('Изменения готовы')
      fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
      expect(option(/Скачать переписку/).getAttribute('aria-disabled')).toBeNull()
      expect(option(/Выпустить новую версию/).getAttribute('aria-disabled')).toBe('true')
    })
  })

  it('finds «Отменить выпуск» by `/rollback`, and `/undo` is the last request now', async () => {
    showDialog(waiting({ status: 'done', commands: verdicts({ undo: null, cancel: 'finished' }) }))
    await screen.findByText('Изменения готовы')
    fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
    expect(option(/Отменить выпуск/).textContent).toContain('/rollback')
    expect(option(/Отменить последний запрос/).textContent).toContain('/undo')
  })

  it('asks before `/cancel` closes the dialog', async () => {
    showDialog()
    await run(/Отменить чат/)
    const confirm = screen.getByRole('dialog', { name: 'Отменить чат?' })
    expect(plain(confirm.textContent)).toContain(
      'Чат завершится, а агент остановится, если ещё работает. Подготовленные изменения на сайт не попадут.',
    )
    expect(calls.cancel).not.toHaveBeenCalled()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Отменить чат' }))
    await waitFor(() => expect(calls.cancel).toHaveBeenCalledTimes(1))
    expect(calls.cancel.mock.calls[0]![0]).toMatchObject({ taskId: TASK_ID })
  })

  it('opens the release from `/release` and from the card of the changes', async () => {
    showDialog()
    await run(/Выпустить новую версию/)
    expect(await screen.findByRole('dialog', { name: 'Выпустить новую версию' })).toBeTruthy()
    expect(calls.prepare).toHaveBeenCalledWith({ taskId: TASK_ID })
  })

  it('shows a command the server refuses as one that cannot be chosen', async () => {
    showDialog(waiting({ commands: verdicts({ release: 'checks_failed' }) }))
    await screen.findByText('Изменения готовы')
    type('/')
    const release = option(/Выпустить новую версию/)
    expect(release.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(release)
    expect(screen.queryByRole('dialog')).toBeNull()
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
    expect(screen.getAllByText('Нужен ваш ответ').length).toBeGreaterThan(0)
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
  describe('after a failed pass that kept the changes', () => {
    const failure: FeedRow = {
      id: '4',
      at: '2026-10-17T09:05:00.000Z',
      type: 'feed.failure',
      turn: 2,
      code: 'technical',
      site: 'unchanged',
      credits: null,
      next: 'awaiting_approval',
    }
    const kept = (canRetry: boolean) =>
      waiting({
        task: { turnNo: 2, canRetry },
        events: [requestRow('1'), resultRow('2', 1), candidateRow('3', 1), failure],
        cursor: '4',
        commands: verdicts(canRetry ? { retry: null } : { retry: 'nothing_to_retry' }),
      })

    it('offers no «Попробовать ещё» when the project is closed (К39)', async () => {
      showDialog({
        ...kept(true),
        commands: verdicts({ retry: 'project_closed', release: 'project_closed' }),
      })
      await screen.findByText('Изменения готовы')
      expect(screen.queryByRole('button', { name: 'Попробовать ещё' })).toBeNull()
    })

    it('offers «Попробовать ещё» on the failure, keeps the field and the release open', async () => {
      showDialog(kept(true))
      const button = await screen.findByRole('button', { name: 'Попробовать ещё' })
      expect(field().disabled).toBe(false)
      expect(screen.getByRole('button', { name: 'Выпустить новую версию' })).toBeTruthy()
      // The live region says the failure: the status «Ждёт вашего решения» did not change, and
      // the dialog is not `failed`, so its label is not said before the sentence.
      expect(
        screen.getByText(
          'Не получилось выполнить задачу из-за технического сбоя. Изменения, готовые до этого, мы сохранили.',
        ),
      ).toBeTruthy()
      expect(screen.queryByText(/Не получилось\. Не получилось/)).toBeNull()
      // The answer to the first press is lost: the next press is a repeat of it, under its id.
      calls.retry.mockRejectedValueOnce(new Error('lost'))
      fireEvent.click(button)
      await waitFor(() => expect(calls.retry).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
      fireEvent.click(button)
      await waitFor(() => expect(calls.retry).toHaveBeenCalledTimes(2))
      const [first, second] = calls.retry.mock.calls.map(([input]) => input)
      expect(first).toMatchObject({ taskId: TASK_ID, failureEventId: '4' })
      expect(second!.requestId).toBe(first!.requestId)
    })

    it('runs `/retry` from the window of commands', async () => {
      showDialog(kept(true))
      await run(/Попробовать ещё/)
      await waitFor(() => expect(calls.retry).toHaveBeenCalledTimes(1))
      expect(calls.retry.mock.calls[0]![0]).toMatchObject({ failureEventId: '4' })
    })

    it('neither offers nor lists it when the server does not', async () => {
      showDialog(kept(false))
      await screen.findAllByText(/Изменения, готовые до этого, мы сохранили/)
      expect(screen.queryByRole('button', { name: 'Попробовать ещё' })).toBeNull()
      await waitFor(() => expect(field().disabled).toBe(false))
      type('/')
      expect(
        within(screen.getByRole('listbox', { name: 'Команды' })).queryByRole('option', {
          name: /Попробовать ещё/,
        }),
      ).toBeNull()
    })
  })

  it('keeps the field closed while a release is installed, and says why', async () => {
    showDialog(
      feedAnswer({
        status: 'deploying',
        release: {
          id: '0199a3f2-0000-7000-8000-0000000000d1',
          status: 'deploying',
          step: 'backup',
          version: 'v1.4.0',
          outcome: null,
        },
      }),
    )
    expect(
      await screen.findByText('Написать можно будет, когда установка закончится.'),
    ).toBeTruthy()
    expect(plain(screen.getByRole('banner').textContent)).toContain(
      'Версия 1.4.0: устанавливаем на сайт',
    )
  })

  it('keeps «Отменить выпуск» of a closed dialog behind the button of a field that takes no words', async () => {
    calls.undoPrepare.mockResolvedValue({ planId: '0199a3f2-0000-7000-8000-0000000000f1' })
    showDialog(
      feedAnswer({
        status: 'done',
        events: [requestRow('1')],
        cursor: '1',
        undo: {
          releaseId: '0199a3f2-0000-7000-8000-0000000000d1',
          version: 'v1.4.0',
          installedNow: true,
          until: new Date('2026-10-25T11:30:00.000Z'),
          run: null,
        },
        commands: verdicts({
          release: 'finished',
          preview: 'preview_unavailable',
          reset: 'finished',
          update: 'finished',
          cancel: 'finished',
          undo: null,
        }),
      }),
    )
    const button = await screen.findByRole('button', { name: 'Команды' })
    expect(field().disabled).toBe(true)
    expect(screen.getByRole('link', { name: 'Новый чат' })).toBeTruthy()
    fireEvent.click(button)
    fireEvent.click(option(/Отменить выпуск/))
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Отменить выпуск 1.4.0?' }),
    ).toBeTruthy()
    await waitFor(() =>
      expect(calls.undoPrepare).toHaveBeenCalledWith({
        taskId: TASK_ID,
        releaseId: '0199a3f2-0000-7000-8000-0000000000d1',
      }),
    )
  })

  it('ends with a way to a new dialog', async () => {
    showDialog(
      feedAnswer({
        status: 'done',
        events: [requestRow('1')],
        cursor: '1',
        commands: verdicts({
          release: 'finished',
          preview: 'preview_unavailable',
          reset: 'finished',
          update: 'finished',
          cancel: 'finished',
        }),
      }),
    )
    // The field stays, closed: it says the dialog has ended, read aloud with the reason.
    const closed = await screen.findByRole('textbox', { name: 'Сообщение' })
    expect((closed as HTMLTextAreaElement).disabled).toBe(true)
    expect(closed.getAttribute('placeholder')).toBe('Чат завершён')
    expect(
      screen.getByText('Чат завершён. Чтобы попросить что-то ещё, начните новый.'),
    ).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Новый чат' }).getAttribute('href')).toBe(
      `/chats/new?project=${SITE_ID}`,
    )
    // The level of a dialog that has ended is no longer changed.
    expect(
      (screen.getByRole('button', { name: 'Размышление: Высокое' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('says when there is no such dialog', async () => {
    calls.feed.mockRejectedValue(
      Object.assign(new Error('Not found'), { data: { code: 'NOT_FOUND', domainCode: null } }),
    )
    const queryClient = new QueryClient()
    render(
      <QueryClientProvider client={queryClient}>
        <DialogView project={PROJECT} taskId={TASK_ID} title={null} />
      </QueryClientProvider>,
    )
    expect(await screen.findByRole('heading', { name: 'Такого чата нет' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'К чатам' }).getAttribute('href')).toBe('/chats')
  })

  it('repeats the same words after a lost answer under the same id, and other words under a new one', async () => {
    calls.message.mockRejectedValueOnce(network()).mockRejectedValueOnce(network())
    showDialog()
    await screen.findByText('Изменения готовы')
    type('Поменяйте цену латте')
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    expect((await screen.findByRole('alert')).textContent).toBe(NETWORK_TEXT)
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    await waitFor(() => expect(calls.message).toHaveBeenCalledTimes(2))
    const [first, again] = calls.message.mock.calls.map(([input]) => input.requestId)
    expect(again).toBe(first)
    type('Поменяйте цену латте и раф')
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    await waitFor(() => expect(calls.message).toHaveBeenCalledTimes(3))
    expect(calls.message.mock.calls[2]![0].requestId).not.toBe(first)
  })

  it('never takes words after the dialog moved on for a repeat of words before', async () => {
    // The answer to the first words is lost after the server wrote them: the dialog goes to work
    // and comes back with the changes, and the feed shows the words under their id.
    calls.message.mockRejectedValueOnce(network())
    const firstId = () => calls.message.mock.calls[0]![0].requestId
    const words = 'Поменяйте цену латте'
    calls.feed
      .mockResolvedValueOnce(waiting())
      .mockImplementationOnce(async () =>
        feedAnswer({
          status: 'queued',
          task: { turnNo: 1 },
          candidate: candidateHead,
          events: [revisionRow('4', firstId(), words)],
          cursor: '4',
        }),
      )
      .mockImplementation(async () =>
        waiting({
          task: { turnNo: 2 },
          events: [
            requestRow('1'),
            resultRow('2', 1),
            candidateRow('3', 1),
            revisionRow('4', firstId(), words),
            resultRow('5', 2, 'Поменял цену латте.'),
          ],
          cursor: '5',
        }),
      )
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <DialogView project={PROJECT} taskId={TASK_ID} title={null} />
      </QueryClientProvider>,
    )
    await screen.findByText('Изменения готовы')
    type(words)
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    expect((await screen.findByRole('alert')).textContent).toBe(NETWORK_TEXT)
    // The dialog has been in work and waits again with what the agent did.
    expect(await screen.findByText('Поменял цену латте.')).toBeTruthy()
    await waitFor(() => expect(field().disabled).toBe(false))
    // The same words once more are a new message now, not a repeat of the first.
    type(words)
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    await waitFor(() => expect(calls.message).toHaveBeenCalledTimes(2))
    expect(calls.message.mock.calls[1]![0].requestId).not.toBe(firstId())
  })

  it('says the refusal of the last thing pressed, not of words sent before it', async () => {
    calls.message.mockRejectedValueOnce(network())
    calls.update.mockRejectedValueOnce(
      serverRefusal('Рабочая копия уже на текущей версии сайта', 'CHAT_COMMAND_UNAVAILABLE'),
    )
    showDialog()
    await screen.findByText('Изменения готовы')
    type('Поменяйте цену латте')
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    expect((await screen.findByRole('alert')).textContent).toBe(NETWORK_TEXT)
    type('/')
    fireEvent.click(option(/Обновить рабочую копию/))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'Рабочая копия уже на текущей версии сайта.',
      ),
    )
  })

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

  it('reads the checks again when their numbers in the head move', async () => {
    let later!: (answer: DialogFeed) => void
    // The checks end on the server when the head says so, not before.
    let ended = false
    calls.candidate.mockImplementation(async () => candidateWith(ended ? 'passed' : 'pending'))
    calls.feed
      .mockResolvedValueOnce(waiting({ candidate: checksOf('pending'), more: true }))
      .mockReturnValueOnce(new Promise((resolve) => (later = resolve)))
      .mockResolvedValue(waiting({ candidate: checksOf('passed') }))
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <DialogView project={PROJECT} taskId={TASK_ID} title={null} />
      </QueryClientProvider>,
    )
    await screen.findByText('Изменения готовы')
    await choose(/^Проверки/)
    expect(await screen.findByText('Идёт')).toBeTruthy()
    ended = true
    later(waiting({ candidate: checksOf('passed') }))
    expect(await screen.findByText('Пройдена')).toBeTruthy()
    expect(screen.queryByText('Идёт')).toBeNull()
  })

  it('starts with the dialog alone, «+» of its tools in the head', async () => {
    showDialog(
      feedAnswer({
        status: 'awaiting_user',
        task: { turnNo: 1 },
        preview: readyPreview,
        candidate: null,
        events: [requestRow('1')],
        cursor: '1',
      }),
    )
    await screen.findByRole('textbox', { name: 'Сообщение' })
    expect(toolsPanel()).toBeNull()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'Инструменты' })).toBe(
      plus(),
    )
    expect(plus().getAttribute('aria-haspopup')).toBe('menu')
    expect(plus().getAttribute('aria-expanded')).toBe('false')
    // One «+» on the screen: the field attaches files by its paperclip (docs/plan/59, И15).
    const plusSign = outlineOf('plus')
    expect(
      screen
        .getAllByRole('button')
        .filter((button) => outline(button) === plusSign)
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Инструменты'])
    expect(outline(screen.getByRole('button', { name: 'Прикрепить файлы' }))).toBe(
      outlineOf('attach'),
    )
  })

  it('shows the changes in place of the dialog below `lg`, «К чату» leading back (И14)', async () => {
    showDialog()
    await screen.findByText('Изменения готовы')
    const heading = screen.getByRole('heading', { level: 1, name: 'Поменять цену капучино' })
    const textarea = field()
    fireEvent.click(screen.getByRole('button', { name: 'Посмотреть изменения' }))
    const tab = await screen.findByRole('tab', { name: 'Файлы', selected: true })
    expect(within(pane()).getByRole('tabpanel')).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(tab))
    // The tool takes the place of the dialog: its head, rows and field are hidden, never gone.
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
    expect(screen.queryByRole('list', { name: 'Сообщения чата' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Сообщение' })).toBeNull()
    expect(heading.isConnected).toBe(true)
    // «К чату» and «+» over the one strip of tabs: no «Диалог | Изменения», no edge to drag,
    // no «Скрыть панель».
    expect(screen.getAllByRole('tablist')).toHaveLength(1)
    expect(within(pane()).getByRole('button', { name: /^Инструменты/ })).toBe(plus())
    expect(within(pane()).queryByRole('button', { name: 'Скрыть панель' })).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
    fireEvent.click(within(pane()).getByRole('button', { name: 'К чату' }))
    await waitFor(() => expect(toolsPanel()).toBeNull())
    // The same dialog again, the focus on «+» of its head.
    expect(screen.getByRole('heading', { level: 1, name: 'Поменять цену капучино' })).toBe(heading)
    expect(field()).toBe(textarea)
    await waitFor(() => expect(document.activeElement).toBe(plus()))
    expect(within(screen.getByRole('banner')).getByRole('button', { name: /^Инструменты/ })).toBe(
      plus(),
    )
  })
})

/** A dialog under way whose preview is ready, and no changes yet. */
const started = () =>
  feedAnswer({
    status: 'awaiting_user',
    task: { turnNo: 1 },
    preview: readyPreview,
    candidate: null,
    events: [requestRow('1'), resultRow('2', 1)],
    cursor: '2',
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
      <DialogView
        project={PROJECT}
        taskId={TASK_ID}
        title="Поменять цену капучино"
        browserStreamUrl={streamUrl}
      />
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
  const BOTH = { repository: true, browser: true }
  const NEITHER = { repository: false, browser: false }
  /** What a chat without the repository lists: no group «Сайт», no `/retry` (К27). */
  const WITHOUT_REPOSITORY = [
    /^\/undoОтменить последний запросНедоступна/u,
    /^\/redoВернуть отменённый запросНедоступна/u,
    /^\/cancelОтменить чат/u,
    /^\/newНовый чат/u,
    /^\/sessionsВсе чаты/u,
    /^\/exportСкачать переписку/u,
    /^\/modelsМодель и размышление/u,
    /^\/detailsПодробности работы/u,
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
      commands: verdicts({ retry: 'nothing_to_retry' }),
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

  it('a chat with the repository alone: no words of files, «+» or the browser without changes', async () => {
    showDialog(answered({ repository: true, browser: false }))
    await screen.findByText('Вот пять вариантов.')
    expect(toolsPanel()).toBeNull()
    expect(screen.queryByRole('button', { name: /^Инструменты/ })).toBeNull()
    expect(document.body.textContent).not.toMatch(/Изменено файлов|Файлы и изменения|Браузер/u)
    const listed = listedCommands().join(' ')
    expect(listed).toContain('Выпустить новую версию')
    expect(listed).toContain('Открыть предпросмотр')
    expect(listed).toContain('Отменить чат')
    // The words of the site's variables stand where the project has them.
    expect(hint()).toContain('доступы задаются в разделе «Переменные»')
  })

  it('a chat with the code and the browser: every tool, the browser last, the panel closed', async () => {
    wideLayout()
    showDialog(
      browserAnswer({
        status: 'awaiting_approval',
        task: { requirements: BOTH },
        preview: readyPreview,
        candidate: candidateHead,
        commands: verdicts(),
        events: [requestRow('1'), resultRow('2', 1), candidateRow('3', 1)],
        cursor: '3',
      }),
      STREAM_URL,
    )
    await screen.findByText('Изменения готовы')
    // The panel stays closed at the start of a showing (И1), no stream, no frame, no changes read.
    expect(toolsPanel()).toBeNull()
    expect(calls.streamTicket).not.toHaveBeenCalled()
    expect(calls.candidate).not.toHaveBeenCalled()
    expect(document.querySelector('iframe')).toBeNull()
    expect(await menuTiles()).toEqual([
      'Предпросмотр',
      'Файлы и изменения, 4',
      'База данных, 3',
      'Проверки, 2 из 2',
      'Браузер, Агент ответил',
    ])
    // The commands of the site are there: the browser takes nothing from the code.
    const listed = listedCommands().join(' ')
    expect(listed).toContain('Выпустить новую версию')
    expect(listed).toContain('Открыть предпросмотр')
    expect(listed).toContain('Отменить чат')
    expect(hint()).toContain('вход в админку сохраните в разделе «Переменные»')
    // «Посмотреть изменения» goes to the changes, never to the browser.
    fireEvent.click(screen.getByRole('button', { name: 'Посмотреть изменения' }))
    await waitFor(() => expect(tabNames()).toEqual(['Файлы']))
  })

  it('stops a chat with the code and the browser that waits: `/release` waits with it', async () => {
    const answer = browserAnswer({
      status: 'awaiting_approval',
      task: { requirements: BOTH },
      candidate: candidateHead,
      // As the server answers while the press stands in the feed (`cancelPending`).
      commands: verdicts({
        release: 'finished',
        preview: 'finished',
        update: 'finished',
        reset: 'finished',
      }),
      events: [requestRow('1'), resultRow('2', 1), candidateRow('3', 1), commandRow('4', 'cancel')],
      cursor: '4',
    })
    showDialog(answer)
    await screen.findByText('Изменения готовы')
    // core has not ended the chat yet, and the press stands in the feed: nothing else is taken.
    await waitFor(() => expect(field().disabled).toBe(true))
    expect(field().getAttribute('placeholder')).not.toBe('Что нужно сделать?')
    expect(screen.queryByRole('button', { name: 'Выпустить новую версию' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
    expect(option(/Отменить чат/).getAttribute('aria-disabled')).toBe('true')
    expect(option(/Выпустить новую версию/).getAttribute('aria-disabled')).toBe('true')
  })

  it('closes `/release` on the card from the press of `/cancel`, before the feed is read again', async () => {
    calls.cancel.mockResolvedValue({ ...posted, state: 'stopping' })
    showDialog(
      browserAnswer({
        status: 'awaiting_approval',
        task: { requirements: BOTH },
        candidate: candidateHead,
        commands: verdicts(),
        events: [requestRow('1'), resultRow('2', 1), candidateRow('3', 1)],
        cursor: '3',
      }),
    )
    const release = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Выпустить новую версию',
    })
    expect(release.disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
    fireEvent.click(option(/Отменить чат/))
    const confirm = screen.getByRole('dialog', { name: 'Отменить чат?' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Отменить чат' }))
    await waitFor(() => expect(calls.cancel).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(field().disabled).toBe(true))
    expect(release.disabled).toBe(true)
  })

  it.each([
    [
      'the code alone, with changes',
      { repository: true, browser: false },
      candidateHead,
      'https://kroshka.example',
      ['Подготовленные изменения на сайт не попадут.'],
      ['проверьте сайт'],
    ],
    [
      'the code alone, nothing ready yet',
      { repository: true, browser: false },
      null,
      'https://kroshka.example',
      [],
      ['проверьте сайт', 'Подготовленные'],
    ],
    [
      'the code and the browser',
      BOTH,
      candidateHead,
      'https://kroshka.example',
      [
        'Подготовленные изменения на сайт не попадут.',
        'То, что он уже сделал на сайте, останется: проверьте сайт.',
      ],
      [],
    ],
    [
      'the browser on a project',
      { repository: false, browser: true },
      null,
      'https://kroshka.example',
      ['То, что он уже сделал на сайте, останется: проверьте сайт.'],
      ['Подготовленные'],
    ],
    [
      'the browser without a project',
      { repository: false, browser: true },
      null,
      null,
      [],
      ['сайт'],
    ],
  ] as const)(
    'says what cancelling leaves of a chat with %s',
    async (_what, requirements, candidate, url, says, never) => {
      showDialog(
        browserAnswer({
          status: 'awaiting_user',
          task: { requirements },
          candidate,
          commands: verdicts(),
          events: [
            requestRow('1'),
            { ...resultRow('2', 1, 'Готово.'), next: 'awaiting_user' } as FeedRow,
          ],
          cursor: '2',
        }),
        null,
        url,
      )
      await screen.findByText('Готово.')
      fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
      fireEvent.click(option(/Отменить чат/))
      const words = plain(screen.getByRole('dialog', { name: 'Отменить чат?' }).textContent)
      expect(words).toContain('Чат завершится, а агент остановится, если ещё работает.')
      for (const line of says) expect(words).toContain(line)
      for (const line of never) expect(words).not.toContain(line)
    },
  )

  it('calls an answer an answer on the tile of a chat with the code and the browser', async () => {
    showDialog(
      browserAnswer({
        status: 'awaiting_user',
        task: { requirements: BOTH },
        commands: verdicts(),
        events: [
          requestRow('1'),
          { ...resultRow('2', 1, 'Готово.'), next: 'awaiting_user' } as FeedRow,
        ],
        cursor: '2',
      }),
      STREAM_URL,
    )
    await screen.findByText('Готово.')
    expect(await menuTiles()).toEqual(['Браузер, Агент ответил'])
  })

  it('gives the panel of a browser beside the open changes to the client who asks for it', async () => {
    wideLayout()
    showDialog(
      browserAnswer({
        status: 'awaiting_approval',
        task: { requirements: BOTH },
        preview: readyPreview,
        candidate: candidateHead,
        commands: verdicts(),
        events: [requestRow('1'), resultRow('2', 1), candidateRow('3', 1)],
        cursor: '3',
      }),
      STREAM_URL,
    )
    await screen.findByText('Изменения готовы')
    await choose(/^Файлы и изменения/)
    expect(calls.streamTicket).not.toHaveBeenCalled()
    await choose(/^Браузер/)
    expect(tabNames()).toEqual(['Файлы', 'Браузер'])
    // The real panel of the browser, on the one stream it reads.
    await waitFor(() => expect(sockets).toHaveLength(1))
    expect(calls.streamTicket).toHaveBeenCalledTimes(1)
    connect(sockets[0]!, 'agent')
    expect(within(pane()).getAllByRole('button', { name: 'Взять управление' })).not.toEqual([])
    expect(within(pane()).getByLabelText('Адрес страницы').textContent).toContain('kroshka.example')
    // Back on the changes the browser stays open, its stream asleep behind them.
    fireEvent.click(screen.getByRole('tab', { name: 'Файлы' }))
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Браузер' }).getAttribute('aria-selected')).toBe(
        'false',
      ),
    )
    expect(tabNames()).toEqual(['Файлы', 'Браузер'])
  })

  describe('asked to sign in while the changes wait', () => {
    const help = { reason: 'login', message: null } as const
    const asks = (browser: Partial<FeedBrowserHead>) =>
      browserAnswer({
        status: 'awaiting_user',
        task: { requirements: BOTH },
        candidate: candidateHead,
        commands: verdicts(),
        browser: { help, ...browser },
        events: [requestRow('1'), browserQuestionRow('2', 1, 'login')],
        cursor: '2',
      })

    it('takes the control of the browser from the card, opening it', async () => {
      wideLayout()
      showDialog(asks({}), STREAM_URL)
      await screen.findByText('Нужно войти на сайт')
      expect(plusName()).toBe(DOT.browser)
      fireEvent.click(screen.getByRole('button', { name: 'Взять управление' }))
      await screen.findByRole('tab', { name: 'Браузер', selected: true })
      await waitFor(() => expect(sockets).toHaveLength(1))
      connect(sockets[0]!, 'agent')
      expect(sockets[0]!.sent).toContainEqual({ t: 'take' })
    })

    it('gives the browser back to the agent from the card', async () => {
      wideLayout()
      showDialog(asks({ controller: 'user' }), STREAM_URL)
      await screen.findByText('Нужно войти на сайт')
      fireEvent.click(screen.getByRole('button', { name: 'Продолжить работу агента' }))
      await waitFor(() => expect(calls.resumeAgent).toHaveBeenCalledTimes(1))
    })
  })

  it.each([
    ['on a project without its files', 'https://kroshka.example', 'вход в админку'],
    ['without a project', null, null],
  ] as const)(
    'a chat with the browser alone %s: the browser, /cancel',
    async (_what, url, words) => {
      showDialog(
        browserAnswer({ events: [requestRow('1', 'Добавьте новость')], cursor: '1' }),
        null,
        url,
      )
      await screen.findByText('Добавьте новость')
      expect(toolsPanel()).toBeNull()
      expect(await menuTiles()).toEqual(['Браузер, Работает агент'])
      expect(listedCommands()).toEqual(WITHOUT_REPOSITORY)
      if (words === null) expect(hint()).not.toContain('Переменные')
      else expect(hint()).toContain(words)
    },
  )

  it('a chat with neither: no tools, no commands of the site, no word of a project', async () => {
    showDialog(answered(NEITHER), null, null)
    await screen.findByText('Вот пять вариантов.')
    expect(screen.queryByRole('button', { name: /^Инструменты/ })).toBeNull()
    expect(screen.queryByRole('link', { name: /Открыть проект/ })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Открыть сайт' })).toBeNull()
    expect(screen.getByRole('list', { name: 'Сообщения чата' }).textContent).not.toMatch(
      /сайт|файл/iu,
    )
    expect(listedCommands()).toEqual(WITHOUT_REPOSITORY)
    expect(hint()).toContain('Не отправляйте в чат пароли и ключи')
    expect(hint()).not.toContain('Переменные')
  })

  it('takes a command of the site in a chat without the repository for none it has', async () => {
    showDialog(answered(NEITHER), null, null)
    await screen.findByText('Вот пять вариантов.')
    type('/release')
    expect(screen.queryByRole('listbox', { name: 'Команды' })).toBeNull()
    fireEvent.keyDown(field(), { key: 'Enter', ctrlKey: true })
    await screen.findByText(composerText.commandUnavailable)
    expect(calls.message).not.toHaveBeenCalled()
  })

  it('offers no /retry, /undo or commands of the site on a project without its files', async () => {
    const failure = {
      id: '2',
      at: '2026-10-17T10:00:00.000Z',
      type: 'feed.failure',
      turn: 1,
      code: 'technical',
      site: 'unchanged',
      credits: null,
      next: 'awaiting_user',
    } as unknown as FeedRow
    showDialog(
      browserAnswer({
        status: 'awaiting_user',
        task: { canRetry: true },
        // Each of them available or refused for a reason of its own: only the requirements say no.
        commands: verdicts({ undo: 'busy', retry: null, release: null, cancel: null }),
        events: [requestRow('1', 'Добавьте новость'), failure],
        cursor: '2',
      }),
    )
    await screen.findByText('Добавьте новость')
    expect(listedCommands()).toEqual(WITHOUT_REPOSITORY)
  })

  it('says what `/undo` does in a chat without the repository', async () => {
    showDialog(
      browserAnswer({
        status: 'awaiting_user',
        commands: verdicts({ turn_undo: null }),
        events: [requestRow('1', 'Добавьте новость')],
        cursor: '1',
      }),
    )
    await screen.findByText('Добавьте новость')
    type('/und')
    expect(option(/Отменить последний запрос/u).textContent).toContain(
      'Агент забудет последний запрос и ответ на него.',
    )
  })

  it('reads an ended chat without a project no words of the «Переменные» either', async () => {
    showDialog(
      browserAnswer({
        status: 'cancelled',
        commands: verdicts({ cancel: 'finished' }),
        events: [requestRow('1', 'Найдите цены')],
        cursor: '1',
      }),
      null,
      null,
    )
    await screen.findByText('Найдите цены')
    await waitFor(() => expect(field().disabled).toBe(true))
    expect(hint()).toContain('Не отправляйте в чат пароли и ключи')
    expect(hint()).not.toContain('Переменные')
  })

  it('sends no client without a project to the «Переменные» it does not have for a password', async () => {
    const refusal =
      'Похоже, в сообщении есть пароль или ключ. Не отправляйте их в чат — доступы задаются в разделе «Переменные»'
    calls.message.mockRejectedValue(serverRefusal(refusal, 'TASK_TEXT_HAS_SECRET'))
    showDialog(answered(NEITHER), null, null)
    await screen.findByText('Вот пять вариантов.')
    type('пароль: hunter2')
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Похоже, в сообщении есть пароль или ключ. Не отправляйте их в чат.',
    )
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
      null,
    )
    await screen.findByText('Нужно войти на сайт')
    expect(plain(document.body.textContent)).toContain(
      'Агенту нужно, чтобы вы вошли на сайт в браузере задачи.',
    )
    expect(document.body.textContent).not.toContain('админку')
  })

  it('says nothing of a site asking to cancel or to delete a chat without a project', async () => {
    showDialog(answered(NEITHER), null, null)
    await screen.findByText('Вот пять вариантов.')
    fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
    fireEvent.click(option(/Отменить чат/))
    const confirm = screen.getByRole('dialog', { name: 'Отменить чат?' })
    expect(plain(confirm.textContent)).toContain('Чат завершится, а агент остановится')
    expect(confirm.textContent).not.toContain('сайт')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Не отменять' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: /^Действия с чатом/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Удалить' }))
    const ask = await screen.findByRole('dialog', { name: 'Удалить чат?' })
    expect(plain(ask.textContent)).toContain('Чат пропадёт из списка')
    expect(ask.textContent).not.toContain('сайт')
  })
})

describe("the tools of a dialog (owner's request of 29.10.2026)", () => {
  it.each([
    ['below the wide layout', false],
    ['from `lg`', true],
  ])('start closed %s, with the changes ready', async (_width, wide) => {
    if (wide) wideLayout()
    showDialog(waiting({ preview: readyPreview }))
    await screen.findByText('Изменения готовы')
    // The changes open nothing by themselves (И1): no panel, no edge, no switch, nothing read —
    // and no mark the shell would leave an empty column for.
    expect(toolsPanel()).toBeNull()
    expect(document.querySelector('[data-chat-pane]')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('button', { name: 'К чату' })).toBeNull()
    // «+» in the head says they are there, by its dot and its name (И13).
    expect(within(screen.getByRole('banner')).getByRole('button', { name: DOT.changes })).toBe(
      plus(),
    )
    expect(plus().querySelector('[data-tools-dot]')).not.toBeNull()
    expect(calls.ticket).not.toHaveBeenCalled()
    expect(calls.candidate).not.toHaveBeenCalled()
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('opens the tool chosen in «+» on its own tab, and one chosen again without a second tab', async () => {
    wideLayout()
    showDialog(waiting({ preview: readyPreview }))
    await screen.findByText('Изменения готовы')
    expect(await menuTiles()).toEqual([
      'Предпросмотр',
      'Файлы и изменения, 4',
      'База данных, 3',
      'Проверки, 2 из 2',
    ])
    await choose(/^Файлы и изменения/)
    expect(tabNames()).toEqual(['Файлы'])
    const files = screen.getByRole('tab', { name: 'Файлы', selected: true })
    await waitFor(() => expect(document.activeElement).toBe(files))
    expect(screen.getByRole('separator', { name: 'Ширина панели' })).toBeTruthy()
    // «+» stands at the end of the tabs now, outside them: still one on the screen.
    expect(within(pane()).getByRole('button', { name: 'Инструменты' })).toBe(plus())
    expect(within(screen.getByRole('tablist')).queryByRole('button')).toBeNull()
    expect(await menuTiles()).toEqual([
      'Предпросмотр',
      'Файлы и изменения, Открыто',
      'База данных, 3',
      'Проверки, 2 из 2',
    ])
    await choose(/^Файлы и изменения/)
    expect(tabNames()).toEqual(['Файлы'])
    await choose(/^Проверки/)
    expect(tabNames()).toEqual(['Файлы', 'Проверки'])
    const checks = screen.getByRole('tab', { name: 'Проверки', selected: true })
    // A tab names its panel and the panel its tab, by the ids the stands find (И20).
    expect(checks.id).toBe('dialog-pane-tab-checks')
    expect(checks.getAttribute('aria-controls')).toBe('dialog-pane-panel-checks')
    expect(
      document.getElementById('dialog-pane-panel-checks')?.getAttribute('aria-labelledby'),
    ).toBe('dialog-pane-tab-checks')
    // A tab chosen on the strip is shown; nothing new opens by it.
    fireEvent.click(screen.getByRole('tab', { name: 'Файлы' }))
    expect(screen.getByRole('tab', { name: 'Файлы', selected: true })).toBeTruthy()
    expect(tabNames()).toEqual(['Файлы', 'Проверки'])
    // Chosen in «+» again while another tab is shown: its own tab comes back, not a second one.
    await choose(/^Проверки/)
    expect(tabNames()).toEqual(['Файлы', 'Проверки'])
    const shown = screen.getByRole('tab', { name: 'Проверки', selected: true })
    await waitFor(() => expect(document.activeElement).toBe(shown))
    // The panel is the one the shell leaves its room to.
    expect(document.querySelectorAll('[data-chat-pane]')).toHaveLength(1)
    expect(pane().hasAttribute('data-chat-pane')).toBe(true)
  })

  it('steps aside with the cross of its last tab: no panel, no edge, the focus back on «+»', async () => {
    wideLayout()
    showDialog()
    await screen.findByText('Изменения готовы')
    fireEvent.click(screen.getByRole('button', { name: 'Посмотреть изменения' }))
    const files = await screen.findByRole('tab', { name: 'Файлы', selected: true })
    expect(screen.getByRole('separator', { name: 'Ширина панели' })).toBeTruthy()
    // The cross is the pointer's way, hidden from a screen reader: the tab is one control.
    const cross = within(files).getByTitle('Закрыть вкладку «Файлы»')
    expect(cross.getAttribute('aria-hidden')).toBe('true')
    fireEvent.click(cross)
    await waitFor(() => expect(toolsPanel()).toBeNull())
    expect(screen.queryByRole('separator')).toBeNull()
    // The shell gives the dialog the room back: nothing of the panel is left to keep it.
    expect(document.querySelector('[data-chat-pane]')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(plus()))
    expect(plus().id).toBe('dialog-tools')
  })

  it('closes every tab by «Скрыть панель», a tab behind by its cross', async () => {
    wideLayout()
    showDialog()
    await screen.findByText('Изменения готовы')
    await choose(/^Файлы и изменения/)
    await choose(/^Проверки/)
    // The cross of a tab in the background: the tab on the screen stays.
    fireEvent.click(
      within(screen.getByRole('tab', { name: 'Файлы' })).getByTitle('Закрыть вкладку «Файлы»'),
    )
    expect(tabNames()).toEqual(['Проверки'])
    expect(screen.getByRole('tab', { name: 'Проверки', selected: true })).toBeTruthy()
    await choose(/^Файлы и изменения/)
    expect(tabNames()).toEqual(['Проверки', 'Файлы'])
    fireEvent.click(within(pane()).getByRole('button', { name: 'Скрыть панель' }))
    await waitFor(() => expect(toolsPanel()).toBeNull())
    expect(screen.queryByRole('separator')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(plus()))
  })

  it('closes the tab in focus by Delete: the focus on the tab shown instead, then on «+»', async () => {
    showDialog()
    await screen.findByText('Изменения готовы')
    await choose(/^Файлы и изменения/)
    await choose(/^Проверки/)
    const checks = screen.getByRole('tab', { name: 'Проверки' })
    expect(checks.getAttribute('aria-keyshortcuts')).toBe('Delete')
    checks.focus()
    fireEvent.keyDown(checks, { key: 'Delete' })
    expect(tabNames()).toEqual(['Файлы'])
    const files = screen.getByRole('tab', { name: 'Файлы', selected: true })
    await waitFor(() => expect(document.activeElement).toBe(files))
    fireEvent.keyDown(files, { key: 'Delete' })
    await waitFor(() => expect(toolsPanel()).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(plus()))
  })

  it.each([
    ['below `lg`, in the sheet', false],
    ['from `lg`, in the card', true],
  ])(
    'is used from the keyboard %s: the first tile in focus, the arrows, Esc and Tab back to «+», Enter and Space',
    async (_where, wide) => {
      if (wide) wideLayout()
      showDialog(waiting({ preview: readyPreview }))
      await screen.findByText('Изменения готовы')
      /** The key pressed where the focus is. */
      const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key })
      /** «+» pressed by Enter: in focus, clicked as a browser clicks it for a key (no mouse). */
      async function openByKeys() {
        plus().focus()
        fireEvent.click(plus(), { detail: 0 })
        const menu = await screen.findByRole('menu', { name: 'Инструменты' })
        const tiles = within(menu).getAllByRole('menuitem')
        // The menu takes the focus on its first tile.
        await waitFor(() => expect(document.activeElement).toBe(tiles[0]))
        return tiles
      }
      const tiles = await openByKeys()
      expect(tiles.map((tile) => plain(tile.textContent))).toEqual([
        'Предпросмотр',
        'Файлы и изменения, 4',
        'База данных, 3',
        'Проверки, 2 из 2',
      ])
      // The arrows go through the tiles in the order of reading, two columns or one.
      press('ArrowDown')
      expect(document.activeElement).toBe(tiles[1])
      press('ArrowDown')
      expect(document.activeElement).toBe(tiles[2])
      press('ArrowUp')
      expect(document.activeElement).toBe(tiles[1])
      press('End')
      expect(document.activeElement).toBe(tiles[3])
      press('Home')
      expect(document.activeElement).toBe(tiles[0])
      // Esc closes the menu, the focus back on «+», nothing opened.
      press('Escape')
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
      await waitFor(() => expect(document.activeElement).toBe(plus()))
      expect(plus().getAttribute('aria-expanded')).toBe('false')
      // Tab leaves it the same way.
      await openByKeys()
      press('Tab')
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
      await waitFor(() => expect(document.activeElement).toBe(plus()))
      expect(toolsPanel()).toBeNull()
      // Enter chooses a tile: the tool opens on its tab, the focus there.
      await openByKeys()
      press('ArrowDown')
      press('Enter')
      const files = await screen.findByRole('tab', { name: 'Файлы', selected: true })
      await waitFor(() => expect(document.activeElement).toBe(files))
      // So does Space, from «+» at the end of the tabs now.
      await openByKeys()
      press('End')
      const last = document.activeElement!
      fireEvent.keyDown(last, { key: ' ' })
      fireEvent.keyUp(last, { key: ' ' })
      const checks = await screen.findByRole('tab', { name: 'Проверки', selected: true })
      await waitFor(() => expect(document.activeElement).toBe(checks))
      expect(tabNames()).toEqual(['Файлы', 'Проверки'])
    },
  )

  it.each([
    ['below `lg`: a sheet from the bottom, the tool in place of the dialog', false],
    ['from `lg`: a card beside «+», the tool beside the dialog', true],
  ])('opens a tool from the menu of «+» %s', async (_how, wide) => {
    if (wide) wideLayout()
    showDialog()
    await screen.findByText('Изменения готовы')
    plus().focus()
    fireEvent.click(plus())
    const menu = await screen.findByRole('menu', { name: 'Инструменты' })
    expect(menu.closest(wide ? '.MuiPopover-paper' : '.MuiDrawer-paper')).not.toBeNull()
    // The tiles say the same on either width, the name first.
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => plain(item.textContent)),
    ).toEqual(['Файлы и изменения, 4', 'База данных, 3', 'Проверки, 2 из 2'])
    if (wide) {
      expect(screen.queryByRole('button', { name: 'Закрыть меню' })).toBeNull()
      fireEvent.keyDown(menu, { key: 'Escape' })
    } else {
      // Under a finger the sheet closes by its own button too.
      fireEvent.click(screen.getByRole('button', { name: 'Закрыть меню' }))
    }
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(plus()))
    await choose(/^Проверки/)
    expect(tabNames()).toEqual(['Проверки'])
    if (wide) {
      // The dialog stays beside the panel, the edge between them.
      expect(screen.getByRole('heading', { level: 1, name: 'Поменять цену капучино' })).toBeTruthy()
      expect(screen.getByRole('separator', { name: 'Ширина панели' })).toBeTruthy()
      expect(within(pane()).getByRole('button', { name: 'Скрыть панель' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'К чату' })).toBeNull()
    } else {
      // The tool takes the place of the dialog, the way back in plain sight.
      expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
      expect(screen.queryByRole('separator')).toBeNull()
      expect(within(pane()).queryByRole('button', { name: 'Скрыть панель' })).toBeNull()
      expect(within(pane()).getByRole('button', { name: 'К чату' })).toBeTruthy()
    }
  })

  it('stays closed when new changes come after the client closed it', async () => {
    wideLayout()
    let later!: (answer: DialogFeed) => void
    const revised = waiting({
      candidate: { ...candidateHead, revision: 2 },
      events: [
        requestRow('1'),
        resultRow('2', 1),
        candidateRow('3', 1),
        resultRow('4', 2, 'Поменял ещё и цену латте.'),
      ],
      cursor: '4',
    })
    showAnswers(
      waiting({ more: true }),
      new Promise<DialogFeed>((resolve) => (later = resolve)),
      revised,
    )
    await screen.findByText('Изменения готовы')
    expect(plusName()).toBe(DOT.changes)
    fireEvent.click(screen.getByRole('button', { name: 'Посмотреть изменения' }))
    await screen.findByRole('tab', { name: 'Файлы', selected: true })
    // No dot while the panel is open.
    expect(plusName()).toBe('Инструменты')
    expect(plus().querySelector('[data-tools-dot]')).toBeNull()
    fireEvent.click(within(pane()).getByRole('button', { name: 'Скрыть панель' }))
    await waitFor(() => expect(toolsPanel()).toBeNull())
    // The client has seen these changes: «+» is plain again.
    expect(plusName()).toBe('Инструменты')
    later(revised)
    expect(await screen.findByText('Поменял ещё и цену латте.')).toBeTruthy()
    // The new revision is in the dialog; the panel stays where the client put it (И1, И8), and
    // only the dot on «+» says it is new (И13).
    expect(toolsPanel()).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
    await waitFor(() => expect(plusName()).toBe(DOT.changes))
    expect(plus().querySelector('[data-tools-dot]')).not.toBeNull()
  })

  it('shows the preview for /preview: asked for, no further press, the focus on its tab', async () => {
    wideLayout()
    showDialog(started())
    await run(/Открыть предпросмотр/)
    const tab = await screen.findByRole('tab', { name: 'Предпросмотр', selected: true })
    expect(within(pane()).queryByRole('button', { name: 'Показать предпросмотр' })).toBeNull()
    expect(within(pane()).getByRole('link', { name: 'Открыть в новой вкладке' })).toBeTruthy()
    expect(await within(pane()).findByTitle(FRAME)).toBeTruthy()
    expect(calls.ticket).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(document.activeElement).toBe(tab))
  })

  it('wakes a stopped preview by one /preview on a closed panel', async () => {
    wideLayout()
    showDialog({ ...started(), preview: { ...readyPreview, status: 'expired' } })
    await run(/Открыть предпросмотр/)
    await screen.findByRole('tab', { name: 'Предпросмотр', selected: true })
    expect(within(pane()).queryByRole('button', { name: 'Открыть предпросмотр' })).toBeNull()
    await waitFor(() => expect(calls.ticket).toHaveBeenCalledTimes(1))
  })

  it('wakes a preview that stopped on its open tab only by a new call: «+» or its button', async () => {
    wideLayout()
    let later!: (answer: DialogFeed) => void
    const stopped = { ...started(), preview: { ...readyPreview, status: 'expired' as const } }
    showAnswers(
      { ...started(), more: true },
      new Promise<DialogFeed>((resolve) => (later = resolve)),
      stopped,
    )
    await screen.findByText('Поменял цену капучино на 290 ₽.')
    await choose(/^Предпросмотр/)
    await within(pane()).findByTitle(FRAME)
    expect(calls.ticket).toHaveBeenCalledTimes(1)
    later(stopped)
    // The frame of the stopped preview is not kept; the call it was shown by does not wake it.
    const reopen = await within(pane()).findByRole('button', { name: 'Открыть предпросмотр' })
    expect(within(pane()).queryByTitle(FRAME)).toBeNull()
    // The spent ticket leaves the cache once its frame is gone (`gcTime: 0`).
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(calls.ticket).toHaveBeenCalledTimes(1)
    // The preview chosen in «+» again is the client's call: it wakes.
    await choose(/^Предпросмотр/)
    await waitFor(() => expect(calls.ticket).toHaveBeenCalledTimes(2))
    expect(reopen.isConnected).toBe(false)
  })

  it('opens the files for «Посмотреть изменения», never the preview', async () => {
    wideLayout()
    showDialog(waiting({ preview: readyPreview }))
    await screen.findByText('Изменения готовы')
    fireEvent.click(screen.getByRole('button', { name: 'Посмотреть изменения' }))
    const tab = await screen.findByRole('tab', { name: 'Файлы', selected: true })
    expect(tabNames()).toEqual(['Файлы'])
    await waitFor(() => expect(document.activeElement).toBe(tab))
    await waitFor(() =>
      expect(calls.candidate).toHaveBeenCalledWith({ taskId: TASK_ID, revision: 1 }),
    )
    expect(calls.ticket).not.toHaveBeenCalled()
  })

  it('opens the records for «Посмотреть изменения» when nothing else changed', async () => {
    showDialog(
      waiting({
        candidate: {
          ...candidateHead,
          counts: { files: { added: 0, modified: 0, deleted: 0 }, media: 0, records: 3 },
          checks: { pending: 0, passed: 0, failed: 0, stale: 0 },
        },
      }),
    )
    await screen.findByText('Изменения готовы')
    fireEvent.click(screen.getByRole('button', { name: 'Посмотреть изменения' }))
    expect(await screen.findByRole('tab', { name: 'База данных', selected: true })).toBeTruthy()
    expect(tabNames()).toEqual(['База данных'])
  })

  it('reads no changes and takes no ticket before a tool is open, and one when it is (И11)', async () => {
    showDialog(waiting({ preview: readyPreview }))
    await screen.findByText('Изменения готовы')
    // The feed is read as before; nothing of the tools is.
    expect(calls.feed).toHaveBeenCalled()
    expect(calls.ticket).not.toHaveBeenCalled()
    expect(calls.candidate).not.toHaveBeenCalled()
    expect(document.querySelector('iframe')).toBeNull()
    await choose(/^Предпросмотр/)
    const frame = await within(pane()).findByTitle(FRAME)
    expect(calls.ticket).toHaveBeenCalledTimes(1)
    expect(calls.candidate).not.toHaveBeenCalled()
    await choose(/^Файлы и изменения/)
    await waitFor(() => expect(calls.candidate).toHaveBeenCalledTimes(1))
    // Back to the preview: the same frame, kept behind the files, no second ticket.
    fireEvent.click(screen.getByRole('tab', { name: 'Предпросмотр' }))
    expect(screen.getByRole('tab', { name: 'Предпросмотр', selected: true })).toBeTruthy()
    expect(within(pane()).getByTitle(FRAME)).toBe(frame)
    expect(calls.ticket).toHaveBeenCalledTimes(1)
    // Closed, the preview leaves no frame behind the files.
    fireEvent.click(
      within(screen.getByRole('tab', { name: 'Предпросмотр' })).getByTitle(
        'Закрыть вкладку «Предпросмотр»',
      ),
    )
    expect(tabNames()).toEqual(['Файлы'])
    expect(frame.isConnected).toBe(false)
    expect(document.querySelector('iframe')).toBeNull()
    expect(calls.ticket).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['below `lg`, «К чату»', false, 'К чату'],
    ['from `lg`, «Скрыть панель»', true, 'Скрыть панель'],
  ])(
    'keeps the draft and the files of the field while the tools open, switch and close %s',
    async (_width, wide, back) => {
      if (wide) wideLayout()
      showDialog(waiting({ preview: readyPreview }))
      await screen.findByText('Изменения готовы')
      const textarea = field()
      type('А ещё поменяйте цену латте')
      fireEvent.change(screen.getByTestId('composer-files'), {
        target: { files: [new File([new Uint8Array(16)], 'Фото.jpg', { type: 'image/jpeg' })] },
      })
      const files = await screen.findByRole('list', { name: 'Файлы к сообщению' })
      await choose(/^Предпросмотр/)
      await choose(/^Файлы и изменения/)
      fireEvent.click(screen.getByRole('tab', { name: 'Предпросмотр' }))
      // The field is never mounted again, beside the panel or behind the area of a tool.
      expect(textarea.isConnected).toBe(true)
      expect(files.isConnected).toBe(true)
      fireEvent.click(within(pane()).getByRole('button', { name: back }))
      await waitFor(() => expect(toolsPanel()).toBeNull())
      // The same field: the words and the file are where the client left them.
      expect(field()).toBe(textarea)
      expect(field().value).toBe('А ещё поменяйте цену латте')
      expect(plain(screen.getByRole('list', { name: 'Файлы к сообщению' }).textContent)).toContain(
        'Фото.jpg',
      )
    },
  )

  it('keeps the dialog, its draft and its files while the window crosses `lg`, a tool open or not (И19)', async () => {
    const resize = resizableLayout(true)
    showDialog(waiting({ preview: readyPreview }))
    await screen.findByText('Изменения готовы')
    const textarea = field()
    const feed = screen.getByRole('list', { name: 'Сообщения чата' })
    type('А ещё поменяйте цену латте')
    fireEvent.change(screen.getByTestId('composer-files'), {
      target: { files: [new File([new Uint8Array(16)], 'Фото.jpg', { type: 'image/jpeg' })] },
    })
    const files = await screen.findByRole('list', { name: 'Файлы к сообщению' })
    fireEvent.click(screen.getByRole('button', { name: 'Посмотреть изменения' }))
    await screen.findByRole('tab', { name: 'Файлы', selected: true })
    expect(screen.getByRole('separator', { name: 'Ширина панели' })).toBeTruthy()
    // Narrower than `lg`: the open tool takes the place of the dialog, which is only hidden.
    resize(false)
    expect(within(pane()).getByRole('button', { name: 'К чату' })).toBeTruthy()
    expect(screen.queryByRole('separator')).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Сообщение' })).toBeNull()
    expect(screen.getByRole('tab', { name: 'Файлы', selected: true })).toBeTruthy()
    expect(textarea.isConnected).toBe(true)
    // Wide again: the same dialog beside the same tab.
    resize(true)
    expect(screen.getByRole('separator', { name: 'Ширина панели' })).toBeTruthy()
    expect(field()).toBe(textarea)
    // Closed, then narrow and wide again: still the field the client wrote in, and its file.
    fireEvent.click(within(pane()).getByRole('button', { name: 'Скрыть панель' }))
    await waitFor(() => expect(toolsPanel()).toBeNull())
    resize(false)
    expect(field()).toBe(textarea)
    resize(true)
    expect(field()).toBe(textarea)
    expect(field().value).toBe('А ещё поменяйте цену латте')
    expect(screen.getByRole('list', { name: 'Сообщения чата' })).toBe(feed)
    expect(files.isConnected).toBe(true)
    expect(plain(files.textContent)).toContain('Фото.jpg')
  })

  it('has no «+» in a closed dialog that left no changes and no preview (К19)', async () => {
    showDialog(
      feedAnswer({
        status: 'done',
        // A preview with a copy of the database, gone with the dialog: nothing is offered any more.
        preview: { ...readyPreview, status: 'destroyed' },
        events: [requestRow('1')],
        cursor: '1',
        commands: verdicts({
          release: 'finished',
          preview: 'preview_unavailable',
          reset: 'finished',
          update: 'finished',
          cancel: 'finished',
        }),
      }),
    )
    await screen.findByRole('textbox', { name: 'Сообщение' })
    expect(screen.getByRole('textbox', { name: 'Сообщение' }).getAttribute('placeholder')).toBe(
      'Чат завершён',
    )
    expect(screen.queryByRole('button', { name: /^Инструменты/ })).toBeNull()
    expect(calls.candidate).not.toHaveBeenCalled()
  })

  it('offers the preview alone in a dialog at work, not a word of changes (К19)', async () => {
    showDialog(started())
    await screen.findByText('Поменял цену капучино на 290 ₽.')
    expect(await menuTiles()).toEqual(['Предпросмотр'])
    expect(calls.candidate).not.toHaveBeenCalled()
  })

  it('keeps an open tab of the changes when they are gone, saying so', async () => {
    let later!: (answer: DialogFeed) => void
    const gone = waiting({
      status: 'awaiting_user',
      candidate: null,
      preview: readyPreview,
      events: [requestRow('1'), resultRow('2', 1), candidateRow('3', 1), requestRow('4', 'Ещё')],
      cursor: '4',
    })
    showAnswers(
      waiting({ preview: readyPreview, more: true }),
      new Promise<DialogFeed>((resolve) => (later = resolve)),
      gone,
    )
    await screen.findByText('Изменения готовы')
    await choose(/^Файлы и изменения/)
    expect(toolsPanel()).not.toBeNull()
    later(gone)
    await waitFor(() =>
      expect(plain(within(pane()).getByRole('tabpanel').textContent)).toBe(
        'Изменений пока нет.Они появятся здесь, когда агент закончит работу.',
      ),
    )
  })

  it.each([
    ['the field, open to words', 'awaiting_user', () => field()],
    [
      'what works in the closed field',
      'done',
      () => screen.getByRole('button', { name: 'Команды' }),
    ],
  ] as const)(
    'gives the focus to %s when the last tool closes and no «+» is left (К19)',
    async (_what, status, target) => {
      wideLayout()
      let later!: (answer: DialogFeed) => void
      const gone = waiting({
        status,
        candidate: null,
        preview: null,
        commands: verdicts({ cancel: status === 'done' ? 'finished' : null }),
        events: [requestRow('1'), resultRow('2', 1), candidateRow('3', 1), requestRow('4', 'Ещё')],
        cursor: '4',
      })
      showAnswers(
        waiting({ more: true }),
        new Promise<DialogFeed>((resolve) => (later = resolve)),
        gone,
      )
      await screen.findByText('Изменения готовы')
      await choose(/^Файлы и изменения/)
      later(gone)
      await waitFor(() =>
        expect(within(pane()).queryByRole('button', { name: /^Инструменты/ })).toBeNull(),
      )
      fireEvent.click(within(pane()).getByRole('button', { name: 'Скрыть панель' }))
      await waitFor(() => expect(toolsPanel()).toBeNull())
      expect(screen.queryByRole('button', { name: /^Инструменты/ })).toBeNull()
      await waitFor(() => expect(document.activeElement).toBe(target()))
    },
  )

  it("offers «База данных» only once the changes hold records (owner's answer of 30.10.2026)", async () => {
    let later!: (answer: DialogFeed) => void
    const filesOnly = {
      ...candidateHead,
      counts: { files: { added: 1, modified: 2, deleted: 0 }, media: 1, records: 0 },
    }
    const withRecords = waiting({
      preview: readyPreview,
      candidate: { ...candidateHead, revision: 2 },
      events: [
        requestRow('1'),
        resultRow('2', 1),
        candidateRow('3', 1),
        resultRow('4', 2, 'Поменял ещё и цену в меню на сайте.'),
      ],
      cursor: '4',
    })
    showAnswers(
      waiting({ preview: readyPreview, candidate: filesOnly, more: true }),
      new Promise<DialogFeed>((resolve) => (later = resolve)),
      withRecords,
    )
    await screen.findByText('Изменения готовы')
    // The changes touch the files alone: no tile of the records, whatever the stack could do.
    expect(await menuTiles()).toEqual(['Предпросмотр', 'Файлы и изменения, 4', 'Проверки, 2 из 2'])
    later(withRecords)
    expect(await screen.findByText('Поменял ещё и цену в меню на сайте.')).toBeTruthy()
    expect(await menuTiles()).toEqual([
      'Предпросмотр',
      'Файлы и изменения, 4',
      'База данных, 3',
      'Проверки, 2 из 2',
    ])
  })

  it("closes only the tab on the screen by «К чату» below `lg`: the others wait behind the dialog (owner's answer of 30.10.2026)", async () => {
    showDialog(waiting({ preview: readyPreview }))
    await screen.findByText('Изменения готовы')
    const heading = screen.getByRole('heading', { level: 1, name: 'Поменять цену капучино' })
    await choose(/^Предпросмотр/)
    await within(pane()).findByTitle(FRAME)
    await choose(/^Проверки/)
    expect(tabNames()).toEqual(['Предпросмотр', 'Проверки'])
    fireEvent.click(within(pane()).getByRole('button', { name: 'К чату' }))
    // The dialog again, the focus on «+» of its head; the area of the tools is put away, and
    // nothing of it reads anything meanwhile.
    await waitFor(() => expect(toolsPanel()).toBeNull())
    expect(screen.getByRole('heading', { level: 1, name: 'Поменять цену капучино' })).toBe(heading)
    await waitFor(() => expect(document.activeElement).toBe(plus()))
    expect(within(screen.getByRole('banner')).getByRole('button', { name: /^Инструменты/ })).toBe(
      plus(),
    )
    expect(document.querySelector('iframe')).toBeNull()
    // «Проверки» closed, «Предпросмотр» kept behind the dialog: its tile says «Открыто».
    expect(await menuTiles()).toEqual([
      'Предпросмотр, Открыто',
      'Файлы и изменения, 4',
      'База данных, 3',
      'Проверки, 2 из 2',
    ])
    // Chosen there, it is on the screen again in place of the dialog, alone on its strip.
    await choose(/^Предпросмотр, Открыто/)
    const tab = await screen.findByRole('tab', { name: 'Предпросмотр', selected: true })
    expect(tabNames()).toEqual(['Предпросмотр'])
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(tab))
    // Choosing the preview is the client's call to show it (И10).
    await waitFor(() => expect(calls.ticket).toHaveBeenCalledTimes(2))
    // «К чату» on the last tab closes the tools: nothing is kept open any more.
    fireEvent.click(within(pane()).getByRole('button', { name: 'К чату' }))
    await waitFor(() => expect(toolsPanel()).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(plus()))
    expect(await menuTiles()).toEqual([
      'Предпросмотр',
      'Файлы и изменения, 4',
      'База данных, 3',
      'Проверки, 2 из 2',
    ])
  })

  it('marks «+» for new changes while the tabs wait behind the dialog below `lg` (И13, И14)', async () => {
    let later!: (answer: DialogFeed) => void
    const revised = waiting({
      preview: readyPreview,
      candidate: { ...candidateHead, revision: 2 },
      events: [
        requestRow('1'),
        resultRow('2', 1),
        candidateRow('3', 1),
        resultRow('4', 2, 'Поменял ещё и цену латте.'),
      ],
      cursor: '4',
    })
    showAnswers(
      waiting({ preview: readyPreview, more: true }),
      new Promise<DialogFeed>((resolve) => (later = resolve)),
      revised,
    )
    await screen.findByText('Изменения готовы')
    await choose(/^Предпросмотр/)
    await choose(/^Файлы и изменения/)
    fireEvent.click(within(pane()).getByRole('button', { name: 'К чату' }))
    await waitFor(() => expect(toolsPanel()).toBeNull())
    // The files were on the screen at these changes: no dot for them.
    expect(plusName()).toBe('Инструменты')
    later(revised)
    expect(await screen.findByText('Поменял ещё и цену латте.')).toBeTruthy()
    // The preview waits behind the dialog; the new changes mark «+», and open nothing.
    await waitFor(() => expect(plusName()).toBe(DOT.changes))
    expect(toolsPanel()).toBeNull()
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
          'Подробности работы',
          'Оформление',
          'Справка',
        ].map((name) => expect.stringContaining(name)),
      )
      expect(
        screen.getByText(
          'Не отправляйте в чат пароли и ключи: вход в админку сохраните в разделе «Переменные» или войдите сами в окне браузера.',
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
    await screen.findByRole('heading', { name: 'Агент работает' })
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

  describe('of a closed project (К39)', () => {
    const noControl = () => {
      expect(screen.queryByRole('button', { name: 'Взять управление' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Продолжить работу агента' })).toBeNull()
    }

    it('offers no «Взять управление» on the question, on the card or beside the picture', async () => {
      showDialog(
        browserAnswer({
          status: 'awaiting_user',
          commands: closedVerdicts(),
          browser: { help: { reason: 'login', message: null } },
          events: [requestRow('1'), browserQuestionRow('2', 1, 'login')],
          cursor: '2',
        }),
        STREAM_URL,
      )
      await screen.findByText('Нужно войти на сайт')
      noControl()
      await choose(/^Браузер/)
      await waitFor(() => expect(sockets).toHaveLength(1))
      connect(sockets[0]!, 'agent')
      noControl()
    })

    it('offers no «Продолжить работу агента» while the client held the control', async () => {
      showDialog(
        browserAnswer({
          status: 'awaiting_user',
          commands: closedVerdicts(),
          browser: { controller: 'user' },
          events: [requestRow('1'), browserQuestionRow('2', 1, 'control')],
          cursor: '2',
        }),
        STREAM_URL,
      )
      await waitFor(() => expect(field().disabled).toBe(true))
      noControl()
    })

    it('says nothing of a press that goes nowhere while a turn under way holds the client', async () => {
      showDialog(
        browserAnswer({
          commands: closedVerdicts(),
          browser: { controller: 'user' },
          events: [requestRow('1', 'Добавьте новость')],
          cursor: '1',
        }),
        STREAM_URL,
      )
      await screen.findByText('Добавьте новость')
      noControl()
      expect(screen.queryByText(/нажмите «Продолжить работу агента»/u)).toBeNull()
    })
  })

  it('offers «Продолжить работу агента» alone while the client drives; «+» opens the browser to look', async () => {
    showDialog(
      browserAnswer({
        status: 'awaiting_user',
        browser: { controller: 'user' },
        events: [requestRow('1'), browserQuestionRow('2', 1, 'control')],
        cursor: '2',
      }),
      STREAM_URL,
    )
    const resume = await screen.findByRole('button', { name: 'Продолжить работу агента' })
    expect(
      within(resume.parentElement!)
        .getAllByRole('button')
        .map((button) => plain(button.textContent)),
    ).toEqual(['Продолжить работу агента'])
    expect(screen.queryByRole('button', { name: 'Открыть браузер' })).toBeNull()
    await choose(/^Браузер/)
    expect(await screen.findByRole('tab', { name: 'Браузер', selected: true })).toBeTruthy()
    // Looking is all: the stream shows the client's own control and says nothing to the browser.
    await waitFor(() => expect(sockets).toHaveLength(1))
    connect(sockets[0]!, 'user')
    expect(sockets[0]!.sent).not.toContainEqual({ t: 'release' })
    expect(sockets[0]!.sent).not.toContainEqual({ t: 'take' })
    expect(calls.resumeAgent).not.toHaveBeenCalled()
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

  it('takes one ticket for «Продолжить работу агента» with the browser closed, opens nothing and leaves no stream', async () => {
    showDialog(
      browserAnswer({ browser: { controller: 'user' }, events: [requestRow('1')], cursor: '1' }),
      STREAM_URL,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Продолжить работу агента' }))
    await waitFor(() => expect(sockets).toHaveLength(1))
    expect(calls.streamTicket).toHaveBeenCalledTimes(1)
    expect(toolsPanel()).toBeNull()
    const socket = sockets[0]!
    connect(socket, 'user')
    expect(socket.sent).toContainEqual({ t: 'release' })
    // The browser shows the agent: the press is done and its stream goes (И11).
    act(() => socket.onmessage?.({ data: JSON.stringify(streamState('agent')) }))
    await waitFor(() => expect(socket.closed).toBe(true))
    // …and stays gone: no second ticket, no stream opened again, no tab.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(calls.streamTicket).toHaveBeenCalledTimes(1)
    expect(sockets).toHaveLength(1)
    expect(toolsPanel()).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(calls.resumeAgent).not.toHaveBeenCalled()
  })

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
    await screen.findByRole('heading', { name: 'Агент работает' })
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

  it('takes the covered head, dialog, list and way back out of the tab order in full screen, until it closes', async () => {
    calls.feed.mockResolvedValue(browserAnswer({ events: [requestRow('1')], cursor: '1' }))
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    render(
      <div data-chat-shell="">
        <nav data-chat-list="" aria-label="Чаты">
          <button type="button">Новый чат</button>
        </nav>
        <main>
          {/* From `lg` the way back to the list stands over a dialog its panel took the room of. */}
          <a data-chat-back="" href="#chats">
            Назад к чатам
          </a>
          <QueryClientProvider client={queryClient}>
            <DialogView project={PROJECT} taskId={TASK_ID} title={null} />
          </QueryClientProvider>
        </main>
      </div>,
    )
    const name = await screen.findByRole('heading', {
      level: 1,
      name: 'Новость о летней веранде',
    })
    const feed = screen.getByRole('list', { name: 'Сообщения чата' })
    const list = screen.getByRole('navigation', { name: 'Чаты' })
    const back = screen.getByRole('link', { name: 'Назад к чатам' })
    await choose(/^Браузер/)
    expect(feed.closest('[inert]')).toBeNull()
    fireEvent.click(within(pane()).getByRole('button', { name: 'Во весь экран' }))
    await waitFor(() => expect(feed.closest('[inert]')).not.toBeNull())
    expect(name.closest('[inert]')).not.toBeNull()
    expect(list.hasAttribute('inert')).toBe(true)
    // The way back to the list is under the browser too: Shift+Tab from its tabs never lands on it.
    expect(back.hasAttribute('inert')).toBe(true)
    expect(pane().closest('[inert]')).toBeNull()
    // The status of the dialog is still said: its live region is outside the covered column.
    const live = screen
      .getAllByRole('status')
      .find(
        (region) =>
          region.getAttribute('aria-live') === 'polite' &&
          plain(region.textContent) === 'Агент работает',
      )
    expect(live).toBeTruthy()
    expect(live!.closest('[inert]')).toBeNull()
    fireEvent.click(within(pane()).getByRole('button', { name: 'Свернуть' }))
    await waitFor(() => expect(feed.closest('[inert]')).toBeNull())
    expect(list.hasAttribute('inert')).toBe(false)
    expect(back.hasAttribute('inert')).toBe(false)
    // The browser closed over the content leaves nothing out of reach (И17).
    fireEvent.click(within(pane()).getByRole('button', { name: 'Во весь экран' }))
    await waitFor(() => expect(list.hasAttribute('inert')).toBe(true))
    expect(back.hasAttribute('inert')).toBe(true)
    fireEvent.click(within(pane()).getByRole('button', { name: 'К чату' }))
    await waitFor(() => expect(toolsPanel()).toBeNull())
    expect(feed.closest('[inert]')).toBeNull()
    expect(name.closest('[inert]')).toBeNull()
    expect(list.hasAttribute('inert')).toBe(false)
    expect(back.hasAttribute('inert')).toBe(false)
  })

  it('leaves the whole area when another tool is chosen: only the browser has the way back', async () => {
    wideLayout()
    showDialog(
      browserAnswer({
        status: 'awaiting_approval',
        task: { requirements: { repository: true, browser: true } },
        candidate: candidateHead,
        commands: verdicts(),
        events: [requestRow('1'), resultRow('2', 1), candidateRow('3', 1)],
        cursor: '3',
      }),
      STREAM_URL,
    )
    const feed = await screen.findByRole('list', { name: 'Сообщения чата' })
    await choose(/^Браузер/)
    await choose(/^Файлы и изменения/)
    const browser = await screen.findByRole('tab', { name: 'Браузер' })
    fireEvent.click(browser)
    fireEvent.click(await within(pane()).findByRole('button', { name: 'Во весь экран' }))
    await waitFor(() => expect(feed.closest('[inert]')).not.toBeNull())
    // A tab of the strip…
    fireEvent.click(screen.getByRole('tab', { name: 'Файлы' }))
    await waitFor(() => expect(feed.closest('[inert]')).toBeNull())
    // …and a tool of «+» at its end, which stands over the browser too.
    fireEvent.click(browser)
    fireEvent.click(await within(pane()).findByRole('button', { name: 'Во весь экран' }))
    await waitFor(() => expect(feed.closest('[inert]')).not.toBeNull())
    await choose(/^База данных/)
    await waitFor(() => expect(feed.closest('[inert]')).toBeNull())
  })

  it('names the files of a later message too: the list is read again for them', async () => {
    const menu = {
      id: ATTACHMENT_ID,
      name: 'menu-leto.pdf',
      type: 'application/pdf',
      size: 312_000,
      kind: 'document',
      sentAt: new Date(),
    }
    const photo = {
      id: '0199a3f2-0000-7000-8000-0000000000f2',
      name: 'veranda-2.jpg',
      type: 'image/jpeg',
      size: 2_400_000,
      kind: 'image',
      sentAt: new Date(),
    }
    calls.attachments.mockResolvedValueOnce([menu]).mockResolvedValue([menu, photo])
    const first = { ...requestRow('1', 'Добавьте новость'), attachments: [menu.id] } as FeedRow
    const answer = {
      ...requestRow('2', 'Вот ещё фото'),
      kind: 'answer',
      attachments: [photo.id],
    } as FeedRow
    calls.feed
      .mockResolvedValueOnce(browserAnswer({ events: [first], cursor: '1', more: true }))
      .mockResolvedValue(browserAnswer({ events: [answer], cursor: '2' }))
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <DialogView project={PROJECT} taskId={TASK_ID} title={null} />
      </QueryClientProvider>,
    )
    expect(await screen.findByText('menu-leto.pdf')).toBeTruthy()
    expect(await screen.findByText('veranda-2.jpg')).toBeTruthy()
    expect(calls.attachments).toHaveBeenCalledTimes(2)
  })

  it('shows the press that gave the browser back and what the task left on the site', async () => {
    calls.attachments.mockResolvedValue([
      {
        id: ATTACHMENT_ID,
        name: 'menu-leto.pdf',
        type: 'application/pdf',
        size: 312_000,
        kind: 'document',
        sentAt: new Date(),
      },
    ])
    const first = {
      ...requestRow('1', 'Добавьте новость'),
      attachments: [ATTACHMENT_ID],
    } as FeedRow
    showDialog(
      browserAnswer({
        status: 'done',
        browser: { status: 'closed', closeReason: 'task_done' },
        events: [first, resumeRow('2'), browserResultRow('3', 2)],
        cursor: '3',
      }),
    )
    expect(await screen.findByText('Вы вернули управление агенту')).toBeTruthy()
    expect(await screen.findByText('menu-leto.pdf')).toBeTruthy()
    const open = screen.getByRole('link', { name: 'Открыть запись' })
    expect(open.getAttribute('href')).toBe('https://kroshka.example/novosti/veranda/')
    expect(open.getAttribute('rel')).toBe('noopener noreferrer')
    expect(open.getAttribute('target')).toBe('_blank')
    expect(screen.getByRole('link', { name: 'Изменить в админке' }).getAttribute('href')).toBe(
      'https://kroshka.example/wp-admin/post.php?post=128&action=edit',
    )
    expect(plain(screen.getByText(/Открыли летнюю веранду/).textContent)).toContain('опубликовано')
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

  describe('in a chat with the code too (docs/plan/61-chats-first.md, К10, К11)', () => {
    const BOTH = { repository: true, browser: true }
    /** The agent works on the changes; the first word to the browser starts it. */
    const both = (browser: Partial<FeedBrowserHead> | null, rows: number, more = false) => {
      const { task: _task, ...answer } = atWork(browser, rows, more)
      return browserAnswer({
        ...answer,
        browser,
        task: { requirements: BOTH },
        candidate: candidateHead,
      })
    }

    it('opens the browser by itself once, on its tab, with its stream', async () => {
      wideLayout()
      const second = later()
      queueAnswers(both(null, 1, true), second.answer, both({ status: 'ready' }, 2))
      mountDialog({ streamUrl: STREAM_URL })
      await screen.findByText(WORDS[0]!)
      expect(toolsPanel()).toBeNull()
      expect(calls.streamTicket).not.toHaveBeenCalled()
      second.give(both({ status: 'ready' }, 2, true))
      expect(await screen.findByRole('tab', { name: 'Браузер', selected: true })).toBeTruthy()
      await waitFor(() => expect(sockets).toHaveLength(1))
      expect(calls.streamTicket).toHaveBeenCalledTimes(1)
      closeBrowser()
      await waitFor(() => expect(toolsPanel()).toBeNull())
      expect(sockets).toHaveLength(1)
    })

    it('leaves the client on the tab read, the focus inside it, the browser a tab beside', async () => {
      wideLayout()
      const second = later()
      queueAnswers(both(null, 1, true), second.answer, both({ status: 'ready' }, 2))
      calls.candidate.mockResolvedValue(candidateWith('passed'))
      mountDialog({ streamUrl: STREAM_URL })
      await screen.findByText(WORDS[0]!)
      await choose(/^Проверки/)
      const panel = await screen.findByRole('tabpanel')
      const held = document.createElement('button')
      panel.appendChild(held)
      held.focus()
      second.give(both({ status: 'ready' }, 2, true))
      await waitFor(() => expect(tabNames()).toEqual(['Проверки', 'Браузер']))
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
      expect(screen.getByRole('tab', { name: 'Проверки' }).getAttribute('aria-selected')).toBe(
        'true',
      )
      expect(panel.hidden).toBe(false)
      expect(document.activeElement).toBe(held)
      // Nothing of the browser before the client asks for it (docs/plan/59, И11).
      expect(calls.streamTicket).not.toHaveBeenCalled()
      expect(sockets).toHaveLength(0)
      panel.removeChild(held)
    })
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

  it.each([
    ['with the browser, still being started', () => atWork({ status: 'starting' }, 1), true],
    [
      'with the repository, on the copy of the site',
      () => feedAnswer({ status: 'queued', events: [requestRow('1', WORDS[0])], cursor: '1' }),
      // No tool yet: «+» has nothing to offer (docs/plan/61-chats-first.md, К19).
      false,
    ],
  ])(
    'starts a dialog the client has just started with the chat alone, %s (И1)',
    async (_what, answer, withPlus) => {
      wideLayout()
      markNewDialog(TASK_ID)
      queueAnswers(answer())
      mountDialog({ streamUrl: STREAM_URL })
      expect(await screen.findByText(WORDS[0]!)).toBeTruthy()
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
      // Watched from its start, it opens nothing before its browser starts (И2), and reads nothing.
      expect(toolsPanel()).toBeNull()
      expect(document.querySelector('[data-chat-pane]')).toBeNull()
      expect(calls.streamTicket).not.toHaveBeenCalled()
      expect(calls.candidate).not.toHaveBeenCalled()
      expect(
        within(screen.getByRole('banner')).queryAllByRole('button', { name: /^Инструменты/ }),
      ).toHaveLength(withPlus ? 1 : 0)
    },
  )

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

  it.each([
    ['a dialog with the repository', () => waiting({ preview: readyPreview })],
    [
      'a task in the browser before its session',
      () => browserAnswer({ browser: null, events: [requestRow('1')], cursor: '1' }),
    ],
    [
      'a browser whose session closed',
      () =>
        browserAnswer({
          status: 'awaiting_user',
          browser: { status: 'closed', closeReason: 'idle' },
          events: [requestRow('1')],
          cursor: '1',
        }),
    ],
    [
      'a task in the browser that has ended',
      () =>
        browserAnswer({
          status: 'done',
          browser: { status: 'closed', closeReason: 'task_done' },
          events: [requestRow('1')],
          cursor: '1',
        }),
    ],
  ])('says nothing for %s', async (_what, answer) => {
    showDialog(answer(), STREAM_URL)
    await screen.findByRole('textbox', { name: 'Сообщение' })
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    showPage(true)
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(calls.watch).not.toHaveBeenCalled()
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
