import { feedRowSchema, type FeedRow } from '@repo/domain'

import type { Prisma } from './generated/prisma/client.ts'

/** The client or an interactive-transaction client: anything that can write feed rows. */
export type FeedWriter = Pick<Prisma.TransactionClient, 'taskEvent'>

export interface FeedEventInput {
  taskId: string
  /** `task_turns.id` when the row belongs to a turn that has a row. */
  turnId?: string | null
  /** A row of the client feed: its type and strict payload (docs/research/2026-10-client-feed). */
  row: FeedRow
}

/**
 * Writes one row of the client feed into `task_events` in the caller's transaction and returns
 * its id — the cursor of `task.feed` and the id a question is answered by. The payload passes
 * the strict write schema here, so a bad row fails the transaction that would have written it
 * (spec §7, «Лента для клиента»); `client_visible` is what the CHECK
 * `task_events_feed_visible_check` requires of a `feed.*` type. Rows are never rewritten.
 */
export async function insertFeedEvent(db: FeedWriter, input: FeedEventInput): Promise<bigint> {
  const row = feedRowSchema.parse(input.row)
  const created = await db.taskEvent.create({
    data: {
      taskId: input.taskId,
      turnId: input.turnId ?? null,
      type: row.type,
      payload: row.payload as Prisma.InputJsonValue,
      clientVisible: true,
    },
    select: { id: true },
  })
  return created.id
}
