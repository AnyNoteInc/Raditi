// Invariants of the migrations: hand-written CHECKs and the (account_id, unit) foreign keys of
// the ledger and holds (spec §16, §17). Needs a migrated PostgreSQL, so it runs when DATABASE_URL is set
// (CI) and is skipped otherwise. Every write happens in a transaction that is rolled back.
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPrismaClient } from '../src/client.ts'
import type { BillingUnit, Prisma, PrismaClient } from '../src/generated/prisma/client.ts'

type Tx = Prisma.TransactionClient

const databaseUrl = process.env.DATABASE_URL

class Rollback extends Error {}

describe.skipIf(!databaseUrl)('migration constraints', () => {
  let db: PrismaClient
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  /** Runs `act` in a transaction that never commits; returns the error it raised, if any. */
  async function attempt(act: (tx: Tx) => Promise<unknown>): Promise<unknown> {
    try {
      await db.$transaction(async (tx) => {
        await act(tx)
        throw new Rollback()
      })
    } catch (error) {
      if (error instanceof Rollback) return undefined
      return error
    }
    return undefined
  }

  async function expectAccepted(act: (tx: Tx) => Promise<unknown>): Promise<void> {
    expect(await attempt(act)).toBeUndefined()
  }

  /**
   * SQLSTATE and constraint name of a PostgreSQL violation. With the pg driver adapter Prisma
   * reports a CHECK as P2039 with an empty message; the details sit in the adapter error.
   */
  function violation(error: unknown): { code?: string; constraint?: string } {
    const cause = (
      error as {
        meta?: {
          driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string } }
        }
      }
    )?.meta?.driverAdapterError?.cause
    return {
      code: cause?.originalCode,
      constraint: cause?.originalMessage?.match(/constraint "([^"]+)"/)?.[1],
    }
  }

  const CHECK_VIOLATION = '23514'
  const FOREIGN_KEY_VIOLATION = '23503'

  async function expectRejected(
    constraint: string,
    act: (tx: Tx) => Promise<unknown>,
    code = CHECK_VIOLATION,
  ): Promise<void> {
    expect(violation(await attempt(act))).toEqual({ code, constraint })
  }

  const unique = () => randomUUID().slice(0, 8)

  const workspace = (tx: Tx) => tx.workspace.create({ data: { name: 'Проверка ограничений' } })

  const account = async (tx: Tx, unit: BillingUnit, balance = '0', held = '0') =>
    tx.billingAccount.create({
      data: { workspaceId: (await workspace(tx)).id, unit, balance, held },
    })

  async function task(tx: Tx) {
    const ws = await workspace(tx)
    const site = await tx.site.create({
      data: {
        workspaceId: ws.id,
        name: 'Сайт',
        url: `https://${unique()}.example.ru`,
        stack: 'wordpress',
      },
    })
    return tx.task.create({ data: { workspaceId: ws.id, siteId: site.id } })
  }

  const plan = (tx: Tx, data: Partial<Prisma.PlanUncheckedCreateInput> = {}) =>
    tx.plan.create({
      data: { slug: `test-${unique()}`, name: 'Тест', kind: 'payg', price: '0.00', ...data },
    })

  async function model(tx: Tx) {
    const provider = await tx.llmProvider.create({
      data: { slug: `test-${unique()}`, name: 'Тест' },
    })
    return tx.llmModel.create({
      data: { providerId: provider.id, slug: 'test-model', name: 'Тест', modelClass: 'light' },
    })
  }

  const price = async (tx: Tx, data: Partial<Prisma.LlmModelPriceUncheckedCreateInput> = {}) =>
    tx.llmModelPrice.create({
      data: {
        modelId: (await model(tx)).id,
        effectiveFrom: new Date(),
        inputPer1m: '122',
        outputPer1m: '244',
        vatRate: '0.2200',
        sourceUrl: 'https://example.ru/prices',
        ...data,
      },
    })

  describe('billing_accounts', () => {
    it('accepts a balance with a smaller hold', () =>
      expectAccepted((tx) => account(tx, 'rub', '1000.50', '300.00')))

    it('rejects a negative balance', () =>
      expectRejected('billing_accounts_balance_check', (tx) => account(tx, 'rub', '-0.01')))

    it('rejects a negative hold', () =>
      expectRejected('billing_accounts_held_check', (tx) => account(tx, 'rub', '10.00', '-1.00')))

    it('rejects a hold above the balance', () =>
      expectRejected('billing_accounts_held_le_balance_check', (tx) =>
        account(tx, 'rub', '10.00', '10.01'),
      ))

    it('rejects fractional edits', () =>
      expectRejected('billing_accounts_edit_whole_check', (tx) => account(tx, 'edit', '1.50')))
  })

  describe('credit_ledger', () => {
    const entry = (accountId: string, unit: BillingUnit, amount: string) => ({
      accountId,
      unit,
      kind: 'grant' as const,
      amount,
      balanceAfter: '30.00',
      idempotencyKey: `test:${randomUUID()}`,
    })

    it('accepts kopecks in roubles and whole edits', () =>
      expectAccepted(async (tx) => {
        const rub = await account(tx, 'rub')
        const edit = await account(tx, 'edit')
        await tx.creditLedger.create({ data: entry(rub.id, 'rub', '0.50') })
        await tx.creditLedger.create({ data: entry(edit.id, 'edit', '30.00') })
      }))

    it('rejects a fractional edit amount', () =>
      expectRejected('credit_ledger_edit_whole_check', async (tx) => {
        const edit = await account(tx, 'edit')
        await tx.creditLedger.create({ data: entry(edit.id, 'edit', '0.50') })
      }))

    it('rejects a fractional edit running balance', () =>
      expectRejected('credit_ledger_edit_whole_check', async (tx) => {
        const edit = await account(tx, 'edit')
        await tx.creditLedger.create({
          data: { ...entry(edit.id, 'edit', '1.00'), balanceAfter: '30.50' },
        })
      }))

    it('accepts kopecks in a rouble running balance', () =>
      expectAccepted(async (tx) => {
        const rub = await account(tx, 'rub')
        await tx.creditLedger.create({
          data: { ...entry(rub.id, 'rub', '1.00'), balanceAfter: '30.50' },
        })
      }))

    it('rejects a unit that differs from the account unit', () =>
      expectRejected(
        'credit_ledger_account_id_unit_fkey',
        async (tx) => {
          const rub = await account(tx, 'rub')
          await tx.creditLedger.create({ data: entry(rub.id, 'edit', '1.00') })
        },
        FOREIGN_KEY_VIOLATION,
      ))

    it('rejects a negative running balance', () =>
      expectRejected('credit_ledger_balance_after_check', async (tx) => {
        const rub = await account(tx, 'rub')
        await tx.creditLedger.create({
          data: { ...entry(rub.id, 'rub', '-1.00'), balanceAfter: '-1.00' },
        })
      }))
  })

  describe('credit_holds', () => {
    const hold = async (tx: Tx, accountId: string, unit: BillingUnit, amount: string) =>
      tx.creditHold.create({
        data: { accountId, unit, taskId: (await task(tx)).id, amount, expiresAt: new Date() },
      })

    it('accepts kopecks in roubles and whole edits', () =>
      expectAccepted(async (tx) => {
        await hold(tx, (await account(tx, 'rub', '100.00')).id, 'rub', '0.50')
        await hold(tx, (await account(tx, 'edit', '30')).id, 'edit', '1')
      }))

    it('rejects a zero hold', () =>
      expectRejected('credit_holds_amount_check', async (tx) =>
        hold(tx, (await account(tx, 'rub', '100.00')).id, 'rub', '0.00'),
      ))

    it('rejects a fractional edit hold', () =>
      expectRejected('credit_holds_edit_whole_check', async (tx) =>
        hold(tx, (await account(tx, 'edit', '30')).id, 'edit', '0.50'),
      ))

    it('rejects a unit that differs from the account unit', () =>
      expectRejected(
        'credit_holds_account_id_unit_fkey',
        async (tx) => hold(tx, (await account(tx, 'rub', '100.00')).id, 'edit', '1'),
        FOREIGN_KEY_VIOLATION,
      ))
  })

  describe('plans and pricing_rules', () => {
    it('rejects a negative plan price', () =>
      expectRejected('plans_price_check', (tx) => plan(tx, { price: '-1.00' })))

    it('rejects a quota plan without a monthly quota', () =>
      expectRejected('plans_kind_fields_check', (tx) => plan(tx, { kind: 'quota', maxSites: 1 })))

    const rule = async (tx: Tx, data: Partial<Prisma.PricingRuleUncheckedCreateInput>) =>
      tx.pricingRule.create({
        data: {
          planId: (await plan(tx)).id,
          modelClass: 'light',
          effectiveFrom: new Date(),
          markup: '2.0000',
          feePerAction: '30.00',
          minCharge: '50.00',
          holdAmount: '300.00',
          ...data,
        },
      })

    it('accepts the seeded hypothesis', () => expectAccepted((tx) => rule(tx, {})))

    it('rejects a zero markup', () =>
      expectRejected('pricing_rules_markup_check', (tx) => rule(tx, { markup: '0' })))

    it('rejects a negative fee', () =>
      expectRejected('pricing_rules_fee_check', (tx) => rule(tx, { feePerAction: '-1.00' })))

    it('rejects a negative minimum', () =>
      expectRejected('pricing_rules_min_charge_check', (tx) =>
        rule(tx, { minCharge: '-1.00', holdAmount: '0.00' }),
      ))

    it('rejects a hold below the minimum charge', () =>
      expectRejected('pricing_rules_hold_check', (tx) => rule(tx, { holdAmount: '49.99' })))
  })

  describe('llm_model_prices', () => {
    it('accepts NULL cache prices', () => expectAccepted((tx) => price(tx)))

    it('rejects a negative price', () =>
      expectRejected('llm_model_prices_prices_check', (tx) => price(tx, { cacheReadPer1m: '-1' })))

    it('rejects a VAT rate of 100%', () =>
      expectRejected('llm_model_prices_vat_rate_check', (tx) => price(tx, { vatRate: '1.0000' })))
  })

  describe('token_usage', () => {
    it('rejects negative token counts', () =>
      expectRejected('token_usage_tokens_check', async (tx) => {
        const t = await task(tx)
        const driver = await tx.agentDriver.create({
          data: { id: `test-${unique()}`, image: 'raditi/agent-test', capabilities: {} },
        })
        const turn = await tx.taskTurn.create({
          data: { taskId: t.id, turnNo: 1, driverId: driver.id, image: driver.image },
        })
        const p = await price(tx)
        const m = await tx.llmModel.findUniqueOrThrow({ where: { id: p.modelId } })
        await tx.llmProvider.update({
          where: { id: m.providerId },
          data: { kind: 'subscription' },
        })
        const credentialRef = await tx.credentialRef.create({
          data: { kind: 'subscription', vaultPath: `subs/test-${randomUUID()}` },
        })
        const subscriptionAccount = await tx.subscriptionAccount.create({
          data: {
            providerId: m.providerId,
            driverId: driver.id,
            label: `test-${randomUUID()}`,
            credentialRefId: credentialRef.id,
            plan: 'test',
            maxConcurrentTurns: 1,
            maxConcurrentRequests: 2,
          },
        })
        const now = new Date()
        const expiresAt = new Date(now.getTime() + 60_000)
        const key = await tx.llmKey.create({
          data: {
            keyHash: randomUUID().replaceAll('-', '').repeat(2),
            taskId: t.id,
            taskAttempt: t.attempt,
            sessionId: randomUUID(),
            turnNo: turn.turnNo,
            firstEpoch: 1,
            driverId: driver.id,
            modelId: p.modelId,
            subscriptionAccountId: subscriptionAccount.id,
            budgetRub: '135.00',
            issuedAt: now,
            expiresAt,
            validUntil: expiresAt,
          },
        })
        const call = await tx.llmCall.create({
          data: {
            keyId: key.id,
            subscriptionAccountId: subscriptionAccount.id,
            modelId: p.modelId,
            route: '/zai/v4/chat/completions',
            state: 'completed',
            reservedRub: '1.00',
            requestBytes: 100,
            startedAt: now,
            finishedAt: now,
          },
        })
        await tx.tokenUsage.create({
          data: {
            gatewayCallId: call.id,
            keyId: key.id,
            subscriptionAccountId: subscriptionAccount.id,
            taskId: t.id,
            taskAttempt: t.attempt,
            turnId: turn.id,
            driverId: driver.id,
            modelId: p.modelId,
            priceId: p.id,
            inputUncachedTokens: -1,
            outputTokens: 1,
            costRub: '0.0000122000',
            occurredAt: new Date(),
          },
        })
      }))
  })

  describe('task_events', () => {
    // The subscription gateway asks on every key lookup and admission, and the issuer on every
    // key, whether the task was refused for content. Only this index keeps that from reading
    // all events of the task.
    const index = 'task_events_llm_policy_flagged_idx'

    it('has the partial index of the content-refusal flag', async () => {
      const rows = await db.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'task_events' AND indexname = ${index}`
      expect(rows.map((row) => row.indexdef)).toEqual([
        `CREATE INDEX ${index} ON public.task_events USING btree (task_id) ` +
          `WHERE ((type)::text = 'llm.policy_flagged'::text)`,
      ])
    })

    it('answers the flag lookup from that index, not from the events of the task', async () => {
      const plans: string[] = []
      await expectAccepted(async (tx) => {
        const t = await task(tx)
        await tx.taskEvent.createMany({
          data: [
            ...Array.from({ length: 200 }, () => ({ taskId: t.id, type: 'message', payload: {} })),
            { taskId: t.id, type: 'llm.policy_flagged', payload: {} },
          ],
        })
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`
        const explain = async (sql: string, ...values: unknown[]) =>
          plans.push(
            (await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN ${sql}`, ...values))
              .map((row) => row['QUERY PLAN'])
              .join('\n'),
          )
        // The gateway's query: the event type is part of the statement (the id is a uuid).
        await explain(`SELECT EXISTS (SELECT 1 FROM task_events e
          WHERE e.task_id = '${t.id}'::uuid AND e.type = 'llm.policy_flagged') AS flagged`)
        // Prisma's own queries bind the type. This client sends unnamed statements, which
        // PostgreSQL plans with the bound values; a named statement could fall back to a
        // generic plan, which cannot prove the predicate of the index.
        await explain(
          `SELECT e.id FROM task_events e WHERE e.task_id = $1::uuid AND e.type = $2 LIMIT 1`,
          t.id,
          'llm.policy_flagged',
        )
      })
      expect(plans).toHaveLength(2)
      for (const plan of plans) {
        expect(plan).toContain(index)
        expect(plan).not.toContain('task_events_task_id_id_idx')
      }
    })
  })

  describe('orders', () => {
    const order = async (tx: Tx, data: Partial<Prisma.OrderUncheckedCreateInput>) =>
      tx.order.create({
        data: {
          workspaceId: (await workspace(tx)).id,
          kind: 'topup',
          amount: '1000.00',
          idempotenceKey: randomUUID(),
          ...data,
        },
      })

    it('accepts a wallet top-up without a plan', () => expectAccepted((tx) => order(tx, {})))

    it('rejects a zero amount', () =>
      expectRejected('orders_amount_check', (tx) => order(tx, { amount: '0.00' })))

    it('rejects a top-up that names a plan', () =>
      expectRejected('orders_plan_check', async (tx) => order(tx, { planId: (await plan(tx)).id })))
  })

  describe('site_leases and credential_refs', () => {
    it('rejects a held lease without an expiry', () =>
      expectRejected('site_leases_state_check', async (tx) => {
        const t = await task(tx)
        await tx.siteLease.create({
          data: { siteId: t.siteId, operation: 'turn', holderTaskId: t.id },
        })
      }))

    it('rejects site access without a site', () =>
      expectRejected('credential_refs_site_scope_check', async (tx) =>
        tx.credentialRef.create({
          data: {
            workspaceId: (await workspace(tx)).id,
            kind: 'ssh',
            vaultPath: `kv/test/${randomUUID()}`,
          },
        }),
      ))

    it('rejects a provider key bound to a workspace', () =>
      expectRejected('credential_refs_platform_scope_check', async (tx) =>
        tx.credentialRef.create({
          data: {
            workspaceId: (await workspace(tx)).id,
            kind: 'llm_provider',
            vaultPath: `kv/test/${randomUUID()}`,
          },
        }),
      ))
  })
})
