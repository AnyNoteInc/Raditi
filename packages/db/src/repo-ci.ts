import {
  ciStatusIsActive,
  gitJobNames,
  readRepoCiJobs,
  REPO_CI_LOG_TTL_MS,
  REPO_LOG_REFRESH_MS,
  REPO_LOG_RETRY_MS,
  repoRunNotFound,
  type CiRefusal,
  type CiStatus,
  type RepoCiJob,
} from '@repo/domain'

import type { Prisma, PrismaClient } from './generated/prisma/client.ts'
import { enqueueOutbox } from './outbox.ts'

// The builds of a project repository as core keeps them (docs/plan/84-projects.md, ПР17, §4.1,
// §4.4; slice 84.21): the rows `git.poll` wrote and the tail of a log `git.log` fetched. Web
// (`projectRepo.runs/run/jobLog`) and `mcp` (`repo_runs`, `repo_job_log`) read them here: neither
// holds a token of git, so a log they want is asked of core by an event of the outbox.

type Db = Pick<PrismaClient, 'projectCiRun' | 'projectCiLog' | 'outboxEvent'>

export interface CiRunRow {
  id: string
  ref: string
  sha: string
  name: string
  event: string | null
  status: CiStatus
  refusal: CiRefusal | null
  url: string
  jobs: RepoCiJob[] | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  syncedAt: Date
}

const runSelect = {
  providerRunId: true,
  ref: true,
  sha: true,
  name: true,
  event: true,
  status: true,
  refusal: true,
  webUrl: true,
  jobs: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  syncedAt: true,
} as const

type RunRecord = Prisma.ProjectCiRunGetPayload<{ select: typeof runSelect }>

const rowOf = (run: RunRecord): CiRunRow => ({
  id: run.providerRunId,
  ref: run.ref,
  sha: run.sha,
  name: run.name,
  event: run.event,
  status: run.status as CiStatus,
  refusal: (run.refusal as CiRefusal | null) ?? null,
  url: run.webUrl,
  jobs: run.jobs === null ? null : readRepoCiJobs(run.jobs),
  createdAt: run.createdAt,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  syncedAt: run.syncedAt,
})

/** The newest runs of a repository, of one ref when it is named; `before` — the next page. */
export async function ciRunsOf(
  db: Pick<PrismaClient, 'projectCiRun'>,
  input: { projectRepositoryId: string; ref?: string; limit: number; before?: Date },
): Promise<CiRunRow[]> {
  const runs = await db.projectCiRun.findMany({
    where: {
      projectRepositoryId: input.projectRepositoryId,
      ...(input.ref === undefined ? {} : { ref: input.ref }),
      ...(input.before === undefined ? {} : { createdAt: { lt: input.before } }),
    },
    orderBy: [{ createdAt: 'desc' }, { providerRunId: 'desc' }],
    take: input.limit,
    select: runSelect,
  })
  return runs.map(rowOf)
}

export async function ciRunOf(
  db: Pick<PrismaClient, 'projectCiRun'>,
  input: { projectRepositoryId: string; runId: string },
): Promise<CiRunRow | null> {
  const run = await db.projectCiRun.findUnique({
    where: {
      projectRepositoryId_providerRunId: {
        projectRepositoryId: input.projectRepositoryId,
        providerRunId: input.runId,
      },
    },
    select: runSelect,
  })
  return run === null ? null : rowOf(run)
}

export type CiLogAnswer =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; text: string; truncated: boolean; fetchedAt: Date }

/**
 * The tail of the log of a job of a run this repository keeps (ПР17): kept and fresh — as it is;
 * not kept, expired, failed or loading for too long — a row `loading` and the job `git.log` for
 * core, then `{ state: 'loading' }`: the caller asks again. A log of a job that still runs is
 * fetched again when older than REPO_LOG_REFRESH_MS, the kept one answered meanwhile. A run or a
 * job the repository does not keep is REPO_RUN_NOT_FOUND: no id of the caller reaches core else.
 */
export async function requestCiLog(
  db: Db,
  input: {
    projectRepositoryId: string
    runId: string
    jobId: string
    now: Date
    /** Only a run of these refs (the agent's: its chat's branch); absent — any (the cabinet). */
    refs?: readonly string[]
  },
): Promise<CiLogAnswer> {
  const { projectRepositoryId, jobId, now } = input
  const found = await ciRunOf(db, input)
  const run = found && (!input.refs || input.refs.includes(found.ref)) ? found : null
  const job = run?.jobs?.find((item) => item.id === jobId) ?? null
  if (job === null) throw repoRunNotFound()
  const key = { projectRepositoryId_providerJobId: { projectRepositoryId, providerJobId: jobId } }
  const row = await db.projectCiLog.findUnique({
    where: key,
    select: {
      state: true,
      text: true,
      truncated: true,
      requestedAt: true,
      fetchedAt: true,
      expiresAt: true,
    },
  })
  const ask = async () => {
    await enqueueOutbox(db, {
      topic: 'git',
      type: gitJobNames.log,
      payload: { projectRepositoryId, jobId },
      dedupeKey: `git.log:${projectRepositoryId}:${jobId}:${Math.floor(now.getTime() / REPO_LOG_RETRY_MS)}`,
    })
  }
  const stale = (at: Date | null, ms: number) => at === null || now.getTime() - at.getTime() >= ms
  if (row !== null && row.expiresAt > now) {
    if (row.state === 'ready' && row.text !== null && row.fetchedAt !== null) {
      if (ciStatusIsActive(job.status) && stale(row.fetchedAt, REPO_LOG_REFRESH_MS)) {
        const asked = await db.projectCiLog.updateMany({
          where: { ...key.projectRepositoryId_providerJobId, requestedAt: row.requestedAt },
          data: { requestedAt: now },
        })
        if (asked.count === 1) await ask()
      }
      return { state: 'ready', text: row.text, truncated: row.truncated, fetchedAt: row.fetchedAt }
    }
    if (!stale(row.requestedAt, REPO_LOG_RETRY_MS))
      return row.state === 'failed' ? { state: 'failed' } : { state: 'loading' }
  }
  await db.projectCiLog.upsert({
    where: key,
    create: {
      projectRepositoryId,
      providerJobId: jobId,
      state: 'loading',
      requestedAt: now,
      expiresAt: new Date(now.getTime() + REPO_CI_LOG_TTL_MS),
    },
    update: {
      state: 'loading',
      text: null,
      truncated: false,
      fetchedAt: null,
      requestedAt: now,
      expiresAt: new Date(now.getTime() + REPO_CI_LOG_TTL_MS),
    },
  })
  await ask()
  return { state: 'loading' }
}
