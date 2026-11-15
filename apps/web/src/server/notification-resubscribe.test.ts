import { TRPCError } from '@trpc/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { handleResubscribe, MAX_RESUBSCRIBE_BODY_BYTES } = await import('./notification-resubscribe')

const APP = 'https://raditi.ru'
const change = {
  oldEndpoint: 'https://fcm.googleapis.com/fcm/send/old',
  endpoint: 'https://fcm.googleapis.com/fcm/send/new',
  p256dh: 'B'.repeat(87),
  auth: 'a'.repeat(22),
}

const post = (body: string, headers: Record<string, string> = { origin: APP }) =>
  new Request(`${APP}/api/notifications/resubscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })

describe('handleResubscribe (docs/plan/82, Зп41)', () => {
  it('hands the change to the procedure with the headers of the request', async () => {
    const resubscribe = vi.fn(async () => ({ resubscribed: true }))
    const request = post(JSON.stringify(change))
    const response = await handleResubscribe(request, { appUrl: () => APP, resubscribe })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(resubscribe).toHaveBeenCalledWith(request.headers, change)
  })

  it('refuses another origin, a large body and what is not JSON before the procedure', async () => {
    const resubscribe = vi.fn(async () => ({ resubscribed: true }))
    const route = { appUrl: () => APP, resubscribe }
    const body = JSON.stringify(change)
    expect(
      (await handleResubscribe(post(body, { origin: 'https://evil.example' }), route)).status,
    ).toBe(403)
    expect(
      (await handleResubscribe(post(body, { 'sec-fetch-site': 'cross-site' }), route)).status,
    ).toBe(403)
    expect(
      (await handleResubscribe(post('x'.repeat(MAX_RESUBSCRIBE_BODY_BYTES + 1)), route)).status,
    ).toBe(413)
    expect((await handleResubscribe(post('not json'), route)).status).toBe(400)
    expect(resubscribe).not.toHaveBeenCalled()
  })

  it('tells a missing session, documents to accept and a bad subscription by their status', async () => {
    const answer = async (code: TRPCError['code']) =>
      (
        await handleResubscribe(post(JSON.stringify(change)), {
          appUrl: () => APP,
          resubscribe: async () => {
            throw new TRPCError({ code })
          },
        })
      ).status
    expect(await answer('UNAUTHORIZED')).toBe(401)
    expect(await answer('PRECONDITION_REQUIRED')).toBe(428)
    expect(await answer('BAD_REQUEST')).toBe(400)
    expect(await answer('INTERNAL_SERVER_ERROR')).toBe(503)
  })
})
