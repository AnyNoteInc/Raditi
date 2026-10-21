import { Prisma, type PrismaClient } from '@repo/db'
import {
  callSignalSchema,
  callUsageSchema,
  estimatedCacheReadTokens,
  limitResetPlausible,
  llmCallCostRub,
  refusalForSignal,
  type CallUsage,
  type GatewayRefusal,
  type LlmModelPrices,
} from '@repo/domain'
import { z } from 'zod'

import {
  decodeLimitWindows,
  GatewayRecordRejected,
  limitWindowColumns,
  policyFlaggedEvent,
  type GatewayFinish,
} from './gateway-types.ts'

type Transaction = Prisma.TransactionClient
type Database = Pick<PrismaClient, '$transaction' | '$queryRaw'>
const transactionOptions = { maxWait: 5_000, timeout: 10_000 }

/**
 * How long an account stays held after its third completed call without usage, and after a
 * breaker trial is admitted: admission and closing read it alike.
 */
export const USAGE_BREAKER_MS = 15 * 60_000

/** Every outcome the gateway closes a call with; exported so unit tests hold the server to it. */
export const gatewayFinishSchema = z
  .strictObject({
    state: z.enum(['completed', 'failed', 'aborted', 'lost']),
    usage: callUsageSchema.refine((usage) =>
      Object.values(usage).every((value) => value <= 2_147_483_647),
    ),
    estimated: z.boolean(),
    billable: z.boolean(),
    estimateReason: z
      .enum(['aborted_client', 'aborted_platform', 'lost', 'no_usage', 'invalid_usage'])
      .nullable(),
    responseBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    upstreamStatus: z.number().int().min(100).max(599).optional(),
    signal: callSignalSchema.optional(),
  })
  .refine((value) => value.estimated === (value.estimateReason !== null))
  .refine(
    (value) =>
      value.billable === !['aborted_platform', 'lost'].includes(value.estimateReason ?? ''),
  )
  .refine((value) => value.state !== 'lost' || value.estimateReason === 'lost')

// The event type goes into SQL as a literal of this constant, never as a bind parameter: only
// then can the planner prove, for every plan, that the partial index on that type applies.
if (!/^[a-z_.]+$/.test(policyFlaggedEvent)) throw new Error('Unsafe policy event literal')
/** The content-refusal event type as an SQL literal, for every statement that reads or writes it. */
export const policyFlaggedLiteral = Prisma.raw(`'${policyFlaggedEvent}'`)

/**
 * The transaction every write of the gateway and of the revocation of a turn key runs in.
 * Prisma's callback timeout cannot cancel an in-flight SQL statement: PostgreSQL bounds row and
 * DDL waits and query execution itself, and LOCAL never changes the pool.
 */
export function gatewayTransaction<T>(
  db: Pick<PrismaClient, '$transaction'>,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('lock_timeout', '1000ms', true),
        set_config('statement_timeout', '5000ms', true)`
    return work(tx)
  }, transactionOptions)
}

export interface LlmCallLedgerOptions {
  /** How old an open call is before the collector closes it as lost: eleven minutes at least. */
  lostAfterMs?: number
  logger?: { warn(message: string): void }
}

/**
 * The closing half of gateway accounting: the outcome of a call, its usage row and the state
 * of its key and account. The llm role closes the calls it admitted; core's credential sweeper
 * closes what the role left open, with its longer crash allowance. Every close locks
 * key → account → call, as admission does.
 */
export class LlmCallLedger {
  readonly #db: Database
  readonly #lostAfterMs: number
  readonly #logger: { warn(message: string): void }

  constructor(db: Database, options: LlmCallLedgerOptions = {}) {
    this.#db = db
    this.#logger = options.logger ?? { warn: () => {} }
    this.#lostAfterMs = z
      .number()
      .int()
      .min(11 * 60_000)
      .max(Number.MAX_SAFE_INTEGER)
      .parse(options.lostAfterMs ?? 11 * 60_000)
  }

  /** False means another closer or the stale-call collector already closed this call. */
  async finish(callId: string, outcome: GatewayFinish): Promise<boolean> {
    const id = z.uuid().safeParse(callId)
    const value = gatewayFinishSchema.safeParse(outcome)
    if (!id.success || !value.success) throw new GatewayRecordRejected()
    try {
      return await this.#close(callId, value.data)
    } catch (error) {
      throw permanent(error) ? new GatewayRecordRejected() : error
    }
  }

  /** Close calls older than the allowance using estimates and mark revoked keys with no open calls. */
  async collectLost(): Promise<number> {
    const calls = await gatewayTransaction(
      this.#db,
      (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM llm_calls
      WHERE state = 'open' AND started_at < clock_timestamp() - (${this.#lostAfterMs} * interval '1 millisecond')
      ORDER BY started_at LIMIT 1000`,
    )
    // Only an unreadable list fails the pass. A row that cannot be closed now (a lock held
    // elsewhere, a missing rate) stays open with its reservation counted and is retried next
    // pass; it must not stop the other rows or close admission for every turn.
    let closed = 0
    for (const call of calls) {
      try {
        if (await this.#close(call.id, null)) closed += 1
      } catch {
        this.#logger.warn(JSON.stringify({ event: 'llm_collector_row_failed', kind: 'call' }))
      }
    }
    const keys = await gatewayTransaction(
      this.#db,
      (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM llm_keys
      WHERE revoked_at IS NOT NULL AND usage_closed_at IS NULL LIMIT 1000`,
    )
    for (const key of keys) {
      try {
        await gatewayTransaction(this.#db, async (tx) => {
          await tx.$queryRaw`SELECT id FROM llm_keys WHERE id = ${key.id}::uuid FOR UPDATE`
          // Fresh after the row wait: an older admission may have just committed its open call.
          await tx.$queryRaw`UPDATE llm_keys k SET usage_closed_at = clock_timestamp()
          WHERE k.id = ${key.id}::uuid AND k.revoked_at IS NOT NULL AND k.usage_closed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM llm_calls c WHERE c.key_id = k.id AND c.state = 'open')`
        })
      } catch {
        this.#logger.warn(JSON.stringify({ event: 'llm_collector_row_failed', kind: 'key' }))
      }
    }
    return closed
  }

  async #close(callId: string, outcome: GatewayFinish | null): Promise<boolean> {
    return gatewayTransaction(this.#db, async (tx) => {
      const selected = await tx.llmCall.findUnique({
        where: { id: callId },
        select: { keyId: true, subscriptionAccountId: true },
      })
      if (!selected) return false
      await tx.$queryRaw`SELECT id FROM llm_keys WHERE id = ${selected.keyId}::uuid FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM subscription_accounts WHERE id = ${selected.subscriptionAccountId}::uuid FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM llm_calls WHERE id = ${callId}::uuid FOR UPDATE`
      const call = await tx.llmCall.findUniqueOrThrow({
        where: { id: callId },
        include: { key: true, model: true },
      })
      if (call.state !== 'open') return false
      const [clock] = await tx.$queryRaw<{ instant: Date }[]>`SELECT clock_timestamp() AS instant`
      const now = clock!.instant
      if (outcome === null && call.startedAt.getTime() >= now.getTime() - this.#lostAfterMs)
        return false
      const price = await tx.llmModelPrice.findFirst({
        where: { modelId: call.modelId, effectiveFrom: { lte: call.startedAt } },
        orderBy: { effectiveFrom: 'desc' },
      })
      if (!price) throw new GatewayRecordRejected('Missing historical LLM accounting rate')
      const rates = modelPrices(price)
      let value: GatewayFinish
      let costRub: string
      if (outcome === null) {
        // est_in excludes image and encrypted bytes; only calls older than it fall back.
        const input = call.estimatedInputTokens ?? Math.ceil(call.requestBytes / 3)
        value = {
          state: 'lost',
          usage: {
            input,
            // The share admission reserved with: the calls completed before this one started.
            cacheRead: estimatedCacheReadTokens(
              {
                estimatedInputTokens: input,
                lastCompletedUsage: await lastCompletedUsage(
                  tx,
                  call.key.taskId,
                  call.key.taskAttempt,
                  call.startedAt,
                ),
              },
              rates,
            ),
            cacheWrite: 0,
            output: call.model.reserveOutputTokens,
            reasoning: 0,
          },
          estimated: true,
          billable: false,
          estimateReason: 'lost',
          responseBytes: 0,
        }
        // A platform failure never takes more of the attempt ceiling than the call reserved,
        // whatever happened to the rows this estimate is rebuilt from.
        const estimate = new Prisma.Decimal(llmCallCostRub(value.usage, rates))
        costRub = Prisma.Decimal.min(estimate, call.reservedRub).toFixed(10)
      } else {
        value = outcome
        costRub = llmCallCostRub(value.usage, rates)
      }
      const updated = await tx.llmCall.updateMany({
        where: { id: callId, state: 'open' },
        data: {
          state: value.state,
          finishedAt: now,
          responseBytes: BigInt(value.responseBytes),
          upstreamStatus: value.upstreamStatus ?? null,
          signal: value.signal?.kind ?? null,
        },
      })
      if (updated.count !== 1) return false
      await tx.tokenUsage.create({
        data: {
          gatewayCallId: callId,
          keyId: call.keyId,
          subscriptionAccountId: call.subscriptionAccountId,
          taskId: call.key.taskId,
          taskAttempt: call.key.taskAttempt,
          driverId: call.key.driverId,
          modelId: call.modelId,
          priceId: price.id,
          inputUncachedTokens: value.usage.input - value.usage.cacheRead - value.usage.cacheWrite,
          cacheReadTokens: value.usage.cacheRead,
          cacheWriteTokens: value.usage.cacheWrite,
          outputTokens: value.usage.output,
          reasoningTokens: value.usage.reasoning,
          costRub,
          estimated: value.estimated,
          billable: value.billable,
          estimateReason: value.estimateReason,
          occurredAt: call.startedAt,
        },
      })
      const accountData: Prisma.SubscriptionAccountUpdateInput = { lastUsedAt: now }
      const account = await tx.subscriptionAccount.findUniqueOrThrow({
        where: { id: call.subscriptionAccountId },
        select: {
          limitWindows: true,
          coolingUntil: true,
          usageMissingStreak: true,
          breakerOpenUntil: true,
        },
      })
      // Only complete generation terminals test the usage contract. Aborted/failed/lost
      // calls neither increase nor reset the streak, and replayed finishes never reach here.
      if (value.state === 'completed') {
        if (value.estimated) {
          const streak = Math.min(3, account.usageMissingStreak + 1)
          accountData.usageMissingStreak = streak
          if (streak >= 3) {
            const until = new Date(now.getTime() + USAGE_BREAKER_MS)
            accountData.breakerOpenUntil =
              account.breakerOpenUntil !== null && account.breakerOpenUntil > until
                ? account.breakerOpenUntil
                : until
          }
        } else {
          accountData.usageMissingStreak = 0
          accountData.breakerOpenUntil = null
        }
      }
      if (value.signal?.kind === 'window_exhausted') {
        // A reset no window can have is no reset: it must never become a pause of years.
        if (
          value.signal.until !== null &&
          value.signal.until > now &&
          limitResetPlausible(value.signal.until, now)
        ) {
          const until = new Date(value.signal.until.getTime() + 60_000)
          if (account.coolingUntil === null || account.coolingUntil < until)
            accountData.coolingUntil = until
        } else {
          const windows = decodeLimitWindows(account.limitWindows)
          if (!windows?.some((window) => window.usedPct >= 100)) {
            // Authoritative exhaustion with no usable reset cannot reuse an older spare
            // snapshot. Only a fresh probe may restore known capacity.
            Object.assign(accountData, limitWindowColumns([], now))
          }
        }
      }
      await tx.subscriptionAccount.update({
        where: { id: call.subscriptionAccountId },
        data: accountData,
      })
      const refusal =
        value.signal === undefined || value.signal.kind === 'ok'
          ? null
          : refusalForSignal(value.signal)
      if (refusal) await recordRefusal(tx, call.keyId, refusal)
      await tx.$queryRaw`UPDATE llm_keys k SET usage_closed_at = ${now}
        WHERE k.id = ${call.keyId}::uuid AND k.revoked_at IS NOT NULL AND k.usage_closed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM llm_calls c WHERE c.key_id = k.id AND c.state = 'open')`
      return true
    })
  }
}

/**
 * last_refusal is the latest reason only. A content refusal also leaves its task the operator
 * event that no later refusal clears: core must never rebind a flagged task (p3-design §2.5).
 */
export async function recordRefusal(
  tx: Pick<Transaction, '$queryRaw'>,
  keyId: string,
  reason: GatewayRefusal,
): Promise<void> {
  await tx.$queryRaw`UPDATE llm_keys SET last_refusal = ${reason}, last_refusal_at = clock_timestamp()
    WHERE id = ${keyId}::uuid`
  if (reason !== 'policy_flagged') return
  // The key row lock above serializes this check for the key; a task holds one live key.
  await tx.$queryRaw(Prisma.sql`INSERT INTO task_events (task_id, type, payload, client_visible)
    SELECT k.task_id, ${policyFlaggedLiteral},
      jsonb_build_object('attempt', k.task_attempt, 'turn', k.turn_no), false
    FROM llm_keys k WHERE k.id = ${keyId}::uuid AND NOT EXISTS (
      SELECT 1 FROM task_events e WHERE e.task_id = k.task_id
        AND e.type = ${policyFlaggedLiteral})`)
}

/**
 * Data and integrity errors (SQLSTATE classes 22 and 23), a vanished row and an invalid query
 * repeat for the same write. Connection, lock, timeout and serialization failures may pass.
 */
function permanent(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientValidationError) return true
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (error.code === 'P2025') return true
  const adapter = error.meta?.driverAdapterError
  const cause =
    adapter && typeof adapter === 'object' && 'cause' in adapter ? adapter.cause : undefined
  const code =
    cause && typeof cause === 'object' && 'originalCode' in cause ? cause.originalCode : undefined
  return typeof code === 'string' && /^2[23]/.test(code)
}

/** An accounting rate row as `LlmModelPrices`: the reserve and the cost are priced alike. */
export function modelPrices(value: {
  inputPer1m: Prisma.Decimal
  cacheReadPer1m: Prisma.Decimal | null
  cacheWritePer1m: Prisma.Decimal | null
  outputPer1m: Prisma.Decimal
}): LlmModelPrices {
  return {
    inputPer1m: value.inputPer1m.toFixed(6),
    cacheReadPer1m: value.cacheReadPer1m?.toFixed(6) ?? null,
    cacheWritePer1m: value.cacheWritePer1m?.toFixed(6) ?? null,
    outputPer1m: value.outputPer1m.toFixed(6),
  }
}

/**
 * Usage of the last completed call of an attempt, across its turn keys: the cache share of the
 * next reserve. `before` rebuilds what admission saw for a call that started then.
 */
export async function lastCompletedUsage(
  tx: Transaction,
  taskId: string,
  taskAttempt: number,
  before?: Date,
): Promise<CallUsage | null> {
  const row = await tx.tokenUsage.findFirst({
    where: {
      taskId,
      taskAttempt,
      estimated: false,
      call: { state: 'completed', ...(before ? { finishedAt: { lte: before } } : {}) },
    },
    orderBy: [{ call: { finishedAt: 'desc' } }, { gatewayCallId: 'desc' }],
  })
  return row ? usageFromRow(row) : null
}

function usageFromRow(value: {
  inputUncachedTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
}): CallUsage {
  return {
    input: value.inputUncachedTokens + value.cacheReadTokens + value.cacheWriteTokens,
    cacheRead: value.cacheReadTokens,
    cacheWrite: value.cacheWriteTokens,
    output: value.outputTokens,
    reasoning: value.reasoningTokens,
  }
}
