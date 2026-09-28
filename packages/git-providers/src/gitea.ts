import type { GitProvider } from '@repo/domain'
import { parseGitProviderConfig, type GitProviderConfig } from './config.ts'
import { createStubGitProvider } from './stub-provider.ts'
import { parseGiteaWebhook } from './webhook.ts'

/** Our Gitea 1.27, organization `sites` (spec §10). TODO(P8): REST API client. */
export function createGiteaProvider(config: GitProviderConfig): GitProvider {
  parseGitProviderConfig('GiteaProvider', config)
  return createStubGitProvider('gitea', 'GiteaProvider', parseGiteaWebhook)
}
