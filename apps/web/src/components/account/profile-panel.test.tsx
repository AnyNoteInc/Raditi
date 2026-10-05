// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProfilePanel } from './profile-panel'

const mocks = vi.hoisted(() => ({
  saveProfile: vi.fn(),
  refresh: vi.fn(),
  redirectToConsents: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('@/trpc/consent-redirect', () => ({ redirectToConsents: mocks.redirectToConsents }))
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    user: {
      me: { queryOptions: () => ({ queryKey: ['user', 'me'] }) },
      updateProfile: {
        mutationOptions: (options: Record<string, unknown>) => ({
          ...options,
          mutationFn: mocks.saveProfile,
        }),
      },
    },
  }),
}))

const user = { name: 'Анна', lastName: 'Иванова', email: 'anna@example.test', image: null }
const storedImage = '/api/profile/avatar/test-user/00000000-0000-4000-8000-000000000000.webp'
const createObjectURL = vi.fn(() => 'blob:profile-preview')
const revokeObjectURL = vi.fn()
const fetchMock = vi.fn()

function showProfile(image: string | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  queryClient.setQueryData(['user', 'me'], { id: 'test-user', ...user, image, emailVerified: true })
  render(
    <QueryClientProvider client={queryClient}>
      <ProfilePanel user={{ ...user, image }} />
    </QueryClientProvider>,
  )
  return queryClient
}

function choosePhoto(file = new File(['photo'], 'portrait.png', { type: 'image/png' })) {
  fireEvent.change(screen.getByLabelText('Выбрать фото профиля'), { target: { files: [file] } })
  return file
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
  mocks.saveProfile.mockResolvedValue({
    id: 'test-user',
    ...user,
    name: 'Анна',
    lastName: 'Петрова',
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('profile editing', () => {
  it('saves separate trimmed fields and refreshes the account menus', async () => {
    const client = showProfile()
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Фамилия' }), {
      target: { value: ' Петрова ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    await screen.findByText('Имя и фамилия сохранены.')
    expect(mocks.saveProfile.mock.calls[0]?.[0]).toEqual({ name: 'Анна', lastName: 'Петрова' })
    expect(client.getQueryData(['user', 'me'])).toMatchObject({ lastName: 'Петрова' })
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('explains a pasted tab under its field instead of sending the profile', () => {
    showProfile()
    const save = screen.getByRole('button', { name: 'Сохранить' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Имя' }), {
      target: { value: 'Анна\tМария' },
    })
    expect(screen.getByText('Уберите из имени табуляцию и другие служебные знаки.')).toBeVisible()
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Имя' }), { target: { value: 'Анна ' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Фамилия' }), {
      target: { value: 'Иванова\u0000Петрова' },
    })
    expect(screen.getByText('Уберите из фамилии табуляцию и другие служебные знаки.')).toBeVisible()
    expect(save).toBeDisabled()
    // The server trims the ends, so a trailing line break is not an error.
    fireEvent.change(screen.getByRole('textbox', { name: 'Фамилия' }), {
      target: { value: 'Петрова\n' },
    })
    expect(save).toBeEnabled()
    expect(mocks.saveProfile).not.toHaveBeenCalled()
  })

  it('sends the user to accept the documents when the photo is refused for missing consents', async () => {
    showProfile()
    choosePhoto()
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: 'Примите обновлённые документы, чтобы продолжить' }), {
        status: 428,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить фото' }))
    await screen.findByText('Примите обновлённые документы, чтобы продолжить')
    expect(mocks.redirectToConsents).toHaveBeenCalledOnce()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('previews a photo locally and uploads only after saving it', async () => {
    const client = showProfile()
    const file = choosePhoto()
    expect(screen.getByText('Предпросмотр. Фото ещё не сохранено.')).toBeVisible()
    expect(screen.getByRole('img', { name: 'Анна Иванова' })).toHaveAttribute(
      'src',
      'blob:profile-preview',
    )
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ image: storedImage })))
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить фото' }))
    await screen.findByText('Фото профиля сохранено.')
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/profile/avatar')
    expect(options.method).toBe('POST')
    expect((options.body as FormData).get('file')).toBe(file)
    expect(client.getQueryData(['user', 'me'])).toMatchObject({ image: storedImage })
    expect(screen.getByRole('button', { name: 'Заменить фото' })).toBeVisible()
    expect(mocks.refresh).toHaveBeenCalledOnce()
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:profile-preview'))
  })

  it('keeps the preview when the server rejects a file, allowing another attempt', async () => {
    showProfile()
    choosePhoto()
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: 'Файл повреждён.' }), { status: 400 }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить фото' }))
    await screen.findByText('Файл повреждён.')
    expect(screen.getByRole('button', { name: 'Сохранить фото' })).toBeEnabled()
    expect(screen.getByText('Предпросмотр. Фото ещё не сохранено.')).toBeVisible()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('rejects unsupported or oversized images before any request', () => {
    showProfile()
    choosePhoto(new File(['<svg />'], 'portrait.svg', { type: 'image/svg+xml' }))
    expect(screen.getByText('Выберите фото в формате JPG, PNG или WebP.')).toBeVisible()
    choosePhoto(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }))
    expect(screen.getByText('Размер фото должен быть от 1 байта до 5 МБ.')).toBeVisible()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('cancels an unsaved preview without changing the stored photo', async () => {
    showProfile(storedImage)
    choosePhoto()
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    expect(screen.queryByText('Предпросмотр. Фото ещё не сохранено.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Удалить фото' })).toBeVisible()
    expect(fetchMock).not.toHaveBeenCalled()
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:profile-preview'))
  })

  it('removes a stored photo and refreshes the initials in the menus', async () => {
    const client = showProfile(storedImage)
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ image: null })))
    fireEvent.click(screen.getByRole('button', { name: 'Удалить фото' }))
    await screen.findByText('Фото профиля удалено.')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/profile/avatar',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(client.getQueryData(['user', 'me'])).toMatchObject({ image: null })
    expect(screen.getByRole('button', { name: 'Выбрать фото' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Удалить фото' })).not.toBeInTheDocument()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })
})
