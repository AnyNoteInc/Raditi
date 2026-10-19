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
  // the site is busy with another operation (SITE_BUSY): back to the queue, not a failure.
  // The key of the pass cannot cover a first call: the platform asks «Продолжить?» before a
  // turn — awaiting_approval when the dialog has a candidate (docs/plan/53-chat-preview-release.md, Р8).
  preparing: ['running', 'queued', 'awaiting_user', 'awaiting_approval', 'failed', 'cancelled'],
  // a pass that left a candidate waits for `/release` (Р6); one that changed nothing and had no
  // candidate ends the dialog (Р7)
  running: ['awaiting_user', 'awaiting_approval', 'done', 'failed', 'cancelled'],
  // the client's answer starts the next turn of the same task
  awaiting_user: ['queued', 'cancelled'],
  // `/release` → deploying; the client's words → the next pass over the candidate; `/cancel` →
  // cancelled. «Обновить» that finds the whole change on main already leaves nothing to release:
  // done, as a pass without changes (docs/plan/53-chat-preview-release.md, Р6, Р7, R3).
  awaiting_approval: ['deploying', 'queued', 'cancelled', 'done'],
  // A release refused without a write to the hosting (a conflict, an outdated candidate, a job
  // that did not start) returns the dialog to its candidate (docs/plan/53-chat-preview-release.md, Р6).
  deploying: ['verifying', 'awaiting_approval', 'rolled_back', 'failed'],
  verifying: ['done', 'rolled_back'],
  done: [],
  // Declared, no procedure takes it: «Попробовать ещё» is awaiting_approval → queued, for a
  // dialog that kept its candidate (spec §7)
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
