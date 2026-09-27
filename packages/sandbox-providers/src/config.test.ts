import { describe, expect, it } from 'vitest'
import { sandboxConfigFromEnv } from './config.ts'

const base = { APP_ENV: 'development' }

describe('sandboxConfigFromEnv', () => {
  it('defaults to runc for local development', () => {
    expect(sandboxConfigFromEnv(base)).toEqual({
      runtime: 'runc',
      socketPath: '/var/run/docker.sock',
    })
    expect(sandboxConfigFromEnv({ ...base, SANDBOX_RUNTIME: '' }).runtime).toBe('runc')
    expect(sandboxConfigFromEnv({ ...base, SANDBOX_RUNTIME: ' ' }).runtime).toBe('runc')
  })

  it('accepts runsc', () => {
    expect(sandboxConfigFromEnv({ ...base, SANDBOX_RUNTIME: 'runsc' }).runtime).toBe('runsc')
  })

  it('accepts only an explicit local Unix socket path', () => {
    expect(
      sandboxConfigFromEnv({ ...base, SANDBOX_DOCKER_SOCKET: '/tmp/docker.sock' }).socketPath,
    ).toBe('/tmp/docker.sock')
    for (const socket of ['tcp://localhost:2375', 'docker.sock', '/tmp/socket\0suffix']) {
      expect(() => sandboxConfigFromEnv({ ...base, SANDBOX_DOCKER_SOCKET: socket })).toThrow(
        /SANDBOX_DOCKER_SOCKET/,
      )
    }
  })

  it('rejects any other runtime', () => {
    for (const runtime of ['kata', 'RUNSC', 'runsc ']) {
      expect(() => sandboxConfigFromEnv({ ...base, SANDBOX_RUNTIME: runtime })).toThrow(
        /^\[sandbox\] invalid configuration: SANDBOX_RUNTIME: /,
      )
    }
  })

  it('requires gVisor in production', () => {
    expect(() => sandboxConfigFromEnv({ ...base, APP_ENV: 'production' })).toThrow(/runsc/)
    expect(() =>
      sandboxConfigFromEnv({ ...base, APP_ENV: 'production', SANDBOX_RUNTIME: 'runc' }),
    ).toThrow(/runsc/)
    expect(
      sandboxConfigFromEnv({ ...base, APP_ENV: 'production', SANDBOX_RUNTIME: 'runsc' }).runtime,
    ).toBe('runsc')
    expect(sandboxConfigFromEnv({ ...base, APP_ENV: 'test' }).runtime).toBe('runc')
  })

  it('requires APP_ENV without a default, so production checks cannot be skipped', () => {
    const { APP_ENV: _omitted, ...withoutAppEnv } = base
    for (const env of [withoutAppEnv, { ...base, APP_ENV: '' }]) {
      expect(() => sandboxConfigFromEnv(env)).toThrow(/APP_ENV/)
    }
    for (const appEnv of ['prod', 'Production', 'staging']) {
      expect(() => sandboxConfigFromEnv({ ...base, APP_ENV: appEnv })).toThrow(/APP_ENV/)
    }
  })
})
