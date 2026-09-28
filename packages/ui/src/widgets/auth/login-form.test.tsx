import { render, screen } from '@testing-library/react'
import { userEvent, type UserEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { CaptchaError } from '../../captcha/captcha-error.ts'
import { LoginForm } from './login-form.tsx'
import { GENERIC_SUBMIT_ERROR } from './auth-submit.ts'

function renderForm(props: Partial<Parameters<typeof LoginForm>[0]> = {}) {
  const onSubmit = vi.fn().mockResolvedValue(undefined)
  render(
    <LoginForm
      onSubmit={onSubmit}
      registerHref="/sign-up"
      forgotPasswordHref="/reset-password"
      {...props}
    />,
  )
  return { onSubmit }
}

async function signIn(user: UserEvent) {
  await user.type(screen.getByLabelText('Электронная почта'), 'anna@example.ru')
  await user.type(screen.getByLabelText('Пароль'), 'secret-pass')
  await user.click(screen.getByRole('button', { name: 'Войти' }))
}

describe('LoginForm', () => {
  it('shows the error returned by the server', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()
    onSubmit.mockResolvedValue({ error: 'Неверная почта или пароль' })

    await signIn(user)

    expect(await screen.findByRole('alert')).toHaveTextContent('Неверная почта или пароль')
    expect(onSubmit).toHaveBeenCalledWith(
      { email: 'anna@example.ru', password: 'secret-pass' },
      { captchaToken: null },
    )
  })

  it('clears the server error on the next successful attempt', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()
    onSubmit.mockResolvedValueOnce({ error: 'Неверная почта или пароль' })

    await signIn(user)
    expect(await screen.findByRole('alert')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Войти' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })

  it('shows a generic message when onSubmit throws', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()
    onSubmit.mockRejectedValue(new Error('fetch failed'))

    await signIn(user)

    expect(await screen.findByRole('alert')).toHaveTextContent(GENERIC_SUBMIT_ERROR)
  })

  it('validates in Russian before calling onSubmit', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()

    await user.click(screen.getByRole('button', { name: 'Войти' }))

    expect(await screen.findByText('Введите адрес электронной почты')).toBeVisible()
    expect(screen.getByText('Введите пароль')).toBeVisible()

    await user.type(screen.getByLabelText('Электронная почта'), 'anna@')
    expect(
      await screen.findByText('Проверьте адрес электронной почты: в нём есть ошибка'),
    ).toBeVisible()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does not submit when the captcha check fails', async () => {
    const user = userEvent.setup()
    const getCaptchaToken = vi.fn().mockRejectedValue(new CaptchaError('cancelled'))
    const { onSubmit } = renderForm({ getCaptchaToken })

    await signIn(user)

    expect(await screen.findByRole('alert')).toHaveTextContent(/Проверка не завершена/)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('shows and hides the password', async () => {
    const user = userEvent.setup()
    renderForm()
    const password = screen.getByLabelText('Пароль')

    expect(password).toHaveAttribute('type', 'password')
    await user.click(screen.getByRole('button', { name: 'Показать пароль' }))
    expect(password).toHaveAttribute('type', 'text')
    await user.click(screen.getByRole('button', { name: 'Скрыть пароль' }))
    expect(password).toHaveAttribute('type', 'password')
  })

  it('links to registration, password recovery and the home page', () => {
    renderForm({ notice: 'Адрес подтверждён. Войдите в кабинет' })

    expect(screen.getByRole('status')).toHaveTextContent('Адрес подтверждён')
    expect(screen.getByRole('link', { name: 'Зарегистрироваться' })).toHaveAttribute(
      'href',
      '/sign-up',
    )
    expect(screen.getByRole('link', { name: 'Забыли пароль?' })).toHaveAttribute(
      'href',
      '/reset-password',
    )
    expect(screen.getByRole('link', { name: 'Радити — на главную' })).toHaveAttribute('href', '/')
  })
})
