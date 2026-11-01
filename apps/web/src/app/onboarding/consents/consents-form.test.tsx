// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ConsentsForm } from './consents-form'

const { acceptRequired, router } = vi.hoisted(() => ({
  acceptRequired: vi.fn(),
  router: { replace: vi.fn(), refresh: vi.fn() },
}))

vi.mock('next/navigation', () => ({ useRouter: () => router }))
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    consent: { acceptRequired: { mutationOptions: (options: object) => options } },
  }),
}))
vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: { onSuccess: () => void }) => ({
    isPending: false,
    isSuccess: false,
    isError: false,
    mutate: (input: unknown) => {
      acceptRequired(input)
      options.onSuccess()
    },
  }),
}))
vi.mock('@repo/ui/widgets/auth', () => ({
  AuthHeader: ({ title, subtitle }: { title: string; subtitle: string }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  ),
  ConsentsCheckboxes: ({
    onAcceptTermsChange,
    onAcceptPersonalDataChange,
  }: {
    onAcceptTermsChange: (value: boolean) => void
    onAcceptPersonalDataChange: (value: boolean) => void
  }): ReactNode => (
    <>
      <button type="button" onClick={() => onAcceptTermsChange(true)}>
        Условия
      </button>
      <button type="button" onClick={() => onAcceptPersonalDataChange(true)}>
        Данные
      </button>
    </>
  ),
}))

describe('ConsentsForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('leads to the chats once both required consents are accepted', async () => {
    render(<ConsentsForm documents={{} as never} />)

    expect(
      screen.getByText(
        'Чтобы работать в кабинете, нужно согласие с действующими редакциями документов.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Условия' }))
    fireEvent.click(screen.getByRole('button', { name: 'Данные' }))
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/chats'))
    expect(acceptRequired).toHaveBeenCalledWith({
      acceptTerms: true,
      acceptPersonalData: true,
      marketing: false,
    })
    expect(router.refresh).toHaveBeenCalledOnce()
  })
})
