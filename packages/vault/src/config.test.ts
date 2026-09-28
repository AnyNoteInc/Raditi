import { describe, expect, it } from 'vitest'

import { vaultConfigFromEnv } from './config.ts'

describe('vaultConfigFromEnv', () => {
  it('reads the local dev setup from .env.example', () => {
    expect(
      vaultConfigFromEnv({
        APP_ENV: 'development',
        VAULT_ADDR: 'http://localhost:8200',
        VAULT_DEV_ROOT_TOKEN: 'raditi-dev-root',
        VAULT_ROLE_ID: '',
        VAULT_SECRET_ID: '',
      }),
    ).toEqual({ addr: 'http://localhost:8200', token: 'raditi-dev-root' })
  })

  it('reads an AppRole', () => {
    expect(
      vaultConfigFromEnv({
        APP_ENV: 'production',
        VAULT_ADDR: 'https://vault.internal:8200',
        VAULT_ROLE_ID: 'role-1',
        VAULT_SECRET_ID: 'secret-1',
      }),
    ).toEqual({
      addr: 'https://vault.internal:8200',
      appRole: { roleId: 'role-1', secretId: 'secret-1' },
    })
  })

  it('requires VAULT_ADDR to be an http(s) URL', () => {
    expect(() => vaultConfigFromEnv({ APP_ENV: 'development' })).toThrow(/VAULT_ADDR/)
    expect(() => vaultConfigFromEnv({ APP_ENV: 'development', VAULT_ADDR: 'vault:8200' })).toThrow(
      /VAULT_ADDR/,
    )
  })

  it.each([
    ['missing', undefined],
    ['blank', ''],
    ['misspelt', 'prod'],
  ])('refuses a %s APP_ENV instead of assuming development', (_case, APP_ENV) => {
    expect(() =>
      vaultConfigFromEnv({
        APP_ENV,
        VAULT_ADDR: 'http://localhost:8200',
        VAULT_DEV_ROOT_TOKEN: 'raditi-dev-root',
      }),
    ).toThrow('[vault] invalid configuration: APP_ENV: must be one of')
  })

  it('requires role id and secret id together', () => {
    expect(() =>
      vaultConfigFromEnv({
        APP_ENV: 'development',
        VAULT_ADDR: 'http://localhost:8200',
        VAULT_ROLE_ID: 'role-1',
      }),
    ).toThrow('VAULT_SECRET_ID: must be set together with VAULT_ROLE_ID')
  })

  it('requires https in production', () => {
    const production = {
      APP_ENV: 'production',
      VAULT_ROLE_ID: 'role-1',
      VAULT_SECRET_ID: 'secret-1',
    }
    expect(() =>
      vaultConfigFromEnv({ ...production, VAULT_ADDR: 'http://vault.internal:8200' }),
    ).toThrow(/VAULT_ADDR: must use https in production/)
    expect(
      vaultConfigFromEnv({ ...production, VAULT_ADDR: 'https://vault.internal:8200' }).addr,
    ).toBe('https://vault.internal:8200')
  })

  it('refuses the dev root token in production and never echoes it', () => {
    let message = ''
    try {
      vaultConfigFromEnv({
        APP_ENV: 'production',
        VAULT_ADDR: 'https://vault.internal:8200',
        VAULT_ROLE_ID: 'role-1',
        VAULT_SECRET_ID: 'secret-1',
        VAULT_DEV_ROOT_TOKEN: 'hvs.very-secret-root',
      })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('VAULT_DEV_ROOT_TOKEN')
    expect(message).not.toContain('hvs.very-secret-root')
    expect(message).not.toContain('secret-1')
  })

  it('requires AppRole in production', () => {
    expect(() =>
      vaultConfigFromEnv({ APP_ENV: 'production', VAULT_ADDR: 'https://vault.internal:8200' }),
    ).toThrow(/AppRole/)
  })
})
