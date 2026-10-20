import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { wakeRelease, wakeUndoPlan, type PrismaClient } from '@repo/db'
import { UNDO_PLAN_PENDING_MS } from '@repo/domain'
import { z } from 'zod'

import { DEPLOY_RUN_CHECK_MS } from './release-row.ts'

/** How often the sweeper of releases looks. */
export const RELEASE_SWEEP_INTERVAL_MS = 60_000
/** A release left alone this long is woken: its job was lost, or a step waits for a retry. */
const QUIET_SECONDS = 120
/** Releases woken by one pass at most. */
const BATCH = 100
/** A plan of an undo no undo was confirmed with is removed after this. */
const UNDO_PLAN_KEEP_HOURS = 24

/**
 * The sweeper of releases (docs/plan/53-chat-preview-release.md, «Очереди и задания»: `core`
 * wakes `release.advance` too). It decides nothing itself: it wakes, through the outbox, each
 * release that needs a run and has had none for a while —
 *
 *   - `approved` and `publishing`: their job was lost, or a retry is due;
 *   - `published`, `deploying`, `verifying`, `rolling_back` near or past the deadline of their
 *     token (DEPLOY_RUN_CHECK_MS): the job did not start, went silent, or its run is asked about;
 *   - an end still holding the barrier of its site (`installed`, `failed`, `rolled_back`, and
 *     `unknown`) and not held for the operator — never marked, or handed back by
 *     `releases:resolve`;
 *   - `installed` whose dialog is not `done` yet: its charge waits for open usage.
 *
 * And the plans of «Отменить выпуск» (docs/plan/53, «Отмена выпуска»): a plan left `pending`
 * longer than UNDO_PLAN_PENDING_MS is asked for again (its job was lost); one no undo was
 * confirmed with is removed after UNDO_PLAN_KEEP_HOURS.
 *
 * The run of the skill reads the row and does the rest; every wake-up raises `enqueues`, so a
 * release is woken at most once per QUIET_SECONDS by the sweeper.
 */
export class ReleaseSweep {
  readonly #logger: { warn(message: string): void }

  constructor(
    private readonly db: PrismaClient,
    logger?: { warn(message: string): void },
  ) {
    this.#logger = logger ?? new Logger('ReleaseSweep')
  }

  async tick(): Promise<number> {
    const due = z.array(z.object({ id: z.uuid() })).parse(
      await this.db.$queryRaw`
        SELECT r.id FROM site_releases r
        LEFT JOIN site_leases l ON l.inflight_release_id = r.id
        JOIN tasks t ON t.id = r.task_id
        WHERE r.updated_at < clock_timestamp() - ${QUIET_SECONDS}::int * interval '1 second'
          AND (
            r.status IN ('approved', 'publishing')
            OR (r.status IN ('published', 'deploying', 'verifying', 'rolling_back')
              AND r.deploy_token_expires_at <= clock_timestamp()
                + ${DEPLOY_RUN_CHECK_MS}::int * interval '1 millisecond')
            OR (r.status IN ('installed', 'failed', 'rolled_back') AND l.site_id IS NOT NULL
              AND NOT l.held_for_operator)
            OR (r.status = 'unknown' AND l.site_id IS NOT NULL AND NOT l.held_for_operator)
            OR (r.status = 'installed' AND t.status IN ('deploying', 'verifying'))
          )
        ORDER BY r.updated_at
        LIMIT ${BATCH}`,
    )
    let woken = 0
    for (const { id } of due) {
      try {
        await this.db.$transaction(async (tx) => {
          await wakeRelease(tx, { releaseId: id })
        })
        woken++
      } catch {
        this.#logger.warn(`release_sweep_wake_failed release=${id}`)
      }
    }
    return woken + (await this.#plans())
  }

  async #plans(): Promise<number> {
    const pending = z.array(z.object({ id: z.uuid() })).parse(
      await this.db.$queryRaw`
        SELECT id FROM release_undo_plans
        WHERE status = 'pending'
          AND updated_at < clock_timestamp() - ${UNDO_PLAN_PENDING_MS}::int * interval '1 millisecond'
        ORDER BY updated_at
        LIMIT ${BATCH}`,
    )
    let woken = 0
    for (const { id } of pending) {
      try {
        if (await this.db.$transaction((tx) => wakeUndoPlan(tx, { planId: id }))) woken++
      } catch {
        this.#logger.warn(`undo_plan_sweep_wake_failed plan=${id}`)
      }
    }
    await this.db.$queryRaw`
      DELETE FROM release_undo_plans p
      WHERE p.created_at < clock_timestamp() - ${UNDO_PLAN_KEEP_HOURS}::int * interval '1 hour'
        AND NOT EXISTS (SELECT 1 FROM site_releases r WHERE r.undo_plan_id = p.id)
      RETURNING p.id`
    return woken
  }
}

/** Runs the sweeper on a timer in the background process of core only. */
export class ReleaseSweepRuntime implements OnApplicationBootstrap, OnModuleDestroy {
  #timer: NodeJS.Timeout | undefined
  #pending: Promise<unknown> | undefined
  #closing = false

  constructor(
    private readonly sweep: Pick<ReleaseSweep, 'tick'>,
    private readonly background: boolean,
    private readonly logger: { warn(message: string): void } = new Logger('ReleaseSweep'),
  ) {}

  onApplicationBootstrap(): void {
    if (!this.background || this.#timer || this.#closing) return
    this.#timer = setInterval(() => void this.tick(), RELEASE_SWEEP_INTERVAL_MS)
    this.#timer.unref()
    void this.tick()
  }

  tick(): Promise<unknown> {
    if (this.#closing) return Promise.resolve()
    if (this.#pending) return this.#pending
    const pending = this.sweep
      .tick()
      .catch(() => this.logger.warn('release_sweep_failed'))
      .finally(() => {
        if (this.#pending === pending) this.#pending = undefined
      })
    this.#pending = pending
    return pending
  }

  async onModuleDestroy(): Promise<void> {
    this.#closing = true
    clearInterval(this.#timer)
    this.#timer = undefined
    await this.#pending
  }
}
