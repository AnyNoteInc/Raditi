import { z } from 'zod'

import {
  githubHost,
  gitNotSupported,
  gitProviderFailed,
  isRepoPath,
  repoCloneUrl,
  repoWebUrl,
  sameHostUrl,
  type CiJob,
  type CiRun,
  type CiStatus,
  type GitAuth,
  type GitProvider,
  type GitProviderSupport,
  type PullRequest,
  type RepoRef,
  type RepositoryInfo,
} from '@repo/domain'

import { call, dateOf, jsonOf, numericId, shaPattern } from './api.ts'
import type { GitTransport } from './transport.ts'

// GitHub REST (https://docs.github.com/en/rest), first version: anonymous reading of public
// repositories by a link (docs/plan/84-projects.md, ПР9, ПР31). Writing, installations, logs and
// deploys come with the GitHub App (Э10); until then they are refused as not supported.

export interface GithubProviderConfig {
  transport: GitTransport
  /** Stands only: `https://localhost:<port>` instead of https://api.github.com. */
  apiUrl?: URL | null
}

export const githubCiPaths = ['.github/', 'CODEOWNERS', 'docs/CODEOWNERS'] as const

const API_VERSION = '2022-11-28'

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
  head: z.looseObject({ ref: z.string(), sha: z.string() }),
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
  html_url: z.unknown().optional(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
})

const jobSchema = z.looseObject({
  id: z.number().int().positive(),
  run_id: z.number().int().positive(),
  name: z.string(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  html_url: z.unknown().optional(),
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

export function createGithubProvider(config: GithubProviderConfig): GitProvider {
  const { transport } = config
  const api = config.apiUrl ?? new URL('https://api.github.com')
  const support: GitProviderSupport = {
    ciLint: false,
    autoMerge: false,
    manualJobs: false,
    workflowDispatch: false,
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

  const get = (auth: GitAuth, path: string, query: Record<string, string> = {}) => {
    const url = new URL(api)
    url.pathname = path
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
    return call(transport.session(), {
      method: 'GET',
      url,
      auth,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': API_VERSION,
        // GitHub refuses a request without a User-Agent; a generic one names no person.
        'user-agent': 'Raditi',
      },
    })
  }

  const notYet = (what: string) => () =>
    Promise.reject(gitNotSupported(`${what} on GitHub before Э10`))

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
      finishedAt: r.status === 'completed' ? dateOf(r.updated_at) : null,
    }
  }

  return {
    kind: 'github',
    support,

    async issueCredentials(grant, repo, access, opts) {
      repoPath(repo)
      if (grant.kind !== 'anonymous' || access !== 'read')
        throw gitNotSupported('access other than an anonymous read on GitHub before Э10')
      return {
        auth: { kind: 'anonymous' },
        basic: null,
        expiresAt: new Date(Date.now() + opts.ttlSeconds * 1000),
      }
    },

    whoAmI: notYet('a sign-in'),
    listRepositories: notYet('a list of repositories'),

    async getRepository(auth, repo) {
      const response = await get(auth, repoPath(repo))
      // A private repository answers 404 to an anonymous read, like a missing one.
      if (response.status === 404) return null
      return repositoryOf(jsonOf(response))
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

    openPullRequest: notYet('opening a pull request'),

    async getPullRequest(auth, repo, number) {
      const response = await get(
        auth,
        `${repoPath(repo)}/pulls/${numericId(number, 'pull request')}`,
      )
      if (response.status === 404) return null
      const parsed = pullSchema.safeParse(jsonOf(response))
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
        state: p.merged_at
          ? 'merged'
          : p.state === 'open'
            ? p.draft
              ? 'draft'
              : 'open'
            : 'closed',
        // Checks need the check suites of the head (Э10).
        checks: 'none',
        autoMerge: p.auto_merge !== null && p.auto_merge !== undefined,
        mergeSha: p.merged_at && mergeSha !== null && shaPattern.test(mergeSha) ? mergeSha : null,
      }
      return pull
    },

    mergePullRequest: notYet('merging'),
    closePullRequest: notYet('closing a pull request'),

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
      }))
    },

    // The log is a redirect to a short-lived address and needs a token (Э10).
    getJobLog: notYet('a job log'),
    rerunRun: notYet('a rerun'),
    cancelRun: notYet('cancelling a run'),
    listDeployActions: () => Promise.resolve([]),
    startDeploy: notYet('a deploy'),
  }
}
