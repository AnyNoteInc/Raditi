import { beforeEach, describe, expect, it, vi } from 'vitest'

import { redirectIfSignedIn } from './auth-redirect'

const { getSession, redirect } = vi.hoisted(() => ({
  getSession: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`)
  }),
}))

vi.mock('./session', () => ({ getSession }))
vi.mock('next/navigation', () => ({ redirect, unstable_rethrow: () => {} }))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('redirectIfSignedIn', () => {
  it('lets a signed-out visitor see the page', async () => {
    getSession.mockResolvedValue(null)
    await expect(redirectIfSignedIn('/app/tasks')).resolves.toBeUndefined()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('sends a signed-in user to the given target, projects by default', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } })
    await expect(redirectIfSignedIn('/app/tasks')).rejects.toThrow('NEXT_REDIRECT /app/tasks')
    await expect(redirectIfSignedIn()).rejects.toThrow('NEXT_REDIRECT /projects')
  })

  it('still shows the page when the session cannot be looked up', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    getSession.mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(redirectIfSignedIn()).resolves.toBeUndefined()
    expect(redirect).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith('[auth] session lookup failed: ECONNREFUSED')
    error.mockRestore()
  })
})
