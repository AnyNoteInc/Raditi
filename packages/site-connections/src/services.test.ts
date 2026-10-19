import { describe, expect, it, vi } from 'vitest'

import { isDomainError, type SecretStore } from '@repo/domain'

import { mysqlInspector, postgresInspector } from './databases/index.ts'
import { ftpSource, sftpSource } from './index.ts'
import { createSiteConnectionServices } from './services.ts'

function store() {
  return {
    kvRead: vi.fn(async () => ({ data: { password: 'leak' }, version: 1 })),
    kvWrite: vi.fn(async () => ({ version: 3 })),
    kvMetadata: vi.fn(async () => null),
    kvDelete: vi.fn(async () => {}),
  }
}

describe('createSiteConnectionServices', () => {
  it('hands the transport a secrets object with the two write-side methods only', async () => {
    const secrets = store()
    const services = createSiteConnectionServices({
      appEnv: 'test',
      secrets: secrets as unknown as Pick<SecretStore, 'kvWrite' | 'kvMetadata'>,
      connectableStacks: ['wordpress'],
      rootMarkers: () => ['wp-content', 'wp-includes'],
      lookup: async () => [],
    })
    expect(Object.keys(services.secrets).sort()).toEqual(['kvMetadata', 'kvWrite'])
    expect('kvRead' in services.secrets).toBe(false)
    expect((services.secrets as unknown as Record<string, unknown>).kvDelete).toBeUndefined()
    expect(Object.getPrototypeOf(services.secrets)).toBeNull()
    expect(Object.isFrozen(services.secrets)).toBe(true)

    await expect(
      services.secrets.kvWrite('kv/sites/x/ftp', { v: '1' }, { cas: 0 }),
    ).resolves.toEqual({ version: 3 })
    expect(secrets.kvWrite).toHaveBeenCalledWith('kv/sites/x/ftp', { v: '1' }, { cas: 0 })
    await services.secrets.kvMetadata('kv/sites/x/ftp')
    expect(secrets.kvMetadata).toHaveBeenCalledWith('kv/sites/x/ftp')
    expect(secrets.kvRead).not.toHaveBeenCalled()
  })

  it('indexes the adapters by kind and offers SSH, FTP and both engines with their ports', () => {
    const lookup = async () => []
    const services = createSiteConnectionServices({
      appEnv: 'production',
      secrets: store() as unknown as Pick<SecretStore, 'kvWrite' | 'kvMetadata'>,
      connectableStacks: ['wordpress'],
      rootMarkers: (stack) => (stack === 'wordpress' ? ['wp-content'] : []),
      lookup,
    })
    expect(services.appEnv).toBe('production')
    expect(services.lookup).toBe(lookup)
    expect(services.connectableStacks).toEqual(['wordpress'])
    expect(services.rootMarkers('wordpress')).toEqual(['wp-content'])
    expect(services.sources('sftp')).toBe(sftpSource)
    expect(services.sources('ftp')).toBe(ftpSource)
    expect(services.databases('postgres')).toBe(postgresInspector)
    expect(services.databases('mysql')).toBe(mysqlInspector)
    expect(services.sourceOptions).toEqual([
      { kind: 'sftp', defaultPort: 22 },
      { kind: 'ftp', defaultPort: 21 },
    ])
    expect(services.databaseOptions).toEqual([
      { engine: 'postgres', defaultPort: 5432 },
      { engine: 'mysql', defaultPort: 3306 },
    ])
    let refused: unknown
    try {
      services.sources('git')
    } catch (error) {
      refused = error
    }
    expect(isDomainError(refused) && refused.code).toBe('NOT_IMPLEMENTED')
    expect(() => services.sources('svn' as never)).toThrow()
    expect(() => services.databases('oracle' as never)).toThrow()
  })

  it('builds its own lookup when none is given', () => {
    const services = createSiteConnectionServices({
      appEnv: 'development',
      secrets: store() as unknown as Pick<SecretStore, 'kvWrite' | 'kvMetadata'>,
      connectableStacks: [],
      rootMarkers: () => [],
    })
    expect(typeof services.lookup).toBe('function')
  })
})
