import { beforeEach, describe, expect, it, vi } from 'vitest'

// The composition with everything around it replaced: the test sees what the services are built
// from and what the store they get can do.
const stand = vi.hoisted(() => ({
  vault: (() => ({ addr: 'http://vault.test', token: 'root-token-of-the-test' })) as () => unknown,
  web: (() => ({ appEnv: 'development' })) as () => unknown,
  store: {
    kvRead: vi.fn(),
    kvWrite: vi.fn(async () => ({ version: 3 })),
    kvMetadata: vi.fn(async () => null),
    kvDelete: vi.fn(),
  },
  createStore: vi.fn(),
  createServices: vi.fn((deps: unknown) => ({ built: deps })),
  rootMarkers: vi.fn(() => ['wp-config.php', 'wp-includes']),
}))

vi.mock('@/env', () => ({ env: { vault: () => stand.vault(), web: () => stand.web() } }))
vi.mock('@repo/vault', () => ({ createVaultSecretStore: stand.createStore }))
vi.mock('@repo/site-connections/services', () => ({
  createSiteConnectionServices: stand.createServices,
}))
vi.mock('@repo/site-adapters', () => ({
  connectableStacks: ['wordpress'],
  getSiteAdapter: () => ({ rootMarkers: stand.rootMarkers }),
}))

/** A new module for every test: the services are kept for the life of the module. */
const load = async () => (await import('./site-connections')).siteConnections

type Deps = {
  appEnv: string
  secrets: Record<string, (...args: unknown[]) => unknown>
  connectableStacks: readonly string[]
  rootMarkers: (stack: string) => readonly string[]
}

describe('the site connection services of web', () => {
  let error: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    stand.vault = () => ({ addr: 'http://vault.test', token: 'root-token-of-the-test' })
    stand.web = () => ({ appEnv: 'development' })
    stand.createStore.mockReturnValue(stand.store)
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('builds them once per process from the environment of the app and the stack registry', async () => {
    const siteConnections = await load()
    const first = siteConnections()
    expect(siteConnections()).toBe(first)
    expect(stand.createServices).toHaveBeenCalledTimes(1)
    expect(stand.createStore).toHaveBeenCalledExactlyOnceWith({
      addr: 'http://vault.test',
      token: 'root-token-of-the-test',
    })
    const [deps] = stand.createServices.mock.calls[0] as unknown as [Deps]
    expect(deps.appEnv).toBe('development')
    expect(deps.connectableStacks).toEqual(['wordpress'])
    expect(deps.rootMarkers('wordpress')).toEqual(['wp-config.php', 'wp-includes'])
  })

  it('hands the services a store that can write and look at metadata, and nothing else', async () => {
    ;(await load())()
    const [deps] = stand.createServices.mock.calls[0] as unknown as [Deps]
    expect(Object.keys(deps.secrets).sort()).toEqual(['kvMetadata', 'kvWrite'])
    expect(deps.secrets).not.toBe(stand.store)

    await deps.secrets.kvWrite!('kv/sites/s/ssh', { v: '1' }, { cas: 0 })
    expect(stand.store.kvWrite).toHaveBeenCalledWith('kv/sites/s/ssh', { v: '1' }, { cas: 0 })
    await deps.secrets.kvMetadata!('kv/sites/s/ssh')
    expect(stand.store.kvMetadata).toHaveBeenCalledWith('kv/sites/s/ssh')
    expect(stand.store.kvRead).not.toHaveBeenCalled()
  })

  it.each(['vault', 'web'])(
    'is off when the %s settings do not parse, and says so once without a value',
    async (section) => {
      const broken = () => {
        throw new Error(`[${section}] invalid configuration: VAULT_DEV_ROOT_TOKEN: secret-value`)
      }
      if (section === 'vault') stand.vault = broken
      else stand.web = broken

      const siteConnections = await load()
      expect(siteConnections()).toBeNull()
      expect(siteConnections()).toBeNull()
      expect(stand.createServices).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledTimes(1)
      expect(String(error.mock.calls[0]?.[0])).not.toMatch(/secret-value|VAULT_/)
    },
  )
})
