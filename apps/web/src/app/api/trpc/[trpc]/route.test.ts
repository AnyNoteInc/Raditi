import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MAX_BATCH_SIZE } from '@/trpc/batch'

// The route with a router of the test; the shop of the process is replaced, and the context
// records what the route builds it from.
const stand = vi.hoisted(() => ({
  shop: { name: 'the shop of the process' } as object | null,
  chat: { name: 'the dialog services of the process' } as object | null,
  contexts: [] as unknown[],
  shopFailure: new Error('YooKassa request timed out'),
}))

vi.mock('@/server/payment-shop', () => ({ paymentShop: () => stand.shop }))
vi.mock('@/server/chat-services', () => ({ chatServices: () => stand.chat }))
vi.mock('@repo/trpc', async () => {
  const { initTRPC, TRPCError } = await import('@trpc/server')
  const t = initTRPC.create()
  return {
    appRouter: t.router({
      ping: t.procedure.query(() => 'pong'),
      crash: t.procedure.query(() => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432')
      }),
      // What @repo/trpc makes of a DomainError: the refusal is the cause of the tRPC error.
      refused: t.procedure.query(() => {
        throw new TRPCError({
          code: 'CONFLICT',
          cause: new Error('The workspace already has a live subscription'),
        })
      }),
      shopDown: t.procedure.query(() => {
        throw new TRPCError({
          code: 'SERVICE_UNAVAILABLE',
          cause: new Error('Payments are not configured', { cause: stand.shopFailure }),
        })
      }),
    }),
    createContext: async (options: unknown) => {
      stand.contexts.push(options)
      return {}
    },
  }
})

const { GET } = await import('./route')

const call = (path: string) => GET(new Request(`http://localhost/api/trpc/${path}`))
const batch = (size: number) =>
  call(`${Array.from({ length: size }, () => 'ping').join(',')}?batch=1`)

describe('tRPC route', () => {
  let error: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    stand.shop = { name: 'the shop of the process' }
    stand.contexts = []
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    error.mockRestore()
  })

  it('serves a batch up to the limit of the client link', async () => {
    const response = await batch(MAX_BATCH_SIZE)
    expect(response.status).toBe(200)
    expect(await response.json()).toHaveLength(MAX_BATCH_SIZE)
  })

  it('refuses a larger batch before running any procedure', async () => {
    const response = await batch(MAX_BATCH_SIZE + 1)
    expect(response.status).toBe(400)
  })

  it('keeps the limit small enough that one request cannot queue hundreds of mutations', () => {
    expect(MAX_BATCH_SIZE).toBeLessThanOrEqual(10)
  })

  it('builds the context from the request headers and the shop of the process', async () => {
    const request = new Request('http://localhost/api/trpc/ping', { headers: { cookie: 'a=1' } })

    expect((await GET(request)).status).toBe(200)

    expect(stand.contexts).toEqual([
      { headers: request.headers, billing: stand.shop, chat: stand.chat },
    ])
    expect((stand.contexts[0] as { billing: unknown }).billing).toBe(stand.shop)
    expect((stand.contexts[0] as { chat: unknown }).chat).toBe(stand.chat)
  })

  it('builds the context without a shop while payments are off', async () => {
    stand.shop = null

    expect((await call('ping')).status).toBe(200)

    expect(stand.contexts).toEqual([
      { headers: expect.any(Headers), billing: null, chat: stand.chat },
    ])
  })

  it('logs an unexpected failure with its cause', async () => {
    expect((await call('crash')).status).toBe(500)

    expect(error.mock.calls).toEqual([
      [
        '[trpc] query crash failed',
        expect.objectContaining({ message: 'connect ECONNREFUSED 10.0.0.5:5432' }),
      ],
    ])
  })

  it('does not log a refusal the client caused', async () => {
    expect((await call('refused')).status).toBe(409)
    expect((await call('nothing.here')).status).toBe(404)

    expect(error).not.toHaveBeenCalled()
  })

  it('logs the failure a refusal was made of: the payment shop that did not answer', async () => {
    expect((await call('shopDown')).status).toBe(503)

    expect(error.mock.calls).toEqual([['[trpc] query shopDown failed', stand.shopFailure]])
  })
})
