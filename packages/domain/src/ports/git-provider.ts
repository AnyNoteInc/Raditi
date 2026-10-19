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

export type WorkflowStatus = 'queued' | 'in_progress' | 'completed'
/** Anything that is not clearly a success is a failure: an unknown one never passes a deploy. */
export type WorkflowConclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | null

export interface WorkflowRun {
  id: string
  /**
   * A label for logs and screens, never an identifier: sources disagree. A Gitea webhook gives
   * the workflow's `name:` (its file when it has none), the REST API only the file. Identify the
   * workflow by `workflowFile` (and `workflowPath` where known) with `ref` and `event`, a run
   * by `id`.
   */
  name: string
  headSha: string
  status: WorkflowStatus
  conclusion: WorkflowConclusion
  url: string
  /** The workflow file as the run names it, without the ref: `deploy.yml`. */
  workflowFile: string | null
  /**
   * The repository path of the workflow file, `.gitea/scoped_workflows/deploy.yml` for the
   * obligatory workflow of platform/ci: the one field that tells it from a file of the site
   * repository. A webhook carries it; the Gitea REST run does not (null).
   */
  workflowPath: string | null
  /** The full ref the run is for: `refs/tags/v1.2.0`, `refs/heads/main`. */
  ref: string | null
  /** What started the run: `push`, `workflow_dispatch`, `pull_request`… */
  event: string | null
  /** The branch of the run; Gitea leaves it empty for a tag push (null): the tag is in `ref`. */
  headBranch: string | null
  /** 1 for the first attempt; a rerun of the same run counts up. */
  runAttempt: number | null
}

export interface WorkflowJobStep {
  name: string
  status: WorkflowStatus
  conclusion: WorkflowConclusion
}

/** One job of a run, from the `workflow_job` webhook: the only place that names the step. */
export interface WorkflowJob {
  id: string
  runId: string
  name: string
  headSha: string
  headBranch: string | null
  runAttempt: number | null
  status: WorkflowStatus
  conclusion: WorkflowConclusion
  url: string
  steps: WorkflowJobStep[]
}

/** A tag of a repository as the provider's API shows it. */
export interface GitTag {
  name: string
  /** The commit the tag names (peeled). */
  commitSha: string
  /** What the ref points to: the commit itself for a lightweight tag, a tag object otherwise. */
  objectSha: string
}

/**
 * A run of a workflow the provider was asked to start (workflow_dispatch). `source` names the
 * repository a required (scoped) workflow comes from, `platform/ci` on our Gitea; without it the
 * workflow file is one of `ref`'s own repository.
 */
export interface WorkflowDispatch {
  workflow: string
  ref: string
  inputs?: Record<string, string>
  source?: RepoRef
}

/** Provider webhooks normalized to what the orchestrator needs. */
export type GitWebhookEvent =
  | { kind: 'pull_request'; repo: RepoRef; pullRequest: PullRequest }
  | { kind: 'workflow_run'; repo: RepoRef; run: WorkflowRun }
  | { kind: 'workflow_job'; repo: RepoRef; job: WorkflowJob }
  | { kind: 'push'; repo: RepoRef; branch: string; headSha: string }
  /** A tag created or moved; `sha` is what the ref points to now (see GitTag.objectSha). */
  | { kind: 'tag'; repo: RepoRef; tag: string; sha: string }

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
  /**
   * A secret of this repository's Actions, never of its organization: a run of another
   * repository cannot read it. Creates or replaces. The provider may need a credential of the
   * owner for this, not the bot's (spec §10; plan 53, Р29, Р35).
   */
  setActionsSecret(ref: RepoRef, name: string, value: string): Promise<void>
  /** A secret that is already gone counts as deleted. */
  deleteActionsSecret(ref: RepoRef, name: string): Promise<void>
  setActionsVariable(ref: RepoRef, name: string, value: string): Promise<void>
  /**
   * Only the release account — the one `createTag` acts as — may create, move or delete a tag
   * matching `pattern`; every other account is refused, the bot and its grants included.
   * Idempotent. What it does not do: keep that one account from moving a tag (plan 53, Р26:
   * immutability is code's, and `createTag` never moves one).
   */
  protectTags(ref: RepoRef, pattern: string): Promise<void>
  /**
   * A lightweight tag `name` on `commitSha`, made by the release account (plan 53, Р26, Р27).
   * Never moves a tag: when the name is taken, the tag as the repository holds it is returned —
   * the caller compares its `commitSha`. A tag protected for another account is refused.
   */
  createTag(ref: RepoRef, name: string, commitSha: string): Promise<GitTag>
  /** Null when the repository has no such tag. */
  getTag(ref: RepoRef, name: string): Promise<GitTag | null>
  /** Polling fallback when a webhook is lost; newest first. */
  listWorkflowRuns(
    ref: RepoRef,
    filter: { headSha?: string; event?: string; branch?: string },
  ): Promise<WorkflowRun[]>
  /** Null when the repository has no such run. */
  getWorkflowRun(ref: RepoRef, id: string): Promise<WorkflowRun | null>
  /**
   * Starts a workflow that has a `workflow_dispatch` trigger. The run id when the provider names
   * it. A provider that refuses to start this workflow (no such trigger, no such file at `ref`,
   * a source it does not run for this repository) rejects with DomainError code NOT_SUPPORTED.
   */
  dispatchWorkflow(ref: RepoRef, dispatch: WorkflowDispatch): Promise<{ runId: string | null }>
  /**
   * The only way in for a webhook: first the timing-safe signature check on the raw body
   * (X-Gitea-Signature, X-Hub-Signature-256, X-Gitlab-Token), then JSON.parse and a zod schema
   * of the provider event. Any failure — bad or missing signature, malformed JSON, an unknown
   * or unsupported event — yields null; it never throws. There is deliberately no way to parse
   * an event without the signature check.
   */
  parseWebhook(headers: Headers, rawBody: string, secret: string): GitWebhookEvent | null
}
