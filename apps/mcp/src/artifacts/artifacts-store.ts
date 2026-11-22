import {
  addAgentCommentReply,
  artifactAddressees,
  artifactNamedByRun,
  admitInWindow,
  markArtifactReadOther,
  applyArtifactOps,
  artifactBlocksChangedSince,
  artifactChatNews,
  artifactPlaceholders,
  chatArtifactAccess,
  chatLastRevOf,
  claimArtifactBlock,
  createArtifact,
  discardAgentArtifact,
  insertFeedEvent,
  listChatArtifacts,
  readArtifact,
  artifactDiagramOf,
  saveArtifactDiagram,
  readChatArtifactComments,
  reserveArtifactFile,
  reserveArtifactImport,
  saveArtifactVersion,
  setArtifactView,
  trashArtifact,
  type PrismaClient,
} from '@repo/db'
import { artifactNotFound } from '@repo/domain/artifacts'

import type { McpArtifactsStore } from './artifacts-service.ts'

// Without decorators: the stand `verify:artifacts` loads it from the sources.

const DAY_MS = 24 * 60 * 60 * 1000

/** The store of the family: the functions of @repo/db over the role's database. */
export function postgresArtifactsStore(
  db: PrismaClient,
  now: () => number = Date.now,
): McpArtifactsStore {
  return {
    projectOf: async (taskId) =>
      (await db.task.findUnique({ where: { id: taskId }, select: { projectId: true } }))
        ?.projectId ?? null,
    access: async (taskId, artifactId) => {
      const access = await chatArtifactAccess(db, { taskId, artifactId })
      if (access === null) return null
      // Named in the window of the run's scheduled task (Ар24, 88.20б): the run may change it.
      return { ...access, named: await artifactNamedByRun(db, { taskId, artifactId }) }
    },
    list: (input) => listChatArtifacts(db, input),
    read: async (actor, artifactId) => {
      const artifact = await readArtifact(db, { artifactId, actor })
      const intents = await db.artifactBlock.findMany({
        where: { documentId: artifactId, deletedRev: null },
        select: {
          sectionKey: true,
          intent: true,
          leaseIntent: true,
          pendingTaskId: true,
          writtenByUserId: true,
          writtenTaskId: true,
        },
      })
      // Who wrote each block last (Ар25): another person, or another person's agent, is `other`.
      const client = (
        await db.task.findUnique({ where: { id: actor.taskId }, select: { createdById: true } })
      )?.createdById
      const writerChats = [
        ...new Set(intents.flatMap((each) => (each.writtenTaskId ? [each.writtenTaskId] : []))),
      ]
      const chatOwners = new Map(
        (
          await db.task.findMany({
            where: { id: { in: writerChats } },
            select: { id: true, createdById: true },
          })
        ).map((task) => [task.id, task.createdById]),
      )
      const other = new Set(
        intents
          .filter(
            (each) =>
              (each.writtenByUserId !== null && each.writtenByUserId !== client) ||
              (each.writtenTaskId !== null && chatOwners.get(each.writtenTaskId) !== client),
          )
          .map((each) => each.sectionKey),
      )
      // The chat reads the intent it wrote before the check, others only the checked one (Ар19).
      const intentOf = new Map(
        intents.map((each) => [
          each.sectionKey,
          each.intent ||
            (each.pendingTaskId === actor.taskId ? (each.leaseIntent ?? '') : each.intent),
        ]),
      )
      return {
        ...artifact,
        blocks: artifact.blocks.map((block) => ({
          ...block,
          intent: intentOf.get(block.key) ?? '',
          ...(other.has(block.key) ? { by: 'other' as const } : {}),
        })),
      }
    },
    news: (taskId, artifactId, readSeq) =>
      artifactChatNews(db, { taskId, artifactId, ...(readSeq === undefined ? {} : { readSeq }) }),
    changedSince: (artifactId, sinceSeq) =>
      artifactBlocksChangedSince(db, { artifactId, sinceSeq }),
    discard: (artifactId, taskId, turnNo) =>
      discardAgentArtifact(db, { artifactId, taskId, turnNo }),
    create: (input) => createArtifact(db, input),
    apply: (batch, actor) => applyArtifactOps(db, { batch, actor }),
    diagramTexts: async (taskId, artifactId) => {
      const artifact = await db.artifact.findUnique({
        where: { id: artifactId },
        select: { workspaceId: true, kind: true },
      })
      if (artifact?.kind !== 'diagram') return null
      const blocks = await db.artifactBlock.findMany({
        where: { documentId: artifactId, blockKind: 'diagram', deletedRev: null },
        orderBy: [{ rank: 'asc' }, { sectionKey: 'asc' }],
        select: { sectionKey: true, content: true, pendingContent: true, pendingTaskId: true },
      })
      const texts = []
      for (const block of blocks) {
        // The chat's own text before the check, or the checked one (Ар19).
        const text = block.pendingTaskId === taskId ? block.pendingContent : block.content
        if (!text || text.trim() === '') continue
        const kept = await artifactDiagramOf(db, { artifactId, source: text })
        texts.push({
          block: block.sectionKey,
          text,
          kept: kept
            ? kept.ok
              ? { ok: true as const, width: kept.width ?? 1, height: kept.height ?? 1 }
              : { ok: false as const, line: kept.errorLine, message: kept.errorMessage ?? '' }
            : null,
        })
      }
      return { workspaceId: artifact.workspaceId, texts }
    },
    saveDiagram: (artifactId, text, result) =>
      saveArtifactDiagram(db, { artifactId, source: text, result }),
    claim: (input) => claimArtifactBlock(db, input),
    saveVersion: (artifactId, actor) => saveArtifactVersion(db, { artifactId, actor }),
    placeholders: (artifactId) => artifactPlaceholders(db, artifactId),
    setView: (artifactId, view) => setArtifactView(db, { artifactId, view }),
    lastRev: (taskId, artifactId, block) => chatLastRevOf(db, { taskId, artifactId, block }),
    revision: async (artifactId) =>
      (await db.artifact.findUnique({ where: { id: artifactId }, select: { revision: true } }))
        ?.revision ?? 1,
    reserveFile: (input) => reserveArtifactFile(db, input),
    reserveImport: async (input) => ({
      artifactId: (await reserveArtifactImport(db, input)).artifactId,
    }),
    kindOf: async (artifactId) =>
      (await db.artifact.findUnique({ where: { id: artifactId }, select: { kind: true } }))?.kind ??
      null,
    admit: (key, limit) => admitInWindow(db, { key, limit, windowMs: DAY_MS, now: now() }),
    feed: async (taskId, turnNo, row) => {
      const turn = await db.taskTurn.findFirst({ where: { taskId, turnNo }, select: { id: true } })
      await insertFeedEvent(db, { taskId, turnId: turn?.id ?? null, row })
    },
    markReadOther: async (taskId, turnNo) => {
      await markArtifactReadOther(db, { taskId, turnNo, now: now() })
    },
    readOther: async (taskId, turnNo) =>
      (await db.rateLimit.findUnique({
        where: { key: `artifact-read-other:${taskId}:${turnNo}` },
        select: { key: true },
      })) !== null,
    sharedWithOthers: async (taskId, artifactId) => {
      const client = (
        await db.task.findUnique({ where: { id: taskId }, select: { createdById: true } })
      )?.createdById
      const { owner, others } = await artifactAddressees(db, artifactId)
      return [owner, ...others].some((id) => id !== null && id !== client)
    },
    namedThisPass: async (taskId, turnNo, artifactId) => {
      const turn = await db.taskTurn.findFirst({
        where: { taskId, turnNo },
        select: { startedAt: true, createdAt: true },
      })
      const since = turn?.startedAt ?? turn?.createdAt
      if (!since) return false
      // The client's mention of this request attaches it as the pass begins (Ар47).
      const link = await db.artifactChat.findUnique({
        where: { artifactId_taskId: { artifactId, taskId } },
        select: { how: true, lastAt: true },
      })
      return (
        link !== null &&
        ['attached', 'mentioned'].includes(link.how) &&
        link.lastAt >= new Date(since.getTime() - 60_000)
      )
    },
    comments: (taskId, artifactId) =>
      readChatArtifactComments(db, { taskId, ...(artifactId === undefined ? {} : { artifactId }) }),
    reply: (input) => addAgentCommentReply(db, { ...input, now: new Date(now()) }),
    trash: async (taskId, artifactId) => {
      // The chat acts with the rights of its client (Ар21): the owner check is the client's.
      const task = await db.task.findUnique({
        where: { id: taskId },
        select: { createdById: true },
      })
      if (!task?.createdById) throw artifactNotFound()
      return trashArtifact(db, {
        artifactId,
        userId: task.createdById,
        by: 'agent',
        now: new Date(now()),
      })
    },
  }
}
