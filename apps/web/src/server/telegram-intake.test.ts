import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { handleTelegramIntake, MAX_TELEGRAM_BODY_BYTES } = await import('./telegram-intake')

const SECRET = 's'.repeat(43)
const update = {
  update_id: 7,
  message: {
    message_id: 1,
    date: 1,
    chat: { id: 4, type: 'private' },
    from: { id: 4 },
    text: 'Привет',
  },
}

const post = (body: string, secret: string | null = SECRET) =>
  new Request('http://web/api/webhooks/telegram', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret }),
    },
    body,
  })

describe('handleTelegramIntake', () => {
  it('hands a checked update to the chat and answers 200', async () => {
    const handle = vi.fn(async () => 'done' as const)
    const response = await handleTelegramIntake(post(JSON.stringify(update)), {
      secret: SECRET,
      handle,
    })
    expect(response.status).toBe(200)
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ updateId: 7, kind: 'message' }))
  })

  it('refuses without the bot, without the secret, an oversize body and what is no update', async () => {
    const handle = vi.fn(async () => 'done' as const)
    expect((await handleTelegramIntake(post('{}'), { secret: null, handle })).status).toBe(404)
    expect((await handleTelegramIntake(post('{}', null), { secret: SECRET, handle })).status).toBe(
      401,
    )
    expect(
      (await handleTelegramIntake(post('{}', 'x'.repeat(43)), { secret: SECRET, handle })).status,
    ).toBe(401)
    expect(
      (
        await handleTelegramIntake(post('x'.repeat(MAX_TELEGRAM_BODY_BYTES + 1)), {
          secret: SECRET,
          handle,
        })
      ).status,
    ).toBe(413)
    expect((await handleTelegramIntake(post('not json'), { secret: SECRET, handle })).status).toBe(
      400,
    )
    expect(
      (await handleTelegramIntake(post('{"hello":1}'), { secret: SECRET, handle })).status,
    ).toBe(400)
    expect(handle).not.toHaveBeenCalled()
  })

  it('passes the topic core found gone, and only with the secret', async () => {
    const topicGone = vi.fn(async () => 'deleted')
    const body = JSON.stringify({ raditi_topic_gone: { chat_id: '42', thread_id: 9 } })
    const handle = vi.fn(async () => 'done' as const)
    expect(
      (await handleTelegramIntake(post(body), { secret: SECRET, handle, topicGone })).status,
    ).toBe(200)
    expect(topicGone).toHaveBeenCalledWith({ chatId: '42', threadId: 9 })
    expect(
      (await handleTelegramIntake(post(body, null), { secret: SECRET, handle, topicGone })).status,
    ).toBe(401)
    expect(handle).not.toHaveBeenCalled()
  })

  it('answers 503 when the chat fails, so core tries the update again, and logs no words', async () => {
    const logError = vi.fn()
    const response = await handleTelegramIntake(post(JSON.stringify(update)), {
      secret: SECRET,
      handle: async () => {
        throw new Error('Привет — words of the client')
      },
      logError,
    })
    expect(response.status).toBe(503)
    expect(logError).toHaveBeenCalledWith('[telegram] update 7 failed: Error')
  })
})
