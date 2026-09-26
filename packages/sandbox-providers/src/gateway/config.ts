import { z } from 'zod'

const image = z
  .string()
  .regex(
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+(?=\/))?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/,
  )
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

/** Optional only as a complete group: gateway-mode creation fails closed without it. */
export function gatewayConfigFromEnv(
  env: Record<string, string | undefined>,
): GatewayConfig | undefined {
  const values = [
    env.SANDBOX_GATEWAY_IMAGE,
    env.SANDBOX_NETWORK_GUARD_IMAGE,
    env.SANDBOX_LLM_UPSTREAM,
    env.SANDBOX_MCP_UPSTREAM,
  ]
  if (values.every((value) => !value)) return undefined
  const parsed = gatewayConfigSchema.safeParse({
    image: env.SANDBOX_GATEWAY_IMAGE,
    guardImage: env.SANDBOX_NETWORK_GUARD_IMAGE,
    llmUpstream: env.SANDBOX_LLM_UPSTREAM,
    mcpUpstream: env.SANDBOX_MCP_UPSTREAM,
  })
  if (!parsed.success) throw new Error('Invalid sandbox gateway configuration')
  return parsed.data
}
