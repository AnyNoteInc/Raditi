import { createHash, randomInt, randomUUID } from 'node:crypto'

import {
  ensurePersonalWorkspace,
  type ModelClass,
  type Prisma,
  type PrismaClient,
  type TurnStatus,
} from '@repo/db'
import { creditAccountUnits, Money, type CreditAccountKind } from '@repo/domain'
import {
  YookassaApiError,
  type CreatePaymentInput,
  type CreatePaymentMethodInput,
  type CreateRefundInput,
  type Payment,
  type Refund,
  type SavedPaymentMethod,
} from '@repo/yookassa'

import type { BillingDeps } from './deps.ts'
import { placeCreditHold, type CreditHoldPlacement, type PlacedCreditHold } from './holds.ts'
import type { PaymentMethodDeps } from './payment-method.ts'
import type { RefundDeps } from './refund.ts'
import { paymentLetterKey } from './settlement.ts'

// The posting half of the charge of a done task. The product reaches it through `chargeTask`,
// which reads the usage of the task itself; a test of another package that needs a charged task
// in its database — and no model call behind it — names the credits and calls this.
export { settleTaskCharge } from './holds.ts'

// ─── A model call and what stands behind it ───────────────────────────────────
//
// The writers below take any client — the process-wide one or a transaction — and write rows
// directly, the way the subscription gateway leaves them, without the gateway: a test of the
// charge needs `token_usage`, and that table reaches `llm_calls`, `llm_keys`,
// `subscription_accounts`, `llm_models`, `llm_model_prices` and `agent_drivers` by foreign keys
// under the CHECKs of the subscription_gateway migration. `billingFixtures` has the same
// writers as methods that also remove what they wrote.

class RolledBack extends Error {}

/**
 * Runs `work` in a transaction that never commits and returns what it returned. For tests of
 * what reads the credit rate: a row of `credit_rates` is global, and one that is never
 * committed is seen by no other suite and left on no database.
 */
export async function inRolledBackTransaction<T>(
  db: PrismaClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let result: { value: T } | undefined
  try {
    await db.$transaction(
      async (tx) => {
        result = { value: await work(tx) }
        throw new RolledBack()
      },
      { timeout: 30_000 },
    )
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error
  }
  if (result === undefined) throw new Error('The transaction ended before its work did')
  return result.value
}

type PoolWriter = Pick<
  Prisma.TransactionClient,
  'agentDriver' | 'llmProvider' | 'llmModel' | 'credentialRef' | 'subscriptionAccount'
>

/** A model with what a call of it needs: its provider, a driver and an account of the pool. */
export interface TestModelPool {
  providerId: string
  /** `llm_providers.slug`, unique to the pool. */
  provider: string
  modelId: string
  /** `llm_models.slug`, unique to the pool. */
  model: string
  modelClass: ModelClass
  driverId: string
  accountId: string
  credentialRefId: string
}

export interface TestModelPoolData {
  modelClass?: ModelClass
  /**
   * `llm_models.enabled`. Off unless asked for: an enabled model with a price takes part in
   * the usable-rate check and in `billing:rates` for the whole database.
   */
  enabled?: boolean
}

/** A provider, one model of it, a driver and a subscription account, all of their own. */
export async function writeModelPool(
  db: PoolWriter,
  data: TestModelPoolData = {},
): Promise<TestModelPool> {
  const suffix = randomUUID().replaceAll('-', '')
  const modelClass = data.modelClass ?? 'standard'
  const driver = await db.agentDriver.create({
    data: {
      // agent_drivers.id is varchar(32).
      id: `billing-${suffix.slice(0, 20)}`,
      image: 'registry.invalid/billing-verification',
      capabilities: {},
    },
  })
  const provider = await db.llmProvider.create({
    data: {
      slug: `billing-${suffix}`,
      name: 'Billing verification',
      kind: 'subscription',
      enabled: false,
    },
  })
  const model = await db.llmModel.create({
    data: {
      providerId: provider.id,
      slug: `billing-${suffix}`,
      name: 'Billing verification',
      modelClass,
      enabled: data.enabled ?? false,
    },
  })
  const credential = await db.credentialRef.create({
    data: { kind: 'subscription', vaultPath: `subs/${provider.slug}/verification` },
  })
  const account = await db.subscriptionAccount.create({
    data: {
      providerId: provider.id,
      driverId: driver.id,
      label: `billing-${suffix}`,
      credentialRefId: credential.id,
      plan: 'verification',
      maxConcurrentTurns: 1,
      maxConcurrentRequests: 1,
    },
  })
  return {
    providerId: provider.id,
    provider: provider.slug,
    modelId: model.id,
    model: model.slug,
    modelClass,
    driverId: driver.id,
    accountId: account.id,
    credentialRefId: credential.id,
  }
}

export interface TestModelPriceData {
  effectiveFrom: Date
  inputPer1m?: string
  cacheReadPer1m?: string | null
  cacheWritePer1m?: string | null
  outputPer1m?: string
}

/** A price row of the pool's model: GPT-6 Sol at 4.65 RUB a Codex credit unless told otherwise. */
export function writeModelPrice(
  db: Pick<Prisma.TransactionClient, 'llmModelPrice'>,
  pool: Pick<TestModelPool, 'modelId'>,
  data: TestModelPriceData,
): Promise<{ id: string; effectiveFrom: Date }> {
  return db.llmModelPrice.create({
    data: {
      modelId: pool.modelId,
      effectiveFrom: data.effectiveFrom,
      inputPer1m: data.inputPer1m ?? '232.500000',
      cacheReadPer1m: data.cacheReadPer1m === undefined ? '23.250000' : data.cacheReadPer1m,
      cacheWritePer1m: data.cacheWritePer1m ?? null,
      outputPer1m: data.outputPer1m ?? '1162.500000',
      vatRate: '0.2200',
      sourceUrl: 'https://rates.invalid/billing-verification',
    },
    select: { id: true, effectiveFrom: true },
  })
}

/** Why a usage row is an estimate (`token_usage_estimate_check`). */
export type TestEstimateReason =
  'aborted_client' | 'aborted_platform' | 'lost' | 'no_usage' | 'invalid_usage'

export interface TestModelCallData {
  taskId: string
  pool: TestModelPool
  /** The price row the call was costed with: `token_usage.price_id`. */
  priceId: string
  /** `token_usage.cost_rub`, up to ten decimals: "22.09". Written as given, not computed. */
  costRub: string
  /** The start of the call: `token_usage.occurred_at` and `llm_calls.started_at`. */
  occurredAt: Date
  /** `tasks.attempt` the call belongs to; 1 unless given. */
  attempt?: number
  /**
   * The turn of the key; 1 unless given. The calls of one turn share its key, and a turn
   * belongs to one attempt: a call of another attempt needs a turn of its own, or it is refused.
   */
  turnNo?: number
  /**
   * The usage is an estimate. `aborted_platform` and `lost` — the platform's fault — make the
   * row not billable, as the CHECK of the table demands; the others stay billable.
   */
  estimateReason?: TestEstimateReason
  /**
   * Writes the turn row of (task, turn) with this status, or moves an existing one to it.
   * Without it no turn row is written — as for every call before the task queue of P12.
   */
  turnStatus?: TurnStatus
  /**
   * The accounting of the key is closed (`llm_keys.usage_closed_at`), as after a turn that
   * ended; true unless given. It is set by the call that creates the key of its turn: a later
   * call of the turn that names the other state is refused, one that names none takes the key
   * as it is.
   */
  usageClosed?: boolean
}

export interface TestModelCall {
  usageId: string
  /** `llm_calls.id` and `token_usage.gateway_call_id`. */
  callId: string
  keyId: string
  billable: boolean
}

const PLATFORM_FAULTS: readonly TestEstimateReason[] = ['aborted_platform', 'lost']
const CALL_STATES = {
  aborted_client: 'aborted',
  aborted_platform: 'aborted',
  lost: 'lost',
  no_usage: 'completed',
  invalid_usage: 'completed',
} as const

/**
 * One finished model call of a task as the gateway records it: the turn key (made for the
 * first call of a turn, reused by the next ones), the `llm_calls` row and its `token_usage`
 * row, with the cost the test names. Nothing here goes through the gateway or reads a rate.
 */
export async function writeModelCall(
  db: Pick<Prisma.TransactionClient, 'llmKey' | 'llmCall' | 'tokenUsage' | 'taskTurn'>,
  data: TestModelCallData,
): Promise<TestModelCall> {
  const { taskId, pool, occurredAt, attempt = 1, turnNo = 1, estimateReason } = data
  const finishedAt = new Date(occurredAt.getTime() + 1_000)
  const turn = { taskId, turnNo, firstEpoch: 1 }
  const found = await db.llmKey.findUnique({
    where: { taskId_turnNo_firstEpoch: turn },
    select: { id: true, taskAttempt: true, usageClosedAt: true },
  })
  // The gateway never writes usage of one attempt on the key of another, and a key is open or
  // closed for all its calls. A test that asks for either would get rows that say something
  // else than it asked for: it is refused instead, before anything is written.
  if (found !== null && found.taskAttempt !== attempt) {
    throw new Error(
      `Turn ${turnNo} of the task belongs to attempt ${found.taskAttempt}: ` +
        `give the call of attempt ${attempt} a turn of its own`,
    )
  }
  if (
    found !== null &&
    data.usageClosed !== undefined &&
    data.usageClosed !== (found.usageClosedAt !== null)
  ) {
    throw new Error(
      `The key of turn ${turnNo} is already ${found.usageClosedAt === null ? 'open' : 'closed'}: ` +
        'usageClosed is set by the first call of a turn',
    )
  }
  if (data.turnStatus !== undefined) {
    await db.taskTurn.upsert({
      where: { taskId_turnNo: { taskId, turnNo } },
      create: {
        taskId,
        turnNo,
        status: data.turnStatus,
        driverId: pool.driverId,
        image: 'registry.invalid/billing-verification@sha256:0',
        modelId: pool.modelId,
      },
      update: { status: data.turnStatus },
    })
  }
  const key =
    found ??
    (await db.llmKey.create({
      data: {
        ...turn,
        keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
        taskAttempt: attempt,
        sessionId: 'billing-verification',
        driverId: pool.driverId,
        modelId: pool.modelId,
        subscriptionAccountId: pool.accountId,
        budgetRub: '750',
        issuedAt: new Date(occurredAt.getTime() - 1_000),
        expiresAt: new Date(occurredAt.getTime() + 1_200_000),
        validUntil: new Date(occurredAt.getTime() + 1_800_000),
        // The key of a turn that ended: revoked, and its accounting closed unless told otherwise.
        revokeRequestedAt: finishedAt,
        revokedAt: finishedAt,
        usageClosedAt: data.usageClosed === false ? null : finishedAt,
      },
      select: { id: true },
    }))
  const call = await db.llmCall.create({
    data: {
      keyId: key.id,
      subscriptionAccountId: pool.accountId,
      modelId: pool.modelId,
      route: 'POST /verification',
      state: estimateReason === undefined ? 'completed' : CALL_STATES[estimateReason],
      reservedRub: data.costRub,
      requestBytes: 600,
      startedAt: occurredAt,
      finishedAt,
    },
    select: { id: true },
  })
  const billable = estimateReason === undefined || !PLATFORM_FAULTS.includes(estimateReason)
  const usage = await db.tokenUsage.create({
    data: {
      gatewayCallId: call.id,
      keyId: key.id,
      subscriptionAccountId: pool.accountId,
      taskId,
      taskAttempt: attempt,
      driverId: pool.driverId,
      modelId: pool.modelId,
      priceId: data.priceId,
      inputUncachedTokens: 1_000,
      outputTokens: 50,
      costRub: data.costRub,
      estimated: estimateReason !== undefined,
      estimateReason: estimateReason ?? null,
      billable,
      occurredAt,
    },
    select: { id: true },
  })
  return { usageId: usage.id, callId: call.id, keyId: key.id, billable }
}

export interface TestCreditRateData {
  /** Whole milliseconds, as the CHECK of the table demands; unique in the table. */
  effectiveFrom: Date
  /** K; 6.000000 unless given. */
  rubPerCredit?: string
}

/**
 * A row of `credit_rates`. The table is global: a committed row is the credit rate of the whole
 * database from `effectiveFrom` on, so a test commits one only on a database that is its own.
 */
export function writeCreditRate(
  db: Pick<Prisma.TransactionClient, 'creditRate'>,
  data: TestCreditRateData,
): Promise<{ id: string; effectiveFrom: Date }> {
  return db.creditRate.create({
    data: {
      effectiveFrom: data.effectiveFrom,
      rubPerCredit: data.rubPerCredit ?? '6.000000',
      basis: 'Billing verification',
    },
    select: { id: true, effectiveFrom: true },
  })
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Runs `work` in the caller's transaction under a credit rate that no other transaction ever
 * sees: the row is written before the work and deleted after it. So the transaction may commit
 * what the work wrote — a reserve needs a usable rate to be placed —, and the database is left
 * without a rate, as every other suite that shares it expects.
 *
 * The rate starts at a random whole millisecond of 1 January 2026 unless told otherwise: before
 * every moment the tests of billing stand at, and unlikely to meet the start of another
 * transaction's rate, which would only make the two wait for each other.
 */
export async function underPrivateCreditRate<T>(
  tx: Pick<Prisma.TransactionClient, 'creditRate'>,
  work: () => Promise<T>,
  data: Partial<TestCreditRateData> = {},
): Promise<T> {
  const rate = await writeCreditRate(tx, {
    ...data,
    effectiveFrom: data.effectiveFrom ?? new Date(Date.UTC(2026, 0, 1) + randomInt(DAY_MS)),
  })
  const result = await work()
  await tx.creditRate.delete({ where: { id: rate.id } })
  return result
}

/**
 * The reserve of an attempt, placed the way the product places it — `placeCreditHold`, with
 * every check of a placement — and committed, under a credit rate of its own that is gone when
 * the transaction commits (`underPrivateCreditRate`).
 */
export function placeReserve(
  db: PrismaClient,
  placement: CreditHoldPlacement,
  rate: Partial<TestCreditRateData> = {},
): Promise<PlacedCreditHold> {
  return db.$transaction(
    (tx) => underPrivateCreditRate(tx, () => placeCreditHold(tx, placement), rate),
    // Concurrent placements queue for the connections of the pool and then for one row lock.
    { maxWait: 15_000, timeout: 30_000 },
  )
}

/**
 * Rows for the PostgreSQL tests of this package, and of other packages through
 * `@repo/billing/testing` (test files only: a rule of dependency-cruiser). Every test works in a
 * workspace of its own and `cleanup` removes exactly what the fixtures and the code under test
 * wrote for it, so the tests may share a database with other suites and never read a whole
 * table. The exceptions are said where they are: an enabled model and a row of `credit_rates`
 * belong to the whole database.
 */
export function billingFixtures(db: PrismaClient) {
  const userIds: string[] = []
  const workspaceIds: string[] = []
  const planIds: string[] = []
  const pools: TestModelPool[] = []
  const creditRateIds: string[] = []

  /** A user who has no workspace yet: the code under test creates it. */
  async function user(): Promise<{ userId: string; email: string }> {
    const row = await db.user.create({
      data: { name: 'Billing verification', email: `${randomUUID()}@billing.example.ru` },
    })
    userIds.push(row.id)
    return { userId: row.id, email: row.email }
  }

  return {
    user,

    /**
     * A user and their personal workspace, found the way the product finds it — and nothing
     * else: no gift of the registration, which the product grants with the workspace
     * (`ensurePersonalWorkspaceWithGift`). A test of the gift calls that itself.
     */
    async workspace(): Promise<{ userId: string; workspaceId: string }> {
      const { userId } = await user()
      const workspace = await db.$transaction((tx) =>
        ensurePersonalWorkspace(tx, { userId, appEnv: 'test' }),
      )
      workspaceIds.push(workspace.id)
      return { userId, workspaceId: workspace.id }
    },

    /**
     * A tariff of its own. Not on sale unless asked for, so that nothing that lists plans
     * elsewhere in a shared database ever shows it. No daily cap in credits unless asked for
     * (`creditsPerDay`, never more than `creditsPerMonth`): a test that is not about the day
     * is not bounded by it.
     */
    async plan(data: Partial<Prisma.PlanUncheckedCreateInput> = {}) {
      const plan = await db.plan.create({
        data: {
          slug: `test-${randomUUID()}`,
          name: 'Проверочный',
          kind: 'quota',
          price: '4900.00',
          creditsPerMonth: 30,
          creditsPerDay: null,
          maxSites: 1,
          isActive: false,
          ...data,
        },
      })
      planIds.push(plan.id)
      return plan
    },

    /** A paid subscription order unless told otherwise. */
    order(
      data: Pick<Prisma.OrderUncheckedCreateInput, 'workspaceId' | 'planId'> &
        Partial<Prisma.OrderUncheckedCreateInput>,
    ) {
      return db.order.create({
        data: {
          kind: 'subscription',
          amount: '4900.00',
          status: 'paid',
          idempotenceKey: randomUUID(),
          ...data,
        },
      })
    },

    /** An active subscription for September 2026 unless told otherwise. */
    subscription(
      data: Pick<Prisma.SubscriptionUncheckedCreateInput, 'workspaceId' | 'planId'> &
        Partial<Prisma.SubscriptionUncheckedCreateInput>,
    ) {
      const start = new Date('2026-09-18T09:00:00Z')
      return db.subscription.create({
        data: {
          status: 'active',
          currentPeriodStart: start,
          currentPeriodEnd: new Date('2026-10-18T09:00:00Z'),
          periodAnchor: start,
          ...data,
        },
      })
    },

    /**
     * A queued task of the workspace, on a site of its own: what a reserve is placed for. Its
     * model runs in the class `standard` unless told otherwise, as a new task of the queue.
     */
    async task(
      workspaceId: string,
      data: Partial<Prisma.TaskUncheckedCreateInput> = {},
    ): Promise<{ taskId: string }> {
      const site = await db.site.create({
        data: {
          workspaceId,
          name: 'Billing verification',
          url: `https://${randomUUID()}.example.ru`,
          stack: 'wordpress',
        },
      })
      const task = await db.task.create({
        data: { workspaceId, siteId: site.id, modelClass: 'standard', ...data },
      })
      return { taskId: task.id }
    },

    /**
     * An active hold of a task on one credit account, written directly: the hold row and `held`
     * of the account in one transaction, for any number of credits. `placeCreditHold` is what
     * the product calls.
     */
    async hold(workspaceId: string, kind: CreditAccountKind, credits: number) {
      const unit = creditAccountUnits[kind]
      return db.$transaction(async (tx) => {
        const account = await tx.billingAccount.findUniqueOrThrow({
          where: { workspaceId_unit: { workspaceId, unit } },
        })
        const site = await tx.site.create({
          data: {
            workspaceId,
            name: 'Billing verification',
            url: `https://${randomUUID()}.example.ru`,
            stack: 'wordpress',
          },
        })
        const task = await tx.task.create({ data: { workspaceId, siteId: site.id } })
        await tx.billingAccount.update({
          where: { id: account.id },
          data: { held: { increment: new Money(credits) } },
        })
        return tx.creditHold.create({
          data: {
            accountId: account.id,
            unit,
            taskId: task.id,
            amount: new Money(credits),
            expiresAt: new Date('2030-01-01T00:00:00Z'),
          },
        })
      })
    },

    /**
     * A model of its own with a provider, a driver and a subscription account, committed and
     * removed by `cleanup` with its price rows. Not enabled unless asked for.
     */
    async modelPool(data: TestModelPoolData = {}): Promise<TestModelPool> {
      const pool = await db.$transaction((tx) => writeModelPool(tx, data))
      pools.push(pool)
      return pool
    },

    /** A price row of a pool's model. */
    modelPrice(pool: Pick<TestModelPool, 'modelId'>, data: TestModelPriceData) {
      return writeModelPrice(db, pool, data)
    },

    /**
     * One finished model call of a task of a fixture workspace: its key, its `llm_calls` row
     * and its `token_usage` row. `cleanup` removes them with the workspace.
     */
    modelCall(data: TestModelCallData): Promise<TestModelCall> {
      return db.$transaction((tx) => writeModelCall(tx, data))
    },

    /**
     * A committed row of `credit_rates`, removed by `cleanup`. It is the credit rate of the whole
     * database while it stands: only for a suite that runs on a database of its own.
     */
    async creditRate(data: TestCreditRateData) {
      const rate = await writeCreditRate(db, data)
      creditRateIds.push(rate.id)
      return rate
    },

    /** `placeReserve` for a task of a fixture workspace: `cleanup` removes what it wrote. */
    reserve(placement: CreditHoldPlacement, rate: Partial<TestCreditRateData> = {}) {
      return placeReserve(db, placement, rate)
    },

    async cleanup(): Promise<void> {
      // The workspaces of the fixtures and the ones the code under test created for their users.
      const created = await db.workspace.findMany({
        where: { createdById: { in: userIds } },
        select: { id: true },
      })
      const ids = [...new Set([...workspaceIds.splice(0), ...created.map(({ id }) => id)])]
      const workspaces = { workspaceId: { in: ids } }
      const orders = await db.order.findMany({ where: workspaces, select: { id: true } })
      await db.outboxEvent.deleteMany({
        where: { dedupeKey: { in: orders.map(({ id }) => paymentLetterKey(id)) } },
      })
      await db.creditLedger.deleteMany({ where: { account: workspaces } })
      await db.creditHold.deleteMany({ where: { account: workspaces } })
      await db.billingAccount.deleteMany({ where: workspaces })
      // The sites whose gift a reserve of these workspaces claimed.
      await db.giftSiteClaim.deleteMany({ where: workspaces })
      // The model calls of the tasks; their turn rows go with the tasks.
      await db.tokenUsage.deleteMany({ where: { task: workspaces } })
      await db.llmCall.deleteMany({ where: { key: { task: workspaces } } })
      await db.llmKey.deleteMany({ where: { task: workspaces } })
      await db.task.deleteMany({ where: workspaces })
      await db.site.deleteMany({ where: workspaces })
      await db.order.deleteMany({ where: workspaces })
      await db.subscription.deleteMany({ where: workspaces })
      await db.auditLog.deleteMany({ where: workspaces })
      await db.workspace.deleteMany({ where: { id: workspaces.workspaceId } })
      await db.plan.deleteMany({ where: { id: { in: planIds.splice(0) } } })
      await db.user.deleteMany({ where: { id: { in: userIds.splice(0) } } })
      const made = pools.splice(0)
      const of = (pick: (pool: TestModelPool) => string) => ({ in: made.map(pick) })
      await db.subscriptionAccount.deleteMany({ where: { id: of((pool) => pool.accountId) } })
      await db.credentialRef.deleteMany({ where: { id: of((pool) => pool.credentialRefId) } })
      await db.llmModelPrice.deleteMany({ where: { modelId: of((pool) => pool.modelId) } })
      await db.llmModel.deleteMany({ where: { id: of((pool) => pool.modelId) } })
      await db.llmProvider.deleteMany({ where: { id: of((pool) => pool.providerId) } })
      await db.agentDriver.deleteMany({ where: { id: of((pool) => pool.driverId) } })
      await db.creditRate.deleteMany({ where: { id: { in: creditRateIds.splice(0) } } })
    },
  }
}

/**
 * The gift account of a workspace the gift of the registration was never granted to, as
 * `getCreditBalances` reports it.
 */
export const NO_GIFT = Object.freeze({ balance: 0, held: 0, available: 0, granted: false })

/**
 * The gift account of a workspace the product made — by a first site or by a checkout, both of
 * which grant the gift of the registration with it —, as `getCreditBalances` reports it while
 * nothing of the gift is spent or set aside.
 */
export const GIFT_GRANTED = Object.freeze({ balance: 35, held: 0, available: 35, granted: true })

/**
 * The credits of a workspace the product made, while nothing was paid for or nothing of what
 * was paid was applied: the gift of the registration and no credit of a tariff or of a pack.
 */
export const GIFT_ONLY = Object.freeze({
  tariff: Object.freeze({ balance: 0, held: 0, available: 0 }),
  gift: GIFT_GRANTED,
  pack: Object.freeze({ balance: 0, held: 0, available: 0 }),
  totalAvailable: 35,
})

/** A moment the tests of checkout and settlement stand at. */
export const TEST_NOW = new Date('2026-10-04T12:00:00.000Z')

const TEST_CARD = {
  first6: '220000',
  last4: '4444',
  expiry_month: '12',
  expiry_year: '2030',
  card_type: 'Mir',
}

/**
 * ЮKassa as a script: payments live in memory, a repeated Idempotence-Key answers with the
 * payment of the first request, and the test decides what happens to each payment and which
 * request fails. Every call is recorded.
 */
export function yookassaStub() {
  const payments = new Map<string, Payment>()
  const idByKey = new Map<string, string>()
  const created: { input: CreatePaymentInput; idempotenceKey: string }[] = []
  const reads: string[] = []
  const createFailures: { error: unknown; processed: boolean }[] = []
  const readFailures: unknown[] = []
  let atCreation: Partial<Payment> = {}

  const stored = (paymentId: string): Payment => {
    const payment = payments.get(paymentId)
    if (payment === undefined) throw new Error(`The stub has no payment ${paymentId}`)
    return payment
  }

  function create(input: CreatePaymentInput, idempotenceKey: string): Payment {
    const known = idByKey.get(idempotenceKey)
    if (known !== undefined) return stored(known)
    const id = randomUUID()
    const payment: Payment = {
      id,
      status: 'pending',
      paid: false,
      amount: { value: input.amount.value, currency: 'RUB' },
      created_at: TEST_NOW.toISOString(),
      confirmation: { type: 'redirect', confirmation_url: `https://yookassa.example/pay/${id}` },
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
      ...atCreation,
    }
    atCreation = {}
    payments.set(id, payment)
    idByKey.set(idempotenceKey, id)
    return payment
  }

  const client: BillingDeps['yookassa'] = {
    createPayment(input, idempotenceKey) {
      created.push({ input: structuredClone(input), idempotenceKey })
      const failure = createFailures.shift()
      if (failure !== undefined) {
        if (failure.processed) create(input, idempotenceKey)
        return Promise.reject(failure.error)
      }
      return Promise.resolve(structuredClone(create(input, idempotenceKey)))
    },
    getPayment(paymentId) {
      reads.push(paymentId)
      const failure = readFailures.shift()
      if (failure !== undefined) return Promise.reject(failure)
      const payment = payments.get(paymentId)
      if (payment === undefined) {
        return Promise.reject(new YookassaApiError('not_found', 404, 'not_found', {}))
      }
      return Promise.resolve(structuredClone(payment))
    },
  }

  return {
    client,
    /** Every createPayment request, a failed one included. */
    created,
    /** The payment id of every getPayment request. */
    reads,
    payments,
    /** The one payment the test made. */
    only(): Payment {
      const [payment, ...others] = [...payments.values()]
      if (payment === undefined || others.length > 0) {
        throw new Error(`The stub holds ${payments.size} payments, not one`)
      }
      return payment
    },
    /**
     * The next createPayment request fails with this error. `processed`: ЮKassa made the
     * payment and only the answer was lost, so a repeat with the same key returns it.
     */
    failCreate(error: unknown, { processed = false } = {}) {
      createFailures.push({ error, processed })
    },
    /** The next getPayment request fails with this error. */
    failRead(error: unknown) {
      readFailures.push(error)
    },
    /** Fields the next created payment gets instead of the usual ones. */
    createAs(patch: Partial<Payment>) {
      atCreation = patch
    },
    /** The customer paid. `saved`: ЮKassa reports the payment method as saved. */
    succeed(
      paymentId: string,
      { saved = false, capturedAt = '2026-10-04T09:00:00.000Z' }: SucceedOptions = {},
    ) {
      const payment = stored(paymentId)
      payment.status = 'succeeded'
      payment.paid = true
      payment.captured_at = capturedAt
      delete payment.confirmation
      payment.payment_method = {
        id: paymentId,
        type: 'bank_card',
        saved,
        status: saved ? 'active' : 'inactive',
        title: 'Bank card *4444',
        card: { ...TEST_CARD },
      }
    },
    /** The bank declined, or the customer never paid. */
    cancel(paymentId: string, reason = 'general_decline') {
      const payment = stored(paymentId)
      payment.status = 'canceled'
      payment.paid = false
      delete payment.confirmation
      payment.cancellation_details = { party: 'payment_network', reason }
    },
    /** Changes what ЮKassa reports about the payment. */
    patch(paymentId: string, patch: Partial<Payment>) {
      Object.assign(stored(paymentId), patch)
    },
  }
}

interface SucceedOptions {
  saved?: boolean
  capturedAt?: string
}

/** The origin the customer returns to in the tests. */
export const TEST_APP_URL = 'https://raditi.example'

/** What checkout and settlement are called with in a test: the scripted shop and a fixed clock. */
export function billingTestDeps(db: PrismaClient) {
  const shop = yookassaStub()
  const deps: BillingDeps = {
    prisma: db,
    yookassa: shop.client,
    appUrl: TEST_APP_URL,
    appEnv: 'test',
    // The shop of the tests saves payment methods; a test of a shop that does not says so.
    autopayments: true,
    now: () => TEST_NOW,
  }
  return { shop, deps }
}

/**
 * The saved payment methods of ЮKassa as a script: a binding waits on its page until the test
 * confirms or refuses it, a repeated Idempotence-Key answers with the method of the first
 * request, and the test decides which request fails. Every call is recorded.
 */
export function paymentMethodStub() {
  const methods = new Map<string, SavedPaymentMethod>()
  const idByKey = new Map<string, string>()
  const created: { input: CreatePaymentMethodInput; idempotenceKey: string }[] = []
  const reads: string[] = []
  const createFailures: { error: unknown; processed: boolean }[] = []
  const readFailures: unknown[] = []
  let atCreation: Partial<SavedPaymentMethod> = {}

  const stored = (methodId: string): SavedPaymentMethod => {
    const method = methods.get(methodId)
    if (method === undefined) throw new Error(`The stub has no payment method ${methodId}`)
    return method
  }

  function create(input: CreatePaymentMethodInput, idempotenceKey: string): SavedPaymentMethod {
    const known = idByKey.get(idempotenceKey)
    if (known !== undefined) return stored(known)
    const id = randomUUID()
    const method: SavedPaymentMethod = {
      id,
      type: input.type,
      saved: false,
      status: 'pending',
      confirmation: { type: 'redirect', confirmation_url: `https://yookassa.example/bind/${id}` },
      ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
      ...atCreation,
    }
    atCreation = {}
    methods.set(id, method)
    idByKey.set(idempotenceKey, id)
    return method
  }

  const client: PaymentMethodDeps['yookassa'] = {
    createPaymentMethod(input, idempotenceKey) {
      created.push({ input: structuredClone(input), idempotenceKey })
      const failure = createFailures.shift()
      if (failure !== undefined) {
        if (failure.processed) create(input, idempotenceKey)
        return Promise.reject(failure.error)
      }
      return Promise.resolve(structuredClone(create(input, idempotenceKey)))
    },
    getPaymentMethod(methodId) {
      reads.push(methodId)
      const failure = readFailures.shift()
      if (failure !== undefined) return Promise.reject(failure)
      const method = methods.get(methodId)
      if (method === undefined) {
        return Promise.reject(new YookassaApiError('not_found', 404, 'not_found', {}))
      }
      return Promise.resolve(structuredClone(method))
    },
  }

  return {
    client,
    /** Every createPaymentMethod request, a failed one included. */
    created,
    /** The method id of every getPaymentMethod request. */
    reads,
    methods,
    /** The one binding the test made. */
    only(): SavedPaymentMethod {
      const [method, ...others] = [...methods.values()]
      if (method === undefined || others.length > 0) {
        throw new Error(`The stub holds ${methods.size} payment methods, not one`)
      }
      return method
    },
    /**
     * The next createPaymentMethod request fails with this error. `processed`: ЮKassa made the
     * binding and only the answer was lost, so a repeat with the same key returns it.
     */
    failCreate(error: unknown, { processed = false } = {}) {
      createFailures.push({ error, processed })
    },
    /** The next getPaymentMethod request fails with this error. */
    failRead(error: unknown) {
      readFailures.push(error)
    },
    /** Fields the next created method gets instead of the usual ones. */
    createAs(patch: Partial<SavedPaymentMethod>) {
      atCreation = patch
    },
    /** The customer confirmed the binding on its page: the card is saved. */
    confirm(methodId: string, card: Partial<typeof TEST_CARD> = {}) {
      const method = stored(methodId)
      const saved = { ...TEST_CARD, ...card }
      method.status = 'active'
      method.saved = true
      method.title = `Bank card *${saved.last4}`
      method.card = saved
      delete method.confirmation
    },
    /** The customer refused, or the page expired: nothing is saved. */
    refuse(methodId: string) {
      const method = stored(methodId)
      method.status = 'inactive'
      method.saved = false
      delete method.confirmation
    },
    /** Changes what ЮKassa reports about the method. */
    patch(methodId: string, patch: Partial<SavedPaymentMethod>) {
      Object.assign(stored(methodId), patch)
    },
    /** ЮKassa no longer knows the method. */
    forget(methodId: string) {
      methods.delete(methodId)
    },
  }
}

/** What the functions of a saved payment method are called with in a test. */
export function paymentMethodTestDeps(db: PrismaClient) {
  const shop = paymentMethodStub()
  const deps: PaymentMethodDeps = {
    prisma: db,
    yookassa: shop.client,
    appUrl: TEST_APP_URL,
    appEnv: 'test',
    // The shop of the tests saves payment methods; a test of a shop that does not says so.
    autopayments: true,
    now: () => TEST_NOW,
  }
  return { shop, deps }
}

/**
 * The refunds of ЮKassa as a script, on top of the scripted payments (`yookassaStub`): a refund
 * succeeds at once unless the test says otherwise, never returns more than is left of its
 * payment, and a repeated Idempotence-Key answers with the refund of the first request. A
 * refund «made in the cabinet» is one the shop holds without any request of ours. Every call is
 * recorded.
 */
export function refundStub() {
  const shop = yookassaStub()
  const refunds = new Map<string, Refund>()
  const idByKey = new Map<string, string>()
  const created: { input: CreateRefundInput; idempotenceKey: string }[] = []
  const reads: string[] = []
  const createFailures: { error: unknown; processed: boolean }[] = []
  const readFailures: unknown[] = []
  let atCreation: Partial<Refund> = {}

  const stored = (refundId: string): Refund => {
    const refund = refunds.get(refundId)
    if (refund === undefined) throw new Error(`The stub has no refund ${refundId}`)
    return refund
  }
  const paymentOf = (paymentId: string): Payment => {
    const payment = shop.payments.get(paymentId)
    if (payment === undefined) throw new Error(`The stub has no payment ${paymentId}`)
    return payment
  }
  const refused = (description: string) =>
    new YookassaApiError(`invalid_request: ${description}`, 400, 'invalid_request', {})

  /** The money of a succeeded refund leaves its payment. */
  function moveMoney(refund: Refund): void {
    const payment = paymentOf(refund.payment_id)
    const returned = new Money(payment.refunded_amount?.value ?? 0).plus(refund.amount.value)
    payment.refunded_amount = { value: returned.toFixed(2), currency: 'RUB' }
    payment.refundable = returned.lessThan(payment.amount.value)
  }

  function make(input: CreateRefundInput, patch: Partial<Refund>): Refund {
    const payment = shop.payments.get(input.payment_id)
    if (payment?.status !== 'succeeded') throw refused('Only a succeeded payment is refunded')
    const left = new Money(payment.amount.value).minus(payment.refunded_amount?.value ?? 0)
    if (left.lessThan(input.amount.value)) throw refused('The refund exceeds what is left')
    const refund: Refund = {
      id: randomUUID(),
      payment_id: input.payment_id,
      status: 'succeeded',
      amount: { value: input.amount.value, currency: 'RUB' },
      created_at: TEST_NOW.toISOString(),
      // As ЮKassa does: what the request described the refund with is read back with it.
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
      ...patch,
    }
    refunds.set(refund.id, refund)
    if (refund.status === 'succeeded') moveMoney(refund)
    return refund
  }

  function create(input: CreateRefundInput, idempotenceKey: string): Refund {
    const known = idByKey.get(idempotenceKey)
    if (known !== undefined) return stored(known)
    const patch = atCreation
    atCreation = {}
    const refund = make(input, patch)
    idByKey.set(idempotenceKey, refund.id)
    return refund
  }

  const client: BillingDeps['yookassa'] & RefundDeps['yookassa'] = {
    ...shop.client,
    createRefund(input, idempotenceKey) {
      created.push({ input: structuredClone(input), idempotenceKey })
      const failure = createFailures.shift()
      try {
        if (failure !== undefined) {
          if (failure.processed) create(input, idempotenceKey)
          return Promise.reject(failure.error)
        }
        return Promise.resolve(structuredClone(create(input, idempotenceKey)))
      } catch (error) {
        return Promise.reject(error)
      }
    },
    getRefund(refundId) {
      reads.push(refundId)
      const failure = readFailures.shift()
      if (failure !== undefined) return Promise.reject(failure)
      const refund = refunds.get(refundId)
      if (refund === undefined) {
        return Promise.reject(new YookassaApiError('not_found', 404, 'not_found', {}))
      }
      return Promise.resolve(structuredClone(refund))
    },
  }

  return {
    ...shop,
    client,
    /** Every createRefund request, a failed and a refused one included. */
    refundRequests: created,
    /** The refund id of every getRefund request. */
    refundReads: reads,
    refunds,
    /** The one refund the shop holds. */
    onlyRefund(): Refund {
      const [refund, ...others] = [...refunds.values()]
      if (refund === undefined || others.length > 0) {
        throw new Error(`The stub holds ${refunds.size} refunds, not one`)
      }
      return refund
    },
    /** A payment the customer has made: succeeded, with nothing returned. */
    paid(amount: string, metadata?: Record<string, string>): Payment {
      const id = randomUUID()
      const payment: Payment = {
        id,
        status: 'succeeded',
        paid: true,
        amount: { value: amount, currency: 'RUB' },
        created_at: TEST_NOW.toISOString(),
        captured_at: TEST_NOW.toISOString(),
        refundable: true,
        ...(metadata === undefined ? {} : { metadata }),
      }
      shop.payments.set(id, payment)
      return payment
    },
    /**
     * The next createRefund request fails with this error. `processed`: ЮKassa made the refund
     * and only the answer was lost, so a repeat with the same key returns it.
     */
    failRefund(error: unknown, { processed = false } = {}) {
      createFailures.push({ error, processed })
    },
    /** The next getRefund request fails with this error. */
    failRefundRead(error: unknown) {
      readFailures.push(error)
    },
    /** Fields the next created refund gets instead of the usual ones: `status: 'pending'`. */
    refundAs(patch: Partial<Refund>) {
      atCreation = patch
    },
    /** A pending refund went through: the money left the payment. */
    succeedRefund(refundId: string) {
      const refund = stored(refundId)
      refund.status = 'succeeded'
      moveMoney(refund)
    },
    /** ЮKassa cancelled a pending refund: no money moved. */
    cancelRefund(refundId: string, reason = 'insufficient_funds') {
      const refund = stored(refundId)
      refund.status = 'canceled'
      refund.cancellation_details = { party: 'yoo_money', reason }
    },
    /** Somebody returned money in the ЮKassa cabinet: a refund no request of ours asked for. */
    cabinetRefund(paymentId: string, amount?: string, patch: Partial<Refund> = {}): Refund {
      const value = amount ?? paymentOf(paymentId).amount.value
      return make({ payment_id: paymentId, amount: { value, currency: 'RUB' } }, patch)
    },
    /** ЮKassa no longer knows the refund. */
    forgetRefund(refundId: string) {
      refunds.delete(refundId)
    },
    /** A day has passed: ЮKassa has let go of every Idempotence-Key of a refund. */
    forgetRefundKeys() {
      idByKey.clear()
    },
  }
}

/** What a refund and everything before it are called with in a test. */
export function refundTestDeps(db: PrismaClient) {
  const shop = refundStub()
  const deps: BillingDeps & RefundDeps = {
    prisma: db,
    yookassa: shop.client,
    appUrl: TEST_APP_URL,
    appEnv: 'test',
    // The shop of the tests saves payment methods; a test of a shop that does not says so.
    autopayments: true,
    now: () => TEST_NOW,
  }
  return { shop, deps }
}
