import { envVar, IMAGE_REPOSITORY, parseEnv, type Env } from '@repo/domain'
import { z } from 'zod'

/**
 * SANDBOX_IMAGE_PREFIX: a repository without tag or digest; a driver image is `<prefix>-<driver>`.
 * TODO(P2): sandboxSpecSchema accepts only digest-pinned images, so `<prefix>-<driver>` must be
 * resolved to `…@sha256:` (Gitea registry) before a SandboxSpec is built.
 */
const imagePrefix = z
  .string()
  .regex(IMAGE_REPOSITORY, 'expected a repository without tag, e.g. raditi/agent')

export const agentDriverConfigSchema = z.object({ imagePrefix })
export type AgentDriverConfig = z.infer<typeof agentDriverConfigSchema>

const envSchema = z.object({ SANDBOX_IMAGE_PREFIX: envVar(imagePrefix) })

export function agentDriverConfigFromEnv(env: Env): AgentDriverConfig {
  return { imagePrefix: parseEnv('agent drivers', envSchema, env).SANDBOX_IMAGE_PREFIX }
}

export function parseAgentDriverConfig(config: AgentDriverConfig): AgentDriverConfig {
  const parsed = agentDriverConfigSchema.safeParse(config)
  if (!parsed.success)
    throw new Error(`Invalid agent driver configuration:\n${z.prettifyError(parsed.error)}`)
  return parsed.data
}
