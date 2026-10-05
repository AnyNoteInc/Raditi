import type { GitProviderKind } from '@repo/domain'
import { badRequest } from '@repo/domain'
import type { GitProviderConfig } from './config.ts'
import { issuesNoCredentials, type ManagedGitProvider } from './credential-lifecycle.ts'
import { createGiteaProvider, type GiteaProviderOptions } from './gitea.ts'
import { createGithubProvider } from './github.ts'
import { createGitlabProvider } from './gitlab.ts'

/** Adapter-side options: a `fetch` for tests and a request timeout. */
export type GitProviderOptions = GiteaProviderOptions

export function createGitProvider(
  kind: GitProviderKind,
  config: GitProviderConfig,
  options: GitProviderOptions = {},
): ManagedGitProvider {
  switch (kind) {
    case 'gitea':
      return createGiteaProvider(config, options)
    case 'github':
      return { ...createGithubProvider(config), ...issuesNoCredentials }
    case 'gitlab':
      return { ...createGitlabProvider(config), ...issuesNoCredentials }
    default: {
      // `kind` may come from the database as a plain string.
      const unknown: never = kind
      throw badRequest(`Unknown git provider: ${String(unknown)}`)
    }
  }
}
