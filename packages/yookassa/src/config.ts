import { z } from 'zod'

export interface YookassaConfig {
  shopId: string
  /** Holds a credential: never log this object. */
  secretKey: string
}

const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

const envSchema = z.object({
  YOOKASSA_SHOP_ID: z.preprocess(blankToUndefined, z.string().regex(/^\d+$/).optional()),
  YOOKASSA_SECRET_KEY: z.preprocess(blankToUndefined, z.string().min(8).optional()),
})

/**
 * Reads the shop credentials. null when both are empty: payments are off (local dev, e2e).
 * The error names variables only, never values.
 */
export function yookassaConfigFromEnv(
  env: Record<string, string | undefined>,
): YookassaConfig | null {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))]
    throw new Error(`[@repo/yookassa] invalid ЮKassa configuration: ${names.join(', ')}`)
  }
  const { YOOKASSA_SHOP_ID: shopId, YOOKASSA_SECRET_KEY: secretKey } = parsed.data
  if (shopId === undefined && secretKey === undefined) return null
  if (shopId === undefined || secretKey === undefined) {
    throw new Error(
      '[@repo/yookassa] invalid ЮKassa configuration: YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY must be set together',
    )
  }
  return { shopId, secretKey }
}
