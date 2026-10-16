import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import { Money } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { writeBillingAudit, type BillingAuditEntry } from './audit.ts'
import { billingFixtures, inRolledBackTransaction } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
const WORKSPACE = '0199a000-0000-7000-8000-0000000000a1'
const USER = '0199a000-0000-7000-8000-0000000000d4'
const SUBSCRIPTION = '0199a000-0000-7000-8000-0000000000c3'

const entry: BillingAuditEntry = {
  actor: { type: 'user', id: USER },
  workspaceId: WORKSPACE,
  action: 'billing.auto_renewal.cancel',
  target: { type: 'subscription', id: SUBSCRIPTION },
  meta: { planSlug: 'business', price: new Money('12900').toFixed(2), creditsLeft: 45 },
  ip: '203.0.113.7',
}

function fakeTx() {
  const create = vi.fn().mockResolvedValue({})
  return {
    create,
    tx: { auditLog: { create } } as unknown as Parameters<typeof writeBillingAudit>[0],
  }
}

describe('billing audit entry', () => {
  it('writes who did what to which object, with the amount as a string', async () => {
    const { create, tx } = fakeTx()
    await writeBillingAudit(tx, entry)
    expect(create).toHaveBeenCalledExactlyOnceWith({
      data: {
        actorType: 'user',
        actorId: USER,
        workspaceId: WORKSPACE,
        action: 'billing.auto_renewal.cancel',
        targetType: 'subscription',
        targetId: SUBSCRIPTION,
        meta: { planSlug: 'business', price: '12900.00', creditsLeft: 45 },
        ip: '203.0.113.7',
      },
    })
  })

  it('writes the scheduler and an operator without a target, details or an address', async () => {
    const { create, tx } = fakeTx()
    await writeBillingAudit(tx, {
      actor: { type: 'system', id: 'core' },
      workspaceId: WORKSPACE,
      action: 'billing.period.end',
    })
    await writeBillingAudit(tx, {
      actor: { type: 'operator', id: 'support' },
      workspaceId: WORKSPACE,
      action: 'billing.refund',
      ip: '2001:db8::7',
    })
    expect(create.mock.calls.map(([call]) => (call as { data: object }).data)).toEqual([
      {
        actorType: 'system',
        actorId: 'core',
        workspaceId: WORKSPACE,
        action: 'billing.period.end',
      },
      {
        actorType: 'operator',
        actorId: 'support',
        workspaceId: WORKSPACE,
        action: 'billing.refund',
        ip: '2001:db8::7',
      },
    ])
  })

  it('writes what an operator did to the platform itself without a workspace', async () => {
    const { create, tx } = fakeTx()
    const RATE = '0199a000-0000-7000-8000-0000000000e5'
    await writeBillingAudit(tx, {
      actor: { type: 'operator', id: 'owner' },
      action: 'billing.credit_rate.approve',
      target: { type: 'credit_rate', id: RATE },
      meta: { rubPerCredit: '6.000000', prices: 2 },
    })
    expect(create).toHaveBeenCalledExactlyOnceWith({
      data: {
        actorType: 'operator',
        actorId: 'owner',
        workspaceId: undefined,
        action: 'billing.credit_rate.approve',
        targetType: 'credit_rate',
        targetId: RATE,
        meta: { rubPerCredit: '6.000000', prices: 2 },
        ip: undefined,
      },
    })
  })

  it('writes what the platform charged a task, about the task itself', async () => {
    const { create, tx } = fakeTx()
    const TASK = '0199a000-0000-7000-8000-0000000000f6'
    const meta = { charged: 17, fromTariff: 5, fromPack: 12, costRub: '101.3700000000' }
    await writeBillingAudit(tx, {
      actor: { type: 'system', id: 'billing' },
      workspaceId: WORKSPACE,
      action: 'billing.task.charge',
      target: { type: 'task', id: TASK },
      meta: { ...meta, minimumApplied: false },
    })
    expect(create).toHaveBeenCalledExactlyOnceWith({
      data: {
        actorType: 'system',
        actorId: 'billing',
        workspaceId: WORKSPACE,
        action: 'billing.task.charge',
        targetType: 'task',
        targetId: TASK,
        meta: { ...meta, minimumApplied: false },
        ip: undefined,
      },
    })
  })

  it.each(['user', 'system'] as const)(
    'refuses an entry of the actor %s that names no workspace',
    async (type) => {
      const { create, tx } = fakeTx()
      const { workspaceId: _, ...nowhere } = { ...entry, actor: { type, id: USER } }
      await expect(writeBillingAudit(tx, nowhere as unknown as BillingAuditEntry)).rejects.toThrow()
      expect(create).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['a fractional number for money', { meta: { price: 12900.5 } }],
    ['a Decimal for money', { meta: { price: new Money('12900') } }],
    ['a nested object', { meta: { plan: { slug: 'business' } } }],
    ['a list', { meta: { plans: ['start', 'business'] } }],
    ['an empty detail name', { meta: { '': 'x' } }],
    ['a text longer than the log shows', { meta: { reason: 'x'.repeat(501) } }],
    ['an action outside billing', { action: 'site.credentials.write' }],
    ['an action that is not a dotted verb', { action: 'billing.Cancel auto-renewal' }],
    ['the bare namespace', { action: 'billing' }],
    ['an action longer than the column', { action: `billing.${'a'.repeat(121)}` }],
    ['the agent as the actor', { actor: { type: 'agent', id: 'codex' } }],
    ['an actor without an id', { actor: { type: 'user', id: '' } }],
    ['an actor id longer than the column', { actor: { type: 'operator', id: 'o'.repeat(129) } }],
    ['a workspace that is not a UUID', { workspaceId: 'workspace' }],
    ['a target that billing does not own', { target: { type: 'site', id: SUBSCRIPTION } }],
    ['a target without an id', { target: { type: 'order', id: '' } }],
    ['an address that is not one', { ip: 'localhost' }],
    ['an unknown field', { userId: USER }],
  ])('refuses %s and writes nothing', async (_name, change) => {
    const { create, tx } = fakeTx()
    await expect(
      writeBillingAudit(tx, { ...entry, ...change } as unknown as BillingAuditEntry),
    ).rejects.toThrow()
    expect(create).not.toHaveBeenCalled()
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL billing audit', () => {
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

  it('commits the row with the change it describes', async () => {
    const { userId, workspaceId } = await fixtures.workspace()
    const plan = await fixtures.plan()
    const subscription = await fixtures.subscription({
      workspaceId,
      planId: plan.id,
      paymentMethodId: 'pm-1',
    })
    const before = Date.now()
    await db.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id: subscription.id },
        data: { cancelAtPeriodEnd: true, cancelledAt: new Date() },
      })
      await writeBillingAudit(tx, {
        actor: { type: 'user', id: userId },
        workspaceId,
        action: 'billing.auto_renewal.cancel',
        target: { type: 'subscription', id: subscription.id },
        meta: {
          price: plan.price.toFixed(2),
          creditsPerMonth: plan.creditsPerMonth,
          resumed: false,
        },
        ip: '203.0.113.7',
      })
    })
    const rows = await db.auditLog.findMany({ where: { workspaceId } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actorType: 'user',
      actorId: userId,
      workspaceId,
      action: 'billing.auto_renewal.cancel',
      targetType: 'subscription',
      targetId: subscription.id,
      meta: { price: '4900.00', creditsPerMonth: 30, resumed: false },
      ip: '203.0.113.7',
    })
    expect(rows[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(rows[0]!.createdAt.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('leaves no row when the change is rolled back', async () => {
    const { userId, workspaceId } = await fixtures.workspace()
    await expect(
      db.$transaction(async (tx) => {
        await writeBillingAudit(tx, {
          actor: { type: 'user', id: userId },
          workspaceId,
          action: 'billing.plan_change.schedule',
          target: { type: 'subscription', id: randomUUID() },
        })
        throw new Error('the change failed')
      }),
    ).rejects.toThrow('the change failed')
    expect(await db.auditLog.count({ where: { workspaceId } })).toBe(0)
  })

  it('stores the entry of an operator about the credit rate without a workspace', async () => {
    const rateId = randomUUID()
    // Nothing of this entry belongs to a workspace a cleanup could find it by: never committed.
    const rows = await inRolledBackTransaction(db, async (tx) => {
      await writeBillingAudit(tx, {
        actor: { type: 'operator', id: 'owner' },
        action: 'billing.credit_rate.approve',
        target: { type: 'credit_rate', id: rateId },
        meta: { rubPerCredit: '6.000000', prices: 0, reason: 'Первый курс' },
      })
      return tx.auditLog.findMany({ where: { targetType: 'credit_rate', targetId: rateId } })
    })
    expect(rows).toMatchObject([
      {
        actorType: 'operator',
        actorId: 'owner',
        workspaceId: null,
        action: 'billing.credit_rate.approve',
        meta: { rubPerCredit: '6.000000', prices: 0, reason: 'Первый курс' },
        ip: null,
      },
    ])
    expect(await db.auditLog.count({ where: { targetId: rateId } })).toBe(0)
  })

  it('keeps the row after its workspace and user are gone', async () => {
    const { userId, workspaceId } = await fixtures.workspace()
    await db.$transaction((tx) =>
      writeBillingAudit(tx, {
        actor: { type: 'user', id: userId },
        workspaceId,
        action: 'billing.payment_method.unbind',
      }),
    )
    await db.workspace.delete({ where: { id: workspaceId } })
    await db.user.delete({ where: { id: userId } })
    expect(await db.auditLog.findMany({ where: { workspaceId } })).toMatchObject([
      { actorId: userId, action: 'billing.payment_method.unbind', targetType: null, meta: null },
    ])
  })
})
