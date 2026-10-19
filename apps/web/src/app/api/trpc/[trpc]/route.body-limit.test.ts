import { legalDocuments } from '@repo/domain'
import type * as TrpcModule from '@repo/trpc'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MAX_TRPC_BODY_BYTES } from '@/server/body-limit'
import { MAX_BATCH_SIZE } from '@/trpc/batch'

const ORIGIN = 'https://raditi.ru'
const USER_ID = '0199a000-0000-7000-8000-000000000001'

// The real router of @repo/trpc; only the session and the database are local.
const { state } = vi.hoisted(() => ({
  state: { signedIn: true, updates: [] as { name: string; lastName: string | null }[] },
}))
vi.mock('@repo/trpc', async (importOriginal) => {
  const original = await importOriginal<typeof TrpcModule>()
  const { legalDocuments: documents } = await import('@repo/domain')
  const accepted = documents.flatMap((document) =>
    document.required && document.consentType
      ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
      : [],
  )
  const user = { id: USER_ID, email: 'owner@example.ru', name: 'Анна', emailVerified: true }
  const prisma = {
    userConsent: { findMany: async () => accepted },
    user: {
      update: async ({ data }: { data: { name: string; lastName: string | null } }) => {
        state.updates.push(data)
        return { id: USER_ID, email: user.email, image: null, ...data }
      },
    },
  }
  return {
    ...original,
    createContext: async ({ headers }: { headers: Headers }) => ({
      prisma,
      headers,
      session: state.signedIn ? { id: 'session' } : null,
      user: state.signedIn ? user : null,
      billing: null,
    }),
  }
})
// The shop settings are read from the environment, which this test does not set.
vi.mock('@/server/payment-shop', () => ({ paymentShop: () => null }))
vi.mock('@/server/chat-services', () => ({ chatServices: () => null }))
vi.mock('@/server/site-connections', () => ({ siteConnections: () => null }))

const { POST } = await import('./route')

const MIB = 1024 * 1024

/** An updateProfile input of `megabytes`, produced lazily; counts what the server pulled. */
function hugeBody(megabytes: number) {
  const encoder = new TextEncoder()
  const chunk = new Uint8Array(MIB).fill(0x61)
  let pulled = 0
  let stage: 'open' | 'fill' | 'done' = 'open'
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stage === 'open') {
        stage = 'fill'
        controller.enqueue(encoder.encode('{"json":{"name":"'))
      } else if (pulled < megabytes) {
        pulled += 1
        controller.enqueue(chunk)
      } else if (stage === 'fill') {
        stage = 'done'
        controller.enqueue(encoder.encode('","lastName":""}}'))
      } else controller.close()
    },
  })
  return { stream, pulled: () => pulled }
}

const post = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/trpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    duplex: 'half',
  } as RequestInit)

beforeEach(() => {
  state.signedIn = true
  state.updates = []
})

describe('tRPC route: request body limit', () => {
  it('has a document every signed-in user must accept, so the consent check is real', () => {
    expect(legalDocuments.some((document) => document.required && document.consentType)).toBe(true)
  })

  it.each([true, false])(
    'stops reading an 8 MiB body sent to user.updateProfile (signed in: %s)',
    async (signedIn) => {
      state.signedIn = signedIn
      const body = hugeBody(8)

      const response = await POST(post('user.updateProfile', body.stream))

      expect(response.status).toBe(413)
      expect(await response.json()).toEqual({ message: 'Запрос слишком большой.' })
      // The limit plus the chunk that crossed it, and one the stream prepared ahead.
      expect(body.pulled()).toBeLessThanOrEqual(2)
      expect(state.updates).toEqual([])
    },
  )

  it('refuses a declared oversize body before reading it', async () => {
    const request = post('user.updateProfile', '{}', {
      'content-length': String(MAX_TRPC_BODY_BYTES + 1),
    })
    expect((await POST(request)).status).toBe(413)
    expect(request.bodyUsed).toBe(false)
  })

  it('serves a full batch of mutations as before', async () => {
    const calls = Array.from({ length: MAX_BATCH_SIZE }, (_, index) => `Анна ${index}`)
    const body = JSON.stringify(
      Object.fromEntries(calls.map((name, index) => [index, { json: { name, lastName: '' } }])),
    )

    const response = await POST(
      post(`${calls.map(() => 'user.updateProfile').join(',')}?batch=1`, body),
    )

    expect(response.status).toBe(200)
    const results = (await response.json()) as { result: { data: { json: { name: string } } } }[]
    expect(results.map((entry) => entry.result.data.json.name)).toEqual(calls)
    expect(state.updates).toEqual(calls.map((name) => ({ name, lastName: null })))
  })

  it('takes a body of exactly the limit to the router', async () => {
    const envelope = Buffer.byteLength(JSON.stringify({ json: { name: '', lastName: '' } }))
    const body = JSON.stringify({
      json: { name: 'a'.repeat(MAX_TRPC_BODY_BYTES - envelope), lastName: '' },
    })
    expect(Buffer.byteLength(body)).toBe(MAX_TRPC_BODY_BYTES)

    const response = await POST(post('user.updateProfile', body))

    // The name is longer than 255 characters: the input check of the procedure answered.
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { json: { data: { code: 'BAD_REQUEST' } } },
    })
  })
})
