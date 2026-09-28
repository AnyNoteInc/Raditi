/**
 * Git provider port — spec §10. Site code lives in our Gitea or in the client's GitHub/GitLab.
 * Git credentials never enter the sandbox: the platform publishes from a clean clone.
 * Paths an agent diff may not touch (DiffPolicy) live in policies/diff-paths.ts.
 */
export const gitProviderKinds = ['gitea', 'github', 'gitlab'] as const
export type GitProviderKind = (typeof gitProviderKinds)[number]

export interface RepoRef {
  provider: GitProviderKind
  owner: string
  name: string
}

export interface RepositoryInfo {
  ref: RepoRef
  defaultBranch: string
  cloneUrl: string
  private: boolean
}

/** Short-lived credentials for one clone or push by the platform's bot. */
export interface GitCredentials {
  username: string
  token: string
  expiresAt: Date
}

export interface PullRequest {
  number: number
  url: string
  headBranch: string
  headSha: string
  baseBranch: string
  state: 'open' | 'merged' | 'closed'
}

export interface WorkflowRun {
  id: string
  name: string
  headSha: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | null
  url: string
}

/** Provider webhooks normalized to what the orchestrator needs. */
export type GitWebhookEvent =
  | { kind: 'pull_request'; repo: RepoRef; pullRequest: PullRequest }
  | { kind: 'workflow_run'; repo: RepoRef; run: WorkflowRun }
  | { kind: 'push'; repo: RepoRef; branch: string; headSha: string }

export interface GitProvider {
  readonly kind: GitProviderKind
  getRepository(ref: RepoRef): Promise<RepositoryInfo | null>
  issueCredentials(
    ref: RepoRef,
    access: 'read' | 'write',
    ttlSeconds: number,
  ): Promise<GitCredentials>
  openPullRequest(
    ref: RepoRef,
    input: { head: string; base: string; title: string; body: string },
  ): Promise<PullRequest>
  getPullRequest(ref: RepoRef, number: number): Promise<PullRequest | null>
  /** Merges only if the head is still `expectedHeadSha`. */
  mergePullRequest(
    ref: RepoRef,
    number: number,
    expectedHeadSha: string,
  ): Promise<{ mergeSha: string }>
  closePullRequest(ref: RepoRef, number: number): Promise<void>
  setActionsSecret(ref: RepoRef, name: string, value: string): Promise<void>
  deleteActionsSecret(ref: RepoRef, name: string): Promise<void>
  setActionsVariable(ref: RepoRef, name: string, value: string): Promise<void>
  /** Polling fallback when a webhook is lost. */
  listWorkflowRuns(
    ref: RepoRef,
    filter: { headSha?: string; branch?: string },
  ): Promise<WorkflowRun[]>
  /**
   * The only way in for a webhook: first the timing-safe signature check on the raw body
   * (X-Gitea-Signature, X-Hub-Signature-256, X-Gitlab-Token), then JSON.parse and a zod schema
   * of the provider event. Any failure — bad or missing signature, malformed JSON, an unknown
   * or unsupported event — yields null; it never throws. There is deliberately no way to parse
   * an event without the signature check.
   */
  parseWebhook(headers: Headers, rawBody: string, secret: string): GitWebhookEvent | null
}
