import {
  addAgentCommentReply,
  admitInWindow,
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
  readChatArtifactComments,
  reserveArtifactFile,
  reserveArtifactImport,
  saveArtifactVersion,
  setArtifactView,
  type PrismaClient,
} from '@repo/db'

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
    access: (taskId, artifactId) => chatArtifactAccess(db, { taskId, artifactId }),
    list: (input) => listChatArtifacts(db, input),
    read: async (actor, artifactId) => {
      const artifact = await readArtifact(db, { artifactId, actor })
      const intents = await db.artifactBlock.findMany({
        where: { documentId: artifactId, deletedRev: null },
        select: { sectionKey: true, intent: true, leaseIntent: true, pendingTaskId: true },
      })
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
    comments: (taskId, artifactId) =>
      readChatArtifactComments(db, { taskId, ...(artifactId === undefined ? {} : { artifactId }) }),
    reply: (input) => addAgentCommentReply(db, { ...input, now: new Date(now()) }),
  }
}
