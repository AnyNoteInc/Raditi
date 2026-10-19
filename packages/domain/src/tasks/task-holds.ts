import { previewDefaults } from '../preview/preview-config.ts'

/**
 * How long the reserve of a dialog lives before the sweeper of the queue may give it back
 * (`expireTaskHolds`; docs/plan/53-chat-preview-release.md, Р8). A dialog keeps its reserve
 * while it is queued or waits for the client — with a question or with a candidate to release —
 * and for as long as its preview lives unviewed; a confirmed release keeps it until the release
 * has ended. Every writer that queues a pass, waits or confirms a release moves the expiry with
 * `taskHoldExpiry` (`placeCreditHold`, `extendTaskHolds` of @repo/billing).
 */
export const taskHoldHours = Object.freeze({
  /** Queued, or waiting for the client: the time an unviewed preview lives by default. */
  waiting: previewDefaults.ttlHours,
  /** From the confirmation of a release until it ends; the sweeper skips a release in work. */
  release: 24,
})
export type TaskHoldHorizon = keyof typeof taskHoldHours

const HOUR_MS = 60 * 60 * 1000

/** When the reserve of a dialog may be given back if nothing moves it again. */
export const taskHoldExpiry = (now: Date, horizon: TaskHoldHorizon): Date =>
  new Date(now.getTime() + taskHoldHours[horizon] * HOUR_MS)
