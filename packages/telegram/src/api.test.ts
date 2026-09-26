import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const { proxyAgentConstructor, undiciFetch } = vi.hoisted(() => ({
  proxyAgentConstructor: vi.fn(function ProxyAgent() {}),
  undiciFetch: vi.fn(),
}))

vi.mock('undici', () => ({ ProxyAgent: proxyAgentConstructor, fetch: undiciFetch }))

import { createTelegramBotApi } from './api.ts'
import type { TelegramFetch } from './proxy.ts'

const TOKEN = '123456789:AAFakeTokenForTests_abcdefghij'

interface Captured {
  url: string
  init: (RequestInit & { dispatcher?: unknown }) | undefined
}

function capturingFetch(response: unknown, status = 200) {
  const calls: Captured[] = []
  const fetchFn: TelegramFetch = (url, init) => {
    calls.push({ url, init })
    return Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }
  return { calls, fetchFn }
}

const bodyOf = (call: Captured | undefined) => JSON.parse(String(call?.init?.body)) as unknown

const okJson = (result: unknown) =>
  new Response(JSON.stringify({ ok: true, result }), {
    headers: { 'content-type': 'application/json' },
  })

describe('transport and proxy', () => {
  beforeEach(() => {
    proxyAgentConstructor.mockClear()
    undiciFetch.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the global fetch without a dispatcher when no proxy is configured', async () => {
    const globalFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(okJson({ id: 1, is_bot: true, first_name: 'B' }))
    vi.stubGlobal('fetch', globalFetch)

    const res = await createTelegramBotApi({ token: TOKEN, proxyUrl: '' }).getMe()

    expect(res.ok).toBe(true)
    expect(globalFetch).toHaveBeenCalledTimes(1)
    expect(globalFetch.mock.calls[0]![1]).not.toHaveProperty('dispatcher')
    expect(proxyAgentConstructor).not.toHaveBeenCalled()
    expect(undiciFetch).not.toHaveBeenCalled()
  })

  it('goes through undici fetch with one ProxyAgent when a proxy is configured', async () => {
    const globalFetch = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', globalFetch)
    undiciFetch.mockResolvedValue(okJson({ id: 1, is_bot: true, first_name: 'B' }))

    const api = createTelegramBotApi({ token: TOKEN, proxyUrl: 'http://egress.internal:3128' })
    await api.getMe()
    await api.getMe()

    expect(proxyAgentConstructor).toHaveBeenCalledTimes(1)
    expect(proxyAgentConstructor).toHaveBeenCalledWith('http://egress.internal:3128/')
    expect(undiciFetch).toHaveBeenCalledTimes(2)
    const init = undiciFetch.mock.calls[0]![1] as { dispatcher?: unknown }
    expect(init.dispatcher).toBe(proxyAgentConstructor.mock.instances[0])
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('attaches the proxy dispatcher to an injected fetch as well', async () => {
    const { calls, fetchFn } = capturingFetch({ ok: true, result: true })

    await createTelegramBotApi({
      token: TOKEN,
      proxyUrl: 'http://egress.internal:3128',
      fetch: fetchFn,
    }).deleteWebhook()

    expect(calls[0]?.init?.dispatcher).toBe(proxyAgentConstructor.mock.instances[0])
  })

  it.each(['socks5h://127.0.0.1:9050', 'not a url'])(
    'refuses the proxy %j at construction without echoing it',
    (proxyUrl) => {
      let error: unknown
      try {
        createTelegramBotApi({ token: TOKEN, proxyUrl })
      } catch (err) {
        error = err
      }
      expect(error).toBeInstanceOf(TypeError)
      expect((error as Error).message).not.toContain(proxyUrl)
      expect(proxyAgentConstructor).not.toHaveBeenCalled()
    },
  )

  it('never echoes proxy credentials', () => {
    expect(() =>
      createTelegramBotApi({ token: TOKEN, proxyUrl: 'ftp://user:p4ss@proxy:21' }),
    ).toThrow(/^(?!.*p4ss).*$/)
  })

  it.each(['', 'abc', '123:abc/../../x', '123:abc?x=1'])(
    'refuses the malformed token %j',
    (token) => {
      expect(() => createTelegramBotApi({ token })).toThrow('Invalid Telegram bot token')
    },
  )
})

describe('URL composition', () => {
  it('builds {base}/bot{token}/{method} from an explicit base URL', async () => {
    const { calls, fetchFn } = capturingFetch({
      ok: true,
      result: { id: 1, is_bot: true, first_name: 'B' },
    })
    await createTelegramBotApi({
      token: TOKEN,
      fetch: fetchFn,
      baseUrl: 'https://tg.example/',
    }).getMe()
    expect(calls[0]?.url).toBe(`https://tg.example/bot${TOKEN}/getMe`)
  })

  it('defaults to https://api.telegram.org and POSTs JSON with a timeout', async () => {
    const { calls, fetchFn } = capturingFetch({ ok: true, result: true })
    await createTelegramBotApi({ token: TOKEN, fetch: fetchFn }).deleteWebhook()
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/deleteWebhook`)
    expect(calls[0]?.init?.method).toBe('POST')
    expect((calls[0]?.init?.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    )
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('refuses method names that could alter the path', async () => {
    const { calls, fetchFn } = capturingFetch({ ok: true, result: true })
    const res = await createTelegramBotApi({ token: TOKEN, fetch: fetchFn }).call(
      '../getMe',
      undefined,
      z.boolean(),
    )
    expect(res).toEqual({ ok: false, description: 'Invalid method name' })
    expect(calls).toHaveLength(0)
  })
})

describe('method bodies', () => {
  it('getMe sends no body and validates the result', async () => {
    const { calls, fetchFn } = capturingFetch({
      ok: true,
      result: { id: 7, is_bot: true, first_name: 'Радити', username: 'raditi_bot' },
    })
    const res = await createTelegramBotApi({ token: TOKEN, fetch: fetchFn }).getMe()
    expect(calls[0]?.init?.body).toBeUndefined()
    expect(res).toEqual({
      ok: true,
      result: { id: 7, is_bot: true, first_name: 'Радити', username: 'raditi_bot' },
    })
  })

  it('setWebhook sends url, secret_token and the default allowed_updates', async () => {
    const { calls, fetchFn } = capturingFetch({ ok: true, result: true })
    await createTelegramBotApi({ token: TOKEN, fetch: fetchFn }).setWebhook(
      'https://raditi.ru/api/webhooks/telegram',
      's3cret',
    )
    expect(bodyOf(calls[0])).toEqual({
      url: 'https://raditi.ru/api/webhooks/telegram',
      secret_token: 's3cret',
      allowed_updates: ['message', 'callback_query', 'my_chat_member'],
      drop_pending_updates: false,
    })
  })

  it('setWebhook accepts custom allowed_updates and dropping pending updates', async () => {
    const { calls, fetchFn } = capturingFetch({ ok: true, result: true })
    await createTelegramBotApi({ token: TOKEN, fetch: fetchFn }).setWebhook('https://x', 's', {
      allowedUpdates: ['message'],
      dropPendingUpdates: true,
    })
    expect(bodyOf(calls[0])).toMatchObject({
      allowed_updates: ['message'],
      drop_pending_updates: true,
    })
  })

  it('deleteWebhook sends no body unless asked to drop updates', async () => {
    const { calls, fetchFn } = capturingFetch({ ok: true, result: true })
    const api = createTelegramBotApi({ token: TOKEN, fetch: fetchFn })
    await api.deleteWebhook()
    await api.deleteWebhook({ dropPendingUpdates: true })
    expect(calls[0]?.init?.body).toBeUndefined()
    expect(bodyOf(calls[1])).toEqual({ drop_pending_updates: true })
  })

  it('getWebhookInfo validates the result', async () => {
    const { fetchFn } = capturingFetch({
      ok: true,
      result: {
        url: 'https://raditi.ru/api/webhooks/telegram',
        has_custom_certificate: false,
        pending_update_count: 2,
        last_error_date: 1_790_000_000,
        last_error_message: 'Connection timed out',
      },
    })
    const res = await createTelegramBotApi({ token: TOKEN, fetch: fetchFn }).getWebhookInfo()
    expect(res).toMatchObject({ ok: true, result: { pending_update_count: 2 } })
  })

  it('sendMessage sends plain text with link previews off by default', async () => {
    const { calls, fetchFn } = capturingFetch({ ok: true, result: { message_id: 9, date: 1 } })
    const res = await createTelegramBotApi({ token: TOKEN, fetch: fetchFn }).sendMessage(
      -100123,
      'Готово: заголовок на главной обновлён.',
    )
    expect(bodyOf(calls[0])).toEqual({
      chat_id: -100123,
      text: 'Готово: заголовок на главной обновлён.',
      link_preview_options: { is_disabled: true },
    })
    expect(res).toEqual({ ok: true, result: { message_id: 9 } })
  })

  it('sendMessage passes HTML mode, previews, a keyboard and a reply target', async () => {
    const { calls, fetchFn } = capturingFetch({ ok: true, result: { message_id: 10 } })
    await createTelegramBotApi({ token: TOKEN, fetch: fetchFn }).sendMessage('42', '<b>Да</b>', {
      parseMode: 'HTML',
      linkPreview: true,
      inlineKeyboard: [[{ text: 'Применить', callback_data: 'apply:t1' }]],
      replyToMessageId: 5,
    })
    expect(bodyOf(calls[0])).toEqual({
      chat_id: '42',
      text: '<b>Да</b>',
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: false },
      reply_markup: { inline_keyboard: [[{ text: 'Применить', callback_data: 'apply:t1' }]] },
      reply_parameters: { message_id: 5 },
    })
  })

  it.each(['', 'x'.repeat(4097)])('sendMessage refuses text of length %#', async (text) => {
    const { calls, fetchFn } = capturingFetch({ ok: true, result: { message_id: 1 } })
    const res = await createTelegramBotApi({ token: TOKEN, fetch: fetchFn }).sendMessage(1, text)
    expect(res.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe('error handling', () => {
  it('surfaces Telegram errors with the code', async () => {
    const { fetchFn } = capturingFetch(
      { ok: false, error_code: 401, description: 'Unauthorized' },
      401,
    )
    const res = await createTelegramBotApi({ token: TOKEN, fetch: fetchFn }).getMe()
    expect(res).toEqual({ ok: false, description: 'Unauthorized', errorCode: 401 })
  })

  it('surfaces retry_after on 429', async () => {
    const { fetchFn } = capturingFetch(
      {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 7',
        parameters: { retry_after: 7 },
      },
      429,
    )
    const res = await createTelegramBotApi({ token: TOKEN, fetch: fetchFn }).sendMessage(1, 'x')
    expect(res).toEqual({
      ok: false,
      description: 'Too Many Requests: retry after 7',
      errorCode: 429,
      retryAfterSec: 7,
    })
  })

  it('falls back to the HTTP status when there is no description', async () => {
    const { fetchFn } = capturingFetch({ ok: false }, 502)
    const res = await createTelegramBotApi({ token: TOKEN, fetch: fetchFn }).getMe()
    expect(res).toEqual({ ok: false, description: 'HTTP 502', errorCode: 502 })
  })

  it('never includes the token in errors, even when fetch puts the URL in its message', async () => {
    const fetchFn: TelegramFetch = (url) => Promise.reject(new Error(`request to ${url} failed`))
    const res = await createTelegramBotApi({ token: TOKEN, fetch: fetchFn }).sendMessage('1', 'x')
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).not.toContain(TOKEN)
    expect(JSON.stringify(res)).not.toContain('bot123456789')
  })

  it('times out and reports TimeoutError without the token', async () => {
    const hanging: TelegramFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error))
      })
    const res = await createTelegramBotApi({ token: TOKEN, fetch: hanging, timeoutMs: 20 }).getMe()
    expect(res).toEqual({ ok: false, description: 'TimeoutError' })
  })

  it('returns the HTTP status for a non-JSON body without leaking it', async () => {
    const fetchFn: TelegramFetch = () =>
      Promise.resolve(new Response('<html>Forbidden</html>', { status: 403 }))
    const res = await createTelegramBotApi({ token: TOKEN, fetch: fetchFn }).sendMessage('1', 'x')
    expect(res).toEqual({ ok: false, description: 'HTTP 403', errorCode: 403 })
  })

  it('rejects a successful response of the wrong shape', async () => {
    const { fetchFn } = capturingFetch({ ok: true, result: { id: 'not-a-number' } })
    const res = await createTelegramBotApi({ token: TOKEN, fetch: fetchFn }).getMe()
    expect(res).toEqual({ ok: false, description: 'Unexpected Telegram response' })
  })
})
