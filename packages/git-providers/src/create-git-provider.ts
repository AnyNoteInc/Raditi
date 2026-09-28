import type { GitProvider, GitProviderKind } from '@repo/domain'
import { badRequest } from '@repo/domain'
import type { GitProviderConfig } from './config.ts'
import { createGiteaProvider } from './gitea.ts'
import { createGithubProvider } from './github.ts'
import { createGitlabProvider } from './gitlab.ts'

export function createGitProvider(kind: GitProviderKind, config: GitProviderConfig): GitProvider {
  switch (kind) {
    case 'gitea':
      return createGiteaProvider(config)
    case 'github':
      return createGithubProvider(config)
    case 'gitlab':
      return createGitlabProvider(config)
    default: {
      // `kind` may come from the database as a plain string.
      const unknown: never = kind
      throw badRequest(`Unknown git provider: ${String(unknown)}`)
    }
  }
}
