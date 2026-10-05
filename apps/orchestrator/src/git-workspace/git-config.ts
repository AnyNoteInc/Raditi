import {
  createGitProvider,
  type GitProviderOptions,
  type ManagedGitProvider,
} from '@repo/git-providers'

import type { GitConfig } from '../config/config.ts'
import type { GitWorkspaceOptions } from './git-workspace.service.ts'

// What CoreConfig.git turns into. Plain functions without Nest: the module and the Gitea stand
// (infra/dev/gitea-verify) compose git the same way.

export const configuredGitProvider = (
  git: GitConfig,
  options: GitProviderOptions = {},
): ManagedGitProvider =>
  createGitProvider(git.kind, { baseUrl: git.baseUrl, token: git.token }, options)

/** HTTPS only, and only to the origin of the configured provider (spec §19). */
export const gitWorkspaceOptions = (git: GitConfig): GitWorkspaceOptions => ({
  transport: {
    kind: 'https',
    allowedOrigins: [new URL(git.baseUrl).origin],
    ...(git.caFile === null ? {} : { caFile: git.caFile }),
  },
})
