import { appEnvSchema, envVar, isProduction, parseEnv, type Env } from '@repo/domain'
import { z } from 'zod'

import { isIpAllowlistEntry } from './webhook.ts'

export interface YookassaConfig {
  shopId: string
  /** Holds a credential: never log this object. */
  secretKey: string
  /** API root of a local fake, without a trailing slash. Unset, the client calls the real API. */
  baseUrl?: string
  /**
   * Addresses notifications are accepted from instead of the published ЮKassa ranges: a local
   * fake sends from loopback. Never empty; never set in production.
   */
  webhookAllowlist?: readonly string[]
}

const envSchema = z
  .object({
    // Required, never defaulted: a missing APP_ENV must not switch the production checks off.
    APP_ENV: envVar(appEnvSchema),
    YOOKASSA_SHOP_ID: envVar(z.string().regex(/^\d+$/, 'must be digits only').optional()),
    YOOKASSA_SECRET_KEY: envVar(z.string().min(8).optional()),
    YOOKASSA_API_URL: envVar(
      z
        .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
        .transform((url) => url.replace(/\/+$/, ''))
        .optional(),
    ),
    YOOKASSA_WEBHOOK_ALLOWLIST: envVar(
      z
        .string()
        .transform((list) => list.split(',').map((entry) => entry.trim()))
        // No blank entries either: an empty list allows every sender outside production.
        .refine(
          (entries) => entries.every(isIpAllowlistEntry),
          'must be IP addresses or CIDR ranges separated by commas',
        )
        .optional(),
    ),
  })
  .superRefine((env, ctx) => {
    const issue = (name: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [name], message })
    if ((env.YOOKASSA_SHOP_ID === undefined) !== (env.YOOKASSA_SECRET_KEY === undefined)) {
      issue(
        env.YOOKASSA_SHOP_ID === undefined ? 'YOOKASSA_SHOP_ID' : 'YOOKASSA_SECRET_KEY',
        'YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY must be set together',
      )
    }
    // zod runs this even after a failed format check, so the value may not be a URL at all.
    if (env.YOOKASSA_API_URL !== undefined && URL.canParse(env.YOOKASSA_API_URL)) {
      const url = new URL(env.YOOKASSA_API_URL)
      // The client appends paths to it and sends the shop key to whatever it names.
      if (url.username || url.password || url.search || url.hash) {
        issue('YOOKASSA_API_URL', 'expected an address without credentials, query or fragment')
      }
    }
    // Both exist for the local fake only: production calls the real API and trusts nothing but
    // the published ranges, whether or not payments are switched on.
    if (isProduction(env.APP_ENV)) {
      if (env.YOOKASSA_API_URL !== undefined) {
        issue('YOOKASSA_API_URL', 'not allowed in production (the real API address is built in)')
      }
      if (env.YOOKASSA_WEBHOOK_ALLOWLIST !== undefined) {
        issue(
          'YOOKASSA_WEBHOOK_ALLOWLIST',
          'not allowed in production (notifications come from the published ranges only)',
        )
      }
    }
  })

/**
 * Reads the shop settings. null when both credentials are empty: payments are off (local dev,
 * e2e), and the two development-only variables are then checked but not used.
 * The error names variables only, never values.
 */
export function yookassaConfigFromEnv(env: Env): YookassaConfig | null {
  const e = parseEnv('yookassa', envSchema, env)
  if (e.YOOKASSA_SHOP_ID === undefined || e.YOOKASSA_SECRET_KEY === undefined) return null
  return {
    shopId: e.YOOKASSA_SHOP_ID,
    secretKey: e.YOOKASSA_SECRET_KEY,
    ...(e.YOOKASSA_API_URL === undefined ? {} : { baseUrl: e.YOOKASSA_API_URL }),
    ...(e.YOOKASSA_WEBHOOK_ALLOWLIST === undefined
      ? {}
      : { webhookAllowlist: e.YOOKASSA_WEBHOOK_ALLOWLIST }),
  }
}
