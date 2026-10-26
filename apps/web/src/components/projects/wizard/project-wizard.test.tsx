// @vitest-environment jsdom
import {
  notifyManager,
  QueryClient,
  QueryClientProvider,
  type UseMutationOptions,
} from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CREATE_RESEND_MS, CREATE_RESENDS, ProjectWizard, VARIABLES_NOTE } from './project-wizard'

type Call = Record<string, unknown>

const { api, push } = vi.hoisted(() => ({
  api: {
    checkBasics: vi.fn<(input: Call) => Promise<unknown>>(),
    checkSource: vi.fn<(input: Call) => Promise<unknown>>(),
    create: vi.fn<(input: Call) => Promise<unknown>>(),
  },
  push: vi.fn(),
}))

const mutation =
  (fn: (input: Call) => Promise<unknown>) =>
  (options: UseMutationOptions<unknown, Error, Call> = {}) => ({ ...options, mutationFn: fn })

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    project: {
      list: { queryKey: () => ['project', 'list'] },
      create: { mutationOptions: mutation((input) => api.create(input)) },
    },
    siteConnection: {
      checkBasics: { mutationOptions: mutation((input) => api.checkBasics(input)) },
      checkSource: { mutationOptions: mutation((input) => api.checkSource(input)) },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

const KEY = `ssh-ed25519 SHA256:${'Q'.repeat(43)}`
const OTHER_KEY = `ssh-ed25519 SHA256:${'Z'.repeat(43)}`
const PASSWORD = 'pa$$-word-of-the-test'
const DB_PASSWORD = 'database-password-of-the-test'
const SITE_ID = '019f1a21-1800-7f00-8abc-111111111111'

let queryClient: QueryClient

function showWizard(
  stacks: readonly ('wordpress' | 'bitrix')[] = ['wordpress'],
  browserAccess = false,
) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ProjectWizard stacks={stacks} browserAccess={browserAccess} />
    </QueryClientProvider>,
  )
}

const stepTitle = () => screen.getByRole('heading', { level: 2 })
const next = () => screen.getByRole('button', { name: /^(Далее|Добавить проект)/ })
const back = () => screen.getByRole('button', { name: 'Назад' })
const textbox = (name: RegExp) => screen.getByRole('textbox', { name })
const type = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } })
const status = () => screen.getByRole('status')
/** The password field; «Пароль» is also a choice of «Способ входа». */
const password = () => screen.getByLabelText(/^Пароль/, { selector: 'input[type="password"]' })

async function passBasics() {
  type(textbox(/Название проекта/), 'Кофейня')
  type(textbox(/Адрес сайта/), 'example.ru')
  fireEvent.click(next())
  await waitFor(() => expect(stepTitle()).toHaveTextContent('Доступ к файлам'))
}

function fillSsh() {
  type(textbox(/^Сервер/), 'ssh.example.ru')
  type(textbox(/^Пользователь/), 'deploy')
  type(password(), PASSWORD)
  type(textbox(/^Папка сайта/), '/var/www/site')
}

/** Through the key prompt to the database step. */
async function passSource() {
  fillSsh()
  fireEvent.click(next())
  fireEvent.click(await screen.findByRole('button', { name: 'Ключ совпадает, продолжить' }))
  await waitFor(() => expect(stepTitle()).toHaveTextContent('База данных'))
}

const sourceCalls = () => api.checkSource.mock.calls.map(([input]) => input)

beforeEach(() => {
  vi.clearAllMocks()
  api.checkBasics.mockImplementation(async (input) => ({
    name: input.name,
    url: input.url,
    host: 'example.ru',
    stack: input.stack,
  }))
  api.checkSource.mockImplementation(async (input) => {
    const source = input.source as { hostKey?: string }
    return source.hostKey === KEY
      ? { ok: true, hostKey: KEY, entries: 12 }
      : { ok: false, reason: 'host_key_unknown', hostKey: KEY }
  })
  api.create.mockResolvedValue({ outcome: 'created', project: { id: SITE_ID } })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the first step', () => {
  it('names what is missing before any request and puts the focus on it', async () => {
    showWizard()
    expect(stepTitle()).toHaveTextContent('Основные данные')
    type(textbox(/Адрес сайта/), 'example.ru/shop')
    fireEvent.click(next())

    expect(await screen.findByText('Введите название проекта')).toBeVisible()
    expect(
      screen.getByText('Укажите адрес сайта без пути к странице, например https://example.ru'),
    ).toBeVisible()
    await waitFor(() => expect(textbox(/Название проекта/)).toHaveFocus())
    expect(textbox(/Название проекта/)).toHaveAttribute('aria-invalid', 'true')
    expect(api.checkBasics).not.toHaveBeenCalled()
  })

  it('checks the name and the address on the server and opens the next step on its heading', async () => {
    showWizard()
    await passBasics()
    expect(api.checkBasics).toHaveBeenCalledExactlyOnceWith({
      name: 'Кофейня',
      url: 'https://example.ru',
      stack: 'wordpress',
    })
    await waitFor(() => expect(stepTitle()).toHaveFocus())
  })

  it('shows the only platform as text and offers a choice only between several', () => {
    const { unmount } = showWizard()
    expect(screen.getByText('Сейчас подключаем сайты на WordPress.')).toBeVisible()
    expect(screen.queryByRole('combobox', { name: 'Платформа сайта' })).not.toBeInTheDocument()
    unmount()
    showWizard(['wordpress', 'bitrix'])
    expect(screen.getByRole('combobox', { name: 'Платформа сайта' })).toBeInTheDocument()
  })

  it('stays on the step with the text of a refusal', async () => {
    api.checkBasics.mockRejectedValue(
      Object.assign(new Error('Сайт с таким адресом уже добавлен'), {
        data: { code: 'CONFLICT', domainCode: 'PROJECT_ALREADY_EXISTS' },
      }),
    )
    showWizard()
    type(textbox(/Название проекта/), 'Кофейня')
    type(textbox(/Адрес сайта/), 'example.ru')
    fireEvent.click(next())
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Сайт с таким адресом уже добавлен.')
    await waitFor(() => expect(alert).toHaveFocus())
    expect(stepTitle()).toHaveTextContent('Основные данные')
  })
})

describe('the access to the files', () => {
  it('offers SSH and FTP on two tabs with the usual ports', async () => {
    showWizard()
    await passBasics()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['SSH', 'FTP'])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(textbox(/^Порт/)).toHaveValue('22')
    fireEvent.click(screen.getByRole('tab', { name: 'FTP' }))
    expect(textbox(/^Порт/)).toHaveValue('21')
    expect(screen.getByRole('combobox', { name: 'Защита соединения' })).toHaveTextContent(
      'FTPS с проверкой сертификата',
    )
  })

  it('asks for the key of the server before any login, and goes on with the confirmed key', async () => {
    showWizard()
    await passBasics()
    fillSsh()
    fireEvent.click(next())

    const panel = await screen.findByRole('region', { name: 'Сверьте ключ сервера' })
    expect(within(panel).getByText(KEY)).toBeVisible()
    await waitFor(() =>
      expect(within(panel).getByRole('heading', { name: 'Сверьте ключ сервера' })).toHaveFocus(),
    )
    expect(sourceCalls()[0]).toEqual({
      stack: 'wordpress',
      source: {
        kind: 'sftp',
        host: 'ssh.example.ru',
        port: 22,
        username: 'deploy',
        auth: { method: 'password', password: PASSWORD },
        rootPath: '/var/www/site',
      },
    })

    fireEvent.click(within(panel).getByRole('button', { name: 'Ключ совпадает, продолжить' }))
    await waitFor(() => expect(stepTitle()).toHaveTextContent('База данных'))
    expect(sourceCalls()[1]).toMatchObject({ source: { hostKey: KEY } })
    // The step that adds the project says the accesses become variables of the site.
    expect(screen.getByText(VARIABLES_NOTE)).toBeVisible()
  })

  it('takes a changed key only by its own explicit button', async () => {
    api.checkSource.mockImplementation(async (input) => {
      const source = input.source as { hostKey?: string }
      if (source.hostKey === OTHER_KEY) return { ok: true, hostKey: OTHER_KEY, entries: 3 }
      return source.hostKey === KEY
        ? { ok: false, reason: 'host_key_changed', hostKey: OTHER_KEY }
        : { ok: false, reason: 'host_key_unknown', hostKey: KEY }
    })
    showWizard()
    await passBasics()
    fillSsh()
    fireEvent.click(next())
    fireEvent.click(await screen.findByRole('button', { name: 'Ключ совпадает, продолжить' }))

    const panel = await screen.findByRole('region', { name: 'Ключ сервера изменился' })
    expect(within(panel).getByText(OTHER_KEY)).toBeVisible()
    expect(stepTitle()).toHaveTextContent('Доступ к файлам')
    expect(api.checkSource).toHaveBeenCalledTimes(2)

    fireEvent.click(within(panel).getByRole('button', { name: 'Принять новый ключ' }))
    await waitFor(() => expect(stepTitle()).toHaveTextContent('База данных'))
    expect(sourceCalls()[2]).toMatchObject({ source: { hostKey: OTHER_KEY } })
  })

  it('blocks every button while the check runs and sends one request however often pressed', async () => {
    let answer: (value: unknown) => void = () => {}
    api.checkSource.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    showWizard()
    await passBasics()
    fillSsh()
    fireEvent.click(next())
    fireEvent.click(next())
    fireEvent.submit(next().closest('form')!)

    await waitFor(() => expect(status()).toHaveTextContent('Проверяем подключение…'))
    expect(api.checkSource).toHaveBeenCalledTimes(1)
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
    for (const tab of screen.getAllByRole('tab')) expect(tab).toBeDisabled()
    expect(textbox(/^Сервер/)).toBeDisabled()

    await act(async () => answer({ ok: false, reason: 'unreachable' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Не удалось подключиться к серверу/)
    expect(next()).toBeEnabled()
    expect(status()).toHaveTextContent('')
  })

  it('checks again after an edit, and forgets the key when the server changes', async () => {
    showWizard()
    await passBasics()
    await passSource()
    expect(api.checkSource).toHaveBeenCalledTimes(2)

    // Back and forth without an edit: the passed check still counts.
    fireEvent.click(back())
    await waitFor(() => expect(stepTitle()).toHaveTextContent('Доступ к файлам'))
    expect(textbox(/^Сервер/)).toHaveValue('ssh.example.ru')
    expect(password()).toHaveValue(PASSWORD)
    fireEvent.click(next())
    await waitFor(() => expect(stepTitle()).toHaveTextContent('База данных'))
    expect(api.checkSource).toHaveBeenCalledTimes(2)

    // Another user on the same server: checked again, with the key confirmed for it.
    fireEvent.click(back())
    await waitFor(() => expect(stepTitle()).toHaveTextContent('Доступ к файлам'))
    type(textbox(/^Пользователь/), 'admin')
    fireEvent.click(next())
    await waitFor(() => expect(stepTitle()).toHaveTextContent('База данных'))
    expect(sourceCalls()[2]).toMatchObject({ source: { username: 'admin', hostKey: KEY } })

    // Another server: its key is not the one confirmed.
    fireEvent.click(back())
    await waitFor(() => expect(stepTitle()).toHaveTextContent('Доступ к файлам'))
    type(textbox(/^Сервер/), 'ssh2.example.ru')
    fireEvent.click(next())
    await screen.findByRole('region', { name: 'Сверьте ключ сервера' })
    expect(sourceCalls()[3]!.source).not.toHaveProperty('hostKey')
  })

  it('offers the folder the server found the site in', async () => {
    api.checkSource.mockResolvedValue({
      ok: false,
      reason: 'not_site_root',
      suggestedRoot: '/var/www/site/public_html',
    })
    showWizard()
    await passBasics()
    fillSsh()
    fireEvent.click(next())

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('В этой папке нет файлов сайта на WordPress.')
    fireEvent.click(
      within(alert).getByRole('button', { name: 'Подставить папку «/var/www/site/public_html»' }),
    )
    expect(textbox(/^Папка сайта/)).toHaveValue('/var/www/site/public_html')
    await waitFor(() => expect(textbox(/^Папка сайта/)).toHaveFocus())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps what was typed in the first step when the user goes back', async () => {
    showWizard()
    await passBasics()
    fillSsh()
    fireEvent.click(back())
    await waitFor(() => expect(stepTitle()).toHaveTextContent('Основные данные'))
    expect(textbox(/Название проекта/)).toHaveValue('Кофейня')
    expect(textbox(/Адрес сайта/)).toHaveValue('example.ru')
    fireEvent.click(next())
    await waitFor(() => expect(stepTitle()).toHaveTextContent('Доступ к файлам'))
    // Nothing changed: no new check.
    expect(api.checkBasics).toHaveBeenCalledTimes(1)
    expect(password()).toHaveValue(PASSWORD)
  })
})

describe('the database step', () => {
  it('has no database by default and shows fields only for a provider', async () => {
    showWizard()
    await passBasics()
    await passSource()
    expect(screen.getByRole('radio', { name: /^Без базы данных/ })).toBeChecked()
    expect(screen.queryByRole('textbox', { name: /^Имя базы/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: /^PostgreSQL/ }))
    expect(textbox(/^Порт/)).toHaveValue('5432')
    fireEvent.click(screen.getByRole('radio', { name: /^MySQL/ }))
    expect(textbox(/^Порт/)).toHaveValue('3306')
    type(textbox(/^Порт/), '3307')
    fireEvent.click(screen.getByRole('radio', { name: /^PostgreSQL/ }))
    expect(textbox(/^Порт/)).toHaveValue('3307')
    expect(screen.getByRole('combobox', { name: 'Защита соединения' })).toHaveTextContent(
      'TLS с проверкой сертификата',
    )
  })
})

describe('adding the project', () => {
  it('sends the three steps with the confirmed key and opens the project', async () => {
    showWizard()
    await passBasics()
    await passSource()
    fireEvent.click(next())

    await waitFor(() => expect(push).toHaveBeenCalledWith(`/projects/${SITE_ID}`))
    const [input] = api.create.mock.calls[0]!
    expect(input).toEqual({
      requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: 'Кофейня',
      url: 'https://example.ru',
      stack: 'wordpress',
      source: expect.objectContaining({ kind: 'sftp', hostKey: KEY }),
      database: null,
    })
    // The page is leaving: nothing can be sent again.
    expect(next()).toBeDisabled()
    expect(status()).toHaveTextContent('Проект добавлен. Открываем его страницу…')
  })

  it('sends a chosen database', async () => {
    showWizard()
    await passBasics()
    await passSource()
    fireEvent.click(screen.getByRole('radio', { name: /^MySQL/ }))
    fireEvent.click(next())
    expect(await screen.findByText('Укажите имя базы данных')).toBeVisible()
    expect(api.create).not.toHaveBeenCalled()

    type(textbox(/^Сервер/), 'db.example.ru')
    type(textbox(/^Имя базы/), 'wp')
    type(textbox(/^Пользователь/), 'wp')
    type(password(), DB_PASSWORD)
    fireEvent.click(next())
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
    expect(api.create.mock.calls[0]![0].database).toEqual({
      engine: 'mysql',
      host: 'db.example.ru',
      port: 3306,
      database: 'wp',
      username: 'wp',
      password: DB_PASSWORD,
      tls: 'verified',
    })
  })

  it('returns to the files with the reason when they are refused this time', async () => {
    api.create.mockResolvedValue({ outcome: 'source_refused', reason: 'auth_failed' })
    showWizard()
    await passBasics()
    await passSource()
    fireEvent.click(next())

    await waitFor(() => expect(stepTitle()).toHaveTextContent('Доступ к файлам'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Сервер не принял пользователя, пароль или ключ.',
    )
    expect(textbox(/^Сервер/)).toHaveValue('ssh.example.ru')
    expect(next()).toBeEnabled()
  })

  it('stays on the database with its reason', async () => {
    api.create.mockResolvedValue({ outcome: 'database_refused', reason: 'host_not_allowed' })
    showWizard()
    await passBasics()
    await passSource()
    fireEvent.click(next())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Сервер базы данных не принимает подключения от нас.',
    )
    expect(stepTitle()).toHaveTextContent('База данных')
    expect(push).not.toHaveBeenCalled()
  })

  it('goes back to the first step when the address is what the server refuses', async () => {
    api.create.mockRejectedValue(
      Object.assign(new Error('Сайт с таким адресом уже добавлен'), {
        data: { code: 'CONFLICT', domainCode: 'PROJECT_ALREADY_EXISTS' },
      }),
    )
    showWizard()
    await passBasics()
    await passSource()
    fireEvent.click(next())

    await waitFor(() => expect(stepTitle()).toHaveTextContent('Основные данные'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Сайт с таким адресом уже добавлен.')
  })

  it('offers the list and a fresh start when this opening already added a project at another address', async () => {
    api.create
      .mockRejectedValueOnce(
        Object.assign(new Error('Этот мастер уже добавил проект с другим адресом'), {
          data: { code: 'CONFLICT', domainCode: 'PROJECT_REQUEST_CONFLICT' },
        }),
      )
      .mockResolvedValue({ outcome: 'created', project: { id: SITE_ID } })
    showWizard()
    await passBasics()
    await passSource()
    fireEvent.click(next())

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Этот мастер уже добавил проект с другим адресом.')
    await waitFor(() => expect(alert).toHaveFocus())
    expect(within(alert).getByRole('link', { name: 'Открыть список проектов' })).toHaveAttribute(
      'href',
      '/projects',
    )

    fireEvent.click(within(alert).getByRole('button', { name: 'Начать заново' }))
    await waitFor(() => expect(stepTitle()).toHaveTextContent('Основные данные'))
    await waitFor(() => expect(stepTitle()).toHaveFocus())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // The name and the address stay; they are checked again, as typed anew.
    expect(textbox(/Название проекта/)).toHaveValue('Кофейня')
    expect(textbox(/Адрес сайта/)).toHaveValue('example.ru')
    fireEvent.click(next())
    await waitFor(() => expect(stepTitle()).toHaveTextContent('Доступ к файлам'))
    expect(api.checkBasics).toHaveBeenCalledTimes(2)
    // Nothing secret is kept: the access and its key are asked for anew.
    expect(textbox(/^Сервер/)).toHaveValue('')
    expect(password()).toHaveValue('')
    await passSource()
    expect(api.checkSource).toHaveBeenCalledTimes(4)
    fireEvent.click(next())
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/projects/${SITE_ID}`))
    // A new opening: a new key, so the first project is not found again under it.
    const [first, second] = api.create.mock.calls.map(([input]) => input.requestKey)
    expect(second).toMatch(/^[0-9a-f-]{36}$/)
    expect(second).not.toBe(first)
  })

  it('sends the same request again while the server is still creating it', async () => {
    const busy = () =>
      Object.assign(new Error('Проект уже добавляется'), {
        data: { code: 'CONFLICT', domainCode: 'PROJECT_CREATION_IN_PROGRESS' },
      })
    api.create
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockResolvedValue({ outcome: 'created', project: { id: SITE_ID } })
    showWizard()
    await passBasics()
    await passSource()

    vi.useFakeTimers({ shouldAdvanceTime: false })
    notifyManager.setScheduler(queueMicrotask)
    fireEvent.click(next())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(status()).toHaveTextContent('Проверяем подключение и добавляем проект…')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREATE_RESEND_MS - 1)
    })
    expect(api.create).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1 + CREATE_RESEND_MS)
    })
    expect(api.create).toHaveBeenCalledTimes(3)
    const keys = api.create.mock.calls.map(([input]) => input.requestKey)
    expect(new Set(keys).size).toBe(1)
    expect(push).toHaveBeenCalledWith(`/projects/${SITE_ID}`)
  })

  it('gives up after a few resends and says so', async () => {
    api.create.mockRejectedValue(
      Object.assign(new Error('Проект уже добавляется'), {
        data: { code: 'CONFLICT', domainCode: 'PROJECT_CREATION_IN_PROGRESS' },
      }),
    )
    showWizard()
    await passBasics()
    await passSource()

    vi.useFakeTimers({ shouldAdvanceTime: false })
    notifyManager.setScheduler(queueMicrotask)
    fireEvent.click(next())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREATE_RESEND_MS * (CREATE_RESENDS + 1))
    })
    expect(api.create).toHaveBeenCalledTimes(CREATE_RESENDS + 1)
    expect(screen.getByRole('alert')).toHaveTextContent('Проект уже добавляется.')
    expect(next()).toBeEnabled()
  })

  it('keeps one request key for the whole opening of the wizard', async () => {
    api.create
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValue({ outcome: 'created', project: { id: SITE_ID } })
    showWizard()
    await passBasics()
    await passSource()
    fireEvent.click(next())
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось связаться с сервером.')
    fireEvent.click(next())
    await waitFor(() => expect(push).toHaveBeenCalled())
    const [first, second] = api.create.mock.calls.map(([input]) => input.requestKey)
    expect(second).toBe(first)
  })
})

describe('a site without access to its files (docs/plan/57-browser-tasks.md, Б8)', () => {
  it('is not offered where the platform has no browser', async () => {
    showWizard()
    await passBasics()
    expect(screen.queryByRole('tab', { name: 'Без доступа к файлам' })).toBeNull()
  })

  it('skips the checks of the files and the database and adds the site with hints', async () => {
    showWizard(['wordpress'], true)
    await passBasics()
    expect(screen.getByText(/Выберите, как агент будет работать с сайтом/)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Без доступа к файлам' }))
    expect(screen.getByRole('heading', { name: 'Что будет без доступа к файлам' })).toBeTruthy()
    // What the agent can do there, and nothing the browser of a task closes to it (Б21).
    expect(
      screen.getByText(
        'Агент меняет записи, страницы и медиафайлы в админке сайта — через браузер, и вы видите каждый шаг.',
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(
        'Настройки сайта и пользователей агент менять не сможет. Код, тему и плагины — тоже: для них нужен доступ по SSH или FTP.',
      ),
    ).toBeTruthy()
    expect(screen.queryByText(/меняет[^.]*настройки/)).toBeNull()
    // No server, no password: only the hints.
    expect(screen.queryByRole('textbox', { name: /^Сервер/ })).toBeNull()
    type(
      screen.getByRole('textbox', { name: /Подсказки для агента/ }),
      '  Вход в админку — по адресу /login  ',
    )
    expect(next()).toHaveTextContent('Добавить проект')
    fireEvent.click(next())
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/projects/${SITE_ID}`))
    expect(api.checkSource).not.toHaveBeenCalled()
    expect(api.create.mock.calls[0]![0]).toEqual({
      requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: 'Кофейня',
      url: 'https://example.ru',
      stack: 'wordpress',
      access: 'browser',
      agentNotes: 'Вход в админку — по адресу /login',
    })
  })

  it('sends no hints when there are none, and says a refused hint on its step', async () => {
    api.create.mockRejectedValueOnce(
      Object.assign(new Error('refused'), {
        message: 'Похоже, в подсказке есть пароль или ключ',
        data: { code: 'BAD_REQUEST', domainCode: 'PROJECT_NOTES_HAS_SECRET' },
      }),
    )
    showWizard(['wordpress'], true)
    await passBasics()
    fireEvent.click(screen.getByRole('tab', { name: 'Без доступа к файлам' }))
    fireEvent.click(next())
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
    expect(api.create.mock.calls[0]![0]).not.toHaveProperty('agentNotes')
    expect(await screen.findByText(/в подсказке есть пароль или ключ/)).toBeTruthy()
    expect(stepTitle()).toHaveTextContent('Доступ к файлам')
  })

  it('goes back to the address when the server takes no address but https (Б33)', async () => {
    const text =
      'Без доступа к файлам агент работает только с сайтами, которые открываются по защищённому адресу. Укажите адрес, который начинается с https://'
    api.create.mockRejectedValueOnce(
      Object.assign(new Error(text), {
        data: { code: 'BAD_REQUEST', domainCode: 'SITE_ADDRESS_NOT_SECURE' },
      }),
    )
    showWizard(['wordpress'], true)
    await passBasics()
    fireEvent.click(screen.getByRole('tab', { name: 'Без доступа к файлам' }))
    fireEvent.click(next())

    await waitFor(() => expect(stepTitle()).toHaveTextContent('Основные данные'))
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
    expect(textbox(/Адрес сайта/)).toHaveValue('example.ru')
  })

  it('goes back to SSH with what was typed in it', async () => {
    showWizard(['wordpress'], true)
    await passBasics()
    type(textbox(/^Сервер/), 'ssh.example.ru')
    fireEvent.click(screen.getByRole('tab', { name: 'Без доступа к файлам' }))
    fireEvent.click(screen.getByRole('tab', { name: 'SSH' }))
    expect(textbox(/^Сервер/)).toHaveValue('ssh.example.ru')
    expect(next()).toHaveTextContent('Далее')
  })
})

describe('the secrets of the wizard', () => {
  it('never reach browser storage, the address or the query cache', async () => {
    const stored = vi.spyOn(Storage.prototype, 'setItem')
    const pushed = vi.spyOn(window.history, 'pushState')
    const replaced = vi.spyOn(window.history, 'replaceState')
    showWizard()
    await passBasics()
    fireEvent.click(screen.getByRole('radio', { name: 'Ключ' }))
    type(textbox(/^Сервер/), 'ssh.example.ru')
    type(textbox(/^Пользователь/), 'deploy')
    type(screen.getByRole('textbox', { name: /^Приватный ключ/ }), 'PRIVATE-KEY-OF-THE-TEST')
    type(screen.getByLabelText(/^Парольная фраза/), 'PHRASE-OF-THE-TEST')
    type(textbox(/^Папка сайта/), '/var/www/site')
    fireEvent.click(next())
    fireEvent.click(await screen.findByRole('button', { name: 'Ключ совпадает, продолжить' }))
    await waitFor(() => expect(stepTitle()).toHaveTextContent('База данных'))
    fireEvent.click(screen.getByRole('radio', { name: /^PostgreSQL/ }))
    type(textbox(/^Сервер/), 'db.example.ru')
    type(textbox(/^Имя базы/), 'wp')
    type(textbox(/^Пользователь/), 'wp')
    type(password(), DB_PASSWORD)
    fireEvent.click(next())
    await waitFor(() => expect(push).toHaveBeenCalled())

    const secrets = /PRIVATE-KEY-OF-THE-TEST|PHRASE-OF-THE-TEST|database-password-of-the-test/
    for (const spy of [stored, pushed, replaced]) {
      for (const args of spy.mock.calls) expect(JSON.stringify(args)).not.toMatch(secrets)
    }
    expect(window.location.href).not.toMatch(secrets)
    expect(push.mock.calls.flat().join(' ')).not.toMatch(secrets)
    // The answers were read and the mutations dropped: the cache keeps no request.
    await waitFor(() => {
      const kept = queryClient
        .getMutationCache()
        .getAll()
        .map((item) => JSON.stringify(item.state.variables ?? null))
      expect(kept.join(' ')).not.toMatch(secrets)
    })
    // A password field asks the browser not to fill in or keep the cabinet's password.
    expect(password()).toHaveAttribute('autocomplete', 'new-password')
  })
})
