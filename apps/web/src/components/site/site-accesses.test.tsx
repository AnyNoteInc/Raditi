// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SiteAccesses, type EditableAccessView } from './site-accesses'

type Call = Record<string, unknown>

const { api, refresh } = vi.hoisted(() => ({
  api: {
    checkSource: vi.fn<(input: Call) => Promise<unknown>>(),
    replaceAccess: vi.fn<(input: Call) => Promise<unknown>>(),
    changeSource: vi.fn<(input: Call) => Promise<unknown>>(),
    changeDatabase: vi.fn<(input: Call) => Promise<unknown>>(),
  },
  refresh: vi.fn(),
}))

const mutation =
  (fn: (input: Call) => Promise<unknown>) =>
  (options: UseMutationOptions<unknown, Error, Call> = {}) => ({ ...options, mutationFn: fn })

const trpc = {
  siteConnection: {
    checkSource: { mutationOptions: mutation((input) => api.checkSource(input)) },
    replaceAccess: { mutationOptions: mutation((input) => api.replaceAccess(input)) },
    changeSource: { mutationOptions: mutation((input) => api.changeSource(input)) },
    changeDatabase: { mutationOptions: mutation((input) => api.changeDatabase(input)) },
  },
}

vi.mock('@/trpc/client', () => ({ useTRPC: () => trpc }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

const SITE_ID = '019f1a21-1800-7f00-8abc-222222222222'
const KEY = `ssh-ed25519 SHA256:${'Q'.repeat(43)}`
const at = new Date('2026-10-04T09:40:00Z')
const saved = [
  { kind: 'ssh', version: 1, updatedAt: at },
  { kind: 'db', version: 2, updatedAt: at },
  { kind: 'wp', version: 2, updatedAt: at },
]
const owner: EditableAccessView = {
  canChange: true,
  busy: null,
  source: {
    kind: 'sftp',
    host: 'ssh.example.ru',
    port: 2222,
    rootPath: '/var/www/site',
    tls: null,
    hostKey: KEY,
  },
  database: {
    engine: 'mysql',
    host: 'db.example.ru',
    port: 3306,
    databaseName: 'wordpress',
    tls: 'verified',
  },
}

function show(
  props: Partial<{
    accesses: typeof saved | null
    editable: EditableAccessView | null
  }> = {},
) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SiteAccesses
        siteId={SITE_ID}
        stack="wordpress"
        platform="WordPress"
        accesses={props.accesses === undefined ? saved : props.accesses}
        editable={props.editable === undefined ? owner : props.editable}
      />
    </QueryClientProvider>,
  )
}

const field = (id: string) => document.getElementById(id) as HTMLInputElement
const type = (id: string, value: string) => fireEvent.change(field(id), { target: { value } })

beforeEach(() => {
  vi.clearAllMocks()
  api.changeSource.mockResolvedValue({ outcome: 'replaced' })
  api.changeDatabase.mockResolvedValue({ outcome: 'replaced' })
})

describe('the accesses of a site', () => {
  it('shows what is saved about an access and never a value', () => {
    show({ accesses: [{ kind: 'wp', version: 2, updatedAt: at }] })
    expect(screen.getByText('Вход в панель сайта')).toBeTruthy()
    expect(screen.getByText('Правки текстов, цен и фото')).toBeTruthy()
    expect(screen.getByText('пароль приложения · скрыто')).toBeTruthy()
    expect(screen.getByText('версия 2')).toBeTruthy()
    expect(screen.getByText(/^4\sоктября 2026, 12:40$/u)).toBeTruthy()
    // An access the client does not change here has no button.
    expect(screen.queryByRole('button', { name: /^Изменить/ })).toBeNull()
  })

  it('says so when no access is saved and when the list could not be read', () => {
    const { rerender } = show({ accesses: [] })
    expect(screen.getByText(/Доступов пока нет/)).toBeTruthy()
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <SiteAccesses
          siteId={SITE_ID}
          stack="wordpress"
          platform="WordPress"
          accesses={null}
          editable={owner}
        />
      </QueryClientProvider>,
    )
    expect(screen.getByRole('alert').textContent).toMatch(/Не удалось загрузить список доступов/)
  })

  it('offers «Изменить» of the files and the database to an owner, and to no one else', () => {
    const { unmount } = show()
    expect(screen.getByRole('button', { name: 'Изменить: SSH' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Изменить: База данных' })).toBeTruthy()
    unmount()
    show({ editable: { canChange: false, busy: null, source: null, database: null } })
    expect(screen.queryByRole('button', { name: /^Изменить/ })).toBeNull()
    expect(screen.getByText(/Изменить доступ могут владелец и администраторы\./)).toBeTruthy()
  })

  it('holds «Изменить» while a release goes on, and says why', () => {
    show({ editable: { ...owner, busy: 'release' } })
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Изменить: SSH' })
    expect(button.disabled).toBe(true)
    expect(screen.getByText(/Сейчас идёт выпуск новой версии сайта\./)).toBeTruthy()
  })

  it('changes the access to the files in a panel over the page, saved once the connection passed', async () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Изменить: SSH' }))
    const panel = screen.getByRole('dialog', { name: 'Изменить доступ к файлам' })
    expect(within(panel).getByText(/сохраним его, только если подключение пройдёт/)).toBeTruthy()
    // The public part of the saved source, never a login or a password.
    expect(field('replace-access-host').value).toBe('ssh.example.ru')
    expect(field('replace-access-username').value).toBe('')
    type('replace-access-username', 'site-user')
    type('replace-access-password', 'new-password-1')
    fireEvent.click(within(panel).getByRole('button', { name: 'Сохранить доступ' }))

    await waitFor(() => expect(api.changeSource).toHaveBeenCalledTimes(1))
    expect(api.changeSource.mock.calls[0]![0]).toEqual({
      id: SITE_ID,
      source: {
        kind: 'sftp',
        host: 'ssh.example.ru',
        port: 2222,
        username: 'site-user',
        auth: { method: 'password', password: 'new-password-1' },
        rootPath: '/var/www/site',
        hostKey: KEY,
      },
    })
    // The key of the saved server is the one it must present: no first check is made.
    expect(api.checkSource).not.toHaveBeenCalled()
    expect(api.replaceAccess).not.toHaveBeenCalled()
    expect(await screen.findByText('Доступ к файлам проверен и сохранён.')).toBeTruthy()
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Изменить доступ к файлам' })).toBeNull(),
    )
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('keeps the panel open with the reason when the connection with the new access fails', async () => {
    api.changeSource.mockResolvedValue({ outcome: 'source_refused', reason: 'auth_failed' })
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Изменить: SSH' }))
    type('replace-access-username', 'site-user')
    type('replace-access-password', 'wrong-password')
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить доступ' }))
    expect(
      await screen.findByText(
        'Сервер не принял пользователя, пароль или ключ. Проверьте их в панели хостинга.',
      ),
    ).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Изменить доступ к файлам' })).toBeTruthy()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('changes the access to the database: a new login, checked before it is saved', async () => {
    api.changeDatabase.mockResolvedValueOnce({ outcome: 'database_refused', reason: 'auth_failed' })
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Изменить: База данных' }))
    const panel = screen.getByRole('dialog', { name: 'Изменить доступ к базе данных' })
    expect(within(panel).queryByText('Без базы данных')).toBeNull()
    expect(field('change-database-host').value).toBe('db.example.ru')
    expect(field('change-database-database').value).toBe('wordpress')

    fireEvent.click(within(panel).getByRole('button', { name: 'Сохранить доступ' }))
    expect(api.changeDatabase).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(field('change-database-username'))

    type('change-database-username', 'db-user')
    type('change-database-password', 'db-password-1')
    fireEvent.click(within(panel).getByRole('button', { name: 'Сохранить доступ' }))
    expect(
      await screen.findByText(
        'Сервер базы данных не принял пользователя или пароль. Проверьте их в панели хостинга.',
      ),
    ).toBeTruthy()
    expect(api.changeDatabase.mock.calls[0]![0]).toEqual({
      id: SITE_ID,
      database: {
        engine: 'mysql',
        host: 'db.example.ru',
        port: 3306,
        database: 'wordpress',
        username: 'db-user',
        password: 'db-password-1',
        tls: 'verified',
      },
    })

    fireEvent.click(within(panel).getByRole('button', { name: 'Сохранить доступ' }))
    expect(await screen.findByText('Доступ к базе данных проверен и сохранён.')).toBeTruthy()
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
