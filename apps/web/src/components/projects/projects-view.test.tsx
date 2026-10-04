// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectsView } from './projects-view'

type Project = {
  id: string
  name: string
  url: string
  host: string
  stack: 'wordpress' | 'bitrix'
  status: 'onboarding' | 'active'
  createdAt: Date
}
type NewProject = { name: string; url: string; stack: string }

const { listProjects, createProject } = vi.hoisted(() => ({
  listProjects: vi.fn<() => Promise<Project[]>>(),
  createProject: vi.fn<(input: NewProject) => Promise<Project>>(),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    project: {
      list: {
        queryKey: () => ['project', 'list'],
        queryOptions: () => ({ queryKey: ['project', 'list'], queryFn: listProjects }),
      },
      create: {
        mutationOptions: (options: UseMutationOptions<Project, Error, NewProject>) => ({
          ...options,
          mutationFn: createProject,
        }),
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

async function openForm() {
  showProjects()
  fireEvent.click(await screen.findByRole('button', { name: 'Добавить сайт' }))
  fireEvent.change(screen.getByRole('textbox', { name: /Название проекта/ }), {
    target: { value: 'Магазин' },
  })
}

function submitAddress(address: string) {
  fireEvent.change(screen.getByRole('textbox', { name: /Адрес сайта/ }), {
    target: { value: address },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Создать проект' }))
}

/** What the tRPC client throws: the Russian text of the server and its codes. */
const serverError = (message: string, code: string, domainCode: string | null) =>
  Object.assign(new Error(message), { data: { code, domainCode } })

beforeEach(() => {
  vi.clearAllMocks()
  listProjects.mockResolvedValue([])
  createProject.mockImplementation(async (input) =>
    project({ ...input, host: new URL(input.url).host, stack: 'wordpress' }),
  )
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

describe('new project form', () => {
  it.each([
    ['shop.example.ru:8443', 'https://shop.example.ru:8443'],
    ['example.ru', 'https://example.ru'],
    ['localhost:8080', 'https://localhost:8080'],
    ['HTTP://example.ru/', 'HTTP://example.ru/'],
    ['http://example.ru:8080', 'http://example.ru:8080'],
  ])('accepts %s and sends %s', async (typed, sent) => {
    await openForm()
    submitAddress(typed)
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1))
    expect(createProject.mock.calls[0]?.[0]).toEqual({
      name: 'Магазин',
      url: sent,
      stack: 'wordpress',
    })
  })

  it.each([
    'example.ru/shop',
    'mailto:owner@example.ru',
    'ftp://example.ru',
    'javascript:alert(1)',
  ])('refuses %s before any request', async (typed) => {
    await openForm()
    submitAddress(typed)
    expect(
      screen.getByText('Укажите адрес сайта без пути к странице, например https://example.ru'),
    ).toBeVisible()
    expect(createProject).not.toHaveBeenCalled()
  })

  it('offers only the platform that can be connected and marks the others as coming', async () => {
    await openForm()
    expect(screen.getByText('Сейчас подключаем сайты на WordPress.')).toBeVisible()
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Платформа сайта' }))
    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      'WordPress',
      '1С-Битрикс — скоро',
      'Laravel — скоро',
      'HTML / CSS — скоро',
      'Node.js — скоро',
      'Python — скоро',
    ])
    expect(options.map((option) => option.getAttribute('aria-disabled') === 'true')).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
    ])
  })

  it.each([
    [
      serverError(
        'Укажите адрес сайта, который открывается из интернета',
        'BAD_REQUEST',
        'SITE_ADDRESS_NOT_PUBLIC',
      ),
      'Укажите адрес сайта, который открывается из интернета.',
    ],
    [
      serverError(
        'Вы добавили максимальное число сайтов. Напишите нам, если нужно больше',
        'FORBIDDEN',
        'PROJECT_LIMIT_REACHED',
      ),
      'Вы добавили максимальное число сайтов. Напишите нам, если нужно больше.',
    ],
    [
      serverError('Сайт с таким адресом уже добавлен', 'CONFLICT', 'PROJECT_ALREADY_EXISTS'),
      'Сайт с таким адресом уже добавлен.',
    ],
    [
      serverError('Проверьте введённые данные', 'BAD_REQUEST', null),
      'Проверьте название и адрес сайта. Нужен полный адрес без пути к странице.',
    ],
    [
      serverError('Что-то пошло не так', 'INTERNAL_SERVER_ERROR', null),
      'Не удалось добавить проект. Попробуйте ещё раз.',
    ],
  ])('explains a refusal of the server: %s', async (error, text) => {
    createProject.mockRejectedValue(error)
    await openForm()
    submitAddress('https://example.ru')
    expect(await screen.findByText(text)).toBeVisible()
  })
})
