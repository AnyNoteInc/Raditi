import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { CaptchaError } from '../../captcha/captcha-error.ts'
import { ResetPasswordConfirmForm } from './reset-password-confirm-form.tsx'
import {
  RESET_REQUEST_SENT_MESSAGE,
  ResetPasswordRequestForm,
} from './reset-password-request-form.tsx'

describe('ResetPasswordRequestForm', () => {
  it('confirms the request without revealing whether the address exists', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<ResetPasswordRequestForm onSubmit={onSubmit} loginHref="/sign-in" />)

    await user.type(screen.getByLabelText('Электронная почта'), 'anna@example.ru')
    await user.click(screen.getByRole('button', { name: 'Отправить ссылку' }))

    expect(await screen.findByRole('status')).toHaveTextContent(RESET_REQUEST_SENT_MESSAGE)
    expect(onSubmit).toHaveBeenCalledWith({ email: 'anna@example.ru' }, { captchaToken: null })
    expect(screen.getByRole('button', { name: 'Отправить ещё раз' })).toBeEnabled()
  })

  it('shows no success after a server error', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue({ error: 'Слишком много попыток' })
    render(<ResetPasswordRequestForm onSubmit={onSubmit} loginHref="/sign-in" />)

    await user.type(screen.getByLabelText('Электронная почта'), 'anna@example.ru')
    await user.click(screen.getByRole('button', { name: 'Отправить ссылку' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Слишком много попыток')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('treats a superseded captcha attempt as neither an error nor a success', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const getCaptchaToken = vi.fn().mockRejectedValue(new CaptchaError('superseded'))
    render(
      <ResetPasswordRequestForm
        onSubmit={onSubmit}
        getCaptchaToken={getCaptchaToken}
        loginHref="/sign-in"
      />,
    )

    await user.type(screen.getByLabelText('Электронная почта'), 'anna@example.ru')
    await user.click(screen.getByRole('button', { name: 'Отправить ссылку' }))

    expect(getCaptchaToken).toHaveBeenCalledOnce()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('ResetPasswordConfirmForm', () => {
  const links = { loginHref: '/sign-in', requestResetHref: '/reset-password' }

  it('sends only the new password', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<ResetPasswordConfirmForm onSubmit={onSubmit} {...links} />)

    await user.type(screen.getByLabelText('Новый пароль'), 'fresh-secret')
    await user.type(screen.getByLabelText('Новый пароль ещё раз'), 'fresh-secret')
    await user.click(screen.getByRole('button', { name: 'Сохранить пароль' }))

    expect(onSubmit).toHaveBeenCalledWith({ password: 'fresh-secret' }, { captchaToken: null })
    expect(await screen.findByRole('link', { name: 'Войти' })).toHaveAttribute('href', '/sign-in')
  })

  it('rejects a short or repeated-wrong password', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<ResetPasswordConfirmForm onSubmit={onSubmit} {...links} />)

    await user.type(screen.getByLabelText('Новый пароль'), 'short')
    await user.type(screen.getByLabelText('Новый пароль ещё раз'), 'shorter')
    await user.click(screen.getByRole('button', { name: 'Сохранить пароль' }))

    expect(await screen.findByText('Пароль должен быть не короче 8 символов')).toBeVisible()
    expect(screen.getByText('Пароли не совпадают')).toBeVisible()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('offers a new link instead of the form when the link is broken', () => {
    render(
      <ResetPasswordConfirmForm
        onSubmit={vi.fn()}
        {...links}
        linkError="Ссылка устарела. Запросите новую."
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Ссылка устарела')
    expect(screen.getByRole('link', { name: 'Запросить новую ссылку' })).toHaveAttribute(
      'href',
      '/reset-password',
    )
    expect(screen.queryByLabelText('Новый пароль')).not.toBeInTheDocument()
  })
})
