// @vitest-environment jsdom
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
  type UseMutationOptions,
} from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { plain, serverRefusal } from '@/components/billing/testing'

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
}))

const mutation = <I, O>(fn: (input: I) => Promise<O>) => ({
  mutationOptions: (options?: UseMutationOptions<O, Error, I>) => ({ ...options, mutationFn: fn }),
})
const query = <I, O>(path: string, fn: (input: I) => Promise<O>) => ({
  queryOptions: (input: I) => ({ queryKey: [path, input] as QueryKey, queryFn: () => fn(input) }),
  queryKey: (input?: I) => (input === undefined ? [path] : [path, input]) as QueryKey,
})

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    task: {
      message: mutation(calls.message),
      continue: mutation(calls.proceed),
      retry: mutation(calls.retry),
      cancel: mutation(calls.cancel),
      resumeAgent: mutation(calls.resumeAgent),
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
    preview: { ticket: { mutate: async () => ({ url: '', expiresAt: new Date() }) } },
    release: {
      prepare: { query: calls.prepare },
      undoPrepare: { mutate: calls.undoPrepare },
      undoPlan: { query: async () => ({ state: 'pending' }) },
    },
    browser: { streamTicket: { mutate: vi.fn() } },
    attachment: { start: { mutate: vi.fn() }, remove: { mutate: vi.fn() } },
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
  it('reads its head and rows, and names its status in a sign and a word', async () => {
    showDialog()
    expect(await screen.findByText('Изменения готовы')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'Поменять цену капучино' })).toBeTruthy()
    expect(calls.feed).toHaveBeenCalledWith({ taskId: TASK_ID, after: '0' })
    const header = screen.getByRole('banner')
    expect(plain(header.textContent)).toContain('Режим: Работа')
    expect(field().getAttribute('placeholder')).toBe('Что поправить?')
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
  })

  it('offers «Продолжить» on the question about credits and keeps the field closed', async () => {
    showDialog(
      feedAnswer({
        status: 'awaiting_user',
        task: { turnNo: 1 },
        events: [requestRow('1'), ceilingRow('2', 1)],
        cursor: '2',
      }),
    )
    const next = await screen.findByRole('button', { name: 'Продолжить' })
    expect(field().disabled).toBe(true)
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
    expect(
      await screen.findByText('Диалог завершён. Чтобы попросить что-то ещё, начните новый.'),
    ).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Новый диалог' }).getAttribute('href')).toBe(
      `/projects/${SITE_ID}/chat/new`,
    )
    expect(screen.queryByRole('textbox', { name: 'Сообщение' })).toBeNull()
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
    expect(screen.queryByRole('complementary', { name: 'Изменения диалога' })).toBeNull()
    expect(screen.queryByRole('tablist', { name: 'Что показать' })).toBeNull()
  })

  it('shows the panel of the changes behind the switch below the wide layout', async () => {
    showDialog()
    await screen.findByText('Изменения готовы')
    fireEvent.click(screen.getByRole('button', { name: 'Посмотреть изменения' }))
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Предпросмотр', selected: true })).toBeTruthy(),
    )
    expect(screen.getByRole('tab', { name: 'Файлы', selected: true })).toBeTruthy()
  })
})

describe('a task in the browser', () => {
  const pane = () => screen.getByRole('complementary', { name: 'Браузер задачи' })

  it('shows the browser instead of the preview, behind «Диалог | Браузер», and only /cancel', async () => {
    showDialog(
      browserAnswer({ events: [requestRow('1', 'Добавьте новость о веранде')], cursor: '1' }),
    )
    expect(await screen.findByText('Добавьте новость о веранде')).toBeTruthy()
    expect(plain(screen.getByRole('banner').textContent)).toContain('В браузере')
    expect(pane()).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: 'Изменения диалога' })).toBeNull()
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
        'Не отправляйте в чат пароли и ключи: в админку входите сами, в окне браузера.',
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
