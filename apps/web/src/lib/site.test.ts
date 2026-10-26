import type * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const id = '0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  setup: vi.fn(),
  session: vi.fn(),
}))

/** Next ends the render by throwing; the test tells the two endings apart by the message. */
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND')
  },
  redirect: (href: string) => {
    throw new Error(`REDIRECT ${href}`)
  },
  unstable_rethrow: (error: unknown) => {
    if (error instanceof Error && /^(NOT_FOUND|REDIRECT)/.test(error.message)) throw error
  },
}))
// The lookup is cached per request; a test has no request, so every call reads anew.
vi.mock('react', async (original) => ({
  ...(await original<typeof React>()),
  cache: <T>(fn: T) => fn,
}))
vi.mock('@/trpc/server', () => ({
  getServerCaller: async () => ({
    project: { get: mocks.get },
    siteConnection: { setup: mocks.setup },
  }),
}))
vi.mock('./access', () => ({ UNAVAILABLE: 'unavailable', requireSession: mocks.session }))

const { loadSiteSection, loadSiteSetup } = await import('./site')

const site = (status: string, setup: string | null = null) => ({
  id,
  name: 'Кофейня',
  url: 'https://kroshka.example',
  status,
  setup,
})

beforeEach(() => {
  mocks.get.mockReset()
  mocks.setup.mockReset()
  mocks.session.mockReset().mockResolvedValue({ user: { id: 'user' } })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('the site of a section page', () => {
  it.each(['paused', 'disconnected', 'archived'])(
    'sends a %s site from every other section to the overview',
    async (status) => {
      mocks.get.mockResolvedValue(site(status))
      for (const section of ['chat', 'changes', 'runs', 'database', 'vault', 'settings'] as const) {
        await expect(loadSiteSection(id, section)).rejects.toThrow(
          `REDIRECT /projects/${id}/overview`,
        )
      }
      await expect(loadSiteSection(id, 'overview')).resolves.toMatchObject({ status })
    },
  )

  it.each(['onboarding', 'active'])('opens every section of a %s site', async (status) => {
    mocks.get.mockResolvedValue(site(status))
    for (const section of [
      'chat',
      'overview',
      'changes',
      'runs',
      'database',
      'vault',
      'settings',
    ] as const) {
      await expect(loadSiteSection(id, section)).resolves.toMatchObject({ id, status })
    }
  })

  it.each(['pending', 'failed'])(
    'sends every other section of a site whose setup is %s to the overview',
    async (setup) => {
      mocks.get.mockResolvedValue(site('onboarding', setup))
      for (const section of ['chat', 'changes', 'runs', 'database', 'vault', 'settings'] as const) {
        await expect(loadSiteSection(id, section)).rejects.toThrow(
          `REDIRECT /projects/${id}/overview`,
        )
      }
      await expect(loadSiteSection(id, 'overview')).resolves.toMatchObject({ setup })
    },
  )

  it('opens every section of a site whose setup is done', async () => {
    mocks.get.mockResolvedValue(site('onboarding', 'done'))
    for (const section of ['chat', 'changes', 'runs', 'database', 'vault', 'settings'] as const) {
      await expect(loadSiteSection(id, section)).resolves.toMatchObject({ setup: 'done' })
    }
  })

  it('answers «not found» for a site of someone else before it looks at the setup', async () => {
    mocks.get.mockRejectedValue(Object.assign(new Error('no site'), { code: 'NOT_FOUND' }))
    await expect(loadSiteSection(id, 'settings')).rejects.toThrow('NOT_FOUND')
  })

  it('redirects to the address of the stored id, not of the one in the request', async () => {
    mocks.get.mockResolvedValue(site('paused'))
    await expect(loadSiteSection(id.toUpperCase(), 'chat')).rejects.toThrow(
      `REDIRECT /projects/${id}/overview`,
    )
  })

  it('answers «not found» for a site of someone else before it looks at the status', async () => {
    mocks.get.mockRejectedValue(Object.assign(new Error('no site'), { code: 'NOT_FOUND' }))
    await expect(loadSiteSection(id, 'chat')).rejects.toThrow('NOT_FOUND')
  })

  it('answers «not found» for an address that is not an id without a lookup', async () => {
    await expect(loadSiteSection('not-an-id', 'settings')).rejects.toThrow('NOT_FOUND')
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it('passes on that the site could not be read instead of redirecting', async () => {
    mocks.get.mockRejectedValue(new Error('database is down'))
    await expect(loadSiteSection(id, 'chat')).resolves.toBe('unavailable')
    mocks.session.mockResolvedValue('unavailable')
    await expect(loadSiteSection(id, 'chat')).resolves.toBe('unavailable')
  })
})

describe('the setup of a site for its screen', () => {
  it('reads it for the page', async () => {
    mocks.setup.mockResolvedValue({ state: 'pending' })
    await expect(loadSiteSetup(id)).resolves.toEqual({ state: 'pending' })
    expect(mocks.setup).toHaveBeenCalledWith({ id })
  })

  it('leaves it to the screen when it cannot be read', async () => {
    mocks.setup.mockRejectedValue(new Error('database is down'))
    await expect(loadSiteSetup(id)).resolves.toBeNull()
    expect(console.error).toHaveBeenCalledWith('[web] site setup lookup failed: database is down')
  })
})
