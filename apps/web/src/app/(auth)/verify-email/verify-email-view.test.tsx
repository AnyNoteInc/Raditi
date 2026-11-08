// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { VerifyEmailView } from './verify-email-view'

vi.mock('@/components/auth/auth-ui', () => ({
  captchaHeaders: () => ({}),
  useAuthUi: () => ({ authClient: {}, captchaSiteKey: undefined }),
}))
vi.mock('@repo/ui/captcha', () => ({
  captchaErrorMessage: () => null,
  useSmartCaptcha: () => ({ execute: async () => null, widget: null }),
}))
vi.mock('@repo/ui/widgets/auth', () => ({
  AuthHeader: ({ title }: { title: string }): ReactNode => <h1>{title}</h1>,
}))

describe('VerifyEmailView', () => {
  it('names the place the link of the letter leads to', () => {
    render(<VerifyEmailView linkError={null} unverified={false} />)

    expect(
      screen.getByText(
        'Мы отправили письмо со ссылкой. Откройте его и перейдите по ссылке — после этого вы перейдёте к чатам.',
      ),
    ).toBeInTheDocument()
  })
})
