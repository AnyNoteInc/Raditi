import { conflict, type DomainError } from '../errors.ts'

/** Task statuses — spec §7. The only allowed values anywhere in the platform. */
export const taskStatuses = [
  'queued',
  'preparing',
  'running',
  'awaiting_user',
  'awaiting_approval',
  'deploying',
  'verifying',
  'done',
  'failed',
  'rolled_back',
  'cancelled',
] as const

export type TaskStatus = (typeof taskStatuses)[number]

export const terminalTaskStatuses: readonly TaskStatus[] = [
  'done',
  'failed',
  'rolled_back',
  'cancelled',
]

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['preparing', 'cancelled'],
  // the site is busy with another operation (SITE_BUSY): back to the queue, not a failure
  preparing: ['running', 'queued', 'failed', 'cancelled'],
  // content-only changes finish right away; code changes wait for "Применить"
  running: ['awaiting_user', 'awaiting_approval', 'done', 'failed', 'cancelled'],
  // the client's answer starts the next turn of the same task
  awaiting_user: ['queued', 'cancelled'],
  // "Применить" → deploying; "Изменить" → next turn; "Отмена" → cancelled
  awaiting_approval: ['deploying', 'queued', 'cancelled'],
  deploying: ['verifying', 'rolled_back', 'failed'],
  verifying: ['done', 'rolled_back'],
  done: [],
  // "Попробовать ещё" re-queues the same task
  failed: ['queued'],
  rolled_back: [],
  cancelled: [],
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to)
}

export function nextStatuses(from: TaskStatus): readonly TaskStatus[] {
  return transitions[from]
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw invalidTransition(from, to)
}

const invalidTransition = (from: TaskStatus, to: TaskStatus): DomainError =>
  conflict(`Task cannot move from ${from} to ${to}`)
