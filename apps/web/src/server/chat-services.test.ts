import type * as StorageModule from '@repo/storage'
import type * as VaultModule from '@repo/vault'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The module with the settings and the client factories replaced: the test sees what the dialog
// services of the process are built from and when.
const stand = vi.hoisted(() => ({
  webEnv: vi.fn(),
  authEnv: vi.fn(),
  storageEnv: vi.fn(),
  vaultEnv: vi.fn(),
  createS3ObjectStorage: vi.fn(),
  createVaultSecretStore: vi.fn(),
  storage: { name: 'artifacts' },
  secrets: { name: 'vault' },
}))

vi.mock('@/env', () => ({
  env: { web: stand.webEnv, auth: stand.authEnv, storage: stand.storageEnv, vault: stand.vaultEnv },
}))
vi.mock('@repo/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof StorageModule>()),
  createS3ObjectStorage: stand.createS3ObjectStorage,
}))
vi.mock('@repo/vault', async (importOriginal) => ({
  ...(await importOriginal<typeof VaultModule>()),
  createVaultSecretStore: stand.createVaultSecretStore,
}))

const ADDRESS = { baseDomain: 'localhost', scheme: 'http', publicPort: 8090 } as const

describe('the dialog services of the process', () => {
  // The first import transforms the module's whole graph (@repo/trpc, the S3 and Vault clients):
  // about a second alone, more than the 5 s limit of a test while the suite loads every core.
  // It is paid once here, under a limit of its own. Each test still evaluates the module afresh
  // (vi.resetModules) within the usual limit, so a module that hangs on import fails as before.
  beforeAll(async () => {
    await import('./chat-services')
  }, 60_000)

  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    stand.webEnv.mockReset().mockReturnValue({ appEnv: 'development', preview: ADDRESS })
    stand.authEnv.mockReset().mockReturnValue({ secret: 'a'.repeat(48) })
    stand.storageEnv.mockReset().mockReturnValue({ name: 'storage settings' })
    stand.vaultEnv.mockReset().mockReturnValue({ name: 'vault settings' })
    stand.createS3ObjectStorage.mockReset().mockReturnValue(stand.storage)
    stand.createVaultSecretStore.mockReset().mockReturnValue(stand.secrets)
  })

  it('reads nothing when the module is imported', async () => {
    await import('./chat-services')
    expect(stand.webEnv).not.toHaveBeenCalled()
    expect(stand.authEnv).not.toHaveBeenCalled()
  })

  it('carries the environment, the address of previews with their life and the key of confirmations', async () => {
    vi.stubEnv('PREVIEW_TTL_HOURS', '48')
    const { chatServices } = await import('./chat-services')
    const { releaseConfirmKey } = await import('@repo/trpc')

    const chat = chatServices()

    expect(chat).toMatchObject({
      appEnv: 'development',
      preview: { address: ADDRESS, ttlHours: 48 },
      releaseConfirmKey: releaseConfirmKey('a'.repeat(48)),
    })
    expect(chatServices()).toBe(chat)
  })

  it('takes the life of a preview of core when it is not set, and no previews when they are off', async () => {
    vi.stubEnv('PREVIEW_TTL_HOURS', '')
    stand.webEnv.mockReturnValue({ appEnv: 'test', preview: null })
    const { chatServices, previewTtlHours } = await import('./chat-services')

    expect(chatServices()?.preview).toBeNull()
    expect(previewTtlHours({})).toBe(72)
    expect(() => previewTtlHours({ PREVIEW_TTL_HOURS: '0' })).toThrow(/PREVIEW_TTL_HOURS/)
  })

  it('makes the clients of S3 and Vault only when a procedure needs them, once', async () => {
    const { chatServices } = await import('./chat-services')
    const chat = chatServices()!
    expect(stand.createS3ObjectStorage).not.toHaveBeenCalled()
    expect(stand.createVaultSecretStore).not.toHaveBeenCalled()

    expect(chat.storage()).toBe(stand.storage)
    expect(chat.storage()).toBe(stand.storage)
    expect(chat.secrets()).toBe(stand.secrets)
    expect(stand.createS3ObjectStorage).toHaveBeenCalledExactlyOnceWith({
      name: 'storage settings',
    })
    expect(stand.createVaultSecretStore).toHaveBeenCalledExactlyOnceWith({ name: 'vault settings' })
  })

  it('is null while a section does not parse, logs it, and is read again on the next request', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    stand.authEnv.mockImplementationOnce(() => {
      throw new Error('Invalid auth configuration: BETTER_AUTH_SECRET is required')
    })
    const { chatServices } = await import('./chat-services')

    expect(chatServices()).toBeNull()
    expect(log).toHaveBeenCalledOnce()
    expect(chatServices()).not.toBeNull()
    log.mockRestore()
  })
})
