import { describe, expect, it, vi } from 'vitest'

import {
  isDomainError,
  type SecretStore,
  type SiteRootInspection,
  type StackSupport,
} from '@repo/domain'

import { mysqlInspector, postgresInspector } from './databases/index.ts'
import { ftpSource, sftpSource } from './index.ts'
import { createSiteConnectionServices } from './services.ts'

const support: StackSupport = {
  files: 'on',
  browser: 'on',
  generations: [],
  refuseBelow: null,
  releaseNeedsChecks: false,
  unknownVersion: 'open',
}
const nothingFound: SiteRootInspection = {
  foundStack: null,
  version: { kind: 'unknown' },
  hint: null,
  hasIndexPhp: false,
}
/** The parts of the deps the registry of adapters gives. */
const registry = {
  stackSupport: () => support,
  inspectRoot: async () => nothingFound,
}

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
      connectableStacks: () => ['wordpress'],
      rootMarkers: () => ['wp-content', 'wp-includes'],
      ...registry,
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
      connectableStacks: (way) => (way === 'files' ? ['wordpress'] : ['wordpress', 'bitrix']),
      rootMarkers: (stack) => (stack === 'wordpress' ? ['wp-content'] : []),
      ...registry,
      lookup,
    })
    expect(services.appEnv).toBe('production')
    expect(services.lookup).toBe(lookup)
    // The way reaches the registry as it is.
    expect(services.connectableStacks('files')).toEqual(['wordpress'])
    expect(services.connectableStacks('browser')).toEqual(['wordpress', 'bitrix'])
    expect(services.rootMarkers('wordpress')).toEqual(['wp-content'])
    expect(services.stackSupport('wordpress')).toBe(support)
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

  it('hands the inspection of a root to the registry with the read of the session as it is', async () => {
    const inspectRoot = vi.fn(async () => nothingFound)
    const services = createSiteConnectionServices({
      appEnv: 'test',
      secrets: store() as unknown as Pick<SecretStore, 'kvWrite' | 'kvMetadata'>,
      connectableStacks: () => [],
      rootMarkers: () => [],
      ...registry,
      inspectRoot,
    })
    const read = async () => null
    await expect(services.inspectRoot(['index.php'], read)).resolves.toBe(nothingFound)
    expect(inspectRoot).toHaveBeenCalledExactlyOnceWith(['index.php'], read)
  })
})
