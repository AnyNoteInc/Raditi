import { DIGEST_PINNED_IMAGE, envVar, parseEnv, type Env } from '@repo/domain'
import { z } from 'zod'

const image = z.string().regex(DIGEST_PINNED_IMAGE)
const origin = z.url().refine((value) => {
  try {
    const url = new URL(value)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/'
    )
  } catch {
    return false
  }
}, 'expected an HTTP(S) origin without credentials or path')

export const gatewayConfigSchema = z
  .object({
    image,
    guardImage: image,
    llmUpstream: origin,
    mcpUpstream: origin,
  })
  .strict()

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>

const gatewayEnvSchema = z
  .object({
    SANDBOX_GATEWAY_IMAGE: envVar(image),
    SANDBOX_NETWORK_GUARD_IMAGE: envVar(image),
    SANDBOX_LLM_UPSTREAM: envVar(origin),
    SANDBOX_MCP_UPSTREAM: envVar(origin),
  })
  .transform((env): GatewayConfig => ({
    image: env.SANDBOX_GATEWAY_IMAGE,
    guardImage: env.SANDBOX_NETWORK_GUARD_IMAGE,
    llmUpstream: env.SANDBOX_LLM_UPSTREAM,
    mcpUpstream: env.SANDBOX_MCP_UPSTREAM,
  }))

/** Optional only as a complete group: gateway-mode creation fails closed without it. */
export function gatewayConfigFromEnv(env: Env): GatewayConfig | undefined {
  const names = Object.keys(gatewayEnvSchema.in.shape)
  if (names.every((name) => !env[name]?.trim())) return undefined
  return parseEnv('sandbox gateway', gatewayEnvSchema, env)
}
