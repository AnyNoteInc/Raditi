import type { Env } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { ConfigError, DEV_PREVIEW_SESSION_SECRET, loadPreviewConfig } from './config.ts'

const devEnv = (overrides: Env = {}): Env => ({
  APP_ENV: 'development',
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://raditi:raditi@localhost:5432/raditi',
  PREVIEW_BASE_DOMAIN: 'localhost',
  PREVIEW_PUBLIC_PORT: '8090',
  ...overrides,
})

const prodEnv = (overrides: Env = {}): Env => ({
  APP_ENV: 'production',
  APP_URL: 'https://raditi.ru',
  DATABASE_URL: 'postgresql://raditi:secret@db.internal:5432/raditi',
  PREVIEW_BASE_DOMAIN: 'preview.raditi-sites.ru',
  PREVIEW_SESSION_SECRET: 's'.repeat(32),
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
  it('starts the gateway with its port, address, the dev secret and the database', () => {
    expect(loadPreviewConfig(devEnv())).toEqual({
      appEnv: 'development',
      port: 8090,
      address: { baseDomain: 'localhost', scheme: 'http', publicPort: 8090 },
      sessionSecret: DEV_PREVIEW_SESSION_SECRET,
      appUrl: 'http://localhost:3000',
      db: { databaseUrl: 'postgresql://raditi:raditi@localhost:5432/raditi' },
      // This machine and Docker's bridges (browser-relays.ts).
      browserRelays: [
        { address: '127.0.0.1', prefix: 32, family: 'ipv4' },
        { address: '::1', prefix: 128, family: 'ipv6' },
        { address: '172.16.0.0', prefix: 12, family: 'ipv4' },
      ],
      host: '127.0.0.1',
    })
    expect(problemsOf(devEnv({ PREVIEW_BASE_DOMAIN: '' }))).toEqual([
      'PREVIEW_BASE_DOMAIN: required for the preview role',
    ])
    expect(problemsOf(devEnv({ PREVIEW_SESSION_SECRET: 'short' }))).toEqual([
      'PREVIEW_SESSION_SECRET: must be at least 32 bytes',
    ])
    expect(problemsOf(devEnv({ PREVIEW_GATEWAY_PORT: 'http' }))[0]).toMatch(/^PREVIEW_GATEWAY_PORT/)
  })

  it('listens where PREVIEW_GATEWAY_HOST says: loopback in dev, every address in production', () => {
    // A Linux stand: the relay of the agent's browser reaches the host on the bridge's gateway.
    expect(loadPreviewConfig(devEnv({ PREVIEW_GATEWAY_HOST: '172.17.0.1' })).host).toBe(
      '172.17.0.1',
    )
    expect(loadPreviewConfig(prodEnv()).host).toBeUndefined()
    expect(problemsOf(devEnv({ PREVIEW_GATEWAY_HOST: 'localhost' }))).toEqual([
      'PREVIEW_GATEWAY_HOST: must be an IP address',
    ])
  })

  it('starts the gateway in production with a secret of its own', () => {
    expect(loadPreviewConfig(prodEnv())).toMatchObject({
      appEnv: 'production',
      port: 8090,
      address: { scheme: 'https', baseDomain: 'preview.raditi-sites.ru' },
    })
    const problems = problemsOf(prodEnv({ PREVIEW_SESSION_SECRET: '' }))
    expect(problems).toEqual(['PREVIEW_SESSION_SECRET: required in production'])
    const short = problemsOf(prodEnv({ PREVIEW_SESSION_SECRET: 'tiny-secret' }))
    expect(short.join('\n')).not.toContain('tiny-secret')
    expect(problemsOf(prodEnv({ PREVIEW_BASE_DOMAIN: 'app.raditi.ru' }))[0]).toMatch(/APP_URL/)
  })

  it('reads the sources of the agent browser from PREVIEW_BROWSER_RELAYS', () => {
    expect(
      loadPreviewConfig(devEnv({ PREVIEW_BROWSER_RELAYS: '192.168.65.0/24' })).browserRelays,
    ).toEqual([{ address: '192.168.65.0', prefix: 24, family: 'ipv4' }])
    expect(() => loadPreviewConfig(devEnv({ PREVIEW_BROWSER_RELAYS: 'nope' }))).toThrow(
      /PREVIEW_BROWSER_RELAYS: must be a comma-separated list of IP CIDRs/,
    )
  })

  it('requires the address of the cabinet it frames', () => {
    expect(problemsOf(devEnv({ APP_URL: '' }))).toEqual([
      'APP_URL: required for the preview role (the cabinet that frames a preview)',
    ])
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
      ).port,
    ).toBe(8090)
  })
})
