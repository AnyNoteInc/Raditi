// @vitest-environment jsdom
import {
  focusManager,
  notifyManager,
  QueryClient,
  QueryClientProvider,
  type UseMutationOptions,
} from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SETUP_POLL_MS, SiteSetup, type SiteSetupState } from './site-setup'

type Call = Record<string, unknown>

const { api, refresh } = vi.hoisted(() => ({
  api: {
    setup: vi.fn<(input: Call) => Promise<unknown>>(),
    retry: vi.fn<(input: Call) => Promise<unknown>>(),
    checkSource: vi.fn<(input: Call) => Promise<unknown>>(),
    replaceAccess: vi.fn<(input: Call) => Promise<unknown>>(),
  },
  refresh: vi.fn(),
}))

const mutation =
  (fn: (input: Call) => Promise<unknown>) =>
  (options: UseMutationOptions<unknown, Error, Call> = {}) => ({ ...options, mutationFn: fn })

// One object for every render, as the real context gives.
const trpc = {
  project: { list: { queryKey: () => ['project', 'list'] } },
  siteConnection: {
    setup: {
      queryKey: (input: Call) => ['siteConnection', 'setup', input],
      queryOptions: (input: Call, options: object) => ({
        queryKey: ['siteConnection', 'setup', input],
        queryFn: () => api.setup(input),
        ...options,
      }),
    },
    retry: { mutationOptions: mutation((input) => api.retry(input)) },
    checkSource: { mutationOptions: mutation((input) => api.checkSource(input)) },
    replaceAccess: { mutationOptions: mutation((input) => api.replaceAccess(input)) },
  },
}

vi.mock('@/trpc/client', () => ({ useTRPC: () => trpc }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

const SITE_ID = '019f1a21-1800-7f00-8abc-111111111111'
const KEY = `ssh-ed25519 SHA256:${'Q'.repeat(43)}`
const OTHER_KEY = `ssh-ed25519 SHA256:${'Z'.repeat(43)}`
const LIST = ['project', 'list']

function setupIn(patch: Partial<SiteSetupState> = {}): SiteSetupState {
  return {
    state: 'pending',
    status: 'queued',
    step: null,
    errorCode: null,
    attempt: 1,
    updatedAt: new Date('2026-10-17T09:00:00Z'),
    retry: 'unavailable',
    replaceAccess: false,
    source: {
      kind: 'sftp',
      host: 'ssh.example.ru',
      port: 2222,
      rootPath: '/var/www/site',
      tls: null,
      hostKey: KEY,
    },
    initialVersion: null,
    summary: null,
    ...patch,
  }
}

const failed = (patch: Partial<SiteSetupState> = {}) =>
  setupIn({
    state: 'failed',
    status: 'failed',
    errorCode: 'auth_failed',
    retry: 'available',
    replaceAccess: true,
    ...patch,
  })

// See order-return.test.tsx: answers land in the same instant they arrive.
notifyManager.setScheduler(queueMicrotask)

async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

let queryClient: QueryClient

async function showSetup(initial?: SiteSetupState) {
  queryClient = new QueryClient()
  // The projects list as the cabinet cached it: its chip names the state of the setup.
  queryClient.setQueryData(LIST, [])
  render(
    <QueryClientProvider client={queryClient}>
      <SiteSetup siteId={SITE_ID} stack="wordpress" platform="WordPress" initial={initial} />
    </QueryClientProvider>,
  )
  await pass(0)
}

const status = () => screen.getByRole('status')
const asked = () => api.setup.mock.calls.length
const listInvalidated = () => queryClient.getQueryState(LIST)?.isInvalidated
const refusal = (domainCode: string | null, code = 'CONFLICT') =>
  Object.assign(new Error('Отказ сервера'), { data: { code, domainCode } })
const textbox = (name: RegExp) => screen.getByRole('textbox', { name })
const passwordField = () => screen.getByLabelText(/^Пароль/, { selector: 'input[type="password"]' })
const typeIn = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } })

async function openReplacement() {
  fireEvent.click(screen.getByRole('button', { name: 'Изменить доступ' }))
  await pass(0)
}

async function saveAccess(user = 'deploy', password = 'new-password-of-the-test') {
  typeIn(textbox(/^Пользователь/), user)
  typeIn(passwordField(), password)
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить доступ' }))
  await pass(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  // Reset, not cleared: an answer queued once by a test that failed must not reach the next one.
  vi.resetAllMocks()
  api.setup.mockResolvedValue(setupIn())
})

afterEach(() => {
  vi.useRealTimers()
  focusManager.setFocused(undefined)
})

describe('the setup screen while the import has no outcome', () => {
  it('says where the import is, in one live region, and asks every few seconds', async () => {
    api.setup
      .mockResolvedValueOnce(setupIn())
      .mockResolvedValueOnce(setupIn({ status: 'running', step: 'fetch' }))
      .mockResolvedValue(setupIn({ status: 'running', step: 'publish' }))
    await showSetup()

    expect(screen.getByRole('heading', { level: 1, name: 'Настраиваем сайт' })).toBeInTheDocument()
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(status()).toHaveTextContent('Ожидаем начала настройки')
    expect(asked()).toBe(1)

    await pass(SETUP_POLL_MS)
    expect(asked()).toBe(2)
    expect(status()).toHaveTextContent('Копируем файлы сайта')
    const steps = screen.getByRole('list', { name: 'Этапы настройки' })
    expect(within(steps).getByText('Копируем файлы сайта').closest('li')).toHaveAttribute(
      'aria-current',
      'step',
    )

    await pass(SETUP_POLL_MS)
    expect(status()).toHaveTextContent('Сохраняем первоначальную версию')
    expect(
      within(steps).getByText('Сохраняем первоначальную версию').closest('li'),
    ).toHaveAttribute('aria-current', 'step')
  })

  it('shows no percentage: the indicator only says that work goes on', async () => {
    await showSetup(setupIn({ status: 'running', step: 'fetch' }))
    expect(document.body.textContent).not.toMatch(/%/)
    const bar = document.querySelector('.MuiLinearProgress-root')
    expect(bar).toHaveAttribute('aria-hidden', 'true')
    expect(bar).not.toHaveAttribute('aria-valuenow')
  })

  it('starts from what the page was rendered with and asks anew at once', async () => {
    api.setup.mockResolvedValue(setupIn({ status: 'running', step: 'fetch' }))
    await showSetup(setupIn())
    expect(asked()).toBe(1)
    expect(status()).toHaveTextContent('Копируем файлы сайта')
  })

  it('says it lost track of the import when the server stops answering, and stops the motion', async () => {
    api.setup
      .mockResolvedValueOnce(setupIn({ status: 'running', step: 'fetch' }))
      .mockRejectedValue(new Error('Failed to fetch'))
    await showSetup()
    expect(status()).toHaveTextContent('Копируем файлы сайта')

    // The poll and the retries of the query client.
    await pass(SETUP_POLL_MS + 10_000)
    expect(status()).toHaveTextContent('Не удалось узнать, как идёт настройка')
    expect(status()).not.toHaveTextContent('Копируем файлы сайта')
    expect(document.querySelector('.MuiLinearProgress-root')).toBeNull()
    expect(screen.queryByRole('list', { name: 'Этапы настройки' })).not.toBeInTheDocument()

    api.setup.mockResolvedValue(setupIn({ status: 'running', step: 'publish' }))
    fireEvent.click(screen.getByRole('button', { name: 'Обновить' }))
    await pass(0)
    expect(status()).toHaveTextContent('Сохраняем первоначальную версию')
    expect(screen.queryByRole('button', { name: 'Обновить' })).not.toBeInTheDocument()
  })

  it.each(['UNAUTHORIZED', 'NOT_FOUND'])(
    'stops asking once the server answers %s',
    async (code) => {
      api.setup.mockResolvedValueOnce(setupIn()).mockRejectedValue(refusal(null, code))
      await showSetup()
      await pass(SETUP_POLL_MS + 10_000)
      expect(status()).toHaveTextContent('Не удалось узнать, как идёт настройка')
      const before = asked()
      await pass(SETUP_POLL_MS * 5)
      expect(asked()).toBe(before)
    },
  )

  it('asks again when the owner comes back to the tab', async () => {
    await showSetup()
    expect(asked()).toBe(1)
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await pass(0)
    expect(asked()).toBe(2)
  })
})

describe('the setup screen at an outcome', () => {
  it('renders the page anew on the server once the import succeeded, and stops asking', async () => {
    api.setup
      .mockResolvedValueOnce(setupIn())
      .mockResolvedValue(setupIn({ state: 'done', status: 'succeeded' }))
    await showSetup()
    expect(listInvalidated()).toBe(false)
    await pass(SETUP_POLL_MS)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(status()).toHaveTextContent('Настройка завершена')
    // The chip of the project in the list no longer says «Настраиваем».
    expect(listInvalidated()).toBe(true)
    const before = asked()
    await pass(SETUP_POLL_MS * 5)
    expect(asked()).toBe(before)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('stops asking on a failure and says why, in the same live region', async () => {
    api.setup.mockResolvedValue(failed())
    await showSetup()
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(status()).toHaveTextContent('Настройка остановилась')
    expect(status()).toHaveTextContent('Сервер не принял сохранённые данные для входа.')
    await pass(SETUP_POLL_MS * 5)
    expect(asked()).toBe(1)
    expect(refresh).not.toHaveBeenCalled()
    expect(document.querySelector('.MuiLinearProgress-root')).toBeNull()
  })

  it('tries again by «Повторить» and follows the new attempt', async () => {
    api.setup.mockResolvedValueOnce(failed())
    api.retry.mockResolvedValue(setupIn({ attempt: 2 }))
    api.setup.mockResolvedValue(setupIn({ attempt: 2, status: 'running', step: 'fetch' }))
    await showSetup()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    await pass(0)
    expect(api.retry).toHaveBeenCalledWith({ id: SITE_ID })
    expect(status()).toHaveTextContent('Ожидаем начала настройки')
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument()
    expect(document.getElementById('site-setup-headline')).toHaveFocus()
    expect(listInvalidated()).toBe(true)
    await pass(SETUP_POLL_MS)
    expect(status()).toHaveTextContent('Копируем файлы сайта')
  })

  // The server offers neither once the hour is used up; an offer of the replacement next to a
  // used-up hour would be refused all the same, so the phrase stands alone either way.
  it.each([true, false])(
    'says only why the buttons are not there when the hour is used up (replaceAccess: %s)',
    async (replaceAccess) => {
      api.setup.mockResolvedValue(failed({ retry: 'limited', replaceAccess }))
      await showSetup()
      expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Изменить доступ' })).not.toBeInTheDocument()
      expect(document.body.textContent).toContain(
        'Повторить настройку или изменить доступ можно 6 раз в час.',
      )
    },
  )

  it('passes on the text of a refused retry', async () => {
    api.setup.mockResolvedValue(failed())
    api.retry.mockRejectedValue(
      Object.assign(new Error('Повторить можно позже'), {
        data: { code: 'TOO_MANY_REQUESTS', domainCode: 'SITE_CHECKS_LIMITED' },
      }),
    )
    await showSetup()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    await pass(0)
    expect(screen.getByRole('alert')).toHaveTextContent('Повторить можно позже.')
  })

  it.each(['SITE_SETUP_NOT_FAILED', 'SITE_SETUP_UNAVAILABLE'])(
    'asks the server anew when «Повторить» is refused with %s',
    async (domainCode) => {
      api.setup
        .mockResolvedValueOnce(failed())
        .mockResolvedValue(setupIn({ attempt: 2, status: 'running', step: 'fetch' }))
      api.retry.mockRejectedValue(refusal(domainCode))
      await showSetup()
      expect(asked()).toBe(1)
      fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
      await pass(0)
      // Another tab already started the next attempt: the screen follows it.
      expect(asked()).toBe(2)
      expect(status()).toHaveTextContent('Копируем файлы сайта')
      expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument()
      await pass(SETUP_POLL_MS)
      expect(asked()).toBe(3)
    },
  )
})

describe('«Изменить доступ»', () => {
  it('starts from the public part of the saved access, never from a secret', async () => {
    api.setup.mockResolvedValue(failed())
    await showSetup()
    fireEvent.click(screen.getByRole('button', { name: 'Изменить доступ' }))
    await pass(0)

    expect(screen.getByRole('heading', { name: 'Новый доступ к файлам' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: 'SSH' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: /^Сервер/ })).toHaveValue('ssh.example.ru')
    expect(screen.getByRole('textbox', { name: /^Порт/ })).toHaveValue('2222')
    expect(screen.getByRole('textbox', { name: /^Папка сайта/ })).toHaveValue('/var/www/site')
    expect(screen.getByRole('textbox', { name: /^Пользователь/ })).toHaveValue('')
    expect(screen.getByLabelText(/^Пароль/, { selector: 'input[type="password"]' })).toHaveValue('')
  })

  it('sends the new access to the same server with the key confirmed for it before', async () => {
    api.setup.mockResolvedValueOnce(failed())
    api.replaceAccess.mockResolvedValue({ outcome: 'replaced' })
    api.setup.mockResolvedValue(setupIn({ attempt: 2 }))
    await showSetup()
    await openReplacement()
    await saveAccess()

    // The saved key is what the server must present: nothing to compare when it does.
    expect(api.checkSource).not.toHaveBeenCalled()
    expect(api.replaceAccess).toHaveBeenCalledExactlyOnceWith({
      id: SITE_ID,
      source: {
        kind: 'sftp',
        host: 'ssh.example.ru',
        port: 2222,
        username: 'deploy',
        auth: { method: 'password', password: 'new-password-of-the-test' },
        rootPath: '/var/www/site',
        hostKey: KEY,
      },
    })
    expect(screen.queryByRole('heading', { name: 'Новый доступ к файлам' })).not.toBeInTheDocument()
    expect(status()).toHaveTextContent('Ожидаем начала настройки')
    expect(listInvalidated()).toBe(true)
  })

  it('warns when the same server presents another key, and takes it only by its own button', async () => {
    api.setup.mockResolvedValueOnce(failed())
    api.replaceAccess
      .mockResolvedValueOnce({
        outcome: 'source_refused',
        reason: 'host_key_changed',
        hostKey: OTHER_KEY,
      })
      .mockResolvedValueOnce({ outcome: 'source_refused', reason: 'auth_failed' })
      .mockResolvedValue({ outcome: 'replaced' })
    api.setup.mockResolvedValue(setupIn({ attempt: 2 }))
    await showSetup()
    await openReplacement()
    await saveAccess()

    expect(api.replaceAccess).toHaveBeenLastCalledWith({
      id: SITE_ID,
      source: expect.objectContaining({ hostKey: KEY }),
    })
    expect(screen.queryByRole('region', { name: 'Сверьте ключ сервера' })).not.toBeInTheDocument()
    const panel = screen.getByRole('region', { name: 'Ключ сервера изменился' })
    expect(within(panel).getByText(OTHER_KEY)).toBeVisible()
    expect(within(panel).getByRole('heading', { name: 'Ключ сервера изменился' })).toHaveFocus()

    fireEvent.click(within(panel).getByRole('button', { name: 'Принять новый ключ' }))
    await pass(0)
    expect(api.replaceAccess).toHaveBeenLastCalledWith({
      id: SITE_ID,
      source: expect.objectContaining({ hostKey: OTHER_KEY }),
      acceptNewHostKey: true,
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Сервер не принял пользователя')

    // The accepted key stays accepted while the user fixes the password.
    await saveAccess('deploy', 'another-password-of-the-test')
    expect(api.replaceAccess).toHaveBeenCalledTimes(3)
    expect(api.replaceAccess).toHaveBeenLastCalledWith({
      id: SITE_ID,
      source: expect.objectContaining({
        hostKey: OTHER_KEY,
        auth: { method: 'password', password: 'another-password-of-the-test' },
      }),
      acceptNewHostKey: true,
    })
    expect(screen.queryByRole('heading', { name: 'Новый доступ к файлам' })).not.toBeInTheDocument()
  })

  it('confirms the key of another server anew before the new access is sent', async () => {
    api.setup.mockResolvedValueOnce(failed())
    api.checkSource.mockResolvedValue({ ok: false, reason: 'host_key_unknown', hostKey: OTHER_KEY })
    api.replaceAccess.mockResolvedValue({ outcome: 'replaced' })
    api.setup.mockResolvedValue(setupIn({ attempt: 2 }))
    await showSetup()
    await openReplacement()
    typeIn(textbox(/^Сервер/), 'ssh2.example.ru')
    await saveAccess()

    // The first look learns the key and logs in nowhere.
    expect(api.checkSource).toHaveBeenCalledExactlyOnceWith({
      stack: 'wordpress',
      source: expect.not.objectContaining({ hostKey: expect.anything() }),
    })
    expect(api.replaceAccess).not.toHaveBeenCalled()
    const panel = screen.getByRole('region', { name: 'Сверьте ключ сервера' })
    expect(within(panel).getByText(OTHER_KEY)).toBeVisible()

    fireEvent.click(within(panel).getByRole('button', { name: 'Ключ совпадает, продолжить' }))
    await pass(0)
    expect(api.replaceAccess).toHaveBeenCalledExactlyOnceWith({
      id: SITE_ID,
      source: {
        kind: 'sftp',
        host: 'ssh2.example.ru',
        port: 2222,
        username: 'deploy',
        auth: { method: 'password', password: 'new-password-of-the-test' },
        rootPath: '/var/www/site',
        hostKey: OTHER_KEY,
      },
    })
    expect(status()).toHaveTextContent('Ожидаем начала настройки')
  })

  it('expects the saved key again once the server and the port are the saved ones', async () => {
    api.setup.mockResolvedValue(failed())
    api.replaceAccess.mockResolvedValue({ outcome: 'source_refused', reason: 'auth_failed' })
    await showSetup()
    await openReplacement()
    typeIn(textbox(/^Порт/), '22')
    typeIn(textbox(/^Порт/), '2222')
    await saveAccess()
    expect(api.checkSource).not.toHaveBeenCalled()
    expect(api.replaceAccess).toHaveBeenCalledExactlyOnceWith({
      id: SITE_ID,
      source: expect.objectContaining({ port: 2222, hostKey: KEY }),
    })
  })

  it('sends FTP at once with the protection it had', async () => {
    api.setup.mockResolvedValue(
      failed({
        source: {
          kind: 'ftp',
          host: 'ftp.example.ru',
          port: 21,
          rootPath: 'www',
          tls: 'unverified',
          hostKey: null,
        },
      }),
    )
    api.replaceAccess.mockResolvedValue({ outcome: 'source_refused', reason: 'auth_failed' })
    await showSetup()
    fireEvent.click(screen.getByRole('button', { name: 'Изменить доступ' }))
    await pass(0)
    expect(screen.getByRole('tab', { name: 'FTP' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.change(screen.getByRole('textbox', { name: /^Пользователь/ }), {
      target: { value: 'u' },
    })
    fireEvent.change(screen.getByLabelText(/^Пароль/, { selector: 'input[type="password"]' }), {
      target: { value: 'p' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить доступ' }))
    await pass(0)
    expect(api.checkSource).not.toHaveBeenCalled()
    expect(api.replaceAccess).toHaveBeenCalledWith({
      id: SITE_ID,
      source: expect.objectContaining({ kind: 'ftp', tls: 'unverified', rootPath: 'www' }),
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Сервер не принял пользователя или пароль.')
  })

  it('goes back to the buttons on «Отмена», with the focus on «Изменить доступ»', async () => {
    api.setup.mockResolvedValue(failed())
    await showSetup()
    await openReplacement()
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    await pass(0)
    expect(screen.queryByRole('heading', { name: 'Новый доступ к файлам' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Изменить доступ' })).toHaveFocus()
  })

  it('puts the focus on the first wrong field at once and leaves it where the user types next', async () => {
    api.setup.mockResolvedValue(failed())
    await showSetup()
    await openReplacement()
    const save = screen.getByRole('button', { name: 'Сохранить доступ' })
    fireEvent.click(save)
    expect(textbox(/^Пользователь/)).toHaveFocus()
    // A second press with nothing fixed changes nothing on the screen.
    fireEvent.click(save)
    expect(textbox(/^Пользователь/)).toHaveFocus()

    const folder = textbox(/^Папка сайта/)
    act(() => folder.focus())
    typeIn(folder, '/var/www/site/public_html')
    await pass(0)
    expect(folder).toHaveFocus()
    expect(api.replaceAccess).not.toHaveBeenCalled()
  })

  it('says the new access was saved only for the attempt it was saved for', async () => {
    let answer: (value: SiteSetupState) => void = () => {}
    api.setup
      .mockResolvedValueOnce(failed())
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
      .mockResolvedValue(failed({ attempt: 2, errorCode: 'not_found' }))
    api.replaceAccess.mockResolvedValue({ outcome: 'replaced' })
    await showSetup()
    await openReplacement()
    await saveAccess()
    expect(status()).toHaveTextContent('Новый доступ сохранён.')
    expect(listInvalidated()).toBe(true)

    // The next attempt runs, then stops for its own reason: the notice was of the one before.
    await act(async () => answer(setupIn({ attempt: 2, status: 'running', step: 'fetch' })))
    expect(status()).toHaveTextContent('Копируем файлы сайта')
    await pass(SETUP_POLL_MS)
    expect(status()).toHaveTextContent('Папки сайта на сервере не нашлось.')
    expect(status()).not.toHaveTextContent('Новый доступ сохранён.')
  })
})
