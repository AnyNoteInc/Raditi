import {
  appEnvSchema,
  DIGEST_PINNED_IMAGE,
  envVar,
  isProduction,
  parseEnv,
  type Env,
} from '@repo/domain'
import { z } from 'zod'

/** One stack image for every driver, resolved by the operator before scheduling a turn. */
const image = z
  .string()
  .max(512)
  .regex(DIGEST_PINNED_IMAGE, 'expected an image pinned by digest: repository@sha256:<64 hex>')

export const agentDriverConfigSchema = z.object({ image })
export type AgentDriverConfig = z.infer<typeof agentDriverConfigSchema>

/** What .env.example and infra/app/env.example carry until an image is built: never real. */
const PLACEHOLDER_DIGEST = `@sha256:${'0'.repeat(64)}`

const envSchema = z
  .object({
    // Required, never defaulted: a missing APP_ENV must not switch the placeholder check off.
    APP_ENV: envVar(appEnvSchema),
    SANDBOX_IMAGE: envVar(image),
  })
  .refine((env) => !isProduction(env.APP_ENV) || !env.SANDBOX_IMAGE.endsWith(PLACEHOLDER_DIGEST), {
    message:
      'the all-zero digest is the env.example placeholder: set the digest of the built stack image',
    path: ['SANDBOX_IMAGE'],
  })

export function agentDriverConfigFromEnv(env: Env): AgentDriverConfig {
  return { image: parseEnv('agent drivers', envSchema, env).SANDBOX_IMAGE }
}

export function parseAgentDriverConfig(config: AgentDriverConfig): AgentDriverConfig {
  const parsed = agentDriverConfigSchema.safeParse(config)
  if (!parsed.success)
    throw new Error(`Invalid agent driver configuration:\n${z.prettifyError(parsed.error)}`)
  return parsed.data
}
