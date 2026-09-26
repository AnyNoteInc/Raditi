// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SignInForm } from './sign-in-form'

const { signInEmail, hardNavigate, router } = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  hardNavigate: vi.fn<(path: string) => void>(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}))

vi.mock('@/components/auth/auth-ui', () => ({
  captchaHeaders: () => ({}),
  useAuthUi: () => ({ authClient: { signIn: { email: signInEmail } }, captchaSiteKey: undefined }),
}))
vi.mock('@repo/ui/captcha', () => ({
  useSmartCaptcha: () => ({ execute: async () => null, widget: null }),
}))
vi.mock('@/lib/hard-navigate', () => ({ hardNavigate }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))

beforeEach(() => {
  vi.clearAllMocks()
})

function signIn() {
  fireEvent.change(screen.getByLabelText('Электронная почта'), {
    target: { value: 'anna@example.ru' },
  })
  fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'secret-pass' } })
  fireEvent.click(screen.getByRole('button', { name: 'Войти' }))
}

describe('SignInForm', () => {
  it('opens the target with a full page load, not a client-side transition', async () => {
    signInEmail.mockResolvedValue({ data: {}, error: null })
    render(<SignInForm redirectTo="/app/tasks/42" />)

    signIn()

    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/app/tasks/42'))
    expect(signInEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'anna@example.ru', password: 'secret-pass' }),
    )
    expect(router.replace).not.toHaveBeenCalled()
    expect(router.push).not.toHaveBeenCalled()
  })

  it('stays on the page when the password is wrong', async () => {
    signInEmail.mockResolvedValue({
      data: null,
      error: {
        status: 401,
        code: 'INVALID_EMAIL_OR_PASSWORD',
        message: 'Invalid email or password',
      },
    })
    render(<SignInForm redirectTo="/app" />)

    signIn()

    expect(await screen.findByRole('alert')).toBeVisible()
    expect(hardNavigate).not.toHaveBeenCalled()
  })
})
