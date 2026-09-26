import type { GitProvider } from '@repo/domain'
import { parseGitProviderConfig, type GitProviderConfig } from './config.ts'
import { createStubGitProvider } from './stub-provider.ts'
import { parseGitlabWebhook } from './webhook.ts'

/** Client repositories on GitLab (spec §10). TODO(P8): REST API client. */
export function createGitlabProvider(config: GitProviderConfig): GitProvider {
  parseGitProviderConfig('GitlabProvider', config)
  return createStubGitProvider('gitlab', 'GitlabProvider', parseGitlabWebhook)
}
