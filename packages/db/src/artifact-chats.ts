import { artifactLimits, artifactRoleCan, type ArtifactListScope } from '@repo/domain/artifacts'

import type { Prisma, PrismaClient } from './generated/prisma/client.ts'
import { artifactRole } from './artifacts.ts'

// What a chat may open of the artifacts of its workspace, and what changed in them since it read
// them (docs/plan/88-artifacts.md, Ар21, Ар23, §7.5; slice 88.6). The role on each artifact is
// `artifactRole` — the one function of every path (Ар37); this file adds the bounds of a chat:
// what it created, edited or was given (`artifact_chats`), the artifacts of its project, the
// client's own without a project. A chat that only read an artifact keeps a row of `how = 'read'`
// for its `read_seq`: it opens nothing by itself.

type Db = Pick<PrismaClient, '$queryRaw' | 'artifact' | 'artifactChat' | 'artifactOp' | 'task'>

/** The links of a chat that open an artifact to it (Ар23): not a mere read. */
const openingLinks = ['created', 'attached', 'mentioned', 'edited'] as const

interface ChatOf {
  workspaceId: string
  projectId: string | null
  clientId: string | null
}

async function chatOf(db: Pick<PrismaClient, 'task'>, taskId: string): Promise<ChatOf | null> {
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { workspaceId: true, projectId: true, createdById: true },
  })
  return task
    ? { workspaceId: task.workspaceId, projectId: task.projectId, clientId: task.createdById }
    : null
}

/** Which of the chat's places an artifact is in; null — none: the chat does not open it. */
function placeOf(
  artifact: { projectId: string | null; ownerUserId: string | null; linked: boolean },
  chat: ChatOf,
): ArtifactListScope | null {
  if (artifact.linked) return 'chat'
  if (artifact.projectId !== null && artifact.projectId === chat.projectId) return 'project'
  if (artifact.projectId === null && artifact.ownerUserId === chat.clientId) return 'mine'
  return null
}

/**
 * Whether the chat opens the artifact, and with which role of its client (Ар23, Ар37): null — it
 * does not, never told apart from «not there». `personal` — the client's own without a project:
 * a pass without its client writes only there (Ар24).
 */
export async function chatArtifactAccess(
  db: Db,
  input: { taskId: string; artifactId: string },
): Promise<{
  role: 'view' | 'comment' | 'edit' | 'owner'
  personal: boolean
  linked: boolean
} | null> {
  const chat = await chatOf(db, input.taskId)
  if (!chat?.clientId) return null
  const artifact = await db.artifact.findUnique({
    where: { id: input.artifactId },
    select: {
      workspaceId: true,
      projectId: true,
      ownerUserId: true,
      chats: { where: { taskId: input.taskId }, select: { how: true } },
    },
  })
  if (!artifact || artifact.workspaceId !== chat.workspaceId) return null
  const linked = artifact.chats.some((link) =>
    (openingLinks as readonly string[]).includes(link.how),
  )
  if (placeOf({ ...artifact, linked }, chat) === null) return null
  const role = await artifactRole(db, { artifactId: input.artifactId, userId: chat.clientId })
  if (role === null) return null
  return { role, personal: artifact.projectId === null, linked }
}

export interface ChatArtifactRow {
  id: string
  kind: string
  title: string
  version: number
  updatedAt: Date
  place: ArtifactListScope
}

/**
 * `artifact_list` (§7.5): what the chat opens — created, edited or attached in it, of its project,
 * the client's own — newest first, up to 50 rows; a title the agent wrote is the checked one.
 */
export async function listChatArtifacts(
  db: Db,
  input: { taskId: string; scope?: ArtifactListScope; kind?: string; query?: string },
): Promise<{ rows: ChatArtifactRow[]; more: boolean }> {
  const chat = await chatOf(db, input.taskId)
  if (!chat?.clientId) return { rows: [], more: false }
  const places: Prisma.ArtifactWhereInput[] = []
  const wants = (scope: ArtifactListScope) => !input.scope || input.scope === scope
  if (wants('chat'))
    places.push({ chats: { some: { taskId: input.taskId, how: { in: [...openingLinks] } } } })
  if (wants('attached')) places.push({ chats: { some: { taskId: input.taskId, how: 'attached' } } })
  if (wants('project') && chat.projectId) places.push({ projectId: chat.projectId })
  if (wants('mine')) places.push({ projectId: null, ownerUserId: chat.clientId })
  if (places.length === 0) return { rows: [], more: false }
  const found = await db.artifact.findMany({
    where: {
      workspaceId: chat.workspaceId,
      deletedAt: null,
      takenDownAt: null,
      OR: places,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.query ? { title: { contains: input.query, mode: 'insensitive' } } : {}),
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: artifactLimits.listRows * 2,
    select: {
      id: true,
      kind: true,
      title: true,
      currentVersion: true,
      updatedAt: true,
      projectId: true,
      ownerUserId: true,
      chats: { where: { taskId: input.taskId }, select: { how: true } },
    },
  })
  const rows: ChatArtifactRow[] = []
  for (const artifact of found) {
    if (rows.length > artifactLimits.listRows) break
    const linked = artifact.chats.some((link) =>
      (openingLinks as readonly string[]).includes(link.how),
    )
    const place = placeOf({ ...artifact, linked }, chat)
    if (place === null) continue
    // The role of every row, as every path reads it (Ар37).
    const role = await artifactRole(db, { artifactId: artifact.id, userId: chat.clientId })
    if (!artifactRoleCan(role, 'read')) continue
    rows.push({
      id: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      version: artifact.currentVersion,
      updatedAt: artifact.updatedAt,
      place: input.scope === 'attached' ? 'attached' : place,
    })
  }
  return {
    rows: rows.slice(0, artifactLimits.listRows),
    more: rows.length > artifactLimits.listRows,
  }
}

/** The journal's kinds that change a block another reader sees (Ар21). */
const changingKinds = [
  'insert',
  'replace',
  'edit',
  'move',
  'delete',
  'props',
  'cells',
  'check',
  'take',
]

export interface ArtifactChatNews {
  /** The `seq` of the artifact now. */
  seq: number
  /**
   * The blocks other people or chats changed since this chat last read the artifact (Ар21): their
   * number, the first 50 ids, `more` past them.
   */
  changedSinceYourRead: { count: number; blocks: string[]; more: boolean }
  /** The writes of this chat the check of core sent back since its read: the text before stays. */
  refusedSinceYourRead: string[]
}

/**
 * What changed in an artifact since the chat's `read_seq` (Ар21, §7.3): changes by others, and
 * this chat's writes the check refused. `read` — the chat read the artifact now: its `read_seq`
 * moves to the current `seq`, a row `how = 'read'` is kept if it had none.
 */
export async function artifactChatNews(
  db: Db,
  input: { taskId: string; artifactId: string; read?: boolean },
): Promise<ArtifactChatNews> {
  const artifact = await db.artifact.findUniqueOrThrow({
    where: { id: input.artifactId },
    select: { seq: true, chats: { where: { taskId: input.taskId }, select: { readSeq: true } } },
  })
  const since = artifact.chats[0]?.readSeq ?? 0n
  const lines = await db.artifactOp.findMany({
    where: { artifactId: input.artifactId, seq: { gt: since }, kind: { in: changingKinds } },
    select: { taskId: true, actor: true, kind: true, blockKey: true, result: true },
    orderBy: { seq: 'asc' },
  })
  const changed: string[] = []
  const refused: string[] = []
  for (const line of lines) {
    if (line.blockKey === null) continue
    const own = line.taskId === input.taskId && line.actor !== 'user'
    if (own && line.result === 'refused') {
      if (!refused.includes(line.blockKey)) refused.push(line.blockKey)
      continue
    }
    // This chat's own writes and the checks of them are no news to it; a person taking its
    // write is (`take` names the chat it took from).
    if (own || (line.kind === 'check' && line.taskId === input.taskId)) continue
    if (line.result === 'checking' || line.result === 'dropped') continue
    if (!changed.includes(line.blockKey)) changed.push(line.blockKey)
  }
  if (input.read)
    await db.artifactChat.upsert({
      where: { artifactId_taskId: { artifactId: input.artifactId, taskId: input.taskId } },
      create: {
        artifactId: input.artifactId,
        taskId: input.taskId,
        how: 'read',
        readSeq: artifact.seq,
      },
      update: { readSeq: artifact.seq, lastAt: new Date() },
    })
  const shown = artifactLimits.changedIdsShown
  return {
    seq: Number(artifact.seq),
    changedSinceYourRead: {
      count: changed.length,
      blocks: changed.slice(0, shown),
      more: changed.length > shown,
    },
    refusedSinceYourRead: refused,
  }
}

/**
 * The artifacts a turn of a chat changed or created (§7.3, Ар46): its lines of the journal, with
 * how many of its writes the check refused. Read by core at the end of the turn — for the version
 * of each and for the row of the feed after the answer.
 */
export async function artifactsOfTurn(
  db: Pick<PrismaClient, '$queryRaw'>,
  taskId: string,
  turnNo: number,
): Promise<
  { artifactId: string; kind: string; created: boolean; refused: number; checked: number }[]
> {
  const rows = await db.$queryRaw<
    { artifact_id: string; kind: string; created: boolean; refused: bigint; checked: bigint }[]
  >`
    SELECT o.artifact_id, d.kind,
           bool_or(o.kind = 'create') AS created,
           count(*) FILTER (WHERE o.result = 'refused') AS refused,
           count(*) FILTER (WHERE o.result IN ('checked', 'applied')) AS checked
    FROM artifact_ops o JOIN chat_documents d ON d.id = o.artifact_id
    WHERE o.task_id = ${taskId}::uuid AND o.turn_no = ${turnNo} AND o.actor <> 'user'
      AND d.deleted_at IS NULL
    GROUP BY o.artifact_id, d.kind
    ORDER BY min(o.created_at), o.artifact_id`
  return rows.map((row) => ({
    artifactId: row.artifact_id,
    kind: row.kind,
    created: row.created,
    refused: Number(row.refused),
    checked: Number(row.checked),
  }))
}

/** `doc_finish` with a view (docs/plan/74, Д1): how the document is shown; the rest is the turn's. */
export async function setArtifactView(
  db: Pick<PrismaClient, 'artifact'>,
  input: { artifactId: string; view: 'page' | 'text' },
): Promise<void> {
  await db.artifact.update({
    where: { id: input.artifactId },
    data: { view: input.view, revision: { increment: 1 } },
  })
}

/** The placeholders of a skeleton the document still has: `doc_finish` waits while there are. */
export async function artifactPlaceholders(
  db: Pick<PrismaClient, 'artifactBlock'>,
  artifactId: string,
): Promise<number> {
  return db.artifactBlock.count({
    where: {
      documentId: artifactId,
      deletedRev: null,
      blockKind: 'section',
      state: 'pending',
      pendingContent: null,
    },
  })
}

/**
 * The revision of a block this chat last saw (Ар3): the last line of its own in the journal — its
 * insert, write, the check of it or its refusal. A `doc_section_write` of plan 69 carries no
 * `ifRev`: it goes with this one, so a person's change since makes it `ARTIFACT_STALE`. Null — the
 * chat never wrote the block: the caller reads the current revision.
 */
export async function chatLastRevOf(
  db: Pick<PrismaClient, 'artifactOp'>,
  input: { taskId: string; artifactId: string; block: string },
): Promise<number | null> {
  const line = await db.artifactOp.findFirst({
    where: {
      artifactId: input.artifactId,
      taskId: input.taskId,
      blockKey: input.block,
      actor: { not: 'user' },
      newRev: { not: null },
    },
    orderBy: { seq: 'desc' },
    select: { newRev: true },
  })
  return line?.newRev ?? null
}
