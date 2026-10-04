import { z } from 'zod'

export const gitProviderConfigSchema = z.object({
  /** API root: GITEA_URL for Gitea, https://api.github.com, https://gitlab.com. */
  baseUrl: z.url({ protocol: /^https?$/ }),
  /**
   * Bot token, read from Vault in production (CLAUDE.md rule 2). Webhook parsing needs none;
   * the Gitea API refuses to run without one or over plain http (gitea-client.ts).
   * TODO(P8): require it for GitHub and GitLab with their API clients.
   */
  token: z.string(),
})
export type GitProviderConfig = z.infer<typeof gitProviderConfigSchema>

export function parseGitProviderConfig(
  label: string,
  config: GitProviderConfig,
): GitProviderConfig {
  const parsed = gitProviderConfigSchema.safeParse(config)
  if (!parsed.success) {
    throw new Error(`Invalid ${label} configuration:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}
