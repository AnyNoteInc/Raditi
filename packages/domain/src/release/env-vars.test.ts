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
  siteAccessVariableNames,
  siteAccessVariables,
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
  it('wants at least one byte of text', () => {
    expect(envVarValueSchema.safeParse('').success).toBe(false)
    expect(envVarValueSchema.safeParse('1').success).toBe(true)
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

describe('the variables an access of a site becomes', () => {
  const hosts = ['укк-жкх.рф', 'xn----ltbkac3ct.xn--p1ai']
  const ftp = {
    v: '1',
    host: 'ftp.hosting.example',
    port: '21',
    tls: 'unverified',
    rootPath: 'укк-жкх.рф',
    username: 'u1234567_site',
    password: 'synthetic-password-1',
  }

  it('makes the host, port, user and password of FTP its variables, never the folder', () => {
    expect(siteAccessVariables('ftp', ftp, hosts)).toEqual([
      { name: 'FTP_HOST', value: 'ftp.hosting.example' },
      { name: 'FTP_PORT', value: '21' },
      { name: 'FTP_USER', value: 'u1234567_site' },
      { name: 'FTP_PASSWORD', value: 'synthetic-password-1' },
    ])
  })

  it('leaves out a long value the address of the site holds, and keeps a short one', () => {
    const named = { ...ftp, host: 'xn----ltbkac3ct.xn--p1ai', port: '21' }
    expect(siteAccessVariables('ftp', named, hosts).map(({ name }) => name)).toEqual([
      'FTP_PORT',
      'FTP_USER',
      'FTP_PASSWORD',
    ])
    expect(siteAccessVariables('ftp', ftp, ['site21.ru']).map(({ name }) => name)).toContain(
      'FTP_PORT',
    )
  })

  it('names the key or the password of SFTP, and the database and git with SITE_', () => {
    const key = {
      v: '1',
      host: 'h.example',
      port: '22',
      hostKey: 'k',
      rootPath: '/www',
      username: 'u-sftp',
      auth: 'key',
      privateKey: '-----BEGIN KEY-----\nabc\n-----END KEY-----',
      passphrase: 'phrase-123',
    }
    expect(siteAccessVariables('ssh', key, []).map(({ name }) => name)).toEqual([
      'SFTP_HOST',
      'SFTP_PORT',
      'SFTP_USER',
      'SFTP_PRIVATE_KEY',
      'SFTP_PASSPHRASE',
    ])
    const db = {
      v: '1',
      engine: 'mysql',
      host: 'db.example',
      port: '3306',
      tls: 'plain',
      database: 'wp',
      username: 'wp-user',
      password: 'db-password-1',
    }
    expect(siteAccessVariables('db', db, []).map(({ name }) => name)).toEqual([
      'SITE_DB_HOST',
      'SITE_DB_PORT',
      'SITE_DB_NAME',
      'SITE_DB_USER',
      'SITE_DB_PASSWORD',
    ])
    expect(siteAccessVariableNames('git')).toEqual([
      'SITE_GIT_URL',
      'SITE_GIT_USER',
      'SITE_GIT_TOKEN',
    ])
    expect(siteAccessVariables('browser', { password: 'x' }, [])).toEqual([])
  })

  it('takes only names a client variable may have', () => {
    for (const kind of ['ftp', 'ssh', 'git', 'db'])
      for (const name of siteAccessVariableNames(kind)) expect(envVarNameProblem(name)).toBeNull()
  })
})
