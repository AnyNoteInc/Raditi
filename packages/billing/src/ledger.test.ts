import { randomUUID } from 'node:crypto'

import { createPrismaClient, ensurePersonalWorkspace, type PrismaClient } from '@repo/db'
import { Money, signupGiftCredits } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { ensureAccounts, lockCreditAccount, type BillingTx } from './accounts.ts'
import {
  expireTariffRemainder,
  giftAuditActions,
  grantPackCredits,
  grantSignupGift,
  grantTariffCredits,
  ledgerKeys,
} from './ledger.ts'
import { billingFixtures } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
const WORKSPACE = '0199a000-0000-7000-8000-0000000000a1'
const ORDER = '0199a000-0000-7000-8000-0000000000b2'
const SUBSCRIPTION = '0199a000-0000-7000-8000-0000000000c3'
const TASK = '0199a000-0000-7000-8000-0000000000d4'
const HOLD = '0199a000-0000-7000-8000-0000000000e5'
const USER = '0199a000-0000-7000-8000-0000000000f6'
const ACCOUNT = '0199a000-0000-7000-8000-000000000a07'

describe('ledger keys', () => {
  it('names each thing that may happen once', () => {
    expect(ledgerKeys.tariffGrant(ORDER)).toBe(`order:${ORDER}:grant`)
    expect(ledgerKeys.packGrant(ORDER)).toBe(`order:${ORDER}:pack`)
    expect(ledgerKeys.tariffExpiry(SUBSCRIPTION, new Date('2026-10-18T09:00:00.000Z'))).toBe(
      `sub:${SUBSCRIPTION}:1792314000000:expire`,
    )
    // One charge per task and account, whatever attempts of the task reserved there.
    expect(ledgerKeys.taskCharge(TASK, ACCOUNT)).toBe(`task:${TASK}:charge:${ACCOUNT}`)
    expect(ledgerKeys.holdCharge(HOLD)).toBe(`hold:${HOLD}:charge`)
    expect(ledgerKeys.holdExpiry(HOLD)).toBe(`hold:${HOLD}:expire`)
    expect(ledgerKeys.refundAdjust(ORDER)).toBe(`order:${ORDER}:refund:adjust`)
    expect(ledgerKeys.signupGift(USER)).toBe(`user:${USER}:signup-gift`)
  })

  it('names the audit action of the gift', () => {
    expect(giftAuditActions).toEqual({ grant: 'billing.gift.grant' })
  })

  it('never gives two things one key, even when their ids are equal', () => {
    const keys = [
      ledgerKeys.tariffGrant(ORDER),
      ledgerKeys.packGrant(ORDER),
      ledgerKeys.tariffExpiry(ORDER, new Date(0)),
      ledgerKeys.taskCharge(ORDER, ORDER),
      ledgerKeys.taskCharge(ORDER, ACCOUNT),
      ledgerKeys.taskCharge(ACCOUNT, ORDER),
      ledgerKeys.holdCharge(ORDER),
      ledgerKeys.holdExpiry(ORDER),
      ledgerKeys.refundAdjust(ORDER),
      ledgerKeys.signupGift(ORDER),
    ]
    expect(new Set(keys).size).toBe(keys.length)
    // credit_ledger.idempotency_key is varchar(255).
    for (const key of keys) expect(key.length).toBeLessThanOrEqual(255)
  })
})

describe('ledger input', () => {
  // Reaching the database with a refused input would throw on the missing client.
  const tx = {} as BillingTx

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '30'])(
    'refuses to grant %s credits before any query',
    async (credits) => {
      const input = { workspaceId: WORKSPACE, orderId: ORDER, credits: credits as number }
      await expect(grantTariffCredits(tx, input)).rejects.toThrow()
      await expect(grantPackCredits(tx, input)).rejects.toThrow()
    },
  )

  it('refuses an id that is not a UUID and an unknown field', async () => {
    const input = { workspaceId: WORKSPACE, orderId: ORDER, credits: 30 }
    await expect(grantTariffCredits(tx, { ...input, workspaceId: 'ws' })).rejects.toThrow()
    await expect(grantPackCredits(tx, { ...input, orderId: 'order' })).rejects.toThrow()
    await expect(
      grantPackCredits(tx, { ...input, unit: 'rub' } as unknown as typeof input),
    ).rejects.toThrow()
  })

  it('refuses a gift for an id that is not a UUID, with a field missing or unknown', async () => {
    const input = { userId: USER, workspaceId: WORKSPACE }
    for (const bad of [
      { ...input, userId: 'user' },
      { ...input, workspaceId: 'ws' },
      { userId: USER },
      { workspaceId: WORKSPACE },
      // The amount is the constant of the domain, never the caller's.
      { ...input, credits: 350 },
      { ...input, orderId: ORDER },
    ]) {
      await expect(grantSignupGift(tx, bad as typeof input)).rejects.toThrow()
    }
  })

  it('refuses a period end that is not a moment', async () => {
    const input = { workspaceId: WORKSPACE, subscriptionId: SUBSCRIPTION }
    await expect(
      expireTariffRemainder(tx, { ...input, periodEnd: new Date(Number.NaN) }),
    ).rejects.toThrow()
    await expect(
      expireTariffRemainder(tx, { ...input, periodEnd: '2026-10-18' as unknown as Date }),
    ).rejects.toThrow()
  })

  it('creates the three credit accounts and no other', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 3 })
    await ensureAccounts({ billingAccount: { createMany } } as unknown as BillingTx, WORKSPACE)
    expect(createMany).toHaveBeenCalledExactlyOnceWith({
      data: [
        { workspaceId: WORKSPACE, unit: 'credit_tariff' },
        { workspaceId: WORKSPACE, unit: 'credit_gift' },
        { workspaceId: WORKSPACE, unit: 'credit_pack' },
      ],
      skipDuplicates: true,
    })
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL accounts and ledger', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
  })
  afterEach(() => fixtures.cleanup())
  afterAll(async () => {
    await db.$disconnect()
  })

  /**
   * A workspace with a paid order of each kind to grant from and an active subscription whose
   * period ends at `periodEnd`.
   */
  async function paid() {
    const { workspaceId } = await fixtures.workspace()
    const plan = await fixtures.plan()
    const pack = await fixtures.plan({
      kind: 'pack',
      price: '1990.00',
      creditsPerMonth: null,
      creditsPerDay: null,
      maxSites: null,
      packCredits: 10,
    })
    const order = await fixtures.order({ workspaceId, planId: plan.id })
    const packOrder = await fixtures.order({
      workspaceId,
      planId: pack.id,
      kind: 'pack',
      amount: '1990.00',
    })
    const subscription = await fixtures.subscription({ workspaceId, planId: plan.id })
    return {
      workspaceId,
      plan,
      pack,
      orderId: order.id,
      packOrderId: packOrder.id,
      subscriptionId: subscription.id,
      periodEnd: subscription.currentPeriodEnd,
    }
  }

  const PERIOD_MS = 30 * 24 * 60 * 60 * 1000

  /**
   * What a renewal does in one transaction: the remainder goes, the subscription moves to its
   * next period, the new quota comes. `periodEnd` is the end of the period being closed, as the
   * job that renews it knows it.
   */
  const renew = (renewal: {
    workspaceId: string
    subscriptionId: string
    periodEnd: Date
    orderId: string
    credits: number
  }) =>
    db.$transaction(async (tx) => {
      const { workspaceId, subscriptionId, periodEnd, orderId, credits } = renewal
      const expired = await expireTariffRemainder(tx, { workspaceId, subscriptionId, periodEnd })
      await tx.subscription.update({
        where: { id: subscriptionId },
        data: {
          currentPeriodStart: periodEnd,
          currentPeriodEnd: new Date(periodEnd.getTime() + PERIOD_MS),
        },
      })
      const granted = await grantTariffCredits(tx, { workspaceId, orderId, credits })
      return { expired, granted }
    })

  /**
   * The customer spent tariff credits: the charge a later slice writes, row and balance together.
   */
  const spend = (workspaceId: string, credits: number) =>
    db.$transaction(async (tx) => {
      const account = await tx.billingAccount.update({
        where: { workspaceId_unit: { workspaceId, unit: 'credit_tariff' } },
        data: { balance: { decrement: credits } },
      })
      await tx.creditLedger.create({
        data: {
          accountId: account.id,
          unit: 'credit_tariff',
          kind: 'charge',
          amount: -credits,
          balanceAfter: account.balance,
          idempotencyKey: `test:${randomUUID()}:charge`,
        },
      })
    })

  const accounts = async (workspaceId: string) => {
    const rows = await db.billingAccount.findMany({ where: { workspaceId } })
    const of = (unit: string) => {
      const row = rows.find((account) => account.unit === unit)
      return row ? { balance: row.balance.toFixed(2), held: row.held.toFixed(2) } : null
    }
    return {
      tariff: of('credit_tariff'),
      gift: of('credit_gift'),
      pack: of('credit_pack'),
      count: rows.length,
    }
  }

  const entries = (workspaceId: string) =>
    db.creditLedger.findMany({
      where: { account: { workspaceId } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })

  /** The invariant of the ledger: every account holds exactly what its rows add up to. */
  async function expectBalancesToMatchLedger(workspaceId: string) {
    const rows = await db.billingAccount.findMany({
      where: { workspaceId },
      include: { entries: true },
    })
    expect(rows.length).toBeGreaterThan(0)
    for (const account of rows) {
      const sum = account.entries.reduce((total, entry) => total.plus(entry.amount), new Money(0))
      expect(`${account.unit} ${account.balance.toFixed(2)}`).toBe(
        `${account.unit} ${sum.toFixed(2)}`,
      )
    }
  }

  it('creates the three accounts once under concurrent calls', async () => {
    const { workspaceId, orderId } = await paid()
    await Promise.all(
      Array.from({ length: 8 }, () => db.$transaction((tx) => ensureAccounts(tx, workspaceId))),
    )
    expect(await accounts(workspaceId)).toEqual({
      tariff: { balance: '0.00', held: '0.00' },
      gift: { balance: '0.00', held: '0.00' },
      pack: { balance: '0.00', held: '0.00' },
      count: 3,
    })
    // A later call leaves an account with a balance as it is.
    await db.$transaction((tx) => grantTariffCredits(tx, { workspaceId, orderId, credits: 30 }))
    const rows = () =>
      db.billingAccount.findMany({ where: { workspaceId }, orderBy: { unit: 'asc' } })
    const before = await rows()
    await db.$transaction((tx) => ensureAccounts(tx, workspaceId))
    expect(await rows()).toEqual(before)
    // In the order of the database type: the tariff, the pack, the gift.
    expect(before.map((account) => `${account.unit} ${account.balance.toFixed(2)}`)).toEqual([
      'credit_tariff 30.00',
      'credit_pack 0.00',
      'credit_gift 0.00',
    ])
  })

  it('adds the gift account to a workspace that had the other two, and leaves those as they are', async () => {
    const { workspaceId } = await fixtures.workspace()
    // As a workspace was left by the code before the third account: two rows, one with credits.
    await db.billingAccount.createMany({
      data: [
        { workspaceId, unit: 'credit_tariff', balance: 30, held: 2 },
        { workspaceId, unit: 'credit_pack' },
      ],
    })
    const rows = () =>
      db.billingAccount.findMany({ where: { workspaceId }, orderBy: { unit: 'asc' } })
    const before = await rows()

    await db.$transaction((tx) => ensureAccounts(tx, workspaceId))

    const after = await rows()
    expect(after.slice(0, 2)).toEqual(before)
    expect(await accounts(workspaceId)).toEqual({
      tariff: { balance: '30.00', held: '2.00' },
      gift: { balance: '0.00', held: '0.00' },
      pack: { balance: '0.00', held: '0.00' },
      count: 3,
    })
  })

  it('grants the quota: the balance rises and one ledger row says why', async () => {
    const { workspaceId, orderId } = await paid()
    const posting = await db.$transaction((tx) =>
      grantTariffCredits(tx, { workspaceId, orderId, credits: 30 }),
    )
    expect(posting.applied).toBe(true)
    expect(await accounts(workspaceId)).toEqual({
      tariff: { balance: '30.00', held: '0.00' },
      gift: { balance: '0.00', held: '0.00' },
      pack: { balance: '0.00', held: '0.00' },
      count: 3,
    })
    const rows = await entries(workspaceId)
    expect(rows).toEqual([posting.entry])
    expect(rows[0]).toMatchObject({
      unit: 'credit_tariff',
      kind: 'grant',
      orderId,
      taskId: null,
      note: null,
      idempotencyKey: `order:${orderId}:grant`,
    })
    expect(rows[0]!.amount.toFixed(2)).toBe('30.00')
    expect(rows[0]!.balanceAfter.toFixed(2)).toBe('30.00')
    await expectBalancesToMatchLedger(workspaceId)
  })

  it('changes nothing when the same order is granted again', async () => {
    const { workspaceId, orderId } = await paid()
    const input = { workspaceId, orderId, credits: 30 }
    const first = await db.$transaction((tx) => grantTariffCredits(tx, input))
    const account = await db.billingAccount.findUniqueOrThrow({
      where: { workspaceId_unit: { workspaceId, unit: 'credit_tariff' } },
    })
    const repeat = await db.$transaction((tx) => grantTariffCredits(tx, input))
    expect(repeat).toEqual({ entry: first.entry, applied: false })
    expect(await entries(workspaceId)).toEqual([first.entry])
    // Not even updated_at moves.
    expect(await db.billingAccount.findUniqueOrThrow({ where: { id: account.id } })).toEqual(
      account,
    )
  })

  it('grants once when the same order is granted concurrently', async () => {
    const { workspaceId, orderId } = await paid()
    const postings = await Promise.all(
      Array.from({ length: 6 }, () =>
        db.$transaction((tx) => grantTariffCredits(tx, { workspaceId, orderId, credits: 30 })),
      ),
    )
    expect(postings.filter((posting) => posting.applied)).toHaveLength(1)
    expect(new Set(postings.map((posting) => posting.entry.id)).size).toBe(1)
    expect((await accounts(workspaceId)).tariff).toEqual({ balance: '30.00', held: '0.00' })
    expect(await entries(workspaceId)).toHaveLength(1)
    await expectBalancesToMatchLedger(workspaceId)
  })

  it('applies every one of concurrent grants of different orders', async () => {
    const { workspaceId, plan } = await paid()
    const orders = await Promise.all(
      Array.from({ length: 5 }, () => fixtures.order({ workspaceId, planId: plan.id })),
    )
    const postings = await Promise.all(
      orders.map((order) =>
        db.$transaction((tx) =>
          grantTariffCredits(tx, { workspaceId, orderId: order.id, credits: 7 }),
        ),
      ),
    )
    expect(postings.every((posting) => posting.applied)).toBe(true)
    expect((await accounts(workspaceId)).tariff).toEqual({ balance: '35.00', held: '0.00' })
    // Each row saw the balance the previous writer left: no update was lost.
    expect(
      postings.map((posting) => posting.entry.balanceAfter.toNumber()).sort((a, b) => a - b),
    ).toEqual([7, 14, 21, 28, 35])
    await expectBalancesToMatchLedger(workspaceId)
  })

  it('refuses a key that already stands for another amount or account', async () => {
    const { workspaceId, plan, orderId } = await paid()
    await db.$transaction((tx) => grantTariffCredits(tx, { workspaceId, orderId, credits: 30 }))
    await expect(
      db.$transaction((tx) => grantTariffCredits(tx, { workspaceId, orderId, credits: 80 })),
    ).rejects.toMatchObject({ name: 'DomainError', code: 'CONFLICT' })

    // A row written under the grant key of another order, but on the other account.
    const order = await fixtures.order({ workspaceId, planId: plan.id })
    const pack = await db.billingAccount.findUniqueOrThrow({
      where: { workspaceId_unit: { workspaceId, unit: 'credit_pack' } },
    })
    await db.creditLedger.create({
      data: {
        accountId: pack.id,
        unit: 'credit_pack',
        kind: 'grant',
        amount: 0,
        balanceAfter: 0,
        orderId: order.id,
        idempotencyKey: ledgerKeys.tariffGrant(order.id),
      },
    })
    await expect(
      db.$transaction((tx) =>
        grantTariffCredits(tx, { workspaceId, orderId: order.id, credits: 30 }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    expect((await accounts(workspaceId)).tariff).toEqual({ balance: '30.00', held: '0.00' })
    expect(await entries(workspaceId)).toHaveLength(2)
  })

  it('grants only for an order of the same workspace', async () => {
    const { workspaceId, orderId, packOrderId } = await paid()
    const other = await fixtures.workspace()
    for (const grant of [grantTariffCredits, grantPackCredits]) {
      await expect(
        db.$transaction((tx) =>
          grant(tx, { workspaceId: other.workspaceId, orderId, credits: 30 }),
        ),
      ).rejects.toMatchObject({ name: 'DomainError', code: 'BILLING_ORDER_NOT_FOUND' })
      await expect(
        db.$transaction((tx) => grant(tx, { workspaceId, orderId: randomUUID(), credits: 30 })),
      ).rejects.toMatchObject({ code: 'BILLING_ORDER_NOT_FOUND' })
    }
    // Nothing was created for either workspace, and the orders can still be granted.
    expect((await accounts(other.workspaceId)).count).toBe(0)
    expect((await accounts(workspaceId)).count).toBe(0)
    await db.$transaction((tx) => grantTariffCredits(tx, { workspaceId, orderId, credits: 30 }))
    await db.$transaction((tx) =>
      grantPackCredits(tx, { workspaceId, orderId: packOrderId, credits: 10 }),
    )
    await expectBalancesToMatchLedger(workspaceId)
  })

  it('grants each account only from an order of its own kind', async () => {
    const { workspaceId, orderId, packOrderId } = await paid()
    const topup = await fixtures.order({ workspaceId, planId: null, kind: 'topup' })
    // A pack does not pay for a month of quota, a tariff payment is not a pack, a wallet
    // top-up is neither.
    for (const [grant, order] of [
      [grantTariffCredits, packOrderId],
      [grantPackCredits, orderId],
      [grantTariffCredits, topup.id],
      [grantPackCredits, topup.id],
    ] as const) {
      await expect(
        db.$transaction((tx) => grant(tx, { workspaceId, orderId: order, credits: 10 })),
      ).rejects.toMatchObject({ name: 'DomainError', code: 'BILLING_ORDER_NOT_FOUND' })
    }
    expect((await accounts(workspaceId)).count).toBe(0)

    // Each order is still granted on its own account, once.
    await db.$transaction((tx) => grantTariffCredits(tx, { workspaceId, orderId, credits: 30 }))
    await db.$transaction((tx) =>
      grantPackCredits(tx, { workspaceId, orderId: packOrderId, credits: 10 }),
    )
    expect(await accounts(workspaceId)).toEqual({
      tariff: { balance: '30.00', held: '0.00' },
      gift: { balance: '0.00', held: '0.00' },
      pack: { balance: '10.00', held: '0.00' },
      count: 3,
    })
    expect(await entries(workspaceId)).toHaveLength(2)
    await expectBalancesToMatchLedger(workspaceId)
  })

  it('grants a pack to the account of purchased credits and leaves the tariff alone', async () => {
    const { workspaceId, orderId, packOrderId } = await paid()
    await db.$transaction((tx) => grantTariffCredits(tx, { workspaceId, orderId, credits: 30 }))
    const tariff = await db.billingAccount.findUniqueOrThrow({
      where: { workspaceId_unit: { workspaceId, unit: 'credit_tariff' } },
    })
    const posting = await db.$transaction((tx) =>
      grantPackCredits(tx, { workspaceId, orderId: packOrderId, credits: 10 }),
    )
    expect(posting.applied).toBe(true)
    expect(posting.entry).toMatchObject({
      unit: 'credit_pack',
      kind: 'grant',
      orderId: packOrderId,
      idempotencyKey: `order:${packOrderId}:pack`,
    })
    expect(posting.entry.balanceAfter.toFixed(2)).toBe('10.00')
    expect((await accounts(workspaceId)).pack).toEqual({ balance: '10.00', held: '0.00' })
    expect(await db.billingAccount.findUniqueOrThrow({ where: { id: tariff.id } })).toEqual(tariff)
    // A repeat of the pack grant is a no-op as well.
    const repeat = await db.$transaction((tx) =>
      grantPackCredits(tx, { workspaceId, orderId: packOrderId, credits: 10 }),
    )
    expect(repeat).toEqual({ entry: posting.entry, applied: false })
    expect((await accounts(workspaceId)).pack).toEqual({ balance: '10.00', held: '0.00' })
    await expectBalancesToMatchLedger(workspaceId)
  })

  it('expires only what is available when a task holds a credit', async () => {
    const { workspaceId, orderId, packOrderId, subscriptionId, periodEnd } = await paid()
    await db.$transaction((tx) => grantTariffCredits(tx, { workspaceId, orderId, credits: 30 }))
    await db.$transaction((tx) =>
      grantPackCredits(tx, { workspaceId, orderId: packOrderId, credits: 10 }),
    )
    await fixtures.hold(workspaceId, 'tariff', 2)

    const posting = await db.$transaction((tx) =>
      expireTariffRemainder(tx, { workspaceId, subscriptionId, periodEnd }),
    )
    expect(posting).toMatchObject({
      applied: true,
      entry: {
        unit: 'credit_tariff',
        kind: 'expire',
        orderId: null,
        idempotencyKey: `sub:${subscriptionId}:${periodEnd.getTime()}:expire`,
      },
    })
    expect(posting!.entry.amount.toFixed(2)).toBe('-28.00')
    expect(posting!.entry.balanceAfter.toFixed(2)).toBe('2.00')
    // The held credits stay for their hold, the purchased ones never expire.
    expect(await accounts(workspaceId)).toEqual({
      tariff: { balance: '2.00', held: '2.00' },
      gift: { balance: '0.00', held: '0.00' },
      pack: { balance: '10.00', held: '0.00' },
      count: 3,
    })
    await expectBalancesToMatchLedger(workspaceId)

    // The same period again after the renewal moved on and the next quota arrived: the key
    // answers with the row of the first time.
    const next = await fixtures.order({ workspaceId, planId: (await fixtures.plan()).id })
    const renewal = { workspaceId, subscriptionId, periodEnd, orderId: next.id, credits: 30 }
    expect(await renew(renewal)).toEqual({
      expired: { entry: posting!.entry, applied: false },
      granted: { entry: expect.objectContaining({ orderId: next.id }), applied: true },
    })
    const repeat = await db.$transaction((tx) =>
      expireTariffRemainder(tx, { workspaceId, subscriptionId, periodEnd }),
    )
    expect(repeat).toEqual({ entry: posting!.entry, applied: false })
    expect((await accounts(workspaceId)).tariff).toEqual({ balance: '32.00', held: '2.00' })
    await expectBalancesToMatchLedger(workspaceId)
  })

  it('expires once when the same period end is processed concurrently', async () => {
    const { workspaceId, orderId, subscriptionId, periodEnd } = await paid()
    await db.$transaction((tx) => grantTariffCredits(tx, { workspaceId, orderId, credits: 30 }))
    const expiry = { workspaceId, subscriptionId, periodEnd }
    const postings = await Promise.all(
      Array.from({ length: 6 }, () => db.$transaction((tx) => expireTariffRemainder(tx, expiry))),
    )
    expect(postings.filter((posting) => posting?.applied)).toHaveLength(1)
    expect((await accounts(workspaceId)).tariff).toEqual({ balance: '0.00', held: '0.00' })
    expect(await entries(workspaceId)).toHaveLength(2)
    await expectBalancesToMatchLedger(workspaceId)
  })

  it('writes nothing when there is nothing to expire', async () => {
    const { workspaceId, orderId, subscriptionId, periodEnd } = await paid()
    const expiry = { workspaceId, subscriptionId, periodEnd }
    // No accounts yet: none is created for an expiry.
    expect(await db.$transaction((tx) => expireTariffRemainder(tx, expiry))).toBeNull()
    expect((await accounts(workspaceId)).count).toBe(0)

    // Everything on the account is held.
    await db.$transaction((tx) => grantTariffCredits(tx, { workspaceId, orderId, credits: 3 }))
    await fixtures.hold(workspaceId, 'tariff', 3)
    expect(await db.$transaction((tx) => expireTariffRemainder(tx, expiry))).toBeNull()
    expect((await accounts(workspaceId)).tariff).toEqual({ balance: '3.00', held: '3.00' })
    expect(await entries(workspaceId)).toHaveLength(1)
  })

  it('leaves the new quota alone when a renewal that had nothing to expire runs again', async () => {
    const { workspaceId, plan, orderId, subscriptionId, periodEnd } = await paid()
    await db.$transaction((tx) => grantTariffCredits(tx, { workspaceId, orderId, credits: 3 }))
    // The whole quota is spent: the period ends with nothing available, so no key is written.
    await spend(workspaceId, 3)
    const next = await fixtures.order({ workspaceId, planId: plan.id })
    const renewal = { workspaceId, subscriptionId, periodEnd, orderId: next.id, credits: 30 }

    const first = await renew(renewal)
    expect(first).toMatchObject({ expired: null, granted: { applied: true } })
    expect((await accounts(workspaceId)).tariff).toEqual({ balance: '30.00', held: '0.00' })

    // A second scheduler tick, the webhook after the sweep, a retry after a lost answer.
    expect(await renew(renewal)).toEqual({
      expired: null,
      granted: { entry: first.granted.entry, applied: false },
    })
    const replays = await Promise.all(Array.from({ length: 6 }, () => renew(renewal)))
    expect(replays.every((replay) => replay.expired === null && !replay.granted.applied)).toBe(true)

    expect((await accounts(workspaceId)).tariff).toEqual({ balance: '30.00', held: '0.00' })
    const rows = await entries(workspaceId)
    expect(rows.map((row) => row.kind).sort()).toEqual(['charge', 'grant', 'grant'])
    await expectBalancesToMatchLedger(workspaceId)
  })

  it('grants once and expires nothing when the same renewal runs concurrently', async () => {
    const { workspaceId, plan, orderId, subscriptionId, periodEnd } = await paid()
    await db.$transaction((tx) => grantTariffCredits(tx, { workspaceId, orderId, credits: 3 }))
    await spend(workspaceId, 3)
    const next = await fixtures.order({ workspaceId, planId: plan.id })
    const renewal = { workspaceId, subscriptionId, periodEnd, orderId: next.id, credits: 30 }

    const renewals = await Promise.all(Array.from({ length: 6 }, () => renew(renewal)))
    expect(renewals.filter((result) => result.granted.applied)).toHaveLength(1)
    expect(renewals.every((result) => result.expired === null)).toBe(true)
    expect((await accounts(workspaceId)).tariff).toEqual({ balance: '30.00', held: '0.00' })
    expect((await entries(workspaceId)).filter((row) => row.kind === 'expire')).toEqual([])
    await expectBalancesToMatchLedger(workspaceId)
  })

  it.each(['cancelled', 'expired'] as const)(
    'expires nothing for a subscription that is already %s',
    async (status) => {
      const { workspaceId, plan, orderId, subscriptionId, periodEnd } = await paid()
      await db.$transaction((tx) => grantTariffCredits(tx, { workspaceId, orderId, credits: 30 }))
      const expiry = { workspaceId, subscriptionId, periodEnd }
      // The period is closed in one transaction: the remainder goes, the subscription ends.
      const close = () =>
        db.$transaction(async (tx) => {
          const expired = await expireTariffRemainder(tx, expiry)
          await tx.subscription.update({ where: { id: subscriptionId }, data: { status } })
          return expired
        })
      expect(await close()).toMatchObject({ applied: true })
      expect((await accounts(workspaceId)).tariff).toEqual({ balance: '0.00', held: '0.00' })

      // The customer buys a tariff again: a new subscription and its quota on the same account.
      const next = await fixtures.order({ workspaceId, planId: plan.id })
      await fixtures.subscription({ workspaceId, planId: plan.id })
      await db.$transaction((tx) =>
        grantTariffCredits(tx, { workspaceId, orderId: next.id, credits: 30 }),
      )
      // The end of the old subscription is processed again, under its key and under another.
      expect(await close()).toMatchObject({ applied: false })
      const later = { ...expiry, periodEnd: new Date(periodEnd.getTime() + PERIOD_MS) }
      expect(await db.$transaction((tx) => expireTariffRemainder(tx, later))).toBeNull()
      expect((await accounts(workspaceId)).tariff).toEqual({ balance: '30.00', held: '0.00' })
      expect((await entries(workspaceId)).filter((row) => row.kind === 'expire')).toHaveLength(1)
      await expectBalancesToMatchLedger(workspaceId)
    },
  )

  it('expires only the period the subscription stands in, past_due included', async () => {
    const { workspaceId, orderId, subscriptionId, periodEnd } = await paid()
    await db.$transaction((tx) => grantTariffCredits(tx, { workspaceId, orderId, credits: 30 }))
    const expire = (end: Date) =>
      db.$transaction((tx) =>
        expireTariffRemainder(tx, { workspaceId, subscriptionId, periodEnd: end }),
      )
    // Not the end of the current period: an earlier one, a later one, a millisecond off.
    for (const end of [-PERIOD_MS, PERIOD_MS, -1, 1]) {
      expect(await expire(new Date(periodEnd.getTime() + end))).toBeNull()
    }
    expect((await accounts(workspaceId)).tariff).toEqual({ balance: '30.00', held: '0.00' })
    expect(await entries(workspaceId)).toHaveLength(1)

    // The charge was refused: the period is over all the same and its remainder goes.
    await db.subscription.update({
      where: { id: subscriptionId },
      data: { status: 'past_due', pastDueSince: periodEnd },
    })
    expect(await expire(periodEnd)).toMatchObject({ applied: true })
    expect((await accounts(workspaceId)).tariff).toEqual({ balance: '0.00', held: '0.00' })
    await expectBalancesToMatchLedger(workspaceId)
  })

  it('expires only under a subscription of the same workspace', async () => {
    const { workspaceId, plan, orderId, periodEnd } = await paid()
    const other = await fixtures.workspace()
    const otherOrder = await fixtures.order({ workspaceId: other.workspaceId, planId: plan.id })
    const foreign = await fixtures.subscription({ workspaceId: other.workspaceId, planId: plan.id })
    await db.$transaction((tx) => grantTariffCredits(tx, { workspaceId, orderId, credits: 30 }))
    await db.$transaction((tx) =>
      grantTariffCredits(tx, {
        workspaceId: other.workspaceId,
        orderId: otherOrder.id,
        credits: 30,
      }),
    )

    for (const subscriptionId of [foreign.id, randomUUID()]) {
      await expect(
        db.$transaction((tx) =>
          expireTariffRemainder(tx, { workspaceId, subscriptionId, periodEnd }),
        ),
      ).rejects.toMatchObject({ name: 'DomainError', code: 'BILLING_NO_LIVE_SUBSCRIPTION' })
    }
    // Nothing was written for either workspace, and the key of the other subscription is free.
    for (const id of [workspaceId, other.workspaceId]) {
      expect((await accounts(id)).tariff).toEqual({ balance: '30.00', held: '0.00' })
      expect(await entries(id)).toHaveLength(1)
    }
    const own = { workspaceId: other.workspaceId, subscriptionId: foreign.id }
    expect(
      await db.$transaction((tx) =>
        expireTariffRemainder(tx, { ...own, periodEnd: foreign.currentPeriodEnd }),
      ),
    ).toMatchObject({ applied: true })
    expect((await accounts(workspaceId)).tariff).toEqual({ balance: '30.00', held: '0.00' })
  })

  it('keeps the balance equal to the sum of the ledger through periods', async () => {
    const { workspaceId, plan, packOrderId, subscriptionId, periodEnd } = await paid()
    for (let period = 0; period < 3; period += 1) {
      const order = await fixtures.order({ workspaceId, planId: plan.id })
      await renew({
        workspaceId,
        subscriptionId,
        periodEnd: new Date(periodEnd.getTime() + period * PERIOD_MS),
        orderId: order.id,
        credits: 30 + period,
      })
      await expectBalancesToMatchLedger(workspaceId)
      if (period === 0) {
        await db.$transaction((tx) =>
          grantPackCredits(tx, { workspaceId, orderId: packOrderId, credits: 10 }),
        )
        await fixtures.hold(workspaceId, 'tariff', 1)
      }
    }
    // 30, then −29 (one credit is held) +31, then −31 +32.
    expect(await accounts(workspaceId)).toEqual({
      tariff: { balance: '33.00', held: '1.00' },
      gift: { balance: '0.00', held: '0.00' },
      pack: { balance: '10.00', held: '0.00' },
      count: 3,
    })
    // Each row keeps the balance it left behind.
    const rows = await entries(workspaceId)
    expect(
      rows
        .map(
          (row) =>
            `${row.unit} ${row.kind} ${row.amount.toFixed(0)} → ${row.balanceAfter.toFixed(0)}`,
        )
        .sort(),
    ).toEqual(
      [
        'credit_tariff grant 30 → 30',
        'credit_tariff expire -29 → 1',
        'credit_tariff grant 31 → 32',
        'credit_tariff expire -31 → 1',
        'credit_tariff grant 32 → 33',
        'credit_pack grant 10 → 10',
      ].sort(),
    )
    await expectBalancesToMatchLedger(workspaceId)
  })

  it('leaves no trace of a grant whose transaction is rolled back', async () => {
    const { workspaceId, orderId } = await paid()
    await expect(
      db.$transaction(async (tx) => {
        await grantTariffCredits(tx, { workspaceId, orderId, credits: 30 })
        throw new Error('the order could not be settled')
      }),
    ).rejects.toThrow('the order could not be settled')
    expect((await accounts(workspaceId)).count).toBe(0)
    expect(await entries(workspaceId)).toEqual([])
    // The key is free: the retry grants.
    const retry = await db.$transaction((tx) =>
      grantTariffCredits(tx, { workspaceId, orderId, credits: 30 }),
    )
    expect(retry.applied).toBe(true)
  })

  it('locks an account for the transaction and reports a missing one', async () => {
    const { workspaceId, orderId } = await paid()
    expect(await db.$transaction((tx) => lockCreditAccount(tx, workspaceId, 'tariff'))).toBeNull()
    await db.$transaction((tx) => grantTariffCredits(tx, { workspaceId, orderId, credits: 30 }))
    await fixtures.hold(workspaceId, 'tariff', 4)
    const order: string[] = []
    await db
      .$transaction(async (tx) => {
        const locked = await lockCreditAccount(tx, workspaceId, 'tariff')
        expect(locked).toMatchObject({ unit: 'credit_tariff', snapshot: { balance: 30, held: 4 } })
        expect(await lockCreditAccount(tx, workspaceId, 'pack')).toMatchObject({
          unit: 'credit_pack',
          snapshot: { balance: 0, held: 0 },
        })
        // Another writer of the same account waits for this transaction.
        const waiting = db
          .$transaction((other) => lockCreditAccount(other, workspaceId, 'tariff'))
          .then(() => order.push('second'))
        await new Promise((resolve) => setTimeout(resolve, 300))
        order.push('first')
        return { waiting }
      })
      .then(({ waiting }) => waiting)
    expect(order).toEqual(['first', 'second'])
  })

  describe('the gift of the registration', () => {
    const gift = (userId: string, workspaceId: string) =>
      db.$transaction((tx) => grantSignupGift(tx, { userId, workspaceId }))

    /** Another workspace the user owns, beside the personal one. */
    async function secondWorkspace(userId: string): Promise<string> {
      const workspace = await db.workspace.create({
        data: {
          name: 'Второе пространство',
          createdById: userId,
          dataClass: 'synthetic',
          members: { create: { userId, role: 'owner' } },
        },
        select: { id: true },
      })
      return workspace.id
    }

    const giftAudit = (workspaceIds: string[]) =>
      db.auditLog.findMany({
        where: { workspaceId: { in: workspaceIds }, action: giftAuditActions.grant },
      })

    it('is the 35 credits of the design, on the gift account, with no order behind it', async () => {
      const { userId, workspaceId } = await fixtures.workspace()
      const posting = await gift(userId, workspaceId)

      expect(signupGiftCredits).toBe(35)
      expect(posting.applied).toBe(true)
      expect(await accounts(workspaceId)).toEqual({
        tariff: { balance: '0.00', held: '0.00' },
        gift: { balance: '35.00', held: '0.00' },
        pack: { balance: '0.00', held: '0.00' },
        count: 3,
      })
      const rows = await entries(workspaceId)
      expect(rows).toEqual([posting.entry])
      expect(rows[0]).toMatchObject({
        unit: 'credit_gift',
        kind: 'grant',
        orderId: null,
        taskId: null,
        note: null,
        idempotencyKey: `user:${userId}:signup-gift`,
      })
      expect(rows[0]!.amount.toFixed(2)).toBe('35.00')
      expect(rows[0]!.balanceAfter.toFixed(2)).toBe('35.00')
      await expectBalancesToMatchLedger(workspaceId)

      const account = await db.billingAccount.findUniqueOrThrow({
        where: { workspaceId_unit: { workspaceId, unit: 'credit_gift' } },
      })
      expect(rows[0]!.accountId).toBe(account.id)
      const audit = await giftAudit([workspaceId])
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({
        actorType: 'system',
        actorId: 'billing',
        workspaceId,
        action: 'billing.gift.grant',
        targetType: 'billing_account',
        targetId: account.id,
        meta: { userId, credits: 35 },
        ip: null,
      })
    })

    it('changes nothing when it is granted again: already granted', async () => {
      const { userId, workspaceId } = await fixtures.workspace()
      const first = await gift(userId, workspaceId)
      const account = await db.billingAccount.findUniqueOrThrow({
        where: { workspaceId_unit: { workspaceId, unit: 'credit_gift' } },
      })

      const repeat = await gift(userId, workspaceId)

      expect(repeat).toEqual({ entry: first.entry, applied: false })
      expect(await entries(workspaceId)).toEqual([first.entry])
      expect(await giftAudit([workspaceId])).toHaveLength(1)
      // Not even updated_at moves.
      expect(await db.billingAccount.findUniqueOrThrow({ where: { id: account.id } })).toEqual(
        account,
      )
    })

    it('is granted exactly once when two transactions grant it at the same time', async () => {
      const { userId, workspaceId } = await fixtures.workspace()

      const postings = await Promise.all([gift(userId, workspaceId), gift(userId, workspaceId)])

      expect(postings.filter((posting) => posting.applied)).toHaveLength(1)
      expect(new Set(postings.map((posting) => posting.entry.id)).size).toBe(1)
      expect((await accounts(workspaceId)).gift).toEqual({ balance: '35.00', held: '0.00' })
      expect(await entries(workspaceId)).toHaveLength(1)
      expect(await giftAudit([workspaceId])).toHaveLength(1)
      await expectBalancesToMatchLedger(workspaceId)
    })

    it('is granted exactly once under many concurrent calls', async () => {
      const { userId, workspaceId } = await fixtures.workspace()

      const postings = await Promise.all(Array.from({ length: 8 }, () => gift(userId, workspaceId)))

      expect(postings.filter((posting) => posting.applied)).toHaveLength(1)
      expect(new Set(postings.map((posting) => posting.entry.id)).size).toBe(1)
      expect((await accounts(workspaceId)).gift).toEqual({ balance: '35.00', held: '0.00' })
      expect(await entries(workspaceId)).toHaveLength(1)
      expect(await giftAudit([workspaceId])).toHaveLength(1)
    })

    it('answers «already granted» for a second workspace of the user, not a conflict', async () => {
      const { userId, workspaceId } = await fixtures.workspace()
      const second = await secondWorkspace(userId)
      const first = await gift(userId, workspaceId)

      const repeat = await gift(userId, second)

      // The row of the first workspace, and nothing of its own: no account, no entry.
      expect(repeat).toEqual({ entry: first.entry, applied: false })
      expect(await accounts(second)).toEqual({ tariff: null, gift: null, pack: null, count: 0 })
      expect(await entries(second)).toEqual([])
      expect(await giftAudit([workspaceId, second])).toHaveLength(1)
      expect((await accounts(workspaceId)).gift).toEqual({ balance: '35.00', held: '0.00' })

      // Nor when the second workspace already has its accounts.
      await db.$transaction((tx) => ensureAccounts(tx, second))
      expect(await gift(userId, second)).toEqual({ entry: first.entry, applied: false })
      expect((await accounts(second)).gift).toEqual({ balance: '0.00', held: '0.00' })
      await expectBalancesToMatchLedger(workspaceId)
      await expectBalancesToMatchLedger(second)
    })

    it('grants one gift when two workspaces of the user ask for it at the same time', async () => {
      const { userId, workspaceId } = await fixtures.workspace()
      const second = await secondWorkspace(userId)

      const postings = await Promise.all(
        [workspaceId, second, workspaceId, second, workspaceId, second].map((id) =>
          gift(userId, id),
        ),
      )

      // Nobody was refused, and one call granted.
      expect(postings.filter((posting) => posting.applied)).toHaveLength(1)
      expect(new Set(postings.map((posting) => posting.entry.id)).size).toBe(1)
      const rows = [...(await entries(workspaceId)), ...(await entries(second))]
      expect(rows.map((row) => row.id)).toEqual([postings[0]!.entry.id])
      const balances = [(await accounts(workspaceId)).gift, (await accounts(second)).gift]
      expect(balances.filter((account) => account?.balance === '35.00')).toHaveLength(1)
      expect(balances.filter((account) => (account?.balance ?? '0.00') === '0.00')).toHaveLength(1)
      expect(await giftAudit([workspaceId, second])).toHaveLength(1)
    })

    it('makes the second caller wait for the first and then see its gift', async () => {
      const { userId, workspaceId } = await fixtures.workspace()
      const second = await secondWorkspace(userId)
      const order: string[] = []

      const { first, waiting } = await db.$transaction(async (tx) => {
        const granted = await grantSignupGift(tx, { userId, workspaceId })
        // Not committed yet: a caller that did not wait would find no key and grant again.
        const other = gift(userId, second).then((posting) => {
          order.push('second answers')
          return posting
        })
        await new Promise((resolve) => setTimeout(resolve, 300))
        order.push('first commits')
        return { first: granted, waiting: other }
      })

      expect(await waiting).toEqual({ entry: first.entry, applied: false })
      expect(order).toEqual(['first commits', 'second answers'])
      expect(first.applied).toBe(true)
    })

    it('gives each user a gift of their own', async () => {
      const one = await fixtures.workspace()
      const other = await fixtures.workspace()

      const postings = await Promise.all([
        gift(one.userId, one.workspaceId),
        gift(other.userId, other.workspaceId),
      ])

      expect(postings.map((posting) => posting.applied)).toEqual([true, true])
      for (const { workspaceId } of [one, other]) {
        expect((await accounts(workspaceId)).gift).toEqual({ balance: '35.00', held: '0.00' })
        await expectBalancesToMatchLedger(workspaceId)
      }
    })

    it('adds to nothing but the gift account of a workspace that has credits', async () => {
      const { workspaceId, orderId, packOrderId } = await paid()
      const { userId } = await db.member.findFirstOrThrow({ where: { workspaceId } })
      await db.$transaction((tx) => grantTariffCredits(tx, { workspaceId, orderId, credits: 30 }))
      await db.$transaction((tx) =>
        grantPackCredits(tx, { workspaceId, orderId: packOrderId, credits: 10 }),
      )
      const others = () =>
        db.billingAccount.findMany({
          where: { workspaceId, unit: { not: 'credit_gift' } },
          orderBy: { unit: 'asc' },
        })
      const before = await others()

      await gift(userId, workspaceId)

      expect(await others()).toEqual(before)
      expect(await accounts(workspaceId)).toEqual({
        tariff: { balance: '30.00', held: '0.00' },
        gift: { balance: '35.00', held: '0.00' },
        pack: { balance: '10.00', held: '0.00' },
        count: 3,
      })
      await expectBalancesToMatchLedger(workspaceId)
    })

    it('goes only to a workspace the user owns', async () => {
      const { userId, workspaceId } = await fixtures.workspace()
      const stranger = await fixtures.workspace()
      // A workspace the user was invited to is not theirs to be given credits in.
      await db.member.create({
        data: { workspaceId: stranger.workspaceId, userId, role: 'member' },
      })
      for (const [user, workspace] of [
        [userId, stranger.workspaceId],
        [userId, randomUUID()],
        [randomUUID(), workspaceId],
      ] as const) {
        await expect(gift(user, workspace)).rejects.toMatchObject({
          name: 'DomainError',
          code: 'NOT_FOUND',
        })
      }
      for (const id of [workspaceId, stranger.workspaceId]) {
        expect((await accounts(id)).count).toBe(0)
      }
      expect(await giftAudit([workspaceId, stranger.workspaceId])).toEqual([])
      // The key is free: the gift is still granted where it belongs.
      expect((await gift(userId, workspaceId)).applied).toBe(true)
      expect((await gift(stranger.userId, stranger.workspaceId)).applied).toBe(true)
    })

    it('refuses a key that already stands for something that is not a gift', async () => {
      const { workspaceId, orderId } = await paid()
      const { userId } = await db.member.findFirstOrThrow({ where: { workspaceId } })
      await db.$transaction((tx) => grantTariffCredits(tx, { workspaceId, orderId, credits: 30 }))
      const tariff = await db.billingAccount.findUniqueOrThrow({
        where: { workspaceId_unit: { workspaceId, unit: 'credit_tariff' } },
      })
      await db.creditLedger.create({
        data: {
          accountId: tariff.id,
          unit: 'credit_tariff',
          kind: 'grant',
          amount: 0,
          balanceAfter: 30,
          idempotencyKey: ledgerKeys.signupGift(userId),
        },
      })

      await expect(gift(userId, workspaceId)).rejects.toMatchObject({ code: 'CONFLICT' })

      expect((await accounts(workspaceId)).gift).toEqual({ balance: '0.00', held: '0.00' })
      expect(await giftAudit([workspaceId])).toEqual([])
    })

    it('refuses a key that stands on the gift account for something that is not a grant', async () => {
      const { userId, workspaceId } = await fixtures.workspace()
      await db.$transaction((tx) => ensureAccounts(tx, workspaceId))
      const account = await db.billingAccount.findUniqueOrThrow({
        where: { workspaceId_unit: { workspaceId, unit: 'credit_gift' } },
      })
      // The right account and the right key, but not a gift: an entry written by hand, say.
      const foreign = await db.creditLedger.create({
        data: {
          accountId: account.id,
          unit: 'credit_gift',
          kind: 'adjust',
          amount: 0,
          balanceAfter: 0,
          idempotencyKey: ledgerKeys.signupGift(userId),
        },
      })

      // Not «already granted»: nothing was granted, and the caller must hear of it.
      await expect(gift(userId, workspaceId)).rejects.toMatchObject({
        name: 'DomainError',
        code: 'CONFLICT',
      })

      expect((await accounts(workspaceId)).gift).toEqual({ balance: '0.00', held: '0.00' })
      expect(await entries(workspaceId)).toEqual([foreign])
      expect(await giftAudit([workspaceId])).toEqual([])
    })

    it('keeps the amount of a gift that was granted when the constant was another', async () => {
      const { userId, workspaceId } = await fixtures.workspace()
      await db.$transaction((tx) => ensureAccounts(tx, workspaceId))
      const account = await db.billingAccount.update({
        where: { workspaceId_unit: { workspaceId, unit: 'credit_gift' } },
        data: { balance: 30 },
      })
      const earlier = await db.creditLedger.create({
        data: {
          accountId: account.id,
          unit: 'credit_gift',
          kind: 'grant',
          amount: 30,
          balanceAfter: 30,
          idempotencyKey: ledgerKeys.signupGift(userId),
        },
      })

      expect(await gift(userId, workspaceId)).toEqual({ entry: earlier, applied: false })
      expect((await accounts(workspaceId)).gift).toEqual({ balance: '30.00', held: '0.00' })
    })

    it('leaves no trace when its transaction is rolled back, and is granted by the retry', async () => {
      const { userId } = await fixtures.user()
      // As the product will call it: in the transaction that makes the personal workspace,
      // which holds the lock of the user already.
      const create = (fail: boolean) =>
        db.$transaction(async (tx) => {
          const workspace = await ensurePersonalWorkspace(tx, { userId, appEnv: 'test' })
          const posting = await grantSignupGift(tx, { userId, workspaceId: workspace.id })
          if (fail) throw new Error('the site could not be created')
          return { workspaceId: workspace.id, posting }
        })

      await expect(create(true)).rejects.toThrow('the site could not be created')
      expect(await db.workspace.count({ where: { createdById: userId } })).toBe(0)
      expect(
        await db.creditLedger.count({ where: { idempotencyKey: ledgerKeys.signupGift(userId) } }),
      ).toBe(0)

      const { workspaceId, posting } = await create(false)
      expect(posting.applied).toBe(true)
      expect((await accounts(workspaceId)).gift).toEqual({ balance: '35.00', held: '0.00' })
      expect(await giftAudit([workspaceId])).toHaveLength(1)
      // Whether or not the workspace is new, the call is safe.
      expect((await create(false)).posting).toEqual({ entry: posting.entry, applied: false })
    })

    it('is not expired with the remainder of the tariff when the period ends', async () => {
      const { workspaceId, orderId, subscriptionId, periodEnd } = await paid()
      const { userId } = await db.member.findFirstOrThrow({ where: { workspaceId } })
      await db.$transaction((tx) => grantTariffCredits(tx, { workspaceId, orderId, credits: 30 }))
      await gift(userId, workspaceId)
      const account = await db.billingAccount.findUniqueOrThrow({
        where: { workspaceId_unit: { workspaceId, unit: 'credit_gift' } },
      })

      const expired = await db.$transaction((tx) =>
        expireTariffRemainder(tx, { workspaceId, subscriptionId, periodEnd }),
      )

      expect(expired!.entry.amount.toFixed(2)).toBe('-30.00')
      expect(await db.billingAccount.findUniqueOrThrow({ where: { id: account.id } })).toEqual(
        account,
      )
      expect(await accounts(workspaceId)).toMatchObject({
        tariff: { balance: '0.00', held: '0.00' },
        gift: { balance: '35.00', held: '0.00' },
      })
      await expectBalancesToMatchLedger(workspaceId)
    })
  })
})
