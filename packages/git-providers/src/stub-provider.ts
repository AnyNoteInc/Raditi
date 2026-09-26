import type { GitProvider, GitProviderKind } from '@repo/domain'
import { notImplemented } from '@repo/domain'

/**
 * B3 stub: every API call rejects with NOT_IMPLEMENTED until P8; only webhook parsing is real
 * (signature first, then the event schema), because it guards a public endpoint.
 */
export function createStubGitProvider(
  kind: GitProviderKind,
  label: string,
  parseWebhook: GitProvider['parseWebhook'],
): GitProvider {
  const todo = (method: string) => notImplemented(`${label}.${method} (P8)`)
  return {
    kind,
    async getRepository() {
      throw todo('getRepository')
    },
    async issueCredentials() {
      throw todo('issueCredentials')
    },
    async openPullRequest() {
      throw todo('openPullRequest')
    },
    async getPullRequest() {
      throw todo('getPullRequest')
    },
    async mergePullRequest() {
      throw todo('mergePullRequest')
    },
    async closePullRequest() {
      throw todo('closePullRequest')
    },
    async setActionsSecret() {
      throw todo('setActionsSecret')
    },
    async deleteActionsSecret() {
      throw todo('deleteActionsSecret')
    },
    async setActionsVariable() {
      throw todo('setActionsVariable')
    },
    async listWorkflowRuns() {
      throw todo('listWorkflowRuns')
    },
    parseWebhook,
  }
}
