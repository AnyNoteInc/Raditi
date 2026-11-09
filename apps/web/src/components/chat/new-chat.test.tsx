// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { serverRefusal } from '@/components/billing/testing'

import type * as Upload from './attachment-upload'
import { greetingLines } from './chat-greeting'
import { taskWayText } from './chat-texts'
import type { ProjectListItem } from './chat-types'
import { keepChatDraft } from './chat-draft'
import { NewChat } from './new-chat'
import { forgetNewDialog, isNewDialog } from './new-dialog-hint'
import { SITE_ID } from './testing'

type Created = { taskId: string; alias: string; created: boolean }
type CreateInput = {
  siteId: string | null
  taskId: string
  text: string
  attachments?: string[]
}

const { create, push, search, start, projectList, setPreference } = vi.hoisted(() => ({
  setPreference: vi.fn(),
  create: vi.fn<(input: CreateInput) => Promise<Created>>(),
  push: vi.fn<(path: string) => void>(),
  // The query of the address: `?project=`.
  search: { params: new URLSearchParams() },
  start: vi.fn(),
  projectList: vi.fn<() => Promise<ProjectListItem[]>>(),
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
      list: { queryOptions: () => ({ queryKey: ['project.list'], queryFn: projectList }) },
    },
    billing: { usage: { queryKey: () => ['billing', 'usage'] } },
  }),
  useTRPCClient: () => ({
    attachment: {
      start: { mutate: start },
      remove: { mutate: vi.fn() },
    },
  }),
}))

const { ATTACHMENT } = vi.hoisted(() => ({ ATTACHMENT: '0199a3f2-0000-7000-8000-0000000000f1' }))
const OTHER_ID = '0199a3f2-0000-8000-8000-000000000002'
const CLOSED_ID = '0199a3f2-0000-8000-8000-000000000003'
const USER_ID = 'user-of-the-tab'
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function project(
  id: string,
  name: string,
  chat: Partial<ProjectListItem['chat']> = {},
): ProjectListItem {
  return {
    id,
    name,
    url: 'https://kroshka.example',
    host: 'kroshka.example',
    stack: 'wordpress',
    status: 'active',
    createdAt: new Date(),
    setup: null,
    capabilities: { repository: 'ready', browser: 'ready' },
    chat: { state: 'ready', requirements: { repository: true, browser: true }, ...chat },
  } as ProjectListItem
}

const KROSHKA = project(SITE_ID, 'Кофейня «Крошка»')
const GRAND = project(OTHER_ID, 'Автосервис «Гранд»', {
  requirements: { repository: true, browser: false },
})
const CLOSED = project(CLOSED_ID, 'Студия «Линия»', { state: 'closed', requirements: null })

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

/** Whether the window is `md` or wider, as every media query of the screen reads it. */
const windowFrom = (wide: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))

const field = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Сообщение' })
const send = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Отправить' })
const write = (text: string) => fireEvent.change(field(), { target: { value: text } })
const pill = (name: string) =>
  screen.getByRole('button', { name: `Проект для этого чата: ${name}` })
async function choose(from: string, to: RegExp) {
  fireEvent.click(pill(from))
  fireEvent.click(await screen.findByRole('menuitem', { name: to }))
}
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
  projectList.mockResolvedValue([KROSHKA, GRAND, CLOSED])
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

  it('has no switch of modes', () => {
    showChat()
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('starts a chat without a project by default, under an id of the browser', async () => {
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
      siteId: null,
      taskId: expect.stringMatching(UUID_V7),
      text: 'Предложите пять названий для пекарни',
      // «Высокое» unless the client picks another.
      effort: 'high',
    })
    expect(push).toHaveBeenCalledWith(`/chats/${input.taskId}`)
  })

  it('sends only the project chosen: what the agent works with is the server’s to read', async () => {
    showChat()
    await waitFor(() => expect(projectList).toHaveBeenCalled())
    await choose('Без проекта', /Кофейня/)
    write('Поменяйте телефон в шапке сайта')
    fireEvent.click(send())
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const [input] = create.mock.calls[0]!
    expect(input.siteId).toBe(SITE_ID)
    expect(input).not.toHaveProperty('requirements')
  })

  it.each([
    ['the project is unknown', '0199a3f2-0000-8000-8000-0000000000ee'],
    ['the project is closed', CLOSED_ID],
    ['the address is no id', 'nonsense'],
  ])('is «Без проекта» when %s', async (_case, id) => {
    search.params = new URLSearchParams(`project=${id}`)
    showChat()
    await waitFor(() => expect(projectList).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pill('Без проекта')).toBeTruthy()
    write('Слова')
    fireEvent.click(send())
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]![0].siteId).toBeNull()
  })

  it('chooses the project of the address once the list says it may be chosen', async () => {
    search.params = new URLSearchParams(`project=${SITE_ID}`)
    showChat()
    expect(await screen.findByRole('button', { name: /Кофейня/ })).toBeTruthy()
  })

  it.each([
    ['the list is loading', () => new Promise<ProjectListItem[]>(() => {})],
    ['the list failed', () => Promise.reject(new Error('down'))],
  ])('sends without a project while %s', async (_case, answer) => {
    projectList.mockImplementation(answer)
    showChat()
    expect(pill('Без проекта')).toBeTruthy()
    write('Слова')
    expect(send().disabled).toBe(false)
    fireEvent.click(send())
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]![0].siteId).toBeNull()
  })

  it('takes a new id for the chat after the pill changes: the old id is of another chat', async () => {
    create.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    showChat()
    await waitFor(() => expect(projectList).toHaveBeenCalled())
    write('Поменяйте телефон')
    fireEvent.click(send())
    await screen.findByRole('alert')
    await choose('Без проекта', /Кофейня/)
    fireEvent.click(send())
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(create.mock.calls[1]![0].taskId).not.toBe(create.mock.calls[0]![0].taskId)
    expect(create.mock.calls[1]![0].siteId).toBe(SITE_ID)
  })

  it('takes a new id when the list that arrives moves the pill after a lost answer', async () => {
    let answer: (list: ProjectListItem[]) => void = () => undefined
    projectList.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    search.params = new URLSearchParams(`project=${SITE_ID}`)
    create.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    showChat()
    write('Поменяйте телефон')
    fireEvent.click(send())
    await screen.findByRole('alert')
    expect(create.mock.calls[0]![0].siteId).toBeNull()
    answer([KROSHKA])
    expect(await screen.findByRole('button', { name: /Кофейня/ })).toBeTruthy()
    fireEvent.click(send())
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[1]![0].siteId).toBe(SITE_ID)
    expect(create.mock.calls[1]![0].taskId).not.toBe(create.mock.calls[0]![0].taskId)
  })

  it('takes a new id when the address moves the pill after a lost answer', async () => {
    search.params = new URLSearchParams(`project=${SITE_ID}`)
    create.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const chat = showChat()
    await screen.findByRole('button', { name: /Кофейня/ })
    write('Поменяйте телефон')
    fireEvent.click(send())
    await screen.findByRole('alert')
    // «Новый чат» of the list: the same page, another address.
    chat.moved('')
    expect(pill('Без проекта')).toBeTruthy()
    fireEvent.click(send())
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[1]![0].siteId).toBeNull()
    expect(create.mock.calls[1]![0].taskId).not.toBe(create.mock.calls[0]![0].taskId)
  })

  it('keeps «Без проекта» pressed before the list came, whatever the address asks', async () => {
    let answer: (list: ProjectListItem[]) => void = () => undefined
    projectList.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    search.params = new URLSearchParams(`project=${SITE_ID}`)
    showChat()
    await choose('Без проекта', /^Без проекта/)
    answer([KROSHKA])
    await waitFor(() => expect(projectList).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pill('Без проекта')).toBeTruthy()
    write('Слова')
    fireEvent.click(send())
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]![0].siteId).toBeNull()
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

  const SECRET_REFUSAL =
    'Похоже, в сообщении есть пароль или ключ. Не отправляйте их в чат — доступы задаются в разделе «Переменные»'

  it('says a refusal of the server in its words, the project of the chat being chosen', async () => {
    search.params = new URLSearchParams(`project=${SITE_ID}`)
    create.mockRejectedValueOnce(serverRefusal('Не удалось начать чат', 'SOME_REFUSAL'))
    showChat()
    await screen.findByRole('button', { name: /Кофейня/ })
    write('Поменяйте телефон')
    fireEvent.click(send())
    expect((await screen.findByRole('alert')).textContent).toBe('Не удалось начать чат.')
    create.mockRejectedValueOnce(serverRefusal(SECRET_REFUSAL, 'TASK_TEXT_HAS_SECRET'))
    fireEvent.click(send())
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(`${SECRET_REFUSAL}.`))
  })

  it('sends no client without a project to the «Переменные» it does not have for a password', async () => {
    create.mockRejectedValueOnce(serverRefusal(SECRET_REFUSAL, 'TASK_TEXT_HAS_SECRET'))
    showChat()
    write('пароль: hunter2')
    fireEvent.click(send())
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Похоже, в сообщении есть пароль или ключ. Не отправляйте их в чат.',
    )
    expect(push).not.toHaveBeenCalled()
    // No chat was started: none is told it was.
    expect(isNewDialog(create.mock.calls[0]![0].taskId)).toBe(false)
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
    const list = () => screen.getByRole('listbox', { name: 'Команды' })
    const named = (name: RegExp) => within(list()).getByRole('option', { name })
    const none = (name: RegExp) => within(list()).queryByRole('option', { name })
    const SITE = [
      /Выпустить новую версию/,
      /Открыть предпросмотр/,
      /Обновить рабочую копию/,
      /Сбросить данные предпросмотра/,
    ]
    const page = [
      /Новый чат/,
      /Все чаты/,
      /Модель и размышление/,
      /Подробности работы/,
      /Размышления агента/,
      /Оформление/,
      /Справка/,
    ]
    const closed = (names: readonly RegExp[]) => {
      for (const name of names) {
        expect(named(name).getAttribute('aria-disabled')).toBe('true')
        expect(named(name).textContent).toContain(REASON)
      }
    }

    it('has no group «Сайт» without a project: that chat will have none (К27)', () => {
      showChat()
      write('/')
      for (const name of SITE) expect(none(name)).toBeNull()
      expect(within(list()).queryByText('Сайт', { exact: true })).toBeNull()
      closed([/Отменить последний запрос/, /Вернуть отменённый запрос/, /Отменить чат/])
      closed([/Скачать переписку/])
      for (const name of page) expect(named(name).getAttribute('aria-disabled')).toBeNull()
      expect(none(/Отменить выпуск/)).toBeNull()
      expect(none(/Попробовать ещё/)).toBeNull()
    })

    it('has none on a project without its files either', async () => {
      search.params = new URLSearchParams(`project=${OTHER_ID}`)
      projectList.mockResolvedValue([
        project(OTHER_ID, 'Автосервис «Гранд»', {
          requirements: { repository: false, browser: true },
        }),
      ])
      showChat()
      await screen.findByRole('button', { name: /Автосервис «Гранд»/ })
      write('/')
      for (const name of SITE) expect(none(name)).toBeNull()
    })

    it('says of the site commands of a project with files that they work inside a chat', async () => {
      search.params = new URLSearchParams(`project=${OTHER_ID}`)
      projectList.mockResolvedValue([GRAND])
      showChat()
      await screen.findByRole('button', { name: /Автосервис «Гранд»/ })
      write('/')
      closed(SITE)
      expect(none(/Отменить выпуск/)).toBeNull()
    })

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

  it('runs the commands of the page here too: the list, the level, a new chat of the project', async () => {
    projectList.mockResolvedValue([KROSHKA])
    search.params = new URLSearchParams(`project=${SITE_ID}`)
    showChat()
    await screen.findByRole('button', { name: /Крошка/ })
    write('/sessions')
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(push).toHaveBeenLastCalledWith('/chats')
    write('/new')
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(push).toHaveBeenLastCalledWith(`/chats/new?project=${SITE_ID}`)
    write('/mo')
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(await screen.findByRole('menu', { name: 'Размышление' })).toBeTruthy()
    expect(create).not.toHaveBeenCalled()
  })

  it('never starts a chat with the words of a command', () => {
    showChat()
    write('/release')
    fireEvent.click(send())
    expect(create).not.toHaveBeenCalled()
    // A chat without a project will not have it: «внутри чата» would not be true.
    expect(screen.getByRole('alert').textContent).toBe('Эта команда сейчас недоступна.')
  })

  it('says of a command of a project with files that it works inside a chat', async () => {
    search.params = new URLSearchParams(`project=${OTHER_ID}`)
    projectList.mockResolvedValue([GRAND])
    showChat()
    await screen.findByRole('button', { name: /Автосервис «Гранд»/ })
    write('/release')
    fireEvent.click(send())
    expect(create).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(
      'Команды работают внутри чата. Сначала напишите, что нужно сделать.',
    )
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

  it('has the controls of a chat in their order, the pill before the level of thinking', () => {
    showChat()
    expect(
      screen.getAllByRole('button').map((button) => button.getAttribute('aria-label')),
    ).toEqual([
      'Команды',
      'Прикрепить файлы',
      'Проект для этого чата: Без проекта',
      'Размышление: Высокое',
      'Отправить',
    ])
  })

  it('reminds of the sign-in only where the project has a browser', async () => {
    showChat()
    await waitFor(() => expect(projectList).toHaveBeenCalled())
    expect(described(field())).not.toContain(taskWayText.noSecrets)
    // A chat without a project has no «Переменные» to point to.
    expect(described(field())).toContain(taskWayText.noSecretsPlain)
    expect(described(field())).not.toContain('Переменные')
    await choose('Без проекта', /Гранд/)
    expect(described(field())).not.toContain(taskWayText.noSecrets)
    expect(described(field())).toContain('доступы задаются в разделе «Переменные»')
    await choose('Автосервис «Гранд»', /Кофейня/)
    expect(described(field())).toContain(taskWayText.noSecrets)
  })
})

describe('files of a new chat', () => {
  it('goes without a project, before the first words (C-first)', async () => {
    showChat()
    await attach()
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ siteId: null }))
    write('Перескажите файл')
    await waitFor(() => expect(send().disabled).toBe(false))
    fireEvent.click(send())
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]![0]).toMatchObject({ siteId: null, attachments: [ATTACHMENT] })
  })

  it('locks the project they were sent for, and says how to change it', async () => {
    showChat()
    await waitFor(() => expect(projectList).toHaveBeenCalled())
    await choose('Без проекта', /Кофейня/)
    await attach()
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ siteId: SITE_ID }))
    expect(screen.queryByRole('button', { name: /^Проект для этого чата/ })).toBeNull()
    const locked = screen.getByRole('button', { name: /Кофейня/ })
    expect(locked.getAttribute('aria-disabled')).toBe('true')
    expect(described(locked)).toBe('Чтобы сменить проект, уберите прикреплённые файлы.')
  })

  it('stays with «Без проекта» too, and an address does not move a file', async () => {
    let answer: (list: ProjectListItem[]) => void = () => undefined
    projectList.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    search.params = new URLSearchParams(`project=${SITE_ID}`)
    showChat()
    await attach()
    await waitFor(() => expect(start).toHaveBeenCalled())
    answer([KROSHKA])
    await waitFor(() => expect(screen.getByRole('button', { name: /Без проекта/ })).toBeTruthy())
    write('Перескажите файл')
    await waitFor(() => expect(send().disabled).toBe(false))
    fireEvent.click(send())
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]![0].siteId).toBeNull()
  })
})

describe('files of a project that closes under them', () => {
  it('stay on the project, so the server says it is closed instead of refusing the file', async () => {
    const chat = showChat()
    await waitFor(() => expect(projectList).toHaveBeenCalled())
    await choose('Без проекта', /Кофейня/)
    await attach()
    projectList.mockResolvedValue([{ ...KROSHKA, chat: { state: 'closed', requirements: null } }])
    await chat.invalidateQueries({ queryKey: ['project.list'] })
    await waitFor(() => expect(projectList).toHaveBeenCalledTimes(2))
    const locked = screen.getByRole('button', { name: /Кофейня/ })
    expect(locked.getAttribute('aria-disabled')).toBe('true')
    write('Перескажите файл')
    await waitFor(() => expect(send().disabled).toBe(false))
    fireEvent.click(send())
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]![0]).toMatchObject({ siteId: SITE_ID, attachments: [ATTACHMENT] })
  })

  it('stay on a project gone from the list too: the server says what became of it', async () => {
    const chat = showChat()
    await waitFor(() => expect(projectList).toHaveBeenCalled())
    await choose('Без проекта', /Кофейня/)
    await attach()
    projectList.mockResolvedValue([])
    await chat.invalidateQueries({ queryKey: ['project.list'] })
    await waitFor(() => expect(projectList).toHaveBeenCalledTimes(2))
    write('Перескажите файл')
    await waitFor(() => expect(send().disabled).toBe(false))
    fireEvent.click(send())
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]![0]).toMatchObject({ siteId: SITE_ID, attachments: [ATTACHMENT] })
  })
})

describe('«Добавить проект» from a new chat', () => {
  it('leads to the wizard and keeps the words for the way back', async () => {
    showChat()
    await waitFor(() => expect(projectList).toHaveBeenCalled())
    write('Опубликуйте новость')
    fireEvent.click(pill('Без проекта'))
    const add = await screen.findByRole('menuitem', { name: 'Добавить проект' })
    expect(add.getAttribute('href')).toBe('/projects/new?from=chats')
    fireEvent.click(add)
    expect(sessionStorage.getItem('raditi-new-chat-draft')).toContain('Опубликуйте новость')
  })

  it('puts the kept words back once', async () => {
    keepChatDraft(USER_ID, 'Опубликуйте новость')
    showChat()
    await waitFor(() => expect(field().value).toBe('Опубликуйте новость'))
    expect(sessionStorage.getItem('raditi-new-chat-draft')).toBeNull()
  })

  it('leaves the words to a screen the client sees: below `md` the one beside the list is hidden', async () => {
    keepChatDraft(USER_ID, 'Опубликуйте новость')
    windowFrom(false)
    showChat({ beside: true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(field().value).toBe('')
    expect(sessionStorage.getItem('raditi-new-chat-draft')).toContain('Опубликуйте новость')
  })

  it('puts the words back beside the list from `md`', async () => {
    keepChatDraft(USER_ID, 'Опубликуйте новость')
    windowFrom(true)
    showChat({ beside: true })
    await waitFor(() => expect(field().value).toBe('Опубликуйте новость'))
  })

  it('gives the words of another user to nobody, and drops them', async () => {
    keepChatDraft('the-user-who-left', 'Слова другого человека')
    showChat()
    await waitFor(() => expect(sessionStorage.getItem('raditi-new-chat-draft')).toBeNull())
    expect(field().value).toBe('')
  })
})
