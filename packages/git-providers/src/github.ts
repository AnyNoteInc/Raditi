import type { GitProvider } from '@repo/domain'
import { parseGitProviderConfig, type GitProviderConfig } from './config.ts'
import { createStubGitProvider } from './stub-provider.ts'
import { parseGithubWebhook } from './webhook.ts'

/** Client repositories on GitHub (spec §10). TODO(P8): API client, likely a GitHub App. */
export function createGithubProvider(config: GitProviderConfig): GitProvider {
  parseGitProviderConfig('GithubProvider', config)
  return createStubGitProvider('github', 'GithubProvider', parseGithubWebhook)
}
