import { recordOriFact } from '@repo/db'
import { describe, expect, it } from 'vitest'

import { ORI_FACT_HEADER, withOriFactHeader } from './ori-fact-header'

// The edge keeps the client's port of a fact by this header (docs/plan/88-artifacts.md, 88.16а-2).

const written: unknown[][] = []
const tx = {
  $executeRaw: async (...args: unknown[]) => {
    written.push(args)
    return 1
  },
} as unknown as Parameters<typeof recordOriFact>[0]
const fact = () => recordOriFact(tx, { kind: 'sign_in', userId: null })
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('the header of the facts of a request', () => {
  it('names the random keys of the facts the request wrote, never their ids', async () => {
    const handler = withOriFactHeader(async () => {
      await fact()
      await fact()
      return new Response('ok', { headers: { 'set-cookie': 'a=1' } })
    })
    const answer = await handler(new Request('https://raditi.test/api/auth/sign-in'))
    const keys = answer.headers.get(ORI_FACT_HEADER)!.split(',')
    expect(keys).toHaveLength(2)
    for (const key of keys) expect(key).toMatch(uuid)
    expect(answer.headers.get('set-cookie')).toBe('a=1')
    expect(await answer.text()).toBe('ok')
  })

  it('leaves an answer without a fact untouched, and a redirect keeps its place', async () => {
    const plain = await withOriFactHeader(async () => new Response('ok'))(
      new Request('https://raditi.test/api/trpc/x'),
    )
    expect(plain.headers.has(ORI_FACT_HEADER)).toBe(false)
    const moved = await withOriFactHeader(async () => {
      await fact()
      return Response.redirect('https://raditi.test/chats', 302)
    })(new Request('https://raditi.test/api/auth/callback'))
    expect(moved.status).toBe(302)
    expect(moved.headers.get('location')).toBe('https://raditi.test/chats')
    expect(moved.headers.get(ORI_FACT_HEADER)).toMatch(uuid)
  })

  it('gives no key to a payment applied while a client comes back from the shop', async () => {
    const answer = await withOriFactHeader(async () => {
      await recordOriFact(tx, { kind: 'payment', userId: null })
      return new Response('ok')
    })(new Request('https://raditi.test/api/trpc/billing.syncOrder'))
    expect(answer.headers.has(ORI_FACT_HEADER)).toBe(false)
  })

  it('gives no key to a fact written outside a request of web', async () => {
    written.length = 0
    await fact()
    expect(written[0]!.at(-1)).toBeNull()
  })
})
