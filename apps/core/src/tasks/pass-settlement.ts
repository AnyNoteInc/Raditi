import { Logger } from '@nestjs/common'
import {
  attemptCreditBudget,
  chargeTask,
  extendTaskHolds,
  releaseTask,
  type ReturnedTaskHolds,
} from '@repo/billing'
import {
  cancelWaitingTask,
  carryBrowserChecks,
  excludeTurnDbOperations,
  insertFeedEvent,
  nextCandidateRevision,
  recordCandidate,
  rejectTurn,
  requestPreviewSync,
  settleTurn,
  supersedeStandingCandidate,
  taskHasProductionWrites,
  waitingTaskStatuses,
  type Prisma,
  type PrismaClient,
  type SettledTaskStatus,
} from '@repo/db'
import {
  candidateFactsSchema,
  feedLimits,
  isDomainError,
  isTooLarge,
  Money,
  readFeedRow,
  taskHoldExpiry,
  type FeedCreditsState,
  type FeedFailureCode,
  type FeedQuestionPayload,
  type FeedRow,
  type SiteStack,
  type TaskRequirements,
  type TaskWaitingReason,
  type TurnEvidence,
  type TurnResult,
} from '@repo/domain'

import { readBrowserTaskFacts, type BrowserTaskFacts } from '../browser/browser-facts.ts'
import type { BrowserSessions } from '../browser/browser-sessions.ts'
import type { CandidateBuild, CandidateBuilder, StandingCandidate } from './candidate-builder.ts'
import { isComparisonMissing } from './candidate-git.ts'
import { agentQuestionOf, agentWords, ceilingQuestionOf, feedFailureOf } from './turn-outcome.ts'

// How a pass of the agent ends (docs/plan/53-chat-preview-release.md, R3, Р5–Р8, Р22; spec §7).
// Each ending is one transaction: the conditional move of the task (settleTurn), its feed rows,
// the candidate and the money — the move first, then @repo/billing, so the task row is always
// locked before the credit accounts. The live handler and the sweep both end passes here; the
// conditional move lets only one of them write. The client's «Отменить» is read again after the
// move has locked the task row, so a press web wrote while the pass was being ended still wins.

type JournalReason = NonNullable<TurnEvidence['reason']>
type CeilingQuestion = Extract<FeedQuestionPayload, { kind: 'ceiling' }>
type BrowserQuestion = Extract<FeedQuestionPayload, { kind: 'browser' }>

/** A pass orphaned this many times in one attempt is failed instead of put again. */
export const ORPHANED_PASS_LIMIT = 3
/** The internal row of `task_events` an orphaned pass leaves (never shown to the client). */
export const ORPHANED_PASS_EVENT = 'pass.orphaned'

export type PassEnding =
  /**
   * The turn completed: its result, and with a repository the head it published on
   * `agent/<taskId>` — a turn without one publishes nothing (docs/plan/57-browser-tasks.md, Б4).
   */
  | { kind: 'completed'; turn: number; result: TurnResult; headSha?: string }
  /** The turn, or the pass before its turn, failed. */
  | {
      kind: 'failed'
      turn: number | null
      errorCode?: string
      detailReason?: string
      journalReason?: JournalReason
    }
  /** The pass stopped because the client cancelled it. */
  | { kind: 'cancelled'; turn: number | null }
  /** Before a turn: the key could not cover a first call (Р8). */
  | { kind: 'ceiling'; question: CeilingQuestion }
  /** Before a turn: the pass cannot be run at all. */
  | { kind: 'refused'; code: FeedFailureCode }
  /** The site or the pool of agents is busy: back to the queue, not a failure. */
  | { kind: 'busy'; waiting: TaskWaitingReason }
  /**
   * Before a turn: the handler of the pass is gone (its core stopped while planning). Nothing
   * was lost, so the pass goes back to the queue; after ORPHANED_PASS_LIMIT times it fails.
   */
  | { kind: 'orphaned' }

export interface PassRef {
  taskId: string
  /** `tasks.attempt` of the pass. */
  attempt: number
  /** `tasks.turn_no` now: the number a turn this pass opened got, or the one it was claimed at. */
  turnNo: number
}

/**
 * - `moved` — the task left its pass with this ending;
 * - `skipped` — another writer moved it first, or a turn of it is still assigned;
 * - `later` — the ending cannot be written yet (the usage of the turn keys is open, git did not
 *   answer): the task stays where it is and the sweep comes back to it.
 */
export type SettleAnswer = 'moved' | 'skipped' | 'later'

export interface SettlementDependencies {
  db: PrismaClient
  /** null while git is not configured: a completed pass then cannot become a candidate. */
  candidates: CandidateBuilder | null
  /**
   * Closes the cloud browser of a task that ended (docs/plan/57, Б18); null — no worker is
   * configured, and the collector closes what is left.
   */
  browser?: Pick<BrowserSessions, 'close'> | null
  logger?: { warn(message: string): void; error(message: string): void }
  now?: () => Date
}

export interface SettleOptions {
  /**
   * The sweep has waited long enough: a candidate that cannot be built fails the pass, and a
   * charge refused for a reason other than open usage is left to the operator — the task is
   * moved anyway, never kept forever.
   */
  giveUp?: boolean
}

/** Thrown inside a transaction to roll it back: the move matched nothing. */
class NotMoved extends Error {}
/** Thrown inside a transaction to roll it back: try again later. */
class Later extends Error {}
/** Thrown inside a transaction to roll it back: the client pressed «Отменить» meanwhile. */
class CancelPressed extends Error {
  constructor(readonly authorId: string) {
    super('cancel pressed')
  }
}

type Reader = Pick<Prisma.TransactionClient, 'taskEvent'>

interface SettleContext {
  task: {
    id: string
    workspaceId: string
    siteId: string
    billable: boolean
    site: { stack: SiteStack; url: string; installedVersion: string | null }
  }
  /** What the task works with (docs/plan/57, Б2): a pass without a repository has no candidate. */
  requirements: TaskRequirements
  /** The facts of the task's cloud browser; null for a task without one. */
  browser: BrowserTaskFacts | null
  /** The author of a `cancel` command written after the last request of the dialog. */
  cancel: { authorId: string } | null
  policyFlagged: boolean
  /**
   * The task wrote the production site and the write was not undone (legacy content path), or
   * anyone acted in its cloud browser (Б28).
   */
  productionWrites: boolean
  standing: StandingCandidate | null
}

const creditsOf = (returned: ReturnedTaskHolds): FeedCreditsState | null =>
  returned.applied ? (returned.expiries.length > 0 ? 'expired' : 'returned') : null

/** What a task in the browser had saved on the site, for a row that ends it (Б23, Б24). */
const objectsOf = (context: SettleContext) =>
  context.browser?.objects.length ? { objects: context.browser.objects } : {}

const chargeRefusal = (error: unknown): string | null => {
  if (!isDomainError(error) || error.code !== 'CONFLICT') return null
  const charge = (error.details as { charge?: unknown } | undefined)?.charge
  return typeof charge === 'string' ? charge : null
}

/**
 * The author of a `cancel` press that came after the last words of the dialog, or null: a
 * command is a press, not an answer (R2, `movingRequest`), so only commands are skipped on the
 * way back, and the first non-command request ends the search.
 */
export async function pressedCancel(
  db: Reader,
  taskId: string,
): Promise<{ authorId: string } | null> {
  const requests = await db.taskEvent.findMany({
    where: { taskId, type: 'feed.request' },
    orderBy: { id: 'desc' },
    take: 50,
    select: { payload: true },
  })
  for (const row of requests) {
    const event = readFeedRow('feed.request', row.payload)
    if (event.type !== 'feed.request') continue
    if (event.kind !== 'command') return null
    if (event.command === 'cancel') return { authorId: event.authorId }
  }
  return null
}

export class PassSettlement {
  readonly #logger: { warn(message: string): void; error(message: string): void }
  readonly #now: () => Date

  constructor(private readonly deps: SettlementDependencies) {
    this.#logger = deps.logger ?? new Logger('PassSettlement')
    this.#now = deps.now ?? (() => new Date())
  }

  async settle(
    pass: PassRef,
    ending: PassEnding,
    options: SettleOptions = {},
  ): Promise<SettleAnswer> {
    const context = await this.#context(pass.taskId)
    if (!context) return 'skipped'
    const turn = 'turn' in ending ? ending.turn : null
    // The client's «Отменить» wins over whatever the pass came to (spec §7).
    if (context.cancel) return this.#cancelled(pass, context, turn, ending)
    try {
      return await this.#end(pass, context, ending, options)
    } catch (error) {
      // The press was written while this ending was being prepared: the move is rolled back.
      if (!(error instanceof CancelPressed)) throw error
      return this.#cancelled(
        pass,
        { ...context, cancel: { authorId: error.authorId } },
        turn,
        ending,
      )
    }
  }

  /**
   * A dialog that waits — queued, with a question or with a candidate — whose «Отменить» came
   * while core still saw its pass at work: web left it to core (`turn.cancel`), and the pass
   * ended otherwise first. It is closed as web closes a waiting dialog: `cancelled`, the reserve
   * given back, `feed.cancelled` by its author, the preview taken down. Never with a release in
   * work (cancelWaitingTask).
   */
  async cancelWaiting(taskId: string): Promise<SettleAnswer> {
    const context = await this.#context(taskId)
    const cancel = context?.cancel
    if (!context || !cancel) return 'skipped'
    const task = await this.deps.db.task.findUnique({
      where: { id: taskId },
      select: { status: true, attempt: true, turnNo: true },
    })
    const from = waitingTaskStatuses.find((status) => status === task?.status)
    if (!task || !from) return 'skipped'
    return this.#transaction(async (tx, now) => {
      const moved = await cancelWaitingTask(tx, {
        taskId,
        from,
        attempt: task.attempt,
        feed: [],
      })
      if (!moved.moved) throw new NotMoved()
      const returned = await releaseTask(tx, { taskId, now })
      await insertFeedEvent(tx, {
        taskId,
        turnId: moved.turnId,
        row: {
          type: 'feed.cancelled',
          payload: {
            v: 1,
            turn: task.turnNo > 0 ? task.turnNo : null,
            by: 'customer',
            authorId: cancel.authorId,
            site: context.productionWrites ? 'check' : 'unchanged',
            credits: creditsOf(returned),
            ...objectsOf(context),
          },
        },
      })
      await requestPreviewSync(tx, { taskId, revision: 0 })
    }).then((answer) => this.#closeBrowser(context, answer, 'task_cancelled'))
  }

  #end(
    pass: PassRef,
    context: SettleContext,
    ending: PassEnding,
    options: SettleOptions,
  ): Promise<SettleAnswer> {
    switch (ending.kind) {
      case 'completed':
        return this.#completed(pass, context, ending, options)
      case 'failed':
        return this.#failed(pass, context, ending)
      case 'cancelled':
        return this.#cancelled(pass, context, ending.turn, ending)
      case 'ceiling':
        return this.#ceiling(pass, context, null, ending.question)
      case 'refused':
        return this.#failure(pass, context, null, ending.code)
      case 'busy':
        return this.#busy(pass, context, ending.waiting)
      case 'orphaned':
        return this.#orphaned(pass, context)
    }
  }

  // --- Endings --------------------------------------------------------------------------------

  async #completed(
    pass: PassRef,
    context: SettleContext,
    ending: Extract<PassEnding, { kind: 'completed' }>,
    options: SettleOptions,
  ): Promise<SettleAnswer> {
    const { result, turn } = ending
    // Without a repository there is no candidate: the site itself is what the pass changed.
    if (!context.requirements.repository)
      return this.#completedWithoutRepository(pass, context, ending, options)
    const question = agentQuestionOf(result, turn)
    const message = agentWords(result.client_message, 2000)
    // Nothing readable is left of the agent's words: its result is as good as missing.
    if (!question && !message) return this.#failure(pass, context, turn, 'technical')
    // A turn with a repository published its head: without one there is nothing to compare.
    const headSha = ending.headSha
    if (!headSha) return this.#failure(pass, context, turn, 'technical')

    let build: CandidateBuild
    try {
      if (!this.deps.candidates) throw new Error('git is not configured')
      const revision = await nextCandidateRevision(this.deps.db, pass.taskId)
      const candidateContext = await this.deps.candidates.context(
        context.task,
        context.standing,
        revision,
      )
      if (!candidateContext) throw new Error('the dialog has no base')
      build = await this.deps.candidates.build(candidateContext, {
        turnNo: turn,
        headSha,
        claims: result,
      })
    } catch (error) {
      if (isTooLarge(error)) return this.#failure(pass, context, turn, 'too_large')
      // This build of core cannot compare commits (R4): the change can never become a
      // candidate here, so the client is not kept waiting for it.
      if (isComparisonMissing(error)) {
        this.#logger.error(`pass_candidate_unsupported task=${pass.taskId} turn=${turn}`)
        return this.#failure(pass, context, turn, 'unavailable')
      }
      if (!options.giveUp) {
        this.#logger.warn(`pass_candidate_later task=${pass.taskId} turn=${turn}`)
        return 'later'
      }
      return this.#failure(pass, context, turn, 'technical')
    }

    const hasCandidate =
      build.kind === 'candidate' || (build.kind === 'unchanged' && !!context.standing)
    // Nothing to release and nothing asked: the dialog stays open for the client's next words, in
    // the same attempt (owner's decision of 26.10.2026, «не закрывай чат»). A dialog the client
    // leaves so is free, as any abandoned dialog (answer of 18.10.2026).
    const to: SettledTaskStatus = question || !hasCandidate ? 'awaiting_user' : 'awaiting_approval'
    // The trusted count of what the dialog would release now; none once the pass undid it all.
    const facts =
      build.kind === 'candidate'
        ? build.record.facts
        : build.kind === 'unchanged'
          ? (context.standing?.facts ?? null)
          : null
    const filesChanged = facts
      ? facts.addedFiles + facts.modifiedFiles + facts.deletedFiles + facts.mediaFiles
      : 0
    const rows: FeedRow[] = []
    if (build.kind === 'candidate') {
      const { record } = build
      rows.push({
        type: 'feed.candidate',
        payload: {
          v: 1,
          turn,
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
      })
    }
    rows.push(
      question
        ? { type: 'feed.question', payload: question }
        : {
            type: 'feed.result',
            payload: {
              v: 1,
              turn,
              message: message!,
              site: context.productionWrites ? 'changed' : 'unchanged',
              next: hasCandidate ? 'awaiting_approval' : 'awaiting_user',
              filesChanged: Math.min(filesChanged, 10_000),
              changeType: result.change_type,
              needsApproval: result.needs_approval,
              risk: result.risk,
            },
          },
    )

    return this.#transaction(async (tx, now) => {
      const moved = await settleTurn(tx, {
        taskId: pass.taskId,
        attempt: pass.attempt,
        expectedTurnNo: pass.turnNo,
        from: ['running'],
        to,
        turn,
        feed: rows,
        summary: result.summary,
        changeType: result.change_type,
      })
      if (!moved.moved) throw new NotMoved()
      await this.#assertNotCancelled(tx, pass.taskId)
      if (build.kind === 'candidate') {
        const recorded = await recordCandidate(tx, build.record)
        // The agent's checks in the browser of this turn, when nothing reached the preview
        // after them (R7): a row `agent_browser` of the revision the turn made.
        await carryBrowserChecks(tx, {
          taskId: pass.taskId,
          candidateId: recorded.id,
          turnNo: pass.turnNo,
        })
        await requestPreviewSync(tx, { taskId: pass.taskId, revision: build.record.revision })
      } else if (build.kind === 'unchanged' && context.standing) {
        // The turn looked at the revision that stands and changed nothing of it.
        await carryBrowserChecks(tx, {
          taskId: pass.taskId,
          candidateId: context.standing.id,
          turnNo: pass.turnNo,
        })
      } else if (build.kind === 'empty' && context.standing) {
        // The pass undid every change of the dialog: nothing stands to release, and the preview
        // shows the site as it is.
        await supersedeStandingCandidate(tx, pass.taskId)
        await requestPreviewSync(tx, { taskId: pass.taskId, revision: 0 })
      }
      // The dialog waits — for an answer, a decision on its changes or the next words — under
      // the same reserve; it is charged once it ends (release), or never when left.
      if (context.task.billable) {
        await extendTaskHolds(tx, {
          taskId: pass.taskId,
          expiresAt: taskHoldExpiry(now, 'waiting'),
        })
      }
    })
  }

  /**
   * A completed pass of a task in the cloud browser (docs/plan/57-browser-tasks.md, Б23, Б25): no
   * candidate — what the site holds now is the result, and only the platform's own check of it
   * ends the task. In this order: the agent asked the client to act in the browser (`web_help`),
   * the client holds the browser, the agent asked a question — each waits for the client
   * (`awaiting_user`) within the same attempt; else an object the platform confirmed on the
   * site, or a screenshot the agent sent the client with nothing saved left unconfirmed (owner's
   * decision of 26.10.2026), makes the task `done`, charged, its browser closed; neither — the
   * platform asks the client to look (`unconfirmed`).
   */
  async #completedWithoutRepository(
    pass: PassRef,
    context: SettleContext,
    ending: Extract<PassEnding, { kind: 'completed' }>,
    options: SettleOptions,
  ): Promise<SettleAnswer> {
    const { result, turn } = ending
    const browser = context.browser
    const message = agentWords(result.client_message, feedLimits.message)
    // Under a question of the platform the agent's message still reaches the client: why it
    // saved nothing («менять настройки мне нельзя»), or what it did before the client took over.
    const said = message ? { message } : {}
    let question: FeedQuestionPayload | null
    if (browser?.help) {
      // The agent's words of its request; its message when they cannot be shown.
      const words = agentWords(browser.help.message, feedLimits.helpMessage) ?? message
      question = {
        v: 1,
        kind: 'browser',
        turn,
        reason: browser.help.reason,
        ...(words ? { message: words } : {}),
      } satisfies BrowserQuestion
    } else if (browser?.controller === 'user')
      question = {
        v: 1,
        kind: 'browser',
        turn,
        reason: 'control',
        ...said,
      } satisfies BrowserQuestion
    else question = agentQuestionOf(result, turn)
    // Nothing readable is left of the agent's words: its result is as good as missing.
    if (!question && !message) return this.#failure(pass, context, turn, 'technical')
    // `done` is what the site confirms or the screenshot the client got, never the agent's word
    // (Б23; owner's decision of 26.10.2026).
    if (!question && !browser?.confirmed && !browser?.screenshotted)
      question = {
        v: 1,
        kind: 'browser',
        turn,
        reason: 'unconfirmed',
        ...said,
      } satisfies BrowserQuestion
    const to: SettledTaskStatus = question ? 'awaiting_user' : 'done'
    const row: FeedRow = question
      ? { type: 'feed.question', payload: question }
      : {
          type: 'feed.result',
          payload: {
            v: 1,
            turn,
            message: message!,
            // A screenshot alone changed nothing on the site.
            site: browser?.confirmed ? 'changed' : 'unchanged',
            next: 'done',
            filesChanged: 0,
            changeType: result.change_type,
            needsApproval: result.needs_approval,
            risk: result.risk,
            ...objectsOf(context),
          },
        }
    const answer = await this.#transaction(async (tx, now) => {
      const moved = await settleTurn(tx, {
        taskId: pass.taskId,
        attempt: pass.attempt,
        expectedTurnNo: pass.turnNo,
        from: ['running'],
        to,
        turn,
        feed: [row],
        summary: result.summary,
        changeType: result.change_type,
      })
      if (!moved.moved) throw new NotMoved()
      await this.#assertNotCancelled(tx, pass.taskId)
      if (to === 'done') {
        if (context.task.billable) await this.#charge(tx, pass.taskId, now, options)
      } else if (context.task.billable) {
        // The help, the control and the answer are the same attempt (Б25): its reserve waits.
        await extendTaskHolds(tx, {
          taskId: pass.taskId,
          expiresAt: taskHoldExpiry(now, 'waiting'),
        })
      }
    })
    return to === 'done' ? this.#closeBrowser(context, answer, 'task_done') : answer
  }

  async #failed(
    pass: PassRef,
    context: SettleContext,
    ending: Extract<PassEnding, { kind: 'failed' }>,
  ): Promise<SettleAnswer> {
    const code = feedFailureOf({
      ...(ending.errorCode ? { errorCode: ending.errorCode } : {}),
      ...(ending.detailReason ? { detailReason: ending.detailReason } : {}),
      ...(ending.journalReason ? { journalReason: ending.journalReason } : {}),
      policyFlagged: context.policyFlagged,
    })
    // The step or the client's credits ran out inside the turn: the platform asks «Продолжить?»
    // instead of failing, and a dialog with a candidate keeps `/release` (Р8). A key the gateway
    // stopped for its pace or its count of calls (`budget` too, П22) still had money: that is
    // the platform's limit, not the client's, and the pass fails as it is.
    if (code === 'technical' && ending.turn !== null && context.task.billable) {
      const question = await this.#moneyCeiling(pass, ending.turn)
      if (question) return this.#ceiling(pass, context, ending.turn, question)
    }
    return this.#failure(pass, context, ending.turn, code)
  }

  /**
   * A pass failed. Its turn, when it opened one, is marked refused (`rejectTurn`): the planner
   * replaces it, «Обновить» does not carry it, and its model calls are not charged.
   *
   * A dialog that already had a candidate keeps it and its preview, whatever the failure (the
   * owner's answer 1 of 18.10.2026; docs/plan/53, «Попробовать ещё (18.10)»): it waits in
   * `awaiting_approval` with the failure row, as with «Продолжить?» (Р8) — `/release`, «Обновить»,
   * words, «Отменить» and, when the failure allows one, «Попробовать ещё» stay open. The reserve
   * stays and is moved on: the release is charged from it, and a retry gives it back. A dialog
   * without a candidate ends `failed` and gives its reserve back.
   */
  async #failure(
    pass: PassRef,
    context: SettleContext,
    turn: number | null,
    code: FeedFailureCode,
  ): Promise<SettleAnswer> {
    const site = context.productionWrites ? 'check' : 'unchanged'
    const { standing } = context
    if (standing)
      return this.#transaction(async (tx, now) => {
        const moved = await settleTurn(tx, {
          taskId: pass.taskId,
          attempt: pass.attempt,
          expectedTurnNo: pass.turnNo,
          from: ['preparing', 'running'],
          to: 'awaiting_approval',
          turn,
          feed: [
            {
              type: 'feed.failure',
              payload: { v: 1, turn, code, site, credits: null, next: 'awaiting_approval' },
            },
          ],
        })
        if (!moved.moved) throw new NotMoved()
        await this.#assertNotCancelled(tx, pass.taskId)
        if (turn !== null) {
          await rejectTurn(tx, { taskId: pass.taskId, turnNo: turn })
          // The preview goes back to the candidate: the database writes of the turn leave the
          // plan (Р22).
          await excludeTurnDbOperations(tx, { taskId: pass.taskId, turnNo: turn })
          await requestPreviewSync(tx, { taskId: pass.taskId, revision: standing.revision })
        }
        if (context.task.billable)
          await extendTaskHolds(tx, {
            taskId: pass.taskId,
            expiresAt: taskHoldExpiry(now, 'waiting'),
          })
      })
    return this.#transaction(async (tx, now) => {
      const moved = await settleTurn(tx, {
        taskId: pass.taskId,
        attempt: pass.attempt,
        expectedTurnNo: pass.turnNo,
        from: ['preparing', 'running'],
        to: 'failed',
        turn,
        feed: [],
      })
      if (!moved.moved) throw new NotMoved()
      await this.#assertNotCancelled(tx, pass.taskId)
      if (turn !== null) await rejectTurn(tx, { taskId: pass.taskId, turnNo: turn })
      const returned = await releaseTask(tx, { taskId: pass.taskId, now })
      await insertFeedEvent(tx, {
        taskId: pass.taskId,
        turnId: moved.turnId,
        row: {
          type: 'feed.failure',
          payload: {
            v: 1,
            turn,
            code,
            site,
            credits: creditsOf(returned),
            next: 'failed',
            ...objectsOf(context),
          },
        },
      })
      await this.#closePreview(tx, pass.taskId, turn)
    }).then((answer) => this.#closeBrowser(context, answer, 'task_failed'))
  }

  async #cancelled(
    pass: PassRef,
    context: SettleContext,
    turn: number | null,
    ending: PassEnding,
  ): Promise<SettleAnswer> {
    // A pass sent back to the queue is cancelled from `preparing`: it never ran.
    const from: ('preparing' | 'running')[] =
      ending.kind === 'busy' || ending.kind === 'orphaned'
        ? ['preparing']
        : ['preparing', 'running']
    return this.#transaction(async (tx, now) => {
      const moved = await settleTurn(tx, {
        taskId: pass.taskId,
        attempt: pass.attempt,
        expectedTurnNo: pass.turnNo,
        from,
        to: 'cancelled',
        turn,
        feed: [],
      })
      if (!moved.moved) throw new NotMoved()
      const returned = await releaseTask(tx, { taskId: pass.taskId, now })
      await insertFeedEvent(tx, {
        taskId: pass.taskId,
        turnId: moved.turnId,
        row: {
          type: 'feed.cancelled',
          payload: {
            v: 1,
            turn,
            by: 'customer',
            ...(context.cancel ? { authorId: context.cancel.authorId } : {}),
            site: context.productionWrites ? 'check' : 'unchanged',
            credits: creditsOf(returned),
            ...objectsOf(context),
          },
        },
      })
      await this.#closePreview(tx, pass.taskId, turn)
    }).then((answer) => this.#closeBrowser(context, answer, 'task_cancelled'))
  }

  async #ceiling(
    pass: PassRef,
    context: SettleContext,
    turn: number | null,
    question: CeilingQuestion,
  ): Promise<SettleAnswer> {
    const to: SettledTaskStatus = context.standing ? 'awaiting_approval' : 'awaiting_user'
    return this.#transaction(async (tx, now) => {
      const moved = await settleTurn(tx, {
        taskId: pass.taskId,
        attempt: pass.attempt,
        expectedTurnNo: pass.turnNo,
        from: ['preparing', 'running'],
        to,
        turn,
        feed: [{ type: 'feed.question', payload: question }],
      })
      if (!moved.moved) throw new NotMoved()
      await this.#assertNotCancelled(tx, pass.taskId)
      // The preview goes back to the last candidate, or to the base: the database writes of
      // the turn leave the plan (Р22).
      if (turn !== null) {
        await excludeTurnDbOperations(tx, { taskId: pass.taskId, turnNo: turn })
        await requestPreviewSync(tx, {
          taskId: pass.taskId,
          revision: context.standing?.revision ?? 0,
        })
      }
      if (context.task.billable)
        await extendTaskHolds(tx, {
          taskId: pass.taskId,
          expiresAt: taskHoldExpiry(now, 'waiting'),
        })
    })
  }

  /**
   * Back to the queue from `preparing`: `waiting` names why the site or the pool sent it back;
   * null — its handler was lost before a turn (`orphaned`), and the row that counts those is
   * written with the move.
   */
  async #busy(
    pass: PassRef,
    context: SettleContext,
    waiting: TaskWaitingReason | null,
  ): Promise<SettleAnswer> {
    return this.#transaction(async (tx, now) => {
      const moved = await settleTurn(tx, {
        taskId: pass.taskId,
        attempt: pass.attempt,
        expectedTurnNo: pass.turnNo,
        from: ['preparing'],
        to: 'queued',
        waiting,
        turn: null,
        feed: [],
      })
      if (!moved.moved) throw new NotMoved()
      await this.#assertNotCancelled(tx, pass.taskId)
      if (waiting === null)
        await tx.taskEvent.create({
          data: {
            taskId: pass.taskId,
            type: ORPHANED_PASS_EVENT,
            payload: { v: 1, attempt: pass.attempt },
          },
        })
      // The reserve waits with the task in the queue.
      if (context.task.billable)
        await extendTaskHolds(tx, {
          taskId: pass.taskId,
          expiresAt: taskHoldExpiry(now, 'waiting'),
        })
    })
  }

  async #orphaned(pass: PassRef, context: SettleContext): Promise<SettleAnswer> {
    const [row] = await this.deps.db.$queryRaw<Array<{ orphaned: bigint }>>`
      SELECT count(*) AS orphaned FROM task_events
      WHERE task_id = ${pass.taskId}::uuid AND type = ${ORPHANED_PASS_EVENT}
        AND payload->>'attempt' = ${String(pass.attempt)}`
    if ((row?.orphaned ?? 0n) + 1n >= BigInt(ORPHANED_PASS_LIMIT))
      return this.#failure(pass, context, null, 'unavailable')
    // Back to the queue without a reason to wait: the caller puts the pass again.
    return this.#busy(pass, context, null)
  }

  // --- Parts ----------------------------------------------------------------------------------

  /** One transaction at READ COMMITTED, as @repo/billing requires; its answer as SettleAnswer. */
  async #transaction(
    work: (tx: Prisma.TransactionClient, now: Date) => Promise<void>,
  ): Promise<SettleAnswer> {
    try {
      await this.deps.db.$transaction((tx) => work(tx, this.#now()), {
        isolationLevel: 'ReadCommitted',
        timeout: 30_000,
      })
      return 'moved'
    } catch (error) {
      if (error instanceof NotMoved) return 'skipped'
      if (error instanceof Later) return 'later'
      throw error
    }
  }

  /**
   * After the move has locked the task row: web writes «Отменить» of a pass at work under the
   * same lock (`cancelDialog`), so at READ COMMITTED this statement sees every press that came
   * before the move, and one that comes after it finds the task waiting and is web's to close.
   */
  async #assertNotCancelled(tx: Reader, taskId: string): Promise<void> {
    const cancel = await pressedCancel(tx, taskId)
    if (cancel) throw new CancelPressed(cancel.authorId)
  }

  /**
   * `chargeTask` after the move to `done` (rule 7). Open usage of a turn key takes the move
   * back: the sweep settles again once it closed. Any other refusal is the operator's; the
   * sweep that gave up moves the task without the charge.
   */
  async #charge(
    tx: Prisma.TransactionClient,
    taskId: string,
    now: Date,
    options: SettleOptions,
  ): Promise<void> {
    try {
      await chargeTask(tx, { taskId, now })
    } catch (error) {
      const refusal = chargeRefusal(error)
      if (refusal === null) throw error
      if (refusal === 'usage_open' || !options.giveUp) {
        this.#logger.warn(`pass_charge_later task=${taskId} reason=${refusal}`)
        throw new Later()
      }
      this.#logger.error(`pass_charge_refused task=${taskId} reason=${refusal}`)
    }
  }

  /**
   * The dialog is closed (`failed`, `cancelled`): the database writes of its last turn leave the
   * plan (Р22), and the manager of previews, woken for a closed task, takes its preview down
   * (R5c) — whether or not a turn ever ran.
   */
  async #closePreview(
    tx: Prisma.TransactionClient,
    taskId: string,
    turn: number | null,
  ): Promise<void> {
    if (turn !== null) await excludeTurnDbOperations(tx, { taskId, turnNo: turn })
    await requestPreviewSync(tx, { taskId, revision: 0 })
  }

  /**
   * The task ended with this move: its cloud browser is closed (Б18) — after the commit, best
   * effort; the collector closes what a failure here leaves. Answers the move as it was.
   */
  async #closeBrowser(
    context: SettleContext,
    answer: SettleAnswer,
    reason: 'task_done' | 'task_failed' | 'task_cancelled',
  ): Promise<SettleAnswer> {
    if (answer === 'moved' && context.requirements.browser)
      await this.deps.browser?.close(context.task.id, reason)
    return answer
  }

  /**
   * The numbers of «Продолжить?» when a key of the turn was refused for money: what it had left
   * — its budget less its recorded work and the reserves of its open calls — could not cover a
   * next call, at least a first call of the class or as much as its last call reserved. null —
   * no key of the turn was refused, the refusal was the gateway's pace or call ceiling, or the
   * budget cannot be read.
   */
  async #moneyCeiling(pass: PassRef, turn: number): Promise<CeilingQuestion | null> {
    const { db } = this.deps
    const keys = await db.llmKey.findMany({
      where: { taskId: pass.taskId, turnNo: turn, lastRefusal: 'budget' },
      select: { id: true, budgetRub: true },
    })
    if (keys.length === 0) return null
    let budget: Awaited<ReturnType<typeof attemptCreditBudget>>
    try {
      budget = await attemptCreditBudget(db, {
        taskId: pass.taskId,
        attempt: pass.attempt,
        now: this.#now(),
      })
    } catch {
      return null
    }
    const firstCall = new Money(budget.finishRub)
    let money = false
    for (const key of keys) {
      const [spent, open, last] = await Promise.all([
        db.tokenUsage.aggregate({ where: { keyId: key.id }, _sum: { costRub: true } }),
        db.llmCall.aggregate({
          where: { keyId: key.id, state: 'open' },
          _sum: { reservedRub: true },
        }),
        db.llmCall.findFirst({
          where: { keyId: key.id },
          orderBy: { startedAt: 'desc' },
          select: { reservedRub: true },
        }),
      ])
      const left = new Money(key.budgetRub.toFixed(10))
        .minus(spent._sum.costRub?.toFixed(10) ?? 0)
        .minus(open._sum.reservedRub?.toFixed(10) ?? 0)
      const lastCall = new Money(last?.reservedRub.toFixed(10) ?? 0)
      if (left.lt(Money.max(firstCall, lastCall))) money = true
    }
    if (!money) return null
    return ceilingQuestionOf(
      {
        chainAttempts: budget.chainAttempts,
        reserved: budget.reserved,
        used: budget.used,
        customerLeftRub: budget.customerLeftRub,
        spendableNow: budget.spendableNow,
      },
      turn,
    )
  }

  /** What the ending of a pass depends on beyond the pass itself, read before its transaction. */
  async #context(taskId: string): Promise<SettleContext | null> {
    const { db } = this.deps
    const task = await db.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        workspaceId: true,
        siteId: true,
        billable: true,
        needsRepository: true,
        needsBrowser: true,
        site: { select: { stack: true, url: true, installedVersion: true } },
      },
    })
    if (!task) return null
    const { needsRepository, needsBrowser, ...settled } = task
    const [cancel, flagged, writes, standing, browser] = await Promise.all([
      pressedCancel(db, taskId),
      db.taskEvent.count({ where: { taskId, type: 'llm.policy_flagged' } }),
      taskHasProductionWrites(db, taskId),
      db.taskCandidate.findFirst({
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
      }),
      needsBrowser ? readBrowserTaskFacts(db, taskId) : null,
    ])
    const facts = standing ? candidateFactsSchema.safeParse(standing.facts) : null
    return {
      task: settled,
      requirements: { repository: needsRepository, browser: needsBrowser },
      browser,
      cancel,
      policyFlagged: flagged > 0,
      productionWrites: writes,
      standing:
        standing && facts?.success
          ? {
              id: standing.id,
              revision: standing.revision,
              baseSha: standing.baseSha,
              headSha: standing.headSha,
              dbPlanSha256: standing.dbPlanSha256,
              facts: facts.data,
            }
          : null,
    }
  }
}
