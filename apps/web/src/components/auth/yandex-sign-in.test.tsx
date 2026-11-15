// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { yandexFailureText } from './yandex-failure'
import { YandexSignIn } from './yandex-sign-in'

const { social, ui } = vi.hoisted(() => ({
  social: vi.fn(),
  ui: { yandexSignIn: true },
}))

vi.mock('./auth-ui', () => ({
  useAuthUi: () => ({ authClient: { signIn: { social } }, yandexSignIn: ui.yandexSignIn }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  ui.yandexSignIn = true
})

describe('YandexSignIn', () => {
  it('starts the round trip back to the given page, failures to the sign-in page', async () => {
    social.mockResolvedValue({ data: { url: 'https://oauth.yandex.com/authorize' }, error: null })
    render(<YandexSignIn callbackURL="/chats/42" />)

    fireEvent.click(screen.getByRole('button', { name: 'Войти с Яндекс ID' }))

    await waitFor(() =>
      expect(social).toHaveBeenCalledWith({
        provider: 'yandex',
        callbackURL: '/chats/42',
        errorCallbackURL: '/sign-in?yandex=failed',
      }),
    )
  })

  it('says so when the start fails', async () => {
    social.mockResolvedValue({ data: null, error: { status: 500 } })
    render(<YandexSignIn callbackURL="/chats" />)

    fireEvent.click(screen.getByRole('button', { name: 'Войти с Яндекс ID' }))

    expect(
      await screen.findByText('Не удалось войти через Яндекс ID. Попробуйте ещё раз.'),
    ).toBeTruthy()
  })

  it('shows nothing when the server has no Yandex app', () => {
    ui.yandexSignIn = false
    const { container } = render(<YandexSignIn callbackURL="/chats" />)
    expect(container.textContent).toBe('')
  })
})

describe('yandexFailureText', () => {
  it('reads the failure of the last round trip', () => {
    expect(yandexFailureText({})).toBeUndefined()
    expect(yandexFailureText({ error: 'account_not_linked' })).toBeUndefined()
    expect(yandexFailureText({ yandex: 'failed', error: 'account_not_linked' })).toMatch(
      /уже зарегистрирован в Радити, но ещё не подтверждён/,
    )
    expect(yandexFailureText({ yandex: 'failed', error: 'state_mismatch' })).toBe(
      'Не удалось войти через Яндекс ID. Попробуйте ещё раз.',
    )
  })
})
