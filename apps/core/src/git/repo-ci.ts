import type { PrismaClient } from '@repo/db'
import {
  ciStatusIsActive,
  gitConnectionProviders,
  isDomainError,
  maskCiLog,
  REPO_CI_JOBS_KEPT,
  REPO_CI_LOG_BYTES,
  REPO_CI_RUNS_KEPT,
  REPO_POLL_EVERY_MS,
  REPO_POLL_REQUESTS_MS,
  type CiJob,
  type CiRun,
  type GitAuth,
  type GitConnectionKind,
  type GitGrant,
  type GitProvider,
  type RepoCiJob,
  type RepoProviderKind,
  type RepoRef,
  type SecretStore,
} from '@repo/domain'

import { readWorkspaceEnvValuesToRefuse } from '../workspace-env/workspace-env-values.ts'
import type { GitAuthSource } from './git-auth-source.ts'
import type { GitProviderFactory } from './git-jobs.ts'
import type { ResolvePublicHost } from './public-host.ts'
import { endWaitingMerges } from './repo-actions.ts'

// The builds of the repositories of projects (docs/plan/84-projects.md, ПР15, ПР17, §4.3; slice
// 84.21). In the first version core learns of them by polling — webhooks are Э10:
// - `git.poll` without a repository is the tick of a job scheduler every REPO_POLL_EVERY_MS: the
//   repositories that have a run still going, a branch sent lately or an open merge request not
//   read for REPO_POLL_REQUESTS_MS, each claimed by a CAS of `ci_polled_at` so that two processes
//   never read one repository in the same tick; `git.poll` with a repository is the look of its
//   page (`projectRepo.runs`), coalesced the same way;
// - a poll reads the newest runs in one request and the jobs only of runs that are new, changed or
//   still going, then the open merge requests: a merged one marks the chat's branch `merged`
//   (ПР25), a closed one `closed`; a press «Принять, когда сборка пройдёт» that waits for it ends;
// - `git.log` fetches the tail of a job's log, takes out ANSI, masks the values of the
//   workspace's variables, the access of the operation and the forms of keys, and keeps it 24 h;
// - `git.repo.deploy_actions` keeps the manual jobs of the head of the default branch (ПР15).
// Nothing here writes to the client's repository.

/** Repositories one tick polls at most. */
export const REPO_POLL_PER_TICK = 20
/** Runs whose jobs one poll reads at most. */
const JOBS_PER_POLL = 10
/** Merge requests one poll reads at most. */
const REQUESTS_PER_POLL = 20
/** A branch sent this recently may have a run the provider has not listed yet: it is polled. */
const RECENT_PUSH_MS = 15 * 60_000
/** Two polls of one repository are at least this far apart, whoever asks. */
const POLL_GAP_MS = REPO_POLL_EVERY_MS - 5_000
/** What core reads of a log: its kept tail and room for the escapes it takes out. */
const LOG_READ_BYTES = REPO_CI_LOG_BYTES + 16 * 1024

export interface RepoCiOptions {
  prisma: PrismaClient
  auth: Pick<GitAuthSource, 'grantFor'>
  resolvePublic: ResolvePublicHost
  provider: GitProviderFactory
  /** The values of the workspace's variables, to mask in logs. */
  secrets: Pick<SecretStore, 'kvRead'>
  logger: { log(line: string): void; warn(line: string): void }
  now?: () => Date
}

const repoSelect = {
  id: true,
  workspaceId: true,
  provider: true,
  host: true,
  path: true,
  providerRepoId: true,
  defaultBranch: true,
  mirrorState: true,
  connection: { select: { id: true, workspaceId: true, kind: true, host: true, state: true } },
} as const

interface RepoRow {
  id: string
  workspaceId: string
  provider: string
  host: string
  path: string
  providerRepoId: string | null
  defaultBranch: string
  mirrorState: string
  connection: {
    id: string
    workspaceId: string
    kind: string
    host: string
    state: string
  } | null
}

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null)

const jobRowOf = (job: CiJob): RepoCiJob => ({
  id: job.id,
  name: job.name.slice(0, 255),
  stage: job.stage === null ? null : job.stage.slice(0, 255),
  status: job.status,
  manual: job.status === 'manual',
  refusal: job.refusal ?? null,
  url: job.url.slice(0, 500),
  startedAt: iso(job.startedAt),
  finishedAt: iso(job.finishedAt),
})

/** A run is refused when it says so, or when one of its jobs does (gitlab.com, ПР17). */
const refusalOf = (run: CiRun, jobs: readonly RepoCiJob[] | null) =>
  run.refusal ?? jobs?.find((job) => job.refusal !== null)?.refusal ?? null

export class RepoCi {
  readonly #o: RepoCiOptions
  readonly #now: () => Date

  constructor(options: RepoCiOptions) {
    this.#o = options
    this.#now = options.now ?? (() => new Date())
  }

  /** The tick of `git.poll`: kept logs past their day go, then the repositories that are due. */
  async tick(): Promise<{ polled: number }> {
    await this.purgeLogs()
    const now = this.#now()
    const gap = new Date(now.getTime() - POLL_GAP_MS)
    const due = await this.#o.prisma.projectRepository.findMany({
      where: {
        mirrorState: 'ready',
        OR: [{ ciPolledAt: null }, { ciPolledAt: { lte: gap } }],
        AND: [
          { OR: [{ connectionId: null }, { connection: { state: 'ok' } }] },
          {
            OR: [
              { ciRuns: { some: { status: { in: ['pending', 'running'] } } } },
              {
                branches: {
                  some: {
                    remoteSha: { not: null },
                    updatedAt: { gte: new Date(now.getTime() - RECENT_PUSH_MS) },
                  },
                },
              },
              {
                mergeRequests: {
                  some: {
                    state: { in: ['open', 'draft'] },
                    syncedAt: { lte: new Date(now.getTime() - REPO_POLL_REQUESTS_MS) },
                  },
                },
              },
            ],
          },
        ],
      },
      orderBy: { ciPolledAt: { sort: 'asc', nulls: 'first' } },
      take: REPO_POLL_PER_TICK,
      select: { id: true },
    })
    let polled = 0
    for (const repo of due) if (await this.poll(repo.id)) polled++
    return { polled }
  }

  /**
   * One repository: its newest runs and the jobs of those that changed, its open merge requests.
   * False — another process polled it within the gap, or it cannot be read now.
   */
  async poll(projectRepositoryId: string): Promise<boolean> {
    const { prisma } = this.#o
    const now = this.#now()
    const claimed = await prisma.projectRepository.updateMany({
      where: {
        id: projectRepositoryId,
        mirrorState: 'ready',
        OR: [{ ciPolledAt: null }, { ciPolledAt: { lte: new Date(now.getTime() - POLL_GAP_MS) } }],
      },
      data: { ciPolledAt: now },
    })
    if (claimed.count === 0) return false
    const repo = (await prisma.projectRepository.findUnique({
      where: { id: projectRepositoryId },
      select: repoSelect,
    })) as RepoRow | null
    if (repo === null) return false
    try {
      const op = await this.#operation(repo)
      if (op === null) return false
      const defaultChanged = await this.#pollRuns(repo, op)
      await this.#pollRequests(repo, op, now)
      if (defaultChanged) await this.#deployActions(repo, op)
      return true
    } catch (error) {
      const code = isDomainError(error) ? error.code : 'unknown'
      this.#o.logger.warn(`git.poll ${projectRepositoryId}: ${code}`)
      return false
    }
  }

  async #operation(
    repo: RepoRow,
  ): Promise<{ provider: GitProvider; auth: GitAuth; ref: RepoRef; grant: GitGrant } | null> {
    let grant: GitGrant = { kind: 'anonymous' }
    let kind = repo.provider as RepoProviderKind
    if (repo.connection !== null) {
      if (repo.connection.state !== 'ok') return null
      const connectionKind = repo.connection.kind as GitConnectionKind
      kind = gitConnectionProviders[connectionKind]
      grant = await this.#o.auth.grantFor({ ...repo.connection, kind: connectionKind })
    }
    const address = await this.#o.resolvePublic(repo.host)
    const provider = this.#o.provider({ kind, host: repo.host, address })
    const auth: GitAuth =
      grant.kind === 'token' ? { kind: 'bearer', token: grant.token } : { kind: 'anonymous' }
    const ref: RepoRef = {
      provider: kind,
      host: repo.host,
      path: repo.path,
      ...(repo.providerRepoId === null ? {} : { providerRepoId: repo.providerRepoId }),
    }
    return { provider, auth, ref, grant }
  }

  /** The newest runs; true when the newest run of the default branch is new or changed. */
  async #pollRuns(
    repo: RepoRow,
    op: { provider: GitProvider; auth: GitAuth; ref: RepoRef },
  ): Promise<boolean> {
    const { prisma } = this.#o
    const now = this.#now()
    const runs = await op.provider.listRuns(op.auth, op.ref, {})
    const known = new Map(
      (
        await prisma.projectCiRun.findMany({
          where: { projectRepositoryId: repo.id, providerRunId: { in: runs.map((r) => r.id) } },
          select: { providerRunId: true, status: true, jobs: true },
        })
      ).map((row) => [row.providerRunId, row]),
    )
    let jobsRead = 0
    let defaultChanged = false
    const newestDefault = runs.find((run) => run.ref === repo.defaultBranch)?.id ?? null
    for (const run of runs) {
      const before = known.get(run.id)
      const changed = before === undefined || before.status !== run.status
      if (run.id === newestDefault && changed) defaultChanged = true
      const wantJobs = changed || ciStatusIsActive(run.status) || before?.jobs == null
      let jobs: RepoCiJob[] | null = null
      if (wantJobs && jobsRead < JOBS_PER_POLL) {
        jobsRead++
        jobs = (await op.provider.listJobs(op.auth, op.ref, run.id))
          .slice(0, REPO_CI_JOBS_KEPT)
          .map(jobRowOf)
      }
      if (!/^[0-9a-f]{40}$/.test(run.sha)) continue
      const fields = {
        ref: run.ref.slice(0, 255),
        sha: run.sha,
        name: run.name.slice(0, 200),
        event: run.event ? run.event.slice(0, 40) : null,
        status: run.status,
        refusal: refusalOf(run, jobs),
        webUrl: run.url.slice(0, 500),
        startedAt: run.startedAt ?? null,
        finishedAt: run.finishedAt,
        syncedAt: now,
        ...(jobs === null ? {} : { jobs }),
      }
      await prisma.projectCiRun.upsert({
        where: {
          projectRepositoryId_providerRunId: {
            projectRepositoryId: repo.id,
            providerRunId: run.id,
          },
        },
        create: {
          projectRepositoryId: repo.id,
          providerRunId: run.id,
          createdAt: run.createdAt ?? now,
          ...fields,
        },
        update: fields,
      })
    }
    // Only the newest REPO_CI_RUNS_KEPT stay.
    const kept = await prisma.projectCiRun.findMany({
      where: { projectRepositoryId: repo.id },
      orderBy: [{ createdAt: 'desc' }, { providerRunId: 'desc' }],
      skip: REPO_CI_RUNS_KEPT,
      select: { providerRunId: true },
    })
    if (kept.length > 0)
      await prisma.projectCiRun.deleteMany({
        where: {
          projectRepositoryId: repo.id,
          providerRunId: { in: kept.map((r) => r.providerRunId) },
        },
      })
    return defaultChanged
  }

  /**
   * The open merge requests not read for REPO_POLL_REQUESTS_MS, and those whose branch has a run
   * going: their state, checks and head. A merged one marks the chat's branch `merged` — the card
   * then says «Изменения уже приняты в основную ветку» (ПР25); a closed one `closed`.
   */
  async #pollRequests(
    repo: RepoRow,
    op: { provider: GitProvider; auth: GitAuth; ref: RepoRef },
    now: Date,
  ): Promise<void> {
    const { prisma } = this.#o
    const active = await prisma.projectCiRun.findMany({
      where: {
        projectRepositoryId: repo.id,
        OR: [
          { status: { in: ['pending', 'running'] } },
          { finishedAt: { gte: new Date(now.getTime() - 2 * REPO_POLL_EVERY_MS) } },
        ],
      },
      select: { ref: true },
    })
    const requests = await prisma.projectMergeRequest.findMany({
      where: {
        projectRepositoryId: repo.id,
        state: { in: ['open', 'draft'] },
        OR: [
          { syncedAt: { lte: new Date(now.getTime() - REPO_POLL_REQUESTS_MS) } },
          { sourceBranch: { in: [...new Set(active.map((run) => run.ref))] } },
        ],
      },
      orderBy: { syncedAt: 'asc' },
      take: REQUESTS_PER_POLL,
      select: { id: true, number: true, taskId: true, sourceBranch: true },
    })
    for (const request of requests) {
      const pr = await op.provider.getPullRequest(op.auth, op.ref, request.number)
      if (pr === null) {
        await prisma.projectMergeRequest.updateMany({
          where: { id: request.id },
          data: { state: 'closed', syncedAt: now },
        })
        await endWaitingMerges(prisma, {
          projectRepositoryId: repo.id,
          number: request.number,
          merged: false,
          now,
        })
        continue
      }
      await prisma.$transaction(async (tx) => {
        await tx.projectMergeRequest.updateMany({
          where: { id: request.id },
          data: {
            state: pr.state,
            checks: pr.checks,
            autoMerge: pr.autoMerge,
            title: pr.title.slice(0, 255),
            ...(/^[0-9a-f]{40}$/.test(pr.headSha) ? { headSha: pr.headSha } : {}),
            mergeSha: pr.mergeSha,
            syncedAt: now,
          },
        })
        if (pr.state !== 'merged' && pr.state !== 'closed') return
        await tx.projectRepoBranch.updateMany({
          where: {
            projectRepositoryId: repo.id,
            branch: request.sourceBranch,
            state: pr.state === 'merged' ? { in: ['pushed', 'closed'] } : 'pushed',
            ...(request.taskId === null ? {} : { taskId: request.taskId }),
          },
          data: { state: pr.state },
        })
      })
      // «Принять, когда сборка пройдёт» (ПР15; slice 84.22): the press waits until the provider
      // merged the request — or ends when the wait was taken off or the request closed.
      if (pr.state === 'merged' || pr.state === 'closed' || !pr.autoMerge)
        await endWaitingMerges(prisma, {
          projectRepositoryId: repo.id,
          number: request.number,
          merged: pr.state === 'merged',
          now,
        })
    }
  }

  /** `git.repo.deploy_actions` (ПР15, ПР17). */
  async syncDeployActions(projectRepositoryId: string): Promise<void> {
    const repo = (await this.#o.prisma.projectRepository.findUnique({
      where: { id: projectRepositoryId },
      select: repoSelect,
    })) as RepoRow | null
    if (repo === null || repo.mirrorState !== 'ready') return
    const op = await this.#operation(repo)
    if (op === null) return
    await this.#deployActions(repo, op)
  }

  async #deployActions(
    repo: RepoRow,
    op: { provider: GitProvider; auth: GitAuth; ref: RepoRef },
  ): Promise<void> {
    const { support } = op.provider
    if (!support.manualJobs && !support.workflowDispatch) return
    // A deploy starts a job of the client: only by its own connection, never by a link.
    if (repo.connection === null) return
    const now = this.#now()
    const actions = (await op.provider.listDeployActions(op.auth, op.ref, repo.defaultBranch))
      .filter((action) => /^[0-9a-f]{40}$/.test(action.sha))
      .slice(0, 50)
    await this.#o.prisma.$transaction(async (tx) => {
      await tx.projectDeployAction.deleteMany({ where: { projectRepositoryId: repo.id } })
      if (actions.length === 0) return
      await tx.projectDeployAction.createMany({
        data: actions.map((action) => ({
          projectRepositoryId: repo.id,
          ref: action.ref.slice(0, 255),
          sha: action.sha,
          kind: action.kind,
          providerActionId: action.id.slice(0, 200),
          name: action.name.slice(0, 200),
          syncedAt: now,
        })),
        skipDuplicates: true,
      })
    })
  }

  /**
   * `git.log` (ПР17): the tail of a job's log, masked, kept until its row expires. A row that is
   * not `loading` any more (fetched by another delivery, gone) is left alone.
   */
  async fetchLog(projectRepositoryId: string, jobId: string): Promise<void> {
    const { prisma } = this.#o
    const key = { projectRepositoryId_providerJobId: { projectRepositoryId, providerJobId: jobId } }
    const row = await prisma.projectCiLog.findUnique({
      where: key,
      select: { state: true, requestedAt: true },
    })
    if (row === null) return
    const repo = (await prisma.projectRepository.findUnique({
      where: { id: projectRepositoryId },
      select: repoSelect,
    })) as RepoRow | null
    const mark = (data: { state: 'ready' | 'failed'; text: string | null; truncated: boolean }) =>
      prisma.projectCiLog.updateMany({
        where: { ...key.projectRepositoryId_providerJobId, requestedAt: row.requestedAt },
        data: { ...data, fetchedAt: this.#now() },
      })
    try {
      if (repo === null) throw new Error('no repository')
      const op = await this.#operation(repo)
      if (op === null) throw new Error('the connection is not ok')
      const raw = await op.provider.getJobLog(op.auth, op.ref, jobId, { tailBytes: LOG_READ_BYTES })
      const values = await this.#maskValues(repo, op.grant)
      const masked = maskCiLog(raw.text, values)
      await mark({
        state: 'ready',
        text: masked.text,
        truncated: raw.truncated || masked.truncated,
      })
    } catch (error) {
      const code = isDomainError(error) ? error.code : 'unknown'
      this.#o.logger.warn(`git.log ${projectRepositoryId}: ${code}`)
      await mark({ state: 'failed', text: null, truncated: false })
    }
  }

  /** What a kept log never holds: the values of the workspace's variables and the access used. */
  async #maskValues(repo: RepoRow, grant: GitGrant): Promise<string[]> {
    const names = await this.#o.prisma.workspaceEnvVar.findMany({
      where: { workspaceId: repo.workspaceId },
      select: { name: true },
    })
    const values = await readWorkspaceEnvValuesToRefuse(
      this.#o.secrets,
      repo.workspaceId,
      names.map((row) => row.name),
    )
    if (grant.kind === 'token') values.push(grant.token)
    return values
  }

  /** Kept logs past their day. */
  async purgeLogs(): Promise<number> {
    const { count } = await this.#o.prisma.projectCiLog.deleteMany({
      where: { expiresAt: { lte: this.#now() } },
    })
    return count
  }
}
