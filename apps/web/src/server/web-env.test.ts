import { DEV_METRICS_TOKEN } from '@repo/observability'
import { describe, expect, it } from 'vitest'

import { webEnvFromEnv } from './web-env'

const devEnv = {
  APP_ENV: 'development',
  APP_URL: 'http://localhost:3000/',
  METRICS_TOKEN: DEV_METRICS_TOKEN,
  REDIS_URL: 'redis://localhost:6379',
}

const PROD_METRICS_TOKEN = 'test-metrics-token-'.padEnd(32, 'x')

const prodEnv = {
  APP_ENV: 'production',
  APP_URL: 'https://raditi.ru',
  METRICS_TOKEN: PROD_METRICS_TOKEN,
  REDIS_URL: 'rediss://redis.internal:6380',
}

describe('webEnvFromEnv', () => {
  it('reads the .env.example setup', () => {
    expect(webEnvFromEnv(devEnv)).toEqual({
      appEnv: 'development',
      appUrl: 'http://localhost:3000',
      metricsToken: DEV_METRICS_TOKEN,
      redisUrl: 'redis://localhost:6379',
      pastDueDays: 7,
      preview: null,
    })
    expect(webEnvFromEnv({ ...devEnv, METRICS_TOKEN: ' ', REDIS_URL: '' })).toMatchObject({
      metricsToken: DEV_METRICS_TOKEN,
      redisUrl: undefined,
    })
  })

  it('reads the grace of an overdue tariff as the core role does: a week unless set', () => {
    expect(webEnvFromEnv({ ...devEnv, BILLING_PAST_DUE_DAYS: '14' }).pastDueDays).toBe(14)
    for (const blank of ['', ' ', undefined]) {
      expect(webEnvFromEnv({ ...devEnv, BILLING_PAST_DUE_DAYS: blank }).pastDueDays).toBe(7)
    }
    for (const broken of ['0', '91', '1.5', 'week']) {
      expect(() => webEnvFromEnv({ ...devEnv, BILLING_PAST_DUE_DAYS: broken })).toThrow(
        /^\[web\] invalid configuration: BILLING_PAST_DUE_DAYS: /,
      )
    }
  })

  it('requires APP_ENV: a missing or misspelt one never falls back to development', () => {
    for (const APP_ENV of [undefined, '', 'prod']) {
      expect(() => webEnvFromEnv({ ...devEnv, APP_ENV })).toThrow(
        '[web] invalid configuration: APP_ENV: must be one of development, test, production',
      )
    }
  })

  it('accepts production settings', () => {
    expect(webEnvFromEnv(prodEnv)).toMatchObject({
      appEnv: 'production',
      metricsToken: PROD_METRICS_TOKEN,
    })
  })

  it('requires a production metrics token of at least 32 characters, without leaking it', () => {
    const short = 'k'.repeat(31)
    expect(() => webEnvFromEnv({ ...prodEnv, METRICS_TOKEN: short })).toThrow(
      /^\[web\] invalid configuration: METRICS_TOKEN: must be at least 32 characters in production$/,
    )
    // Short tokens stay fine outside production.
    expect(webEnvFromEnv({ ...devEnv, METRICS_TOKEN: 'short' }).metricsToken).toBe('short')
  })

  it('refuses a metrics token with whitespace in every environment, as the orchestrator does', () => {
    // It is compared with a Bearer token, which never carries a trailing newline or a space.
    for (const env of [devEnv, prodEnv]) {
      for (const METRICS_TOKEN of [`${PROD_METRICS_TOKEN}\n`, `${PROD_METRICS_TOKEN} x`]) {
        expect(() => webEnvFromEnv({ ...env, METRICS_TOKEN })).toThrow(
          /^\[web\] invalid configuration: METRICS_TOKEN: must not contain whitespace \(it is sent as a Bearer token\)$/,
        )
      }
    }
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

    expect(error.message).toBe(
      '[web] invalid configuration: ' +
        'METRICS_TOKEN: set a unique token in production (the dev placeholder is refused); ' +
        'APP_URL: must use https in production',
    )
  })

  it('names bad URLs without echoing them', () => {
    expect(() =>
      webEnvFromEnv({ ...devEnv, APP_URL: 'ftp://files', REDIS_URL: 'http://cache:6379' }),
    ).toThrow(
      '[web] invalid configuration: APP_URL: must be an http(s) URL; REDIS_URL: must be a redis:// URL',
    )
  })
})

describe('the address of previews', () => {
  it('reads the address of .env.example and nothing without a base domain', () => {
    expect(
      webEnvFromEnv({
        ...devEnv,
        PREVIEW_BASE_DOMAIN: 'localhost',
        PREVIEW_SCHEME: 'http',
        PREVIEW_PUBLIC_PORT: '8090',
      }).preview,
    ).toEqual({ baseDomain: 'localhost', scheme: 'http', publicPort: 8090 })
    expect(webEnvFromEnv({ ...devEnv, PREVIEW_BASE_DOMAIN: '' }).preview).toBeNull()
  })

  it('takes https in production and refuses http there', () => {
    expect(
      webEnvFromEnv({ ...prodEnv, PREVIEW_BASE_DOMAIN: 'preview.raditi-sites.ru' }).preview,
    ).toEqual({ baseDomain: 'preview.raditi-sites.ru', scheme: 'https', publicPort: null })
    expect(() =>
      webEnvFromEnv({
        ...prodEnv,
        PREVIEW_BASE_DOMAIN: 'preview.raditi-sites.ru',
        PREVIEW_SCHEME: 'http',
      }),
    ).toThrow(/PREVIEW_SCHEME: must be https in production/)
  })

  it('refuses in production a base under the domain of the cabinet or of Gitea', () => {
    expect(() => webEnvFromEnv({ ...prodEnv, PREVIEW_BASE_DOMAIN: 'preview.raditi.ru' })).toThrow(
      /PREVIEW_BASE_DOMAIN: must not share its registrable domain with APP_URL/,
    )
    expect(() =>
      webEnvFromEnv({
        ...prodEnv,
        PREVIEW_BASE_DOMAIN: 'p.code-raditi.ru',
        GITEA_URL: 'https://git.code-raditi.ru',
      }),
    ).toThrow(/with GITEA_URL/)
    expect(() => webEnvFromEnv({ ...prodEnv, PREVIEW_BASE_DOMAIN: 'localhost:8090' })).toThrow(
      /PREVIEW_BASE_DOMAIN/,
    )
  })
})
