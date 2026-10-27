import {
  appEnvSchema,
  DIGEST_PINNED_IMAGE,
  envVar,
  isProduction,
  parseEnv,
  parseIpSubnet,
  type Env,
} from '@repo/domain'
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

/** One CIDR subnet in the spelling the client egress proxy reads (`84.201.128.0/18`). */
const subnet = z.string().refine((text) => parseIpSubnet(text) !== null, 'expected a CIDR subnet')

/**
 * The platform's own subnets the client egress proxies never connect to
 * (docs/plan/53-chat-preview-release.md, Р13), besides every address that is not public: the
 * public addresses of the platform's machines, which a client could point a name of its own at.
 */
export const egressRefusedSubnetsSchema = z.array(subnet).max(64)

/** `SANDBOX_EGRESS_REFUSED_SUBNETS`: comma-separated CIDR; blank — none. */
export const egressRefusedSubnetsVar = envVar(
  z
    .string()
    .transform((text) =>
      text
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(egressRefusedSubnetsSchema)
    .optional(),
)

export const gatewayConfigSchema = z
  .object({
    image,
    guardImage: image,
    llmUpstream: origin,
    mcpUpstream: origin,
    egressRefusedSubnets: egressRefusedSubnetsSchema.optional(),
  })
  .strict()

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>

const gatewayEnvSchema = z
  .object({
    SANDBOX_GATEWAY_IMAGE: envVar(image),
    SANDBOX_NETWORK_GUARD_IMAGE: envVar(image),
    SANDBOX_LLM_UPSTREAM: envVar(origin),
    SANDBOX_MCP_UPSTREAM: envVar(origin),
    SANDBOX_EGRESS_REFUSED_SUBNETS: egressRefusedSubnetsVar,
  })
  .transform((env): GatewayConfig => ({
    image: env.SANDBOX_GATEWAY_IMAGE,
    guardImage: env.SANDBOX_NETWORK_GUARD_IMAGE,
    llmUpstream: env.SANDBOX_LLM_UPSTREAM,
    mcpUpstream: env.SANDBOX_MCP_UPSTREAM,
    ...(env.SANDBOX_EGRESS_REFUSED_SUBNETS?.length
      ? { egressRefusedSubnets: env.SANDBOX_EGRESS_REFUSED_SUBNETS }
      : {}),
  }))

/**
 * The variables that turn the gateway on. The image of the host rules and the platform's subnets
 * are shared with the previews and the browser sessions (docs/plan/58): set for them alone, they
 * leave the gateway off.
 */
const GATEWAY_OWN = ['SANDBOX_GATEWAY_IMAGE', 'SANDBOX_LLM_UPSTREAM', 'SANDBOX_MCP_UPSTREAM']

/**
 * Optional only as a complete group: gateway-mode creation fails closed without it. In production
 * the group names the platform's subnets as well: the gateway's client egress proxy sits on a
 * network of the VM, and a name a client points at a public address of the platform's own would
 * otherwise be tunnelled past the perimeter (docs/plan/53-chat-preview-release.md, Р13).
 */
export function gatewayConfigFromEnv(env: Env): GatewayConfig | undefined {
  if (GATEWAY_OWN.every((name) => !env[name]?.trim())) return undefined
  const config = parseEnv('sandbox gateway', gatewayEnvSchema, env)
  const appEnv = appEnvSchema.safeParse(env.APP_ENV?.trim())
  if (appEnv.success && isProduction(appEnv.data) && !config.egressRefusedSubnets?.length)
    throw new Error(
      "[sandbox gateway] invalid configuration: SANDBOX_EGRESS_REFUSED_SUBNETS: required in production, the public subnets of the platform's machines",
    )
  return config
}
