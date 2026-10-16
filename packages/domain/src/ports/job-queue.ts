/**
 * Job queue port. The adapter is BullMQ on Redis inside the orchestrator.
 * The truth about a task is tasks.status in PostgreSQL: jobs only move it forward,
 * long waits (awaiting_user, awaiting_approval) are a status plus a delayed timer job.
 * Enqueueing together with a database write goes through outbox_events, never directly.
 */
export const queueNames = [
  'agent-turns',
  'deploys',
  'timers',
  'notifications',
  'site-provisioning',
  'site-import',
  'billing',
] as const
export type QueueName = (typeof queueNames)[number]

export interface EnqueueOptions {
  /**
   * Deterministic id makes enqueueing idempotent, e.g. turn:<taskId>:<turn>. The BullMQ adapter
   * encodes characters BullMQ rejects (':' and integer-like ids), so any string is fine here.
   */
  jobId?: string
  delayMs?: number
  /** Lower runs first (tariff priority). */
  priority?: number
}

export interface JobQueue {
  enqueue(queue: QueueName, name: string, payload: unknown, opts?: EnqueueOptions): Promise<void>
}
