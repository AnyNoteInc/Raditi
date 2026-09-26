import { describe, expect, it } from 'vitest'

import { telegramConfigFromEnv } from './config.ts'

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
