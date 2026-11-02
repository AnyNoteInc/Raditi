import { Logger } from '@nestjs/common'
import { extendTaskHolds } from '@repo/billing'
import {
  excludeTurnDbOperations,
  insertFeedEvent,
  nextCandidateRevision,
  recordCandidate,
  requestPreviewSync,
  rewindDialog,
  supersedeStandingCandidate,
  taskHasProductionWrites,
  type Prisma,
  type PrismaClient,
} from '@repo/db'
import {
  AGENT_TURN_QUEUE,
  branchBeforeTurn,
  CANDIDATE_REWIND_EVENT,
  CANDIDATE_REWIND_JOB,
  CANDIDATE_REWIND_PUSH_EVENT,
  candidateFactsSchema,
  candidateRewindDedupeKey,
  DomainError,
  feedEndedSiteOf,
  isDomainError,
  isTooLarge,
  leaseLost,
  taskHoldExpiry,
  terminalTaskStatuses,
  withSite,
  type CandidateRewindJob,
  type JobQueue,
  type RepoRef,
  type SiteLeaseFence,
  type SiteLeaseStore,
  type SiteStack,
  type TaskStatus,
  type TurnResult,
} from '@repo/domain'

import {
  standingCandidateOf,
  type CandidateBuild,
  type CandidateBuilder,
  type StandingCandidate,
} from './candidate-builder.ts'
import type { CandidateGit } from './candidate-git.ts'
import { savedPlanOf, UPDATE_REPAIR_MS } from './turn-planner.ts'

/** `/undo` holds the site this long at most: a build of the candidate and one push. */
const REWIND_LEASE_MS = 10 * 60_000
/** A busy site, or an undo that could not be recorded yet, is asked again after this. */
const RETRY_MS = 30_000
/**
 * A press that moved nothing is given up after this, and the chat takes words again: the site may
 * stay held for days. It outlasts a turn of another chat on the same site.
 */
export const REWIND_GIVE_UP_MS = 30 * 60_000

/** Where a chat stands while its turn is taken back: nothing else starts meanwhile. */
const waiting: readonly TaskStatus[] = ['awaiting_user', 'awaiting_approval']

export interface CandidateRewindDependencies {
  db: PrismaClient
  /** Both null while git is not configured: nothing can be taken back. */
  git: CandidateGit | null
  candidates: CandidateBuilder | null
  leases: SiteLeaseStore
  queue: JobQueue
  logger?: { log(message: string): void; warn(message: string): void; error(message: string): void }
  now?: () => Date
}

export type RewindAnswer =
  /** The branch, the candidate and the preview stand where the turn found them. */
  | 'rewound'
  /** The chat closed meanwhile, or the press was answered already. */
  | 'nothing'
  /** The turn cannot be taken back: nothing moved. */
  | 'refused'
  /** The site is busy: the job is put again. */
  | 'busy'
  /** Something did not answer: the job is put again, or the press was given up. */
  | 'later'
  /** Git is not configured, or this core cannot compare commits. */
  | 'unavailable'

interface RewoundTask {
  id: string
  siteId: string
  status: TaskStatus
  turnNo: number
  billable: boolean
  site: { stack: SiteStack; url: string; installedVersion: string | null }
}

/** What is taken back and where to: read under the lease. */
interface RewindTarget {
  /** The head of the turn: where the branch stands. */
  head: string
  /** Where the branch goes: where the turn found it; null — it found none. */
  branch: string | null
  /** What the turn worked from: the commit the candidate stands on again. */
  content: string
}

/** What is written of the undo: `empty` without a build — the candidate gave way to the record. */
type RewindRecord = CandidateBuild | { kind: 'empty' }

/** The chat stopped waiting before the branch moved: nothing is written. */
const withdrawn = () =>
  new DomainError('CONFLICT', 'The chat no longer waits', 409, { reason: 'withdrawn' })
const isWithdrawn = (error: unknown) =>
  isDomainError(error) &&
  (error.details as { reason?: unknown } | undefined)?.reason === 'withdrawn'

/**
 * `/undo` in a chat with the repository (docs/plan/61-chats-first.md, К29, §5.14): the last turn is
 * taken back without the model, one step. The branch goes to where the turn found it, by CAS and
 * under the site's lease — a first turn found none, and the branch is deleted —, the candidate goes
 * back to what the chat released before the turn, the database writes of the turn leave the plan,
 * and the preview follows. Nothing stands any more: the chat stays open for the next words, it does
 * not end (`finishEmptiedDialog` is not for it). No money moves: the pass was charged when it ended.
 *
 * Everything that can refuse comes before the push: the candidate is built from commits, which need
 * no branch, and what the build writes is an artifact the next revision overwrites. After the push
 * only the record is left, one transaction with the turn undone, the status and the feed row, and a
 * repeat finds the branch moved already. The undone commit leaves the remote with the branch: what
 * a repeat cannot read from git any more stands in the `candidate.rewind.push` row, written first.
 *
 * A press stays pending until a `candidate.rewind` row answers it, and nothing else starts in the
 * chat until then (`turnRewinding`). A job may die before it writes one — `agent-turns` runs a job
 * once —, so the answer rests on `TaskSweep.rewinds`, which puts a press left unanswered again. A
 * press given up says the chat stands as it did, so a branch that moved is never given up: it is
 * recorded, in the end without a candidate (`UPDATE_REPAIR_MS`), and the next pass builds one.
 */
export class CandidateRewind {
  readonly #logger: {
    log(message: string): void
    warn(message: string): void
    error(message: string): void
  }
  readonly #now: () => Date

  constructor(private readonly deps: CandidateRewindDependencies) {
    this.#logger = deps.logger ?? new Logger('CandidateRewind')
    this.#now = deps.now ?? (() => new Date())
  }

  async run(job: CandidateRewindJob): Promise<RewindAnswer> {
    const { git, candidates } = this.deps
    if (!git || !candidates || !git.comparesCommits) return this.#final(job, 'unavailable', true)
    let lease: SiteLeaseFence | null = null
    try {
      if (await this.#answered(this.deps.db, job)) return this.#answer(job, 'nothing')
      const task = await this.deps.db.task.findUnique({
        where: { id: job.taskId },
        select: {
          id: true,
          siteId: true,
          status: true,
          turnNo: true,
          billable: true,
          site: { select: { stack: true, url: true, installedVersion: true } },
        },
      })
      if (!task || !waiting.includes(task.status))
        return await this.#final(
          job,
          'nothing',
          task !== null && !terminalTaskStatuses.includes(task.status),
        )

      const sited = withSite(task)
      lease = await this.deps.leases.acquire({
        siteId: sited.siteId,
        taskId: task.id,
        operation: 'turn',
        ttlMs: REWIND_LEASE_MS,
      })
      if (!lease) return await this.#busy(job)
      return await this.#rewind(job, sited, lease, git, candidates)
    } catch (error) {
      return this.#later(job, error)
    } finally {
      if (lease)
        await this.deps.leases.release(lease).catch(() => {
          this.#logger.warn(`candidate_rewind_release_failed task=${job.taskId}`)
        })
    }
  }

  async #rewind(
    job: CandidateRewindJob,
    task: RewoundTask,
    lease: SiteLeaseFence,
    git: CandidateGit,
    candidates: CandidateBuilder,
  ): Promise<RewindAnswer> {
    // Under the lease: two jobs of a press end up here one after the other.
    if (await this.#answered(this.deps.db, job)) return this.#answer(job, 'nothing')
    const pushed = await this.#pushed(job)
    // After a push nothing may say the chat stands as it did: the job goes on until it is recorded.
    // A branch that stands neither here nor there for that long is no longer this press's to move.
    const refuse = async (moved: boolean) =>
      (pushed === null || !(await this.#young(job, UPDATE_REPAIR_MS))) && !moved
        ? this.#final(job, 'refused', true)
        : this.#later(job, new Error('A press that pushed was refused'))

    const repository = await this.deps.db.gitRepository.findFirst({
      where: { siteId: task.siteId },
      orderBy: { createdAt: 'asc' },
      select: { provider: true, owner: true, name: true },
    })
    const target = await this.#target(task)
    if (!repository || !target) return refuse(false)
    const repo: RepoRef = repository
    const branch = `agent/${task.id}`
    // A repeat finds the branch moved already; anything else is not where the turn left it.
    const head = await git.readBranchHead({ repo, branch })
    const moved = head === target.branch
    if (head !== target.head && !moved) return refuse(false)

    if (!moved && !(await this.#young(job, REWIND_GIVE_UP_MS)))
      return this.#final(job, 'later', true)
    const standing = await standingCandidateOf(this.deps.db, task.id)
    if (moved && !(await this.#young(job, UPDATE_REPAIR_MS))) {
      this.#logger.error(`candidate_rewind_without_candidate task=${job.taskId}`)
      return this.#settle(job, task, standing, { kind: 'empty' }, pushed ?? true)
    }

    const revision = await nextCandidateRevision(this.deps.db, task.id)
    const context = await candidates.context(task, standing, revision)
    if (!context) return refuse(moved)
    const before = await this.#candidateBefore(task, target.content)
    let build: CandidateBuild
    try {
      build = await candidates.build(context, {
        turnNo: before.turnNo,
        headSha: target.content,
        claims: before.claims,
        withoutTurn: task.turnNo,
        // The base skips the look at the standing head: it may be the commit that left the remote.
        ...(moved && standing ? { baseSha: standing.baseSha } : {}),
      })
    } catch (error) {
      if (!isTooLarge(error)) throw error
      this.#logger.error(`candidate_rewind_too_large task=${job.taskId}`)
      return refuse(moved)
    }
    // A turn that changed no file published a commit of the same tree: no word of files (К19).
    const files = pushed ?? (await this.#filesChanged(git, repo, target))

    if (!moved) {
      if (pushed === null) await this.#markPush(job, files)
      try {
        await git.rewindBranch({ repo, branch, from: target.head, to: target.branch }, async () => {
          if (!(await this.deps.leases.assert(lease))) throw leaseLost()
          if (!(await this.#waits(task))) throw withdrawn()
        })
      } catch (error) {
        if (isWithdrawn(error)) return this.#final(job, 'nothing', false)
        if (isDomainError(error) && error.code === 'CONFLICT')
          return this.#final(job, 'refused', true)
        throw error
      }
    }
    return this.#settle(job, task, standing, build, files)
  }

  /** The record of the undo: false from it — the chat stopped waiting, and nothing was written. */
  async #settle(
    job: CandidateRewindJob,
    task: RewoundTask,
    standing: StandingCandidate | null,
    build: RewindRecord,
    files: boolean,
  ): Promise<RewindAnswer> {
    const recorded = await this.#record(job, task, standing, build, files)
    return recorded ? this.#answer(job, 'rewound') : this.#final(job, 'nothing', false)
  }

  async #filesChanged(git: CandidateGit, repo: RepoRef, target: RewindTarget): Promise<boolean> {
    const [turnTree, startTree] = await Promise.all([
      git.treeOf({ repo, sha: target.head }),
      git.treeOf({ repo, sha: target.content }),
    ])
    return turnTree !== startTree
  }

  /**
   * The turn `/undo` takes: the last one, completed and not refused, whose head no «Обновить» moved
   * and which wrote nothing on the site itself. web refused all that at the press; a job finds what
   * changed since. null — it cannot be taken.
   */
  async #target(task: RewoundTask): Promise<RewindTarget | null> {
    const { db } = this.deps
    const turn = await db.taskTurn.findUnique({
      where: { taskId_turnNo: { taskId: task.id, turnNo: task.turnNo } },
      select: { status: true, rejectedAt: true, undoneAt: true, headSha: true },
    })
    if (
      turn?.status !== 'completed' ||
      turn.rejectedAt !== null ||
      turn.undoneAt !== null ||
      turn.headSha === null
    )
      return null
    const latest = await db.taskCandidate.findFirst({
      where: { taskId: task.id },
      orderBy: { revision: 'desc' },
      select: { turnNo: true, headSha: true },
    })
    if (latest?.turnNo === task.turnNo && latest.headSha !== turn.headSha) return null
    if (await taskHasProductionWrites(db, task.id, { turnNo: task.turnNo })) return null
    const assignments = await db.turnAssignment.findMany({
      where: { taskId: task.id, turnNo: task.turnNo },
      select: { plan: true },
    })
    const plan = assignments.length === 1 ? savedPlanOf(assignments[0]!.plan) : null
    if (!plan?.workspace) return null
    return {
      head: turn.headSha,
      branch: branchBeforeTurn(plan),
      content: plan.workspace.expectedBaseSha,
    }
  }

  /**
   * What the candidate of the commit the turn worked from says: the turn that wrote that commit —
   * a candidate under another turn would read as moved by «Обновить» — and the agent's claims of
   * the chat before the undone turn. A head «Обновить» wrote is named by its own revision.
   */
  async #candidateBefore(
    task: RewoundTask,
    content: string,
  ): Promise<{ turnNo: number; claims: Pick<TurnResult, 'change_type' | 'risk'> | null }> {
    const { db } = this.deps
    const [own, earlier] = await Promise.all([
      db.taskTurn.findFirst({
        where: { taskId: task.id, headSha: content, turnNo: { lt: task.turnNo } },
        orderBy: { turnNo: 'desc' },
        select: { turnNo: true },
      }),
      db.taskCandidate.findFirst({
        where: { taskId: task.id, turnNo: { lt: task.turnNo } },
        orderBy: { revision: 'desc' },
        select: { turnNo: true, headSha: true, facts: true },
      }),
    ])
    const facts = candidateFactsSchema.safeParse(earlier?.facts)
    return {
      turnNo: own?.turnNo ?? (earlier?.headSha === content ? earlier.turnNo : task.turnNo - 1),
      claims: facts.success ? { change_type: facts.data.changeType, risk: facts.data.risk } : null,
    }
  }

  /** The undo in one transaction: false — the chat stopped waiting, and nothing is written. */
  async #record(
    job: CandidateRewindJob,
    task: RewoundTask,
    standing: StandingCandidate | null,
    build: RewindRecord,
    files: boolean,
  ): Promise<boolean> {
    const stands = build.kind === 'candidate' ? build.record.revision : (standing?.revision ?? null)
    const emptied = build.kind === 'empty'
    return this.#transaction(async (tx, now) => {
      const turnId = await rewindDialog(tx, {
        taskId: task.id,
        turnNo: task.turnNo,
        to: stands !== null && !emptied ? 'awaiting_approval' : 'awaiting_user',
      })
      if (turnId === null) return false
      await excludeTurnDbOperations(tx, { taskId: task.id, turnNo: task.turnNo })
      if (build.kind === 'candidate') {
        const { record } = build
        await recordCandidate(tx, record)
        await insertFeedEvent(tx, {
          taskId: task.id,
          turnId,
          row: {
            type: 'feed.candidate',
            payload: {
              v: 1,
              // The turn of the words about this revision: never the one taken back.
              turn: record.turnNo,
              revision: record.revision,
              version: record.proposedVersion,
              bump: record.proposedBump,
              files: {
                added: record.facts.addedFiles,
                modified: record.facts.modifiedFiles,
                deleted: record.facts.deletedFiles,
              },
              media: record.facts.mediaFiles,
              records: record.dbPlan.length,
            },
          },
        })
      } else if (emptied && standing) await supersedeStandingCandidate(tx, task.id)
      await requestPreviewSync(tx, {
        taskId: task.id,
        revision: emptied ? 0 : (stands ?? 0),
      })
      if (task.billable)
        await extendTaskHolds(tx, { taskId: task.id, expiresAt: taskHoldExpiry(now, 'waiting') })
      await insertFeedEvent(tx, {
        taskId: task.id,
        turnId,
        row: {
          type: 'feed.rewind',
          payload: {
            v: 1,
            turn: task.turnNo,
            files,
            // The browser belongs to the whole task: what it did stays, whatever this turn did.
            site: feedEndedSiteOf(task, await taskHasProductionWrites(tx, task.id)),
          },
        },
      })
      await this.#event(tx, job, 'rewound')
      return true
    })
  }

  /**
   * The chat still waits at the turn being undone: the check right before the push, read after
   * every writer of the task row before it has committed.
   */
  async #waits(task: RewoundTask): Promise<boolean> {
    return this.#transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM tasks
        WHERE id = ${task.id}::uuid AND status::text = ANY(${[...waiting]}::text[])
          AND turn_no = ${task.turnNo}
        FOR UPDATE`
      return rows.length === 1
    })
  }

  async #transaction<T>(work: (tx: Prisma.TransactionClient, now: Date) => Promise<T>) {
    return this.deps.db.$transaction((tx) => work(tx, this.#now()), {
      isolationLevel: 'ReadCommitted',
      timeout: 30_000,
    })
  }

  /**
   * Something did not answer: the job is put again. A press past `REWIND_GIVE_UP_MS` that never
   * reached the push is answered as failed instead, and the chat takes words again. A failure of
   * the put, or of this very reading, leaves the press to `TaskSweep.rewinds`.
   */
  async #later(job: CandidateRewindJob, error: unknown): Promise<RewindAnswer> {
    const code = isDomainError(error) ? error.code : 'error'
    if (await this.#givenUp(job)) {
      this.#logger.error(`candidate_rewind_unrecorded task=${job.taskId} code=${code}`)
      return this.#final(job, 'later', true)
    }
    this.#logger.warn(`candidate_rewind_later task=${job.taskId} code=${code}`)
    await this.#again(job, 'retry')
    return this.#answer(job, 'later')
  }

  /** The site is held by another: as long as the press may wait, and it never moved anything. */
  async #busy(job: CandidateRewindJob): Promise<RewindAnswer> {
    if (await this.#givenUp(job)) {
      this.#logger.error(`candidate_rewind_site_held task=${job.taskId}`)
      return this.#final(job, 'later', true)
    }
    await this.#again(job, 'busy')
    return this.#answer(job, 'busy')
  }

  /** One id per interval: the jobs of a press, the sweep's among them, come down to one. */
  async #again(job: CandidateRewindJob, why: 'busy' | 'retry'): Promise<void> {
    const interval = Math.floor(this.#now().getTime() / RETRY_MS)
    await this.deps.queue
      .enqueue(AGENT_TURN_QUEUE, CANDIDATE_REWIND_JOB, job, {
        jobId: `${candidateRewindDedupeKey(job)}:${why}:${interval}`,
        delayMs: RETRY_MS,
      })
      .catch(() => this.#logger.warn(`candidate_rewind_requeue_failed task=${job.taskId}`))
  }

  /** Whether the press is younger than `limit`; a database that does not answer says yes. */
  async #young(job: CandidateRewindJob, limit: number): Promise<boolean> {
    try {
      const row = await this.deps.db.taskEvent.findFirst({
        where: { id: BigInt(job.requestEventId), taskId: job.taskId },
        select: { createdAt: true },
      })
      return row !== null && this.#now().getTime() - row.createdAt.getTime() <= limit
    } catch {
      return true
    }
  }

  /** The press may be given up: old, and sure not to have reached the push. */
  async #givenUp(job: CandidateRewindJob): Promise<boolean> {
    if (await this.#young(job, REWIND_GIVE_UP_MS)) return false
    try {
      return (await this.#pushed(job)) === null
    } catch {
      return false
    }
  }

  async #answered(
    db: Pick<Prisma.TransactionClient, 'taskEvent'>,
    job: CandidateRewindJob,
  ): Promise<boolean> {
    const rows = await db.taskEvent.count({
      where: {
        taskId: job.taskId,
        type: CANDIDATE_REWIND_EVENT,
        payload: { path: ['requestEventId'], equals: job.requestEventId },
      },
    })
    return rows > 0
  }

  /** What the job that reached the push said of the files; null — no job reached it. */
  async #pushed(job: CandidateRewindJob): Promise<boolean | null> {
    const row = await this.deps.db.taskEvent.findFirst({
      where: {
        taskId: job.taskId,
        type: CANDIDATE_REWIND_PUSH_EVENT,
        payload: { path: ['requestEventId'], equals: job.requestEventId },
      },
      select: { payload: true },
    })
    return row === null ? null : (row.payload as { files: boolean }).files
  }

  async #markPush(job: CandidateRewindJob, files: boolean): Promise<void> {
    await this.deps.db.taskEvent.create({
      data: {
        taskId: job.taskId,
        type: CANDIDATE_REWIND_PUSH_EVENT,
        payload: { v: 1, requestEventId: job.requestEventId, files },
      },
    })
  }

  /** The answer to the press: an internal row, and it lets the chat go on. */
  async #event(
    db: Pick<Prisma.TransactionClient, 'taskEvent'>,
    job: CandidateRewindJob,
    outcome: RewindAnswer,
  ): Promise<void> {
    await db.taskEvent.create({
      data: {
        taskId: job.taskId,
        type: CANDIDATE_REWIND_EVENT,
        payload: { v: 1, requestEventId: job.requestEventId, outcome },
      },
    })
  }

  /**
   * A final answer that took nothing back: logged and kept as the press's row, with the client's
   * row when `told`, unless the press was answered already. A write that fails leaves the press
   * unanswered for `TaskSweep.rewinds`.
   */
  async #final(
    job: CandidateRewindJob,
    answer: RewindAnswer,
    told: boolean,
  ): Promise<RewindAnswer> {
    try {
      await this.#transaction(async (tx) => {
        if (await this.#answered(tx, job)) return
        await this.#event(tx, job, answer)
        if (told)
          await insertFeedEvent(tx, {
            taskId: job.taskId,
            row: { type: 'feed.update', payload: { v: 1, outcome: 'rewind_failed', conflicts: 0 } },
          })
      })
    } catch {
      this.#logger.warn(`candidate_rewind_event_failed task=${job.taskId}`)
    }
    return this.#answer(job, answer)
  }

  #answer(job: CandidateRewindJob, answer: RewindAnswer): RewindAnswer {
    this.#logger.log(`candidate_rewind task=${job.taskId} answer=${answer}`)
    return answer
  }
}
