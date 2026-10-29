// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { serverRefusal } from '@/components/billing/testing'
import { SITE_ID } from '@/components/chat/testing'

import { NewDialog, newDialogWays } from './new-dialog'

type Created = { taskId: string; alias: string; created: boolean }
type CreateInput = {
  siteId: string
  taskId: string
  text: string
  requirements?: { repository: boolean; browser: boolean }
  attachments?: string[]
}

const { create, push } = vi.hoisted(() => ({
  create: vi.fn<(input: CreateInput) => Promise<Created>>(),
  push: vi.fn<(path: string) => void>(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

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
    billing: { usage: { queryKey: () => ['billing', 'usage'] } },
  }),
  useTRPCClient: () => ({
    attachment: {
      start: { mutate: vi.fn(async () => ({ attachmentId: ATTACHMENT, uploadPath: '/x' })) },
      remove: { mutate: vi.fn() },
    },
  }),
}))

const ATTACHMENT = '0199a3f2-0000-7000-8000-0000000000f1'
type Capabilities = Parameters<typeof NewDialog>[0]['capabilities']
const COPY_ONLY: Capabilities = { repository: 'ready', browser: 'not_configured' }
const BOTH: Capabilities = { repository: 'ready', browser: 'ready' }
const BROWSER_ONLY: Capabilities = { repository: 'absent', browser: 'ready' }
const NONE: Capabilities = { repository: 'inactive', browser: 'not_configured' }

const NOT_CONNECTED = 'Сайт ещё не подключён. Задачи можно будет ставить после подключения.'
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** The phrase is in the page for a screen reader and takes no room on the screen. */
const offScreenText = (text: string) =>
  getComputedStyle(screen.getByText(text)).position === 'absolute' &&
  getComputedStyle(screen.getByText(text)).width === '1px'

const described = (element: HTMLElement) =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')

function showDialog(props: { capabilities?: Capabilities; heading?: 'h1' | 'h2' } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <NewDialog
        siteId={SITE_ID}
        capabilities={props.capabilities ?? COPY_ONLY}
        heading={props.heading}
      />
    </QueryClientProvider>,
  )
  return queryClient
}

const field = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Сообщение' })
const send = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Отправить' })
const write = (text: string) => fireEvent.change(field(), { target: { value: text } })

beforeEach(() => {
  vi.clearAllMocks()
  create.mockImplementation(async ({ taskId }) => ({ taskId, alias: 'a1b2c3', created: true }))
})

describe('new dialog', () => {
  it('heads the screen and labels the message field', () => {
    showDialog()
    expect(screen.getByRole('heading', { level: 1, name: 'Новый диалог' })).toBeTruthy()
    expect(field().tagName).toBe('TEXTAREA')
    expect(field().getAttribute('placeholder')).toBe('Что поменять на сайте?')
  })

  it('takes the level below beside a list that heads the page', () => {
    showDialog({ heading: 'h2' })
    expect(screen.getByRole('heading', { level: 2, name: 'Новый диалог' })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })

  it('starts a dialog with the first words under an id of the browser and opens it', async () => {
    const queryClient = showDialog()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    write('Поменяйте телефон в шапке сайта')
    fireEvent.click(send())
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1))
    // The list shows the new dialog, and the credits under it what its reserve left.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['billing', 'usage'] })
    const [input] = create.mock.calls[0]!
    expect(input).toEqual({
      siteId: SITE_ID,
      taskId: expect.stringMatching(UUID_V7),
      text: 'Поменяйте телефон в шапке сайта',
      // «Высокое» unless the client picks another.
      effort: 'high',
    })
    expect(push).toHaveBeenCalledWith(`/projects/${SITE_ID}/chat/${input.taskId}`)
  })

  it('repeats a request that got no answer under the same id, and keeps the words', async () => {
    create.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    showDialog()
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

  it('says a refusal of the server in its words', async () => {
    create.mockRejectedValueOnce(
      serverRefusal(
        'Похоже, в сообщении есть пароль или ключ. Не отправляйте их в чат — доступы задаются в разделе «Переменные»',
        'TASK_TEXT_HAS_SECRET',
      ),
    )
    showDialog()
    write('пароль: hunter2')
    fireEvent.click(send())
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Похоже, в сообщении есть пароль или ключ. Не отправляйте их в чат — доступы задаются в разделе «Переменные».',
    )
    expect(push).not.toHaveBeenCalled()
  })

  it('has no window of commands: commands belong to a dialog', () => {
    showDialog()
    write('/')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Команды' })).toBeNull()
  })

  it('never starts a dialog with the words of a command', () => {
    showDialog()
    write('/release')
    fireEvent.click(send())
    expect(create).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(
      'Команды работают внутри диалога. Сначала опишите, что поменять на сайте.',
    )
  })

  it('tells a screen reader, not the screen, why a site that is not connected takes no task', () => {
    showDialog({ capabilities: NONE })
    expect(field().disabled).toBe(true)
    expect(send().disabled).toBe(true)
    expect(described(field())).toContain(NOT_CONNECTED)
    expect(described(send())).toBe(NOT_CONNECTED)
    expect(offScreenText(NOT_CONNECTED)).toBe(true)
  })

  it('offers two modes in two words, «Работа» chosen', () => {
    showDialog()
    const modes = within(screen.getByRole('radiogroup', { name: 'Режим диалога' }))
    expect(modes.getAllByRole('radio').map((mode) => mode.closest('label')?.textContent)).toEqual([
      'Чат',
      'Работа',
    ])
    expect(modes.getByRole<HTMLInputElement>('radio', { name: 'Работа' }).checked).toBe(true)
  })

  it('shows «Чат» as a mode that cannot be chosen without the cloud browser, and says so', () => {
    showDialog()
    const chat = screen.getByRole<HTMLInputElement>('radio', { name: 'Чат' })
    expect(chat.disabled).toBe(true)
    expect(chat.checked).toBe(false)
    const off = 'Режим «Чат» для этого сайта сейчас недоступен: облачный браузер не подключён.'
    expect(described(chat)).toBe(off)
    expect(offScreenText(off)).toBe(true)
    // Not by colour alone: the word carries a mark of its own.
    expect(chat.closest('label')?.querySelector('svg')).toBeTruthy()
    expect(
      screen.getByRole('radio', { name: 'Работа' }).closest('label')?.querySelector('svg'),
    ).toBeNull()
  })

  it('lets the client pick how hard the model thinks, «Высокое» first', async () => {
    showDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Размышление: Высокое' }))
    const efforts = within(await screen.findByRole('menu', { name: 'Размышление' }))
    expect(
      efforts.getAllByRole('menuitemradio').map((item) => item.querySelector('span')?.textContent),
    ).toEqual(['Низкое', 'Высокое', 'Максимальное'])
    expect(
      efforts.getByRole('menuitemradio', { name: /Высокое/ }).getAttribute('aria-checked'),
    ).toBe('true')
    fireEvent.click(efforts.getByRole('menuitemradio', { name: /Максимальное/ }))
    expect(screen.getByRole('button', { name: 'Размышление: Максимальное' })).toBeTruthy()
    write('Расскажи про этот проект')
    fireEvent.click(send())
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]![0]).toMatchObject({ effort: 'max' })
  })

  it('shows no words under the field, and no files for the copy of the site', () => {
    showDialog()
    // The level of thinking and «Отправить».
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Прикрепить файлы' })).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: 'Как агент будет работать' })).toBeNull()
    expect(screen.queryByText('ИИ может допускать ошибки. Проверяйте важное.')).toBeNull()
    expect(
      offScreenText(
        'В режиме «Работа» агент получает копию файлов сайта из последней версии, вы смотрите результат в предпросмотре и сами выпускаете новую версию на сайт.',
      ),
    ).toBe(true)
  })
})

describe('the way of a new dialog (docs/plan/57-browser-tasks.md, Б9)', () => {
  it('lets the client choose «Чат» in the browser or «Работа» on the copy where the site offers both', async () => {
    showDialog({ capabilities: BOTH })
    const modes = screen.getByRole('radiogroup', { name: 'Режим диалога' })
    const chat = within(modes).getByRole<HTMLInputElement>('radio', { name: 'Чат' })
    const work = within(modes).getByRole<HTMLInputElement>('radio', { name: 'Работа' })
    // The server's own default: the copy of the site where it is ready.
    expect(work.checked).toBe(true)
    expect(described(modes)).toContain('сами выпускаете новую версию')
    expect(screen.queryByRole('button', { name: 'Прикрепить файлы' })).toBeNull()
    fireEvent.click(chat)
    expect(chat.checked).toBe(true)
    expect(described(modes)).toContain('без копии файлов сайта')
    expect(screen.getByRole('button', { name: 'Прикрепить файлы' })).toBeTruthy()
    expect(described(field())).toContain(
      'Не отправляйте в чат пароли и ключи: вход в админку сохраните в разделе «Переменные» или войдите сами в окне браузера.',
    )
    write('Открой сайт и пришли скриншот')
    fireEvent.click(send())
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]![0]).toMatchObject({
      requirements: { repository: false, browser: true },
    })
  })

  it('sends the copy of the site when it is chosen', async () => {
    showDialog({ capabilities: BOTH })
    write('Поменяйте телефон в шапке')
    fireEvent.click(send())
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]![0]).toMatchObject({
      requirements: { repository: true, browser: false },
    })
  })

  it('works through the browser alone on a site without access to its files, and says so', async () => {
    showDialog({ capabilities: BROWSER_ONLY })
    expect(screen.queryByRole('radiogroup', { name: 'Как агент будет работать' })).toBeNull()
    expect(
      screen.getByText(
        'Сайт добавлен без доступа к файлам: агент работает в админке сайта через браузер. Изменения появляются на сайте сразу.',
      ),
    ).toBeTruthy()
    expect(field().disabled).toBe(false)
    write('Добавьте новость')
    fireEvent.click(send())
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]![0].requirements).toEqual({ repository: false, browser: true })
  })

  it('says why a site whose address is not https takes no task in the browser', () => {
    showDialog({ capabilities: { repository: 'absent', browser: 'insecure' } })
    expect(field().disabled).toBe(true)
    expect(described(field())).toContain(
      'В браузере агент работает только с сайтами, которые открываются по защищённому адресу. Адрес сайта в кабинете поменять нельзя: добавьте сайт заново с адресом, который начинается с https://.',
    )
  })
})

describe('newDialogWays', () => {
  it('offers what the site takes, the copy first as the server does', () => {
    expect(newDialogWays(BOTH)).toEqual({
      ways: ['browser', 'repository'],
      initial: 'repository',
      blocked: null,
    })
    expect(newDialogWays(COPY_ONLY)).toEqual({
      ways: ['repository'],
      initial: 'repository',
      blocked: null,
    })
    expect(newDialogWays(BROWSER_ONLY)).toEqual({
      ways: ['browser'],
      initial: 'browser',
      blocked: null,
    })
    expect(newDialogWays({ repository: 'importing', browser: 'closed' }).blocked).toBe(
      NOT_CONNECTED,
    )
  })
})
