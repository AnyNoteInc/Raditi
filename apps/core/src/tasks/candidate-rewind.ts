import { Logger } from '@nestjs/common'
import { extendTaskHolds } from '@repo/billing'
import {
  excludeTurnDbOperations,
  includeTurnDbOperations,
  insertFeedEvent,
  nextCandidateRevision,
  recordCandidate,
  redoDialog,
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
  readFeedRow,
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

/** `/undo` and `/redo` hold the site this long at most: a build of the candidate and one push. */
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
  /** `/redo`: they stand where the turn left them, and the chat waits as it did before `/undo`. */
  | 'redone'
  /** The chat closed meanwhile, or the press was answered already. */
  | 'nothing'
  /** The turn cannot be taken back, or brought back: nothing moved. */
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

/** What is taken back, or brought back, and where to: read under the lease. */
interface RewindTarget {
  /** The head of the turn: where the branch stands before `/undo` and after `/redo`. */
  head: string
  /** Where the turn found the branch; null — it found none. */
  branch: string | null
  /** What the turn worked from: the commit the candidate stands on again. */
  content: string
}

/** What is written of the press: `empty` without a build — the candidate gave way to the record. */
type RewindRecord = CandidateBuild | { kind: 'empty' }

/** Which way a press moves the chat: `/undo`, or `/redo` with what stood before that `/undo`. */
type RewindWay = { redo: false } | { redo: true; before: TaskStatus | null }

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
 *
 * `/redo` goes the same way with the same rules, forward: the row of the press says which it is.
 * The undone commit left the remote's branch, so `/undo` holds it under a ref of its own before the
 * push (`holdUndoneCommit`): the mirror that also has it lives and dies with its container. What the
 * chat waited with before `/undo` stands in the row that answered that press, and with it the chat
 * is as it was: an answer, or a question still open. Only a candidate that does not come back makes
 * it otherwise: the chat that waited with one is open then, and `feed.redo` says so (`open`).
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
      const redo = await this.#isRedo(job)
      lease = await this.deps.leases.acquire({
        siteId: sited.siteId,
        taskId: task.id,
        operation: 'turn',
        ttlMs: REWIND_LEASE_MS,
      })
      if (!lease) return await this.#busy(job)
      return await (redo
        ? this.#redo(job, sited, lease, git, candidates)
        : this.#rewind(job, sited, lease, git, candidates))
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
    const refuse = (moved: boolean) => this.#refused(job, pushed, moved)

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
      return this.#settle(job, task, standing, { kind: 'empty' }, pushed ?? true, { redo: false })
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
      // Before the row of the push: a job that cannot hold the commit may still give the press up.
      const fence = this.#fence(task, lease)
      await git.holdUndoneCommit({ repo, branch, sha: target.head }, fence)
      if (pushed === null) await this.#markPush(job, files)
      const stopped = await this.#moveBranch(job, git, { repo, branch, target, to: 'back' }, fence)
      if (stopped) return stopped
    }
    return this.#settle(job, task, standing, build, files, { redo: false })
  }

  /**
   * `/redo` of a turn: as `#rewind`, forward. The turn is back at its head, its database writes in
   * the plan and its claims on the revision, which `/undo` set aside. `files` — what the row of that
   * `/undo` said, from trees read before its push.
   */
  async #redo(
    job: CandidateRewindJob,
    task: RewoundTask,
    lease: SiteLeaseFence,
    git: CandidateGit,
    candidates: CandidateBuilder,
  ): Promise<RewindAnswer> {
    if (await this.#answered(this.deps.db, job)) return this.#answer(job, 'nothing')
    const pushed = await this.#pushed(job)
    const refuse = (moved: boolean) => this.#refused(job, pushed, moved)

    const repository = await this.deps.db.gitRepository.findFirst({
      where: { siteId: task.siteId },
      orderBy: { createdAt: 'asc' },
      select: { provider: true, owner: true, name: true },
    })
    const target = await this.#undoneTarget(task)
    if (!repository || !target) return refuse(false)
    const repo: RepoRef = repository
    const branch = `agent/${task.id}`
    const head = await git.readBranchHead({ repo, branch })
    const moved = head === target.head
    if (head !== target.branch && !moved) return refuse(false)
    if (!moved && !(await this.#young(job, REWIND_GIVE_UP_MS)))
      return this.#final(job, 'later', true)

    const way = { redo: true, before: await this.#beforeUndo(task) } as const
    const standing = await standingCandidateOf(this.deps.db, task.id)
    if (moved && !(await this.#young(job, UPDATE_REPAIR_MS))) {
      this.#logger.error(`candidate_rewind_without_candidate task=${job.taskId}`)
      return this.#settle(job, task, standing, { kind: 'empty' }, await this.#undoFiles(task), way)
    }

    const revision = await nextCandidateRevision(this.deps.db, task.id)
    const context = await candidates.context(task, standing, revision)
    if (!context) return refuse(moved)
    let build: CandidateBuild
    try {
      build = await candidates.build(context, {
        turnNo: task.turnNo,
        headSha: target.head,
        claims: await this.#claimsOfTurn(task, target.head),
        withTurn: task.turnNo,
      })
    } catch (error) {
      if (!isTooLarge(error)) throw error
      this.#logger.error(`candidate_rewind_too_large task=${job.taskId}`)
      return refuse(moved)
    }
    const files = pushed ?? (await this.#undoFiles(task))

    if (!moved) {
      if (pushed === null) await this.#markPush(job, files)
      const fence = this.#fence(task, lease)
      const stopped = await this.#moveBranch(
        job,
        git,
        { repo, branch, target, to: 'forward' },
        fence,
      )
      if (stopped) return stopped
    }
    return this.#settle(job, task, standing, build, files, way)
  }

  /**
   * A press that cannot go on. After a push nothing may say the chat stands as it did: the job goes
   * on until it is recorded. A branch that stands neither here nor there for that long is no longer
   * this press's to move.
   */
  async #refused(
    job: CandidateRewindJob,
    pushed: boolean | null,
    moved: boolean,
  ): Promise<RewindAnswer> {
    return (pushed === null || !(await this.#young(job, UPDATE_REPAIR_MS))) && !moved
      ? this.#final(job, 'refused', true)
      : this.#later(job, new Error('A press that pushed was refused'))
  }

  /** The check right before a push: the lease is held and the chat waits at this turn. */
  #fence(task: RewoundTask, lease: SiteLeaseFence): () => Promise<void> {
    return async () => {
      if (!(await this.deps.leases.assert(lease))) throw leaseLost()
      if (!(await this.#waits(task))) throw withdrawn()
    }
  }

  /** The push of a press: null — the branch moved; else what the job answers without it. */
  async #moveBranch(
    job: CandidateRewindJob,
    git: CandidateGit,
    move: { repo: RepoRef; branch: string; target: RewindTarget; to: 'back' | 'forward' },
    fence: () => Promise<void>,
  ): Promise<RewindAnswer | null> {
    const { repo, branch, target, to } = move
    const [from, onto] = to === 'back' ? [target.head, target.branch] : [target.branch, target.head]
    try {
      await git.rewindBranch({ repo, branch, from, to: onto }, fence)
      return null
    } catch (error) {
      if (isWithdrawn(error)) return this.#final(job, 'nothing', false)
      if (isDomainError(error) && error.code === 'CONFLICT')
        return this.#final(job, 'refused', true)
      throw error
    }
  }

  /** The record of a press: false from it — the chat stopped waiting, and nothing was written. */
  async #settle(
    job: CandidateRewindJob,
    task: RewoundTask,
    standing: StandingCandidate | null,
    build: RewindRecord,
    files: boolean,
    way: RewindWay,
  ): Promise<RewindAnswer> {
    const recorded = await this.#record(job, task, standing, build, files, way)
    if (!recorded) return this.#final(job, 'nothing', false)
    return this.#answer(job, way.redo ? 'redone' : 'rewound')
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
    return this.#plannedTarget(task, turn.headSha)
  }

  /** The turn `/redo` brings back: the last one, undone. web refused the rest at the press. */
  async #undoneTarget(task: RewoundTask): Promise<RewindTarget | null> {
    const turn = await this.deps.db.taskTurn.findUnique({
      where: { taskId_turnNo: { taskId: task.id, turnNo: task.turnNo } },
      select: { status: true, rejectedAt: true, undoneAt: true, headSha: true },
    })
    if (
      turn?.status !== 'completed' ||
      turn.rejectedAt !== null ||
      turn.undoneAt === null ||
      turn.headSha === null
    )
      return null
    return this.#plannedTarget(task, turn.headSha)
  }

  /** Where the turn found the branch and what it worked from, by the plan it ran on. */
  async #plannedTarget(task: RewoundTask, head: string): Promise<RewindTarget | null> {
    const assignments = await this.deps.db.turnAssignment.findMany({
      where: { taskId: task.id, turnNo: task.turnNo },
      select: { plan: true },
    })
    const plan = assignments.length === 1 ? savedPlanOf(assignments[0]!.plan) : null
    if (!plan?.workspace) return null
    return { head, branch: branchBeforeTurn(plan), content: plan.workspace.expectedBaseSha }
  }

  /** The agent's claims of the turn `/redo` brings back; null — no revision of its head was made. */
  async #claimsOfTurn(
    task: RewoundTask,
    head: string,
  ): Promise<Pick<TurnResult, 'change_type' | 'risk'> | null> {
    const row = await this.deps.db.taskCandidate.findFirst({
      where: { taskId: task.id, turnNo: task.turnNo, headSha: head },
      orderBy: { revision: 'desc' },
      select: { facts: true },
    })
    const facts = candidateFactsSchema.safeParse(row?.facts)
    return facts.success ? { change_type: facts.data.changeType, risk: facts.data.risk } : null
  }

  /** What the last `/undo` said of the files: its row of the feed, written after its push. */
  async #undoFiles(task: RewoundTask): Promise<boolean> {
    const row = await this.deps.db.taskEvent.findFirst({
      where: { taskId: task.id, type: 'feed.rewind' },
      orderBy: { id: 'desc' },
      select: { payload: true },
    })
    const rewind = row === null ? null : readFeedRow('feed.rewind', row.payload)
    return rewind?.type === 'feed.rewind' && rewind.files
  }

  /** The status the chat stood in when the last `/undo` took the turn; null — it is not known. */
  async #beforeUndo(task: RewoundTask): Promise<TaskStatus | null> {
    const row = await this.deps.db.taskEvent.findFirst({
      where: {
        taskId: task.id,
        type: CANDIDATE_REWIND_EVENT,
        payload: { path: ['outcome'], equals: 'rewound' },
      },
      orderBy: { id: 'desc' },
      select: { payload: true },
    })
    return (row?.payload as { before?: TaskStatus } | undefined)?.before ?? null
  }

  /** Whether the press of the job is `/redo`: the row of the feed says what was pressed. */
  async #isRedo(job: CandidateRewindJob): Promise<boolean> {
    const row = await this.deps.db.taskEvent.findFirst({
      where: { id: BigInt(job.requestEventId), taskId: job.taskId },
      select: { payload: true },
    })
    const press = row === null ? null : readFeedRow('feed.request', row.payload)
    return press?.type === 'feed.request' && press.kind === 'command'
      ? press.command === 'turn_redo'
      : false
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

  /**
   * The press in one transaction: false — the chat stopped waiting or the press was answered, and
   * nothing is written. `/redo` puts the turn back in the state `/undo` found it in, so a job that
   * outlived its lease is no longer stopped by the turn: only by the answer of the job after it.
   */
  async #record(
    job: CandidateRewindJob,
    task: RewoundTask,
    standing: StandingCandidate | null,
    build: RewindRecord,
    files: boolean,
    way: RewindWay,
  ): Promise<boolean> {
    const stands = build.kind === 'candidate' ? build.record.revision : (standing?.revision ?? null)
    const emptied = build.kind === 'empty'
    const held = stands !== null && !emptied
    // As it was before `/undo`: an open question waits for words, whatever stands.
    const answering = way.redo && way.before === 'awaiting_user'
    const to = held && !answering ? 'awaiting_approval' : 'awaiting_user'
    const turn = { taskId: task.id, turnNo: task.turnNo }
    return this.#transaction(async (tx, now) => {
      // The row first: two jobs of a press read each other's answer here, or not at all.
      if (!(await this.#locked(tx, task)) || (await this.#answered(tx, job))) return false
      const turnId = await (way.redo ? redoDialog : rewindDialog)(tx, { ...turn, to })
      if (turnId === null) return false
      if (way.redo) await includeTurnDbOperations(tx, turn)
      else await excludeTurnDbOperations(tx, turn)
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
        row: way.redo
          ? {
              type: 'feed.redo',
              payload: {
                v: 1,
                turn: task.turnNo,
                files,
                // It waited with a candidate that did not come back: nothing else takes words.
                open: to === 'awaiting_user' && !answering,
              },
            }
          : {
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
      if (way.redo) await this.#event(tx, job, 'redone')
      else await this.#event(tx, job, 'rewound', { before: task.status })
      return true
    })
  }

  /**
   * The chat still waits at the turn of the press: the check right before the push, read after
   * every writer of the task row before it has committed.
   */
  async #waits(task: RewoundTask): Promise<boolean> {
    return this.#transaction((tx) => this.#locked(tx, task))
  }

  /** Whether the chat waits at the turn of the press, with its row locked for the transaction. */
  async #locked(
    tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
    task: RewoundTask,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM tasks
      WHERE id = ${task.id}::uuid AND status::text = ANY(${[...waiting]}::text[])
        AND turn_no = ${task.turnNo}
      FOR UPDATE`
    return rows.length === 1
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
    facts: { before?: TaskStatus } = {},
  ): Promise<void> {
    await db.taskEvent.create({
      data: {
        taskId: job.taskId,
        type: CANDIDATE_REWIND_EVENT,
        payload: { v: 1, requestEventId: job.requestEventId, outcome, ...facts },
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
      const redo = told && (await this.#isRedo(job))
      await this.#transaction(async (tx) => {
        if (await this.#answered(tx, job)) return
        await this.#event(tx, job, answer)
        if (told)
          await insertFeedEvent(tx, {
            taskId: job.taskId,
            row: {
              type: 'feed.update',
              payload: { v: 1, outcome: redo ? 'redo_failed' : 'rewind_failed', conflicts: 0 },
            },
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
