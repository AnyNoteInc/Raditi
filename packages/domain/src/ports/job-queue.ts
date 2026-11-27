/**
 * Job queue port. The adapter is BullMQ on Redis inside the orchestrator.
 * The truth about a task is tasks.status in PostgreSQL: jobs only move it forward,
 * long waits (awaiting_user, awaiting_approval) are a status the lifecycle moves on.
 * Enqueueing together with a database write goes through outbox_events, never directly.
 */
export const queueNames = [
  'agent-turns',
  'notifications',
  'billing',
  // Starting the browser of a task the first time its agent needs it (docs/plan/61-chats-first.md, К11).
  'browser-sessions',
  // Leads of the landing on their way to the Telegram group (docs/plan/65-landing-platforms-leads.md).
  'leads',
  // The bot of the chat in Telegram: its updates in, its messages out (docs/plan/80-telegram.md).
  'telegram',
  'telegram-updates',
  // The git connections and repositories of projects: their checks, lists and first fetch
  // (docs/plan/84-projects.md, §4.3; slice 84.17).
  'git',
  // The tick of the scheduled tasks and the starts of their runs (docs/plan/82-scheduled-tasks.md, Зп19).
  'schedules',
  // The files «Скачать» and the thumbnails of artifacts that core builds (docs/plan/88-artifacts.md).
  'artifacts',
  // Quick edits of artifact notes: one model call of core each (docs/plan/98-quick-edits.md).
  'artifact-edits',
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
