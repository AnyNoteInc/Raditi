import { describe, expect, it } from 'vitest'
import { sandboxConfigFromEnv } from './config.ts'

const base = { APP_ENV: 'development', SANDBOX_IMAGE_PREFIX: 'raditi/agent' }

describe('sandboxConfigFromEnv', () => {
  it('defaults to runc for local development', () => {
    expect(sandboxConfigFromEnv(base)).toEqual({ runtime: 'runc', imagePrefix: 'raditi/agent' })
    expect(sandboxConfigFromEnv({ ...base, SANDBOX_RUNTIME: '' }).runtime).toBe('runc')
  })

  it('accepts runsc', () => {
    expect(sandboxConfigFromEnv({ ...base, SANDBOX_RUNTIME: 'runsc' }).runtime).toBe('runsc')
  })

  it('rejects any other runtime', () => {
    for (const runtime of ['kata', 'RUNSC', 'runsc ']) {
      expect(() => sandboxConfigFromEnv({ ...base, SANDBOX_RUNTIME: runtime })).toThrow(
        /Invalid sandbox configuration[\s\S]*SANDBOX_RUNTIME/,
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

  it('requires an image prefix', () => {
    expect(() => sandboxConfigFromEnv({ APP_ENV: 'development' })).toThrow(/SANDBOX_IMAGE_PREFIX/)
    expect(() => sandboxConfigFromEnv({ ...base, SANDBOX_IMAGE_PREFIX: '' })).toThrow(
      /SANDBOX_IMAGE_PREFIX/,
    )
  })

  it('accepts a registry host with a port', () => {
    const prefix = 'registry.raditi.local:3300/raditi/agent'
    expect(sandboxConfigFromEnv({ ...base, SANDBOX_IMAGE_PREFIX: prefix }).imagePrefix).toBe(prefix)
  })

  it.each([
    'raditi/agent:latest',
    'raditi/agent@sha256:abc',
    'Raditi/Agent',
    'raditi//agent',
    'host:3300',
    '/agent',
  ])('rejects the image prefix %s', (prefix) => {
    expect(() => sandboxConfigFromEnv({ ...base, SANDBOX_IMAGE_PREFIX: prefix })).toThrow(
      /SANDBOX_IMAGE_PREFIX/,
    )
  })
})
