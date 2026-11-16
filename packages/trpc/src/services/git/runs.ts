import {
  ciRunOf,
  ciRunsOf,
  enqueueOutbox,
  projectOwnedBy,
  requestCiLog,
  type CiLogAnswer,
  type CiRunRow,
  type PrismaClient,
} from '@repo/db'
import {
  gitJobNames,
  projectNotFound,
  REPO_POLL_ON_LOOK_MS,
  repoRunNotFound,
  type ChecksState,
  type CiStatus,
  type PullRequestState,
  type RepoBranchState,
  type RepoCiJob,
  type CiRefusal,
} from '@repo/domain'

// The builds of a project's repository in the cabinet (docs/plan/84-projects.md, ПР17, §4.4,
// §4.8; slice 84.21): «Сборки (CI/CD)», «Запросы на слияние» and «Ветки агента» of P-repo, a run
// with its stages and jobs of P-pipeline, and the log of a job. Web never reaches the provider:
// what core polled is read from PostgreSQL; a look at the page asks core to poll again at most
// once a minute, a log is asked of core and answered `loading` until it is there.

/** Runs of one page of «Сборки». */
export const RUNS_PAGE = 20

export interface RunChat {
  id: string
  title: string | null
}

export interface RunView {
  id: string
  name: string
  ref: string
  sha: string
  event: string | null
  status: CiStatus
  refusal: CiRefusal | null
  url: string
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  /** The chat whose branch it built, when the branch is one of the agent's. */
  chat: RunChat | null
  /** The stages in the client's own names, in the order of the jobs (ПР3). */
  stages: string[]
}

/** The repository of a project its author reads; NOT_FOUND for anything else. */
async function ownRepository(db: PrismaClient, userId: string, projectId: string) {
  if ((await projectOwnedBy(db, projectId, userId)) === null) throw projectNotFound()
  const repo = await db.projectRepository.findUnique({
    where: { projectId },
    select: {
      id: true,
      defaultBranch: true,
      mirrorState: true,
      ciPolledAt: true,
      connection: { select: { state: true } },
    },
  })
  if (repo === null) throw repoRunNotFound()
  return repo
}

/** The chats whose branches are these refs. */
async function chatsOf(
  db: PrismaClient,
  projectRepositoryId: string,
  refs: readonly string[],
): Promise<Map<string, RunChat>> {
  if (refs.length === 0) return new Map()
  const branches = await db.projectRepoBranch.findMany({
    where: { projectRepositoryId, branch: { in: [...new Set(refs)] } },
    select: { branch: true, task: { select: { id: true, title: true, deletedAt: true } } },
  })
  return new Map(
    branches
      .filter((row) => row.task.deletedAt === null)
      .map((row) => [row.branch, { id: row.task.id, title: row.task.title }]),
  )
}

const stagesOf = (jobs: readonly RepoCiJob[] | null): string[] => {
  const names: string[] = []
  for (const job of [...(jobs ?? [])].reverse())
    if (job.stage !== null && !names.includes(job.stage)) names.push(job.stage)
  return names
}

const viewOf = (run: CiRunRow, chats: Map<string, RunChat>): RunView => ({
  id: run.id,
  name: run.name,
  ref: run.ref,
  sha: run.sha,
  event: run.event,
  status: run.status,
  refusal: run.refusal,
  url: run.url,
  createdAt: run.createdAt,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  chat: chats.get(run.ref) ?? null,
  stages: stagesOf(run.jobs),
})

/**
 * A look at the builds: core polls this repository again when it has not for a minute (`git.poll`
 * with the repository, coalesced by a CAS in core). True — a poll was asked for.
 */
async function askPoll(
  db: PrismaClient,
  repo: {
    id: string
    mirrorState: string
    ciPolledAt: Date | null
    connection: { state: string } | null
  },
  now: Date,
): Promise<boolean> {
  if (repo.mirrorState !== 'ready') return false
  if (repo.connection !== null && repo.connection.state !== 'ok') return false
  if (repo.ciPolledAt !== null && now.getTime() - repo.ciPolledAt.getTime() < REPO_POLL_ON_LOOK_MS)
    return false
  await enqueueOutbox(db, {
    topic: 'git',
    type: gitJobNames.poll,
    payload: { projectRepositoryId: repo.id },
    dedupeKey: `git.poll:${repo.id}:${Math.floor(now.getTime() / REPO_POLL_ON_LOOK_MS)}`,
  })
  return true
}

/** `projectRepo.runs`: a page of the newest runs; `before` — the `createdAt` of the last shown. */
export async function readRuns(
  db: PrismaClient,
  input: { userId: string; projectId: string; before?: Date; limit?: number; now: Date },
): Promise<{
  items: RunView[]
  next: Date | null
  polledAt: Date | null
  refreshing: boolean
}> {
  const repo = await ownRepository(db, input.userId, input.projectId)
  const refreshing = input.before === undefined && (await askPoll(db, repo, input.now))
  const limit = Math.min(input.limit ?? RUNS_PAGE, RUNS_PAGE)
  const runs = await ciRunsOf(db, {
    projectRepositoryId: repo.id,
    limit: limit + 1,
    ...(input.before === undefined ? {} : { before: input.before }),
  })
  const page = runs.slice(0, limit)
  const chats = await chatsOf(
    db,
    repo.id,
    page.map((run) => run.ref),
  )
  return {
    items: page.map((run) => viewOf(run, chats)),
    next: runs.length > limit ? (page.at(-1)?.createdAt ?? null) : null,
    polledAt: repo.ciPolledAt,
    refreshing,
  }
}

/** `projectRepo.run`: one run with its jobs (P-pipeline). */
export async function readRun(
  db: PrismaClient,
  input: { userId: string; projectId: string; runId: string; now: Date },
): Promise<{ run: RunView; jobs: RepoCiJob[] }> {
  const repo = await ownRepository(db, input.userId, input.projectId)
  const run = await ciRunOf(db, { projectRepositoryId: repo.id, runId: input.runId })
  if (run === null) throw repoRunNotFound()
  if (run.status === 'pending' || run.status === 'running') await askPoll(db, repo, input.now)
  const chats = await chatsOf(db, repo.id, [run.ref])
  return { run: viewOf(run, chats), jobs: run.jobs ?? [] }
}

/** `projectRepo.jobLog`: the masked tail core keeps, or `loading` while core fetches it. */
export async function readJobLog(
  db: PrismaClient,
  input: { userId: string; projectId: string; runId: string; jobId: string; now: Date },
): Promise<CiLogAnswer> {
  const repo = await ownRepository(db, input.userId, input.projectId)
  return requestCiLog(db, {
    projectRepositoryId: repo.id,
    runId: input.runId,
    jobId: input.jobId,
    now: input.now,
  })
}

export interface RepoWorkView {
  mergeRequests: {
    number: number
    title: string
    state: PullRequestState
    checks: ChecksState
    sourceBranch: string
    url: string
    chat: RunChat | null
  }[]
  branches: {
    branch: string
    state: RepoBranchState
    pushed: boolean
    chat: RunChat
    updatedAt: Date
  }[]
}

/** «Запросы на слияние» and «Ветки агента» of P-repo. */
export async function readRepoWork(
  db: PrismaClient,
  input: { userId: string; projectId: string },
): Promise<RepoWorkView> {
  const repo = await ownRepository(db, input.userId, input.projectId)
  const [requests, branches] = await Promise.all([
    db.projectMergeRequest.findMany({
      where: { projectRepositoryId: repo.id },
      orderBy: { number: 'desc' },
      take: 50,
      select: {
        number: true,
        title: true,
        state: true,
        checks: true,
        sourceBranch: true,
        webUrl: true,
        task: { select: { id: true, title: true, deletedAt: true } },
      },
    }),
    db.projectRepoBranch.findMany({
      where: { projectRepositoryId: repo.id, task: { deletedAt: null } },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: {
        branch: true,
        state: true,
        remoteSha: true,
        updatedAt: true,
        task: { select: { id: true, title: true } },
      },
    }),
  ])
  return {
    mergeRequests: requests.map((row) => ({
      number: row.number,
      title: row.title,
      state: row.state as PullRequestState,
      checks: row.checks as ChecksState,
      sourceBranch: row.sourceBranch,
      url: row.webUrl,
      chat:
        row.task && row.task.deletedAt === null ? { id: row.task.id, title: row.task.title } : null,
    })),
    branches: branches.map((row) => ({
      branch: row.branch,
      state: row.state as RepoBranchState,
      pushed: row.remoteSha !== null,
      chat: { id: row.task.id, title: row.task.title },
      updatedAt: row.updatedAt,
    })),
  }
}

/** The newest run of a chat's branch, for its card in the chat (P-chat): polled, never pushed. */
export async function lastRunOf(
  db: PrismaClient,
  input: { projectRepositoryId: string; branch: string; sha: string | null },
): Promise<{ id: string; status: CiStatus; refusal: CiRefusal | null; url: string } | null> {
  const runs = await ciRunsOf(db, {
    projectRepositoryId: input.projectRepositoryId,
    ref: input.branch,
    limit: 5,
  })
  const run = runs.find((item) => input.sha === null || item.sha === input.sha) ?? null
  return run ? { id: run.id, status: run.status, refusal: run.refusal, url: run.url } : null
}
