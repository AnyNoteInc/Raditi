// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectsView } from './projects-view'

type Project = {
  id: string
  name: string
  url: string
  host: string
  stack: 'wordpress' | 'bitrix'
  status: 'onboarding' | 'active'
  setup: 'pending' | 'failed' | 'done' | null
  createdAt: Date
}

const { listProjects } = vi.hoisted(() => ({
  listProjects: vi.fn<() => Promise<Project[]>>(),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    project: {
      list: {
        queryKey: () => ['project', 'list'],
        queryOptions: () => ({ queryKey: ['project', 'list'], queryFn: listProjects }),
      },
    },
  }),
}))

const project = (overrides: Partial<Project> = {}): Project => ({
  id: '019f1a21-1800-7f00-8abc-111111111111',
  name: 'Кофейня у дома',
  url: 'https://xn--e1aiboc0b6e.xn--p1ai',
  host: 'кофейня.рф',
  stack: 'wordpress',
  status: 'onboarding',
  setup: null,
  createdAt: new Date('2026-10-01T10:00:00Z'),
  ...overrides,
})

function showProjects() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectsView />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  listProjects.mockResolvedValue([])
})

describe('project list', () => {
  it('shows a .рф site by the host the server returned and finds it by that host', async () => {
    listProjects.mockResolvedValue([
      project(),
      project({
        id: '019f1a21-1800-7f00-8abc-222222222222',
        name: 'Студия',
        url: 'https://studio.example',
        host: 'studio.example',
      }),
    ])
    showProjects()

    const link = await screen.findByRole('link', {
      name: 'Открыть сайт Кофейня у дома в новой вкладке',
    })
    expect(link).toHaveTextContent('кофейня.рф')
    expect(link).toHaveAttribute('href', 'https://xn--e1aiboc0b6e.xn--p1ai')
    expect(screen.queryByText(/xn--/)).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: 'Поиск проектов' }), {
      target: { value: 'КОФЕЙНЯ.рф' },
    })
    const sites = within(screen.getByRole('list', { name: 'Сайты' })).getAllByRole('listitem')
    expect(sites).toHaveLength(1)
    expect(sites[0]).toHaveTextContent('Кофейня у дома')
    // The stored form still finds it: an address copied from the browser bar may be ASCII.
    fireEvent.change(screen.getByRole('textbox', { name: 'Поиск проектов' }), {
      target: { value: 'xn--e1aiboc0b6e' },
    })
    expect(
      within(screen.getByRole('list', { name: 'Сайты' })).getAllByRole('listitem'),
    ).toHaveLength(1)
  })

  it('does not decode an address by itself: the readable host is the one in the answer', async () => {
    // Deliberately not the host of `url`: only the field of the answer can produce this text.
    listProjects.mockResolvedValue([project({ host: 'магазин.рф:8443' })])
    showProjects()

    const link = await screen.findByRole('link', {
      name: 'Открыть сайт Кофейня у дома в новой вкладке',
    })
    expect(link).toHaveTextContent('магазин.рф:8443')
    expect(link).toHaveAttribute('href', 'https://xn--e1aiboc0b6e.xn--p1ai')
    fireEvent.change(screen.getByRole('textbox', { name: 'Поиск проектов' }), {
      target: { value: 'магазин.рф' },
    })
    expect(
      within(screen.getByRole('list', { name: 'Сайты' })).getAllByRole('listitem'),
    ).toHaveLength(1)
  })
})

describe('adding a project', () => {
  it('leads from the empty list to the wizard of a new project', async () => {
    showProjects()
    const add = await screen.findByRole('link', { name: 'Добавить проект' })
    expect(add).toHaveAttribute('href', '/projects/new')
    // No form in the list: the wizard is a page of its own.
    expect(screen.queryByRole('textbox', { name: /Название проекта/ })).not.toBeInTheDocument()
  })

  it('leads from the heading of a list with projects to the same wizard', async () => {
    listProjects.mockResolvedValue([project()])
    showProjects()
    await screen.findByRole('list', { name: 'Сайты' })
    const links = screen.getAllByRole('link', { name: 'Добавить проект' })
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', '/projects/new')
  })
})

describe('the chip of a project', () => {
  const chipOf = async (overrides: Partial<Project>) => {
    listProjects.mockResolvedValue([project(overrides)])
    showProjects()
    const [site] = within(await screen.findByRole('list', { name: 'Сайты' })).getAllByRole(
      'listitem',
    )
    return site!.querySelector('.MuiChip-root')
  }

  it.each([
    [{ setup: 'pending' }, 'Настраиваем'],
    [{ setup: 'failed' }, 'Ошибка настройки'],
    [{ setup: 'done' }, 'Ожидает подключения'],
    [{ setup: null }, 'Ожидает подключения'],
    [{ setup: null, status: 'active' }, 'Подключён'],
  ] as const)('says %o as «%s»', async (overrides, label) => {
    expect(await chipOf(overrides)).toHaveTextContent(label)
  })

  it('marks a failed setup by its colour as well as its words', async () => {
    expect(await chipOf({ setup: 'failed' })).toHaveClass('MuiChip-colorError')
  })
})
