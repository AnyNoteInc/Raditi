import type { GitProviderKind, GitWebhookEvent, RepoRef, WorkflowRun } from '@repo/domain'
import { z } from 'zod'

// Provider webhook payloads → GitWebhookEvent. Only the fields the orchestrator needs are
// read; everything else is ignored. A payload that does not match yields null.

const sha = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i)
  .transform((s) => s.toLowerCase())
const isZeroSha = (s: string) => /^0+$/.test(s)
const httpUrl = z.url({ protocol: /^https?$/ }).max(2048)
const segment = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^/\s]+$/)
const branch = z
  .string()
  .min(1)
  .max(255)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f\x7f]+$/)

const BRANCH_REF = 'refs/heads/'

/** A push to a branch; tags and branch deletions are not events for the orchestrator. */
function pushEvent(repo: RepoRef, ref: string, after: string): GitWebhookEvent | null {
  if (!ref.startsWith(BRANCH_REF) || isZeroSha(after)) return null
  const parsed = branch.safeParse(ref.slice(BRANCH_REF.length))
  return parsed.success ? { kind: 'push', repo, branch: parsed.data, headSha: after } : null
}

// --- Gitea and GitHub: Gitea mirrors the GitHub payloads for these three events ------------

const githubStyleRepository = z.object({
  name: segment,
  owner: z.object({ login: segment }),
})

const githubStylePullRequest = z.object({
  pull_request: z.object({
    number: z.number().int().positive(),
    html_url: httpUrl,
    state: z.enum(['open', 'closed']),
    merged: z.boolean().nullish(),
    head: z.object({ ref: branch, sha }),
    base: z.object({ ref: branch }),
  }),
  repository: githubStyleRepository,
})

const githubStyleWorkflowRun = z.object({
  workflow_run: z.object({
    id: z.number().int().nonnegative(),
    name: z.string().max(255).nullish(),
    display_title: z.string().max(1024).nullish(),
    head_sha: sha,
    status: z.string().max(64),
    conclusion: z.string().max(64).nullish(),
    html_url: httpUrl,
  }),
  workflow: z.object({ name: z.string().max(255).nullish() }).nullish(),
  repository: githubStyleRepository,
})

const githubStylePush = z.object({
  ref: z.string().max(1024),
  after: sha,
  deleted: z.boolean().optional(),
  repository: githubStyleRepository,
})

/**
 * GitHub statuses and conclusions, which Gitea reuses. Anything that is not clearly a success
 * counts as a failure: an unknown conclusion must never pass for a successful deploy.
 */
function runState(
  status: string,
  conclusion: string | null | undefined,
): Pick<WorkflowRun, 'status' | 'conclusion'> {
  if (status === 'in_progress') return { status: 'in_progress', conclusion: null }
  if (status !== 'completed') return { status: 'queued', conclusion: null }
  switch (conclusion) {
    case 'success':
      return { status: 'completed', conclusion: 'success' }
    case 'skipped':
    case 'neutral':
      return { status: 'completed', conclusion: 'skipped' }
    case 'cancelled':
    case 'stale':
      return { status: 'completed', conclusion: 'cancelled' }
    default:
      return { status: 'completed', conclusion: 'failure' }
  }
}

/** `event` is X-Gitea-Event or X-GitHub-Event. */
export function normalizeGithubStyleEvent(
  provider: Extract<GitProviderKind, 'gitea' | 'github'>,
  event: string,
  payload: unknown,
): GitWebhookEvent | null {
  const repoRef = (r: z.infer<typeof githubStyleRepository>): RepoRef => ({
    provider,
    owner: r.owner.login,
    name: r.name,
  })

  switch (event) {
    case 'pull_request': {
      const parsed = githubStylePullRequest.safeParse(payload)
      if (!parsed.success) return null
      const pr = parsed.data.pull_request
      return {
        kind: 'pull_request',
        repo: repoRef(parsed.data.repository),
        pullRequest: {
          number: pr.number,
          url: pr.html_url,
          headBranch: pr.head.ref,
          headSha: pr.head.sha,
          baseBranch: pr.base.ref,
          state: pr.merged ? 'merged' : pr.state,
        },
      }
    }
    case 'workflow_run': {
      const parsed = githubStyleWorkflowRun.safeParse(payload)
      if (!parsed.success) return null
      const run = parsed.data.workflow_run
      return {
        kind: 'workflow_run',
        repo: repoRef(parsed.data.repository),
        run: {
          id: String(run.id),
          name: run.name || parsed.data.workflow?.name || run.display_title || 'workflow',
          headSha: run.head_sha,
          ...runState(run.status, run.conclusion),
          url: run.html_url,
        },
      }
    }
    case 'push': {
      const parsed = githubStylePush.safeParse(payload)
      if (!parsed.success || parsed.data.deleted) return null
      return pushEvent(repoRef(parsed.data.repository), parsed.data.ref, parsed.data.after)
    }
    default:
      return null
  }
}

// --- GitLab ---------------------------------------------------------------------------------

const gitlabProject = z.object({
  // group/subgroup/project: the owner is the whole namespace path.
  path_with_namespace: z
    .string()
    .max(1024)
    .regex(/^[^/\s]+(?:\/[^/\s]+)+$/),
  web_url: httpUrl,
})

const gitlabPush = z.object({
  object_kind: z.literal('push'),
  ref: z.string().max(1024),
  after: sha,
  project: gitlabProject,
})

const gitlabMergeRequest = z.object({
  object_kind: z.literal('merge_request'),
  project: gitlabProject,
  object_attributes: z.object({
    iid: z.number().int().positive(),
    url: httpUrl,
    source_branch: branch,
    target_branch: branch,
    state: z.enum(['opened', 'closed', 'merged', 'locked']),
    last_commit: z.object({ id: sha }),
  }),
})

const gitlabPipeline = z.object({
  object_kind: z.literal('pipeline'),
  project: gitlabProject,
  object_attributes: z.object({
    id: z.number().int().nonnegative(),
    name: z.string().max(255).nullish(),
    sha,
    status: z.string().max(64),
    url: httpUrl.optional(),
  }),
})

function gitlabRunState(status: string): Pick<WorkflowRun, 'status' | 'conclusion'> {
  switch (status) {
    case 'success':
      return { status: 'completed', conclusion: 'success' }
    case 'failed':
      return { status: 'completed', conclusion: 'failure' }
    case 'canceled':
      return { status: 'completed', conclusion: 'cancelled' }
    case 'skipped':
      return { status: 'completed', conclusion: 'skipped' }
    case 'running':
    case 'canceling':
      return { status: 'in_progress', conclusion: null }
    default:
      // created, pending, preparing, waiting_for_resource, scheduled, manual…
      return { status: 'queued', conclusion: null }
  }
}

function gitlabRepoRef(project: z.infer<typeof gitlabProject>): RepoRef {
  const path = project.path_with_namespace
  const slash = path.lastIndexOf('/')
  return { provider: 'gitlab', owner: path.slice(0, slash), name: path.slice(slash + 1) }
}

/** `event` is X-Gitlab-Event; `object_kind` in the body must agree with it. */
export function normalizeGitlabEvent(event: string, payload: unknown): GitWebhookEvent | null {
  switch (event) {
    case 'Merge Request Hook': {
      const parsed = gitlabMergeRequest.safeParse(payload)
      if (!parsed.success) return null
      const mr = parsed.data.object_attributes
      const state = mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'open'
      return {
        kind: 'pull_request',
        repo: gitlabRepoRef(parsed.data.project),
        pullRequest: {
          number: mr.iid,
          url: mr.url,
          headBranch: mr.source_branch,
          headSha: mr.last_commit.id,
          baseBranch: mr.target_branch,
          state,
        },
      }
    }
    case 'Pipeline Hook': {
      const parsed = gitlabPipeline.safeParse(payload)
      if (!parsed.success) return null
      const pipeline = parsed.data.object_attributes
      return {
        kind: 'workflow_run',
        repo: gitlabRepoRef(parsed.data.project),
        run: {
          id: String(pipeline.id),
          name: pipeline.name || 'pipeline',
          headSha: pipeline.sha,
          ...gitlabRunState(pipeline.status),
          url: pipeline.url ?? `${parsed.data.project.web_url}/-/pipelines/${pipeline.id}`,
        },
      }
    }
    case 'Push Hook': {
      const parsed = gitlabPush.safeParse(payload)
      if (!parsed.success) return null
      return pushEvent(gitlabRepoRef(parsed.data.project), parsed.data.ref, parsed.data.after)
    }
    default:
      return null
  }
}
