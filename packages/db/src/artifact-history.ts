import { randomUUID } from 'node:crypto'

import {
  artifactForbidden,
  artifactLimits,
  artifactNotFound,
  artifactRoleCan,
} from '@repo/domain/artifacts'

import { Prisma, type PrismaClient } from './generated/prisma/client.ts'
import {
  applyArtifactOps,
  artifactRole,
  readArtifact,
  readArtifactVersion,
  saveArtifactVersion,
  type ArtifactOpsAnswer,
} from './artifacts.ts'

// The history of an artifact (docs/plan/88-artifacts.md, Ар13; board D-history; slice 88.11а):
// its versions and the journal of its changes, «Вернуть эту версию» and «Отменить правки этого
// хода». Both are writes of a person: they go through `applyArtifactOps` as any edit does — a
// block an agent holds is not overwritten (ARTIFACT_BLOCK_HELD), a block changed since is left as
// it is. «Вернуть» is a new version, and the state before it is kept as a version first.

type Db = PrismaClient

const person = (userId: string) => ({ kind: 'user' as const, userId })

async function requireOwnerOf(
  db: Db,
  artifactId: string,
  userId: string,
  action: 'read' | 'restore_version' | 'edit',
) {
  const role = await artifactRole(db, { artifactId, userId })
  if (role === null) throw artifactNotFound()
  if (!artifactRoleCan(role, action)) throw artifactForbidden()
  return role
}

/** The authors of revisions as the reader may name them: people by name, chats by title (Ар21). */
async function authorsOf(
  db: Db,
  rows: readonly { writtenByUserId: string | null; taskId: string | null }[],
  readerId: string,
): Promise<{ people: Map<string, string>; chats: Map<string, string | null> }> {
  const userIds = [
    ...new Set(rows.flatMap((row) => (row.writtenByUserId ? [row.writtenByUserId] : []))),
  ]
  const taskIds = [...new Set(rows.flatMap((row) => (row.taskId ? [row.taskId] : [])))]
  const [users, tasks] = await Promise.all([
    db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
    // A chat is named to its own client alone; others read «Агент».
    db.task.findMany({
      where: { id: { in: taskIds } },
      select: { id: true, title: true, createdById: true },
    }),
  ])
  return {
    people: new Map(users.map((user) => [user.id, user.id === readerId ? '' : user.name])),
    chats: new Map(
      tasks.map((task) => [task.id, task.createdById === readerId ? task.title : null]),
    ),
  }
}

export interface ArtifactVersionRow {
  no: number
  label: string | null
  named: boolean
  /** user | turn | schedule. */
  author: 'user' | 'turn' | 'schedule'
  /** The title of the chat of an agent's version, for its client; null otherwise. */
  chat: string | null
  /** The chat and turn of an agent's version: «Отменить правки этого хода». */
  taskId: string | null
  turnNo: number | null
  createdAt: Date
  current: boolean
}

/** The versions of an artifact, newest first (D-history, «Версии»). */
export async function listArtifactVersions(
  db: Db,
  input: { artifactId: string; userId: string },
): Promise<ArtifactVersionRow[]> {
  await requireOwnerOf(db, input.artifactId, input.userId, 'read')
  const [artifact, versions] = await Promise.all([
    db.artifact.findUniqueOrThrow({
      where: { id: input.artifactId },
      select: { currentVersion: true },
    }),
    db.artifactVersion.findMany({
      where: { documentId: input.artifactId },
      orderBy: { no: 'desc' },
      take: artifactLimits.automaticVersions + artifactLimits.namedVersions,
      select: {
        no: true,
        label: true,
        named: true,
        authorKind: true,
        taskId: true,
        turnNo: true,
        createdAt: true,
      },
    }),
  ])
  const { chats } = await authorsOf(
    db,
    versions.map((version) => ({ writtenByUserId: null, taskId: version.taskId })),
    input.userId,
  )
  return versions.map((version) => ({
    no: version.no,
    label: version.label,
    named: version.named,
    author:
      version.authorKind === 'user' || version.authorKind === 'schedule'
        ? version.authorKind
        : version.taskId === null
          ? 'user'
          : 'turn',
    chat: version.taskId ? (chats.get(version.taskId) ?? null) : null,
    taskId: version.taskId,
    turnNo: version.turnNo,
    createdAt: version.createdAt,
    current: version.no === artifact.currentVersion,
  }))
}

export interface ArtifactChangeRow {
  seq: number
  kind: string
  block: string | null
  /** applied | checking | checked | refused | dropped | taken. */
  result: string
  author: { kind: 'person'; name: string; self: boolean } | { kind: 'agent'; chat: string | null }
  taskId: string | null
  turnNo: number | null
  createdAt: Date
}

/** «Все изменения» (D-history): the journal of the artifact, newest first, without text. */
export async function listArtifactChanges(
  db: Db,
  input: { artifactId: string; userId: string; limit?: number },
): Promise<ArtifactChangeRow[]> {
  await requireOwnerOf(db, input.artifactId, input.userId, 'read')
  const ops = await db.artifactOp.findMany({
    where: { artifactId: input.artifactId, kind: { notIn: ['create'] } },
    orderBy: { seq: 'desc' },
    take: Math.min(input.limit ?? 200, 500),
    select: {
      seq: true,
      kind: true,
      blockKey: true,
      result: true,
      actor: true,
      userId: true,
      taskId: true,
      turnNo: true,
      createdAt: true,
    },
  })
  const { people, chats } = await authorsOf(
    db,
    ops.map((op) => ({
      writtenByUserId: op.actor === 'user' ? op.userId : null,
      taskId: op.taskId,
    })),
    input.userId,
  )
  return ops.map((op) => ({
    seq: Number(op.seq),
    kind: op.kind,
    block: op.blockKey,
    result: op.result,
    author:
      op.actor === 'user'
        ? {
            kind: 'person' as const,
            name: people.get(op.userId ?? '') ?? '',
            self: op.userId === input.userId,
          }
        : { kind: 'agent' as const, chat: op.taskId ? (chats.get(op.taskId) ?? null) : null },
    taskId: op.taskId,
    turnNo: op.turnNo,
    createdAt: op.createdAt,
  }))
}

interface RevisionText {
  content: string | null
  props: Record<string, string | number | boolean>
  kind: string
  parent: string | null
  deleted: boolean
}

/** The text of one revision of a block: kept once per hash, on the first revision that had it. */
async function revisionText(
  db: Db,
  artifactId: string,
  blockKey: string,
  rev: number,
): Promise<RevisionText | null> {
  const row = await db.artifactBlockRevision.findUnique({
    where: { artifactId_blockKey_rev: { artifactId, blockKey, rev } },
  })
  if (!row) return null
  const text =
    row.props !== null
      ? row
      : await db.artifactBlockRevision.findFirst({
          where: { artifactId, sha256: row.sha256, props: { not: Prisma.DbNull } },
        })
  const props = (text?.props ?? {}) as Record<string, string | number | boolean>
  return {
    content: text?.content ?? null,
    props,
    kind: row.blockKind,
    parent: row.parentKey,
    deleted: row.deleted,
  }
}

type Op = Record<string, unknown> & { op: string }

/** The lines of the journal that wrote a block; a check, a take and a claim did not. */
const writingKinds = ['insert', 'replace', 'edit', 'move', 'delete', 'props', 'cells'] as const

/** The ops of a person in batches the pipeline takes (§7.2: up to 50 a batch), one after another. */
async function applyInBatches(
  db: Db,
  artifactId: string,
  userId: string,
  ops: readonly Op[],
): Promise<ArtifactOpsAnswer[]> {
  const answers: ArtifactOpsAnswer[] = []
  for (let at = 0; at < ops.length; at += artifactLimits.batchOps)
    answers.push(
      await applyArtifactOps(db, {
        batch: {
          artifactId,
          opId: `hist-${randomUUID()}`,
          ops: ops.slice(at, at + artifactLimits.batchOps),
        },
        actor: person(userId),
      }),
    )
  return answers
}

export interface ArtifactRestorePreview {
  /** The blocks that would be written, removed or put back. */
  blocks: number
  /** Whose edits it overwrites (Ар13): the people by name — the reader not named — and the chats. */
  people: string[]
  chats: string[]
  agents: number
  /** Blocks an agent holds now: «Вернуть» waits for them. */
  held: number
}

async function restorePlan(db: Db, input: { artifactId: string; no: number; userId: string }) {
  const version = await readArtifactVersion(db, {
    artifactId: input.artifactId,
    no: input.no,
    actor: person(input.userId),
  })
  const current = await readArtifact(db, {
    artifactId: input.artifactId,
    actor: person(input.userId),
  })
  const wanted = new Map(version.blocks.map((block) => [block.key, block]))
  const now = new Map(current.blocks.map((block) => [block.key, block]))
  const ops: Op[] = []
  const touched: { key: string; rev: number }[] = []
  let held = 0
  let previous: string | null = null
  for (const block of version.blocks) {
    const live = now.get(block.key)
    if (live?.hold === 'checking' || live?.hold === 'claim') held += 1
    if (!live) {
      ops.push({
        op: 'insert',
        block: block.key,
        after: previous !== null && (now.has(previous) || wanted.has(previous)) ? previous : null,
        kind: block.kind ?? 'section',
        content: block.content ?? '',
        props: block.props,
      })
    } else if (live.rev !== block.rev) {
      touched.push({ key: live.key, rev: live.rev })
      ops.push({
        op: 'replace',
        block: block.key,
        ifRev: live.rev,
        content: block.content ?? '',
        props: block.props,
      })
    }
    previous = block.key
  }
  for (const live of current.blocks)
    if (!wanted.has(live.key)) {
      if (live.hold === 'checking' || live.hold === 'claim') held += 1
      touched.push({ key: live.key, rev: live.rev })
      ops.push({ op: 'delete', block: live.key, ifRev: live.rev })
    }
  return { version, current, ops, touched, held }
}

/** What «Вернуть эту версию» would overwrite, before the person confirms it (Ар13). */
export async function previewArtifactRestore(
  db: Db,
  input: { artifactId: string; no: number; userId: string },
): Promise<ArtifactRestorePreview> {
  await requireOwnerOf(db, input.artifactId, input.userId, 'restore_version')
  const plan = await restorePlan(db, input)
  const rows = await db.artifactBlockRevision.findMany({
    where: {
      artifactId: input.artifactId,
      OR: plan.touched.length
        ? plan.touched.map((each) => ({ blockKey: each.key, rev: each.rev }))
        : [{ blockKey: '' }],
    },
    select: { writtenByUserId: true, taskId: true },
  })
  const { people, chats } = await authorsOf(db, rows, input.userId)
  const names = [
    ...new Set(
      rows.flatMap((row) => (row.writtenByUserId ? [people.get(row.writtenByUserId) ?? ''] : [])),
    ),
  ].filter(Boolean)
  const chatTitles = [
    ...new Set(rows.flatMap((row) => (row.taskId ? [chats.get(row.taskId) ?? null] : []))),
  ]
  return {
    blocks: plan.ops.length,
    people: names,
    chats: chatTitles.filter((title): title is string => title !== null),
    agents: chatTitles.filter((title) => title === null).length,
    held: plan.held,
  }
}

/**
 * «Вернуть эту версию» (Ар13) — only the owner: the state before it is kept as a version, then the
 * blocks become what the version holds, and that is a new version. A block an agent holds refuses
 * (ARTIFACT_BLOCK_HELD) and nothing of that batch is written.
 */
export async function restoreArtifactVersion(
  db: Db,
  input: { artifactId: string; no: number; userId: string },
): Promise<{ no: number; changed: number }> {
  await requireOwnerOf(db, input.artifactId, input.userId, 'restore_version')
  const plan = await restorePlan(db, input)
  if (plan.ops.length === 0) return { no: plan.current.version, changed: 0 }
  await saveArtifactVersion(db, { artifactId: input.artifactId, actor: person(input.userId) })
  await applyInBatches(db, input.artifactId, input.userId, plan.ops)
  const saved = await saveArtifactVersion(db, {
    artifactId: input.artifactId,
    actor: person(input.userId),
  })
  return { no: saved.no, changed: plan.ops.length }
}

/** The artifacts a turn of a chat changed, for `/undo` (Ар13): what it may offer to take back. */
export async function artifactsChangedByTurn(
  db: Db,
  input: { taskId: string; turnNo: number; userId: string },
): Promise<{ id: string; title: string }[]> {
  const ops = await db.artifactOp.findMany({
    where: {
      taskId: input.taskId,
      turnNo: input.turnNo,
      actor: { in: ['agent', 'schedule'] },
      result: { in: ['applied', 'checked', 'checking'] },
      kind: { in: [...writingKinds] },
      blockKey: { not: null },
    },
    distinct: ['artifactId'],
    select: { artifactId: true },
  })
  const rows: { id: string; title: string }[] = []
  for (const op of ops) {
    if ((await artifactRole(db, { artifactId: op.artifactId, userId: input.userId })) === null)
      continue
    const artifact = await db.artifact.findUnique({
      where: { id: op.artifactId },
      select: { title: true },
    })
    if (artifact) rows.push({ id: op.artifactId, title: artifact.title })
  }
  return rows
}

/**
 * «Отменить правки этого хода» (Ар13): the blocks a turn of a chat wrote, each back to the text it
 * had before that turn — only those nobody changed since; a block the turn inserted goes. Returns
 * how many came back and how many were left as they are because they changed since.
 */
export async function undoArtifactTurn(
  db: Db,
  input: { artifactId: string; taskId: string; turnNo: number; userId: string },
): Promise<{ undone: number; kept: number }> {
  await requireOwnerOf(db, input.artifactId, input.userId, 'edit')
  const ops = await db.artifactOp.findMany({
    where: {
      artifactId: input.artifactId,
      taskId: input.taskId,
      turnNo: input.turnNo,
      actor: { in: ['agent', 'schedule'] },
      blockKey: { not: null },
      kind: { in: [...writingKinds] },
      result: { in: ['applied', 'checked', 'checking'] },
    },
    orderBy: { seq: 'asc' },
    select: { blockKey: true, baseRev: true, newRev: true, kind: true },
  })
  // Per block: the revision before the first write of the turn, and the one after its last.
  const spans = new Map<
    string,
    { before: number | null; after: number | null; inserted: boolean }
  >()
  for (const op of ops) {
    const key = op.blockKey!
    const span = spans.get(key)
    if (!span)
      spans.set(key, {
        before: op.kind === 'insert' ? null : op.baseRev,
        after: op.newRev,
        inserted: op.kind === 'insert',
      })
    else span.after = op.newRev ?? span.after
  }
  if (spans.size === 0) return { undone: 0, kept: 0 }
  const current = await readArtifact(db, {
    artifactId: input.artifactId,
    actor: person(input.userId),
  })
  const now = new Map(current.blocks.map((block) => [block.key, block]))
  const undo: Op[] = []
  let kept = 0
  for (const [key, span] of spans) {
    const live = now.get(key)
    // Changed since the turn — by a person, another chat or the next turn: left as it is.
    if (!live || (span.after !== null && live.rev !== span.after) || live.hold === 'checking') {
      kept += 1
      continue
    }
    if (span.inserted || span.before === null || span.before < 1) {
      undo.push({ op: 'delete', block: key, ifRev: live.rev })
      continue
    }
    const before = await revisionText(db, input.artifactId, key, span.before)
    if (!before || before.deleted) {
      kept += 1
      continue
    }
    undo.push({
      op: 'replace',
      block: key,
      ifRev: live.rev,
      content: before.content ?? '',
      props: before.props,
    })
  }
  if (undo.length > 0) await applyInBatches(db, input.artifactId, input.userId, undo)
  return { undone: undo.length, kept }
}
