import { beforeEach, describe, expect, it, vi } from 'vitest'

// The caller of Server Components with everything around it replaced: the test sees the
// context it hands to the router.
const stand = vi.hoisted(() => ({
  shop: { name: 'the shop of the process' } as object | null,
  prisma: { name: 'the database client of the process' },
  headers: new Headers({ cookie: 'a=1' }),
  current: null as { session: object; user: object } | null,
  caller: { name: 'the caller of the router' },
  createCaller: vi.fn(),
}))

vi.mock('@/server/payment-shop', () => ({ paymentShop: () => stand.shop }))
vi.mock('@/lib/session', () => ({
  getRequestHeaders: () => Promise.resolve(stand.headers),
  getSession: () => Promise.resolve(stand.current),
}))
vi.mock('@repo/db', () => ({ prisma: stand.prisma }))
vi.mock('@repo/trpc', () => ({ createCaller: stand.createCaller }))

/** A new module for every test: what React's cache() remembers does not pass between them. */
const serverCaller = async () => (await import('./server')).getServerCaller()

describe('the tRPC caller of Server Components', () => {
  beforeEach(() => {
    vi.resetModules()
    stand.shop = { name: 'the shop of the process' }
    stand.current = null
    stand.createCaller.mockReset().mockReturnValue(stand.caller)
  })

  it('hands the router the shop of the process', async () => {
    await expect(serverCaller()).resolves.toBe(stand.caller)

    expect(stand.createCaller).toHaveBeenCalledExactlyOnceWith({
      prisma: stand.prisma,
      headers: stand.headers,
      session: null,
      user: null,
      billing: stand.shop,
    })
    const [context] = stand.createCaller.mock.calls[0] as [{ billing: unknown }]
    expect(context.billing).toBe(stand.shop)
  })

  it('hands the router no shop while payments are off', async () => {
    stand.shop = null

    await serverCaller()

    expect(stand.createCaller).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ billing: null }),
    )
  })

  it('reuses the session the layout has looked up', async () => {
    stand.current = { session: { id: 'session-1' }, user: { id: 'user-1' } }

    await serverCaller()

    const [context] = stand.createCaller.mock.calls[0] as [{ session: unknown; user: unknown }]
    expect(context.session).toBe(stand.current.session)
    expect(context.user).toBe(stand.current.user)
  })
})
