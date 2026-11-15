// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Upload from './attachment-upload'
import { greetingLines } from './chat-greeting'
import { taskWayText } from './chat-texts'
import { NewChat } from './new-chat'
import { forgetNewDialog, isNewDialog } from './new-dialog-hint'

type Created = { taskId: string; alias: string; created: boolean }
type CreateInput = {
  taskId: string
  text: string
  attachments?: string[]
}

const { create, push, search, start, setPreference, projects } = vi.hoisted(() => ({
  setPreference: vi.fn(),
  projects: vi.fn(async () => ({ items: [] as unknown[] })),
  create: vi.fn<(input: CreateInput) => Promise<Created>>(),
  push: vi.fn<(path: string) => void>(),
  search: { params: new URLSearchParams() },
  start: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => search.params,
}))

vi.mock('@repo/ui/providers', () => ({
  useThemePreference: () => ({ preference: 'system', setPreference }),
}))

// The bytes of a chosen file reach the server at once: the upload itself is the composer's test.
vi.mock('./attachment-upload', async (original) => ({
  ...(await original<typeof Upload>()),
  uploadBytes: vi.fn(async () => ({ attachmentId: ATTACHMENT, size: 16 })),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    task: {
      create: {
        mutationOptions: (options: UseMutationOptions<Created, Error, CreateInput>) => ({
          ...options,
          mutationFn: create,
        }),
      },
    },
    project: {
      pathKey: () => ['project'],
      list: { queryOptions: () => ({ queryKey: ['project', 'list'], queryFn: projects }) },
      create: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
    },
    billing: {
      usage: {
        queryKey: () => ['billing', 'usage'],
        // The hint of the windows (plan 71) reads nothing in these cases.
        queryOptions: () => ({ queryKey: ['billing', 'usage'], queryFn: async () => null }),
      },
    },
  }),
  useTRPCClient: () => ({
    attachment: {
      start: { mutate: start },
      remove: { mutate: vi.fn() },
    },
  }),
}))

const { ATTACHMENT } = vi.hoisted(() => ({ ATTACHMENT: '0199a3f2-0000-7000-8000-0000000000f1' }))
const USER_ID = 'user-of-the-tab'
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const described = (element: HTMLElement) =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')

function showChat(props: { beside?: boolean; userId?: string; userName?: string | null } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const screenOfChat = () => (
    <QueryClientProvider client={queryClient}>
      <NewChat userId={USER_ID} {...props} />
    </QueryClientProvider>
  )
  const { rerender } = render(screenOfChat())
  return Object.assign(queryClient, {
    /** The page stays mounted: the address changed under it. */
    moved: (address: string) => {
      search.params = new URLSearchParams(address)
      rerender(screenOfChat())
    },
  })
}

const field = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Сообщение' })
const send = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Отправить' })
const write = (text: string) => fireEvent.change(field(), { target: { value: text } })
const attach = async () => {
  fireEvent.change(screen.getByTestId('composer-files'), {
    target: { files: [new File([new Uint8Array(16)], 'Меню.pdf', { type: 'application/pdf' })] },
  })
  await screen.findByRole('list', { name: 'Файлы к сообщению' })
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  search.params = new URLSearchParams()
  start.mockResolvedValue({ attachmentId: ATTACHMENT, uploadPath: '/x' })
  create.mockImplementation(async ({ taskId }) => ({ taskId, alias: 'a1b2c3', created: true }))
})

afterEach(() => {
  window.localStorage.removeItem('raditi-chat-effort')
  vi.unstubAllGlobals()
})

describe('new chat', () => {
  it('opens with one line — the greeting by name or a phrase — and labels the message field', () => {
    showChat({ userName: 'Виктор Луферов' })
    const heading = screen.getByRole('heading', { level: 1 })
    expect(
      /^(Доброе утро|Добрый день|Добрый вечер|Доброй ночи), Виктор!$/.test(
        heading.textContent ?? '',
      ) || (greetingLines as readonly string[]).includes(heading.textContent ?? ''),
    ).toBe(true)
    for (const line of greetingLines)
      if (line !== heading.textContent) expect(screen.queryByText(line)).toBeNull()
    expect(field().tagName).toBe('TEXTAREA')
    expect(field().getAttribute('placeholder')).toBe('Что нужно сделать?')
  })

  it('takes the level below beside a list that heads the page', () => {
    showChat({ beside: true })
    expect(screen.getByRole('heading', { level: 2 })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })

  it('has no switch of modes, and its pill says «Без проекта» (docs/plan/84, ПР30)', () => {
    showChat()
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByRole('button', { name: 'Без проекта' })).toBeTruthy()
  })

  it('starts a chat under an id of the browser, without a project by default', async () => {
    const queryClient = showChat()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    write('Предложите пять названий для пекарни')
    fireEvent.click(send())
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1))
    // The list shows the new chat, and the credits under it what its reserve left.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['billing', 'usage'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['chat', 'dialogs'] })
    const [input] = create.mock.calls[0]!
    expect(input).toEqual({
      taskId: expect.stringMatching(UUID_V7),
      text: 'Предложите пять названий для пекарни',
      // «Высокое» unless the client picks another.
      effort: 'high',
      projectId: null,
    })
    expect(push).toHaveBeenCalledWith(`/chats/${input.taskId}`)
  })

  describe('the project of the chat (docs/plan/84-projects.md, ПР30)', () => {
    const KOLOS = '0199a3f2-0000-7000-8000-00000000c001'
    const TEA = '0199a3f2-0000-7000-8000-00000000c002'
    const listed = (id: string, name: string, patch: Record<string, unknown> = {}) => ({
      id,
      name,
      goal: null,
      starred: false,
      archived: false,
      chats: 0,
      hasInstructions: false,
      activityAt: new Date(),
      createdAt: new Date(),
      purgeAfter: null,
      ...patch,
    })
    beforeEach(() => {
      projects.mockResolvedValue({
        items: [
          listed(TEA, 'Интернет-магазин чая'),
          listed(KOLOS, 'Сайт пекарни «Колос»', {
            starred: true,
            hasInstructions: true,
            goal: 'Обновить сайт к зиме',
          }),
        ],
      })
    })

    it('lists the starred first, finds one by its name, and starts the chat in it', async () => {
      showChat()
      fireEvent.click(screen.getByRole('button', { name: 'Без проекта' }))
      const menu = await screen.findByRole('menu', { name: 'Проект для чата' })
      await within(menu).findByRole('menuitemradio', { name: /Колос/ })
      const names = within(menu)
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent)
      expect(names[0]).toContain('Без проекта')
      expect(names[1]).toContain('Сайт пекарни «Колос»')
      expect(names[2]).toContain('Интернет-магазин чая')
      fireEvent.change(screen.getByRole('textbox', { name: 'Найти проект' }), {
        target: { value: 'колос' },
      })
      expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(1)
      fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Колос/ }))

      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        'Новый чат в проекте «Сайт пекарни «Колос»»',
      )
      expect(screen.getByText('Обновить сайт к зиме')).toBeTruthy()
      expect(screen.getByText('Агент учтёт инструкции и цель проекта')).toBeTruthy()
      expect(screen.getByRole('link', { name: 'Открыть проект' }).getAttribute('href')).toBe(
        `/projects/${KOLOS}`,
      )
      write('Сверь цены в прайсе с сайтом')
      fireEvent.click(send())
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
      expect(create.mock.calls[0]![0]).toMatchObject({ projectId: KOLOS })
    })

    it('keeps the words and the files of the field when the project changes', async () => {
      showChat()
      write('Черновик до выбора')
      await attach()
      fireEvent.click(screen.getByRole('button', { name: 'Без проекта' }))
      const menu = await screen.findByRole('menu', { name: 'Проект для чата' })
      fireEvent.click(await within(menu).findByRole('menuitemradio', { name: /чая/ }))
      expect(field().value).toBe('Черновик до выбора')
      expect(screen.getByRole('list', { name: 'Файлы к сообщению' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Проект: Интернет-магазин чая' }))
      fireEvent.click(
        within(await screen.findByRole('menu', { name: 'Проект для чата' })).getByRole(
          'menuitemradio',
          { name: /Без проекта/ },
        ),
      )
      expect(field().value).toBe('Черновик до выбора')
      expect(screen.getByRole('button', { name: 'Без проекта' })).toBeTruthy()
    })

    it('chooses the project of `?project=` once the list names it as the user’s', async () => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      render(
        <QueryClientProvider client={queryClient}>
          <NewChat userId={USER_ID} projectId={TEA} />
        </QueryClientProvider>,
      )
      expect(
        await screen.findByRole('button', { name: 'Проект: Интернет-магазин чая' }),
      ).toBeTruthy()
      expect(screen.getByText('Агент учтёт цель проекта')).toBeTruthy()
    })

    it('starts without a project when `?project=` names none of the user’s', async () => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      render(
        <QueryClientProvider client={queryClient}>
          <NewChat userId={USER_ID} projectId="0199a3f2-0000-7000-8000-0000000000ff" />
        </QueryClientProvider>,
      )
      await waitFor(() => expect(projects).toHaveBeenCalled())
      expect(await screen.findByRole('button', { name: 'Без проекта' })).toBeTruthy()
    })

    it('starts the chat in the project of `?project=` before the list has come (84.7)', async () => {
      // The list is on its way the whole time: the id of the address stands for the project.
      projects.mockImplementation(() => new Promise<never>(() => {}))
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      render(
        <QueryClientProvider client={queryClient}>
          <NewChat userId={USER_ID} projectId={TEA.toUpperCase()} />
        </QueryClientProvider>,
      )
      expect(screen.getByRole('button', { name: 'Загружаем проект…' })).toBeTruthy()
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Новый чат в проекте')
      expect(screen.queryByRole('button', { name: 'Без проекта' })).toBeNull()
      expect(screen.queryByText(/Агент учтёт/)).toBeNull()
      write('Сверь цены в прайсе с сайтом')
      fireEvent.click(send())
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
      expect(create.mock.calls[0]![0]).toMatchObject({ projectId: TEA })
    })
  })

  it('reminds that keys and passwords go to «Переменные», not to the chat', () => {
    showChat()
    expect(described(field())).toContain(taskWayText.noSecrets)
  })

  it('repeats a request that got no answer under the same id, and keeps the words', async () => {
    create.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    showChat()
    write('Поменяйте телефон в шапке сайта')
    fireEvent.click(send())
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Не удалось связаться с сервером. Проверьте подключение и попробуйте ещё раз.',
    )
    expect(field().value).toBe('Поменяйте телефон в шапке сайта')
    fireEvent.click(send())
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1))
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[1]![0].taskId).toBe(create.mock.calls[0]![0].taskId)
  })

  it('tells the chat it opens that the client watched it start (docs/plan/59, И3)', async () => {
    // Asked as the screen moves: the chat reads it on its first render.
    const told: boolean[] = []
    push.mockImplementationOnce((path) => void told.push(isNewDialog(path.split('/').at(-1)!)))
    showChat()
    write('Поменяйте телефон в шапке сайта')
    fireEvent.click(send())
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1))
    expect(told).toEqual([true])
    forgetNewDialog(create.mock.calls[0]![0].taskId)
  })

  describe('the window of commands', () => {
    const REASON = 'Команды работают внутри чата. Сначала напишите, что нужно сделать.'

    it('answers a typed command of the server, and the words stay in the field', async () => {
      showChat()
      write('/undo')
      fireEvent.keyDown(field(), { key: 'Escape' })
      fireEvent.keyDown(field(), { key: 'Enter', ctrlKey: true })
      expect((await screen.findByRole('alert')).textContent).toBe(REASON)
      expect(field().value).toBe('/undo')
      expect(create).not.toHaveBeenCalled()
    })

    it('`/themes` opens the menu over the field and starts no chat', async () => {
      showChat()
      write('/themes')
      fireEvent.keyDown(field(), { key: 'Enter' })
      const menu = within(await screen.findByRole('menu', { name: 'Оформление' }))
      fireEvent.click(menu.getByRole('menuitemradio', { name: 'Тёмная' }))
      expect(setPreference).toHaveBeenCalledWith('dark')
      expect(create).not.toHaveBeenCalled()
      expect(field().value).toBe('')
    })

    it('`/details` is kept for the chats to come, and a screen reader is told', async () => {
      window.localStorage.clear()
      showChat()
      write('/details')
      fireEvent.keyDown(field(), { key: 'Enter' })
      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toBe('Подробности работы показаны'),
      )
      expect(window.localStorage.getItem('raditi-chat-details')).toBe('1')
      expect(create).not.toHaveBeenCalled()
      window.localStorage.clear()
    })

    it('`/thinking` is kept for the chats to come, and a screen reader is told', async () => {
      window.localStorage.clear()
      showChat()
      write('/thinking')
      fireEvent.keyDown(field(), { key: 'Enter' })
      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toBe('Размышления агента показаны'),
      )
      expect(window.localStorage.getItem('raditi-chat-thinking')).toBe('1')
      expect(create).not.toHaveBeenCalled()
      window.localStorage.clear()
    })
  })

  it('lets the client pick how hard the model thinks, «Высокое» first', async () => {
    showChat()
    fireEvent.click(screen.getByRole('button', { name: 'Размышление: Высокое' }))
    const efforts = within(await screen.findByRole('menu', { name: 'Размышление' }))
    fireEvent.click(efforts.getByRole('menuitemradio', { name: /Максимальное/ }))
    expect(screen.getByRole('button', { name: 'Размышление: Максимальное' })).toBeTruthy()
    write('Расскажи про этот проект')
    fireEvent.click(send())
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]![0]).toMatchObject({ effort: 'max' })
  })

  it('remembers the level of thinking after the page is opened anew', () => {
    const first = showChat()
    fireEvent.click(screen.getByRole('button', { name: 'Размышление: Высокое' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Максимальное/ }))
    first.clear()
    cleanup()
    showChat()
    expect(screen.getByRole('button', { name: 'Размышление: Максимальное' })).toBeTruthy()
    expect(window.localStorage.getItem('raditi-chat-effort')).toBe('max')
  })
})

describe('files of a new chat', () => {
  it('go before the first words, and with them (C-first)', async () => {
    showChat()
    await attach()
    expect(start).toHaveBeenCalledWith(expect.not.objectContaining({ siteId: expect.anything() }))
    write('Перескажите файл')
    await waitFor(() => expect(send().disabled).toBe(false))
    fireEvent.click(send())
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]![0]).toMatchObject({ attachments: [ATTACHMENT] })
  })
})

describe('the caret of a new chat (docs/plan/79, П4)', () => {
  it('stands in the field as the screen opens', async () => {
    showChat()
    const area = await screen.findByRole('textbox', { name: 'Сообщение' })
    await waitFor(() => expect(document.activeElement).toBe(area))
  })
})
