import { gitJobNames, queueNames, type QueueName } from '@repo/domain'
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

/**
 * `git.repo.forget` (docs/plan/84-projects.md, ПР20): in the transaction that deletes the row of a
 * repository of a project — «Отключить репозиторий», the purge of its project — so that core
 * removes its mirror and bundles from the volume once the row is gone.
 */
export function enqueueRepoForget(db: OutboxWriter, projectRepositoryId: string): Promise<boolean> {
  return enqueueOutbox(db, {
    topic: 'git',
    type: gitJobNames.repoForget,
    payload: { projectRepositoryId },
    dedupeKey: `git.repo.forget:${projectRepositoryId}`,
  })
}

/** What the row of a repository held of its hook (slice 84.26): enough to remove it after the row. */
export interface RepoHookRow {
  id: string
  connectionId: string | null
  host: string
  path: string
  providerRepoId: string | null
  hookId: string | null
}

/** The columns `enqueueRepoGone` reads: select them on the rows about to be deleted. */
export const repoHookSelect = {
  id: true,
  connectionId: true,
  host: true,
  path: true,
  providerRepoId: true,
  hookId: true,
} as const

/**
 * The row of a repository is deleted in this transaction («Отключить репозиторий», the purge of a
 * project): core removes its mirror (`git.repo.forget`, ПР20) and, when it made one, the hook at
 * the provider by the same connection (`git.hook.remove`, slice 84.26) — the row is gone by then,
 * so the job names the hook by what the row held.
 */
export async function enqueueRepoGone(db: OutboxWriter, row: RepoHookRow): Promise<void> {
  await enqueueRepoForget(db, row.id)
  if (row.hookId === null || row.connectionId === null || row.providerRepoId === null) return
  await enqueueOutbox(db, {
    topic: 'git',
    type: gitJobNames.hookRemove,
    payload: {
      connectionId: row.connectionId,
      host: row.host,
      path: row.path,
      providerRepoId: row.providerRepoId,
      hookId: row.hookId,
    },
    dedupeKey: `git.hook.remove:${row.id}:${row.hookId}`,
  })
}
