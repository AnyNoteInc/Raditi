import { describe, expect, it } from 'vitest'

import { DEV_METRICS_TOKEN, MIN_METRICS_TOKEN_LENGTH, webEnvFromEnv } from './web-env'

const devEnv = {
  APP_ENV: 'development',
  APP_URL: 'http://localhost:3000/',
  METRICS_TOKEN: DEV_METRICS_TOKEN,
  REDIS_URL: 'redis://localhost:6379',
}

const prodEnv = {
  APP_ENV: 'production',
  APP_URL: 'https://raditi.ru',
  METRICS_TOKEN: '3f9c1e7a5b2d4c6e8f0a1b3c5d7e9f1a',
  REDIS_URL: 'rediss://redis.internal:6380',
}

describe('webEnvFromEnv', () => {
  it('reads the .env.example setup', () => {
    expect(webEnvFromEnv(devEnv)).toEqual({
      appEnv: 'development',
      appUrl: 'http://localhost:3000',
      metricsToken: DEV_METRICS_TOKEN,
      redisUrl: 'redis://localhost:6379',
    })
  })

  it('requires APP_ENV: a missing or misspelt one never falls back to development', () => {
    for (const APP_ENV of [undefined, '', 'prod']) {
      expect(() => webEnvFromEnv({ ...devEnv, APP_ENV })).toThrow(
        '[web] invalid configuration: APP_ENV: APP_ENV must be one of development, test, production',
      )
    }
  })

  it('accepts production settings', () => {
    expect(webEnvFromEnv(prodEnv)).toMatchObject({
      appEnv: 'production',
      metricsToken: '3f9c1e7a5b2d4c6e8f0a1b3c5d7e9f1a',
    })
  })

  it('requires a production metrics token of at least 32 characters, without leaking it', () => {
    const short = 'k'.repeat(MIN_METRICS_TOKEN_LENGTH - 1)
    expect(MIN_METRICS_TOKEN_LENGTH).toBe(32)
    expect(() => webEnvFromEnv({ ...prodEnv, METRICS_TOKEN: short })).toThrow(
      /^\[web\] invalid configuration: METRICS_TOKEN: must be at least 32 characters in production$/,
    )
    expect(
      webEnvFromEnv({ ...prodEnv, METRICS_TOKEN: 'x'.repeat(MIN_METRICS_TOKEN_LENGTH) })
        .metricsToken,
    ).toHaveLength(MIN_METRICS_TOKEN_LENGTH)
    // Short tokens stay fine outside production.
    expect(webEnvFromEnv({ ...devEnv, METRICS_TOKEN: 'short' }).metricsToken).toBe('short')
  })

  it('refuses the dev metrics token and plain http in production, without leaking values', () => {
    const error = (() => {
      try {
        webEnvFromEnv({ ...prodEnv, APP_URL: 'http://raditi.ru', METRICS_TOKEN: DEV_METRICS_TOKEN })
      } catch (err) {
        return err as Error
      }
      throw new Error('expected an error')
    })()

    expect(error.message).toMatch(/METRICS_TOKEN: set a unique token in production/)
    expect(error.message).toMatch(/APP_URL: must use https in production/)
    expect(error.message).not.toContain(DEV_METRICS_TOKEN)
  })
})
