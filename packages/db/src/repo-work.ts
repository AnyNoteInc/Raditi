import {
  REPO_PROPOSALS_PER_TURN,
  repoChatBranch,
  repoProposalLimit,
  repoProposalPayloadSchema,
  type RepoBranchState,
  type RepoProposalPayload,
} from '@repo/domain'

import type { Prisma, PrismaClient } from './generated/prisma/client.ts'
import { uuidv7 } from './uuidv7.ts'

// The work of a chat in the repository of its project (docs/plan/84-projects.md, ПР13, ПР14, ПР25,
// §4.1; slice 84.19): where its branch stands, its branch row with a name of its own, and the
// proposals of a merge request the agent reserves in a turn. Nothing here sends anything to the
// client's repository: that is `git.action` of core, after a button of the client.

type Tx = Prisma.TransactionClient

/** Tries of a free name before the chat gives up its card (`-2` … `-20`). */
const BRANCH_NAME_TRIES = 20

/**
 * The head of the chat's branch in the mirror as the client left it (ПР25): the commit of its last
 * completed turn that was neither refused nor taken back by `/undo` and left a change. `/undo` and
 * `/redo` only mark the turn: the ref of the mirror follows this when core next touches it. null —
 * no change of the chat stands.
 */
export async function chatBranchHead(
  db: Pick<Tx, 'taskTurn'>,
  taskId: string,
): Promise<{ turnNo: number; headSha: string; baseSha: string | null } | null> {
  const turn = await db.taskTurn.findFirst({
    where: {
      taskId,
      status: 'completed',
      rejectedAt: null,
      undoneAt: null,
      headSha: { not: null },
    },
    orderBy: { turnNo: 'desc' },
    select: { turnNo: true, headSha: true, baseSha: true },
  })
  if (!turn?.headSha || !/^[0-9a-f]{40}$/.test(turn.headSha)) return null
  return { turnNo: turn.turnNo, headSha: turn.headSha, baseSha: turn.baseSha }
}

export interface ChatBranchRow {
  taskId: string
  projectRepositoryId: string
  branch: string
  baseSha: string
  mirrorSha: string | null
  remoteSha: string | null
  state: RepoBranchState
}

const branchSelect = {
  taskId: true,
  projectRepositoryId: true,
  branch: true,
  baseSha: true,
  mirrorSha: true,
  remoteSha: true,
  state: true,
} as const

export async function chatBranch(
  db: Pick<Tx, 'projectRepoBranch'>,
  taskId: string,
): Promise<ChatBranchRow | null> {
  const row = await db.projectRepoBranch.findUnique({ where: { taskId }, select: branchSelect })
  return row === null ? null : { ...row, state: row.state as RepoBranchState }
}

/**
 * The branch row of a chat, made with its first card (ПР13): `raditi/<word>-<last 8 of the chat
 * id>`, and the next free suffix when another chat of the repository holds that name. `branch` —
 * the name the turn worked under, which its checkpoint keeps: it is taken first, so a chat the
 * agent renamed at the end of that turn keeps the branch of its checkpoint. A row of another
 * repository (the chat moved, or the repository was attached again) is made anew.
 */
export async function ensureChatBranch(
  db: Pick<Tx, '$queryRaw' | 'projectRepoBranch'>,
  input: {
    taskId: string
    projectRepositoryId: string
    title: string | null
    baseSha: string
    branch?: string
  },
): Promise<ChatBranchRow> {
  const existing = await chatBranch(db, input.taskId)
  if (existing?.projectRepositoryId === input.projectRepositoryId) return existing
  if (existing) await db.projectRepoBranch.delete({ where: { taskId: input.taskId } })
  for (let attempt = 1; attempt <= BRANCH_NAME_TRIES; attempt++) {
    const branch =
      attempt === 1 && input.branch !== undefined
        ? input.branch
        : repoChatBranch(input.taskId, input.title, attempt)
    const made = await db.$queryRaw<{ task_id: string }[]>`
      INSERT INTO project_repo_branches
        (task_id, project_repository_id, branch, base_sha, state, updated_at)
      VALUES (${input.taskId}::uuid, ${input.projectRepositoryId}::uuid, ${branch},
        ${input.baseSha}, 'local', now())
      ON CONFLICT DO NOTHING
      RETURNING task_id`
    if (made.length) return (await chatBranch(db, input.taskId))!
    // The chat's own row came meanwhile (a second end of the same turn): that one stands.
    const raced = await chatBranch(db, input.taskId)
    if (raced) return raced
  }
  throw new Error('No free name of a branch for the chat')
}

/** The chat has worked with the repository of its project (ПР2): it is not moved. */
export async function chatHasRepoBranch(
  db: Pick<Tx, 'projectRepoBranch'>,
  taskId: string,
): Promise<boolean> {
  return (await db.projectRepoBranch.count({ where: { taskId } })) > 0
}

// --- the proposals of the agent (ПР14) -------------------------------------------------------

/** `repo_request_merge`: one proposal a turn; core shows it when the pass completed. */
export async function reserveRepoProposal(
  db: Pick<PrismaClient, '$transaction'>,
  input: { workspaceId: string; taskId: string; turnNo: number; proposal: RepoProposalPayload },
): Promise<{ reservationId: string }> {
  const payload = repoProposalPayloadSchema.parse(input.proposal)
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`repo-turn:${input.taskId}:${input.turnNo}`}, 0))`
    const open = await tx.repoReservation.count({
      where: { taskId: input.taskId, turnNo: input.turnNo, outcome: null },
    })
    if (open >= REPO_PROPOSALS_PER_TURN) throw repoProposalLimit()
    const row = await tx.repoReservation.create({
      data: {
        id: uuidv7(),
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        turnNo: input.turnNo,
        kind: 'request_merge',
        payload,
      },
      select: { id: true },
    })
    return { reservationId: row.id }
  })
}

export interface PendingRepoProposal {
  id: string
  payload: unknown
}

export async function pendingRepoProposals(
  db: Pick<PrismaClient, 'repoReservation'>,
  taskId: string,
  turnNo: number,
): Promise<PendingRepoProposal[]> {
  return db.repoReservation.findMany({
    where: { taskId, turnNo, outcome: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, payload: true },
  })
}

/** Closes an open proposal; false — it was closed already. */
export async function closeRepoProposal(
  db: Pick<Tx, 'repoReservation'>,
  id: string,
  outcome: 'done' | 'refused' | 'failed',
  reason: string,
): Promise<boolean> {
  const closed = await db.repoReservation.updateMany({
    where: { id, outcome: null },
    data: { outcome, reason: reason.slice(0, 24), closedAt: new Date() },
  })
  return closed.count > 0
}

/** The proposals of a failed or cancelled pass, closed at once (§4.3, step 9). The count. */
export async function failRepoTurn(
  db: Pick<PrismaClient, 'repoReservation'>,
  taskId: string,
  turnNo: number,
): Promise<number> {
  const closed = await db.repoReservation.updateMany({
    where: { taskId, turnNo, outcome: null },
    data: { outcome: 'failed', reason: 'failed', closedAt: new Date() },
  })
  return closed.count
}

/**
 * The proposals of passes that never ended — lost with their turn — older than `before`, of a
 * task with no turn assigned now (ревью C11): closed failed, never shown. The count.
 */
export async function closeStaleRepoProposals(
  db: Pick<PrismaClient, 'repoReservation'>,
  before: Date,
): Promise<number> {
  const closed = await db.repoReservation.updateMany({
    where: {
      outcome: null,
      createdAt: { lt: before },
      task: { turnAssignments: { none: { finishedAt: null } } },
    },
    data: { outcome: 'failed', reason: 'failed', closedAt: new Date() },
  })
  return closed.count
}

// --- what a push would send (ПР13, ПР26) -------------------------------------------------------

/** One card «Изменения в ветке» of a turn still standing. */
export interface BranchCard {
  turnNo: number
  headSha: string
  diffSha256: string
  files: number
  additions: number
  deletions: number
  list: { path: string; additions: number; deletions: number }[]
  ciTouched: boolean
}

/**
 * What «Отправить в ветку» of a chat sends: its head (chatBranchHead), the cards of the turns since
 * the last push that still stand, and whether the head goes back past what was sent (`/undo`).
 * null — nothing to send: no change stands, or the branch at the client has the head already.
 * Web shows it and binds the token to it; core reads it again before it pushes.
 */
export interface UnsentBranch {
  head: { turnNo: number; headSha: string }
  /** The card of the head: the diff the client is shown and the token names; null — `/undo`. */
  card: BranchCard | null
  cards: BranchCard[]
  files: number
  additions: number
  deletions: number
  ciTouched: boolean
}

export async function unsentBranch(
  db: Pick<Tx, 'taskTurn' | 'taskEvent' | 'projectRepoBranch'>,
  taskId: string,
): Promise<UnsentBranch | null> {
  const head = await chatBranchHead(db, taskId)
  if (head === null) return null
  const branch = await chatBranch(db, taskId)
  if (branch?.mirrorSha === head.headSha) return null
  const turns = await db.taskTurn.findMany({
    where: {
      taskId,
      status: 'completed',
      rejectedAt: null,
      undoneAt: null,
      headSha: { not: null },
    },
    select: { id: true, turnNo: true, headSha: true },
  })
  const sentTurn =
    branch?.mirrorSha == null
      ? 0
      : (turns.find((turn) => turn.headSha === branch.mirrorSha)?.turnNo ?? 0)
  const standing = new Map(
    turns.filter((turn) => turn.turnNo > sentTurn).map((turn) => [turn.id, turn]),
  )
  const events = await db.taskEvent.findMany({
    where: { taskId, type: 'feed.repo_changes', turnId: { in: [...standing.keys()] } },
    orderBy: { id: 'asc' },
    select: { turnId: true, payload: true },
  })
  const cards: BranchCard[] = []
  for (const event of events) {
    const turn = event.turnId ? standing.get(event.turnId) : undefined
    const payload = event.payload as Record<string, unknown> | null
    if (!turn || !payload || payload.headSha !== turn.headSha) continue
    cards.push({
      turnNo: turn.turnNo,
      headSha: turn.headSha!,
      diffSha256: String(payload.diffSha256),
      files: Number(payload.files) || 0,
      additions: Number(payload.additions) || 0,
      deletions: Number(payload.deletions) || 0,
      list: Array.isArray(payload.list) ? (payload.list as BranchCard['list']).slice(0, 50) : [],
      ciTouched: payload.ciTouched === true,
    })
  }
  cards.sort((a, b) => a.turnNo - b.turnNo)
  return {
    head: { turnNo: head.turnNo, headSha: head.headSha },
    card: cards.find((card) => card.headSha === head.headSha) ?? null,
    cards,
    files: cards.reduce((sum, card) => sum + card.files, 0),
    additions: cards.reduce((sum, card) => sum + card.additions, 0),
    deletions: cards.reduce((sum, card) => sum + card.deletions, 0),
    ciTouched: cards.some((card) => card.ciTouched),
  }
}

/**
 * The next free name of the chat's branch after `after` (ПР13: «при совпадении имени — суффикс»):
 * the name is taken at the client by a branch the platform did not make.
 */
export async function repoChatBranchName(
  db: Pick<PrismaClient, '$queryRaw' | 'projectRepoBranch'>,
  input: { taskId: string; title: string | null; after: string },
): Promise<ChatBranchRow> {
  const at = /-(\d+)$/.exec(input.after.slice(input.after.lastIndexOf('/')))
  const current =
    repoChatBranch(input.taskId, input.title, 1) === input.after ? 1 : Number(at?.[1] ?? 1)
  for (let attempt = current + 1; attempt <= BRANCH_NAME_TRIES; attempt++) {
    const branch = repoChatBranch(input.taskId, input.title, attempt)
    const moved = await db.$queryRaw<{ task_id: string }[]>`
      UPDATE project_repo_branches b SET branch = ${branch}, updated_at = now()
      WHERE b.task_id = ${input.taskId}::uuid AND b.branch = ${input.after}
        AND NOT EXISTS (SELECT 1 FROM project_repo_branches o
          WHERE o.project_repository_id = b.project_repository_id AND o.branch = ${branch})
      RETURNING b.task_id`
    if (moved.length) return (await chatBranch(db, input.taskId))!
  }
  throw new Error('No free name of a branch for the chat')
}
