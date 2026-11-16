import { FEED_REQUEST_TEXT_LIMIT } from '../tasks/client-feed-text.ts'

/**
 * The bounds of the scheduled tasks (docs/plan/82-scheduled-tasks.md, §4.1). Constants, not
 * settings: the cabinet, the agent's tools, core and web read the same numbers.
 */
export const scheduleLimits = Object.freeze({
  /** Enabled tasks of a workspace, the same on every tariff (Зп16). */
  activePerWorkspace: 20,
  /** Schedules of one task (Зп7, Зп16); none — «Только вручную». */
  triggersPerTask: 5,
  /** Characters of a name. */
  nameMax: 80,
  /** Characters of the instructions: the words of a request of the chat (Зп26). */
  instructionsMax: FEED_REQUEST_TEXT_LIMIT,
  /** Changes of the tasks one turn of the agent reserves (Зп31). */
  changesPerTurn: 5,
  /** A due moment older than this is not caught up: «Пропущено» (Зп14, Зп15). */
  catchUpHours: 6,
  /** Deliveries of `schedule.start` to web before «сбой платформы» (Зп21). */
  startAttempts: 8,
  /** A run `pending` longer than this is closed by the tick (Зп21). */
  pendingSweepMinutes: 75,
  /**
   * A run of «Запустить сейчас» `pending` longer than this is closed by the sweep of chats: web
   * starts it at once, with no delivery of core to wait for, so one left waiting is a web that
   * stopped mid-request, and it would hold the task up as «Выполняется» (Зп24).
   */
  manualPendingSweepMinutes: 5,
  /** Refusals in a row for a reason of the client before the task is paused (Зп22). */
  refusalsToPause: 3,
  /** «Запустить сейчас» at most once a minute per task (Зп24). */
  manualRunGapMs: 60_000,
  /** «Один раз» from the agent, in minutes from now (Зп15). */
  onceMinMinutes: 5,
  onceMaxMinutes: 43_200,
})

/** Runs of one task closer than this are refused: «не чаще раза в час» (Зп11). */
export const SCHEDULE_MIN_GAP_MINUTES = 60
