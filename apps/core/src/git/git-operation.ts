import type {
  GitAuth,
  GitGrant,
  GitProvider,
  IssuedGitAccess,
  RepoProviderKind,
  RepoRef,
} from '@repo/domain'

import { GIT_CREDENTIAL_TTL_SECONDS } from '../git-workspace/git-auth.ts'
import type { ResolvePublicHost } from './public-host.ts'

// One operation on a git host (docs/plan/84-projects.md, §4.3, §4.6): the host resolved once and
// checked, an adapter pinned to that address, and the access of the operation issued from its
// grant by the adapter — a stored token as it is, an installation of the GitHub App as a token of
// this repository and these rights only (ПР10). The same access serves the API and git, and is
// revoked when the operation ends (`close`). Nothing here compares a kind: the adapter knows its
// grant.

/** An adapter whose every request of this operation goes to `address`. */
export interface GitProviderFactory {
  (input: { kind: RepoProviderKind; host: string; address: string }): GitProvider
}

export interface GitOperation {
  address: string
  provider: GitProvider
  access: IssuedGitAccess
  auth: GitAuth
  /** Revokes the access where the provider can; never throws. */
  close(): Promise<void>
}

export async function openGitOperation(
  deps: { resolvePublic: ResolvePublicHost; provider: GitProviderFactory },
  input: {
    kind: RepoProviderKind
    host: string
    grant: GitGrant
    /** null — an operation on the whole account of the grant (a sync of its repositories). */
    repo: RepoRef | null
    access: 'read' | 'write'
    /** The access may change build workflows (ПР16): only a press the card of build settings allowed. */
    workflows?: boolean
  },
): Promise<GitOperation> {
  const address = await deps.resolvePublic(input.host)
  const provider = deps.provider({ kind: input.kind, host: input.host, address })
  const access = await provider.issueCredentials(input.grant, input.repo, input.access, {
    ttlSeconds: GIT_CREDENTIAL_TTL_SECONDS,
    ...(input.workflows ? { workflows: true } : {}),
  })
  return {
    address,
    provider,
    access,
    auth: access.auth,
    close: async () => {
      await access.revoke?.().catch(() => undefined)
    },
  }
}

/** The secret of an access the logs never keep: its bearer token, its git password. */
export function accessSecrets(access: IssuedGitAccess): string[] {
  const values: string[] = []
  if (access.auth.kind === 'bearer') values.push(access.auth.token)
  if (access.basic && !values.includes(access.basic.password)) values.push(access.basic.password)
  return values
}
