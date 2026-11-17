// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectContext } from './project-context'
import { ProjectCreateDialog } from './project-create-dialog'
import type { ProjectDetails } from './project-types'

// The repository of a project in the cabinet (docs/plan/84-projects.md, ПР9, ПР10, §4.8; slice
// 84.17): «Ссылка на GitHub» and its refusal for a private repository, «Подключить репозиторий»
// with an own GitLab server, «Выберите репозиторий», and the link saved with a new project.

const PROJECT_ID = '0199a3f2-0000-7000-8000-00000000c001'
const CONNECTION_ID = '0199a3f2-0000-7000-8000-00000000d001'
const at = new Date('2026-11-16T09:00:00Z')

const calls = vi.hoisted(() => ({
  get: vi.fn<(input: { projectId: string }) => Promise<unknown>>(async () => null),
  list: vi.fn(),
  repositories: vi.fn(),
  branches: vi.fn(async () => ({ state: 'ready', names: ['main', 'develop'] })),
  attach: vi.fn(async (_input: unknown) => ({ projectRepositoryId: 'r' })),
  addToken: vi.fn(async (_input: unknown) => ({ connectionId: CONNECTION_ID })),
  detach: vi.fn(async (_input: unknown) => ({ detached: true })),
  create: vi.fn(async (input: { projectId: string }) => ({
    projectId: input.projectId,
    created: true,
  })),
}))

vi.mock('@/trpc/client', async () => {
  const { repoTrpc } = await import('./testing/repo-trpc')
  return {
    useTRPC: () => ({
      ...repoTrpc({
        get: calls.get,
        list: calls.list,
        repositories: calls.repositories,
        branches: calls.branches,
        attach: calls.attach,
        addToken: calls.addToken,
        detach: calls.detach,
      }),
      project: {
        pathKey: () => ['project'],
        create: { mutationOptions: () => ({ mutationFn: calls.create }) },
      },
      projectFile: {
        pathKey: () => ['projectFile'],
        list: {
          queryOptions: (input: unknown) => ({
            queryKey: ['projectFile.list', input],
            queryFn: async () => ({ files: [], bytes: 0, limitBytes: 1, percent: 0 }),
          }),
        },
        remove: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
      },
    }),
    useTRPCClient: () => ({
      projectFile: {
        start: { mutate: vi.fn() },
        bind: { mutate: vi.fn() },
        addText: { mutate: vi.fn() },
        remove: { mutate: vi.fn() },
      },
    }),
  }
})

const repository = (overrides: Partial<NonNullable<ProjectDetails['repository']>> = {}) => ({
  id: '0199a3f2-0000-7000-8000-00000000e001',
  provider: 'github' as const,
  host: 'github.com',
  path: 'kolos/site',
  webUrl: 'https://github.com/kolos/site',
  defaultBranch: 'main',
  mode: 'read' as const,
  mirrorState: 'ready' as const,
  connection: null,
  refusal: null,
  secretsFound: [],
  fetchedAt: at,
  ...overrides,
})

const kolos = (repo: ProjectDetails['repository'] = null): ProjectDetails => ({
  id: PROJECT_ID,
  name: 'Сайт пекарни «Колос»',
  goal: null,
  instructions: null,
  useAccountMemory: true,
  starred: false,
  archived: false,
  chats: 0,
  activityAt: at,
  createdAt: at,
  files: { count: 0, bytes: 0, limitBytes: 100 * 1024 * 1024, first: [] },
  memory: { active: 0, proposed: 0 },
  repository: repo,
})

function wrap(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  calls.list.mockResolvedValue({
    connections: [],
    available: { github: false, gitlabCom: false, ownServer: true },
  })
  calls.repositories.mockResolvedValue({ state: 'ready', reason: null, items: [] })
})
afterEach(cleanup)

async function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Добавить в контекст проекта' }))
  return screen.findByRole('menu', { name: 'Добавить в контекст' })
}

describe('the repository of a project (84.17)', () => {
  it('attaches an open link from «Ссылка на GitHub»', async () => {
    wrap(<ProjectContext project={kolos()} />)
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: /Ссылка на GitHub/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Ссылка на репозиторий' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Ссылка/ }), {
      target: { value: 'https://github.com/kolos/site' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Добавить' }))
    await waitFor(() =>
      expect(calls.attach).toHaveBeenCalledWith(
        { projectId: PROJECT_ID, publicUrl: 'https://github.com/kolos/site' },
        expect.anything(),
      ),
    )
  })

  it('offers «Войти заново» on a repository whose sign-in is to be renewed (ревью P3)', async () => {
    const refused = repository({
      provider: 'gitlab',
      mode: 'write',
      connection: {
        id: CONNECTION_ID,
        kind: 'gitlab_oauth',
        login: 'elena.k',
        state: 'reauth_needed',
      },
      refusal: { code: 'GIT_CONNECTION_REAUTH', message: 'Нужно войти в GitLab заново' },
    })
    calls.get.mockResolvedValue(refused)
    wrap(<ProjectContext project={kolos(refused)} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Войти заново' }))
    expect(await screen.findByRole('dialog', { name: 'Подключить репозиторий' })).toBeTruthy()
  })

  it('says a private link in the words of REPO_LINK_PRIVATE, and offers «Отключить»', async () => {
    const refused = repository({
      mirrorState: 'unreachable',
      refusal: {
        code: 'REPO_LINK_PRIVATE',
        message:
          'Репозиторий закрытый или его нет: по ссылке агент видит только открытые репозитории',
      },
    })
    calls.get.mockResolvedValue(refused)
    wrap(<ProjectContext project={kolos(refused)} />)
    expect(
      await screen.findByText(
        'Репозиторий закрытый или его нет: по ссылке агент видит только открытые репозитории',
      ),
    ).toBeTruthy()
    expect(screen.getByText('Репозиторий: kolos/site')).toBeTruthy()
    expect(screen.getByText('по открытой ссылке · только чтение')).toBeTruthy()
    // «Открыть» leads to the page of the repository in Радити (ревью P6).
    expect(
      screen.getByRole('link', { name: 'Открыть репозиторий kolos/site' }).getAttribute('href'),
    ).toBe(`/projects/${PROJECT_ID}/repository`)
    // With a repository the menu offers no second one.
    const menu = await openMenu()
    expect(
      within(menu)
        .getByRole('menuitem', { name: /Ссылка на GitHub/ })
        .getAttribute('aria-disabled'),
    ).toBe('true')
    fireEvent.keyDown(menu, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Открыть контекст проекта' }))
    const dialog = await screen.findByRole('dialog', { name: 'Контекст' })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Отключить репозиторий kolos/site' }),
    )
    await waitFor(() =>
      expect(calls.detach).toHaveBeenCalledWith({ projectId: PROJECT_ID }, expect.anything()),
    )
  })

  it('connects an own GitLab server by a token and picks a repository with its branch', async () => {
    calls.repositories.mockResolvedValue({
      state: 'ready',
      reason: null,
      items: [
        {
          providerRepoId: '7',
          path: 'kolos-bakery/site',
          name: 'site',
          visibility: 'private',
          defaultBranch: 'main',
          canPush: true,
          syncedAt: at,
        },
        {
          providerRepoId: '8',
          path: 'elena.k/recepty',
          name: 'recepty',
          visibility: 'public',
          defaultBranch: 'main',
          canPush: true,
          syncedAt: at,
        },
      ],
    })
    wrap(<ProjectContext project={kolos()} />)
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: /Подключить GitLab/ }))
    const connect = await screen.findByRole('dialog', { name: 'Подключить репозиторий' })
    expect(
      within(connect).getByText('Выберите, где лежит код проекта «Сайт пекарни «Колос»».'),
    ).toBeTruthy()
    // The GitHub App and GitLab.com are not offered here: both «Скоро».
    for (const name of [/^GitHub/, /^GitLab\.com/])
      expect(within(connect).getByRole('radio', { name }).getAttribute('aria-disabled')).toBe(
        'true',
      )
    expect(within(connect).getByText(/лучше токен одного проекта/)).toBeTruthy()
    fireEvent.change(within(connect).getByLabelText('Адрес сервера'), {
      target: { value: 'https://git.kolos-bakery.ru' },
    })
    fireEvent.change(within(connect).getByLabelText('Токен доступа проекта'), {
      target: { value: 'glpat-synthetic-token' },
    })
    fireEvent.click(within(connect).getByRole('button', { name: 'Проверить и подключить' }))
    await waitFor(() =>
      expect(calls.addToken).toHaveBeenCalledWith(
        { host: 'https://git.kolos-bakery.ru', token: 'glpat-synthetic-token' },
        expect.anything(),
      ),
    )
    const pick = await screen.findByRole('dialog', { name: 'Выберите репозиторий' })
    expect(
      await within(pick).findByText('Репозитории, к которым у вас есть доступ · 2'),
    ).toBeTruthy()
    expect(within(pick).getByText('Открытый')).toBeTruthy()
    fireEvent.click(within(pick).getByRole('radio', { name: /site/ }))
    expect(await within(pick).findByText(/в main сам не отправляет/)).toBeTruthy()
    fireEvent.mouseDown(within(pick).getByRole('combobox', { name: 'Основная ветка' }))
    fireEvent.click(await screen.findByRole('option', { name: 'develop' }))
    fireEvent.click(within(pick).getByRole('button', { name: 'Подключить к проекту' }))
    await waitFor(() =>
      expect(calls.attach).toHaveBeenCalledWith(
        {
          projectId: PROJECT_ID,
          connectionId: CONNECTION_ID,
          providerRepoId: '7',
          defaultBranch: 'develop',
        },
        expect.anything(),
      ),
    )
  })

  it('offers GitLab.com where it is configured and published', async () => {
    calls.list.mockResolvedValue({
      connections: [],
      available: { github: false, gitlabCom: true, ownServer: true },
    })
    wrap(<ProjectContext project={kolos()} />)
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: /Подключить GitLab/ }))
    const connect = await screen.findByRole('dialog', { name: 'Подключить репозиторий' })
    const gitlab = await within(connect).findByRole('radio', { name: /^GitLab\.com/ })
    await waitFor(() => expect(gitlab.getAttribute('aria-disabled')).toBe('false'))
    // The window opens on the sign-in, not on the token of an own server (ревью P2).
    expect(within(connect).getByRole('button', { name: 'Войти через GitLab' })).toBeTruthy()
    fireEvent.click(gitlab)
    expect(within(connect).getByRole('button', { name: 'Войти через GitLab' })).toBeTruthy()
  })
})

describe('the GitHub App (84.25)', () => {
  it('«Подключить GitHub» opens the window on GitHub and goes to install the app', async () => {
    calls.list.mockResolvedValue({
      connections: [],
      available: { github: true, gitlabCom: false, ownServer: true },
    })
    const assign = vi.fn()
    const location = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...location, href: 'https://raditi.example/projects/x', assign },
    })
    try {
      wrap(<ProjectContext project={kolos()} />)
      const menu = await openMenu()
      const item = await within(menu).findByRole('menuitem', { name: /Подключить GitHub/ })
      await waitFor(() => expect(item.getAttribute('aria-disabled')).toBeNull())
      fireEvent.click(item)
      const connect = await screen.findByRole('dialog', { name: 'Подключить репозиторий' })
      expect(
        within(connect)
          .getByRole('radio', { name: /^GitHub/ })
          .getAttribute('aria-checked'),
      ).toBe('true')
      fireEvent.click(within(connect).getByRole('button', { name: 'Установить в GitHub' }))
      expect(assign).toHaveBeenCalledWith(
        `https://raditi.example/api/git/github/start?project=${PROJECT_ID}`,
      )
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: location })
    }
  })

  it('offers «Подключить заново» on GitHub when the app was removed or suspended (84.27)', async () => {
    calls.list.mockResolvedValue({
      connections: [],
      available: { github: true, gitlabCom: false, ownServer: true },
    })
    const gone = repository({
      mode: 'write',
      connection: { id: CONNECTION_ID, kind: 'github_app', login: 'kolos', state: 'reauth_needed' },
      refusal: {
        code: 'GIT_CONNECTION_REAUTH',
        message:
          'Приложение Радити на GitHub удалено или приостановлено — подключите GitHub заново',
      },
    })
    calls.get.mockResolvedValue(gone)
    wrap(<ProjectContext project={kolos(gone)} />)
    expect(await screen.findByText(/удалено или приостановлено/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Войти заново' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Подключить заново' }))
    const connect = await screen.findByRole('dialog', { name: 'Подключить репозиторий' })
    await waitFor(() =>
      expect(
        within(connect)
          .getByRole('radio', { name: /^GitHub/ })
          .getAttribute('aria-checked'),
      ).toBe('true'),
    )
  })

  it('«Подключить GitHub» is «Скоро» while the app is not offered', async () => {
    wrap(<ProjectContext project={kolos()} />)
    const menu = await openMenu()
    expect(
      within(menu)
        .getByRole('menuitem', { name: /Подключить GitHub/ })
        .getAttribute('aria-disabled'),
    ).toBe('true')
  })
})

describe('a new project with a link (ПР5)', () => {
  it('saves the link with the project and refuses what is not a repository', async () => {
    const onCreated = vi.fn()
    wrap(<ProjectCreateDialog open onClose={vi.fn()} onCreated={onCreated} />)
    fireEvent.change(screen.getByRole('textbox', { name: /Над чем вы работаете/ }), {
      target: { value: 'Сайт' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Добавить контекст' }))
    const menu = await screen.findByRole('menu', { name: 'Добавить в контекст' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Ссылка на GitHub/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Ссылка на репозиторий' })
    const field = within(dialog).getByRole('textbox', { name: /Ссылка/ })
    fireEvent.change(field, { target: { value: 'https://example.ru' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Добавить' }))
    expect(
      await within(dialog).findByText('Это не ссылка на репозиторий GitHub или GitLab'),
    ).toBeTruthy()
    fireEvent.change(field, { target: { value: 'https://gitlab.com/kolos/site' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Добавить' }))
    expect(await screen.findByText('https://gitlab.com/kolos/site')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Создать проект' }))
    await waitFor(() =>
      expect(calls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Сайт',
          publicRepositoryUrl: 'https://gitlab.com/kolos/site',
        }),
        expect.anything(),
      ),
    )
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ name: 'Сайт' }), {
      connectRepository: false,
    })
  })

  it('«Подключить GitLab» in the window is an intent the page acts on after «Создать проект»', async () => {
    const onCreated = vi.fn()
    wrap(<ProjectCreateDialog open onClose={vi.fn()} onCreated={onCreated} />)
    fireEvent.change(screen.getByRole('textbox', { name: /Над чем вы работаете/ }), {
      target: { value: 'Бот' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Добавить контекст' }))
    const menu = await screen.findByRole('menu', { name: 'Добавить в контекст' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Подключить GitLab/ }))
    expect(await screen.findByText('Подключить GitLab — после создания проекта')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Создать проект' }))
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ name: 'Бот' }), {
        connectRepository: true,
      }),
    )
    expect(calls.create.mock.calls[0]![0]).not.toHaveProperty('publicRepositoryUrl')
  })
})
