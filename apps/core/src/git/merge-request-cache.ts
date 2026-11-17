import { randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@repo/db'
import { isDomainError, type PullRequest } from '@repo/domain'

// The cache of the merge requests of a repository (`project_merge_requests`, §4.1): what core read
// at the provider, never the truth. A merge request opened at the provider for a chat's own branch
// `raditi/…` — by the client in GitLab or GitHub, or one a press found there already — is adopted
// (docs/plan/84-projects.md, «Открытое после ревью», C5; slice 84.26): kept for the chat of that
// branch, so its card offers «Принять» and the poll reads it.

type Db = Pick<PrismaClient, 'projectMergeRequest' | 'projectRepoBranch'> | Prisma.TransactionClient

/** The merge request as read, kept for `taskId` (or for none); a merged one marks its branch. */
export async function cacheMergeRequest(
  db: Db,
  input: { projectRepositoryId: string; taskId: string | null; pr: PullRequest; now: Date },
): Promise<void> {
  const { pr } = input
  const fields = {
    taskId: input.taskId,
    sourceBranch: pr.sourceBranch.slice(0, 255),
    targetBranch: pr.targetBranch.slice(0, 255),
    title: pr.title.slice(0, 255),
    state: pr.state,
    headSha: pr.headSha,
    mergeSha: pr.mergeSha,
    checks: pr.checks,
    autoMerge: pr.autoMerge,
    webUrl: pr.url.slice(0, 500),
    syncedAt: input.now,
  }
  await db.projectMergeRequest.upsert({
    where: {
      projectRepositoryId_number: {
        projectRepositoryId: input.projectRepositoryId,
        number: pr.number,
      },
    },
    create: {
      id: randomUUID(),
      projectRepositoryId: input.projectRepositoryId,
      number: pr.number,
      ...fields,
    },
    update: fields,
  })
  if (pr.state === 'merged' && input.taskId !== null)
    await db.projectRepoBranch.updateMany({
      where: {
        taskId: input.taskId,
        projectRepositoryId: input.projectRepositoryId,
        branch: pr.sourceBranch,
        state: { in: ['pushed', 'closed'] },
      },
      data: { state: 'merged' },
    })
}

/**
 * The chat whose own branch a merge request comes from: a sent branch of a chat of this repository
 * (`project_repo_branches`, by its name), into the main branch. null — not a chat's, so not adopted.
 */
export async function chatOfMergeRequest(
  db: Pick<PrismaClient, 'projectRepoBranch'>,
  input: { projectRepositoryId: string; defaultBranch: string; pr: PullRequest },
): Promise<string | null> {
  if (input.pr.targetBranch !== input.defaultBranch || input.pr.state === 'closed') return null
  const branch = await db.projectRepoBranch.findUnique({
    where: {
      projectRepositoryId_branch: {
        projectRepositoryId: input.projectRepositoryId,
        branch: input.pr.sourceBranch,
      },
    },
    select: { taskId: true, state: true, remoteSha: true },
  })
  if (branch === null || branch.remoteSha === null || branch.state === 'local') return null
  return branch.taskId
}

/** A merge request of this branch exists at the provider already (GitLab 409, GitHub 422). */
export function isMergeRequestThere(error: unknown): boolean {
  if (!isDomainError(error) || error.code !== 'GIT_PROVIDER_FAILED') return false
  const status = (error.details as { status?: unknown } | undefined)?.status
  return status === 409 || status === 422
}
