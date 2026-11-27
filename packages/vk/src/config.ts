import { appEnvSchema, envVar, isProduction, parseEnv, type Env } from '@repo/domain'
import { z } from 'zod'

// The settings of VK the apps share (docs/plan/99-vk-community.md, §3.3): the HMAC of the cards of
// VK. web signs a press by it, core checks every press again before it calls VK.

export interface VkConfig {
  /**
   * VK_CONFIRM_SECRET. null only in production without it: then no card publishes and no action
   * runs; outside production an empty one is a value for development.
   */
  confirmSecret: string | null
}

/** VK_CONFIRM_SECRET outside production when none is set: never a secret of a server. */
export const DEV_VK_CONFIRM_SECRET = 'raditi-development-vk-confirm-secret-not-for-production'

const schema = z
  .object({
    APP_ENV: envVar(appEnvSchema),
    VK_CONFIRM_SECRET: envVar(
      z.string().regex(/^\S+$/, 'must be one word without whitespace').max(4096).optional(),
    ),
  })
  .superRefine((env, ctx) => {
    if (env.VK_CONFIRM_SECRET !== undefined && env.VK_CONFIRM_SECRET.length < 32)
      ctx.addIssue({
        code: 'custom',
        path: ['VK_CONFIRM_SECRET'],
        message: 'must be at least 32 characters',
      })
  })

export function vkConfigFromEnv(env: Env): VkConfig {
  const e = parseEnv('vk', schema, env)
  return {
    confirmSecret:
      e.VK_CONFIRM_SECRET ?? (isProduction(e.APP_ENV) ? null : DEV_VK_CONFIRM_SECRET),
  }
}
