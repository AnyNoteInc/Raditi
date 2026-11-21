import { randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import {
  applyArtifactOps,
  createArtifact,
  createPrismaClient,
  insertFeedEvent,
  settleArtifactWrites,
} from '@repo/db'

import { authEnv, databaseUrl } from '../../fixtures/billing-stand.ts'

// The rows of artifacts the scenarios of «Артефакты» stand on (docs/plan/88-artifacts.md, stage
// Э4): a document of the signed-in user, and the write of an agent in it, as core leaves them. No
// core runs here: what an agent writes is written by @repo/db directly.

export async function addDocument(
  userId: string,
  {
    title,
    sections,
  }: { title: string; sections: readonly { key: string; heading: string; text: string }[] },
): Promise<{ id: string; workspaceId: string }> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const workspace = await prisma.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: authEnv.APP_ENV }),
    )
    const actor = { kind: 'user' as const, userId }
    const { id } = await createArtifact(prisma, {
      workspaceId: workspace.id,
      kind: 'document',
      title,
      actor,
    })
    let after: string | null = null
    const ops = sections.map((section) => {
      const op = {
        op: 'insert' as const,
        block: section.key,
        after,
        kind: 'section' as const,
        content: section.text,
        props: { heading: section.heading },
      }
      after = section.key
      return op
    })
    await applyArtifactOps(prisma, { batch: { artifactId: id, opId: randomUUID(), ops }, actor })
    // The person's lease of the writes ends: an agent may write next.
    await prisma.artifactBlock.updateMany({
      where: { documentId: id },
      data: { leaseHolder: null, leaseUserId: null, leaseUntil: null },
    })
    return { id, workspaceId: workspace.id }
  } finally {
    await prisma.$disconnect()
  }
}

/** Expire the synthetic user's session without reloading any of their open pages. */
export async function expireArtifactReaderSession(userId: string): Promise<void> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const { count } = await prisma.session.updateMany({
      where: { userId },
      data: { expiresAt: new Date(0) },
    })
    if (count === 0) throw new Error('The artifact reader has no session to expire')
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * A chat of the user whose turn made the artifact: its link, the line of the feed after the
 * answer — the tab, «+» and «Результаты» name it from these.
 */
export async function attachToChat(artifactId: string, taskId: string): Promise<void> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    await prisma.artifactChat.create({ data: { artifactId, taskId, how: 'created' } })
    await insertFeedEvent(prisma, {
      taskId,
      row: {
        type: 'feed.artifact',
        payload: { v: 1, artifactId, kind: 'document', created: true },
      },
    })
  } finally {
    await prisma.$disconnect()
  }
}

/** A turn of the chat writes a section and holds it: the check of core has not come yet. */
export async function agentWrites(
  artifactId: string,
  taskId: string,
  { block, text, settle = false }: { block: string; text: string; settle?: boolean },
): Promise<void> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const current = await prisma.artifactBlock.findUniqueOrThrow({
      where: { documentId_sectionKey: { documentId: artifactId, sectionKey: block } },
      select: { rev: true, props: true },
    })
    const answer = await applyArtifactOps(prisma, {
      batch: {
        artifactId,
        opId: randomUUID(),
        ops: [
          {
            op: 'replace',
            block,
            ifRev: current.rev,
            content: text,
            props: current.props as Record<string, string>,
          },
        ],
      },
      actor: { kind: 'agent', taskId, turnNo: 1 },
    })
    if (settle)
      await settleArtifactWrites(prisma, {
        taskId,
        blocks: answer.blocks.map((each) => ({
          artifactId,
          block: each.key,
          rev: each.rev,
          refusal: null,
        })),
        final: true,
      })
  } finally {
    await prisma.$disconnect()
  }
}

/** A mockup of the signed-in user from the template «Калькулятор стоимости» (slice 88.13). */
export async function addMockup(userId: string): Promise<{ id: string }> {
  const { artifactTemplateOf } = await import('@repo/domain/artifacts')
  const template = artifactTemplateOf('cost-calculator')!
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const workspace = await prisma.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: authEnv.APP_ENV }),
    )
    const actor = { kind: 'user' as const, userId }
    const { id } = await createArtifact(prisma, {
      workspaceId: workspace.id,
      kind: 'mockup',
      title: template.title,
      actor,
    })
    let after: string | null = null
    const ops = template.blocks.map((block, at) => {
      const key = `b${at + 1}`
      const op = {
        op: 'insert' as const,
        block: key,
        after,
        kind: block.kind,
        content: block.content,
      }
      after = key
      return op
    })
    await applyArtifactOps(prisma, { batch: { artifactId: id, opId: randomUUID(), ops }, actor })
    await prisma.artifactBlock.updateMany({
      where: { documentId: id },
      data: { leaseHolder: null, leaseUserId: null, leaseUntil: null },
    })
    return { id }
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * An artifact of a template of the gallery (slices 88.15, 88.15а): the canvas «Холст для нового
 * сайта» with its screens and their parts, or the brand, in a project of the user when one is named.
 * The blocks are the person's writes, as «Создать» makes them.
 */
export async function addFromTemplate(
  userId: string,
  templateId: string,
  projectId: string | null = null,
): Promise<{ id: string }> {
  const { artifactTemplateOf } = await import('@repo/domain/artifacts')
  const template = artifactTemplateOf(templateId)!
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const workspace = await prisma.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: authEnv.APP_ENV }),
    )
    const actor = { kind: 'user' as const, userId }
    const { id } = await createArtifact(prisma, {
      workspaceId: workspace.id,
      kind: template.kind,
      title: template.title,
      projectId,
      actor,
    })
    const lastOf = new Map<string | null, string>()
    const ops = template.blocks.map((block, at) => {
      const key = block.key ?? `b${at + 1}`
      const parent = block.parent ?? null
      const props = {
        ...(block.props ?? {}),
        ...(block.heading === undefined ? {} : { heading: block.heading }),
      }
      const op = {
        op: 'insert' as const,
        block: key,
        after: lastOf.get(parent) ?? null,
        ...(parent === null ? {} : { parent }),
        kind: block.kind,
        content: block.content,
        ...(Object.keys(props).length === 0 ? {} : { props }),
      }
      lastOf.set(parent, key)
      return op
    })
    await applyArtifactOps(prisma, { batch: { artifactId: id, opId: randomUUID(), ops }, actor })
    await prisma.artifactBlock.updateMany({
      where: { documentId: id },
      data: { leaseHolder: null, leaseUserId: null, leaseUntil: null },
    })
    return { id }
  } finally {
    await prisma.$disconnect()
  }
}
