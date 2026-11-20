import { randomUUID } from 'node:crypto'

import {
  applyArtifactOps,
  holdArtifactBlock,
  readArtifact,
  releaseArtifactBlock,
  saveArtifactVersion,
  takeArtifactBlock,
  type PrismaClient,
} from '@repo/db'
import { canonicalSection } from '@repo/doc-bridge'
import {
  artifactBatchHasSecretShape,
  artifactBatchSchema,
  artifactOpInvalid,
  artifactSecretShape,
  type ArtifactBatch,
} from '@repo/domain/artifacts'

// The page of an artifact in the cabinet (docs/plan/88-artifacts.md, Ар17, Ар18, Ар48, §7.7;
// slice 88.10): what a person reads, writes, holds and takes. A person's text of a section is kept
// in the canonical form of the bridge, the form the editor saves: before a person's first save of
// a section the agent wrote otherwise, the section is brought to that form by a write of its own,
// so that the person's revision changes only what the person changed.

const actorOf = (userId: string) => ({ kind: 'user' as const, userId })

/** The artifact as its owner reads it: the checked text, who holds each block, where it lies. */
export async function readCabinetArtifact(
  db: PrismaClient,
  input: { userId: string; artifactId: string },
) {
  const artifact = await readArtifact(db, {
    artifactId: input.artifactId,
    actor: actorOf(input.userId),
  })
  const row = await db.artifact.findUniqueOrThrow({
    where: { id: artifact.id },
    select: {
      updatedAt: true,
      project: { select: { id: true, name: true } },
    },
  })
  return {
    id: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
    seq: artifact.seq,
    role: artifact.role,
    version: artifact.version,
    project: row.project,
    updatedAt: row.updatedAt.toISOString(),
    blocks: artifact.blocks.map((block) => ({
      key: block.key,
      kind: block.kind,
      rank: block.rank,
      rev: block.rev,
      heading: typeof block.props.heading === 'string' ? block.props.heading : null,
      content: block.content,
      checking: block.checking,
      hold: block.hold,
    })),
  }
}

/**
 * The text of a section a person writes: the bridge's form, headings from the third level. A new
 * section says its kind; a `replace` is of a section when the block it names is one.
 */
function canonicalBatch(batch: ArtifactBatch, sections: ReadonlySet<string>): ArtifactBatch {
  return {
    ...batch,
    ops: batch.ops.map((op) => {
      if (op.op === 'insert' && op.kind === 'section' && op.content !== undefined)
        return { ...op, content: canonicalSection(op.content) }
      if (op.op === 'replace' && sections.has(op.block))
        return { ...op, content: canonicalSection(op.content) }
      return op
    }),
  }
}

/**
 * A batch of a person (§7.2) with the text of sections in the canonical form. A `replace` of a
 * section whose checked text is not in it yet — an agent's text, a section of the code before —
 * is preceded by a write of that same text in the canonical form, under the person's name and its
 * own revision; the person's write then names the revision after it.
 */
export async function applyCabinetOps(db: PrismaClient, input: { userId: string; batch: unknown }) {
  const parsed = artifactBatchSchema.safeParse(input.batch)
  if (!parsed.success) throw artifactOpInvalid('the batch does not fit the schema')
  // The form of a secret is looked for in the words as typed: the canonical form escapes some
  // of their signs (`ghp\_…`), and the check after it would miss them (Ар19).
  if (artifactBatchHasSecretShape(parsed.data)) throw artifactSecretShape()
  const actor = actorOf(input.userId)
  const replaced = parsed.data.ops.flatMap((op) => (op.op === 'replace' ? [op] : []))
  const current =
    replaced.length > 0
      ? await readArtifact(db, { artifactId: parsed.data.artifactId, actor })
      : null
  const byKey = new Map((current?.blocks ?? []).map((block) => [block.key, block]))
  const sections = new Set(
    [...byKey.values()].filter((block) => block.kind === 'section').map((block) => block.key),
  )
  const batch = canonicalBatch(parsed.data, sections)
  if (replaced.length > 0) {
    const tidy = replaced.flatMap((op) => {
      const block = byKey.get(op.block)
      if (!block || block.kind !== 'section' || block.rev !== op.ifRev || block.content === null)
        return []
      const canonical = canonicalSection(block.content)
      return canonical === block.content
        ? []
        : [
            {
              op: 'replace' as const,
              block: op.block,
              ifRev: op.ifRev,
              content: canonical,
            },
          ]
    })
    if (tidy.length > 0) {
      const tidied = await applyArtifactOps(db, {
        batch: { artifactId: batch.artifactId, opId: `canon-${randomUUID()}`, ops: tidy },
        actor,
      })
      const revs = new Map(tidied.blocks.map((block) => [block.key, block.rev]))
      batch.ops = batch.ops.map((op) =>
        op.op === 'replace' && revs.has(op.block) ? { ...op, ifRev: revs.get(op.block)! } : op,
      )
    }
  }
  return applyArtifactOps(db, { batch, actor })
}

export async function holdCabinetBlock(
  db: PrismaClient,
  input: { userId: string; artifactId: string; block: string },
) {
  const { rev, until } = await holdArtifactBlock(db, input)
  return { rev, until: until.toISOString() }
}

export const releaseCabinetBlock = (
  db: PrismaClient,
  input: { userId: string; artifactId: string; block: string },
) => releaseArtifactBlock(db, input)

/** «Забрать правку» (Ар16, Ар17): the agent's write or claim is dropped, the block is the person's. */
export const takeCabinetBlock = (
  db: PrismaClient,
  input: { userId: string; artifactId: string; block: string },
) => takeArtifactBlock(db, input)

/** «Сохранить текущую как версию…» — named, with a label up to 60 characters (Ар13). */
export const saveCabinetVersion = (
  db: PrismaClient,
  input: { userId: string; artifactId: string; label: string },
) =>
  saveArtifactVersion(db, {
    artifactId: input.artifactId,
    actor: actorOf(input.userId),
    label: input.label,
  })

/**
 * The chats of this artifact of the reader alone (Ар48): a chat of someone else is never opened.
 * The newest first — the page opens the last one.
 */
export async function cabinetArtifactChats(
  db: PrismaClient,
  input: { userId: string; artifactId: string },
) {
  await readArtifact(db, { artifactId: input.artifactId, actor: actorOf(input.userId) })
  const rows = await db.artifactChat.findMany({
    where: {
      artifactId: input.artifactId,
      how: { not: 'read' },
      task: { createdById: input.userId, deletedAt: null },
    },
    orderBy: { lastAt: 'desc' },
    take: 20,
    select: { lastAt: true, task: { select: { id: true, title: true } } },
  })
  return rows.map((row) => ({
    taskId: row.task.id,
    title: row.task.title,
    lastAt: row.lastAt.toISOString(),
  }))
}
