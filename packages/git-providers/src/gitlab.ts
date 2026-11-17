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
  repoRunGone,
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
import type { GitHttpResponse, GitSession, GitTransport } from './transport.ts'

// GitLab REST v4 (https://docs.gitlab.com/api/rest/): gitlab.com and the client's own server
// (docs/plan/84-projects.md, ПР10, ПР11, §4.5). One adapter per host. Every path goes through the
// whitelist of the attached project (gitlab-paths.ts); addresses are built from the host and the
// project id, never from an answer.

export interface GitlabProviderConfig {
  host: string
  transport: GitTransport
  /** Stands only: `https://localhost:<port>` instead of `https://<host>` (parsed by the caller). */
  baseUrl?: URL | null
  /**
   * How long the adapter waits for GitLab to catch up with what just happened: a merge for the
   * check of whether a request can merge, a new merge request for the push of its branch (see
   * `mergePullRequest`, `openPullRequest`) — `tries` attempts, `everyMs` apart. Tests shorten it.
   */
  settle?: { tries: number; everyMs: number }
}

/**
 * 20 attempts half a second apart. GitLab CE 19.5.6 took about 0.6 s to check a fresh request, and
 * knew a pushed branch about 0.3 s after the push.
 */
export const gitlabSettleDefaults = Object.freeze({ tries: 20, everyMs: 500 })

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
  // https://docs.gitlab.com/api/projects/#get-a-single-project: the access of the token's user.
  permissions: z
    .looseObject({
      project_access: z.looseObject({ access_level: z.number().int() }).nullish(),
      group_access: z.looseObject({ access_level: z.number().int() }).nullish(),
    })
    .nullish(),
})

/** Maintainer (https://docs.gitlab.com/api/members/#roles): what a project hook needs (ПР17). */
const MAINTAINER = 40

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
  updated_at: z.string().nullish(),
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

/**
 * `detailed_merge_status` while GitLab still computes whether a request can merge: a request just
 * opened (`preparing`, then `checking`) or one whose target moved since it was last read
 * (`unchecked` until a read starts the check). A merge then is 405, a merge when green 422 —
 * checked on GitLab CE 19.5.6 (docs/plan/84-projects.md, §10, «Живая проверка GitLab CE»).
 */
const STILL_CHECKING = new Set(['unchecked', 'checking', 'preparing', 'approvals_syncing'])

/** A pipeline that is over. */
const PIPELINE_OVER = new Set(['success', 'failed', 'canceled', 'skipped'])

// GitLab Runner writes every line of a job's log with a prefix (on by default in Runner 19, checked
// on 19.5.3): `<RFC 3339 time> <stream, 2 hex><O|E><' ' or '+'>`, where `+` continues the line
// before. The API gives the log so; GitLab's own page shows it without. A log without the prefix
// (an older runner) is left as it is.
const TRACE_PREFIX = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z [0-9a-f]{2}[OE]([ +])/

/**
 * The text of a job's log as the build wrote it (ПР17): the runner's prefixes taken off, the parts
 * of one line joined. The first line of a tail starts inside a line and is left out.
 */
export function gitlabTraceText(raw: string, truncated: boolean): string {
  const lines = raw.split('\n')
  if (truncated && lines.length > 1) lines.shift()
  const out: string[] = []
  for (const line of lines) {
    const prefix = TRACE_PREFIX.exec(line)
    if (prefix === null) out.push(line)
    else if (prefix[1] === '+' && out.length > 0)
      out[out.length - 1] += line.slice(prefix[0].length)
    else out.push(line.slice(prefix[0].length))
  }
  return out.join('\n')
}

/** A path `include:` names: a file of this repository, another place, or a form not read. */
type Named = { path: string } | 'elsewhere' | 'unknown'

/** The keys of an include that are another place than this repository. */
const ELSEWHERE = new Set(['project', 'remote', 'template', 'component'])
/** More include entries than this are not read one by one: every path is a build path. */
const INCLUDES_READ = 200

/** A line without its YAML comment — one pass, so no text of the agent makes it slow. */
function withoutComment(text: string): string {
  const at = text.search(/(?:^|\s)#/)
  return (at < 0 ? text : text.slice(0, at)).trim()
}

/** A scalar of `include` or `local:`: a variable in a path is any name (`*`). */
function namedOf(raw: string): Named {
  const text = withoutComment(raw)
  // An alias, an anchor, a tag, a block scalar or a flow of YAML is not read as a path; a wildcard
  // is quoted.
  if (text === '' || /^[*&!|>[{]/.test(text)) return 'unknown'
  const quoted = /^(['"])(.*)\1$/.exec(text)
  if (quoted === null && /^['"]/.test(text)) return 'unknown'
  const path = quoted === null ? text : quoted[2]!
  if (path === '') return 'unknown'
  if (path.includes('://')) return 'elsewhere'
  if (/[[\]{},]/.test(path)) return 'unknown'
  return { path: path.replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, '*') }
}

/** The parts of a flow `[…]` or `{…}` of one line, split at its own commas. */
function flowParts(inner: string): string[] | null {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let from = 0
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!
    if (quote !== null) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') {
      if (--depth < 0) return null
    } else if (c === ',' && depth === 0) {
      parts.push(inner.slice(from, i).trim())
      from = i + 1
    }
  }
  if (quote !== null || depth !== 0) return null
  parts.push(inner.slice(from).trim())
  return parts.filter((part) => part !== '')
}

const KEY = /^(?:"([A-Za-z_]+)"|'([A-Za-z_]+)'|([A-Za-z_]+))\s*:(?:\s+(.*))?$/

/** One entry of a flow: `{ local: a.yml }` or a path. */
function flowEntry(part: string): Named[] {
  if (!part.startsWith('{')) return [namedOf(part)]
  const parts = part.endsWith('}') ? flowParts(part.slice(1, -1)) : null
  if (parts === null) return ['unknown']
  let local: Named | null = null
  for (const pair of parts) {
    const key = KEY.exec(pair)
    const name = key?.[1] ?? key?.[2] ?? key?.[3]
    if (name === 'local') local = namedOf(key?.[4] ?? '')
    else if (name !== undefined && ELSEWHERE.has(name)) return ['elsewhere']
  }
  return [local ?? 'unknown']
}

/** `include: […]` or `include: {…}` on one line. */
function flowOf(text: string): Named[] {
  if (text.startsWith('{')) return flowEntry(text)
  const parts = text.endsWith(']') ? flowParts(text.slice(1, -1)) : null
  return parts === null ? ['unknown'] : parts.flatMap(flowEntry)
}

/** A scalar or a one-line flow. */
const entryOf = (text: string): Named[] =>
  text.startsWith('[') || text.startsWith('{') ? flowOf(text) : [namedOf(text)]

/**
 * The files of `include: local` (and of `trigger: include`) a configuration names in its own text
 * (ПР16): the plain form, a list of paths, `local:` keys and one-line flows; `project:`, `remote:`,
 * `template:` and `component:` are other places and stay out. GitLab's CI Lint names only the
 * files that exist at the ref it is asked for, with a wildcard already expanded, and none at all
 * when one is missing (GitLab CE 19.5.6) — so a file the chat's branch adds, or that only a
 * wildcard covers, comes from here. A reading of the text, not a YAML parser, and closed where it
 * cannot read: a form it does not know, or more than INCLUDES_READ entries, is `*` — every path.
 * Linear in the text: the configuration is the agent's.
 */
export function gitlabLocalIncludes(content: string): string[] {
  const named: Named[] = []
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length && named.length <= INCLUDES_READ; i++) {
    const at = /^(\s*)(?:-\s+)?include:(?:\s+(.*))?$/.exec(lines[i]!)
    if (at === null) continue
    const indent = at[1]!.length
    // `include: &anchor` names the block below.
    const inline = withoutComment(at[2] ?? '').replace(/^&\S+$/, '')
    if (inline !== '') named.push(...entryOf(inline))
    // The block below: deeper lines, or list items at the same depth. A path alone is an entry
    // of the include list itself, not of a list deeper in it (`rules: - exists: - Dockerfile`).
    let other = false
    let itemDepth = -1
    let j = i + 1
    for (; j < lines.length && named.length <= INCLUDES_READ; j++) {
      const line = lines[j]!
      const body = withoutComment(line.replace(/^\s*-(?=\s|$)/, ''))
      const item = /^\s*-(?:\s|$)/.test(line)
      if (body === '' && !item) continue
      const depth = line.length - line.trimStart().length
      if (depth < indent || (depth === indent && !item)) break
      if (item && itemDepth < 0) itemDepth = depth
      const entry = item && depth === itemDepth
      if (entry) other = false
      const key = KEY.exec(body)
      const name = key?.[1] ?? key?.[2] ?? key?.[3]
      if (name === 'local') named.push(namedOf(key?.[4] ?? ''))
      else if (name !== undefined) {
        if (ELSEWHERE.has(name)) other = true
      } else if (entry && !other) named.push(...entryOf(body))
    }
    // The block is read: the next `include:` is after it.
    i = j - 1
  }
  if (named.length > INCLUDES_READ) return ['*']
  const paths = new Set<string>()
  for (const entry of named)
    if (entry === 'unknown') paths.add('*')
    else if (entry !== 'elsewhere') paths.add(entry.path)
  return [...paths].sort()
}

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
    checksWait: false,
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
      ...(project.permissions == null
        ? {}
        : {
            canManageHooks:
              Math.max(
                project.permissions.project_access?.access_level ?? 0,
                project.permissions.group_access?.access_level ?? 0,
              ) >= MAINTAINER,
          }),
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
      // The list of pipelines has no `started_at` and `finished_at`, only the pipeline itself
      // (GitLab CE 19.5.6): a pipeline that is over ended when it last changed.
      finishedAt:
        dateOf(p.finished_at) ?? (PIPELINE_OVER.has(p.status) ? dateOf(p.updated_at) : null),
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

  const settle = config.settle ?? gitlabSettleDefaults
  const pause = () => new Promise((done) => setTimeout(done, settle.everyMs))
  /**
   * After GitLab refused a merge: reads the request while it is STILL_CHECKING, at most
   * `settle.tries` times. True — it was being checked, or can merge now: the refusal was not
   * GitLab's answer, and the merge may be asked again.
   */
  const checkedSince = async (
    session: GitSession,
    auth: GitAuth,
    repo: RepoRef,
    iid: string,
    target: string | undefined,
  ): Promise<boolean> => {
    let waited = false
    for (let i = 0; i < settle.tries; i++) {
      const response = await request(session, 'GET', auth, repo, `/merge_requests/${iid}`)
      if (response.status !== 200) return false
      const read = z
        .looseObject({
          detailed_merge_status: z.string().nullish(),
          target_branch: z.string().nullish(),
        })
        .safeParse(jsonOf(response))
      // A target changed while the request was checked is not the one the client was shown (ПР15).
      if (target !== undefined && read.success && read.data.target_branch !== target)
        throw repoChanged()
      const status = read.success ? (read.data.detailed_merge_status ?? null) : null
      if (status === null || !STILL_CHECKING.has(status)) return waited || status === 'mergeable'
      waited = true
      await pause()
    }
    return false
  }

  /**
   * 400 `{"message":{"source_branch":["does not exist"]}}`: GitLab does not know a branch pushed a
   * moment ago yet — 3 of 8 requests opened right after the push on GitLab CE 19.5.6, known on the
   * next attempt. Nothing was opened.
   */
  const branchNotKnownYet = (response: GitHttpResponse): boolean => {
    if (response.status !== 400) return false
    let raw: unknown
    try {
      raw = JSON.parse(response.body.toString('utf8'))
    } catch {
      return false
    }
    const body = z
      .looseObject({ message: z.looseObject({ source_branch: z.array(z.string()).optional() }) })
      .safeParse(raw)
    return body.success && (body.data.message.source_branch ?? []).includes('does not exist')
  }

  const provider: GitProvider = {
    kind: 'gitlab',
    support,

    async issueCredentials(grant, repo, _access, opts) {
      if (repo !== null) keyOf(repo)
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

    async branchHead(auth, repo, branch) {
      // `search` matches parts of names; `^name$` anchors it, and the exact name is still compared
      // (https://docs.gitlab.com/api/branches/#list-repository-branches).
      const response = await request(fresh(), 'GET', auth, repo, '/repository/branches', {
        query: { per_page: '100', search: `^${branch}$` },
      })
      const parsed = z
        .array(z.looseObject({ name: z.string(), commit: z.looseObject({ id: z.string() }) }))
        .safeParse(jsonOf(response))
      if (!parsed.success) throw gitProviderFailed('branches of an unexpected form')
      const found = parsed.data.find((b) => b.name === branch)
      if (found === undefined) return null
      if (!shaPattern.test(found.commit.id)) throw gitProviderFailed('a branch without a head')
      return found.commit.id
    },

    async openPullRequest(auth, repo, input) {
      // A draft is a title prefix on GitLab (https://docs.gitlab.com/user/project/merge_requests/drafts/).
      const session = fresh()
      const open = () =>
        request(session, 'POST', auth, repo, '/merge_requests', {
          body: {
            source_branch: input.head,
            target_branch: input.base,
            title: input.draft ? `Draft: ${input.title}` : input.title,
            description: input.body,
            remove_source_branch: false,
          },
        })
      let response = await open()
      for (let i = 1; i < settle.tries && branchNotKnownYet(response); i++) {
        await pause()
        response = await open()
      }
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

    async findPullRequests(auth, repo, sourceBranch) {
      const response = await request(fresh(), 'GET', auth, repo, '/merge_requests', {
        query: {
          source_branch: sourceBranch,
          order_by: 'created_at',
          sort: 'desc',
          per_page: '20',
        },
      })
      const body = jsonOf(response)
      if (!Array.isArray(body)) throw gitProviderFailed('merge requests of an unexpected form')
      return body
        .map((raw) => pullRequestOf(repo, raw))
        .filter((mr) => mr.sourceBranch === sourceBranch && mr.state !== 'closed')
    },

    async mergePullRequest(auth, repo, number, opts) {
      if (!shaPattern.test(opts.expectedHeadSha)) throw repoChanged()
      const iid = numericId(number, 'merge request')
      const session = fresh()
      const put = () =>
        request(session, 'PUT', auth, repo, `/merge_requests/${iid}/merge`, {
          body: {
            sha: opts.expectedHeadSha,
            should_remove_source_branch: opts.deleteBranch,
            // `auto_merge` since 17.11; a server that predates it reads the deprecated name and
            // ignores the other — both go, so an old server never merges at once instead.
            ...(opts.whenGreen ? { auto_merge: true, merge_when_pipeline_succeeds: true } : {}),
          },
        })
      let response = await put()
      // A refusal while GitLab still checks the request (STILL_CHECKING) is not its answer: the
      // check ends in about a second, then the merge is asked once again.
      if (
        (response.status === 405 || response.status === 422) &&
        (await checkedSince(session, auth, repo, iid, opts.expectedTargetBranch))
      )
        response = await put()
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
      // `cancel_auto_merge` answers 201 with the merge request; older servers have only the
      // deprecated endpoint, which answers 201 with `status` (success or error).
      const current = await request(
        session,
        'POST',
        auth,
        repo,
        `/merge_requests/${iid}/cancel_auto_merge`,
      )
      // 409 «Can't cancel the automatic merge» — none was on, or the request is closed (GitLab CE
      // 19.5.6). The request is read: still waiting is a failure, otherwise nothing was on.
      if (current.status === 409) {
        const now = await request(session, 'GET', auth, repo, `/merge_requests/${iid}`)
        if (now.status === 404) return false
        const mr = pullRequestOf(repo, jsonOf(now))
        if (mr.autoMerge && (mr.state === 'open' || mr.state === 'draft'))
          throw gitProviderFailed('the auto-merge was not taken off', 409)
        return false
      }
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
      const raw = new TextDecoder('utf-8').decode(response.body)
      return { text: gitlabTraceText(raw, response.truncated), truncated: response.truncated }
    },

    async rerunRun(auth, repo, runId) {
      // GitLab's retry of a pipeline runs again only its failed and canceled jobs: of one that
      // passed it runs nothing and answers 201 with it as it was (GitLab CE 19.5.6). What
      // «Запустить снова» means for such a pipeline is the owner's (docs/plan/84-projects.md, §10,
      // «Живая проверка GitLab CE»): retrying its jobs one by one would run a deploy job a person
      // had played, without the card of a deploy.
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
      const played = await request(
        fresh(),
        'POST',
        auth,
        repo,
        `/jobs/${numericId(action.id, 'job')}/play`,
      )
      // 400 «Unplayable Job»: the job is not waiting any more — played already (GitLab CE 19.5.6).
      if (played.status === 400 && /unplayable job/i.test(played.body.toString('utf8')))
        throw repoRunGone()
      const body = jsonOf(played)
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
      // GitLab names the local files that exist at `ref`, a wildcard expanded; what the
      // configuration itself names joins them (gitlabLocalIncludes).
      const named = (parsed.data.includes ?? [])
        .filter((include) => include.type === 'local')
        .map((include) => include.location)
      return {
        valid: parsed.data.valid,
        errors: parsed.data.errors.slice(0, 50),
        includes: [...new Set([...named, ...gitlabLocalIncludes(content)])],
      }
    },

    async createHook(auth, repo, hook) {
      const body = jsonOf(
        await request(fresh(), 'POST', auth, repo, '/hooks', {
          body: {
            url: hook.url,
            token: hook.token,
            // https://docs.gitlab.com/api/project_webhooks/#add-a-webhook-to-a-project: since
            // 19.0; an older server ignores it and answers without `signing_token_present`.
            ...(hook.signingToken === null ? {} : { signing_token: hook.signingToken }),
            name: 'Радити',
            push_events: true,
            merge_requests_events: true,
            pipeline_events: true,
            job_events: false,
            enable_ssl_verification: true,
          },
        }),
      )
      const parsed = z
        .looseObject({
          id: z.number().int().positive(),
          signing_token_present: z.boolean().nullish(),
        })
        .safeParse(body)
      if (!parsed.success) throw gitProviderFailed('a hook of an unexpected form')
      return {
        hookId: String(parsed.data.id),
        signed: hook.signingToken !== null && parsed.data.signing_token_present === true,
      }
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
