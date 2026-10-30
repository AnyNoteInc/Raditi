import type { MemberRole, Prisma } from '@repo/db'
import {
  candidateFactsSchema,
  chatCommandAvailability,
  isTerminalReleaseStatus,
  releaseOutcomeOf,
  retryCommandRefusal,
  terminalReleaseStatuses,
  undoDeadline,
  undoExpired,
  type CandidateCheckStatus,
  type ChatCommandAvailability,
  type ChatCommandFacts,
  type ChatCommandId,
  type ChatCommandRefusal,
  type PreviewStatus,
  type ReleaseOutcome,
  type ReleaseStatus,
  type TaskStatus,
} from '@repo/domain'

import { memberRole } from './access.ts'
import { dialogRetry } from './dialog-state.ts'
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
  task: { id: string; workspaceId: string; siteId: string; status: TaskStatus },
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
  // A task without the repository works in the browser of the site (docs/plan/57, Б1): it has no
  // candidate, no preview, no release and no «Попробовать ещё» (Б25), whatever rows say — only
  // `/cancel` is ever offered.
  const withRepository =
    (
      await db.task.findUnique({
        where: { id: task.id },
        select: { needsRepository: true },
      })
    )?.needsRepository ?? true

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
    },
  }
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
  task: { id: string; siteId: string },
  now: Date,
): Promise<{ dialog: DialogUndo; command: ChatCommandFacts['undo'] } | null> {
  const installed = await db.siteRelease.findFirst({
    where: { taskId: task.id, kind: 'release', status: 'installed' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, version: true },
  })
  if (installed === null) return null
  const site = await db.site.findUniqueOrThrow({
    where: { id: task.siteId },
    select: { status: true, installedReleaseId: true, installedAt: true },
  })
  const lease = await db.siteLease.findUnique({
    where: { siteId: task.siteId },
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
      where: { siteId: task.siteId, status: { notIn: [...terminalReleaseStatuses] } },
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
  command: ChatCommandId,
): ChatCommandRefusal | null {
  return chatCommandAvailability(facts).find((item) => item.id === command)?.refusal ?? null
}

/** Throws the refusal of the command, the text `task.commands` shows for it. */
export function assertCommandAvailable(facts: ChatCommandFacts, command: ChatCommandId): void {
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
