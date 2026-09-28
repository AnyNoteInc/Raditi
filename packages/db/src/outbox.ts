import { queueNames, type QueueName } from '@repo/domain'
import { z } from 'zod'

import type { Prisma } from './generated/prisma/client.ts'

/** The client or an interactive-transaction client: anything that can write outbox rows. */
export type OutboxWriter = Pick<Prisma.TransactionClient, 'outboxEvent'>

export interface OutboxMessage {
  /** BullMQ queue the relay publishes to. */
  topic: QueueName
  /** Job name inside the queue, e.g. "auth.verify_email". */
  type: string
  /** The relay clears it after publishing: payloads may carry one-time links. */
  payload: Prisma.InputJsonValue
  /** Idempotency key: when a row with this key exists, nothing is written. */
  dedupeKey?: string
  /** Earliest publish time; defaults to now. */
  availableAt?: Date
}

const outboxMessageSchema = z.object({
  topic: z.enum(queueNames),
  type: z.string().min(1).max(128),
  dedupeKey: z.string().min(1).max(255).optional(),
  availableAt: z.date().optional(),
})

/**
 * Writes an outbox row, normally inside the same transaction as the business change.
 * A duplicate dedupeKey is skipped (INSERT … ON CONFLICT DO NOTHING).
 * Returns false when the row was skipped.
 */
export async function enqueueOutbox(db: OutboxWriter, message: OutboxMessage): Promise<boolean> {
  const { topic, type, dedupeKey, availableAt } = outboxMessageSchema.parse(message)
  const { count } = await db.outboxEvent.createMany({
    data: [{ topic, type, payload: message.payload, dedupeKey, availableAt }],
    skipDuplicates: true,
  })
  return count === 1
}
