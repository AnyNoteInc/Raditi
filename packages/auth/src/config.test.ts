import { describe, expect, it } from 'vitest'

import { authConfigFromEnv } from './config.ts'

const pair = 'a1b2c3d4e5f6g7h8i9j0'
const serverKey = `ysc2_${pair}SERVERSECRETPART`
const clientKey = `ysc1_${pair}CLIENTPUBLICPART`

const base = {
  APP_ENV: 'development',
  APP_URL: 'http://localhost:3000/',
  BETTER_AUTH_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
}

describe('authConfigFromEnv', () => {
  it('reads a local setup without captcha', () => {
    expect(authConfigFromEnv(base)).toEqual({
      appEnv: 'development',
      appUrl: 'http://localhost:3000',
      baseUrl: 'http://localhost:3000',
      secret: 'x'.repeat(32),
      captcha: null,
    })
  })

  it('treats blank keys as unset, as in .env.example', () => {
    const config = authConfigFromEnv({
      ...base,
      SMARTCAPTCHA_SERVER_KEY: '',
      SMARTCAPTCHA_CLIENT_KEY: ' ',
    })
    expect(config.captcha).toBeNull()
  })

  it('enables the captcha with a matching key pair', () => {
    const config = authConfigFromEnv({
      ...base,
      SMARTCAPTCHA_SERVER_KEY: serverKey,
      SMARTCAPTCHA_CLIENT_KEY: clientKey,
    })
    expect(config.captcha).toEqual({ serverKey, clientKey })
  })

  it('refuses a single key', () => {
    expect(() => authConfigFromEnv({ ...base, SMARTCAPTCHA_SERVER_KEY: serverKey })).toThrow(
      /both SMARTCAPTCHA_SERVER_KEY and SMARTCAPTCHA_CLIENT_KEY or neither/,
    )
    expect(() => authConfigFromEnv({ ...base, SMARTCAPTCHA_CLIENT_KEY: clientKey })).toThrow(
      /or neither/,
    )
  })

  it('refuses swapped keys and keys of different captchas', () => {
    expect(() =>
      authConfigFromEnv({
        ...base,
        SMARTCAPTCHA_SERVER_KEY: clientKey,
        SMARTCAPTCHA_CLIENT_KEY: serverKey,
      }),
    ).toThrow(/must start with ysc2_/)
    expect(() =>
      authConfigFromEnv({
        ...base,
        SMARTCAPTCHA_SERVER_KEY: serverKey,
        SMARTCAPTCHA_CLIENT_KEY: `ysc1_${'z'.repeat(20)}CLIENTPUBLICPART`,
      }),
    ).toThrow(/different captchas/)
  })

  it('requires the captcha and https in production', () => {
    expect(() => authConfigFromEnv({ ...base, APP_ENV: 'production' })).toThrow(
      /required when APP_ENV=production/,
    )
    expect(() =>
      authConfigFromEnv({
        ...base,
        APP_ENV: 'production',
        SMARTCAPTCHA_SERVER_KEY: serverKey,
        SMARTCAPTCHA_CLIENT_KEY: clientKey,
      }),
    ).toThrow(/APP_URL must use https/)
    const config = authConfigFromEnv({
      APP_ENV: 'production',
      APP_URL: 'https://raditi.ru',
      BETTER_AUTH_URL: 'https://raditi.ru',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      SMARTCAPTCHA_SERVER_KEY: serverKey,
      SMARTCAPTCHA_CLIENT_KEY: clientKey,
    })
    expect(config.captcha?.serverKey).toBe(serverKey)
  })

  it.each([
    ['missing', undefined],
    ['blank', ''],
    ['misspelt', 'prod'],
  ])('refuses a %s APP_ENV instead of assuming development', (_case, APP_ENV) => {
    expect(() => authConfigFromEnv({ ...base, APP_ENV })).toThrow(/APP_ENV must be one of/)
  })

  it('refuses a short or missing secret and a non-http URL', () => {
    expect(() => authConfigFromEnv({ ...base, BETTER_AUTH_SECRET: 'short' })).toThrow(/at least 32/)
    expect(() => authConfigFromEnv({ ...base, BETTER_AUTH_SECRET: undefined })).toThrow(/not set/)
    expect(() => authConfigFromEnv({ ...base, APP_URL: 'javascript:alert(1)' })).toThrow(
      /APP_URL must be an http\(s\) URL/,
    )
  })
})
