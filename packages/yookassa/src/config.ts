import { envVar, parseEnv, type Env } from '@repo/domain'
import { z } from 'zod'

export interface YookassaConfig {
  shopId: string
  /** Holds a credential: never log this object. */
  secretKey: string
}

const envSchema = z
  .object({
    YOOKASSA_SHOP_ID: envVar(z.string().regex(/^\d+$/, 'must be digits only').optional()),
    YOOKASSA_SECRET_KEY: envVar(z.string().min(8).optional()),
  })
  .superRefine((env, ctx) => {
    if ((env.YOOKASSA_SHOP_ID === undefined) !== (env.YOOKASSA_SECRET_KEY === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [env.YOOKASSA_SHOP_ID === undefined ? 'YOOKASSA_SHOP_ID' : 'YOOKASSA_SECRET_KEY'],
        message: 'YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY must be set together',
      })
    }
  })

/**
 * Reads the shop credentials. null when both are empty: payments are off (local dev, e2e).
 * The error names variables only, never values.
 */
export function yookassaConfigFromEnv(env: Env): YookassaConfig | null {
  const { YOOKASSA_SHOP_ID: shopId, YOOKASSA_SECRET_KEY: secretKey } = parseEnv(
    'yookassa',
    envSchema,
    env,
  )
  return shopId === undefined || secretKey === undefined ? null : { shopId, secretKey }
}
