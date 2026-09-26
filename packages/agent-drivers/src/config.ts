import { z } from 'zod'

export const agentDriverConfigSchema = z.object({
  /**
   * SANDBOX_IMAGE_PREFIX; a driver image is `<prefix>-<driver>`.
   * TODO(P2): pin by digest in the Gitea registry, `registry/raditi/sbx-…@sha256:…`. The sandbox
   * config forbids a digest in the prefix today, so `AgentDriver.image` is not pinned yet and
   * sandboxSpecSchema (@repo/domain) would refuse it: P2 resolves the digest per driver.
   */
  imagePrefix: z.string().min(1),
})
export type AgentDriverConfig = z.infer<typeof agentDriverConfigSchema>

export function parseAgentDriverConfig(config: AgentDriverConfig): AgentDriverConfig {
  const parsed = agentDriverConfigSchema.safeParse(config)
  if (!parsed.success) {
    throw new Error(`Invalid agent driver configuration:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}
