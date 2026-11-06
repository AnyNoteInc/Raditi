import type * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const id = '0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  session: vi.fn(),
}))

/** Next ends the render by throwing; the test tells the endings apart by the message. */
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND')
  },
  unstable_rethrow: (error: unknown) => {
    if (error instanceof Error && error.message === 'NOT_FOUND') throw error
  },
}))
// The lookup is cached per request; a test has no request, so every call reads anew.
vi.mock('react', async (original) => ({
  ...(await original<typeof React>()),
  cache: <T>(fn: T) => fn,
}))
vi.mock('@/trpc/server', () => ({
  getServerCaller: async () => ({ task: { get: mocks.get } }),
}))
vi.mock('@/lib/access', () => ({ UNAVAILABLE: 'unavailable', requireSession: mocks.session }))

const { loadChat } = await import('./load-chat')

const failure = (code: string) => Object.assign(new Error('refused'), { code })

beforeEach(() => {
  mocks.get.mockReset()
  mocks.session.mockReset().mockResolvedValue({ user: { id: 'user' } })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('the chat of a page', () => {
  it('reads the chat by the address', async () => {
    mocks.get.mockResolvedValue({ id, project: null })
    await expect(loadChat(id)).resolves.toEqual({ id, project: null })
    expect(mocks.get).toHaveBeenCalledWith({ taskId: id })
  })

  it.each([
    ['of someone else or none at all', 'NOT_FOUND'],
    ['in the form of an id, but no id for the server', 'BAD_REQUEST'],
  ])('answers «not found» for a chat %s', async (_case, code) => {
    mocks.get.mockRejectedValue(failure(code))
    await expect(loadChat(id)).rejects.toThrow('NOT_FOUND')
  })

  it('says a failure of the server as one, not as a chat that is not there', async () => {
    mocks.get.mockRejectedValue(failure('INTERNAL_SERVER_ERROR'))
    await expect(loadChat(id)).resolves.toBe('unavailable')
  })

  it('asks nothing when the session cannot be read', async () => {
    mocks.session.mockResolvedValue('unavailable')
    await expect(loadChat(id)).resolves.toBe('unavailable')
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it('answers «not found» for an address that is no id, without a request', async () => {
    await expect(loadChat('not-an-id')).rejects.toThrow('NOT_FOUND')
    expect(mocks.get).not.toHaveBeenCalled()
  })
})
