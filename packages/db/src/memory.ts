import {
  memoryChangeMode,
  memoryChangesLimit,
  memoryEntryNotFound,
  memoryFull,
  memoryLimits,
  memoryReservationPayloadSchema,
  memoryTextOf,
  memoryVersionChanged,
  savedMemoryStatus,
  updatedMemoryStatus,
  type MemoryAuthor,
  type MemoryChangeAction,
  type MemoryChangeKind,
  type MemoryChangeRequest,
  type MemoryKind,
  type MemoryLeftReason,
  type MemoryPassConditions,
  type MemoryPendingAction,
  type MemorySectionEntry,
  type MemoryStatus,
} from '@repo/domain'

import type { Prisma, PrismaClient } from './generated/prisma/client.ts'
import { uuidv7 } from './uuidv7.ts'

// The memory of an account and of its projects (docs/plan/84-projects.md, ПР18, §4.1, §4.3; slice
// 84.11). The agent reserves a change in its turn (`memory_save`, `memory_update`, `memory_forget`
// of the mcp app); core applies it when the pass completed — under a lock of the entry, at the
// version the agent read, so two changes of one entry never both pass — or closes it refused or
// failed. Whether a note of the agent is active at once or «Предложено» is the domain's rule over
// what core knows of the pass (MemoryPassConditions).

type Tx = Prisma.TransactionClient
type Db = Pick<PrismaClient, '$transaction'>

/** A memory: of a project, or — projectId null — of the account of a user in a workspace. */
export interface MemoryScope {
  workspaceId: string
  userId: string
  projectId: string | null
}

/** The memory of a chat now: its author's, of its project or of the account; null — off. */
export interface ChatMemory extends MemoryScope {
  /** A chat of a project reads the account's notes too («Использовать память аккаунта»). */
  accountMemory: boolean
}

/**
 * The memory a chat reads and writes (ПР18): null when the chat has no author, the author turned
 * «Агент запоминает важное» off, or the project of the chat is in the trash.
 */
export async function chatMemory(
  db: Pick<PrismaClient, 'task'>,
  taskId: string,
): Promise<ChatMemory | null> {
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      workspaceId: true,
      projectId: true,
      createdBy: { select: { id: true, agentMemory: true } },
      project: { select: { deletedAt: true, useAccountMemory: true } },
    },
  })
  if (!task?.createdBy?.agentMemory) return null
  if (task.project && task.project.deletedAt !== null) return null
  return {
    workspaceId: task.workspaceId,
    userId: task.createdBy.id,
    projectId: task.projectId,
    accountMemory: task.project ? task.project.useAccountMemory : true,
  }
}

const scopeWhere = (scope: MemoryScope) => ({
  workspaceId: scope.workspaceId,
  userId: scope.userId,
  projectId: scope.projectId,
})

/** The memories a chat reads: its own, and the account's when its project lets it. */
const readWhere = (memory: ChatMemory) =>
  memory.projectId !== null && memory.accountMemory
    ? {
        workspaceId: memory.workspaceId,
        userId: memory.userId,
        OR: [{ projectId: memory.projectId }, { projectId: null }],
      }
    : scopeWhere(memory)

/** The active notes a pass carries in its section (memorySection): newest first, at most 40. */
export async function memoryEntriesOfPass(
  db: Pick<PrismaClient, 'memoryEntry'>,
  memory: ChatMemory,
): Promise<MemorySectionEntry[]> {
  const rows = await db.memoryEntry.findMany({
    where: { ...readWhere(memory), status: 'active' },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: memoryLimits.sectionEntries,
    select: { id: true, kind: true, text: true, updatedAt: true },
  })
  return rows.map((row) => ({ ...row, kind: row.kind as MemoryKind }))
}

/** An entry as the agent lists it (`memory_list`). */
export interface ListedMemoryEntry {
  id: string
  kind: MemoryKind
  text: string
  status: MemoryStatus
  author: MemoryAuthor
  version: number
  /** null — a note of the account, read by a chat of a project. */
  projectId: string | null
  pendingAction: MemoryPendingAction | null
  updatedAt: Date
}

/** Every entry a chat reads, active and proposed, newest first. */
export async function listChatMemory(
  db: Pick<PrismaClient, 'memoryEntry'>,
  memory: ChatMemory,
): Promise<ListedMemoryEntry[]> {
  const rows = await db.memoryEntry.findMany({
    where: readWhere(memory),
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: memoryLimits.entries * 2,
    select: {
      id: true,
      kind: true,
      text: true,
      status: true,
      author: true,
      version: true,
      projectId: true,
      pendingAction: true,
      updatedAt: true,
    },
  })
  return rows.map((row) => ({
    ...row,
    kind: row.kind as MemoryKind,
    status: row.status as MemoryStatus,
    author: row.author as MemoryAuthor,
    pendingAction: row.pendingAction as MemoryPendingAction | null,
  }))
}

/** One lock a memory: saves into it are counted against its 40 entries one at a time. */
const lockMemory = (tx: Tx, scope: MemoryScope) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`memory:${scope.workspaceId}:${scope.userId}:${scope.projectId ?? 'account'}`}, 0))`

/** The entry of a memory, locked for its change; null — not of this memory. */
async function lockedEntry(tx: Tx, scope: MemoryScope, entryId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM memory_entries
    WHERE id = ${entryId}::uuid AND workspace_id = ${scope.workspaceId}::uuid
      AND user_id = ${scope.userId}::uuid
      AND project_id IS NOT DISTINCT FROM ${scope.projectId}::uuid
    FOR UPDATE`
  if (rows.length === 0) return null
  return tx.memoryEntry.findUniqueOrThrow({
    where: { id: entryId },
    select: {
      id: true,
      kind: true,
      text: true,
      status: true,
      author: true,
      version: true,
      confirmedAt: true,
    },
  })
}

/**
 * A change the agent asks of the memory of its chat in a turn (§4.4): checked now — the text, the
 * room of the memory, the entry and the version the agent read, at most 10 a turn — and kept for
 * core to apply when the pass completed. The memory is the chat's own; never the arguments'.
 */
export async function reserveMemoryChange(
  db: Db,
  input: { taskId: string; turnNo: number; scope: MemoryScope; change: MemoryChangeRequest },
): Promise<{ reservationId: string }> {
  const { taskId, turnNo, scope, change } = input
  const text = change.kind === 'forget' ? undefined : memoryTextOf(change.text)
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`memory-turn:${taskId}:${turnNo}`}, 0))`
    const open = await tx.memoryReservation.count({ where: { taskId, turnNo, outcome: null } })
    if (open >= memoryLimits.changesPerTurn) throw memoryChangesLimit()
    if (change.kind === 'save') {
      const entries = await tx.memoryEntry.count({ where: scopeWhere(scope) })
      const saves = await tx.memoryReservation.count({
        where: { taskId, turnNo, outcome: null, kind: 'save' },
      })
      if (entries + saves >= memoryLimits.entries) throw memoryFull()
    } else {
      const entry = await tx.memoryEntry.findFirst({
        where: { id: change.entryId, ...scopeWhere(scope) },
        select: { version: true },
      })
      if (!entry) throw memoryEntryNotFound()
      if (entry.version !== change.expectedVersion) throw memoryVersionChanged()
    }
    const payload = memoryReservationPayloadSchema.parse({
      projectId: scope.projectId,
      ...(change.kind === 'save' ? { kind: change.entryKind } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(change.kind !== 'save' ? { expectedVersion: change.expectedVersion } : {}),
    })
    const reservation = await tx.memoryReservation.create({
      data: {
        id: uuidv7(),
        workspaceId: scope.workspaceId,
        taskId,
        turnNo,
        kind: change.kind,
        entryId: change.kind === 'save' ? null : change.entryId,
        payload,
      },
      select: { id: true },
    })
    return { reservationId: reservation.id }
  })
}

/** An open change of a turn, in the order the agent asked them. */
export interface PendingMemoryChange {
  id: string
  kind: MemoryChangeKind
  entryId: string | null
  payload: unknown
}

export async function pendingMemoryChanges(
  db: Pick<PrismaClient, 'memoryReservation'>,
  taskId: string,
  turnNo: number,
): Promise<PendingMemoryChange[]> {
  const rows = await db.memoryReservation.findMany({
    where: { taskId, turnNo, outcome: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, kind: true, entryId: true, payload: true },
  })
  return rows.map((row) => ({ ...row, kind: row.kind as MemoryChangeKind }))
}

/** What the end of a pass did with a change. null — it was closed already. */
export type AppliedMemoryChange =
  | {
      outcome: 'done'
      action: MemoryChangeAction
      entryId: string
      kind: MemoryKind
      /** What the client reads: the new text, or the text of the entry it forgets. */
      text: string
    }
  | { outcome: 'refused'; action: MemoryChangeKind; reason: MemoryLeftReason }

async function close(
  tx: Tx,
  reservationId: string,
  outcome: 'done' | 'refused' | 'failed',
  reason: MemoryLeftReason | null,
  entryId?: string | null,
) {
  await tx.memoryReservation.update({
    where: { id: reservationId },
    data: {
      outcome,
      reason,
      closedAt: new Date(),
      ...(entryId !== undefined ? { entryId } : {}),
    },
  })
}

/**
 * Applies a change the agent reserved, in one transaction: the memory of the chat now (`memory`;
 * another project than the one it was asked in — refused `not_found`), a new note counted against
 * the 40 of its memory, a change of an entry at the version the agent read, under the lock of the
 * entry. Whether it is active at once, a proposal, or a direct change is the domain's rule over
 * the pass (ПР18). The caller checked the text against secrets and the values of the client.
 */
export async function applyMemoryChange(
  db: Db,
  input: {
    reservationId: string
    taskId: string
    turnNo: number
    memory: MemoryScope
    conditions: MemoryPassConditions
  },
): Promise<AppliedMemoryChange | null> {
  const { reservationId, memory, conditions } = input
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM memory_reservations
      WHERE id = ${reservationId}::uuid AND task_id = ${input.taskId}::uuid AND outcome IS NULL
      FOR UPDATE`
    if (locked.length === 0) return null
    const row = await tx.memoryReservation.findUniqueOrThrow({
      where: { id: reservationId },
      select: { kind: true, entryId: true, payload: true, workspaceId: true },
    })
    const action = row.kind as MemoryChangeKind
    const refuse = async (reason: MemoryLeftReason): Promise<AppliedMemoryChange> => {
      await close(tx, reservationId, 'refused', reason)
      return { outcome: 'refused', action, reason }
    }
    const payload = memoryReservationPayloadSchema.safeParse(row.payload)
    if (!payload.success || row.workspaceId !== memory.workspaceId) return refuse('failed')
    if (payload.data.projectId !== memory.projectId) return refuse('not_found')
    const text = payload.data.text

    if (action === 'save') {
      if (text === undefined || payload.data.kind === undefined) return refuse('failed')
      await lockMemory(tx, memory)
      if ((await tx.memoryEntry.count({ where: scopeWhere(memory) })) >= memoryLimits.entries)
        return refuse('limit')
      const status = savedMemoryStatus(text, conditions)
      const entry = await tx.memoryEntry.create({
        data: {
          id: uuidv7(),
          ...scopeWhere(memory),
          kind: payload.data.kind,
          text,
          status,
          author: 'agent',
          sourceTaskId: input.taskId,
          sourceTurn: input.turnNo,
        },
        select: { id: true },
      })
      await close(tx, reservationId, 'done', null, entry.id)
      return {
        outcome: 'done',
        action: status === 'active' ? 'saved' : 'proposed',
        entryId: entry.id,
        kind: payload.data.kind,
        text,
      }
    }

    if (!row.entryId) return refuse('not_found')
    const entry = await lockedEntry(tx, memory, row.entryId)
    if (!entry) return refuse('not_found')
    if (entry.version !== payload.data.expectedVersion) return refuse('version')
    const facts = {
      author: entry.author as MemoryAuthor,
      status: entry.status as MemoryStatus,
      confirmedAt: entry.confirmedAt,
    }
    const kind = entry.kind as MemoryKind
    const done = async (
      result: Omit<
        Extract<AppliedMemoryChange, { outcome: 'done' }>,
        'outcome' | 'entryId' | 'kind'
      >,
    ): Promise<AppliedMemoryChange> => {
      await close(tx, reservationId, 'done', null, result.action === 'forgotten' ? null : entry.id)
      return { outcome: 'done', entryId: entry.id, kind, ...result }
    }

    if (action === 'update') {
      if (text === undefined) return refuse('failed')
      if (memoryChangeMode(facts, { kind: 'update', text }, conditions) === 'proposal') {
        await tx.memoryEntry.update({
          where: { id: entry.id },
          data: { pendingAction: 'update', pendingText: text, version: { increment: 1 } },
        })
        return done({ action: 'update_proposed', text })
      }
      const status = updatedMemoryStatus(facts, text, conditions)
      await tx.memoryEntry.update({
        where: { id: entry.id },
        data: {
          text,
          status,
          pendingAction: null,
          pendingText: null,
          version: { increment: 1 },
          sourceTaskId: input.taskId,
          sourceTurn: input.turnNo,
        },
      })
      return done({
        action:
          status === 'proposed' ? 'proposed' : facts.status === 'proposed' ? 'saved' : 'updated',
        text,
      })
    }

    if (memoryChangeMode(facts, { kind: 'forget' }, conditions) === 'proposal') {
      await tx.memoryEntry.update({
        where: { id: entry.id },
        data: { pendingAction: 'forget', pendingText: null, version: { increment: 1 } },
      })
      return done({ action: 'forget_proposed', text: entry.text })
    }
    await tx.memoryEntry.delete({ where: { id: entry.id } })
    return done({ action: 'forgotten', text: entry.text })
  })
}

/** A change the end of its turn does not apply: closed with its reason; false — closed already. */
export async function refuseMemoryChange(
  db: Pick<PrismaClient, 'memoryReservation'>,
  reservationId: string,
  outcome: 'refused' | 'failed',
  reason: MemoryLeftReason,
): Promise<boolean> {
  const closed = await db.memoryReservation.updateMany({
    where: { id: reservationId, outcome: null },
    data: { outcome, reason, closedAt: new Date() },
  })
  return closed.count === 1
}

/**
 * The changes of a failed or cancelled turn, closed at once (§4.3, step 9): what it asked is never
 * applied. The closed ones, for the caller to tell.
 */
export async function failMemoryTurn(
  db: Pick<PrismaClient, '$transaction'>,
  taskId: string,
  turnNo: number,
): Promise<{ id: string; kind: MemoryChangeKind }[]> {
  return db.$transaction(async (tx) => {
    const open = await tx.memoryReservation.findMany({
      where: { taskId, turnNo, outcome: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, kind: true },
    })
    if (open.length === 0) return []
    await tx.memoryReservation.updateMany({
      where: { id: { in: open.map((row) => row.id) }, outcome: null },
      data: { outcome: 'failed', reason: 'failed', closedAt: new Date() },
    })
    return open.map((row) => ({ id: row.id, kind: row.kind as MemoryChangeKind }))
  })
}

/** Changes no end of a turn closed — the pass was lost — older than `before`: the sweep closes them. */
export async function closeStaleMemoryReservations(
  db: Pick<PrismaClient, 'memoryReservation'>,
  before: Date,
  limit = 100,
): Promise<{ id: string; taskId: string; turnNo: number; kind: MemoryChangeKind }[]> {
  const stale = await db.memoryReservation.findMany({
    // A turn has no time limit (plan 70): one still assigned ends its own (ревью C8).
    where: {
      outcome: null,
      createdAt: { lt: before },
      task: { turnAssignments: { none: { finishedAt: null } } },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true, taskId: true, turnNo: true, kind: true },
  })
  const closed: { id: string; taskId: string; turnNo: number; kind: MemoryChangeKind }[] = []
  for (const row of stale)
    if (await refuseMemoryChange(db, row.id, 'failed', 'failed'))
      closed.push({ ...row, kind: row.kind as MemoryChangeKind })
  return closed
}

// ── The client's side (slice 84.13): the windows «Память» of a project and of the account. ─────
// Only the owner of a memory sees and changes it; an entry of someone else, of a project in the
// trash or of another project answers MEMORY_NOT_FOUND, as one that is not there. Every change
// grows the version, so that the end of a pass of the agent that read it before refuses its own.

/** An entry as the window «Память» shows it. */
export interface MemoryRow {
  id: string
  kind: MemoryKind
  text: string
  status: MemoryStatus
  author: MemoryAuthor
  version: number
  /** A proposal of the agent over an active entry: its new text, or to forget it. */
  pendingAction: MemoryPendingAction | null
  pendingText: string | null
  /** The chat it came from, while that chat is shown. */
  source: { taskId: string; title: string | null } | null
  confirmed: boolean
  createdAt: Date
  updatedAt: Date
}

const memoryRowSelect = {
  id: true,
  kind: true,
  text: true,
  status: true,
  author: true,
  version: true,
  pendingAction: true,
  pendingText: true,
  confirmedAt: true,
  createdAt: true,
  updatedAt: true,
  sourceTask: { select: { id: true, title: true, deletedAt: true } },
} as const

type MemoryRowRecord = Prisma.MemoryEntryGetPayload<{ select: typeof memoryRowSelect }>

const memoryRowOf = (row: MemoryRowRecord): MemoryRow => ({
  id: row.id,
  kind: row.kind as MemoryKind,
  text: row.text,
  status: row.status as MemoryStatus,
  author: row.author as MemoryAuthor,
  version: row.version,
  pendingAction: row.pendingAction as MemoryPendingAction | null,
  pendingText: row.pendingText,
  source:
    row.sourceTask && row.sourceTask.deletedAt === null
      ? { taskId: row.sourceTask.id, title: row.sourceTask.title }
      : null,
  confirmed: row.confirmedAt !== null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

/** Every entry of one memory, newest first: at most 40 of them. */
export async function listMemory(
  db: Pick<PrismaClient, 'memoryEntry'>,
  scope: MemoryScope,
): Promise<MemoryRow[]> {
  const rows = await db.memoryEntry.findMany({
    where: scopeWhere(scope),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: memoryLimits.entries * 2,
    select: memoryRowSelect,
  })
  return rows.map(memoryRowOf)
}

/** How many entries a memory has: active ones and those waiting for the client («N ждут…»). */
export async function memoryCounts(
  db: Pick<PrismaClient, 'memoryEntry'>,
  scope: MemoryScope,
): Promise<{ active: number; proposed: number }> {
  const [active, proposed] = await Promise.all([
    db.memoryEntry.count({ where: { ...scopeWhere(scope), status: 'active' } }),
    db.memoryEntry.count({
      where: {
        ...scopeWhere(scope),
        OR: [{ status: 'proposed' }, { pendingAction: { not: null } }],
      },
    }),
  ])
  return { active, proposed }
}

/** «Добавить запись»: the client's own note, active at once, counted against the 40. */
export async function addMemoryEntry(
  db: Db,
  input: { scope: MemoryScope; kind: MemoryKind; text: string },
): Promise<MemoryRow> {
  const text = memoryTextOf(input.text)
  return db.$transaction(async (tx) => {
    await lockMemory(tx, input.scope)
    if ((await tx.memoryEntry.count({ where: scopeWhere(input.scope) })) >= memoryLimits.entries)
      throw memoryFull()
    const now = new Date()
    const row = await tx.memoryEntry.create({
      data: {
        id: uuidv7(),
        ...scopeWhere(input.scope),
        kind: input.kind,
        text,
        status: 'active',
        author: 'client',
        confirmedAt: now,
      },
      select: memoryRowSelect,
    })
    return memoryRowOf(row)
  })
}

/**
 * The entry of the user, locked for its change: of the account, or of a project of theirs that is
 * not in the trash. Anything else — MEMORY_NOT_FOUND.
 */
async function ownEntry(tx: Tx, userId: string, entryId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT e.id FROM memory_entries e
    LEFT JOIN projects p ON p.id = e.project_id
    WHERE e.id = ${entryId}::uuid AND e.user_id = ${userId}::uuid
      AND (e.project_id IS NULL OR (p.deleted_at IS NULL AND p.created_by_id = ${userId}::uuid))
    FOR UPDATE OF e`
  if (rows.length === 0) throw memoryEntryNotFound()
  return tx.memoryEntry.findUniqueOrThrow({
    where: { id: entryId },
    select: {
      id: true,
      workspaceId: true,
      projectId: true,
      version: true,
      status: true,
      text: true,
      pendingAction: true,
      pendingText: true,
    },
  })
}

/**
 * «Изменить»: the client's text — and its kind — at the version they saw. The entry becomes
 * active and confirmed: from now on the agent changes it only by a proposal; a proposal it had
 * over the entry is dropped.
 */
export async function editMemoryEntry(
  db: Db,
  input: {
    userId: string
    entryId: string
    text: string
    kind?: MemoryKind
    expectedVersion: number
  },
): Promise<MemoryRow> {
  const text = memoryTextOf(input.text)
  return db.$transaction(async (tx) => {
    const entry = await ownEntry(tx, input.userId, input.entryId)
    if (entry.version !== input.expectedVersion) throw memoryVersionChanged()
    const row = await tx.memoryEntry.update({
      where: { id: entry.id },
      data: {
        text,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        status: 'active',
        confirmedAt: new Date(),
        pendingAction: null,
        pendingText: null,
        version: { increment: 1 },
      },
      select: memoryRowSelect,
    })
    return memoryRowOf(row)
  })
}

/** What «Сохранить» or «Не надо» did. */
export type MemoryDecision = 'saved' | 'updated' | 'forgotten' | 'dropped'

/**
 * «Сохранить» (ПР18): a note the agent proposed becomes active and confirmed; its new text of an
 * active entry replaces the old one; its «Предложено забыть» deletes the entry. At the version the
 * client saw: what they did not read is never saved. An entry with nothing to decide — refused.
 */
export async function confirmMemoryEntry(
  db: Db,
  input: { userId: string; entryId: string; expectedVersion: number },
): Promise<{ decision: MemoryDecision; entry: MemoryRow | null }> {
  return db.$transaction(async (tx) => {
    const entry = await ownEntry(tx, input.userId, input.entryId)
    if (entry.version !== input.expectedVersion) throw memoryVersionChanged()
    if (entry.pendingAction === 'forget') {
      await tx.memoryEntry.delete({ where: { id: entry.id } })
      await auditMemory(tx, input.userId, entry, 'memory.entry.forget')
      return { decision: 'forgotten', entry: null }
    }
    if (entry.status !== 'proposed' && entry.pendingAction !== 'update')
      throw memoryVersionChanged()
    const row = await tx.memoryEntry.update({
      where: { id: entry.id },
      data: {
        ...(entry.pendingAction === 'update' && entry.pendingText !== null
          ? { text: entry.pendingText }
          : {}),
        status: 'active',
        confirmedAt: new Date(),
        pendingAction: null,
        pendingText: null,
        version: { increment: 1 },
      },
      select: memoryRowSelect,
    })
    return {
      decision: entry.pendingAction === 'update' ? 'updated' : 'saved',
      entry: memoryRowOf(row),
    }
  })
}

/**
 * «Не надо» (ПР18): a note the agent proposed is deleted; its proposal over an active entry is
 * dropped and the entry keeps its text.
 */
export async function rejectMemoryEntry(
  db: Db,
  input: { userId: string; entryId: string; expectedVersion: number },
): Promise<{ decision: 'dropped'; entry: MemoryRow | null }> {
  return db.$transaction(async (tx) => {
    const entry = await ownEntry(tx, input.userId, input.entryId)
    if (entry.version !== input.expectedVersion) throw memoryVersionChanged()
    if (entry.status === 'proposed') {
      await tx.memoryEntry.delete({ where: { id: entry.id } })
      return { decision: 'dropped', entry: null }
    }
    if (entry.pendingAction === null) throw memoryVersionChanged()
    const row = await tx.memoryEntry.update({
      where: { id: entry.id },
      data: { pendingAction: null, pendingText: null, version: { increment: 1 } },
      select: memoryRowSelect,
    })
    return { decision: 'dropped', entry: memoryRowOf(row) }
  })
}

/** «Удалить» (ПР28): forever; the audit keeps that it was, never its text. */
export async function removeMemoryEntry(
  db: Db,
  input: { userId: string; entryId: string },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const entry = await ownEntry(tx, input.userId, input.entryId)
    await tx.memoryEntry.delete({ where: { id: entry.id } })
    await auditMemory(tx, input.userId, entry, 'memory.entry.remove')
  })
}

/** «Очистить память» (ПР28): every entry of one memory, forever. */
export async function clearMemory(
  db: Db,
  input: { scope: MemoryScope },
): Promise<{ removed: number }> {
  return db.$transaction(async (tx) => {
    await lockMemory(tx, input.scope)
    const { count } = await tx.memoryEntry.deleteMany({ where: scopeWhere(input.scope) })
    await tx.auditLog.create({
      data: {
        actorType: 'user',
        actorId: input.scope.userId,
        workspaceId: input.scope.workspaceId,
        action: 'memory.clear',
        targetType: input.scope.projectId === null ? 'account_memory' : 'project',
        targetId: input.scope.projectId ?? input.scope.userId,
        meta: { removed: count },
      },
    })
    return { removed: count }
  })
}

function auditMemory(
  tx: Tx,
  userId: string,
  entry: { id: string; workspaceId: string; projectId: string | null },
  action: string,
) {
  return tx.auditLog.create({
    data: {
      actorType: 'user',
      actorId: userId,
      workspaceId: entry.workspaceId,
      action,
      targetType: 'memory_entry',
      targetId: entry.id,
      meta: { projectId: entry.projectId },
    },
  })
}

/** One entry of the user, for a row of the feed that offers «Сохранить»; null — gone or not theirs. */
export async function readMemoryEntry(
  db: Pick<PrismaClient, 'memoryEntry'>,
  input: { userId: string; entryId: string },
): Promise<MemoryRow | null> {
  const row = await db.memoryEntry.findFirst({
    where: {
      id: input.entryId,
      userId: input.userId,
      OR: [{ projectId: null }, { project: { deletedAt: null, createdById: input.userId } }],
    },
    select: memoryRowSelect,
  })
  return row ? memoryRowOf(row) : null
}
