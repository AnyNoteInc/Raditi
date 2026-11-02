import {
  openBrowserSessionOfTask,
  taskHasProductionWrites,
  type MemberRole,
  type Prisma,
} from '@repo/db'
import {
  candidateFactsSchema,
  chatCommandAvailability,
  isTerminalReleaseStatus,
  releaseOutcomeOf,
  retryCommandRefusal,
  siteIdOf,
  terminalReleaseStatuses,
  undoDeadline,
  undoExpired,
  type CandidateCheckStatus,
  type ChatCommandAvailability,
  type ChatCommandFacts,
  type ChatCommandRefusal,
  type OfferedCommandId,
  type PreviewStatus,
  type ReleaseOutcome,
  type ReleaseStatus,
  type TaskStatus,
  type TurnRedoRefusal,
  type TurnUndoRefusal,
} from '@repo/domain'

import { siteClosed } from '../site-capabilities.ts'
import { memberRole } from './access.ts'
import {
  cancelPending,
  dialogRetry,
  movingRequest,
  openCeilingQuestion,
  turnRewinding,
} from './dialog-state.ts'
import { commandUnavailable } from './refusals.ts'

type Reader = Pick<
  Prisma.TransactionClient,
  | 'member'
  | 'task'
  | 'taskEvent'
  | 'taskCandidate'
  | 'candidateCheck'
  | 'previewEnvironment'
  | 'siteRelease'
  | 'site'
  | 'siteLease'
  | 'browserSession'
  | 'taskTurn'
  | '$queryRaw'
>

/** The preview of a dialog as its facts and its panel read it. */
export interface DialogPreview {
  id: string
  status: PreviewStatus
  unavailableReason: string | null
  hostname: string
  revision: number
  dirty: boolean
}

/** The candidate a dialog waits with, with the counts of its checks by status. */
export interface DialogCandidate {
  id: string
  revision: number
  status: 'current' | 'stale'
  baseSha: string
  proposedVersion: string
  proposedBump: string
  facts: unknown
  checks: Record<CandidateCheckStatus, number>
}

/** The latest release of the dialog. */
export interface DialogRelease {
  id: string
  status: ReleaseStatus
  step: string | null
  version: string
  /** null while it goes on. */
  outcome: ReleaseOutcome | null
}

/**
 * «Отменить выпуск» of the dialog (docs/plan/53, «Отмена выпуска»): its latest installed release,
 * and the latest undo of it.
 */
export interface DialogUndo {
  /** The release of the dialog whose undo the command is about. */
  releaseId: string
  version: string
  /** The site runs it now. */
  installedNow: boolean
  /** The last moment its undo may be confirmed; null — the site does not run it. */
  until: Date | null
  /** The latest undo of it; null — none. */
  run: DialogRelease | null
}

export interface DialogFacts {
  role: MemberRole | null
  preview: DialogPreview | null
  candidate: DialogCandidate | null
  /** The latest release of a candidate of the dialog; an undo of it is `undo.run`. */
  release: DialogRelease | null
  undo: DialogUndo | null
  /** What `chatCommandAvailability` decides by. */
  commands: ChatCommandFacts
}

const noChecks = (): Record<CandidateCheckStatus, number> => ({
  pending: 0,
  passed: 0,
  failed: 0,
  stale: 0,
})

/**
 * What the server decides the commands of a dialog by (Р34): the reader's role, the candidate
 * the dialog waits with, its preview and its latest release, read with the caller's client —
 * the snapshot of `task.feed` or the transaction of a command.
 *
 * Web has no git: a `current` candidate is taken to stand on the tree of `main`, a `stale` one
 * not — a release that installed after the candidate was made marks it `stale` (Р15). core
 * compares the trees under the lease of the release and refuses an outdated one (Р27).
 */
export async function dialogFacts(
  db: Reader,
  task: { id: string; workspaceId: string; siteId: string | null; status: TaskStatus },
  userId: string,
  now: Date = new Date(),
): Promise<DialogFacts> {
  // One query at a time: the client may be an interactive transaction.
  const role = await memberRole(db, task.workspaceId, userId)
  const previewRow = await db.previewEnvironment.findUnique({
    where: { taskId: task.id },
    select: {
      id: true,
      status: true,
      unavailableReason: true,
      hostname: true,
      revision: true,
      dirty: true,
    },
  })
  const candidateRow = await db.taskCandidate.findFirst({
    where: { taskId: task.id, status: { in: ['current', 'stale'] } },
    orderBy: { revision: 'desc' },
    select: {
      id: true,
      revision: true,
      status: true,
      baseSha: true,
      proposedVersion: true,
      proposedBump: true,
      facts: true,
    },
  })
  const releaseRow = await db.siteRelease.findFirst({
    where: { taskId: task.id, kind: 'release' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, status: true, step: true, version: true, mainPushedAt: true },
  })
  const undo = await undoFacts(db, task, now)
  const retry = await dialogRetry(db, task)
  const needs = await db.task.findUnique({
    where: { id: task.id },
    select: { needsRepository: true, needsBrowser: true, turnNo: true },
  })
  // A task without the repository has no candidate, no preview, no release and no «Попробовать
  // ещё» (docs/plan/57, Б1, Б25), whatever rows say: the page does not list those (К27).
  const withRepository = needs?.needsRepository ?? true
  const withBrowser = needs?.needsBrowser ?? false
  const pending = withRepository ? await turnRewinding(db, task.id) : null
  const site =
    task.siteId === null
      ? null
      : await db.site.findUnique({ where: { id: task.siteId }, select: { status: true } })

  let candidate: DialogCandidate | null = null
  if (candidateRow !== null) {
    const checks = noChecks()
    const counted = await db.candidateCheck.groupBy({
      by: ['status'],
      where: { candidateId: candidateRow.id },
      _count: { _all: true },
    })
    for (const row of counted) checks[row.status] = row._count._all
    candidate = {
      ...candidateRow,
      status: candidateRow.status as DialogCandidate['status'],
      checks,
    }
  }
  const release = releaseRow === null ? null : dialogRelease(releaseRow)

  return {
    role,
    preview: previewRow,
    candidate,
    release,
    undo: undo?.dialog ?? null,
    commands: {
      taskStatus: task.status,
      repository: withRepository,
      role: role ?? 'member',
      candidate:
        candidate === null || !withRepository
          ? null
          : {
              status: candidate.status,
              baseIsMain: candidate.status === 'current',
              checksFailed: candidate.checks.failed > 0,
            },
      preview: previewRow === null || !withRepository ? null : { status: previewRow.status },
      releaseInProgress: release !== null && !isTerminalReleaseStatus(release.status),
      undo: withRepository ? (undo?.command ?? null) : null,
      retry: withRepository ? retryCommandRefusal(retry) : 'nothing_to_retry',
      cancelPending: withBrowser && (await cancelPending(db, task.id)),
      browserWrote:
        withBrowser &&
        (await db.browserSession.count({
          where: { taskId: task.id, wroteAt: { not: null } },
        })) > 0,
      projectClosed: site !== null && siteClosed(site.status),
      turnUndo: await turnUndoRefusal(db, {
        taskId: task.id,
        status: task.status,
        turnNo: needs?.turnNo ?? 0,
      }),
      turnRewinding: pending !== null && !pending.redo,
      turnRedo: await turnRedoRefusal(db, {
        taskId: task.id,
        status: task.status,
        turnNo: needs?.turnNo ?? 0,
      }),
      turnRedoing: pending?.redo === true,
    },
  }
}

/**
 * Why `/undo` takes no turn of this chat (docs/plan/61-chats-first.md, §5.14): it takes the last
 * turn, one that completed with its result taken, once, while the chat waits for its next words. A
 * question of the platform about credits holds a pass that has not run, and a request of the agent
 * to act in the browser stands in the live session until the next turn takes it (`reclaim`), with
 * a button that would resume nothing: both are answered first. Words the last turn never saw — their
 * pass failed before it opened a turn — are the last request, and that has no turn to take back:
 * the turn before them would go instead. A write of the turn on the site itself cannot go back with
 * the conversation; the browser belongs to the task, and its row says what stays. A chat with the
 * repository may wait with a candidate too, and its turn goes back with its files; once «Обновить»
 * moved the candidate past the turn, the turn stands on a version of the site that is gone.
 */
async function turnUndoRefusal(
  db: Reader,
  chat: { taskId: string; status: TaskStatus; turnNo: number },
): Promise<TurnUndoRefusal | null> {
  if (chat.status !== 'awaiting_user' && chat.status !== 'awaiting_approval')
    return 'nothing_to_undo'
  const turn = await db.taskTurn.findUnique({
    where: { taskId_turnNo: { taskId: chat.taskId, turnNo: chat.turnNo } },
    select: { status: true, rejectedAt: true, undoneAt: true, startedAt: true, headSha: true },
  })
  if (turn?.status !== 'completed' || turn.rejectedAt !== null || turn.undoneAt !== null)
    return 'nothing_to_undo'
  if ((await openCeilingQuestion(db, chat.taskId)) !== null) return 'awaiting_answer'
  const session = await openBrowserSessionOfTask(db, chat.taskId)
  if (session?.helpReason) return 'awaiting_answer'
  if (turn.startedAt !== null) {
    const later = await db.taskEvent.count({
      where: { taskId: chat.taskId, ...movingRequest, createdAt: { gt: turn.startedAt } },
    })
    if (later > 0) return 'nothing_to_undo'
  }
  const latest = await db.taskCandidate.findFirst({
    where: { taskId: chat.taskId },
    orderBy: { revision: 'desc' },
    select: { turnNo: true, headSha: true },
  })
  if (latest?.turnNo === chat.turnNo && latest.headSha !== turn.headSha) return 'undo_past_update'
  const wrote = await taskHasProductionWrites(db, chat.taskId, { turnNo: chat.turnNo })
  return wrote ? 'content_written' : null
}

/**
 * Why `/redo` brings nothing back (docs/plan/61-chats-first.md, §5.14): it brings back the turn the
 * last `/undo` took, while the chat still stands where that left it. Words, a pass, a command that
 * moves the chat, a new revision or a confirmed release after the `feed.rewind` — each put something
 * on top of the turn before, and «Обновить» is pressed as a plain command (`movingRequest` does not
 * count it) while it writes the candidate onto a new `main`, under the same turn number: the branch
 * cannot go back past it. The revision of the undo itself is written before the `feed.rewind`.
 */
async function turnRedoRefusal(
  db: Reader,
  chat: { taskId: string; status: TaskStatus; turnNo: number },
): Promise<TurnRedoRefusal | null> {
  if (chat.status !== 'awaiting_user' && chat.status !== 'awaiting_approval')
    return 'nothing_to_redo'
  const turn = await db.taskTurn.findUnique({
    where: { taskId_turnNo: { taskId: chat.taskId, turnNo: chat.turnNo } },
    select: { undoneAt: true },
  })
  if (!turn?.undoneAt) return 'nothing_to_redo'
  const rewind = await db.taskEvent.findFirst({
    where: { taskId: chat.taskId, type: 'feed.rewind' },
    orderBy: { id: 'desc' },
    select: { id: true },
  })
  if (rewind === null) return 'nothing_to_redo'
  const after = await db.taskEvent.count({
    where: {
      taskId: chat.taskId,
      id: { gt: rewind.id },
      OR: [
        movingRequest,
        {
          type: 'feed.request',
          AND: [
            { payload: { path: ['kind'], equals: 'command' } },
            { payload: { path: ['command'], equals: 'update' } },
          ],
        },
        { type: { in: ['feed.candidate', 'feed.decision', 'feed.release'] } },
      ],
    },
  })
  return after > 0 ? 'nothing_to_redo' : null
}

const dialogRelease = (row: {
  id: string
  status: ReleaseStatus
  step: string | null
  version: string
  mainPushedAt: Date | null
}): DialogRelease => ({
  id: row.id,
  status: row.status,
  step: row.step,
  version: row.version,
  outcome: releaseOutcomeOf(row.status, { mainMoved: row.mainPushedAt !== null }),
})

/**
 * What «Отменить выпуск» is decided by: the latest installed release of the dialog, whether the
 * site runs it and since when, whether it was undone, and the site around it — any release or
 * undo under way, the operator's hold, the connection. null — the dialog installed nothing.
 */
async function undoFacts(
  db: Reader,
  task: { id: string; siteId: string | null },
  now: Date,
): Promise<{ dialog: DialogUndo; command: ChatCommandFacts['undo'] } | null> {
  const installed = await db.siteRelease.findFirst({
    where: { taskId: task.id, kind: 'release', status: 'installed' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, version: true },
  })
  if (installed === null) return null
  // Read on every read of a feed: only past `installed` is the site proven (a release has one).
  const siteId = siteIdOf(task)
  const site = await db.site.findUniqueOrThrow({
    where: { id: siteId },
    select: { status: true, installedReleaseId: true, installedAt: true },
  })
  const lease = await db.siteLease.findUnique({
    where: { siteId },
    select: { heldForOperator: true },
  })
  const runRow = await db.siteRelease.findFirst({
    where: { undoesReleaseId: installed.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, status: true, step: true, version: true, mainPushedAt: true },
  })
  const undone =
    (await db.siteRelease.count({
      where: { undoesReleaseId: installed.id, status: 'installed' },
    })) > 0
  const releasing =
    (await db.siteRelease.count({
      where: { siteId, status: { notIn: [...terminalReleaseStatuses] } },
    })) > 0
  const installedNow = site.installedReleaseId === installed.id
  const installedAt = installedNow ? site.installedAt : null
  return {
    dialog: {
      releaseId: installed.id,
      version: installed.version,
      installedNow,
      until: installedAt === null ? null : undoDeadline(installedAt),
      run: runRow === null ? null : dialogRelease(runRow),
    },
    command: {
      installedNow,
      undone,
      expired: installedAt === null || undoExpired(installedAt, now),
      siteReleasing: releasing,
      siteHeld: lease?.heldForOperator === true,
      siteActive: site.status === 'active',
    },
  }
}

/** The verdict of one command. */
export function commandRefusal(
  facts: ChatCommandFacts,
  command: OfferedCommandId,
): ChatCommandRefusal | null {
  return chatCommandAvailability(facts).find((item) => item.id === command)?.refusal ?? null
}

/** Throws the refusal of the command, the text `task.commands` shows for it. */
export function assertCommandAvailable(facts: ChatCommandFacts, command: OfferedCommandId): void {
  const refusal = commandRefusal(facts, command)
  if (refusal !== null) throw commandUnavailable(command, refusal)
}

/** Every command of the dialog with its verdict. */
export const dialogCommands = (facts: DialogFacts): ChatCommandAvailability[] =>
  chatCommandAvailability(facts.commands)

/** The counts of a candidate the platform computed itself; null — its facts are unreadable. */
export function candidateCountsOf(facts: unknown): {
  files: { added: number; modified: number; deleted: number }
  media: number
  records: number
} | null {
  const parsed = candidateFactsSchema.safeParse(facts)
  if (!parsed.success) return null
  const value = parsed.data
  return {
    files: { added: value.addedFiles, modified: value.modifiedFiles, deleted: value.deletedFiles },
    media: value.mediaFiles,
    records: value.dbObjects,
  }
}
