// @vitest-environment node
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { useSmartCaptcha } from './captcha/use-smart-captcha.tsx'
import { UiProvider } from './providers/ui-provider.tsx'
import { LoginForm } from './widgets/auth/login-form.tsx'
import { RegisterForm } from './widgets/auth/register-form.tsx'

const documents = {
  userAgreement: '/legal/user-agreement',
  publicOffer: '/legal/public-offer',
  privacyPolicy: '/legal/privacy-policy',
  piiProcessing: '/legal/consent',
  marketing: '/legal/marketing-consent',
}

function SignUpPage() {
  const captcha = useSmartCaptcha('ysc1_test')
  return (
    <>
      <RegisterForm
        onSubmit={vi.fn()}
        getCaptchaToken={captcha.execute}
        documents={documents}
        loginHref="/sign-in"
      />
      {captcha.widget}
    </>
  )
}

// Next renders client components on the server first: nothing may touch browser APIs.
describe('server rendering', () => {
  it.each(['light', 'dark', 'system'] as const)('renders the auth pages with %s', (mode) => {
    const html = renderToString(
      <UiProvider themePreference={mode}>
        <LoginForm onSubmit={vi.fn()} registerHref="/sign-up" forgotPasswordHref="/reset" />
        <SignUpPage />
      </UiProvider>,
    )

    expect(html).toContain('Вход в кабинет')
    expect(html).toContain('Зарегистрироваться')
  })
})
