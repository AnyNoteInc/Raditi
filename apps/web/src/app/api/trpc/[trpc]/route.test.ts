import { describe, expect, it, vi } from 'vitest'

import { MAX_BATCH_SIZE } from '@/trpc/batch'

vi.mock('@repo/trpc', async () => {
  const { initTRPC } = await import('@trpc/server')
  const t = initTRPC.create()
  return {
    appRouter: t.router({ ping: t.procedure.query(() => 'pong') }),
    createContext: async () => ({}),
  }
})

const { GET } = await import('./route')

const batch = (size: number) =>
  GET(
    new Request(
      `http://localhost/api/trpc/${Array.from({ length: size }, () => 'ping').join(',')}?batch=1`,
    ),
  )

describe('tRPC route', () => {
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
})
