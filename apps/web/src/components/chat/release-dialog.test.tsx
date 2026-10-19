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

import type { CandidateView, PreparedRelease } from './chat-types'
import { ReleaseDialog, releaseFacts } from './release-dialog'
import { CANDIDATE_ID, databaseView, RELEASE_ID, TASK_ID } from './testing'

type ConfirmInput = { taskId: string; confirmToken: string; version: string; reviewed?: boolean }
type Confirmed = {
  releaseId: string
  status: 'approved' | 'failed' | 'installed'
  version: string
  repeated: boolean
}

const { prepare, confirm, candidate } = vi.hoisted(() => ({
  prepare: vi.fn<(input: { taskId: string }) => Promise<PreparedRelease>>(),
  confirm: vi.fn<(input: ConfirmInput) => Promise<Confirmed>>(),
  candidate: vi.fn<(input: { taskId: string; revision?: number }) => Promise<CandidateView>>(),
}))

const query = <I, O>(path: string, fn: (input: I) => Promise<O>) => ({
  queryOptions: (input: I) => ({
    queryKey: [path, input] as QueryKey,
    queryFn: () => fn(input),
  }),
})

vi.mock('@/trpc/client', () => ({
  useTRPCClient: () => ({ release: { prepare: { query: prepare } } }),
  useTRPC: () => ({
    release: {
      confirm: {
        mutationOptions: (options: UseMutationOptions<Confirmed, Error, ConfirmInput>) => ({
          ...options,
          mutationFn: confirm,
        }),
      },
    },
    candidate: { get: query('candidate.get', candidate) },
  }),
}))

function prepared(patch: Partial<PreparedRelease> = {}): PreparedRelease {
  return {
    candidateId: CANDIDATE_ID,
    revision: 2,
    counts: { files: { added: 1, modified: 2, deleted: 0 }, media: 1, records: 1 },
    installedVersion: 'v1.3.2',
    base: 'v1.3.2',
    proposal: { version: 'v1.4.0', bump: 'minor' },
    choices: [
      { version: 'v1.3.3', bump: 'patch', confirmToken: 'token-patch' },
      { version: 'v1.4.0', bump: 'minor', confirmToken: 'token-minor' },
      { version: 'v2.0.0', bump: 'major', confirmToken: 'token-major' },
    ],
    review: false,
    expiresAt: new Date('2026-10-17T09:10:00Z'),
    ...patch,
  }
}

const candidateView: CandidateView = {
  id: CANDIDATE_ID,
  taskId: TASK_ID,
  revision: 2,
  status: 'current',
  turnNo: 2,
  createdAt: new Date('2026-10-17T09:00:00Z'),
  baseVersion: 'v1.3.2',
  files: [],
  media: [],
  database: [
    {
      objectType: 'page',
      objectId: '42',
      fields: ['title', 'content'],
      text: 'Страница 42: изменятся заголовок и текст',
    },
  ],
  databaseView: null,
  databaseReview: false,
  checks: [
    {
      id: '0199a3f2-0000-7000-8000-0000000000c1',
      kind: 'php_lint',
      status: 'passed',
      finishedAt: new Date('2026-10-17T09:01:00Z'),
      screenshot: false,
    },
    {
      id: '0199a3f2-0000-7000-8000-0000000000c2',
      kind: 'preview_smoke',
      status: 'stale',
      finishedAt: new Date('2026-10-17T09:01:00Z'),
      screenshot: false,
    },
  ],
  proposal: { base: 'v1.3.2', version: 'v1.4.0', bump: 'minor', choices: [] },
  runtime: null,
}

const onClose = vi.fn<() => void>()
const onReleased = vi.fn<() => void>()

function showDialog(agentMessage: string | null = 'Поменял цену капучино на 290 ₽.') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const at = (open: boolean) => (
    <QueryClientProvider client={queryClient}>
      <ReleaseDialog
        taskId={TASK_ID}
        open={open}
        agentMessage={agentMessage}
        onClose={onClose}
        onReleased={onReleased}
      />
    </QueryClientProvider>
  )
  const view = render(at(true))
  return { reopen: (open: boolean) => view.rerender(at(open)) }
}

const dialog = () => screen.getByRole('dialog', { name: 'Выпустить новую версию' })
const releaseButton = (version: string) =>
  screen.findByRole('button', { name: `Выпустить версию ${version}` })

beforeEach(() => {
  vi.clearAllMocks()
  prepare.mockResolvedValue(prepared())
  candidate.mockResolvedValue(candidateView)
  confirm.mockImplementation(async ({ version }) => ({
    releaseId: RELEASE_ID,
    status: 'approved',
    version,
    repeated: false,
  }))
})

describe('the release dialog', () => {
  it('tells what goes into the version: the counts, the words of the agent, the records, the checks', async () => {
    showDialog()
    await releaseButton('1.4.0')
    const text = plain(dialog().textContent)
    expect(text).toContain('Изменено файлов: 3')
    expect(text).toContain('Добавится медиафайлов: 1')
    expect(text).toContain('Изменится записей на сайте: 1')
    expect(text).toContain('Сейчас на сайте версия 1.3.2.')
    expect(within(dialog()).getByText('Поменял цену капучино на 290 ₽.').tagName).toBe('BLOCKQUOTE')
    expect(
      await within(dialog()).findByText('Страница 42: изменятся заголовок и текст'),
    ).toBeTruthy()
    expect(text).toContain('Перед установкой мы сохраним резервную копию.')
    expect(plain(dialog().textContent)).toContain('Устарела: изменения поменялись после неё')
    expect(prepare).toHaveBeenCalledWith({ taskId: TASK_ID })
    expect(candidate).toHaveBeenCalledWith({ taskId: TASK_ID, revision: 2 })
  })

  it('proposes one number and offers its two neighbours', async () => {
    showDialog()
    await releaseButton('1.4.0')
    const numbers = within(screen.getByRole('radiogroup', { name: 'Номер версии' }))
    const radios = numbers.getAllByRole<HTMLInputElement>('radio')
    expect(radios.map((radio) => plain(radio.closest('label')?.textContent))).toEqual([
      '1.3.3 — Исправления',
      '1.4.0 — Новые возможности (предлагаем)',
      '2.0.0 — Крупные изменения',
    ])
    expect(radios.map((radio) => radio.checked)).toEqual([false, true, false])
  })

  it('confirms exactly the chosen number with its own confirmation', async () => {
    showDialog()
    await releaseButton('1.4.0')
    fireEvent.click(screen.getByRole('radio', { name: /2\.0\.0/ }))
    fireEvent.click(await releaseButton('2.0.0'))
    await waitFor(() => expect(onReleased).toHaveBeenCalledTimes(1))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0]![0]).toEqual({
      taskId: TASK_ID,
      confirmToken: 'token-major',
      version: 'v2.0.0',
    })
  })

  it('releases a bulk or shortened plan only once the client looked at every change', async () => {
    prepare.mockResolvedValue(prepared({ review: true }))
    candidate.mockResolvedValue({ ...candidateView, databaseView, databaseReview: true })
    showDialog()
    const button = await releaseButton('1.4.0')
    expect(
      await within(dialog()).findByText(
        'Описание сайта: было «Цветы у дома», станет «Цветы у дома — доставка за час»',
      ),
    ).toBeTruthy()
    expect(plain(dialog().textContent)).toContain(
      'Часть изменений базы данных показана не полностью.',
    )
    expect(button).toHaveProperty('disabled', true)
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Я посмотрел(а) все изменения базы данных' }),
    )
    expect(button).toHaveProperty('disabled', false)
    fireEvent.click(button)
    await waitFor(() => expect(onReleased).toHaveBeenCalledTimes(1))
    expect(confirm.mock.calls[0]![0]).toEqual({
      taskId: TASK_ID,
      confirmToken: 'token-minor',
      version: 'v1.4.0',
      reviewed: true,
    })
  })

  it('keeps a refusal inside and asks anew what can be released', async () => {
    confirm.mockRejectedValueOnce(
      serverRefusal(
        'Изменения диалога поменялись, пока вы смотрели на них. Посмотрите их ещё раз',
        'RELEASE_CANDIDATE_CHANGED',
      ),
    )
    showDialog()
    fireEvent.click(await releaseButton('1.4.0'))
    expect(
      await within(dialog()).findByText(
        'Изменения диалога поменялись, пока вы смотрели на них. Посмотрите их ещё раз.',
      ),
    ).toBeTruthy()
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2))
    expect(onReleased).not.toHaveBeenCalled()
  })

  it('falls back to the proposal when a new answer no longer offers the chosen number', async () => {
    confirm.mockRejectedValueOnce(
      serverRefusal('Этот номер уже занят', 'RELEASE_VERSION_NOT_OFFERED'),
    )
    showDialog()
    await releaseButton('1.4.0')
    fireEvent.click(screen.getByRole('radio', { name: /1\.3\.3/ }))
    prepare.mockResolvedValue(
      prepared({
        proposal: { version: 'v1.5.0', bump: 'minor' },
        choices: [
          { version: 'v1.4.1', bump: 'patch', confirmToken: 'token-2-patch' },
          { version: 'v1.5.0', bump: 'minor', confirmToken: 'token-2-minor' },
          { version: 'v2.0.0', bump: 'major', confirmToken: 'token-2-major' },
        ],
      }),
    )
    fireEvent.click(await releaseButton('1.3.3'))
    fireEvent.click(await releaseButton('1.5.0'))
    await waitFor(() => expect(onReleased).toHaveBeenCalledTimes(1))
    expect(confirm.mock.calls[1]![0]).toMatchObject({ confirmToken: 'token-2-minor' })
  })

  it('says why nothing can be released', async () => {
    prepare.mockRejectedValue(
      serverRefusal('Выпускать версии могут владелец и администраторы', 'CHAT_COMMAND_UNAVAILABLE'),
    )
    showDialog()
    expect(
      await within(dialog()).findByText('Выпускать версии могут владелец и администраторы.'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Выпустить версию/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Не выпускать' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows nothing of an opening before: the numbers are asked anew, and only then offered', async () => {
    const view = showDialog()
    await releaseButton('1.4.0')
    view.reopen(false)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    let answer!: (prepared: PreparedRelease) => void
    prepare.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    view.reopen(true)
    expect(await within(dialog()).findByText('Готовим выпуск…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Выпустить версию/ })).toBeNull()
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(prepare).toHaveBeenCalledTimes(2)
    answer(
      prepared({
        proposal: { version: 'v1.5.0', bump: 'minor' },
        choices: [
          { version: 'v1.4.1', bump: 'patch', confirmToken: 'token-2-patch' },
          { version: 'v1.5.0', bump: 'minor', confirmToken: 'token-2-minor' },
          { version: 'v2.0.0', bump: 'major', confirmToken: 'token-2-major' },
        ],
      }),
    )
    fireEvent.click(await releaseButton('1.5.0'))
    await waitFor(() => expect(onReleased).toHaveBeenCalledTimes(1))
    expect(confirm.mock.calls[0]![0]).toMatchObject({ confirmToken: 'token-2-minor' })
  })

  it('offers no confirmation beside a refusal to say what can be released', async () => {
    const view = showDialog()
    await releaseButton('1.4.0')
    view.reopen(false)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    prepare.mockRejectedValueOnce(
      serverRefusal('Пока нечего выпускать', 'CHAT_COMMAND_UNAVAILABLE'),
    )
    view.reopen(true)
    expect(await within(dialog()).findByText('Пока нечего выпускать.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Выпустить версию/ })).toBeNull()
  })

  it('keeps the dialog open when the number was used before for an ended release', async () => {
    confirm.mockResolvedValueOnce({
      releaseId: RELEASE_ID,
      status: 'failed',
      version: 'v1.4.0',
      repeated: true,
    })
    showDialog()
    fireEvent.click(await releaseButton('1.4.0'))
    expect(
      await within(dialog()).findByText(
        'Номер 1.4.0 уже использовали для этих изменений. Выберите номер ещё раз.',
      ),
    ).toBeTruthy()
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2))
    expect(onReleased).not.toHaveBeenCalled()
  })

  it('takes a repeat of a release still under way for that release', async () => {
    confirm.mockResolvedValueOnce({
      releaseId: RELEASE_ID,
      status: 'approved',
      version: 'v1.4.0',
      repeated: true,
    })
    showDialog()
    fireEvent.click(await releaseButton('1.4.0'))
    await waitFor(() => expect(onReleased).toHaveBeenCalledTimes(1))
  })

  it('names the first release when nothing is installed yet', async () => {
    prepare.mockResolvedValue(prepared({ installedVersion: null, counts: null }))
    showDialog(null)
    await releaseButton('1.4.0')
    expect(plain(dialog().textContent)).toContain('Это первая версия, которую выпустит Радити.')
    expect(plain(dialog().textContent)).toContain('Изменения есть, но подсчитать их не получилось.')
    expect(within(dialog()).queryByRole('blockquote')).toBeNull()
  })
})

describe('releaseFacts', () => {
  it('leaves out what does not change', () => {
    expect(
      releaseFacts({ files: { added: 0, modified: 0, deleted: 0 }, media: 0, records: 2 }),
    ).toEqual(['Изменится записей на сайте: 2'])
  })
})
