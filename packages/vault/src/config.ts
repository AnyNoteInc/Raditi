import { appEnvSchema, envVar, isProduction, parseEnv, type Env } from '@repo/domain'
import { z } from 'zod'

export interface VaultAppRole {
  roleId: string
  secretId: string
}

/**
 * How a service reaches Vault/OpenBao (spec §15). Services log in with their own AppRole;
 * `token` is the dev-mode root token and exists only for local development.
 * Holds credentials: never log this object.
 */
export interface VaultConfig {
  addr: string
  token?: string
  appRole?: VaultAppRole
}

const optionalSecret = envVar(z.string().optional())

const envSchema = z
  .object({
    APP_ENV: envVar(appEnvSchema),
    VAULT_ADDR: envVar(z.url({ protocol: /^https?$/ })),
    VAULT_ROLE_ID: optionalSecret,
    VAULT_SECRET_ID: optionalSecret,
    VAULT_DEV_ROOT_TOKEN: optionalSecret,
  })
  .superRefine((env, ctx) => {
    if ((env.VAULT_ROLE_ID === undefined) !== (env.VAULT_SECRET_ID === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['VAULT_SECRET_ID'],
        message: 'must be set together with VAULT_ROLE_ID',
      })
    }
    if (isProduction(env.APP_ENV)) {
      // AppRole secret ids and tokens must not cross the network in clear text.
      if (!env.VAULT_ADDR.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['VAULT_ADDR'],
          message: 'must use https in production',
        })
      }
      if (env.VAULT_DEV_ROOT_TOKEN !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['VAULT_DEV_ROOT_TOKEN'],
          message: 'the dev root token is not allowed in production',
        })
      }
      if (env.VAULT_ROLE_ID === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['VAULT_ROLE_ID'],
          message: 'services log in by AppRole in production',
        })
      }
    }
  })

/** Reads the Vault settings from an env-like object; the error never contains values. */
export function vaultConfigFromEnv(env: Env): VaultConfig {
  const e = parseEnv('vault', envSchema, env)
  const config: VaultConfig = { addr: e.VAULT_ADDR }
  if (e.VAULT_ROLE_ID !== undefined && e.VAULT_SECRET_ID !== undefined) {
    config.appRole = { roleId: e.VAULT_ROLE_ID, secretId: e.VAULT_SECRET_ID }
  }
  if (e.VAULT_DEV_ROOT_TOKEN !== undefined) config.token = e.VAULT_DEV_ROOT_TOKEN
  return config
}
