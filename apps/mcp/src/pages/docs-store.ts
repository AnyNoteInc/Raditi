import {
  admitInWindow,
  createChatDocument,
  insertFeedEvent,
  moveDocSection,
  readChatDocument,
  removeDocSection,
  requestDocFinish,
  writeDocSection,
  type PrismaClient,
} from '@repo/db'
import { pageLimits } from '@repo/domain'

import type { McpDocsStore } from './docs-service.ts'

/** The store of the agent's documents: @repo/db, the counter of writes and the feed of the chat. */
export function postgresDocsStore(db: PrismaClient, now: () => number = Date.now): McpDocsStore {
  return {
    create: (input) => createChatDocument(db, input),
    write: (input) => writeDocSection(db, input),
    remove: (input) => removeDocSection(db, input),
    move: (input) => moveDocSection(db, input),
    // The agent reads what its chat wrote before the check, another chat's only after (Ст19).
    read: (input) => readChatDocument(db, { ...input, reader: 'agent' }),
    finish: (input) => requestDocFinish(db, input),
    admitWrite: (taskId, turnNo) =>
      admitInWindow(db, {
        key: `doc-writes:${taskId}:${turnNo}`,
        limit: pageLimits.sectionWritesPerTurn,
        windowMs: 24 * 60 * 60 * 1000,
        now: now(),
      }),
    feed: async (taskId, turnNo, row) => {
      const turn = await db.taskTurn.findFirst({ where: { taskId, turnNo }, select: { id: true } })
      await insertFeedEvent(db, { taskId, turnId: turn?.id ?? null, row })
    },
  }
}
