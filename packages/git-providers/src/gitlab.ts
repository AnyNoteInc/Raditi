import { z } from 'zod'

import {
  checksOf,
  gitlabComHost,
  gitNotSupported,
  gitProviderFailed,
  isRepoPath,
  repoChanged,
  repoCloneUrl,
  repoNotMergeable,
  repoWebUrl,
  sameHostUrl,
  type CiJob,
  type CiRefusal,
  type CiRun,
  type CiStatus,
  type DeployAction,
  type GitAuth,
  type GitProvider,
  type GitProviderSupport,
  type PullRequest,
  type RepoRef,
  type RepositoryInfo,
} from '@repo/domain'

import { call, dateOf, jsonOf, numericId, shaPattern } from './api.ts'
import { assertGitlabPath } from './gitlab-paths.ts'
import type { GitSession, GitTransport } from './transport.ts'

// GitLab REST v4 (https://docs.gitlab.com/api/rest/): gitlab.com and the client's own server
// (docs/plan/84-projects.md, ПР10, ПР11, §4.5). One adapter per host. Every path goes through the
// whitelist of the attached project (gitlab-paths.ts); addresses are built from the host and the
// project id, never from an answer.

export interface GitlabProviderConfig {
  host: string
  transport: GitTransport
  /** Stands only: `https://localhost:<port>` instead of `https://<host>` (parsed by the caller). */
  baseUrl?: URL | null
}

/** Paths of build settings on GitLab (ПР16), besides `forbiddenCiPaths` of the domain. */
export const gitlabCiPaths = [
  '.gitlab-ci.yml',
  '.gitlab/',
  'CODEOWNERS',
  'docs/CODEOWNERS',
] as const

/** The log of a job is read up to this many bytes, then only its tail is kept (§4.7). */
export const jobLogReadLimit = 32 * 1024 * 1024

const projectSchema = z.looseObject({
  id: z.number().int().positive(),
  path_with_namespace: z.string(),
  default_branch: z.string().nullish(),
  visibility: z.string().nullish(),
  web_url: z.unknown().optional(),
  statistics: z.looseObject({ repository_size: z.number().nonnegative().nullish() }).nullish(),
  ci_config_path: z.string().max(255).nullish(),
})

const pipelineRefSchema = z.looseObject({ id: z.number().int(), status: z.string() }).nullish()

const mergeRequestSchema = z.looseObject({
  iid: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean().nullish(),
  source_branch: z.string(),
  target_branch: z.string(),
  sha: z.string().nullish(),
  merge_commit_sha: z.string().nullish(),
  squash_commit_sha: z.string().nullish(),
  merge_when_pipeline_succeeds: z.boolean().nullish(),
  web_url: z.unknown().optional(),
  head_pipeline: pipelineRefSchema,
  pipeline: pipelineRefSchema,
})

const pipelineSchema = z.looseObject({
  id: z.number().int().positive(),
  sha: z.string(),
  ref: z.string().nullish(),
  status: z.string(),
  name: z.string().nullish(),
  source: z.string().nullish(),
  web_url: z.unknown().optional(),
  created_at: z.string().nullish(),
  started_at: z.string().nullish(),
  finished_at: z.string().nullish(),
  failure_reason: z.string().nullish(),
})

const jobSchema = z.looseObject({
  id: z.number().int().positive(),
  name: z.string(),
  stage: z.string().nullish(),
  status: z.string(),
  web_url: z.unknown().optional(),
  started_at: z.string().nullish(),
  finished_at: z.string().nullish(),
  failure_reason: z.string().nullish(),
  pipeline: z.looseObject({ id: z.number().int(), sha: z.string().nullish() }).nullish(),
})

const lintSchema = z.looseObject({
  valid: z.boolean(),
  errors: z.array(z.string()).default([]),
  includes: z.array(z.looseObject({ type: z.string(), location: z.string() })).nullish(),
})

/** GitLab's pipeline and job statuses in the words of the platform (https://docs.gitlab.com/api/jobs/). */
export function gitlabCiStatus(status: string): CiStatus {
  switch (status) {
    case 'running':
    case 'canceling':
      return 'running'
    case 'manual':
      return 'manual'
    case 'success':
      return 'success'
    case 'failed':
      return 'failed'
    case 'canceled':
      return 'canceled'
    case 'skipped':
      return 'skipped'
    default:
      // created, waiting_for_resource, preparing, pending, scheduled, waiting_for_callback
      return 'pending'
  }
}

/**
 * A job or a pipeline gitlab.com did not start because the account is not verified (ПР17): the
 * failure reason `user_not_verified` (https://docs.gitlab.com/ci/debugging/, «Identity
 * verification is required in order to run CI jobs»). Checked only against fakes.
 */
export function gitlabCiRefusal(reason: string | null | undefined): CiRefusal | null {
  return reason === 'user_not_verified' ? 'account_unverified' : null
}

export function createGitlabProvider(config: GitlabProviderConfig): GitProvider {
  const { host, transport } = config
  const origin = config.baseUrl ?? new URL(`https://${host}`)
  const support: GitProviderSupport = {
    ciLint: true,
    autoMerge: true,
    manualJobs: true,
    workflowDispatch: false,
    projectHooks: true,
    ciPaths: gitlabCiPaths,
    // «у своего сервера — его имя» (§4.5).
    label: host === gitlabComHost ? 'GitLab' : host,
    requestRef: (n) => `!${n}`,
  }

  const keyOf = (repo: RepoRef): string => {
    if (repo.provider !== 'gitlab' || repo.host !== host)
      throw gitProviderFailed('the repository is not of this server')
    return repo.providerRepoId === undefined
      ? encodeURIComponent(repo.path)
      : numericId(repo.providerRepoId, 'project')
  }

  /** One request of the whitelist; `rest` is below `projects/<key>` (or a top path). */
  const request = async (
    session: GitSession,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    auth: GitAuth,
    repo: RepoRef | null,
    rest: string,
    options: { query?: Record<string, string>; body?: unknown; tailBytes?: number } = {},
  ) => {
    const key = repo === null ? null : keyOf(repo)
    const url = new URL(origin)
    url.pathname = key === null ? `/api/v4${rest}` : `/api/v4/projects/${key}${rest}`
    for (const [name, value] of Object.entries(options.query ?? {}))
      url.searchParams.set(name, value)
    // The check reads the path as URL parsed it: `..` and encoded tricks are already resolved.
    const apiPath = url.pathname.replace(/^\/api\/v4/, '')
    if (!url.pathname.startsWith('/api/v4/')) throw gitProviderFailed('not an API path')
    assertGitlabPath(method, apiPath, url.searchParams, key, options.body)
    return call(session, {
      method,
      url,
      auth,
      body: options.body,
      ...(options.tailBytes === undefined
        ? {}
        : { limits: { tailBytes: options.tailBytes, maxBytes: jobLogReadLimit } }),
    })
  }

  const repositoryOf = (raw: unknown): RepositoryInfo | null => {
    const parsed = projectSchema.safeParse(raw)
    if (!parsed.success) throw gitProviderFailed('a project of an unexpected form')
    const project = parsed.data
    if (!isRepoPath('gitlab', project.path_with_namespace)) return null
    const ref = {
      provider: 'gitlab' as const,
      host,
      path: project.path_with_namespace,
      providerRepoId: String(project.id),
    }
    const size = project.statistics?.repository_size
    return {
      ref,
      defaultBranch: project.default_branch ?? 'main',
      private: project.visibility !== 'public',
      webUrl: sameHostUrl(host, project.web_url, repoWebUrl(ref)),
      cloneUrl: repoCloneUrl(ref),
      sizeBytes: typeof size === 'number' ? size : null,
      ciConfigPath: project.ci_config_path ? project.ci_config_path : null,
    }
  }

  const pullRequestOf = (repo: RepoRef, raw: unknown): PullRequest => {
    const parsed = mergeRequestSchema.safeParse(raw)
    if (!parsed.success) throw gitProviderFailed('a merge request of an unexpected form')
    const mr = parsed.data
    if (mr.sha == null || !shaPattern.test(mr.sha))
      throw gitProviderFailed('a merge request without a head')
    const pipeline = mr.head_pipeline ?? mr.pipeline
    const mergeSha = mr.merge_commit_sha ?? mr.squash_commit_sha ?? null
    return {
      number: mr.iid,
      url: sameHostUrl(host, mr.web_url, `${repoWebUrl(repo)}/-/merge_requests/${mr.iid}`),
      title: mr.title,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      headSha: mr.sha,
      state:
        mr.state === 'merged'
          ? 'merged'
          : mr.state === 'opened'
            ? mr.draft === true
              ? 'draft'
              : 'open'
            : 'closed',
      checks: checksOf(pipeline == null ? null : gitlabCiStatus(pipeline.status)),
      autoMerge: mr.merge_when_pipeline_succeeds === true,
      mergeSha: mergeSha !== null && shaPattern.test(mergeSha) ? mergeSha : null,
    }
  }

  const runOf = (repo: RepoRef, raw: unknown): CiRun => {
    const parsed = pipelineSchema.safeParse(raw)
    if (!parsed.success) throw gitProviderFailed('a pipeline of an unexpected form')
    const p = parsed.data
    return {
      id: String(p.id),
      name: p.name ?? `#${p.id}`,
      sha: p.sha,
      ref: p.ref ?? '',
      status: gitlabCiStatus(p.status),
      url: sameHostUrl(host, p.web_url, `${repoWebUrl(repo)}/-/pipelines/${p.id}`),
      createdAt: dateOf(p.created_at),
      startedAt: dateOf(p.started_at),
      finishedAt: dateOf(p.finished_at),
      event: p.source ?? null,
      refusal: gitlabCiRefusal(p.failure_reason),
    }
  }

  const jobsOf = (repo: RepoRef, runId: string, raw: unknown): CiJob[] => {
    const parsed = z.array(jobSchema).safeParse(raw)
    if (!parsed.success) throw gitProviderFailed('jobs of an unexpected form')
    return parsed.data.map((job) => ({
      id: String(job.id),
      runId,
      name: job.name,
      stage: job.stage ?? null,
      status: gitlabCiStatus(job.status),
      url: sameHostUrl(host, job.web_url, `${repoWebUrl(repo)}/-/jobs/${job.id}`),
      startedAt: dateOf(job.started_at),
      finishedAt: dateOf(job.finished_at),
      refusal: gitlabCiRefusal(job.failure_reason),
    }))
  }

  const fresh = () => transport.session()

  const provider: GitProvider = {
    kind: 'gitlab',
    support,

    async issueCredentials(grant, repo, _access, opts) {
      keyOf(repo)
      const expiresAt = new Date(Date.now() + opts.ttlSeconds * 1000)
      if (grant.kind === 'anonymous') return { auth: { kind: 'anonymous' }, basic: null, expiresAt }
      if (grant.kind !== 'token') throw gitNotSupported('a GitHub installation on GitLab')
      // OAuth tokens authenticate git over HTTPS as `oauth2`; a personal or project token takes any
      // non-empty user name (https://docs.gitlab.com/api/oauth2/).
      return {
        auth: { kind: 'bearer', token: grant.token },
        basic: { username: 'oauth2', password: grant.token },
        expiresAt,
      }
    },

    async whoAmI(auth) {
      const body = jsonOf(await request(fresh(), 'GET', auth, null, '/user'))
      const user = z.looseObject({ id: z.number().int(), username: z.string() }).safeParse(body)
      if (!user.success) throw gitProviderFailed('a user of an unexpected form')
      return { login: user.data.username, id: String(user.data.id) }
    },

    async listRepositories(auth, page) {
      const response = await request(fresh(), 'GET', auth, null, '/projects', {
        query: {
          membership: 'true',
          archived: 'false',
          order_by: 'last_activity_at',
          per_page: '50',
          page: page !== undefined && /^[1-9][0-9]{0,5}$/.test(page) ? page : '1',
        },
      })
      const body = jsonOf(response)
      if (!Array.isArray(body)) throw gitProviderFailed('projects of an unexpected form')
      const next = response.headers.get('x-next-page')
      return {
        items: body.map(repositoryOf).filter((item): item is RepositoryInfo => item !== null),
        next: next !== null && /^[1-9][0-9]{0,5}$/.test(next) ? next : null,
      }
    },

    async getRepository(auth, repo) {
      const response = await request(fresh(), 'GET', auth, repo, '', {
        query: { statistics: 'true' },
      })
      if (response.status === 404) return null
      return repositoryOf(jsonOf(response))
    },

    async listBranches(auth, repo, query) {
      const response = await request(fresh(), 'GET', auth, repo, '/repository/branches', {
        query: { per_page: '100', ...(query ? { search: query } : {}) },
      })
      const parsed = z.array(z.looseObject({ name: z.string() })).safeParse(jsonOf(response))
      if (!parsed.success) throw gitProviderFailed('branches of an unexpected form')
      return parsed.data.map((b) => b.name)
    },

    async openPullRequest(auth, repo, input) {
      // A draft is a title prefix on GitLab (https://docs.gitlab.com/user/project/merge_requests/drafts/).
      const response = await request(fresh(), 'POST', auth, repo, '/merge_requests', {
        body: {
          source_branch: input.head,
          target_branch: input.base,
          title: input.draft ? `Draft: ${input.title}` : input.title,
          description: input.body,
          remove_source_branch: false,
        },
      })
      return pullRequestOf(repo, jsonOf(response))
    },

    async getPullRequest(auth, repo, number) {
      const response = await request(
        fresh(),
        'GET',
        auth,
        repo,
        `/merge_requests/${numericId(number, 'merge request')}`,
      )
      if (response.status === 404) return null
      return pullRequestOf(repo, jsonOf(response))
    },

    async mergePullRequest(auth, repo, number, opts) {
      if (!shaPattern.test(opts.expectedHeadSha)) throw repoChanged()
      const response = await request(
        fresh(),
        'PUT',
        auth,
        repo,
        `/merge_requests/${numericId(number, 'merge request')}/merge`,
        {
          body: {
            sha: opts.expectedHeadSha,
            should_remove_source_branch: opts.deleteBranch,
            // `auto_merge` since 17.11; a server that predates it reads the deprecated name and
            // ignores the other — both go, so an old server never merges at once instead.
            ...(opts.whenGreen ? { auto_merge: true, merge_when_pipeline_succeeds: true } : {}),
          },
        },
      )
      // https://docs.gitlab.com/api/merge_requests/#merge-a-merge-request
      if (response.status === 409) throw repoChanged()
      if (response.status === 405 || response.status === 422) throw repoNotMergeable()
      const mr = pullRequestOf(repo, jsonOf(response))
      if (mr.headSha !== opts.expectedHeadSha) throw repoChanged()
      if (mr.state === 'merged')
        return mr.mergeSha === null
          ? { state: 'merged' }
          : { state: 'merged', mergeSha: mr.mergeSha }
      if (opts.whenGreen && mr.autoMerge) return { state: 'scheduled' }
      throw repoNotMergeable()
    },

    async cancelAutoMerge(auth, repo, number) {
      const iid = numericId(number, 'merge request')
      const session = fresh()
      // `cancel_auto_merge` since GitLab 19.5 answers with the merge request; older servers have
      // only the deprecated endpoint, which answers 201 with `status` (success or error).
      const current = await request(
        session,
        'POST',
        auth,
        repo,
        `/merge_requests/${iid}/cancel_auto_merge`,
      )
      if (current.status !== 404) {
        const mr = pullRequestOf(repo, jsonOf(current))
        return !mr.autoMerge
      }
      const legacy = await request(
        session,
        'POST',
        auth,
        repo,
        `/merge_requests/${iid}/cancel_merge_when_pipeline_succeeds`,
      )
      if (legacy.status === 404) return false
      const body = z.looseObject({ status: z.string().optional() }).safeParse(jsonOf(legacy))
      return body.success && body.data.status === 'success'
    },

    async closePullRequest(auth, repo, number) {
      jsonOf(
        await request(
          fresh(),
          'PUT',
          auth,
          repo,
          `/merge_requests/${numericId(number, 'merge request')}`,
          {
            body: { state_event: 'close' },
          },
        ),
      )
    },

    async listRuns(auth, repo, filter) {
      const response = await request(fresh(), 'GET', auth, repo, '/pipelines', {
        query: {
          per_page: '20',
          order_by: 'id',
          sort: 'desc',
          ...(filter.branch === undefined ? {} : { ref: filter.branch }),
          ...(filter.sha === undefined ? {} : { sha: filter.sha }),
        },
      })
      const body = jsonOf(response)
      if (!Array.isArray(body)) throw gitProviderFailed('pipelines of an unexpected form')
      return body.map((p) => runOf(repo, p))
    },

    async getRun(auth, repo, runId) {
      const response = await request(
        fresh(),
        'GET',
        auth,
        repo,
        `/pipelines/${numericId(runId, 'pipeline')}`,
      )
      if (response.status === 404) return null
      return runOf(repo, jsonOf(response))
    },

    async listJobs(auth, repo, runId) {
      const id = numericId(runId, 'pipeline')
      const response = await request(fresh(), 'GET', auth, repo, `/pipelines/${id}/jobs`, {
        query: { per_page: '100' },
      })
      return jobsOf(repo, id, jsonOf(response))
    },

    async getJobLog(auth, repo, jobId, opts) {
      const response = await request(
        fresh(),
        'GET',
        auth,
        repo,
        `/jobs/${numericId(jobId, 'job')}/trace`,
        { tailBytes: opts.tailBytes },
      )
      if (response.status === 404) return { text: '', truncated: false }
      if (response.status === 401 || response.status === 403) jsonOf(response)
      if (response.status !== 200) throw gitProviderFailed('unexpected answer', response.status)
      // A tail may start inside a character: the decoder writes a replacement, never throws.
      return { text: new TextDecoder('utf-8').decode(response.body), truncated: response.truncated }
    },

    async rerunRun(auth, repo, runId) {
      jsonOf(
        await request(
          fresh(),
          'POST',
          auth,
          repo,
          `/pipelines/${numericId(runId, 'pipeline')}/retry`,
        ),
      )
    },

    async cancelRun(auth, repo, runId) {
      jsonOf(
        await request(
          fresh(),
          'POST',
          auth,
          repo,
          `/pipelines/${numericId(runId, 'pipeline')}/cancel`,
        ),
      )
    },

    async listDeployActions(auth, repo, ref) {
      const session = fresh()
      const runs = jsonOf(
        await request(session, 'GET', auth, repo, '/pipelines', {
          query: { ref, per_page: '1', order_by: 'id', sort: 'desc' },
        }),
      )
      if (!Array.isArray(runs)) throw gitProviderFailed('pipelines of an unexpected form')
      if (runs.length === 0) return []
      const run = runOf(repo, runs[0])
      const jobs = jsonOf(
        await request(session, 'GET', auth, repo, `/pipelines/${run.id}/jobs`, {
          query: { per_page: '100', 'scope[]': 'manual' },
        }),
      )
      return jobsOf(repo, run.id, jobs)
        .filter((job) => job.status === 'manual')
        .map((job): DeployAction => ({
          id: job.id,
          kind: 'manual_job',
          name: job.name,
          ref,
          sha: run.sha,
        }))
    },

    async startDeploy(auth, repo, action) {
      if (action.kind !== 'manual_job') throw gitNotSupported('workflow_dispatch')
      const body = jsonOf(
        await request(fresh(), 'POST', auth, repo, `/jobs/${numericId(action.id, 'job')}/play`),
      )
      const job = jobSchema.safeParse(body)
      return { runId: job.success && job.data.pipeline ? String(job.data.pipeline.id) : null }
    },

    async lintCi(auth, repo, content, ref) {
      const parsed = lintSchema.safeParse(
        jsonOf(
          await request(fresh(), 'POST', auth, repo, '/ci/lint', {
            body: { content, dry_run: true, ref, include_jobs: false },
          }),
        ),
      )
      if (!parsed.success) throw gitProviderFailed('a lint answer of an unexpected form')
      return {
        valid: parsed.data.valid,
        errors: parsed.data.errors.slice(0, 50),
        includes: (parsed.data.includes ?? [])
          .filter((include) => include.type === 'local')
          .map((include) => include.location),
      }
    },

    async createHook(auth, repo, hook) {
      const body = jsonOf(
        await request(fresh(), 'POST', auth, repo, '/hooks', {
          body: {
            url: hook.url,
            token: hook.token,
            push_events: true,
            merge_requests_events: true,
            pipeline_events: true,
            enable_ssl_verification: true,
          },
        }),
      )
      const parsed = z.looseObject({ id: z.number().int().positive() }).safeParse(body)
      if (!parsed.success) throw gitProviderFailed('a hook of an unexpected form')
      return { hookId: String(parsed.data.id) }
    },

    async deleteHook(auth, repo, hookId) {
      const response = await request(
        fresh(),
        'DELETE',
        auth,
        repo,
        `/hooks/${numericId(hookId, 'hook')}`,
      )
      if (response.status !== 404) jsonOf(response)
    },
  }
  return provider
}
