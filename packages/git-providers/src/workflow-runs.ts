import type { WorkflowConclusion, WorkflowRun, WorkflowStatus } from '@repo/domain'

/**
 * GitHub statuses and conclusions, which Gitea reuses in webhooks and in its REST API. Anything
 * that is not clearly a success counts as a failure: an unknown conclusion must never pass for a
 * successful deploy.
 */
export function runState(
  status: string,
  conclusion: string | null | undefined,
): { status: WorkflowStatus; conclusion: WorkflowConclusion } {
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

/**
 * `deploy.yml@refs/tags/v1.2.0` — how Gitea 1.27.3 names the workflow of a run in
 * `workflow_run.path`, in the webhook and in the REST API alike (recorded 2026-10-04 and
 * 2026-10-17). A path without `@` is a file alone: GitHub sends the repository path there.
 */
export function workflowOfRun(
  path: string | null | undefined,
): Pick<WorkflowRun, 'workflowFile' | 'ref'> {
  if (!path) return { workflowFile: null, ref: null }
  const at = path.indexOf('@')
  if (at < 0) return { workflowFile: path, ref: null }
  const ref = path.slice(at + 1)
  return { workflowFile: path.slice(0, at) || null, ref: ref.startsWith('refs/') ? ref : null }
}
