import { Logger } from '@nestjs/common'
import { chargeTask, extendTaskHolds } from '@repo/billing'
import {
  finishEmptiedDialog,
  insertFeedEvent,
  nextCandidateRevision,
  recordCandidate,
  requestPreviewSync,
  supersedeStandingCandidate,
  type CandidateRecordInput,
  type Prisma,
  type PrismaClient,
} from '@repo/db'
import {
  AGENT_TURN_QUEUE,
  candidateFactsSchema,
  CANDIDATE_REBASE_JOB,
  candidateRebaseDedupeKey,
  DomainError,
  isDomainError,
  isTooLarge,
  leaseLost,
  taskHoldExpiry,
  terminalTaskStatuses,
  type CandidateRebaseJob,
  type FeedUpdateOutcome,
  type JobQueue,
  type SiteAdapter,
  type SiteLeaseFence,
  type SiteLeaseStore,
  type SiteStack,
  type TaskStatus,
} from '@repo/domain'

import type { CandidateBuild, CandidateBuilder, StandingCandidate } from './candidate-builder.ts'
import type { CandidateGit } from './candidate-git.ts'
import { siteFactsOf, workspaceRulesOf } from './pass-facts.ts'
import { UPDATE_REPAIR_MS } from './turn-planner.ts'

/** «Обновить» holds the site this long at most: a clone, a patch and one push. */
const REBASE_LEASE_MS = 10 * 60_000
/** A busy site, or a candidate that could not be recorded yet, is asked again after this. */
const RETRY_MS = 30_000
/** The internal row of `task_events` that answers an `/update` (never shown to the client). */
export const CANDIDATE_REBASE_EVENT = 'candidate.rebase'

/**
 * Where a dialog may stand while its branch is carried: waiting, or a pass of it planning
 * (which waits for the lease the update holds). A turn, a release and a closed dialog are not.
 */
const carriable: readonly TaskStatus[] = [
  'awaiting_approval',
  'queued',
  'preparing',
  'awaiting_user',
]

export interface CandidateRebaseDependencies {
  db: PrismaClient
  /** Both null while git is not configured: nothing can be carried. */
  git: CandidateGit | null
  candidates: CandidateBuilder | null
  leases: SiteLeaseStore
  queue: JobQueue
  /**
   * The adapter of a stack: the rules of its workspace (`siteWorkspaceRules`) hold every path
   * the update changes, as publication held the candidate (rule 6).
   */
  adapter: (stack: SiteStack) => SiteAdapter
  logger?: { log(message: string): void; warn(message: string): void; error(message: string): void }
  now?: () => Date
}

export type RebaseAnswer =
  /** The next revision stands on the current `main`. */
  | 'rebased'
  /** `main` holds the whole change already: nothing is left to release, the dialog is done. */
  | 'emptied'
  /** The dialog does not wait with a candidate, or its base is the current `main` already. */
  | 'nothing'
  /** The change does not apply onto the current `main`: the candidate stays as it is. */
  | 'conflict'
  /**
   * What the update would change breaks the rules of the workspace (a CI path, a protected
   * one, media that is not only added): nothing is pushed.
   */
  | 'refused'
  /** The site is busy: the job is put again. */
  | 'busy'
  /** The branch is moved but the candidate could not be recorded yet: the job is put again. */
  | 'later'
  /** Git is not configured, or this core cannot compare commits. */
  | 'unavailable'

interface RebasedTask {
  id: string
  siteId: string
  status: TaskStatus
  attempt: number
  turnNo: number
  billable: boolean
  site: { stack: SiteStack; url: string; installedVersion: string | null }
}

/** The dialog stopped waiting with its candidate before the branch moved: nothing is written. */
const withdrawn = () =>
  new DomainError('CONFLICT', 'The dialog no longer waits with its candidate', 409, {
    reason: 'withdrawn',
  })
const isWithdrawn = (error: unknown) =>
  isDomainError(error) &&
  (error.details as { reason?: unknown } | undefined)?.reason === 'withdrawn'

/** Thrown inside a transaction to roll it back and put the job again. */
class Later extends Error {}

/** What the client's feed is told of an answer (`feed.update`); null — nothing, a closed dialog. */
interface FeedUpdate {
  outcome: FeedUpdateOutcome
  /** Files of the dialog that `main` changed too. */
  conflicts?: number
}
const told = (outcome: FeedUpdateOutcome, conflicts = 0): FeedUpdate => ({ outcome, conflicts })

/** The refusals of the rules of a workspace (`assertCandidatePath`, `assertCandidateChange`). */
const ruleRefusals = new Set(['PUBLICATION_FORBIDDEN', 'PUBLICATION_TOO_LARGE'])

/**
 * «Обновить» (`/update`; docs/plan/53-chat-preview-release.md, Р27): the change of the
 * dialog's candidate since its base is carried onto the current `main` by the trusted side,
 * without the model (`rebaseCandidate`, a three-way merge of trees, R4), and pushed to
 * `agent/<taskId>` by CAS. The result is the next revision with its checks pending, the preview
 * is rebuilt to it, and the next turn of the dialog starts a new session (the planner sees the
 * candidate's head differ from its last turn's). Done under the site's lease, so no turn of the
 * site and no release runs meanwhile.
 *
 * The push comes before the record — the comparison reads the pushed commit — so an update is
 * always finished from the branch as it stands: a run that finds the branch past the standing
 * candidate carries that head (the same commit again while `main` stands still, since the merge
 * is deterministic in the command's instant) and records it, whatever the dialog did meanwhile.
 * A run that could not record puts itself again; a pass that finds the branch moved waits and
 * puts the update again (PassRunner). Every final answer leaves a `candidate.rebase` row.
 */
export class CandidateRebase {
  readonly #logger: {
    log(message: string): void
    warn(message: string): void
    error(message: string): void
  }
  readonly #now: () => Date

  constructor(private readonly deps: CandidateRebaseDependencies) {
    this.#logger = deps.logger ?? new Logger('CandidateRebase')
    this.#now = deps.now ?? (() => new Date())
  }

  async run(job: CandidateRebaseJob): Promise<RebaseAnswer> {
    const { git, candidates } = this.deps
    // Without the comparison a moved branch could never be recorded: nothing is pushed.
    if (!git || !candidates || !git.comparesCommits)
      return this.#final(job, 'unavailable', told('failed'))
    const task = await this.deps.db.task.findUnique({
      where: { id: job.taskId },
      select: {
        id: true,
        siteId: true,
        status: true,
        attempt: true,
        turnNo: true,
        billable: true,
        site: { select: { stack: true, url: true, installedVersion: true } },
      },
    })
    const standing = task ? await this.#standing(task.id) : null
    if (!task || !standing || task.turnNo < 1 || !carriable.includes(task.status))
      return this.#final(
        job,
        'nothing',
        // A dialog at work again — the client wrote meanwhile — or no longer waiting with a
        // candidate: told; a closed or unknown one: not.
        task && !terminalTaskStatuses.includes(task.status)
          ? told(standing && task.status !== 'awaiting_approval' ? 'withdrawn' : 'current')
          : null,
      )

    const lease = await this.deps.leases.acquire({
      siteId: task.siteId,
      taskId: task.id,
      operation: 'turn',
      ttlMs: REBASE_LEASE_MS,
    })
    if (!lease) {
      await this.#again(job, 'busy')
      return this.#answer(job, 'busy')
    }
    try {
      return await this.#rebase(job, task, standing, lease, git, candidates)
    } finally {
      await this.deps.leases.release(lease).catch(() => {
        this.#logger.warn(`candidate_rebase_release_failed task=${job.taskId}`)
      })
    }
  }

  async #rebase(
    job: CandidateRebaseJob,
    task: RebasedTask,
    standing: StandingCandidate,
    lease: SiteLeaseFence,
    git: CandidateGit,
    candidates: CandidateBuilder,
  ): Promise<RebaseAnswer> {
    const repository = await this.deps.db.gitRepository.findFirst({
      where: { siteId: task.siteId },
      orderBy: { createdAt: 'asc' },
      select: { provider: true, owner: true, name: true, defaultBranch: true },
    })
    if (!repository) return this.#final(job, 'nothing', told('failed'))
    const repo = { provider: repository.provider, owner: repository.owner, name: repository.name }
    const branch = `agent/${task.id}`
    const [main, head] = await Promise.all([
      git.readBranchHead({ repo, branch: repository.defaultBranch }),
      git.readBranchHead({ repo, branch }),
    ])
    if (!main || !head) return this.#final(job, 'nothing', told('failed'))
    // A branch past the standing candidate is an update that pushed and did not record — unless
    // it stands on a turn the platform refused (docs/plan/53, «Попробовать ещё (18.10)»): that
    // turn is replaced, never carried, and the candidate is carried as it stands.
    const refused = head !== standing.headSha && (await this.#refused(task.id, head))
    const finishing = head !== standing.headSha && !refused
    if (!finishing && (task.status !== 'awaiting_approval' || main === standing.baseSha))
      return this.#final(job, 'nothing', told(main === standing.baseSha ? 'current' : 'withdrawn'))
    const revision = await nextCandidateRevision(this.deps.db, task.id)
    const context = await candidates.context(task, standing, revision)
    if (!context) return this.#final(job, 'nothing', told('failed'))
    // The rules publication held the candidate to hold every path the update changes: a head
    // past the standing candidate is carried as it is, and only the trusted side checks it.
    const rules = workspaceRulesOf(this.deps.adapter(task.site.stack), siteFactsOf(task.site))

    let headSha: string
    try {
      const rebased = await git.rebaseCandidate(
        {
          repo,
          branch,
          fromBase: standing.baseSha,
          toBase: main,
          head: refused ? standing.headSha : head,
          ...(refused ? { branchHead: head } : {}),
          committedAt: await this.#committedAt(job),
          rules: {
            protectedPaths: [...rules.protectedPaths],
            ...(rules.workingSet ? { workingSet: rules.workingSet } : {}),
            ...(rules.addOnlyPaths ? { addOnlyPaths: [...rules.addOnlyPaths] } : {}),
            ...(rules.media ? { media: rules.media } : {}),
          },
        },
        async () => {
          if (!(await this.deps.leases.assert(lease))) throw leaseLost()
          // A new update moves the branch only of a dialog that still waits with this candidate.
          if (!finishing && !(await this.#waits(task, standing))) throw withdrawn()
        },
      )
      if (rebased.status === 'conflict')
        return this.#final(job, 'conflict', told('conflict', rebased.paths.length))
      headSha = rebased.headSha
    } catch (error) {
      if (isWithdrawn(error)) return this.#final(job, 'nothing', told('withdrawn'))
      // The branch moved, or the candidate no longer stands on its base: nothing was written.
      if (isDomainError(error) && error.code === 'CONFLICT')
        return this.#final(job, 'conflict', told('failed'))
      // A path the rules of the workspace refuse: nothing was pushed, and a retry meets the same.
      if (isDomainError(error) && ruleRefusals.has(error.code)) {
        this.#logger.error(`candidate_rebase_refused task=${job.taskId} code=${error.code}`)
        return this.#final(job, 'refused', told('failed'))
      }
      throw error
    }

    // From here the branch holds the update: it is recorded, or the job is put again.
    let build: CandidateBuild
    try {
      build = await candidates.build(context, {
        turnNo: task.turnNo,
        headSha,
        baseSha: main,
        claims: null,
      })
    } catch (error) {
      return this.#later(job, error)
    }
    if (build.kind === 'empty')
      return this.#emptied(
        job,
        task,
        standing,
        candidates.carrier(context, { turnNo: task.turnNo, headSha, baseSha: main }, build),
      )
    if (build.kind !== 'candidate') return this.#final(job, 'nothing', told('failed'))
    const { record } = build
    if (!(await this.deps.leases.assert(lease))) return this.#later(job, leaseLost())
    try {
      const moved = await this.#transaction(async (tx, now) => {
        if (!(await this.#lockStanding(tx, task, standing))) return false
        await recordCandidate(tx, record)
        const turn = await tx.taskTurn.findUnique({
          where: { taskId_turnNo: { taskId: task.id, turnNo: task.turnNo } },
          select: { id: true },
        })
        await insertFeedEvent(tx, {
          taskId: task.id,
          turnId: turn?.id ?? null,
          row: {
            type: 'feed.candidate',
            payload: {
              v: 1,
              turn: task.turnNo,
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
        await requestPreviewSync(tx, { taskId: task.id, revision: record.revision })
        if (task.billable)
          await extendTaskHolds(tx, {
            taskId: task.id,
            expiresAt: taskHoldExpiry(now, 'waiting'),
          })
        await this.#event(tx, job, 'rebased', record.revision)
        return true
      })
      // The dialog closed meanwhile: its branch no longer matters.
      return moved ? this.#answer(job, 'rebased') : this.#final(job, 'nothing', null)
    } catch (error) {
      return this.#later(job, error)
    }
  }

  /**
   * `main` holds the whole change of the dialog: nothing is left to release, and a waiting
   * dialog ends `done` and is charged by its usage, as a pass without changes ends a dialog
   * without a candidate (Р7).
   *
   * A dialog the client wrote to meanwhile has a pass in the queue: it goes on, without a
   * candidate. The branch holds the update already, so the update is recorded as a revision
   * that is superseded at once (`carrier`, no change against `main`): the planner and the store
   * of assignments find in it the head the platform wrote last and the base `main`, and the pass
   * starts a new session on it — it does not wait for a branch nothing records.
   */
  async #emptied(
    job: CandidateRebaseJob,
    task: RebasedTask,
    standing: StandingCandidate,
    carrier: CandidateRecordInput,
  ): Promise<RebaseAnswer> {
    try {
      const moved = await this.#transaction(async (tx, now) => {
        const done = await finishEmptiedDialog(tx, {
          taskId: task.id,
          attempt: task.attempt,
          turnNo: task.turnNo,
        })
        if (done) {
          await supersedeStandingCandidate(tx, task.id)
          await requestPreviewSync(tx, { taskId: task.id, revision: 0 })
          if (task.billable)
            try {
              await chargeTask(tx, { taskId: task.id, now })
            } catch (error) {
              if (isDomainError(error) && error.code === 'CONFLICT') throw new Later()
              throw error
            }
        } else {
          if (!(await this.#lockStanding(tx, task, standing))) return false
          await recordCandidate(tx, carrier)
          await supersedeStandingCandidate(tx, task.id)
          await requestPreviewSync(tx, { taskId: task.id, revision: 0 })
        }
        await this.#event(tx, job, 'emptied', null)
        await this.#feed(tx, job, told('emptied'))
        return true
      })
      if (moved) return this.#answer(job, 'emptied')
      // The dialog closed meanwhile: its branch no longer matters.
      return this.#final(job, 'nothing', null)
    } catch (error) {
      return this.#later(job, error)
    }
  }

  /**
   * The dialog waits with the same candidate: the check right before the push of a new update,
   * read after every writer of the task row before it has committed. A press after it finds the
   * update recorded whatever it did (`#lockStanding`).
   */
  async #waits(task: RebasedTask, standing: StandingCandidate): Promise<boolean> {
    return this.#transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status::text AS status FROM tasks WHERE id = ${task.id}::uuid FOR UPDATE`
      if (rows[0]?.status !== 'awaiting_approval') return false
      return this.#isStanding(tx, task.id, standing.id)
    })
  }

  /** The task row is locked and still carriable at the same turn, under the same candidate. */
  async #lockStanding(
    tx: Prisma.TransactionClient,
    task: RebasedTask,
    standing: StandingCandidate,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM tasks
      WHERE id = ${task.id}::uuid AND status::text = ANY(${[...carriable]}::text[])
        AND turn_no = ${task.turnNo}
      FOR UPDATE`
    return rows.length === 1 && (await this.#isStanding(tx, task.id, standing.id))
  }

  async #isStanding(
    tx: Prisma.TransactionClient,
    taskId: string,
    candidateId: string,
  ): Promise<boolean> {
    const current = await tx.taskCandidate.findFirst({
      where: { taskId, status: { in: ['current', 'stale'] } },
      orderBy: { revision: 'desc' },
      select: { id: true },
    })
    return current?.id === candidateId
  }

  async #transaction<T>(work: (tx: Prisma.TransactionClient, now: Date) => Promise<T>) {
    return this.deps.db.$transaction((tx) => work(tx, this.#now()), {
      isolationLevel: 'ReadCommitted',
      timeout: 30_000,
    })
  }

  /**
   * The branch is moved and its candidate is not recorded: the job is put again while the
   * update is young enough, so the dialog is never left on a branch nothing knows. A change too
   * large to show will not get smaller and is left to the pass that finds the branch moved.
   */
  async #later(job: CandidateRebaseJob, error: unknown): Promise<RebaseAnswer> {
    const code = isDomainError(error) ? error.code : error instanceof Later ? 'later' : 'error'
    if (isTooLarge(error) || !(await this.#young(job))) {
      this.#logger.error(`candidate_rebase_unrecorded task=${job.taskId} code=${code}`)
      return this.#final(job, 'later', told('failed'))
    }
    this.#logger.warn(`candidate_rebase_later task=${job.taskId} code=${code}`)
    await this.#again(job, 'retry')
    return this.#answer(job, 'later')
  }

  async #again(job: CandidateRebaseJob, why: 'busy' | 'retry'): Promise<void> {
    await this.deps.queue
      .enqueue(AGENT_TURN_QUEUE, CANDIDATE_REBASE_JOB, job, {
        jobId: `${candidateRebaseDedupeKey(job)}:${why === 'busy' ? 'retry' : 'record'}:${this.#now().getTime()}`,
        delayMs: RETRY_MS,
      })
      .catch(() => this.#logger.warn(`candidate_rebase_requeue_failed task=${job.taskId}`))
  }

  async #young(job: CandidateRebaseJob): Promise<boolean> {
    const at = await this.#commandAt(job)
    return at !== null && this.#now().getTime() - at.getTime() <= UPDATE_REPAIR_MS
  }

  async #commandAt(job: CandidateRebaseJob): Promise<Date | null> {
    const row = await this.deps.db.taskEvent.findFirst({
      where: { id: BigInt(job.requestEventId), taskId: job.taskId },
      select: { createdAt: true },
    })
    return row?.createdAt ?? null
  }

  /** Whether `head` is the head of a turn of the task whose pass ended in a failure. */
  async #refused(taskId: string, head: string): Promise<boolean> {
    const turns = await this.deps.db.taskTurn.count({
      where: { taskId, headSha: head, rejectedAt: { not: null } },
    })
    return turns > 0
  }

  /**
   * The trusted instant of the update: when its command was written. A retry of the same job
   * makes the same commit (`rebaseCandidate` is deterministic in it).
   */
  async #committedAt(job: CandidateRebaseJob): Promise<string> {
    const at = (await this.#commandAt(job)) ?? this.#now()
    return new Date(Math.floor(at.getTime() / 1000) * 1000).toISOString()
  }

  async #standing(taskId: string): Promise<StandingCandidate | null> {
    const row = await this.deps.db.taskCandidate.findFirst({
      where: { taskId, status: { in: ['current', 'stale'] } },
      orderBy: { revision: 'desc' },
      select: {
        id: true,
        revision: true,
        baseSha: true,
        headSha: true,
        dbPlanSha256: true,
        facts: true,
      },
    })
    const facts = row ? candidateFactsSchema.safeParse(row.facts) : null
    return row && facts?.success ? { ...row, facts: facts.data } : null
  }

  /** The answer to the command, for operators and the head of the feed: an internal row. */
  async #event(
    db: Pick<Prisma.TransactionClient, 'taskEvent'>,
    job: CandidateRebaseJob,
    outcome: RebaseAnswer,
    revision: number | null,
  ): Promise<void> {
    await db.taskEvent.create({
      data: {
        taskId: job.taskId,
        type: CANDIDATE_REBASE_EVENT,
        payload: { v: 1, requestEventId: job.requestEventId, outcome, revision },
      },
    })
  }

  /**
   * The client's row of an answer that left no new revision (`feed.update`): a new one is told
   * by its `feed.candidate`. The command's own row (`feed.request`) says what was pressed.
   */
  async #feed(
    db: Pick<Prisma.TransactionClient, 'taskEvent'>,
    job: CandidateRebaseJob,
    feed: FeedUpdate,
  ): Promise<void> {
    await insertFeedEvent(db, {
      taskId: job.taskId,
      row: {
        type: 'feed.update',
        payload: { v: 1, outcome: feed.outcome, conflicts: Math.min(feed.conflicts ?? 0, 10_000) },
      },
    })
  }

  /**
   * A final answer: logged, and kept as the command's row — with the client's row `feed` —
   * unless the command was answered already: a repeat put by a pass that waited finds the
   * update recorded and says `nothing`.
   */
  async #final(
    job: CandidateRebaseJob,
    answer: RebaseAnswer,
    feed: FeedUpdate | null,
  ): Promise<RebaseAnswer> {
    try {
      await this.#transaction(async (tx) => {
        const answered = await tx.taskEvent.count({
          where: {
            taskId: job.taskId,
            type: CANDIDATE_REBASE_EVENT,
            payload: { path: ['requestEventId'], equals: job.requestEventId },
          },
        })
        if (answered > 0) return
        await this.#event(tx, job, answer, null)
        if (feed) await this.#feed(tx, job, feed)
      })
    } catch {
      this.#logger.warn(`candidate_rebase_event_failed task=${job.taskId}`)
    }
    return this.#answer(job, answer)
  }

  #answer(job: CandidateRebaseJob, answer: RebaseAnswer): RebaseAnswer {
    this.#logger.log(`candidate_rebase task=${job.taskId} answer=${answer}`)
    return answer
  }
}
