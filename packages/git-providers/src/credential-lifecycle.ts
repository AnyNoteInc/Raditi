import type { GitProvider } from '@repo/domain'

/**
 * For an adapter that enforces the lifetime of its credentials itself (GitCredentials are
 * short-lived, spec §10): what the process that issues them owes at its start and at its stop.
 * A provider whose credentials expire on the server has nothing to do in either.
 */
export interface GitCredentialLifecycle {
  /** Ends the expired credentials earlier processes left behind. Rejects if it could not. */
  sweepCredentials(): Promise<void>
  /** Ends, before their term, the credentials this process issued. Rejects if it could not. */
  revokeCredentials(): Promise<void>
}

export type ManagedGitProvider = GitProvider & GitCredentialLifecycle

/** GitHub and GitLab issue nothing until P8. */
export const issuesNoCredentials: GitCredentialLifecycle = {
  async sweepCredentials() {},
  async revokeCredentials() {},
}
