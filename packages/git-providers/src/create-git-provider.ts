import { githubHost, gitHostRefused, type GitProvider, type RepoProviderKind } from '@repo/domain'

import { parseEndpointOverride } from './api.ts'
import { createGithubProvider, githubCiPaths } from './github.ts'
import { createGitlabProvider, gitlabCiPaths } from './gitlab.ts'
import type { GitTransport } from './transport.ts'

// The one place that picks an adapter by kind (rule 8): core's GitAuthSource and web call this,
// never compare the kind themselves (docs/plan/84-projects.md, ПР11).

export interface GitProviderEndpoints {
  /** Stands only, `https://localhost:<port>`: RADITI_FAKE_GITHUB_API_URL. */
  githubApiUrl?: string
  /** Stands only, `https://localhost:<port>`: RADITI_FAKE_GITHUB_WEB_URL (the sign-in pages of github.com, Э10). */
  githubWebUrl?: string
  /** Stands only, `https://localhost:<port>`: RADITI_FAKE_GITLAB_COM_URL. */
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

/**
 * The paths of build settings of a provider (`support.ciPaths`, ПР16) without an adapter: core
 * marks a card «Изменения в ветке» as touching them before any operation on the provider.
 */
export function gitProviderCiPaths(kind: RepoProviderKind): readonly string[] {
  return kind === 'github' ? githubCiPaths : gitlabCiPaths
}
