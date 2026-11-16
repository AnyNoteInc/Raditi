import { githubHost, gitHostRefused, type GitProvider, type RepoProviderKind } from '@repo/domain'

import { parseEndpointOverride } from './api.ts'
import { createGithubProvider } from './github.ts'
import { createGitlabProvider } from './gitlab.ts'
import type { GitTransport } from './transport.ts'

// The one place that picks an adapter by kind (rule 8): core's GitAuthSource and web call this,
// never compare the kind themselves (docs/plan/84-projects.md, ПР11).

export interface GitProviderEndpoints {
  /** Stands only, `https://localhost:<port>`: GITHUB_API_URL. */
  githubApiUrl?: string
  /** Stands only, `https://localhost:<port>`: GITHUB_WEB_URL (the sign-in pages of github.com, Э10). */
  githubWebUrl?: string
  /** Stands only, `https://localhost:<port>`: GITLAB_COM_URL. */
  gitlabComUrl?: string
}

export interface CreateGitProviderInput {
  kind: RepoProviderKind
  host: string
  transport: GitTransport
  endpoints?: GitProviderEndpoints
}

export function createGitProvider(input: CreateGitProviderInput): GitProvider {
  const { kind, host, transport, endpoints = {} } = input
  if (kind === 'github') {
    if (host !== githubHost) throw gitHostRefused()
    return createGithubProvider({
      transport,
      apiUrl: parseEndpointOverride(endpoints.githubApiUrl),
    })
  }
  return createGitlabProvider({
    host,
    transport,
    baseUrl: host === 'gitlab.com' ? parseEndpointOverride(endpoints.gitlabComUrl) : null,
  })
}
