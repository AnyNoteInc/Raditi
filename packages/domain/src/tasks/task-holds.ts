/**
 * How long the reserve of a dialog lives before the sweeper of the queue may give it back
 * (`expireTaskHolds`; docs/plan/53-chat-preview-release.md, Р8). A dialog keeps its reserve
 * while it is queued or waits for the client. Every writer that queues a pass or waits moves the
 * expiry with `taskHoldExpiry` (`placeCreditHold`, `extendTaskHolds` of @repo/billing).
 */
export const taskHoldHours = Object.freeze({
  /** Queued, or waiting for the client. */
  waiting: 72,
})
export type TaskHoldHorizon = keyof typeof taskHoldHours

const HOUR_MS = 60 * 60 * 1000

/** When the reserve of a dialog may be given back if nothing moves it again. */
export const taskHoldExpiry = (now: Date, horizon: TaskHoldHorizon): Date =>
  new Date(now.getTime() + taskHoldHours[horizon] * HOUR_MS)
