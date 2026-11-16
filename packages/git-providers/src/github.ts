import { sign } from 'node:crypto'

import { z } from 'zod'

import {
  githubHost,
  gitNotSupported,
  gitProviderFailed,
  isRepoPath,
  repoChanged,
  repoCloneUrl,
  repoNotMergeable,
  repoWebUrl,
  sameHostUrl,
  type BranchRules,
  type ChecksState,
  type CiJob,
  type CiRun,
  type CiStatus,
  type DeployAction,
  type GitAuth,
  type GitGrant,
  type GitProvider,
  type GitProviderSupport,
  type IssuedGitAccess,
  type PullRequest,
  type RepoRef,
  type RepositoryInfo,
} from '@repo/domain'

import { call, dateOf, jsonOf, numericId, shaPattern } from './api.ts'
import type { GitHttpResponse, GitSession, GitTransport } from './transport.ts'

// GitHub REST (https://docs.github.com/en/rest) by the GitHub App of Raditi
// (docs/plan/84-projects.md, ПР10, ПР13–ПР16, §4.5; slice 84.25), and the anonymous reading of
// public repositories by a link (ПР9). An installation's access is a token of one hour, issued per
// operation by a JWT of the app (RS256, ten minutes), narrowed to the one repository of the
// operation and to its rights — `workflows` only for a press the card of build settings allowed —
// and revoked after it. Every request goes to the API of github.com (or a stand's fake), never to
// an address an answer names; the one exception is the log of a job, a redirect to a short-lived
// address of GitHub's storage, asked without the access.

export interface GithubProviderConfig {
  transport: GitTransport
  /** Stands only: `https://localhost:<port>` instead of https://api.github.com. */
  apiUrl?: URL | null
  now?: () => Date
}

export const githubCiPaths = ['.github/', 'CODEOWNERS', 'docs/CODEOWNERS'] as const

const API_VERSION = '2022-11-28'
/** A JWT of the app lives ten minutes at most; it is dated a minute back for a clock behind. */
const JWT_LIFE_SECONDS = 9 * 60
const JWT_BACKDATE_SECONDS = 60
/** Repositories of an installation a page of a sync reads. */
const REPOSITORY_PAGE = 50
/** Workflows whose file a deploy card reads at most. */
const WORKFLOWS_READ = 20

/**
 * Hosts the redirect of a job's log may lead to (§4.5): the storage of GitHub Actions. The
 * documentation says only «a redirect URL … expires after 1 minute»; these names are the ones
 * GitHub answered with as this was written, unverified here — another host is refused, not followed.
 */
const LOG_HOSTS = [
  /^[a-z0-9-]+\.actions\.githubusercontent\.com$/,
  /^productionresultssa\d+\.blob\.core\.windows\.net$/,
]

/** The rights of a token of an operation (ПР10): reading always, writing only what a press does. */
const READ_PERMISSIONS = {
  metadata: 'read',
  contents: 'read',
  pull_requests: 'read',
  actions: 'read',
  checks: 'read',
  statuses: 'read',
} as const

const WRITE_PERMISSIONS = {
  metadata: 'read',
  contents: 'write',
  pull_requests: 'write',
  actions: 'write',
  checks: 'read',
  statuses: 'read',
} as const

const repositorySchema = z.looseObject({
  id: z.number().int().positive(),
  full_name: z.string(),
  default_branch: z.string().nullish(),
  private: z.boolean(),
  html_url: z.unknown().optional(),
  /** Kilobytes (https://docs.github.com/en/rest/repos/repos#get-a-repository). */
  size: z.number().nonnegative().nullish(),
})

const pullSchema = z.looseObject({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean().nullish(),
  merged_at: z.string().nullish(),
  merge_commit_sha: z.string().nullish(),
  html_url: z.unknown().optional(),
  head: z.looseObject({
    ref: z.string(),
    sha: z.string(),
    repo: z.looseObject({ full_name: z.string() }).nullish(),
  }),
  base: z.looseObject({ ref: z.string() }),
  auto_merge: z.unknown().optional(),
})

const runSchema = z.looseObject({
  id: z.number().int().positive(),
  name: z.string().nullish(),
  head_sha: z.string(),
  head_branch: z.string().nullish(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  event: z.string().nullish(),
  html_url: z.unknown().optional(),
  created_at: z.string().nullish(),
  run_started_at: z.string().nullish(),
  updated_at: z.string().nullish(),
})

const jobSchema = z.looseObject({
  id: z.number().int().positive(),
  run_id: z.number().int().positive(),
  name: z.string(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  html_url: z.unknown().optional(),
  started_at: z.string().nullish(),
  completed_at: z.string().nullish(),
})

const accessTokenSchema = z.looseObject({
  token: z.string().min(1).max(4096),
  expires_at: z.string(),
})

const userSchema = z.looseObject({
  id: z.number().int().positive(),
  login: z.string().min(1).max(100),
})

/** A run's or job's status and conclusion in the words of the platform. */
export function githubCiStatus(
  status: string | null | undefined,
  conclusion: string | null | undefined,
): CiStatus {
  if (status === 'in_progress') return 'running'
  if (status !== 'completed') return 'pending'
  switch (conclusion) {
    case 'success':
      return 'success'
    case 'cancelled':
      return 'canceled'
    case 'skipped':
    case 'neutral':
      return 'skipped'
    default:
      // failure, timed_out, startup_failure, action_required, stale
      return 'failed'
  }
}

/** A conclusion of a check that counts as passed (ПР15): success, or a check that chose not to run. */
const passed = (conclusion: string | null | undefined) =>
  conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped'

const base64url = (data: Buffer | string) => Buffer.from(data).toString('base64url')

/**
 * The JWT of the app (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app):
 * RS256, `iss` — the app id, `iat` a minute back, `exp` within ten minutes of it.
 */
export function githubAppJwt(appId: string, privateKey: string, now: Date): string {
  const at = Math.floor(now.getTime() / 1000) - JWT_BACKDATE_SECONDS
  const head = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify({ iat: at, exp: at + JWT_LIFE_SECONDS, iss: appId }))
  let signature: Buffer
  try {
    signature = sign('sha256', Buffer.from(`${head}.${body}`), privateKey)
  } catch {
    // Never the key in an error.
    throw gitProviderFailed('the private key of the GitHub App does not sign')
  }
  return `${head}.${body}.${base64url(signature)}`
}

/** Whether a workflow file starts on `workflow_dispatch`: the word outside comments. */
export function workflowDispatchable(text: string): boolean {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .some((line) => /(^|[\s[{,'"])workflow_dispatch(\s*:|[\s\]},'"]|$)/.test(line))
}

/** The path of a branch in an address, each segment encoded and the slashes kept. */
const refPath = (branch: string) => branch.split('/').map(encodeURIComponent).join('/')

type ChecksOfHead = {
  suites: { status: string | null; conclusion: string | null }[]
  runs: { name: string; status: string | null; conclusion: string | null }[]
  statuses: { context: string; state: string }[]
}

/**
 * «Сборка прошла» (ПР15): every check suite of the head in which a check ran and every commit
 * status finished successfully, and each required check is there and passed. `none` — the head has
 * no check at all and nothing is required.
 */
export function githubChecksState(checks: ChecksOfHead, required: readonly string[]): ChecksState {
  let pending = false
  for (const suite of checks.suites) {
    if (suite.status !== 'completed') pending = true
    else if (!passed(suite.conclusion)) return 'failure'
  }
  for (const status of checks.statuses) {
    if (status.state === 'pending') pending = true
    else if (status.state !== 'success') return 'failure'
  }
  for (const name of required) {
    const runs = checks.runs.filter((run) => run.name === name)
    const statuses = checks.statuses.filter((status) => status.context === name)
    if (runs.length === 0 && statuses.length === 0) {
      pending = true
      continue
    }
    for (const run of runs) {
      if (run.status !== 'completed') pending = true
      else if (!passed(run.conclusion)) return 'failure'
    }
  }
  if (pending) return 'pending'
  if (required.length === 0 && checks.suites.length === 0 && checks.statuses.length === 0)
    return 'none'
  return 'success'
}

export function createGithubProvider(config: GithubProviderConfig): GitProvider {
  const { transport } = config
  const api = config.apiUrl ?? new URL('https://api.github.com')
  const now = config.now ?? (() => new Date())
  const support: GitProviderSupport = {
    ciLint: false,
    autoMerge: false,
    checksWait: true,
    manualJobs: false,
    workflowDispatch: true,
    projectHooks: false,
    ciPaths: githubCiPaths,
    label: 'GitHub',
    requestRef: (n) => `#${n}`,
  }

  const repoPath = (repo: RepoRef): string => {
    if (repo.provider !== 'github' || repo.host !== githubHost || !isRepoPath('github', repo.path))
      throw gitProviderFailed('not a github.com repository')
    const [owner, name] = repo.path.split('/')
    return `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}`
  }

  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': API_VERSION,
    // GitHub refuses a request without a User-Agent; a generic one names no person.
    'user-agent': 'Raditi',
  }

  const send = (
    session: GitSession,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    auth: GitAuth,
    path: string,
    options: { query?: Record<string, string>; body?: unknown; redirect?: boolean } = {},
  ): Promise<GitHttpResponse> => {
    const url = new URL(api)
    url.pathname = path
    for (const [name, value] of Object.entries(options.query ?? {}))
      url.searchParams.set(name, value)
    return call(session, {
      method,
      url,
      auth,
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.redirect ? { limits: { redirect: 'return' as const } } : {}),
    })
  }
  const get = (auth: GitAuth, path: string, query: Record<string, string> = {}) =>
    send(transport.session(), 'GET', auth, path, { query })

  const notYet = (what: string) => () =>
    Promise.reject(gitNotSupported(`${what} on GitHub before 84.26`))

  const repositoryOf = (raw: unknown): RepositoryInfo | null => {
    const parsed = repositorySchema.safeParse(raw)
    if (!parsed.success) throw gitProviderFailed('a repository of an unexpected form')
    const r = parsed.data
    if (!isRepoPath('github', r.full_name)) return null
    const ref = {
      provider: 'github' as const,
      host: githubHost,
      path: r.full_name,
      providerRepoId: String(r.id),
    }
    return {
      ref,
      defaultBranch: r.default_branch ?? 'main',
      private: r.private,
      webUrl: sameHostUrl(githubHost, r.html_url, repoWebUrl(ref)),
      cloneUrl: repoCloneUrl(ref),
      sizeBytes: typeof r.size === 'number' ? r.size * 1024 : null,
    }
  }

  const runOf = (repo: RepoRef, raw: unknown): CiRun => {
    const parsed = runSchema.safeParse(raw)
    if (!parsed.success) throw gitProviderFailed('a run of an unexpected form')
    const r = parsed.data
    return {
      id: String(r.id),
      name: r.name ?? `#${r.id}`,
      sha: r.head_sha,
      ref: r.head_branch ?? '',
      status: githubCiStatus(r.status, r.conclusion),
      url: sameHostUrl(githubHost, r.html_url, `${repoWebUrl(repo)}/actions/runs/${r.id}`),
      createdAt: dateOf(r.created_at),
      startedAt: dateOf(r.run_started_at),
      finishedAt: r.status === 'completed' ? dateOf(r.updated_at) : null,
      event: r.event ?? null,
    }
  }

  /** The check suites, check runs and commit statuses of a head. */
  const checksOfHead = async (auth: GitAuth, repo: RepoRef, sha: string): Promise<ChecksOfHead> => {
    const at = `${repoPath(repo)}/commits/${sha}`
    const suites = z
      .looseObject({
        check_suites: z.array(
          z.looseObject({
            status: z.string().nullish(),
            conclusion: z.string().nullish(),
            latest_check_runs_count: z.number().int().nonnegative().nullish(),
          }),
        ),
      })
      .safeParse(jsonOf(await get(auth, `${at}/check-suites`, { per_page: '100' })))
    const runs = z
      .looseObject({
        check_runs: z.array(
          z.looseObject({
            name: z.string(),
            status: z.string().nullish(),
            conclusion: z.string().nullish(),
          }),
        ),
      })
      .safeParse(jsonOf(await get(auth, `${at}/check-runs`, { per_page: '100' })))
    const statuses = z
      .looseObject({
        statuses: z.array(z.looseObject({ context: z.string(), state: z.string() })),
      })
      .safeParse(jsonOf(await get(auth, `${at}/status`, { per_page: '100' })))
    if (!suites.success || !runs.success || !statuses.success)
      throw gitProviderFailed('checks of an unexpected form')
    return {
      // A suite in which no check ran (an app that answers nothing on this push) waits for nothing.
      suites: suites.data.check_suites
        .filter((suite) => suite.latest_check_runs_count !== 0)
        .map((suite) => ({ status: suite.status ?? null, conclusion: suite.conclusion ?? null })),
      runs: runs.data.check_runs.map((run) => ({
        name: run.name,
        status: run.status ?? null,
        conclusion: run.conclusion ?? null,
      })),
      statuses: statuses.data.statuses.map((status) => ({
        context: status.context,
        state: status.state,
      })),
    }
  }

  const pullOf = (repo: RepoRef, raw: unknown) => {
    const parsed = pullSchema.safeParse(raw)
    if (!parsed.success || !shaPattern.test(parsed.data.head.sha))
      throw gitProviderFailed('a pull request of an unexpected form')
    const p = parsed.data
    const mergeSha = p.merge_commit_sha ?? null
    const pull: PullRequest = {
      number: p.number,
      url: sameHostUrl(githubHost, p.html_url, `${repoWebUrl(repo)}/pull/${p.number}`),
      title: p.title,
      sourceBranch: p.head.ref,
      targetBranch: p.base.ref,
      headSha: p.head.sha,
      state: p.merged_at ? 'merged' : p.state === 'open' ? (p.draft ? 'draft' : 'open') : 'closed',
      checks: 'none',
      autoMerge: p.auto_merge !== null && p.auto_merge !== undefined,
      mergeSha: p.merged_at && mergeSha !== null && shaPattern.test(mergeSha) ? mergeSha : null,
    }
    return { pull, headRepo: p.head.repo?.full_name ?? null }
  }

  const readPull = async (auth: GitAuth, repo: RepoRef, number: number) => {
    const response = await get(auth, `${repoPath(repo)}/pulls/${numericId(number, 'pull request')}`)
    if (response.status === 404) return null
    return pullOf(repo, jsonOf(response))
  }

  const branchHead = async (auth: GitAuth, repo: RepoRef, branch: string) => {
    const response = await get(auth, `${repoPath(repo)}/branches/${refPath(branch)}`)
    if (response.status === 404) return null
    const parsed = z
      .looseObject({ commit: z.looseObject({ sha: z.string().regex(shaPattern) }) })
      .safeParse(jsonOf(response))
    if (!parsed.success) throw gitProviderFailed('a branch of an unexpected form')
    return parsed.data.commit.sha
  }

  async function installationAccess(
    grant: Extract<GitGrant, { kind: 'github_installation' }>,
    repo: RepoRef | null,
    access: 'read' | 'write',
    workflows: boolean,
  ): Promise<IssuedGitAccess> {
    const installation = numericId(grant.installationId, 'installation')
    if (repo !== null) repoPath(repo)
    const repositoryId =
      repo === null ? null : Number(numericId(repo.providerRepoId ?? '', 'repository'))
    if (access === 'read' && workflows) throw gitProviderFailed('workflows in a reading access')
    // `workflows` only in the token of a press the card of build settings allowed (ПР16).
    const permissions =
      access === 'write'
        ? { ...WRITE_PERMISSIONS, ...(workflows ? { workflows: 'write' } : {}) }
        : READ_PERMISSIONS
    const jwt = githubAppJwt(grant.appId, grant.privateKey, now())
    const response = await send(
      transport.session(),
      'POST',
      { kind: 'bearer', token: jwt },
      `/app/installations/${installation}/access_tokens`,
      {
        body: { ...(repositoryId === null ? {} : { repository_ids: [repositoryId] }), permissions },
      },
    )
    const parsed = accessTokenSchema.safeParse(jsonOf(response))
    if (!parsed.success) throw gitProviderFailed('an installation token of an unexpected form')
    const token = parsed.data.token
    const auth: GitAuth = { kind: 'bearer', token }
    let revoked = false
    return {
      auth,
      // git over HTTPS takes an installation token as the password of `x-access-token`.
      basic: { username: 'x-access-token', password: token },
      expiresAt: dateOf(parsed.data.expires_at) ?? new Date(now().getTime() + 60 * 60_000),
      async revoke() {
        if (revoked) return
        revoked = true
        const answer = await send(transport.session(), 'DELETE', auth, '/installation/token')
        if (answer.status !== 204 && answer.status !== 401)
          throw gitProviderFailed('the token was not revoked', answer.status)
      },
    }
  }

  const provider: GitProvider = {
    kind: 'github',
    support,

    async issueCredentials(grant, repo, access, opts) {
      if (grant.kind === 'github_installation')
        return installationAccess(grant, repo, access, opts.workflows === true)
      if (repo !== null) repoPath(repo)
      if (grant.kind !== 'anonymous' || access !== 'read')
        throw gitNotSupported('a stored token on GitHub: its way is the GitHub App')
      return {
        auth: { kind: 'anonymous' },
        basic: null,
        expiresAt: new Date(now().getTime() + opts.ttlSeconds * 1000),
      }
    },

    async whoAmI(auth) {
      const user = userSchema.safeParse(jsonOf(await get(auth, '/user')))
      if (!user.success) throw gitProviderFailed('a user of an unexpected form')
      return { login: user.data.login, id: String(user.data.id) }
    },

    async personRights(auth, repo, userId) {
      const none = { push: false, maintain: false }
      // The login of the person now — it may have changed since they connected — by their id.
      const user = await get(auth, `/user/${numericId(userId, 'user')}`)
      if (user.status === 404) return none
      const named = userSchema.safeParse(jsonOf(user))
      if (!named.success || String(named.data.id) !== userId)
        throw gitProviderFailed('a user of an unexpected form')
      const response = await get(
        auth,
        `${repoPath(repo)}/collaborators/${encodeURIComponent(named.data.login)}/permission`,
      )
      if (response.status === 404) return none
      const parsed = z
        .looseObject({
          permission: z.string(),
          role_name: z.string().nullish(),
          user: z
            .looseObject({
              id: z.number().int().positive(),
              permissions: z
                .looseObject({
                  push: z.boolean().optional(),
                  maintain: z.boolean().optional(),
                  admin: z.boolean().optional(),
                })
                .nullish(),
            })
            .nullable(),
        })
        .safeParse(jsonOf(response))
      if (!parsed.success) throw gitProviderFailed('a permission of an unexpected form')
      const p = parsed.data
      // The answer must be about this very person, not someone who took the old login.
      if (p.user === null || String(p.user.id) !== userId) return none
      const flags = p.user.permissions ?? {}
      const admin = flags.admin === true || p.permission === 'admin'
      const maintain = admin || flags.maintain === true || p.role_name === 'maintain'
      return { push: maintain || flags.push === true || p.permission === 'write', maintain }
    },

    async branchRules(auth, repo, branch): Promise<BranchRules> {
      const at = await get(auth, `${repoPath(repo)}/branches/${refPath(branch)}`)
      const required = new Set<string>()
      let isProtected = false
      if (at.status !== 404) {
        const parsed = z
          .looseObject({
            protected: z.boolean().nullish(),
            protection: z
              .looseObject({
                required_status_checks: z
                  .looseObject({
                    contexts: z.array(z.string()).nullish(),
                    checks: z.array(z.looseObject({ context: z.string() })).nullish(),
                  })
                  .nullish(),
              })
              .nullish(),
          })
          .safeParse(jsonOf(at))
        if (!parsed.success) throw gitProviderFailed('a branch of an unexpected form')
        isProtected = parsed.data.protected === true
        const checks = parsed.data.protection?.required_status_checks
        for (const name of checks?.contexts ?? []) required.add(name)
        for (const check of checks?.checks ?? []) required.add(check.context)
      }
      // Rulesets protect a branch beside the classic protection: their rules count too
      // (https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch).
      const rules = await get(auth, `${repoPath(repo)}/rules/branches/${refPath(branch)}`, {
        per_page: '100',
      })
      if (rules.status !== 404) {
        const parsed = z
          .array(
            z.looseObject({
              type: z.string(),
              parameters: z
                .looseObject({
                  required_status_checks: z.array(z.looseObject({ context: z.string() })).nullish(),
                })
                .nullish(),
            }),
          )
          .safeParse(jsonOf(rules))
        if (!parsed.success) throw gitProviderFailed('rules of an unexpected form')
        if (parsed.data.length > 0) isProtected = true
        for (const rule of parsed.data)
          if (rule.type === 'required_status_checks')
            for (const check of rule.parameters?.required_status_checks ?? [])
              required.add(check.context)
      }
      return { protected: isProtected, requiredChecks: [...required].sort() }
    },

    async headChecks(auth, repo, sha, required) {
      if (!shaPattern.test(sha)) throw gitProviderFailed('not a commit')
      const state = githubChecksState(await checksOfHead(auth, repo, sha), required)
      return state === 'none' ? 'pending' : state
    },

    async listRepositories(auth, page) {
      const at = page === undefined ? 1 : Number(numericId(page, 'page'))
      const body = jsonOf(
        await get(auth, '/installation/repositories', {
          per_page: String(REPOSITORY_PAGE),
          page: String(at),
        }),
      )
      const parsed = z
        .looseObject({
          total_count: z.number().int().nonnegative(),
          repositories: z.array(z.unknown()),
        })
        .safeParse(body)
      if (!parsed.success) throw gitProviderFailed('repositories of an unexpected form')
      const items = parsed.data.repositories
        .map(repositoryOf)
        .filter((item): item is RepositoryInfo => item !== null)
      const next =
        at * REPOSITORY_PAGE < parsed.data.total_count && parsed.data.repositories.length > 0
          ? String(at + 1)
          : null
      return { items, next }
    },

    async getRepository(auth, repo) {
      const response = await get(auth, repoPath(repo))
      // A private repository answers 404 to an anonymous read, like a missing one.
      if (response.status === 404) return null
      const info = repositoryOf(jsonOf(response))
      // The repository at this path now is another one (renamed and replaced): not this one.
      if (
        info !== null &&
        repo.providerRepoId !== undefined &&
        info.ref.providerRepoId !== repo.providerRepoId
      )
        return null
      return info
    },

    async listBranches(auth, repo, query) {
      const parsed = z
        .array(z.looseObject({ name: z.string() }))
        .safeParse(jsonOf(await get(auth, `${repoPath(repo)}/branches`, { per_page: '100' })))
      if (!parsed.success) throw gitProviderFailed('branches of an unexpected form')
      const names = parsed.data.map((b) => b.name)
      return query
        ? names.filter((name) => name.toLowerCase().includes(query.toLowerCase()))
        : names
    },

    branchHead,

    async openPullRequest(auth, repo, input) {
      const response = await send(transport.session(), 'POST', auth, `${repoPath(repo)}/pulls`, {
        body: {
          title: input.title,
          head: input.head,
          base: input.base,
          body: input.body,
          draft: input.draft,
        },
      })
      if (response.status === 422) throw gitProviderFailed('the pull request was refused', 422)
      return pullOf(repo, jsonOf(response)).pull
    },

    async getPullRequest(auth, repo, number) {
      const read = await readPull(auth, repo, number)
      if (read === null) return null
      const { pull } = read
      if (pull.state === 'open' || pull.state === 'draft')
        pull.checks = githubChecksState(await checksOfHead(auth, repo, pull.headSha), [])
      return pull
    },

    async mergePullRequest(auth, repo, number, opts) {
      // GitHub has no wait of its own here: the platform waits for the checks (`checksWait`).
      if (opts.whenGreen) throw gitNotSupported('a merge when green by the provider')
      if (!shaPattern.test(opts.expectedHeadSha)) throw repoChanged()
      const session = transport.session()
      const response = await send(
        session,
        'PUT',
        auth,
        `${repoPath(repo)}/pulls/${numericId(number, 'pull request')}/merge`,
        { body: { sha: opts.expectedHeadSha, merge_method: 'merge' } },
      )
      // 409 — the head is not the `sha` given; 405 and 422 — not mergeable now
      // (https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request).
      if (response.status === 409) throw repoChanged()
      if (response.status === 405 || response.status === 422) throw repoNotMergeable()
      const merged = z
        .looseObject({ merged: z.boolean().nullish(), sha: z.string().nullish() })
        .safeParse(jsonOf(response))
      if (!merged.success || merged.data.merged === false) throw repoNotMergeable()
      const mergeSha =
        merged.data.sha && shaPattern.test(merged.data.sha) ? merged.data.sha : undefined
      if (opts.deleteBranch) {
        // Only the branch of this very repository, never one of a fork; a failure here leaves the
        // branch, and the merge stands.
        const read = await readPull(auth, repo, number).catch(() => null)
        if (read !== null && read.headRepo?.toLowerCase() === repo.path.toLowerCase())
          await send(
            session,
            'DELETE',
            auth,
            `${repoPath(repo)}/git/refs/heads/${refPath(read.pull.sourceBranch)}`,
          ).catch(() => undefined)
      }
      return { state: 'merged', ...(mergeSha ? { mergeSha } : {}) }
    },

    async closePullRequest(auth, repo, number) {
      jsonOf(
        await send(
          transport.session(),
          'PATCH',
          auth,
          `${repoPath(repo)}/pulls/${numericId(number, 'pull request')}`,
          { body: { state: 'closed' } },
        ),
      )
    },

    async listRuns(auth, repo, filter) {
      const body = jsonOf(
        await get(auth, `${repoPath(repo)}/actions/runs`, {
          per_page: '20',
          ...(filter.branch === undefined ? {} : { branch: filter.branch }),
          ...(filter.sha === undefined ? {} : { head_sha: filter.sha }),
        }),
      )
      const parsed = z.looseObject({ workflow_runs: z.array(z.unknown()) }).safeParse(body)
      if (!parsed.success) throw gitProviderFailed('runs of an unexpected form')
      return parsed.data.workflow_runs.map((run) => runOf(repo, run))
    },

    async getRun(auth, repo, runId) {
      const response = await get(auth, `${repoPath(repo)}/actions/runs/${numericId(runId, 'run')}`)
      if (response.status === 404) return null
      return runOf(repo, jsonOf(response))
    },

    async listJobs(auth, repo, runId) {
      const id = numericId(runId, 'run')
      const body = jsonOf(
        await get(auth, `${repoPath(repo)}/actions/runs/${id}/jobs`, { per_page: '100' }),
      )
      const parsed = z.looseObject({ jobs: z.array(jobSchema) }).safeParse(body)
      if (!parsed.success) throw gitProviderFailed('jobs of an unexpected form')
      return parsed.data.jobs.map((job): CiJob => ({
        id: String(job.id),
        runId: id,
        name: job.name,
        stage: null,
        status: githubCiStatus(job.status, job.conclusion),
        url: sameHostUrl(githubHost, job.html_url, `${repoWebUrl(repo)}/actions/runs/${id}`),
        startedAt: dateOf(job.started_at),
        finishedAt: dateOf(job.completed_at),
      }))
    },

    async getJobLog(auth, repo, jobId, opts) {
      const session = transport.session()
      // https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run
      const response = await send(
        session,
        'GET',
        auth,
        `${repoPath(repo)}/actions/jobs/${numericId(jobId, 'job')}/logs`,
        { redirect: true },
      )
      if (response.status === 404 || response.status === 410) return { text: '', truncated: false }
      if (response.status < 300 || response.status >= 400) {
        jsonOf(response)
        throw gitProviderFailed('a log without its address', response.status)
      }
      let target: URL
      try {
        target = new URL(response.headers.get('location') ?? '')
      } catch {
        throw gitProviderFailed('a log at an unexpected address')
      }
      // One redirect, to the storage of GitHub Actions over https, without the access (§4.5); its
      // address is resolved and checked as any other host of the operation.
      if (
        target.protocol !== 'https:' ||
        (target.port !== '' && target.port !== '443') ||
        target.username !== '' ||
        target.password !== '' ||
        !LOG_HOSTS.some((host) => host.test(target.hostname))
      )
        throw gitProviderFailed('a log at an unexpected address')
      const log = await session.request(
        { method: 'GET', url: target, headers: { 'user-agent': headers['user-agent'] } },
        { tailBytes: opts.tailBytes },
      )
      if (log.status !== 200) throw gitProviderFailed('the log did not come', log.status)
      // A tail may start inside a character: the decoder writes a replacement, never throws.
      return { text: new TextDecoder('utf-8').decode(log.body), truncated: log.truncated }
    },

    rerunRun: notYet('a rerun'),
    cancelRun: notYet('cancelling a run'),

    async listDeployActions(auth, repo, ref) {
      // A deploy starts a workflow of the head of the main branch (ПР15): one that runs on
      // `workflow_dispatch`, read from its file at that head.
      const head = await branchHead(auth, repo, ref)
      if (head === null) return []
      const listed = z
        .looseObject({
          workflows: z.array(
            z.looseObject({
              id: z.number().int().positive(),
              name: z.string(),
              path: z.string(),
              state: z.string(),
            }),
          ),
        })
        .safeParse(
          jsonOf(await get(auth, `${repoPath(repo)}/actions/workflows`, { per_page: '100' })),
        )
      if (!listed.success) throw gitProviderFailed('workflows of an unexpected form')
      const actions: DeployAction[] = []
      for (const workflow of listed.data.workflows
        .filter((w) => w.state === 'active' && /^\.github\/workflows\/[^/]+\.ya?ml$/.test(w.path))
        .slice(0, WORKFLOWS_READ)) {
        const file = await get(
          auth,
          `${repoPath(repo)}/contents/${workflow.path.split('/').map(encodeURIComponent).join('/')}`,
          { ref: head },
        )
        if (file.status === 404) continue
        const content = z
          .looseObject({ content: z.string(), encoding: z.literal('base64') })
          .safeParse(jsonOf(file))
        if (!content.success) continue
        if (!workflowDispatchable(Buffer.from(content.data.content, 'base64').toString('utf8')))
          continue
        actions.push({
          id: String(workflow.id),
          kind: 'workflow_dispatch',
          name: workflow.name.slice(0, 200),
          ref,
          sha: head,
        })
      }
      return actions
    },

    async startDeploy(auth, repo, action) {
      if (action.kind !== 'workflow_dispatch') throw gitNotSupported('a manual job on GitHub')
      const response = await send(
        transport.session(),
        'POST',
        auth,
        `${repoPath(repo)}/actions/workflows/${numericId(action.id, 'workflow')}/dispatches`,
        { body: { ref: action.ref } },
      )
      // 204 by the API version this adapter names; 200 with the run by 2026-03-10 and later.
      if (response.status === 204) return { runId: null }
      const body = z
        .looseObject({ workflow_run_id: z.number().int().positive().nullish() })
        .safeParse(jsonOf(response))
      return {
        runId: body.success && body.data.workflow_run_id ? String(body.data.workflow_run_id) : null,
      }
    },
  }
  return provider
}
