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
  /**
   * YOOKASSA_AUTOPAYMENTS: whether the shop may save a payment method and charge it without the
   * buyer. ЮKassa switches that on for a shop on request, and until then answers 403 to a
   * payment that asks to save its method. false — one-time payments only: no payment asks to
   * save a method, none is bound, and auto-renewal is not offered.
   */
  autopayments: boolean
}

/** YOOKASSA_AUTOPAYMENTS: `on` — the shop saves payment methods and charges them, `off` — not. */
const autopaymentsValues = ['on', 'off'] as const

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
    YOOKASSA_AUTOPAYMENTS: envVar(
      z.enum(autopaymentsValues, { error: 'must be on or off' }).optional(),
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
    if (isProduction(env.APP_ENV)) {
      // Both exist for the local fake only: production calls the real API and trusts nothing but
      // the published ranges, whether or not payments are switched on.
      if (env.YOOKASSA_API_URL !== undefined) {
        issue('YOOKASSA_API_URL', 'not allowed in production (the real API address is built in)')
      }
      if (env.YOOKASSA_WEBHOOK_ALLOWLIST !== undefined) {
        issue(
          'YOOKASSA_WEBHOOK_ALLOWLIST',
          'not allowed in production (notifications come from the published ranges only)',
        )
      }
      // Never guessed for a real shop: `on` at a shop without the approval refuses every
      // customer who ticks auto-renewal, `off` at a shop that has it sells no renewal at all.
      if (
        env.YOOKASSA_SHOP_ID !== undefined &&
        env.YOOKASSA_SECRET_KEY !== undefined &&
        env.YOOKASSA_AUTOPAYMENTS === undefined
      ) {
        issue(
          'YOOKASSA_AUTOPAYMENTS',
          'must be set to on or off in production (YooKassa answers 403 to save_payment_method ' +
            'until its manager approves autopayments for the shop)',
        )
      }
    }
  })

/**
 * Reads the shop settings. null when both credentials are empty: payments are off (local dev,
 * e2e), and the two development-only variables and the switch of autopayments are then checked
 * but not used. The switch is `on` unless set outside production — a local fake saves methods —
 * and has no default for a shop in production. The error names variables only, never values.
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
    autopayments: (e.YOOKASSA_AUTOPAYMENTS ?? 'on') === 'on',
  }
}
