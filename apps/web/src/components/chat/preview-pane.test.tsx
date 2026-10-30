// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { plain } from '@/components/billing/testing'

import type { CandidateHead, CandidateView, FileDiffView, PreviewHead } from './chat-types'
import type { ChangesTool } from './dialog-tools'
import { CandidateTab, PreviewTab, usePreviewCalls } from './preview-pane'
import { CANDIDATE_ID, candidateHead, TASK_ID } from './testing'

// What the tabs of the preview and of the changes show beside a dialog (docs/plan/59-dialog-tools-
// panel.md): a tab is drawn once its tool was chosen, so the preview chosen is the preview asked
// for (И10), and the changes are read only by the tab that shows them (И11).

const { ticket, candidate, fileDiff } = vi.hoisted(() => ({
  ticket:
    vi.fn<(input: { taskId: string; to?: string }) => Promise<{ url: string; expiresAt: Date }>>(),
  candidate:
    vi.fn<(input: { taskId: string; revision?: number }) => Promise<CandidateView | null>>(),
  fileDiff: vi.fn<(input: { candidateId: string; path: string }) => Promise<FileDiffView>>(),
}))

const query = <I, O>(path: string, fn: (input: I) => Promise<O>) => ({
  queryOptions: (input: I) => ({ queryKey: [path, input] as QueryKey, queryFn: () => fn(input) }),
})

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    candidate: { get: query('candidate.get', candidate), fileDiff: query('fileDiff', fileDiff) },
  }),
  useTRPCClient: () => ({ preview: { ticket: { mutate: ticket } } }),
}))

const ORIGIN = 'http://site-0a1b2c3d-chat-4e5f6a.localhost:8090'
const FRAME = 'Предпросмотр сайта с изменениями диалога'

function previewOf(patch: Partial<PreviewHead> = {}): PreviewHead {
  return {
    status: 'ready',
    unavailableReason: null,
    origin: ORIGIN,
    revision: 1,
    dirty: false,
    ...patch,
  }
}

const view: CandidateView = {
  id: CANDIDATE_ID,
  taskId: TASK_ID,
  revision: 1,
  status: 'current',
  turnNo: 1,
  createdAt: new Date('2026-10-17T09:00:00Z'),
  baseVersion: 'v1.3.2',
  files: [
    {
      path: 'wp-content/themes/kroshka/style.css',
      change: 'modified',
      sizeBytes: 2048,
      executable: false,
    },
    {
      path: 'wp-content/themes/kroshka/old.php',
      change: 'deleted',
      sizeBytes: 0,
      executable: false,
    },
  ],
  media: [
    {
      path: 'wp-content/uploads/raditi/cappuccino.webp',
      contentType: 'image/webp',
      sizeBytes: 1536 * 1024,
      sha256: 'a'.repeat(64),
    },
  ],
  database: [
    {
      objectType: 'page',
      objectId: '42',
      fields: ['title'],
      text: 'Страница 42: изменится заголовок',
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
      status: 'failed',
      finishedAt: new Date('2026-10-17T09:01:00Z'),
      screenshot: false,
    },
    {
      id: '0199a3f2-0000-7000-8000-0000000000c3',
      kind: 'agent_browser',
      status: 'passed',
      finishedAt: new Date('2026-10-17T09:01:00Z'),
      screenshot: true,
    },
    {
      id: '0199a3f2-0000-7000-8000-0000000000c4',
      kind: 'agent_browser',
      status: 'stale',
      finishedAt: null,
      screenshot: false,
    },
  ],
  proposal: { base: 'v1.3.2', version: 'v1.4.0', bump: 'minor', choices: [] },
  runtime: { production: '7.4', preview: '8.3', missing: ['imagick'] },
}

const onReset = vi.fn<() => void>()

/** The tab drawn as the dialog draws it: inside its panel, with a cache of its own. */
function inPanel(children: ReactNode, queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <div role="tabpanel" aria-label="Вкладка">
        {children}
      </div>
    </QueryClientProvider>
  )
}

type PreviewProps = {
  preview?: PreviewHead | null
  /** The calls the client made once the preview was there: the one its tab opened by among them. */
  calls?: number
  canReset?: boolean
}

/** The tab of the preview as the dialog holds it: the client's calls are counted, as there. */
function Preview({ props }: { props: PreviewProps }) {
  const preview = props.preview === undefined ? previewOf() : props.preview
  const calls = usePreviewCalls(preview?.status ?? null)
  const made = props.calls ?? 1
  const { call } = calls
  useEffect(() => {
    for (let count = 0; count < made; count++) call()
  }, [made, call])
  return (
    <PreviewTab
      taskId={TASK_ID}
      preview={preview}
      calls={calls}
      onReopen={call}
      canReset={props.canReset ?? true}
      onReset={onReset}
      resetting={false}
    />
  )
}

function showPreview(props: PreviewProps = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const shown = render(inPanel(<Preview props={props} />, queryClient))
  /** The head moves on: the same tab, with the calls the client made, gets new props. */
  const update = (next: PreviewProps) =>
    shown.rerender(inPanel(<Preview props={next} />, queryClient))
  return { update }
}

function showChanges(
  tool: ChangesTool,
  {
    candidate: head = candidateHead,
    ended = false,
  }: { candidate?: CandidateHead | null; ended?: boolean } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    inPanel(
      <CandidateTab taskId={TASK_ID} candidate={head} tool={tool} ended={ended} />,
      queryClient,
    ),
  )
}

const panel = () => screen.getByRole('tabpanel', { name: 'Вкладка' })

beforeEach(() => {
  vi.clearAllMocks()
  ticket.mockImplementation(async () => ({
    url: `${ORIGIN}/__raditi/enter?t=${'a'.repeat(43)}&to=%2F`,
    expiresAt: new Date(),
  }))
  candidate.mockResolvedValue(view)
  fileDiff.mockResolvedValue({
    path: 'wp-content/themes/kroshka/style.css',
    state: 'ready',
    diff: [
      'diff --git a/style.css b/style.css',
      '@@ -1,2 +1,2 @@',
      ' body {',
      '-  color: red;',
      '+  color: <script>alert(1)</script>;',
    ].join('\n'),
  })
})

describe('the tab of the preview (И10: the preview chosen is asked for)', () => {
  it('frames a ready preview at once by a ticket, and opens it in a new tab through the cabinet', async () => {
    showPreview()
    const frame = await screen.findByTitle(FRAME)
    expect(screen.queryByRole('button', { name: 'Показать предпросмотр' })).toBeNull()
    expect(frame.getAttribute('src')?.startsWith(`${ORIGIN}/__raditi/enter?t=`)).toBe(true)
    expect(ticket).toHaveBeenCalledTimes(1)
    const open = screen.getByRole('link', { name: 'Открыть в новой вкладке' })
    expect(open.getAttribute('href')).toBe(
      `${window.location.origin}/preview/open?host=site-0a1b2c3d-chat-4e5f6a.localhost&path=%2F`,
    )
    expect(open.getAttribute('target')).toBe('_blank')
    expect(open.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('says the preview is being built, and spends no ticket on it', () => {
    showPreview({ preview: previewOf({ status: 'building' }) })
    expect(within(panel()).getByRole('status').textContent).toBe('Готовим предпросмотр…')
    expect(ticket).not.toHaveBeenCalled()
  })

  it('says plainly that there is no preview without the database, and draws no site', () => {
    showPreview({
      preview: previewOf({ status: 'unavailable', unavailableReason: 'no_database', origin: null }),
    })
    expect(plain(panel().textContent)).toBe(
      'Предпросмотр недоступен: у нас нет доступа к базе данных сайта. Изменения в файлах можно посмотреть на вкладке «Файлы».',
    )
    expect(screen.queryByTitle(FRAME)).toBeNull()
  })

  it('offers to reset a preview that failed', () => {
    showPreview({ preview: previewOf({ status: 'failed' }) })
    expect(plain(panel().textContent)).toContain('Не удалось подготовить предпросмотр.')
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить данные предпросмотра' }))
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it('does not keep the frame of a preview that stopped: it wakes on a call made after', async () => {
    const { update } = showPreview()
    await screen.findByTitle(FRAME)
    expect(ticket).toHaveBeenCalledTimes(1)
    update({ preview: previewOf({ status: 'expired' }) })
    expect(plain(panel().textContent)).toContain('Предпросмотр остановлен')
    expect(screen.queryByTitle(FRAME)).toBeNull()
    // The spent ticket leaves the cache once the frame is gone (`gcTime: 0`), before a person
    // could press anything.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    fireEvent.click(screen.getByRole('button', { name: 'Открыть предпросмотр' }))
    await waitFor(() => expect(ticket).toHaveBeenCalledTimes(2))
  })

  it('wakes a stopped preview by the call it was opened by', async () => {
    showPreview({ preview: previewOf({ status: 'expired' }) })
    expect(await screen.findByTitle(FRAME)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Открыть предпросмотр' })).toBeNull()
    expect(ticket).toHaveBeenCalledTimes(1)
  })

  it('opens a preview that stopped after the call only when asked again', async () => {
    showPreview({ preview: previewOf({ status: 'expired' }), calls: 0 })
    expect(plain(panel().textContent)).toContain('Предпросмотр остановлен')
    expect(ticket).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Открыть предпросмотр' }))
    await waitFor(() => expect(ticket).toHaveBeenCalledTimes(1))
  })

  it('says the preview of a dialog that has ended is gone, and spends no ticket on it', () => {
    // The menu offers no such preview (И6); a tab open as the dialog ended says what became of it.
    showPreview({ preview: previewOf({ status: 'destroyed' }) })
    expect(within(panel()).getByRole('status').textContent).toBe(
      'Диалог закрыт, и его предпросмотр остановлен.',
    )
    expect(screen.queryByTitle(FRAME)).toBeNull()
    expect(ticket).not.toHaveBeenCalled()
  })

  it('says a dialog without a preview has none', () => {
    showPreview({ preview: null })
    expect(plain(panel().textContent)).not.toBe('')
    expect(ticket).not.toHaveBeenCalled()
  })
})

describe('the tabs of the changes', () => {
  it('lists the files with their changes and the media with their types', async () => {
    showChanges('files')
    const style = await screen.findByRole('button', { name: /style\.css/ })
    expect(plain(style.textContent)).toContain('Изменён')
    expect(plain(style.textContent)).toContain('2 КБ')
    expect(plain(screen.getByRole('button', { name: /old\.php/ }).textContent)).toContain('Удалён')
    expect(plain(panel().textContent)).toContain('image/webp, 1,5 МБ')
    expect(candidate).toHaveBeenCalledWith({ taskId: TASK_ID, revision: 1 })
  })

  it('shows the diff of a file as text, every line with its sign', async () => {
    showChanges('files')
    fireEvent.click(await screen.findByRole('button', { name: /style\.css/ }))
    const added = await screen.findByText(
      (_, element) =>
        element?.tagName === 'SPAN' &&
        (element.textContent ?? '').endsWith('color: <script>alert(1)</script>;') &&
        element.textContent?.startsWith('Добавлено:') === true,
    )
    expect(added).toBeTruthy()
    expect(panel().querySelector('script')).toBeNull()
    expect(plain(panel().textContent)).toContain(
      'Строки со знаком «+» добавятся, со знаком «−» — уйдут.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Ко всем файлам' }))
    expect(await screen.findByRole('button', { name: /old\.php/ })).toBeTruthy()
  })

  it('tells the records of the site in the words of the platform', async () => {
    showChanges('database')
    expect(await screen.findByText('Страница 42: изменится заголовок')).toBeTruthy()
  })

  it('shows each check with its state, a stale one as stale', async () => {
    showChanges('checks')
    await screen.findByText('Файлы без ошибок в коде')
    const text = plain(panel().textContent)
    expect(text).toContain('Файлы без ошибок в кодеПройдена')
    expect(text).toContain('Сайт открывается в предпросмотреНе пройдена')
    expect(text).toContain('Проверка агента в браузереУстарела: изменения поменялись после неё')
    // The preview runs otherwise than the site: said before the checks (Р2, Р18).
    expect(plain(within(panel()).getByRole('note').textContent)).toBe(
      'Предпросмотр работает на PHP 8.3, а сайт — на PHP 7.4. Проверки в предпросмотре могут пройти не так, как пройдут на сайте.На сайте есть расширения PHP, которых нет в предпросмотре: imagick. То, что от них зависит, в предпросмотре может не работать.',
    )
    // The screenshot of the agent's own look, served by the cabinet; none for the stale check.
    const shots = within(panel()).getAllByRole('img', {
      name: 'Снимок экрана, который сделал агент при проверке',
    })
    expect(shots.map((shot) => shot.getAttribute('src'))).toEqual([
      `/api/tasks/${TASK_ID}/checks/0199a3f2-0000-7000-8000-0000000000c3/screenshot`,
    ])
  })

  it('warns that a stale candidate needs the update', async () => {
    showChanges('files', { candidate: { ...candidateHead, status: 'stale' } })
    expect(
      await screen.findByText(
        'Сайт изменился после того, как эти изменения были готовы. Обновите рабочую копию.',
      ),
    ).toBeTruthy()
  })

  it('says the changes are yet to come, in the words of each tab, and reads nothing (И6)', () => {
    showChanges('files', { candidate: null })
    expect(plain(panel().textContent)).toBe(
      'Изменений пока нет.Они появятся здесь, когда агент закончит работу.',
    )
    expect(candidate).not.toHaveBeenCalled()
  })

  it('says what the records and the checks say before the changes', () => {
    showChanges('database', { candidate: null })
    expect(plain(screen.getAllByRole('tabpanel').at(-1)!.textContent)).toBe(
      'Изменений в базе данных пока нет.',
    )
    showChanges('checks', { candidate: null })
    expect(plain(screen.getAllByRole('tabpanel').at(-1)!.textContent)).toBe('Проверок пока нет.')
    expect(candidate).not.toHaveBeenCalled()
  })

  it('says a dialog that has ended has none, and where the released versions are', () => {
    showChanges('files', { candidate: null, ended: true })
    expect(plain(panel().textContent)).toBe(
      'Диалог закрыт: изменений для показа здесь нет.Выпущенные версии — в разделе «Изменения».',
    )
    expect(candidate).not.toHaveBeenCalled()
  })

  it('says there are none when the server has none to read for the changes the head named', async () => {
    candidate.mockResolvedValue(null)
    showChanges('files')
    await waitFor(() =>
      expect(plain(panel().textContent)).toBe(
        'Изменений пока нет.Они появятся здесь, когда агент закончит работу.',
      ),
    )
    expect(candidate).toHaveBeenCalledTimes(1)
  })
})
