// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { plain } from '@/components/billing/testing'

import type { CandidateHead, CandidateView, FileDiffView, PreviewHead } from './chat-types'
import { paneTabsOf, PreviewPane, type PaneTab } from './preview-pane'
import { CANDIDATE_ID, candidateHead, TASK_ID } from './testing'

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

function showPane(props: {
  preview?: PreviewHead | null
  candidate?: CandidateHead | null
  tab?: PaneTab
  tabs?: readonly PaneTab[]
  canReset?: boolean
  onClose?: () => void
}) {
  const onTab = vi.fn<(tab: PaneTab) => void>()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <PreviewPane
        taskId={TASK_ID}
        preview={props.preview === undefined ? previewOf() : props.preview}
        candidate={props.candidate === undefined ? candidateHead : props.candidate}
        tab={props.tab ?? 'preview'}
        onTab={onTab}
        {...(props.tabs ? { tabs: props.tabs } : {})}
        visible
        canReset={props.canReset ?? true}
        onReset={onReset}
        resetting={false}
        {...(props.onClose ? { onClose: props.onClose } : {})}
      />
    </QueryClientProvider>,
  )
  return { onTab }
}

const panel = () => screen.getByRole('tabpanel')

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

describe("the tabs it has something for (owner's request of 26.10.2026)", () => {
  it('opens only when something on the site changed, or the preview was asked for', () => {
    expect(paneTabsOf(previewOf(), candidateHead)).toEqual([
      'preview',
      'files',
      'database',
      'checks',
    ])
    expect(paneTabsOf(null, null)).toEqual([])
    // The owner, 26.10.2026: a preview of a dialog that has changed nothing is not opened by
    // itself — only when the client asks for it (`/preview`).
    expect(paneTabsOf(previewOf(), null)).toEqual([])
    expect(paneTabsOf(previewOf({ status: 'building' }), null)).toEqual([])
    expect(paneTabsOf(previewOf({ status: 'building' }), null, { previewAsked: true })).toEqual([
      'preview',
    ])
    // A preview that cannot be shown, or is gone, is not in use even when asked for.
    expect(paneTabsOf(previewOf({ status: 'unavailable' }), null, { previewAsked: true })).toEqual(
      [],
    )
    expect(paneTabsOf(previewOf({ status: 'destroyed' }), null, { previewAsked: true })).toEqual([])
    // Checks alone change nothing on the site: no preview for them.
    expect(
      paneTabsOf(previewOf(), {
        ...candidateHead,
        counts: { files: { added: 0, modified: 0, deleted: 0 }, media: 0, records: 0 },
      }),
    ).toEqual(['checks'])
    // Only the files change: no tab of the records, none of the checks yet.
    expect(
      paneTabsOf(null, {
        ...candidateHead,
        counts: { files: { added: 0, modified: 1, deleted: 0 }, media: 0, records: 0 },
        checks: { pending: 0, passed: 0, failed: 0, stale: 0 },
      }),
    ).toEqual(['files'])
    expect(paneTabsOf(null, { ...candidateHead, counts: null })).toEqual(['checks'])
  })

  it('draws the tabs as icons named by their labels, the changes with their numbers', () => {
    showPane({ tabs: ['files', 'database'], tab: 'preview' })
    const tabs = within(screen.getByRole('tablist', { name: 'Разделы изменений' })).getAllByRole(
      'tab',
    )
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(['Файлы', 'База данных'])
    expect(tabs.map((tab) => tab.getAttribute('title'))).toEqual(['Файлы', 'База данных'])
    // Two files changed and one added, a medium besides; three records.
    expect(tabs.map((tab) => plain(tab.textContent))).toEqual(['4', '3'])
    // The tab asked for has nothing now: the first that has something is shown.
    expect(screen.getByRole('tab', { name: 'Файлы', selected: true })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: 'Предпросмотр' })).toBeNull()
  })
})

describe('closing the panel', () => {
  it('steps aside by «Скрыть изменения»', () => {
    const onClose = vi.fn()
    showPane({ tabs: ['files'], tab: 'files', onClose })
    fireEvent.click(screen.getByRole('button', { name: 'Скрыть изменения' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('the preview tab', () => {
  it('frames a ready preview by a ticket and opens it in a new tab through the cabinet', async () => {
    showPane({})
    const frame = await screen.findByTitle('Предпросмотр сайта с изменениями диалога')
    expect(frame.getAttribute('src')?.startsWith(`${ORIGIN}/__raditi/enter?t=`)).toBe(true)
    const open = screen.getByRole('link', { name: 'Открыть в новой вкладке' })
    expect(open.getAttribute('href')).toBe(
      `${window.location.origin}/preview/open?host=site-0a1b2c3d-chat-4e5f6a.localhost&path=%2F`,
    )
    expect(open.getAttribute('target')).toBe('_blank')
    expect(open.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('says the preview is being built, and spends no ticket on it', () => {
    showPane({ preview: previewOf({ status: 'building' }) })
    expect(within(panel()).getByRole('status').textContent).toBe('Готовим предпросмотр…')
    expect(ticket).not.toHaveBeenCalled()
  })

  it('says plainly that there is no preview without the database, and draws no site', () => {
    showPane({
      preview: previewOf({ status: 'unavailable', unavailableReason: 'no_database', origin: null }),
    })
    expect(plain(panel().textContent)).toBe(
      'Предпросмотр недоступен: у нас нет доступа к базе данных сайта. Изменения в файлах можно посмотреть на вкладке «Файлы».',
    )
    expect(screen.queryByTitle('Предпросмотр сайта с изменениями диалога')).toBeNull()
  })

  it('offers to reset a preview that failed', () => {
    showPane({ preview: previewOf({ status: 'failed' }) })
    expect(plain(panel().textContent)).toContain('Не удалось подготовить предпросмотр.')
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить данные предпросмотра' }))
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it('opens a stopped preview only when asked', async () => {
    showPane({ preview: previewOf({ status: 'expired' }) })
    expect(plain(panel().textContent)).toContain('Предпросмотр остановлен')
    expect(ticket).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Открыть предпросмотр' }))
    await waitFor(() => expect(ticket).toHaveBeenCalledTimes(1))
  })

  it('says a dialog without a preview has none', () => {
    showPane({ preview: null })
    expect(plain(panel().textContent)).not.toBe('')
    expect(ticket).not.toHaveBeenCalled()
  })
})

describe('the tabs of the changes', () => {
  it('lists the files with their changes and the media with their types', async () => {
    showPane({ tab: 'files' })
    const style = await screen.findByRole('button', { name: /style\.css/ })
    expect(plain(style.textContent)).toContain('Изменён')
    expect(plain(style.textContent)).toContain('2 КБ')
    expect(plain(screen.getByRole('button', { name: /old\.php/ }).textContent)).toContain('Удалён')
    expect(plain(panel().textContent)).toContain('image/webp, 1,5 МБ')
    expect(candidate).toHaveBeenCalledWith({ taskId: TASK_ID, revision: 1 })
  })

  it('shows the diff of a file as text, every line with its sign', async () => {
    showPane({ tab: 'files' })
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
    showPane({ tab: 'database' })
    expect(await screen.findByText('Страница 42: изменится заголовок')).toBeTruthy()
  })

  it('shows each check with its state, a stale one as stale', async () => {
    showPane({ tab: 'checks' })
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
    showPane({ tab: 'files', candidate: { ...candidateHead, status: 'stale' } })
    expect(
      await screen.findByText(
        'Сайт изменился после того, как эти изменения были готовы. Обновите рабочую копию.',
      ),
    ).toBeTruthy()
  })

  it('says there are no changes yet without a candidate', () => {
    showPane({ tab: 'files', candidate: null })
    expect(
      screen.getByText('Изменений пока нет. Они появятся здесь, когда агент закончит работу.'),
    ).toBeTruthy()
    expect(candidate).not.toHaveBeenCalled()
  })
})
