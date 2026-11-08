import { describe, expect, it } from 'vitest'

import { leadsTelegramConfigFromEnv, telegramConfigFromEnv } from './config.ts'

const TOKEN = '123456789:AAFakeTokenForTests_abcdefghij'
const SECRET = 'a'.repeat(43)

describe('telegramConfigFromEnv', () => {
  it('returns null when the bot is off, as in .env.example', () => {
    expect(
      telegramConfigFromEnv({
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_WEBHOOK_SECRET: '',
        TELEGRAM_PROXY_URL: '',
      }),
    ).toBeNull()
  })

  it('reads token, webhook secret and proxy', () => {
    expect(
      telegramConfigFromEnv({
        TELEGRAM_BOT_TOKEN: TOKEN,
        TELEGRAM_WEBHOOK_SECRET: SECRET,
        TELEGRAM_PROXY_URL: 'http://egress.internal:3128',
      }),
    ).toEqual({ botToken: TOKEN, webhookSecret: SECRET, proxyUrl: 'http://egress.internal:3128' })
  })

  it('leaves the proxy undefined when unset', () => {
    expect(
      telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET })
        ?.proxyUrl,
    ).toBeUndefined()
  })

  it('requires a webhook secret when the bot is on', () => {
    expect(() => telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN })).toThrow(
      /TELEGRAM_WEBHOOK_SECRET/,
    )
  })

  it.each(['short', 'a'.repeat(257), `${'a'.repeat(40)}!`])(
    'rejects the weak or malformed webhook secret %#',
    (secret) => {
      expect(() =>
        telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: secret }),
      ).toThrow(/TELEGRAM_WEBHOOK_SECRET/)
    },
  )

  it('rejects a malformed token and a non-http proxy without echoing values', () => {
    let message = ''
    try {
      telegramConfigFromEnv({
        TELEGRAM_BOT_TOKEN: 'secret-token-value',
        TELEGRAM_WEBHOOK_SECRET: SECRET,
        TELEGRAM_PROXY_URL: 'socks5://user:p4ss@proxy:1080',
      })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('TELEGRAM_BOT_TOKEN')
    expect(message).toContain('TELEGRAM_PROXY_URL')
    expect(message).not.toContain('secret-token-value')
    expect(message).not.toContain('p4ss')
  })
})

describe('leadsTelegramConfigFromEnv', () => {
  it('returns null when the bot of leads is off', () => {
    expect(
      leadsTelegramConfigFromEnv({ LEADS_TELEGRAM_BOT_TOKEN: '', LEADS_TELEGRAM_CHAT_ID: '' }),
    ).toBeNull()
  })

  it('reads the token, the group and the proxy', () => {
    expect(
      leadsTelegramConfigFromEnv({
        LEADS_TELEGRAM_BOT_TOKEN: TOKEN,
        LEADS_TELEGRAM_CHAT_ID: '-1001234567890',
        TELEGRAM_PROXY_URL: 'http://egress.internal:3128',
      }),
    ).toEqual({
      botToken: TOKEN,
      chatId: '-1001234567890',
      proxyUrl: 'http://egress.internal:3128',
    })
  })

  it('wants both variables or neither', () => {
    expect(() => leadsTelegramConfigFromEnv({ LEADS_TELEGRAM_BOT_TOKEN: TOKEN })).toThrow(
      /LEADS_TELEGRAM_CHAT_ID/,
    )
    expect(() => leadsTelegramConfigFromEnv({ LEADS_TELEGRAM_CHAT_ID: '-100' })).toThrow(
      /LEADS_TELEGRAM_BOT_TOKEN/,
    )
  })

  it('takes only a group, never a private chat or a public name', () => {
    for (const chat of ['12345', '@raditi_leads']) {
      expect(() =>
        leadsTelegramConfigFromEnv({
          LEADS_TELEGRAM_BOT_TOKEN: TOKEN,
          LEADS_TELEGRAM_CHAT_ID: chat,
        }),
      ).toThrow(/LEADS_TELEGRAM_CHAT_ID/)
    }
  })

  it('never names the token in an error', () => {
    expect(() =>
      leadsTelegramConfigFromEnv({
        LEADS_TELEGRAM_BOT_TOKEN: 'not-a-token',
        LEADS_TELEGRAM_CHAT_ID: '-1',
      }),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining('not-a-token') }))
  })
})
