// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FeedPage } from '../chat/feed-page'
import { mediaStyleOf, WIDE_MEDIA } from '../scheduled/testing'
import { PagesView } from './pages-view'

type Listed = {
  pageId: string
  workspaceId: string
  title: string
  url: string
  kind: 'html' | 'markdown' | 'doc'
  state: 'pending' | 'live' | 'taken_down'
  version: number
  hasPassword: boolean
  takenDownBy: 'client' | 'operator' | null
  trash: { deletedAt: string; purgeAfter: string } | null
  sourceFileName?: string | null
  canManage: boolean
  updatedAt: string
  treeId: string
  parentId: string | null
  path: string
  position: number
  name?: string | null
  namesAllowed?: boolean
}

const {
  listPages,
  setPassword,
  takeDown,
  restore,
  remove,
  returnDeleted,
  purge,
  update,
  setName,
  deleteFile,
  files,
  push,
} = vi.hoisted(() => ({
  listPages: vi.fn<() => Promise<{ enabled: boolean; pages: Listed[] }>>(),
  setPassword: vi.fn(async (_input: unknown) => undefined),
  takeDown: vi.fn(async (_input: unknown) => undefined),
  restore: vi.fn(async (_input: unknown) => undefined),
  remove: vi.fn(async (_input: unknown) => ({ purgeAfter: '2026-12-14T10:00:00.000Z' })),
  returnDeleted: vi.fn(async (_input: unknown) => undefined),
  purge: vi.fn(async (_input: unknown) => undefined),
  update: vi.fn(async (_input: unknown) => ({ path: '/ceny' })),
  setName: vi.fn(async (_input: unknown) => ({ name: 'moya-firma' })),
  deleteFile: vi.fn(async (_input: unknown) => undefined),
  files: vi.fn(async () => [
    {
      path: '/_files/style.css',
      type: 'text/css',
      sizeBytes: 2048,
      updatedAt: '2026-11-14T10:00:00.000Z',
    },
  ]),
  push: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

const mutation = (fn: (input: unknown) => Promise<unknown>) => ({
  mutationOptions: (options: object = {}) => ({ mutationFn: fn, ...options }),
})

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    pages: {
      list: {
        queryKey: () => ['pages', 'list'],
        queryOptions: () => ({ queryKey: ['pages', 'list'], queryFn: listPages }),
      },
      setPassword: mutation(setPassword),
      takeDown: mutation(takeDown),
      restore: mutation(restore),
      delete: mutation(remove),
      returnDeleted: mutation(returnDeleted),
      purge: mutation(purge),
      update: mutation(update),
      setName: mutation(setName),
      deleteFile: mutation(deleteFile),
      files: {
        queryKey: (input: unknown) => ['pages', 'files', input],
        queryOptions: (input: unknown) => ({ queryKey: ['pages', 'files', input], queryFn: files }),
      },
    },
  }),
}))

const page = (overrides: Partial<Listed> = {}): Listed => ({
  pageId: '019f1a21-1800-7f00-8abc-000000000001',
  workspaceId: '019f1a21-1800-7f00-8abc-0000000000ff',
  title: 'Прайс на ноябрь',
  url: 'https://aaaaaaaaaaaaaaaaaaaaaaaaaa.pages.raditi.ru/',
  kind: 'html',
  state: 'live',
  version: 3,
  hasPassword: false,
  takenDownBy: null,
  trash: null,
  canManage: true,
  updatedAt: '2026-11-13T10:00:00.000Z',
  // A site of one home page unless the test says otherwise (docs/plan/73-pages-sites.md, Дер13).
  treeId: overrides.pageId ?? '019f1a21-1800-7f00-8abc-000000000001',
  parentId: null,
  path: '/',
  position: 0,
  ...overrides,
})

function show(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

const USER = 'user-1'

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  listPages.mockResolvedValue({ enabled: true, pages: [] })
})

describe('«Страницы» (plan 69, Ст30)', () => {
  it('lists the pages with their address, version and state, and no chat (plan 73, Дер8)', async () => {
    listPages.mockResolvedValue({
      enabled: true,
      pages: [
        page(),
        page({
          pageId: '019f1a21-1800-7f00-8abc-000000000002',
          title: 'Аудит',
          kind: 'doc',
          state: 'pending',
          version: 0,
        }),
      ],
    })
    show(<PagesView userId={USER} />)
    const row = (await screen.findByText('Прайс на ноябрь')).closest('li')!
    expect(
      within(row).getByText('https://aaaaaaaaaaaaaaaaaaaaaaaaaa.pages.raditi.ru/'),
    ).toBeTruthy()
    expect(
      within(row)
        .queryAllByRole('link')
        .filter((link) => link.getAttribute('href')?.startsWith('/chats/')),
    ).toEqual([])
    expect(within(row).getByText('v3')).toBeTruthy()
    expect(
      within(row)
        .getByRole('link', { name: 'Открыть страницу «Прайс на ноябрь»' })
        .getAttribute('target'),
    ).toBe('_blank')
    const draft = screen.getByText('Аудит').closest('li')!
    expect(within(draft).queryByRole('link', { name: /Открыть страницу/ })).toBeNull()
  })

  it('filters by tags over the list and by the title', async () => {
    listPages.mockResolvedValue({
      enabled: true,
      pages: [
        page(),
        page({
          pageId: '019f1a21-1800-7f00-8abc-000000000003',
          title: 'Старое меню',
          state: 'taken_down',
          takenDownBy: 'client',
        }),
      ],
    })
    show(<PagesView userId={USER} />)
    await screen.findByText('Прайс на ноябрь')
    fireEvent.click(screen.getByRole('button', { name: /Сняты/ }))
    expect(screen.getByRole('button', { name: /Сняты/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByText('Прайс на ноябрь')).toBeNull()
    expect(screen.getByText('Старое меню')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Все/ }))
    fireEvent.change(screen.getByLabelText('Найти по названию'), { target: { value: 'прайс' } })
    expect(screen.queryByText('Старое меню')).toBeNull()
  })

  it('takes a page down from its menu, and puts back one the client took down', async () => {
    listPages.mockResolvedValue({ enabled: true, pages: [page()] })
    show(<PagesView userId={USER} />)
    await screen.findByText('Прайс на ноябрь')
    fireEvent.click(screen.getByRole('button', { name: 'Действия со страницей «Прайс на ноябрь»' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Снять с публикации' }))
    await waitFor(() => expect(takeDown).toHaveBeenCalled())
    expect(takeDown.mock.calls[0]?.[0]).toEqual({ pageId: page().pageId })
  })

  it('sets a password in its dialog, and offers no management to a member', async () => {
    listPages.mockResolvedValue({ enabled: true, pages: [page()] })
    show(<PagesView userId={USER} />)
    await screen.findByText('Прайс на ноябрь')
    fireEvent.click(screen.getByRole('button', { name: 'Действия со страницей «Прайс на ноябрь»' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Поставить пароль…' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Пароль'), { target: { value: 'секрет-1' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(setPassword).toHaveBeenCalled())
    expect(setPassword.mock.calls[0]?.[0]).toEqual({ pageId: page().pageId, password: 'секрет-1' })
  })

  it('shows a member the link only, and a page the support took down as such', async () => {
    listPages.mockResolvedValue({
      enabled: true,
      pages: [
        page({ canManage: false }),
        page({
          pageId: '019f1a21-1800-7f00-8abc-000000000004',
          title: 'Жалоба',
          state: 'taken_down',
          takenDownBy: 'operator',
        }),
      ],
    })
    show(<PagesView userId={USER} />)
    await screen.findByText('Прайс на ноябрь')
    expect(screen.getByText('Снята поддержкой')).toBeTruthy()
    const [menu] = screen.getAllByRole('button', { name: /Действия со страницей/ })
    fireEvent.click(menu!)
    expect(await screen.findByRole('menuitem', { name: 'Скопировать ссылку' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Снять с публикации' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Поставить пароль…' })).toBeNull()
  })

  it('offers no empty menu: none for a member on a draft or a page taken down', async () => {
    listPages.mockResolvedValue({
      enabled: true,
      pages: [
        page({ state: 'pending', version: 0, canManage: false }),
        page({
          pageId: '019f1a21-1800-7f00-8abc-000000000005',
          title: 'Снятая',
          state: 'taken_down',
          takenDownBy: 'client',
          canManage: false,
        }),
      ],
    })
    show(<PagesView userId={USER} />)
    await screen.findByText('Снятая')
    expect(screen.queryByRole('button', { name: /Действия со страницей/ })).toBeNull()
  })

  it('says when taking a page down did not work', async () => {
    takeDown.mockRejectedValueOnce(new Error('down'))
    listPages.mockResolvedValue({ enabled: true, pages: [page()] })
    show(<PagesView userId={USER} />)
    await screen.findByText('Прайс на ноябрь')
    fireEvent.click(screen.getByRole('button', { name: 'Действия со страницей «Прайс на ноябрь»' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Снять с публикации' }))
    expect(await screen.findByText('Не получилось. Попробуйте ещё раз.')).toBeTruthy()
  })

  it('says when the pages are not set up', async () => {
    listPages.mockResolvedValue({ enabled: false, pages: [] })
    show(<PagesView userId={USER} />)
    expect(await screen.findByText('Страницы здесь не настроены.')).toBeTruthy()
    expect(screen.queryByText('Здесь появятся ваши страницы и сайты')).toBeNull()
  })

  it('names nothing found by a filter and resets it', async () => {
    listPages.mockResolvedValue({ enabled: true, pages: [page()] })
    show(<PagesView userId={USER} />)
    await screen.findByText('Прайс на ноябрь')
    fireEvent.change(screen.getByLabelText('Найти по названию'), { target: { value: 'нет такой' } })
    expect(screen.getByText('Ничего не нашлось.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить фильтры' }))
    expect(screen.getByText('Прайс на ноябрь')).toBeTruthy()
    expect((screen.getByLabelText('Найти по названию') as HTMLInputElement).value).toBe('')
  })
})

describe('«Страницы» before the first page (plan 73, Дер6)', () => {
  it('shows no filters, no search and no counts — what will be here and «Начать чат»', async () => {
    show(<PagesView userId={USER} />)
    expect(
      await screen.findByRole('heading', { name: 'Здесь появятся ваши страницы и сайты' }),
    ).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Показать' })).toBeNull()
    expect(screen.queryByLabelText('Найти по названию')).toBeNull()
    expect(screen.getByRole('link', { name: 'Начать чат' }).getAttribute('href')).toBe('/chats/new')
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('puts a request into the draft of a new chat without sending it', async () => {
    show(<PagesView userId={USER} />)
    fireEvent.click(await screen.findByRole('button', { name: /Сделай сайт-визитку/ }))
    expect(push).toHaveBeenCalledWith('/chats/new')
    expect(JSON.parse(sessionStorage.getItem('raditi-new-chat-draft')!)).toEqual({
      userId: USER,
      text: 'Сделай сайт-визитку моей компании: главная, услуги и контакты',
    })
  })

  it('keeps the list, not the first-visit screen, when only the trash has pages', async () => {
    listPages.mockResolvedValue({
      enabled: true,
      pages: [
        page({ trash: { deletedAt: '2026-11-14T10:00:00Z', purgeAfter: '2026-12-14T10:00:00Z' } }),
      ],
    })
    show(<PagesView userId={USER} />)
    expect(await screen.findByRole('button', { name: /Корзина/ })).toBeTruthy()
    expect(screen.queryByText('Здесь появятся ваши страницы и сайты')).toBeNull()
  })
})

describe('the heading «Страницы» (plan 73, Дер7)', () => {
  // The shell gives the padding: «Страницы» adds none of its own, so its heading stands where the
  // heading of «Запланированные задачи» and «Проекты», its neighbours on the rail, does.
  it('adds no padding of its own to the shell', async () => {
    show(<PagesView userId={USER} />)
    const heading = await screen.findByRole('heading', { level: 1 })
    let root: HTMLElement = heading
    while (root.parentElement !== null && root.parentElement.parentElement !== document.body)
      root = root.parentElement
    expect(root.contains(heading)).toBe(true)
    for (const media of [null, '(min-width:0px)', WIDE_MEDIA])
      expect(mediaStyleOf(root, media)).not.toMatch(/padding/)
    expect(mediaStyleOf(root, null)).toContain('max-width:1200px')
  })

  const about = /Страницы и сайты, которые агент сделал для вашего рабочего пространства/
  it('says what the section is on a hover of the title, and by «i» on a focus and a click', async () => {
    show(<PagesView userId={USER} />)
    const heading = await screen.findByRole('heading', { level: 1 })
    // «i» stands beside the heading, not in it: the name of the heading is the title alone.
    expect(heading).toHaveAccessibleName('Страницы')
    const target = within(heading).getByText('Страницы')
    const info = screen.getByRole('button', { name: 'Что это за раздел' })
    expect(heading.contains(info)).toBe(false)
    expect(screen.queryByText(about)).toBeNull()
    fireEvent.mouseOver(target)
    expect(await screen.findByRole('tooltip')).toBeTruthy()
    expect(screen.getByRole('tooltip').textContent).toMatch(about)
    fireEvent.mouseLeave(target)
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    // A keyboard focus of «i»: MUI opens a tooltip on a focus that is visible, and «i» is
    // described by it.
    fireEvent.keyDown(document.body, { key: 'Tab' })
    act(() => info.focus())
    const tooltip = await screen.findByRole('tooltip')
    expect(info.getAttribute('aria-describedby')).toBe(tooltip.id)
    act(() => info.blur())
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    expect(info.getAttribute('aria-describedby')).toBeNull()
    fireEvent.click(info)
    expect(await screen.findByRole('tooltip')).toBeTruthy()
    // The title is not a second stop of the keyboard on the way to the same words.
    expect(target.getAttribute('tabindex')).toBeNull()
  })
})

describe('the trash (plan 73, Дер1–Дер3)', () => {
  const trashed = (overrides: Partial<Listed> = {}) =>
    page({
      trash: { deletedAt: '2026-11-14T10:00:00.000Z', purgeAfter: '2026-12-14T10:00:00.000Z' },
      ...overrides,
    })

  it('deletes a page after its confirmation and offers «Вернуть» beside the list', async () => {
    listPages.mockResolvedValue({ enabled: true, pages: [page()] })
    show(<PagesView userId={USER} />)
    await screen.findByText('Прайс на ноябрь')
    fireEvent.click(screen.getByRole('button', { name: 'Действия со страницей «Прайс на ноябрь»' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Удалить…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Удалить «Прайс на ноябрь»?' })
    expect(within(dialog).getByText(/30 дней страницу можно вернуть из корзины/)).toBeTruthy()
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить' }))
    await waitFor(() => expect(remove).toHaveBeenCalled())
    expect(remove.mock.calls[0]?.[0]).toEqual({ pageId: page().pageId })
    expect(await screen.findByText('Перенесено в корзину')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Вернуть' }))
    await waitFor(() => expect(returnDeleted).toHaveBeenCalled())
    expect(returnDeleted.mock.calls[0]?.[0]).toEqual({ pageId: page().pageId })
  })

  it('cancels a deletion without a word to the server', async () => {
    listPages.mockResolvedValue({ enabled: true, pages: [page()] })
    show(<PagesView userId={USER} />)
    await screen.findByText('Прайс на ноябрь')
    fireEvent.click(screen.getByRole('button', { name: 'Действия со страницей «Прайс на ноябрь»' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Удалить…' }))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Отмена' }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(remove).not.toHaveBeenCalled()
  })

  it('keeps pages in the trash under «Корзина» alone, with when they go, return and purge', async () => {
    listPages.mockResolvedValue({
      enabled: true,
      pages: [page({ pageId: '019f1a21-1800-7f00-8abc-000000000006', title: 'Живая' }), trashed()],
    })
    show(<PagesView userId={USER} />)
    await screen.findByText('Живая')
    expect(screen.queryByText('Прайс на ноябрь')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Корзина/ }))
    const row = screen.getByText('Прайс на ноябрь').closest('li')!
    expect(within(row).getByText(/Удалится навсегда 14 декабря/)).toBeTruthy()
    expect(within(row).queryByRole('link', { name: /Открыть страницу/ })).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: /Действия со страницей/ }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Вернуть',
      'Удалить навсегда…',
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Удалить навсегда…' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Вернуть её будет нельзя/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить навсегда' }))
    await waitFor(() => expect(purge).toHaveBeenCalled())
  })

  it('says every page is in the trash, not «nothing found», and opens it', async () => {
    listPages.mockResolvedValue({ enabled: true, pages: [trashed()] })
    show(<PagesView userId={USER} />)
    expect(await screen.findByText('Все страницы в корзине.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Сбросить фильтры' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Открыть корзину' }))
    expect(screen.getByText('Прайс на ноябрь')).toBeTruthy()
  })

  it('offers no purge of a page the support took down in the trash', async () => {
    listPages.mockResolvedValue({
      enabled: true,
      pages: [trashed({ state: 'taken_down', takenDownBy: 'operator' })],
    })
    show(<PagesView userId={USER} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть корзину' }))
    fireEvent.click(screen.getByRole('button', { name: /Действия со страницей/ }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Вернуть'])
  })

  it('offers no deletion of a page the support took down, nor to a member', async () => {
    listPages.mockResolvedValue({
      enabled: true,
      pages: [
        page({ state: 'taken_down', takenDownBy: 'operator' }),
        page({ pageId: '019f1a21-1800-7f00-8abc-000000000007', title: 'Чужая', canManage: false }),
      ],
    })
    show(<PagesView userId={USER} />)
    await screen.findByText('Чужая')
    for (const button of screen.queryAllByRole('button', { name: /Действия со страницей/ })) {
      fireEvent.click(button)
      expect(screen.queryByRole('menuitem', { name: 'Удалить…' })).toBeNull()
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    }
  })
})

describe('the card of a page in the chat (plan 69, Ст23)', () => {
  it('names its address and version, and opens it in a new tab', async () => {
    listPages.mockResolvedValue({ enabled: true, pages: [page({ hasPassword: true })] })
    show(<FeedPage pageId={page().pageId} title="Прайс на ноябрь" version={2} kind="html" />)
    expect(
      await screen.findByText('https://aaaaaaaaaaaaaaaaaaaaaaaaaa.pages.raditi.ru/'),
    ).toBeTruthy()
    expect(screen.getByText(/v2 · опубликована · с паролем/)).toBeTruthy()
    expect(
      screen.getByRole('link', { name: 'Открыть страницу «Прайс на ноябрь»' }).getAttribute('href'),
    ).toBe(page().url)
    expect(screen.getByRole('button', { name: 'Скопировать ссылку' })).toBeTruthy()
  })

  it('offers nothing to open on a page taken down', async () => {
    listPages.mockResolvedValue({
      enabled: true,
      pages: [page({ state: 'taken_down', takenDownBy: 'client' })],
    })
    show(<FeedPage pageId={page().pageId} title="Прайс на ноябрь" version={2} kind="html" />)
    expect(await screen.findByText(/снята/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Открыть страницу/ })).toBeNull()
  })

  it('says a page in the trash is deleted, and one purged since is no more (Дер5)', async () => {
    listPages.mockResolvedValue({
      enabled: true,
      pages: [
        page({
          trash: { deletedAt: '2026-11-14T10:00:00.000Z', purgeAfter: '2026-12-14T10:00:00.000Z' },
        }),
      ],
    })
    show(<FeedPage pageId={page().pageId} title="Прайс на ноябрь" version={2} kind="html" />)
    expect(await screen.findByText(/v2 · страница удалена/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Открыть страницу/ })).toBeNull()
    expect(screen.queryByText(page().url)).toBeNull()
  })

  it('says a purged page is no more, with nothing to open — after asking the list again', async () => {
    listPages.mockResolvedValue({ enabled: true, pages: [] })
    show(<FeedPage pageId={page().pageId} title="Прайс на ноябрь" version={2} kind="html" />)
    expect(await screen.findByText(/страницы больше нет/)).toBeTruthy()
    expect(listPages).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: /Действия со страницей/ })).toBeNull()
  })

  it('names a page just published, which a list cached before it did not know yet', async () => {
    listPages.mockResolvedValueOnce({ enabled: true, pages: [] })
    listPages.mockResolvedValue({ enabled: true, pages: [page()] })
    show(<FeedPage pageId={page().pageId} title="Прайс на ноябрь" version={1} kind="html" />)
    expect(await screen.findByText(page().url)).toBeTruthy()
    expect(screen.queryByText(/страницы больше нет/)).toBeNull()
  })
})

describe('sites of pages in «Страницы» (plan 73, §7.4)', () => {
  const tree = '019f1a21-1800-7f00-8abc-0000000000f0'
  const home = page({ pageId: tree, treeId: tree, title: 'Сайт компании' })
  const uslugi = page({
    pageId: '019f1a21-1800-7f00-8abc-0000000000f1',
    treeId: tree,
    parentId: tree,
    path: '/uslugi',
    title: 'Услуги',
    url: 'https://aaaaaaaaaaaaaaaaaaaaaaaaaa.pages.raditi.ru/uslugi',
  })
  const remont = page({
    pageId: '019f1a21-1800-7f00-8abc-0000000000f2',
    treeId: tree,
    parentId: uslugi.pageId,
    path: '/uslugi/remont',
    title: 'Ремонт',
    url: 'https://aaaaaaaaaaaaaaaaaaaaaaaaaa.pages.raditi.ru/uslugi/remont',
  })
  const kontakty = page({
    pageId: '019f1a21-1800-7f00-8abc-0000000000f3',
    treeId: tree,
    parentId: tree,
    path: '/kontakty',
    title: 'Контакты',
    position: 1,
    url: 'https://aaaaaaaaaaaaaaaaaaaaaaaaaa.pages.raditi.ru/kontakty',
  })

  beforeEach(() => {
    localStorage.clear()
    listPages.mockResolvedValue({ enabled: true, pages: [home, uslugi, remont, kontakty] })
  })

  it('shows a site by its home page and opens its pages below it, by their places', async () => {
    show(<PagesView userId={USER} />)
    const row = (await screen.findByText('Сайт компании')).closest('li')!
    expect(within(row).getByText('4 страницы')).toBeTruthy()
    expect(screen.queryByText('Услуги')).toBeNull()
    const open = within(row).getByRole('button', {
      name: 'Показать страницы сайта «Сайт компании»',
    })
    expect(open.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(open)
    const titles = screen
      .getAllByRole('listitem')
      .map((item) => within(item).getAllByText(/./)[0]!.textContent)
    expect(titles.slice(0, 4)).toEqual(['Сайт компании4 страницы', 'Услуги', 'Ремонт', 'Контакты'])
    expect(
      within(screen.getByText('Ремонт').closest('li')!).getByText('/uslugi/remont'),
    ).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('raditi-pages-expanded')!)).toEqual([tree])
  })

  it('finds a site by a page of it', async () => {
    show(<PagesView userId={USER} />)
    await screen.findByText('Сайт компании')
    fireEvent.change(screen.getByLabelText('Найти по названию'), { target: { value: 'ремонт' } })
    expect(screen.getByText('Сайт компании')).toBeTruthy()
  })

  it('offers the place of a page, not its password, and of a home page the whole site', async () => {
    localStorage.setItem('raditi-pages-expanded', JSON.stringify([tree]))
    show(<PagesView userId={USER} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Действия со страницей «Услуги»' }))
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent)
    expect(items).toEqual(
      expect.arrayContaining(['Переименовать…', 'Изменить адрес…', 'Переместить…', 'Выше', 'Ниже']),
    )
    expect(items).not.toContain('Поставить пароль…')
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Действия со страницей «Сайт компании»' }))
    expect(screen.getByRole('menuitem', { name: 'Поставить пароль…' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Удалить сайт…' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Изменить адрес…' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Удалить сайт…' }))
    expect(
      await screen.findByRole('dialog', {
        name: 'Удалить «Сайт компании» и ещё 3 вложенные страницы?',
      }),
    ).toBeTruthy()
  })

  it('changes the address of a page, showing what it becomes and that the old one leads to it', async () => {
    localStorage.setItem('raditi-pages-expanded', JSON.stringify([tree]))
    show(<PagesView userId={USER} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Действия со страницей «Услуги»' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Изменить адрес…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Адрес страницы «Услуги»' })
    expect(within(dialog).getByText('Старый адрес будет вести на новый.')).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText('Адрес страницы'), { target: { value: 'Ceny' } })
    expect(
      within(dialog).getByText('https://aaaaaaaaaaaaaaaaaaaaaaaaaa.pages.raditi.ru/ceny'),
    ).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(update).toHaveBeenCalled())
    expect(update.mock.calls[0]?.[0]).toEqual({ pageId: uslugi.pageId, segment: 'ceny' })
  })

  it('moves a page under another page of its site, never under itself or below it', async () => {
    localStorage.setItem('raditi-pages-expanded', JSON.stringify([tree]))
    show(<PagesView userId={USER} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Действия со страницей «Услуги»' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Переместить…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Переместить «Услуги»' })
    fireEvent.mouseDown(within(dialog).getByRole('combobox'))
    const options = screen.getAllByRole('option').map((option) => option.textContent)
    expect(options).toEqual(['Сайт компании · /', 'Контакты · /kontakty'])
    fireEvent.click(screen.getByRole('option', { name: 'Контакты · /kontakty' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(update).toHaveBeenCalled())
    expect(update.mock.calls[0]?.[0]).toEqual({ pageId: uslugi.pageId, parentId: kontakty.pageId })
  })

  it('puts a page above its neighbour', async () => {
    localStorage.setItem('raditi-pages-expanded', JSON.stringify([tree]))
    show(<PagesView userId={USER} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Действия со страницей «Контакты»' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Выше' }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    expect(update.mock.calls.map((call) => call[0])).toEqual([
      { pageId: kontakty.pageId, position: 0 },
      { pageId: uslugi.pageId, position: 1 },
    ])
  })

  it('numbers the siblings anew when two of them stand at one position', async () => {
    listPages.mockResolvedValue({
      enabled: true,
      pages: [home, uslugi, remont, { ...kontakty, position: 0 }],
    })
    localStorage.setItem('raditi-pages-expanded', JSON.stringify([tree]))
    show(<PagesView userId={USER} />)
    // «Контакты» stands before «Услуги» by path at the same position 0: «Ниже» moves it at last.
    fireEvent.click(await screen.findByRole('button', { name: 'Действия со страницей «Контакты»' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ниже' }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls.map((call) => call[0])).toEqual([
      { pageId: kontakty.pageId, position: 1 },
    ])
  })

  it('names the pages a site takes when its home page is purged from the trash', async () => {
    const deleted = {
      deletedAt: '2026-11-14T10:00:00.000Z',
      purgeAfter: '2026-12-14T10:00:00.000Z',
    }
    listPages.mockResolvedValue({
      enabled: true,
      pages: [home, uslugi, remont, kontakty].map((each) => ({ ...each, trash: deleted })),
    })
    show(<PagesView userId={USER} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть корзину' }))
    fireEvent.click(screen.getByRole('button', { name: 'Действия со страницей «Сайт компании»' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Удалить навсегда…' }))
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText('Удалить «Сайт компании» и ещё 3 вложенные страницы навсегда?'),
    ).toBeTruthy()
    expect(within(dialog).getByText(/Вернуть их будет нельзя/)).toBeTruthy()
  })

  it('names a site on a tariff that gives names, and says where they are on another (Дер32)', async () => {
    listPages.mockResolvedValue({ enabled: true, pages: [{ ...home, namesAllowed: true }] })
    show(<PagesView userId={USER} />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Действия со страницей «Сайт компании»' }),
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Адрес сайта…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Адрес сайта «Сайт компании»' })
    fireEvent.change(within(dialog).getByLabelText('Имя сайта'), {
      target: { value: 'Moya-Firma' },
    })
    expect(within(dialog).getByText('https://moya-firma.pages.raditi.ru/')).toBeTruthy()
    expect(within(dialog).getByText(/закройте сайт паролем/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(setName).toHaveBeenCalled())
    expect(setName.mock.calls[0]?.[0]).toEqual({ pageId: tree, name: 'moya-firma' })
  })

  it('offers no own name on a tariff without names, only the way to one', async () => {
    listPages.mockResolvedValue({ enabled: true, pages: [{ ...home, namesAllowed: false }] })
    show(<PagesView userId={USER} />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Действия со страницей «Сайт компании»' }),
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Адрес сайта…' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/доступно на тарифах «Бизнес» и «Агентство»/)).toBeTruthy()
    expect(within(dialog).getByRole('link', { name: 'Тарифы' }).getAttribute('href')).toBe(
      '/settings/plans',
    )
    expect(within(dialog).queryByRole('button', { name: 'Сохранить' })).toBeNull()
  })

  it('shows the shared files of a site and deletes one (Дер34)', async () => {
    listPages.mockResolvedValue({ enabled: true, pages: [home] })
    show(<PagesView userId={USER} />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Действия со страницей «Сайт компании»' }),
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Файлы сайта…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Файлы сайта «Сайт компании»' })
    const link = await within(dialog).findByRole('link', { name: '/_files/style.css' })
    expect(link.getAttribute('href')).toBe(
      'https://aaaaaaaaaaaaaaaaaaaaaaaaaa.pages.raditi.ru/_files/style.css',
    )
    expect(within(dialog).getByText('2 КБ')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить файл /_files/style.css' }))
    await waitFor(() => expect(deleteFile).toHaveBeenCalled())
    expect(deleteFile.mock.calls[0]?.[0]).toEqual({ pageId: tree, path: '/_files/style.css' })
  })
})
