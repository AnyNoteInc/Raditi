import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getLandingViewer } from './landing-viewer'

const { getSession, rethrow } = vi.hoisted(() => ({
  getSession: vi.fn(),
  rethrow: vi.fn(),
}))
vi.mock('@/lib/session', () => ({ getSession }))
vi.mock('next/navigation', () => ({ unstable_rethrow: rethrow }))

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('public landing viewer', () => {
  it('returns a guest when the request has no session', async () => {
    getSession.mockResolvedValue(null)
    await expect(getLandingViewer()).resolves.toEqual({ status: 'guest', user: null })
  })

  it('exposes only display fields and never serializes account or session credentials', async () => {
    getSession.mockResolvedValue({
      session: { token: 'private-session-token', id: 'private-session-id' },
      user: {
        id: 'private-user-id',
        name: 'Анна',
        lastName: 'Иванова',
        email: 'anna@example.ru',
        image: '/avatar.png',
        emailVerified: true,
        createdAt: new Date(),
      },
    })

    expect(await getLandingViewer()).toEqual({
      status: 'authenticated',
      user: { name: 'Анна', lastName: 'Иванова', email: 'anna@example.ru', image: '/avatar.png' },
    })
  })

  it('keeps older accounts without a separate surname usable', async () => {
    getSession.mockResolvedValue({
      user: { name: 'Анна Иванова', email: 'anna@example.ru' },
    })

    await expect(getLandingViewer()).resolves.toEqual({
      status: 'authenticated',
      user: { name: 'Анна Иванова', lastName: null, email: 'anna@example.ru', image: null },
    })
  })

  it('keeps an unavailable session distinct from a signed-out visitor', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    getSession.mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(getLandingViewer()).resolves.toEqual({ status: 'unavailable', user: null })
    expect(report).toHaveBeenCalledWith('landing session unavailable: ECONNREFUSED')
  })

  it('preserves Next request-time rendering control flow', async () => {
    const bailout = new Error('NEXT_DYNAMIC_BAILOUT')
    getSession.mockRejectedValue(bailout)
    rethrow.mockImplementation((error: unknown) => {
      throw error
    })

    await expect(getLandingViewer()).rejects.toBe(bailout)
  })

  it('releases the public page after three seconds when the session lookup never settles', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    getSession.mockReturnValue(new Promise(() => {}))

    const viewer = getLandingViewer()
    await vi.advanceTimersByTimeAsync(3_000)

    await expect(viewer).resolves.toEqual({ status: 'unavailable', user: null })
    expect(vi.getTimerCount()).toBe(0)
  })
})
