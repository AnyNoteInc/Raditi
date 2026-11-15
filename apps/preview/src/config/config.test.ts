import type { Env } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { ConfigError, DEV_PAGES_COOKIE_SECRET, loadPreviewConfig } from './config.ts'

const WORKER_TOKEN = 'worker-token-0123456789abcdef0123456789abcdef'
const worker = { BROWSER_WORKER_URL: 'http://127.0.0.1:8086', BROWSER_WORKER_TOKEN: WORKER_TOKEN }

const devEnv = (overrides: Env = {}): Env => ({
  APP_ENV: 'development',
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://raditi:raditi@localhost:5432/raditi',
  PAGES_BASE_DOMAIN: 'pages.localhost',
  ...overrides,
})

const prodEnv = (overrides: Env = {}): Env => ({
  APP_ENV: 'production',
  APP_URL: 'https://raditi.ru',
  DATABASE_URL: 'postgresql://raditi:secret@db.internal:5432/raditi',
  PAGES_BASE_DOMAIN: 'pages.raditi.ru',
  PAGES_COOKIE_SECRET: 'c'.repeat(32),
  ...overrides,
})

function problemsOf(env: Env): readonly string[] {
  try {
    loadPreviewConfig(env)
  } catch (err) {
    if (err instanceof ConfigError) return err.problems
    throw err
  }
  throw new Error('expected a ConfigError')
}

describe('loadPreviewConfig', () => {
  it('starts with the pages, the cabinet and the database', () => {
    expect(loadPreviewConfig(devEnv({ PAGES_PUBLIC_PORT: '8092' }))).toEqual({
      appEnv: 'development',
      appUrl: 'http://localhost:3000',
      db: { databaseUrl: 'postgresql://raditi:raditi@localhost:5432/raditi' },
      browserStream: null,
      pages: {
        baseDomain: 'pages.localhost',
        publicPort: 8092,
        cookieSecret: DEV_PAGES_COOKIE_SECRET,
        abuseEmail: null,
        port: 8092,
        host: '127.0.0.1',
      },
    })
  })

  it('needs one listener at least: the pages or the stream of a browser (plan 83)', () => {
    expect(problemsOf(devEnv({ PAGES_BASE_DOMAIN: undefined }))).toEqual([
      'PAGES_BASE_DOMAIN: the preview role serves the pages or the stream of a browser (BROWSER_WORKER_URL); neither is set',
    ])
    expect(loadPreviewConfig(devEnv({ PAGES_BASE_DOMAIN: undefined, ...worker }))).toMatchObject({
      pages: null,
      browserStream: { port: 8091 },
    })
  })

  it('requires the address of the cabinet', () => {
    expect(problemsOf(devEnv({ APP_URL: '' }))).toEqual(['APP_URL: required for the preview role'])
  })

  it('reads none of the settings of the gateway of previews any more (plan 83)', () => {
    const config = loadPreviewConfig(
      devEnv({
        PREVIEW_BASE_DOMAIN: '',
        PREVIEW_SESSION_SECRET: 'short',
        PREVIEW_GATEWAY_PORT: 'http',
        PREVIEW_GATEWAY_HOST: 'localhost',
        PREVIEW_BROWSER_RELAYS: 'nope',
        GITEA_URL: 'not a url',
      }),
    )
    expect(config).not.toHaveProperty('address')
    expect(config).not.toHaveProperty('port')
  })

  it('opens the stream of a chat browser only with the worker and its token', () => {
    expect(loadPreviewConfig(devEnv(worker)).browserStream).toEqual({
      port: 8091,
      host: '127.0.0.1',
      workerUrl: 'http://127.0.0.1:8086',
      workerToken: WORKER_TOKEN,
    })
    // BROWSER_STREAM_PORT alone, as .env.example has it, opens nothing.
    expect(loadPreviewConfig(devEnv({ BROWSER_STREAM_PORT: '8091' })).browserStream).toBeNull()
    expect(
      loadPreviewConfig(
        devEnv({ ...worker, BROWSER_STREAM_PORT: '9091', BROWSER_STREAM_HOST: '::1' }),
      ).browserStream,
    ).toMatchObject({ port: 9091, host: '::1' })
    expect(
      loadPreviewConfig(
        prodEnv({ BROWSER_WORKER_URL: 'http://10.0.0.7:8086', BROWSER_WORKER_TOKEN: WORKER_TOKEN }),
      ).browserStream,
    ).toEqual({
      port: 8091,
      host: undefined,
      workerUrl: 'http://10.0.0.7:8086',
      workerToken: WORKER_TOKEN,
    })
  })

  it('refuses an address without its token, a weak token, an address with a path, one port twice', () => {
    expect(problemsOf(devEnv({ BROWSER_WORKER_URL: 'http://127.0.0.1:8086' }))).toEqual([
      'BROWSER_WORKER_TOKEN: required with BROWSER_WORKER_URL',
    ])
    // The token alone is the worker's in the shared .env: no listener then.
    expect(
      loadPreviewConfig(devEnv({ BROWSER_WORKER_TOKEN: WORKER_TOKEN })).browserStream,
    ).toBeNull()
    // The token goes with every stream: plain http in production only inside the perimeter.
    for (const url of ['http://browser:8086', 'http://203.0.113.7:8086'])
      expect(
        problemsOf(prodEnv({ BROWSER_WORKER_URL: url, BROWSER_WORKER_TOKEN: WORKER_TOKEN })),
      ).toEqual([
        'BROWSER_WORKER_URL: plain http only to a private or loopback IP address in production (spec §19)',
      ])
    const weak = problemsOf(
      devEnv({ BROWSER_WORKER_URL: 'http://127.0.0.1:8086', BROWSER_WORKER_TOKEN: 'short-token' }),
    )
    expect(weak[0]).toMatch(/^BROWSER_WORKER_TOKEN: must be 32 to 4096 visible ASCII/)
    expect(weak.join('\n')).not.toContain('short-token')
    const withPath = problemsOf(
      devEnv({
        BROWSER_WORKER_URL: 'http://user:pass@127.0.0.1:8086/v1',
        BROWSER_WORKER_TOKEN: WORKER_TOKEN,
      }),
    )
    expect(withPath[0]).toMatch(/^BROWSER_WORKER_URL: must be an http\(s\) origin/)
    expect(withPath.join('\n')).not.toContain('pass')
    expect(problemsOf(devEnv({ ...worker, PAGES_PORT: '8091' }))).toEqual([
      'PAGES_PORT: must differ from BROWSER_STREAM_PORT',
    ])
    expect(problemsOf(devEnv({ BROWSER_STREAM_HOST: 'localhost' }))).toEqual([
      'BROWSER_STREAM_HOST: must be an IP address',
    ])
  })

  it('opens the pages in production on every address, without a port in the host', () => {
    const production = loadPreviewConfig(prodEnv({ PAGES_ABUSE_EMAIL: 'abuse@raditi.ru' })).pages
    expect(production).toMatchObject({
      baseDomain: 'pages.raditi.ru',
      host: undefined,
      abuseEmail: 'abuse@raditi.ru',
    })
    expect(production).not.toHaveProperty('publicPort')
  })

  it('refuses pages that would share a host with the cabinet, or run open in production', () => {
    expect(problemsOf(prodEnv({ PAGES_COOKIE_SECRET: undefined }))).toContain(
      'PAGES_COOKIE_SECRET: at least 32 characters in production',
    )
    expect(problemsOf(prodEnv({ PAGES_PUBLIC_PORT: '8092' }))).toContain(
      'PAGES_PUBLIC_PORT: not in production (a page host carries no port there)',
    )
    expect(problemsOf(prodEnv({ PAGES_BASE_DOMAIN: 'raditi.ru' }))).toContain(
      'PAGES_BASE_DOMAIN: must not be the host of APP_URL or above it',
    )
    expect(problemsOf(prodEnv({ PAGES_COOKIE_SECRET: DEV_PAGES_COOKIE_SECRET }))).toContain(
      'PAGES_COOKIE_SECRET: a secret of its own in production, not the dev value',
    )
    expect(
      problemsOf(
        devEnv({ PAGES_BASE_DOMAIN: undefined, ...worker, PAGES_COOKIE_SECRET: 'x'.repeat(40) }),
      ),
    ).toContain('PAGES_COOKIE_SECRET: needs PAGES_BASE_DOMAIN')
    expect(problemsOf(devEnv({ PAGES_BASE_DOMAIN: 'Pages.Localhost' }))[0]).toMatch(
      /^PAGES_BASE_DOMAIN/,
    )
  })

  it('reads none of the settings of core', () => {
    expect(
      loadPreviewConfig(
        devEnv({
          CORE_PORT: 'unused',
          REDIS_URL: 'unused',
          RUNNER_API_PORT: 'unused',
          TURN_EXECUTOR: 'unused',
          BILLING_TICK_SECONDS: 'unused',
        }),
      ).pages?.port,
    ).toBe(8092)
  })
})
