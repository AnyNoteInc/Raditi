/**
 * Git provider port (docs/plan/84-projects.md, ПР11, §4.5; rule 8). The repository of a project
 * lives on the client's GitHub or GitLab. The core knows only this port: what a provider can do is
 * its `support` object, never a comparison of its kind. Tokens never enter the sandbox: the trusted
 * side fetches and pushes with an access issued per operation.
 */

/**
 * Kinds a stored snapshot may name. `gitea` stays only so the snapshots of plan 53 still read
 * (docs/plan/84-projects.md, §4.5); no adapter serves it.
 */
export const gitProviderKinds = ['gitea', 'github', 'gitlab'] as const
export type GitProviderKind = (typeof gitProviderKinds)[number]

/** The providers a project repository may live on. */
export const repoProviderKinds = ['github', 'gitlab'] as const
export type RepoProviderKind = (typeof repoProviderKinds)[number]

/**
 * A repository: the host it lives on and its path there (ПР11). On GitHub the path is exactly
 * `owner/name`; on GitLab it is `group/sub/project`, up to 300 characters. `providerRepoId` is the
 * provider's numeric id once known: the API and git addresses are built from the host and it,
 * never from an answer of the API (§4.6).
 */
export interface RepoRef {
  provider: RepoProviderKind
  host: string
  path: string
  providerRepoId?: string
}

/** What a provider can do (ПР11): the core branches on these, never on the kind. */
export interface GitProviderSupport {
  /** The provider checks a CI configuration before a push (GitLab CI Lint). */
  ciLint: boolean
  /** The provider merges by itself once the pipeline passes (GitLab `auto_merge` with `sha`). */
  autoMerge: boolean
  /**
   * The platform waits for the checks itself and merges once they passed (GitHub, ПР15, §4.5):
   * «сборка прошла» — every required check of the target branch and every check suite of the head
   * finished successfully; without required checks the wait is not offered. Needs `headChecks`.
   */
  checksWait: boolean
  /** Manual jobs a deploy can start (GitLab `when: manual`). */
  manualJobs: boolean
  /** Workflows a deploy can start (GitHub `workflow_dispatch`). */
  workflowDispatch: boolean
  /** Hooks on one repository (GitLab project hooks). */
  projectHooks: boolean
  /** The paths of build settings of this provider, on top of `forbiddenCiPaths` (ПР16). */
  ciPaths: readonly string[]
  /** The brand the client reads: «GitLab», «GitHub». */
  label: string
  /** How the provider writes the number of a merge request: `!37` or `#37`. */
  requestRef(number: number): string
}

/** An OAuth application of Raditi on a provider (GitLab.com; GitHub App in Э10). */
export interface OAuthApp {
  host: string
  clientId: string
  clientSecret: string
  /** The callback the authorization went to; GitLab wants it again on refresh. */
  redirectUri: string
}

export interface GitTokens {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date | null
}

/**
 * Sign-in with a provider (ПР11): `@repo/git-providers/connect`, the one part web may import. A
 * refresh the provider refuses for good is the neutral `{ reauth: true }`, never its own code.
 */
export interface GitConnect {
  exchangeCode(app: OAuthApp, code: string, verifier: string): Promise<GitTokens>
  refreshAccess(app: OAuthApp, refreshToken: string): Promise<GitTokens | { reauth: true }>
  /** Who signed in, by the access token just received: the account a connection acts as. */
  signedInUser(app: OAuthApp, accessToken: string): Promise<{ login: string; id: string }>
  /**
   * An installation of an app, checked by the user's own token (ПР10; GitHub, Э10): the
   * `installation_id` of a return can be forged, so it counts only when the user sees it among
   * their installations. Only the repositories where this user may push are returned. null — the
   * user does not see this installation. Only where the provider has installations.
   */
  verifyInstallation?(
    userToken: string,
    installationId: string,
  ): Promise<VerifiedInstallation | null>
}

/** An installation as its user sees it (`verifyInstallation`). */
export interface VerifiedInstallation {
  installationId: string
  /** The account the installation is on: an organisation or the user. */
  account: { login: string; id: string }
  /** Who checked it: the person the connection acts for. */
  user: { login: string; id: string }
  /** The repositories of the installation where `user` has the right to push. */
  repositories: RepositoryInfo[]
}

/**
 * What one person may do in a repository (ПР10), as the provider says: core checks it before every
 * push, request, merge and deploy of a connection that acts for an installation, not for a person.
 */
export interface RepoPersonRights {
  push: boolean
  /** May merge into a protected branch (GitHub `maintain` or `admin`). */
  maintain: boolean
}

/** What protects a branch (ПР10, ПР15): its required checks name what «сборка прошла» waits for. */
export interface BranchRules {
  protected: boolean
  /** The names of the required checks: check runs or commit statuses. */
  requiredChecks: string[]
}

/** The access of one operation. */
export type GitAuth = { kind: 'anonymous' } | { kind: 'bearer'; token: string }

/** What an access is issued from: an installation (Э10), a stored token, or nothing (a link). */
export type GitGrant =
  | { kind: 'github_installation'; appId: string; privateKey: string; installationId: string }
  | { kind: 'token'; token: string }
  | { kind: 'anonymous' }

/**
 * Access for one fetch or push. `basic` is what git sends (by `--config-env`, never in the URL);
 * null for an anonymous read.
 */
export interface IssuedGitAccess {
  auth: GitAuth
  basic: { username: string; password: string } | null
  expiresAt: Date
  revoke?(): Promise<void>
}

export interface RepositoryInfo {
  ref: RepoRef & { providerRepoId: string }
  defaultBranch: string
  private: boolean
  /** `https://<host>/…` of the same host, otherwise built from the host and the path (§4.6). */
  webUrl: string
  /** Built by the adapter from the host and the path, never taken from the API (§4.6). */
  cloneUrl: string
  /** Bytes the provider reports, null when it does not say (ПР12). */
  sizeBytes: number | null
  /**
   * The path of the build configuration of this repository when the provider names one of its
   * own files (GitLab `ci_config_path`, ПР16); null or absent — the provider's default.
   */
  ciConfigPath?: string | null
  /**
   * The access may create hooks on this repository (GitLab: Maintainer or above, ПР17); absent —
   * the provider does not say, or has no hooks of one repository.
   */
  canManageHooks?: boolean
}

export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed'
export type ChecksState = 'none' | 'pending' | 'success' | 'failure'

export interface PullRequest {
  number: number
  url: string
  title: string
  sourceBranch: string
  targetBranch: string
  headSha: string
  state: PullRequestState
  checks: ChecksState
  autoMerge: boolean
  mergeSha: string | null
}

/** A pipeline (GitLab) or a workflow run (GitHub), in the words of the platform. */
export const ciStatuses = [
  'pending',
  'running',
  'manual',
  'success',
  'failed',
  'canceled',
  'skipped',
] as const
export type CiStatus = (typeof ciStatuses)[number]

/**
 * Why a job did not run though nothing in it failed (ПР17): `account_unverified` — gitlab.com did
 * not start it on its own runners until the account is verified. Said in its own words, not «Упала».
 */
export const ciRefusals = ['account_unverified'] as const
export type CiRefusal = (typeof ciRefusals)[number]

export interface CiRun {
  id: string
  name: string
  sha: string
  ref: string
  status: CiStatus
  url: string
  createdAt: Date | null
  startedAt?: Date | null
  finishedAt: Date | null
  /** What started it, as the provider names it (`push`, `merge_request_event`, `web`…). */
  event?: string | null
  refusal?: CiRefusal | null
}

export interface CiJob {
  id: string
  runId: string
  /** As the client's configuration names it (ПР3). */
  name: string
  stage: string | null
  status: CiStatus
  url: string
  startedAt?: Date | null
  finishedAt?: Date | null
  refusal?: CiRefusal | null
}

/** A deploy the client can start on the head of the default branch (ПР15, ПР17). */
export interface DeployAction {
  id: string
  kind: 'manual_job' | 'workflow_dispatch'
  name: string
  ref: string
  sha: string
}

export interface OpenPullRequestInput {
  head: string
  base: string
  title: string
  body: string
  draft: boolean
}

export interface GitProvider {
  readonly kind: RepoProviderKind
  readonly support: GitProviderSupport
  /**
   * The access of one operation. `repo` null — an operation on the whole account of the grant (a
   * sync of a connection's repositories); otherwise the access is narrowed to this repository
   * where the provider can. `workflows` — the access may change build workflows (ПР16, `ci_push`).
   */
  issueCredentials(
    grant: GitGrant,
    repo: RepoRef | null,
    access: 'read' | 'write',
    opts: { ttlSeconds: number; workflows?: boolean },
  ): Promise<IssuedGitAccess>
  whoAmI(auth: GitAuth): Promise<{ login: string; id: string }>
  /** The rights of a person, by their provider id (ПР10). Only where a grant acts for an app. */
  personRights?(auth: GitAuth, repo: RepoRef, userId: string): Promise<RepoPersonRights>
  /** The protection of a branch and its required checks (ПР10, ПР15). */
  branchRules?(auth: GitAuth, repo: RepoRef, branch: string): Promise<BranchRules>
  /**
   * Whether the build of `sha` passed by the definition of ПР15: the required checks and every
   * check suite of the head. Only where `support.checksWait`.
   */
  headChecks?(
    auth: GitAuth,
    repo: RepoRef,
    sha: string,
    required: readonly string[],
  ): Promise<'pending' | 'success' | 'failure'>
  listRepositories(
    auth: GitAuth,
    page?: string,
  ): Promise<{ items: RepositoryInfo[]; next: string | null }>
  /** Null when the repository is not there or the access does not see it. */
  getRepository(auth: GitAuth, repo: RepoRef): Promise<RepositoryInfo | null>
  listBranches(auth: GitAuth, repo: RepoRef, query?: string): Promise<string[]>
  /**
   * The head of one branch at the provider; null when there is no such branch. A deploy reads the
   * main branch again before it plays a job (ПР15). Only where `support.manualJobs`.
   */
  branchHead?(auth: GitAuth, repo: RepoRef, branch: string): Promise<string | null>
  openPullRequest(auth: GitAuth, repo: RepoRef, input: OpenPullRequestInput): Promise<PullRequest>
  getPullRequest(auth: GitAuth, repo: RepoRef, number: number): Promise<PullRequest | null>
  /**
   * The merge requests from `sourceBranch` of this very repository, newest first — open, draft or
   * merged (84.26): one opened at the provider for a chat's branch is adopted by the platform.
   */
  findPullRequests(auth: GitAuth, repo: RepoRef, sourceBranch: string): Promise<PullRequest[]>
  /**
   * Merges only while the source head is `expectedHeadSha` (otherwise REPO_CHANGED). `whenGreen`
   * only where `support.autoMerge`: the provider merges once the pipeline passes.
   */
  mergePullRequest(
    auth: GitAuth,
    repo: RepoRef,
    number: number,
    opts: { expectedHeadSha: string; deleteBranch: boolean; whenGreen: boolean },
  ): Promise<{ state: 'merged' | 'scheduled'; mergeSha?: string }>
  /** Takes an auto-merge off (ПР15); true when one was on. Only where `support.autoMerge`. */
  cancelAutoMerge?(auth: GitAuth, repo: RepoRef, number: number): Promise<boolean>
  closePullRequest(auth: GitAuth, repo: RepoRef, number: number): Promise<void>
  listRuns(
    auth: GitAuth,
    repo: RepoRef,
    filter: { branch?: string; sha?: string },
  ): Promise<CiRun[]>
  getRun(auth: GitAuth, repo: RepoRef, runId: string): Promise<CiRun | null>
  listJobs(auth: GitAuth, repo: RepoRef, runId: string): Promise<CiJob[]>
  /** The last `tailBytes` of the log as the build wrote it (owner's answer of 15.11.2026, §8). */
  getJobLog(
    auth: GitAuth,
    repo: RepoRef,
    jobId: string,
    opts: { tailBytes: number },
  ): Promise<{ text: string; truncated: boolean }>
  rerunRun(auth: GitAuth, repo: RepoRef, runId: string): Promise<void>
  cancelRun(auth: GitAuth, repo: RepoRef, runId: string): Promise<void>
  /** Manual jobs or `workflow_dispatch` of `ref`'s newest run (ПР17). */
  listDeployActions(auth: GitAuth, repo: RepoRef, ref: string): Promise<DeployAction[]>
  startDeploy(auth: GitAuth, repo: RepoRef, action: DeployAction): Promise<{ runId: string | null }>
  lintCi?(
    auth: GitAuth,
    repo: RepoRef,
    content: string,
    ref: string,
  ): Promise<{ valid: boolean; errors: string[]; includes: string[] }>
  /**
   * A hook of the repository (ПР17; slice 84.26): `token` comes back in `X-Gitlab-Token`,
   * `signingToken` (`whsec_…`) signs every delivery where the server can (GitLab ≥ 19.0); `signed`
   * — the server says it took the signing token.
   */
  createHook?(
    auth: GitAuth,
    repo: RepoRef,
    hook: { url: string; token: string; signingToken: string | null },
  ): Promise<{ hookId: string; signed: boolean }>
  deleteHook?(auth: GitAuth, repo: RepoRef, hookId: string): Promise<void>
}
