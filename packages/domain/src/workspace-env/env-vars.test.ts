import { describe, expect, it } from 'vitest'

import {
  envVarNameProblem,
  envVarValueSchema,
  refusedEnvVarPrefixes,
  workspaceEnvVarPath,
} from './env-vars.ts'

const workspaceId = '0196abcd-0000-7000-8000-00000000000f'

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

  it('names the one Vault path of a value', () => {
    expect(workspaceEnvVarPath(workspaceId, 'MAP_API_TOKEN')).toBe(
      `kv/workspaces/${workspaceId}/env/MAP_API_TOKEN`,
    )
    for (const [id, name] of [
      [workspaceId, '../wp'],
      ['workspace', 'MAP_API_TOKEN'],
      [workspaceId, 'PATH'],
    ] as const)
      expect(() => workspaceEnvVarPath(id, name)).toThrow('Invalid workspace variable reference')
  })
})
