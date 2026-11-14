import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'

// What a turn of a model profile takes of the windows of the plan (docs/plan/71-usage-limits.md,
// Л12): p50 and p95 of the plan credits of each turn over 14 days, written as a snapshot the pool
// reads at every issue (`llm_turn_costs`) instead of counting it there. A profile with fewer than
// `minTurns` turns gets no row: a turn is then 5 % of a window, as before.

export const TURN_COST_WINDOW_DAYS = 14
export const TURN_COST_MIN_TURNS = 30
export const TURN_COST_INTERVAL_MS = 60 * 60_000

/** Recomputes the snapshot; returns the profiles it wrote. */
export async function recomputeTurnCosts(
  db: Pick<PrismaClient, '$executeRaw'>,
  input: { days?: number; minTurns?: number } = {},
): Promise<number> {
  const days = input.days ?? TURN_COST_WINDOW_DAYS
  const minTurns = input.minTurns ?? TURN_COST_MIN_TURNS
  // A turn is the plan credits of its calls, by key of the turn (one key per turn); a call the
  // provider has no plan rates for counts nothing and a turn of such calls is not measured.
  return db.$executeRaw`
    WITH turns AS (
      SELECT u.model_id, u.key_id, SUM(u.plan_credits) AS credits
      FROM token_usage u
      WHERE u.occurred_at >= clock_timestamp() - ${days}::int * interval '1 day'
        AND u.plan_credits IS NOT NULL
      GROUP BY u.model_id, u.key_id
    ), costs AS (
      SELECT model_id, count(*)::int AS turns,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY credits) AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY credits) AS p95
      FROM turns GROUP BY model_id
      HAVING count(*) >= ${minTurns}::int
    ), written AS (
      INSERT INTO llm_turn_costs (model_id, turns, p50_plan_credits, p95_plan_credits, computed_at)
      SELECT model_id, turns, round(p50::numeric, 4), round(p95::numeric, 4), clock_timestamp()
      FROM costs
      ON CONFLICT (model_id) DO UPDATE SET turns = excluded.turns,
        p50_plan_credits = excluded.p50_plan_credits, p95_plan_credits = excluded.p95_plan_credits,
        computed_at = excluded.computed_at
      RETURNING model_id
    )
    DELETE FROM llm_turn_costs c
    WHERE NOT EXISTS (SELECT 1 FROM costs WHERE costs.model_id = c.model_id)`
}

/** Runs the recount on a timer in the background process of core only. */
export class TurnCostRuntime implements OnApplicationBootstrap, OnModuleDestroy {
  #timer: NodeJS.Timeout | undefined
  #pending: Promise<unknown> | undefined

  constructor(
    private readonly db: Pick<PrismaClient, '$executeRaw'>,
    private readonly background: boolean,
    private readonly logger: { warn(message: string): void } = new Logger('TurnCosts'),
  ) {}

  onApplicationBootstrap(): void {
    if (!this.background || this.#timer) return
    this.#timer = setInterval(() => void this.tick(), TURN_COST_INTERVAL_MS)
    this.#timer.unref()
    void this.tick()
  }

  tick(): Promise<unknown> {
    this.#pending ??= recomputeTurnCosts(this.db)
      .catch(() => this.logger.warn('turn_costs_failed'))
      .finally(() => {
        this.#pending = undefined
      })
    return this.#pending
  }

  async onModuleDestroy(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
    await this.#pending
  }
}
