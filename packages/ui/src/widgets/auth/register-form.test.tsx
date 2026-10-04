import { fireEvent, render, screen } from '@testing-library/react'
import { userEvent, type UserEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { ConsentDocumentLinks } from './consents-checkboxes.tsx'
import { RegisterForm } from './register-form.tsx'

const documents: ConsentDocumentLinks = {
  userAgreement: '/legal/user-agreement',
  publicOffer: '/legal/public-offer',
  privacyPolicy: '/legal/privacy-policy',
  piiProcessing: '/legal/consent',
  marketing: '/legal/marketing-consent',
}

function renderForm(props: Partial<Parameters<typeof RegisterForm>[0]> = {}) {
  const onSubmit = vi.fn().mockResolvedValue(undefined)
  const view = render(
    <RegisterForm onSubmit={onSubmit} documents={documents} loginHref="/sign-in" {...props} />,
  )
  return { onSubmit, ...view }
}

async function fillFields(user: UserEvent, confirmPassword = 'secret-pass') {
  await user.type(screen.getByLabelText('Как к вам обращаться'), 'Анна')
  await user.type(screen.getByLabelText('Электронная почта'), ' anna@example.ru ')
  await user.type(screen.getByLabelText('Пароль'), 'secret-pass')
  await user.type(screen.getByLabelText('Пароль ещё раз'), confirmPassword)
}

const submitButton = () => screen.getByRole('button', { name: 'Зарегистрироваться' })
const termsCheckbox = () => screen.getByRole('checkbox', { name: /^Я принимаю/ })
const personalDataCheckbox = () =>
  screen.getByRole('checkbox', { name: 'Я даю согласие на обработку персональных данных' })
const marketingCheckbox = () => screen.getByRole('checkbox', { name: /рассылки/ })

const TERMS_ERROR = 'Чтобы зарегистрироваться, примите условия'
const PERSONAL_DATA_ERROR = 'Нужно дать согласие на обработку персональных данных'

async function acceptRequired(user: UserEvent) {
  await user.click(termsCheckbox())
  await user.click(personalDataCheckbox())
}

describe('RegisterForm', () => {
  it('shows three separate consents, unchecked', () => {
    renderForm()

    expect(screen.getAllByRole('checkbox')).toHaveLength(3)
    expect(termsCheckbox()).toHaveAccessibleName(
      'Я принимаю Пользовательское соглашение и Публичную оферту и ознакомлен(а) с Политикой обработки персональных данных',
    )
    expect(termsCheckbox()).not.toBeChecked()
    expect(termsCheckbox()).toBeRequired()
    expect(personalDataCheckbox()).not.toBeChecked()
    expect(personalDataCheckbox()).toBeRequired()
    expect(marketingCheckbox()).toHaveAccessibleName(
      'Я согласен(на) получать информационные и рекламные рассылки',
    )
    expect(marketingCheckbox()).not.toBeChecked()
    expect(marketingCheckbox()).not.toBeRequired()
  })

  it('links the four required documents and the marketing consent', () => {
    renderForm()

    const expected: Array<[RegExp, string]> = [
      [/^Пользовательское соглашение$/, documents.userAgreement],
      [/^Публичную оферту$/, documents.publicOffer],
      [/^Политикой обработки персональных данных$/, documents.privacyPolicy],
      [/^согласие на обработку персональных данных$/, documents.piiProcessing],
      [/^информационные и рекламные рассылки$/, documents.marketing],
    ]
    for (const [name, href] of expected) {
      const link = screen.getByRole('link', { name })
      expect(link).toHaveAttribute('href', href)
      expect(link).toHaveAttribute('target', '_blank')
    }
  })

  it('blocks submit until both required consents are given', async () => {
    const user = userEvent.setup()
    const { onSubmit, container } = renderForm()
    await fillFields(user)

    expect(submitButton()).toBeDisabled()

    // Even a forced submit is stopped by the schema, with an error under each checkbox.
    fireEvent.submit(container.querySelector('form')!)
    expect(await screen.findByText(TERMS_ERROR)).toBeVisible()
    expect(screen.getByText(PERSONAL_DATA_ERROR)).toBeVisible()
    expect(termsCheckbox()).toHaveAttribute('aria-invalid', 'true')
    expect(termsCheckbox()).toHaveAccessibleDescription(TERMS_ERROR)
    expect(personalDataCheckbox()).toHaveAttribute('aria-invalid', 'true')
    expect(personalDataCheckbox()).toHaveAccessibleDescription(PERSONAL_DATA_ERROR)
    expect(marketingCheckbox()).not.toHaveAttribute('aria-invalid')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('cannot submit with the terms only', async () => {
    const user = userEvent.setup()
    const { onSubmit, container } = renderForm()
    await fillFields(user)

    await user.click(termsCheckbox())
    expect(submitButton()).toBeDisabled()

    fireEvent.submit(container.querySelector('form')!)
    expect(await screen.findByText(PERSONAL_DATA_ERROR)).toBeVisible()
    expect(screen.queryByText(TERMS_ERROR)).not.toBeInTheDocument()
    expect(termsCheckbox()).not.toHaveAttribute('aria-invalid')
    expect(personalDataCheckbox()).toHaveAttribute('aria-invalid', 'true')
    expect(personalDataCheckbox()).toHaveFocus()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('cannot submit with the personal data consent only', async () => {
    const user = userEvent.setup()
    const { onSubmit, container } = renderForm()
    await fillFields(user)

    await user.click(personalDataCheckbox())
    await user.click(marketingCheckbox())
    expect(submitButton()).toBeDisabled()

    fireEvent.submit(container.querySelector('form')!)
    expect(await screen.findByText(TERMS_ERROR)).toBeVisible()
    expect(screen.queryByText(PERSONAL_DATA_ERROR)).not.toBeInTheDocument()
    expect(termsCheckbox()).toHaveAttribute('aria-invalid', 'true')
    expect(personalDataCheckbox()).not.toHaveAttribute('aria-invalid')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('clears the error once the missing consent is given', async () => {
    const user = userEvent.setup()
    const { onSubmit, container } = renderForm()
    await fillFields(user)
    await user.click(termsCheckbox())
    fireEvent.submit(container.querySelector('form')!)
    expect(await screen.findByText(PERSONAL_DATA_ERROR)).toBeVisible()

    await user.click(personalDataCheckbox())

    expect(screen.queryByText(PERSONAL_DATA_ERROR)).not.toBeInTheDocument()
    expect(submitButton()).toBeEnabled()
    await user.click(submitButton())
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('submits the values once both required consents are given', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()
    await fillFields(user)

    await acceptRequired(user)
    expect(submitButton()).toBeEnabled()
    await user.click(submitButton())

    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit).toHaveBeenCalledWith(
      {
        name: 'Анна',
        email: 'anna@example.ru',
        password: 'secret-pass',
        acceptTerms: true,
        acceptPersonalData: true,
        marketing: false,
      },
      { captchaToken: null },
    )
  })

  it('passes the marketing choice and the captcha token', async () => {
    const user = userEvent.setup()
    const getCaptchaToken = vi.fn().mockResolvedValue('captcha-token')
    const { onSubmit } = renderForm({ getCaptchaToken })
    await fillFields(user)

    await acceptRequired(user)
    await user.click(marketingCheckbox())
    await user.click(submitButton())

    expect(getCaptchaToken).toHaveBeenCalledOnce()
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ marketing: true }), {
      captchaToken: 'captcha-token',
    })
  })

  it('reports different passwords under the second field', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()
    await fillFields(user, 'other-pass')

    await acceptRequired(user)
    await user.click(submitButton())

    expect(await screen.findByText('Пароли не совпадают')).toBeVisible()
    expect(screen.getByLabelText('Пароль ещё раз')).toHaveAttribute('aria-invalid', 'true')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('reports a pasted tab in the name under its field, as the server would refuse it', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()
    await fillFields(user)
    fireEvent.change(screen.getByLabelText('Как к вам обращаться'), {
      target: { value: 'Анна\tИванова' },
    })

    await acceptRequired(user)
    await user.click(submitButton())

    expect(
      await screen.findByText('Уберите из имени табуляцию и другие служебные знаки'),
    ).toBeVisible()
    expect(screen.getByLabelText('Как к вам обращаться')).toHaveAttribute('aria-invalid', 'true')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('shows field errors returned by the server', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()
    onSubmit.mockResolvedValue({ fieldErrors: { email: 'Этот адрес уже зарегистрирован' } })
    await fillFields(user)

    await acceptRequired(user)
    await user.click(submitButton())

    expect(await screen.findByText('Этот адрес уже зарегистрирован')).toBeVisible()
    expect(screen.getByLabelText('Электронная почта')).toHaveAttribute('aria-invalid', 'true')
  })
})
