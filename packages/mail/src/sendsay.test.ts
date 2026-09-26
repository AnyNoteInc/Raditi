import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSendsayTransport, type SendsayClient } from './sendsay.ts'
import { MailDeliveryError, type OutgoingEmail } from './transport.ts'

const email: OutgoingEmail = {
  from: { email: 'noreply@raditi.ru', name: 'Радити' },
  to: 'owner@example.ru',
  subject: 'Подтвердите адрес почты',
  html: '<p>Здравствуйте!</p>',
  text: 'Здравствуйте!',
}

function fakeClient(request: SendsayClient['request']) {
  const client = { request: vi.fn(request) }
  return { client, transport: createSendsayTransport({ apiKey: 'test-key' }, client) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SendSay transport', () => {
  it('sends one transactional issue.send request', async () => {
    const { client, transport } = fakeClient(() => Promise.resolve({ 'track.id': '1' }))

    await transport.send(email)

    expect(client.request).toHaveBeenCalledExactlyOnceWith({
      action: 'issue.send',
      sendwhen: 'now',
      letter: {
        subject: 'Подтвердите адрес почты',
        'from.name': 'Радити',
        'from.email': 'noreply@raditi.ru',
        message: { html: '<p>Здравствуйте!</p>', text: 'Здравствуйте!' },
      },
      'users.list': 'owner@example.ru',
      group: 'personal',
    })
  })

  it('turns a SendSay error object into MailDeliveryError without the request', async () => {
    const { transport } = fakeClient(() =>
      Promise.reject({ id: 'error/email/invalid', explain: 'bad address', request: { secret: 1 } }),
    )

    const error = await transport.send(email).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(MailDeliveryError)
    expect(error).toMatchObject({ code: 'error/email/invalid' })
    expect((error as Error).message).toContain('bad address')
    expect((error as Error).message).not.toContain('secret')
  })

  it('fails on an error envelope in the response', async () => {
    const { transport } = fakeClient(() =>
      Promise.resolve({ errors: [{ id: 'error/auth/failed', explain: 'wrong key' }] }),
    )

    await expect(transport.send(email)).rejects.toMatchObject({ code: 'error/auth/failed' })
  })

  it('wraps network errors', async () => {
    const { transport } = fakeClient(() => Promise.reject(new TypeError('fetch failed')))

    await expect(transport.send(email)).rejects.toMatchObject({
      name: 'MailDeliveryError',
      code: 'network',
    })
  })

  it('gives up when SendSay does not answer in time', async () => {
    vi.useFakeTimers()
    const client = { request: vi.fn(() => new Promise<unknown>(() => {})) }
    const transport = createSendsayTransport({ apiKey: 'test-key', timeoutMs: 1000 }, client)

    const sending = transport.send(email).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1000)

    expect(await sending).toMatchObject({ code: 'timeout' })
  })
})
