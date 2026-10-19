import { describe, expect, it } from 'vitest'

import {
  envVarNameProblem,
  envVarReachesAgent,
  envVarsMayReachAgent,
  envVarReachesPreview,
  envVarValueSchema,
  refusedEnvVarPrefixes,
  siteEnvVarInputSchema,
  siteEnvVarPath,
  siteEnvVarSecret,
  siteEnvVarTombstone,
  siteEnvVarValueOf,
} from './env-vars.ts'

const siteId = '0196abcd-0000-7000-8000-00000000000f'

describe('names of client variables', () => {
  it('takes capital letters, digits and underscores', () => {
    for (const name of ['STRIPE_KEY', 'MAP_API_TOKEN', 'A1', `A${'B'.repeat(63)}`])
      expect(envVarNameProblem(name), name).toBeNull()
    for (const name of ['', 'A', 'api_key', '1KEY', '_KEY', 'KEY-1', `A${'B'.repeat(64)}`, 'КЛЮЧ'])
      expect(envVarNameProblem(name), name).toBe('format')
  })

  it('refuses what the shell, the runtime or the platform reads', () => {
    for (const prefix of refusedEnvVarPrefixes)
      expect(envVarNameProblem(`${prefix}X`), prefix).toBe('reserved')
    for (const name of [
      'LD_PRELOAD',
      'NODE_OPTIONS',
      'OPENCODE_CONFIG',
      'RADITI_TOKEN',
      'GIT_SSH_COMMAND',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'FTP_PROXY',
      'NO_PROXY',
      'PATH',
      'HOME',
      'SHELL',
      'TMPDIR',
      'BASH_ENV',
      'ENV',
      'DB_PASSWORD',
      'WP_HOME',
      'AUTH_KEY',
      'SECURE_AUTH_SALT',
      'LOGGED_IN_KEY',
      'NONCE_SALT',
    ])
      expect(envVarNameProblem(name), name).toBe('reserved')
    expect(envVarNameProblem('ENVIRONMENT')).toBeNull()
  })
})

describe('values and the form', () => {
  it('wants at least 8 bytes of text', () => {
    expect(envVarValueSchema.safeParse('1234567').success).toBe(false)
    expect(envVarValueSchema.safeParse('12345678').success).toBe(true)
    expect(envVarValueSchema.safeParse('ключ').success).toBe(true)
    expect(envVarValueSchema.safeParse('abc\0defgh').success).toBe(false)
    expect(envVarValueSchema.safeParse('x'.repeat(8 * 1024 + 1)).success).toBe(false)
  })

  it('gives the agent a variable only with the consent', () => {
    const input = {
      name: 'MAP_API_TOKEN',
      value: 'secret-value-1',
      hosts: ['api.maps.example.ru'],
      toPreview: true,
      toAgent: true,
      agentConsent: true,
    }
    expect(siteEnvVarInputSchema.parse(input).hosts).toEqual(['api.maps.example.ru:443'])
    expect(siteEnvVarInputSchema.safeParse({ ...input, agentConsent: false }).success).toBe(false)
    expect(
      siteEnvVarInputSchema.safeParse({ ...input, toAgent: false, agentConsent: false }).success,
    ).toBe(true)
    expect(siteEnvVarInputSchema.safeParse({ ...input, hosts: ['10.0.0.1'] }).success).toBe(false)
    expect(siteEnvVarInputSchema.safeParse({ ...input, name: 'PATH' }).success).toBe(false)
  })

  it('names the one Vault path of a value', () => {
    expect(siteEnvVarPath(siteId, 'MAP_API_TOKEN')).toBe(`kv/sites/${siteId}/env/MAP_API_TOKEN`)
    expect(() => siteEnvVarPath(siteId, '../wp')).toThrow('Invalid site variable reference')
    expect(() => siteEnvVarPath('site', 'MAP_API_TOKEN')).toThrow('Invalid site variable reference')
    expect(() => siteEnvVarPath(siteId, 'PATH')).toThrow('Invalid site variable reference')
  })
})

describe('the key of a variable in Vault', () => {
  it('holds the value under one name, and a removed variable a version without it', () => {
    expect(siteEnvVarSecret('секретное значение')).toEqual({ value: 'секретное значение' })
    expect(siteEnvVarValueOf(siteEnvVarSecret('12345678'))).toBe('12345678')
    const tombstone = siteEnvVarTombstone(new Date('2026-10-17T12:00:00.000Z'))
    expect(tombstone).toEqual({ removed: '2026-10-17T12:00:00.000Z' })
    expect(siteEnvVarValueOf(tombstone)).toBeNull()
    expect(siteEnvVarValueOf({})).toBeNull()
  })
})

describe('who gets the value of a client variable', () => {
  const consented = new Date('2026-10-17T12:00:00Z')
  const variable = (toPreview: boolean, toAgent: boolean, agentConsentAt: Date | null) => ({
    toPreview,
    toAgent,
    agentConsentAt,
  })

  it('gives the agent a value only with its switch, the consent and synthetic data', () => {
    expect(envVarsMayReachAgent('synthetic')).toBe(true)
    expect(envVarsMayReachAgent('client')).toBe(false)
    expect(envVarReachesAgent(variable(true, true, consented), 'synthetic')).toBe(true)
    expect(envVarReachesAgent(variable(true, true, null), 'synthetic')).toBe(false)
    expect(envVarReachesAgent(variable(true, false, consented), 'synthetic')).toBe(false)
    // Real client data: not before the gate of 152-FZ.
    expect(envVarReachesAgent(variable(true, true, consented), 'client')).toBe(false)
  })

  it('gives a preview, which runs the agent code, nothing the agent may not see', () => {
    expect(envVarReachesPreview(variable(true, true, consented), 'synthetic')).toBe(true)
    // The defaults of a new variable: for the preview, not for the agent — so for neither.
    expect(envVarReachesPreview(variable(true, false, null), 'synthetic')).toBe(false)
    expect(envVarReachesPreview(variable(false, true, consented), 'synthetic')).toBe(false)
    expect(envVarReachesPreview(variable(true, true, consented), 'client')).toBe(false)
  })
})
