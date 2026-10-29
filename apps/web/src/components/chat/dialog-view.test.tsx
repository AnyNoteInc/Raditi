// @vitest-environment jsdom
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
  type UseMutationOptions,
} from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { plain, serverRefusal } from '@/components/billing/testing'

import type * as Upload from './attachment-upload'
import { composerText } from './chat-texts'
import type { CandidateView, DialogFeed, FeedRow, PreparedRelease } from './chat-types'
import { DialogView } from './dialog-view'
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
  requestRow,
  resultRow,
  resumeRow,
  SITE_ID,
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
  ticket: vi.fn(async (_input: { taskId: string }) => ({ url: '', expiresAt: new Date() })),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: calls.replace, push: vi.fn() }),
  usePathname: () => `/projects/${SITE_ID}/chat/${TASK_ID}`,
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
    billing: { usage: query('billing.usage', async () => null) },
  }),
  useTRPCClient: () => ({
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
    browser: { streamTicket: { mutate: vi.fn() } },
    attachment: {
      start: {
        mutate: vi.fn(async () => ({
          attachmentId: ATTACHMENT_ID,
          uploadPath: `/api/attachments/${ATTACHMENT_ID}`,
        })),
      },
      remove: { mutate: vi.fn() },
    },
  }),
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

function showDialog(answer: DialogFeed = waiting(), browserStreamUrl: string | null = null) {
  calls.feed.mockResolvedValue(answer)
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <DialogView
        siteId={SITE_ID}
        siteUrl="https://kroshka.example"
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
  it('reads its head and rows: one line of its name and its menu, the mode by the field', async () => {
    showDialog()
    expect(await screen.findByText('Изменения готовы')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'Поменять цену капучино' })).toBeTruthy()
    expect(calls.feed).toHaveBeenCalledWith({ taskId: TASK_ID, after: '0' })
    expect(
      screen.getByRole('button', { name: 'Действия с диалогом: Поменять цену капучино' }),
    ).toBeTruthy()
    // The mode the dialog started in is said by the field, not changed there.
    expect(plain(screen.getByTitle('Режим выбирается в начале диалога').textContent)).toContain(
      'Работа',
    )
    expect(field().getAttribute('placeholder')).toBe('Что поправить?')
    // No standing words under the field (owner, 26.10.2026): the reminder is read aloud only.
    expect(screen.queryByText('ИИ может допускать ошибки. Проверяйте важное.')).toBeNull()
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
      screen.getByRole('button', { name: 'Действия с диалогом: Поменять цену капучино' })

    fireEvent.click(menu())
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Переименовать' }))
    const name = screen.getByRole('textbox', { name: 'Название диалога' })
    fireEvent.change(name, { target: { value: '  Цена   латте ' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    await waitFor(() => expect(calls.rename).toHaveBeenCalledTimes(1))
    expect(calls.rename.mock.calls[0]![0]).toEqual({ taskId: TASK_ID, title: 'Цена латте' })

    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Название диалога' })).toBeNull(),
    )
    fireEvent.click(menu())
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Удалить' }))
    const ask = await screen.findByRole('dialog', { name: 'Удалить диалог?' })
    fireEvent.click(within(ask).getByRole('button', { name: 'Удалить' }))
    await waitFor(() => expect(calls.remove).toHaveBeenCalledTimes(1))
    expect(calls.remove.mock.calls[0]![0]).toEqual({ taskId: TASK_ID })
    // The page of a deleted dialog leaves for the root of «Чат».
    await waitFor(() => expect(calls.replace).toHaveBeenCalledWith(`/projects/${SITE_ID}/chat`))
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
      serverRefusal('Сначала ответьте на вопрос в диалоге', 'CHAT_COMMAND_UNAVAILABLE'),
    )
    showDialog()
    await run(/Обновить рабочую копию/)
    // Opening the window reads the verdicts again.
    await waitFor(() => expect(calls.feed).toHaveBeenCalledTimes(2))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Сначала ответьте на вопрос в диалоге.',
    )
    expect(calls.update).toHaveBeenCalledTimes(1)
    // The verdicts may have changed with the refusal: the dialog is read once more.
    await waitFor(() => expect(calls.feed).toHaveBeenCalledTimes(3))
  })

  it('asks before `/cancel` closes the dialog', async () => {
    showDialog()
    await run(/Отменить диалог/)
    const confirm = screen.getByRole('dialog', { name: 'Отменить диалог?' })
    expect(plain(confirm.textContent)).toContain('Закрыть диалог без выпуска')
    expect(calls.cancel).not.toHaveBeenCalled()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Отменить диалог' }))
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
    expect(screen.getByRole('link', { name: 'Новый диалог' })).toBeTruthy()
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
    expect(closed.getAttribute('placeholder')).toBe('Диалог завершён')
    expect(
      screen.getByText('Диалог завершён. Чтобы попросить что-то ещё, начните новый.'),
    ).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Новый диалог' }).getAttribute('href')).toBe(
      `/projects/${SITE_ID}/chat/new`,
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
        <DialogView
          siteId={SITE_ID}
          siteUrl="https://kroshka.example"
          taskId={TASK_ID}
          title={null}
        />
      </QueryClientProvider>,
    )
    expect(await screen.findByRole('heading', { name: 'Такого диалога нет' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'К диалогам' }).getAttribute('href')).toBe(
      `/projects/${SITE_ID}/chat`,
    )
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
        <DialogView
          siteId={SITE_ID}
          siteUrl="https://kroshka.example"
          taskId={TASK_ID}
          title={null}
        />
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
    fireEvent.click(option(/Отменить диалог/))
    const confirm = screen.getByRole('dialog', { name: 'Отменить диалог?' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Отменить диалог' }))
    expect(await screen.findByText('Останавливаем работу агента…')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
    const again = option(/Отменить диалог/)
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
        <DialogView
          siteId={SITE_ID}
          siteUrl="https://kroshka.example"
          taskId={TASK_ID}
          title={null}
        />
      </QueryClientProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Посмотреть изменения' }))
    fireEvent.click(await screen.findByRole('tab', { name: 'Проверки' }))
    expect(await screen.findByText('Идёт')).toBeTruthy()
    ended = true
    later(waiting({ candidate: checksOf('passed') }))
    expect(await screen.findByText('Пройдена')).toBeTruthy()
    expect(screen.queryByText('Идёт')).toBeNull()
  })

  it('has no panel and no switch while there is nothing to show in it', async () => {
    showDialog(
      feedAnswer({
        status: 'awaiting_user',
        task: { turnNo: 1 },
        preview: null,
        candidate: null,
        events: [requestRow('1')],
        cursor: '1',
      }),
    )
    await screen.findByRole('textbox', { name: 'Сообщение' })
    expect(screen.queryByRole('complementary', { name: PANE })).toBeNull()
    expect(screen.queryByRole('tablist', { name: 'Что показать' })).toBeNull()
  })

  it('shows the panel of the changes behind the switch below the wide layout', async () => {
    showDialog()
    await screen.findByText('Изменения готовы')
    fireEvent.click(screen.getByRole('button', { name: 'Посмотреть изменения' }))
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Изменения', selected: true })).toBeTruthy(),
    )
    expect(screen.getByRole('tab', { name: 'Файлы', selected: true })).toBeTruthy()
  })
})

const PANE = 'Предпросмотр и изменения диалога'
const readyPreview = {
  status: 'ready' as const,
  unavailableReason: null,
  origin: 'http://site-0a1b2c3d-chat-4e5f6a.localhost:8090',
  revision: 1,
  dirty: false,
}

describe("the panel of a dialog (owner's request of 27.10.2026)", () => {
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
  afterEach(() => vi.unstubAllGlobals())

  const started = () =>
    feedAnswer({
      status: 'awaiting_user',
      task: { turnNo: 1 },
      preview: readyPreview,
      candidate: null,
      events: [requestRow('1'), resultRow('2', 1)],
      cursor: '2',
    })

  it('is opened by the button of the head before any changes, with the preview not shown yet', async () => {
    wideLayout()
    showDialog(started())
    const open = await screen.findByRole('button', { name: 'Открыть панель' })
    // Nothing has changed on the site: the panel does not open by itself.
    expect(screen.queryByRole('complementary', { name: PANE })).toBeNull()
    expect(open.getAttribute('title')).toBe('Предпросмотр, файлы, база данных и проверки')
    fireEvent.click(open)
    const pane = await screen.findByRole('complementary', { name: PANE })
    expect(within(pane).getByRole('tab', { name: 'Предпросмотр', selected: true })).toBeTruthy()
    expect(plain(pane.textContent)).toContain('Покажем его, когда попросите.')
    expect(within(pane).queryByTitle('Предпросмотр сайта с изменениями диалога')).toBeNull()
    // Closed, it gives way to the button again.
    fireEvent.click(within(pane).getByRole('button', { name: 'Скрыть панель' }))
    await waitFor(() => expect(screen.queryByRole('complementary', { name: PANE })).toBeNull())
    expect(screen.getByRole('button', { name: 'Открыть панель' })).toBeTruthy()
  })

  it('opens by itself with the changes on their files, not on the preview', async () => {
    wideLayout()
    showDialog(waiting({ preview: readyPreview }))
    const pane = await screen.findByRole('complementary', { name: PANE })
    expect(within(pane).getByRole('tab', { name: 'Файлы', selected: true })).toBeTruthy()
    expect(within(pane).queryByTitle('Предпросмотр сайта с изменениями диалога')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Открыть панель' })).toBeNull()
    expect(calls.ticket).not.toHaveBeenCalled()
  })

  it('shows the preview when the client calls for it by /preview', async () => {
    wideLayout()
    showDialog(started())
    await run(/Открыть предпросмотр/)
    const pane = await screen.findByRole('complementary', { name: PANE })
    const tab = within(pane).getByRole('tab', { name: 'Предпросмотр', selected: true })
    expect(within(pane).queryByRole('button', { name: 'Показать предпросмотр' })).toBeNull()
    expect(within(pane).getByRole('link', { name: 'Открыть в новой вкладке' })).toBeTruthy()
    await waitFor(() => expect(calls.ticket).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(document.activeElement).toBe(tab))
  })

  it('wakes a stopped preview by one /preview, whatever tab the panel was on', async () => {
    wideLayout()
    const stopped = { ...readyPreview, status: 'expired' as const }
    // The panel opened by itself on the files; the preview had stopped before the call.
    showDialog(waiting({ preview: stopped }))
    const pane = await screen.findByRole('complementary', { name: PANE })
    expect(within(pane).getByRole('tab', { name: 'Файлы', selected: true })).toBeTruthy()
    await run(/Открыть предпросмотр/)
    expect(within(pane).getByRole('tab', { name: 'Предпросмотр', selected: true })).toBeTruthy()
    expect(within(pane).queryByRole('button', { name: 'Открыть предпросмотр' })).toBeNull()
    await waitFor(() => expect(calls.ticket).toHaveBeenCalledTimes(1))
  })

  it('wakes a stopped preview by one /preview on a closed panel', async () => {
    wideLayout()
    showDialog(
      feedAnswer({
        status: 'awaiting_user',
        task: { turnNo: 1 },
        preview: { ...readyPreview, status: 'expired' },
        candidate: null,
        events: [requestRow('1'), resultRow('2', 1)],
        cursor: '2',
      }),
    )
    await run(/Открыть предпросмотр/)
    const pane = await screen.findByRole('complementary', { name: PANE })
    expect(within(pane).queryByRole('button', { name: 'Открыть предпросмотр' })).toBeNull()
    await waitFor(() => expect(calls.ticket).toHaveBeenCalledTimes(1))
  })

  it('puts the focus into the panel the button of the head opened', async () => {
    wideLayout()
    showDialog(started())
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть панель' }))
    const pane = await screen.findByRole('complementary', { name: PANE })
    await waitFor(() =>
      expect(document.activeElement).toBe(within(pane).getByRole('tab', { name: 'Предпросмотр' })),
    )
    // «Показать предпросмотр» goes with its button: the focus stays on the tab of the preview.
    fireEvent.click(within(pane).getByRole('button', { name: 'Показать предпросмотр' }))
    await waitFor(() => expect(calls.ticket).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(document.activeElement).toBe(within(pane).getByRole('tab', { name: 'Предпросмотр' })),
    )
  })

  it('does not show the preview for «Посмотреть изменения», even when it is the only tab', async () => {
    wideLayout()
    // Changes the platform could not count, and no checks: the preview's tab is all the panel has.
    showDialog(
      waiting({
        preview: readyPreview,
        candidate: {
          ...candidateHead,
          counts: null,
          checks: { pending: 0, passed: 0, failed: 0, stale: 0 },
        },
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Посмотреть изменения' }))
    const pane = await screen.findByRole('complementary', { name: PANE })
    expect(within(pane).getByRole('button', { name: 'Показать предпросмотр' })).toBeTruthy()
    expect(calls.ticket).not.toHaveBeenCalled()
  })

  it('comes back by itself with new changes on their files, not on the preview asked before', async () => {
    wideLayout()
    let later!: (answer: DialogFeed) => void
    const revised = waiting({ preview: readyPreview, candidate: { ...candidateHead, revision: 2 } })
    calls.feed
      .mockResolvedValueOnce(waiting({ preview: readyPreview, more: true }))
      .mockReturnValueOnce(new Promise((resolve) => (later = resolve)))
      .mockResolvedValue(revised)
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <DialogView
          siteId={SITE_ID}
          siteUrl="https://kroshka.example"
          taskId={TASK_ID}
          title="Поменять цену капучино"
        />
      </QueryClientProvider>,
    )
    await run(/Открыть предпросмотр/)
    const pane = await screen.findByRole('complementary', { name: PANE })
    expect(within(pane).getByRole('tab', { name: 'Предпросмотр', selected: true })).toBeTruthy()
    fireEvent.click(within(pane).getByRole('button', { name: 'Скрыть панель' }))
    await waitFor(() => expect(screen.queryByRole('complementary', { name: PANE })).toBeNull())
    later(revised)
    const back = await screen.findByRole('complementary', { name: PANE })
    expect(within(back).getByRole('tab', { name: 'Файлы', selected: true })).toBeTruthy()
  })

  it('can be shown below the wide layout before any changes, by the switch', async () => {
    showDialog(started())
    await screen.findByRole('textbox', { name: 'Сообщение' })
    fireEvent.click(screen.getByRole('tab', { name: 'Изменения' }))
    const pane = screen.getByRole('complementary', { name: PANE })
    expect(within(pane).getByRole('button', { name: 'Показать предпросмотр' })).toBeTruthy()
  })
})

describe('a task in the browser', () => {
  const pane = () => screen.getByRole('complementary', { name: 'Браузер задачи' })

  it('gives the browser of a task that has ended no half of the screen', async () => {
    showDialog(
      browserAnswer({
        status: 'done',
        events: [requestRow('1', 'Добавьте новость о веранде')],
        cursor: '1',
        browser: null,
      }),
    )
    expect(await screen.findByText('Добавьте новость о веранде')).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: 'Браузер задачи' })).toBeNull()
    expect(screen.queryByRole('tablist', { name: 'Что показать' })).toBeNull()
  })

  it('shows the browser instead of the preview, behind «Диалог | Браузер», and only /cancel', async () => {
    showDialog(
      browserAnswer({ events: [requestRow('1', 'Добавьте новость о веранде')], cursor: '1' }),
    )
    expect(await screen.findByText('Добавьте новость о веранде')).toBeTruthy()
    expect(plain(screen.getByTitle('Режим выбирается в начале диалога').textContent)).toContain(
      'Чат',
    )
    expect(pane()).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: PANE })).toBeNull()
    const views = screen.getByRole('tablist', { name: 'Что показать' })
    expect(
      within(views)
        .getAllByRole('tab')
        .map((tab) => plain(tab.textContent)),
    ).toEqual(['Диалог', 'Браузер, работает агент'])
    // The agent works: the field waits, and the window of commands has only «Отменить диалог».
    fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
    const options = within(screen.getByRole('listbox', { name: 'Команды' })).getAllByRole('option')
    expect(options.map((option) => plain(option.textContent))).toEqual([
      expect.stringContaining('Отменить диалог'),
    ])
    expect(
      screen.getByText(
        'Не отправляйте в чат пароли и ключи: вход в админку сохраните в разделе «Переменные» или войдите сами в окне браузера.',
      ),
    ).toBeTruthy()
  })

  it('says it cannot show the browser where the platform has none, and keeps the dialog', async () => {
    showDialog(browserAnswer())
    await screen.findByRole('heading', { level: 1, name: 'Новость о летней веранде' })
    expect(within(pane()).getByText('Не удалось показать браузер')).toBeTruthy()
  })

  it('offers «Взять управление» on the question to sign in, and shows the browser', async () => {
    showDialog(
      browserAnswer({
        status: 'awaiting_user',
        browser: { help: { reason: 'login', message: null } },
        events: [requestRow('1'), browserQuestionRow('2', 1, 'login')],
        cursor: '2',
      }),
    )
    expect(await screen.findByText('Нужно войти на сайт')).toBeTruthy()
    // Words in the field answer the question too.
    expect(field().disabled).toBe(false)
    const card = screen.getByText('Нужно войти на сайт').closest('div')!.parentElement!
    fireEvent.click(within(card).getByRole('button', { name: 'Взять управление' }))
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Браузер/, selected: true })).toBeTruthy(),
    )
  })

  it('gives the browser back with «Продолжить работу агента» while the task waits', async () => {
    showDialog(
      browserAnswer({
        status: 'awaiting_user',
        browser: { controller: 'user' },
        events: [requestRow('1'), browserQuestionRow('2', 1, 'control')],
        cursor: '2',
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Продолжить работу агента' }))
    await waitFor(() => expect(calls.resumeAgent).toHaveBeenCalledTimes(1))
    expect(calls.resumeAgent.mock.calls[0]![0]).toEqual({
      taskId: TASK_ID,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
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
    const card = screen.getByText('Нужно войти на сайт').closest('div')!.parentElement!
    const take = () =>
      within(card).getByRole<HTMLButtonElement>('button', { name: 'Взять управление' })
    expect(field().disabled).toBe(false)
    expect(take().disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
    fireEvent.click(option(/Отменить диалог/))
    const confirm = screen.getByRole('dialog', { name: 'Отменить диалог?' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Отменить диалог' }))
    // core closes the task: until then the field and the control wait, and say why.
    await waitFor(() => expect(field().disabled).toBe(true))
    expect(screen.getAllByText('Останавливаем задачу…')).toHaveLength(2)
    expect(within(pane()).getByText('Останавливаем задачу…')).toBeTruthy()
    expect(take().disabled).toBe(true)
    expect(calls.cancel).toHaveBeenCalledTimes(1)
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
    expect(within(pane()).getByText('Останавливаем задачу…')).toBeTruthy()
    // «Остановить» is not offered twice.
    expect(
      within(pane())
        .getAllByRole<HTMLButtonElement>('button', { name: 'Остановить' })
        .every((button) => button.disabled),
    ).toBe(true)
    expect(calls.resumeAgent).not.toHaveBeenCalled()
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
        <DialogView
          siteId={SITE_ID}
          siteUrl="https://kroshka.example"
          taskId={TASK_ID}
          title={null}
        />
      </QueryClientProvider>,
    )
    expect(await screen.findByText('menu-leto.pdf')).toBeTruthy()
    expect(await screen.findByText('veranda-2.jpg')).toBeTruthy()
    expect(calls.attachments).toHaveBeenCalledTimes(2)
  })

  it('takes the covered dialog, the bar and the list out of the tab order in full screen', async () => {
    calls.feed.mockResolvedValue(browserAnswer({ events: [requestRow('1')], cursor: '1' }))
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    render(
      <div data-site-shell="">
        <header aria-label="Панель сайта">
          <button type="button">Проекты</button>
        </header>
        <nav data-site-list="" aria-label="Диалоги">
          <button type="button">Новый диалог</button>
        </nav>
        <main>
          <QueryClientProvider client={queryClient}>
            <DialogView
              siteId={SITE_ID}
              siteUrl="https://kroshka.example"
              taskId={TASK_ID}
              title={null}
            />
          </QueryClientProvider>
        </main>
      </div>,
    )
    await screen.findByRole('heading', { level: 1, name: 'Новость о летней веранде' })
    const column = document.getElementById('dialog-view-dialog')!
    const bar = screen.getByRole('banner', { name: 'Панель сайта' })
    const list = screen.getByRole('navigation', { name: 'Диалоги' })
    expect(column.hasAttribute('inert')).toBe(false)
    fireEvent.click(within(pane()).getByRole('button', { name: 'Во весь экран' }))
    await waitFor(() => expect(column.hasAttribute('inert')).toBe(true))
    expect(screen.getByRole('tablist', { name: 'Что показать' }).closest('[inert]')).not.toBeNull()
    expect(bar.hasAttribute('inert')).toBe(true)
    expect(list.hasAttribute('inert')).toBe(true)
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
    await waitFor(() => expect(column.hasAttribute('inert')).toBe(false))
    expect(bar.hasAttribute('inert')).toBe(false)
    expect(list.hasAttribute('inert')).toBe(false)
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
