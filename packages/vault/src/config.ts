import { appEnvSchema, isProduction } from '@repo/domain'
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

const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

const optionalSecret = z.preprocess(blankToUndefined, z.string().optional())

const envSchema = z
  .object({
    APP_ENV: appEnvSchema,
    VAULT_ADDR: z.preprocess(blankToUndefined, z.url({ protocol: /^https?$/ })),
    VAULT_ROLE_ID: optionalSecret,
    VAULT_SECRET_ID: optionalSecret,
    VAULT_DEV_ROOT_TOKEN: optionalSecret,
  })
  .superRefine((env, ctx) => {
    if ((env.VAULT_ROLE_ID === undefined) !== (env.VAULT_SECRET_ID === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['VAULT_SECRET_ID'],
        message: 'VAULT_ROLE_ID and VAULT_SECRET_ID must be set together',
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
export function vaultConfigFromEnv(env: Record<string, string | undefined>): VaultConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    throw new Error(`[@repo/vault] invalid Vault configuration: ${problems.join('; ')}`)
  }
  const e = parsed.data
  const config: VaultConfig = { addr: e.VAULT_ADDR }
  if (e.VAULT_ROLE_ID !== undefined && e.VAULT_SECRET_ID !== undefined) {
    config.appRole = { roleId: e.VAULT_ROLE_ID, secretId: e.VAULT_SECRET_ID }
  }
  if (e.VAULT_DEV_ROOT_TOKEN !== undefined) config.token = e.VAULT_DEV_ROOT_TOKEN
  return config
}
