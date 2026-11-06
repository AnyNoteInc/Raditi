import { beforeEach, describe, expect, it, vi } from 'vitest'

import { UNAVAILABLE } from '@/lib/access'

import OnboardingConsentsPage from './page'

const { hasRequiredConsents, requireSession, redirect } = vi.hoisted(() => ({
  hasRequiredConsents: vi.fn(),
  requireSession: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect ${path}`)
  }),
}))

vi.mock('next/navigation', () => ({ redirect }))
vi.mock('@/lib/access', () => ({
  UNAVAILABLE: Symbol('unavailable'),
  hasRequiredConsents,
  requireSession,
}))
vi.mock('@/lib/legal', () => ({ consentDocumentLinks: () => ({}) }))
vi.mock('./consents-form', () => ({ ConsentsForm: () => null }))
vi.mock('./auto-renewal-notice', () => ({ AutoRenewalNotice: () => null }))

describe('OnboardingConsentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireSession.mockResolvedValue({ user: { id: 'user' } })
  })

  it('sends a user who has accepted everything to the chats', async () => {
    hasRequiredConsents.mockResolvedValue(true)

    await expect(OnboardingConsentsPage()).rejects.toThrow('redirect /chats')
  })

  it('asks a user who has not accepted, and leads nowhere', async () => {
    hasRequiredConsents.mockResolvedValue(false)

    await expect(OnboardingConsentsPage()).resolves.toBeTruthy()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('leads nowhere when the consents cannot be read', async () => {
    hasRequiredConsents.mockResolvedValue(UNAVAILABLE)

    await expect(OnboardingConsentsPage()).resolves.toBeTruthy()
    expect(redirect).not.toHaveBeenCalled()
  })
})
