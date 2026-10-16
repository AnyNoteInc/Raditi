import { randomUUID } from 'node:crypto'

import { createPrismaClient, type Prisma, type PrismaClient } from '@repo/db'
import { Money } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { ensureAccounts } from './accounts.ts'
import { grantPackCredits, grantSignupGift, grantTariffCredits, ledgerKeys } from './ledger.ts'
import { ensurePersonalWorkspaceWithGift } from './personal-workspace.ts'
import {
  getCreditBalances,
  getPlanOverview,
  getSubscriptionWaits,
  isSignupGiftGranted,
  listPayments,
  listPlans,
  promisedCredits,
} from './read-models.ts'
import { renewalKey } from './renewal-order.ts'
import { billingFixtures, GIFT_ONLY, NO_GIFT } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
const WORKSPACE = '0199a000-0000-7000-8000-0000000000a1'

type PlansReader = Parameters<typeof listPlans>[0]

const NO_ACCOUNT = { balance: 0, held: 0, available: 0 }
/** What a user without a workspace reads while the gift of the registration is still to come. */
const PROMISED = {
  tariff: NO_ACCOUNT,
  gift: { balance: 35, held: 0, available: 35, granted: false },
  pack: NO_ACCOUNT,
  totalAvailable: 35,
}
/** What the same user reads when nothing is to come. */
const NOTHING = { tariff: NO_ACCOUNT, gift: NO_GIFT, pack: NO_ACCOUNT, totalAvailable: 0 }

describe('isSignupGiftGranted', () => {
  const USER = '0199a000-0000-7000-8000-0000000000d4'
  const reader = (found: { id: string } | null) => {
    const findUnique = vi.fn().mockResolvedValue(found)
    return { db: { creditLedger: { findUnique } } as never, findUnique }
  }

  it('is false while the key of the user is not in the ledger', async () => {
    const { db, findUnique } = reader(null)
    expect(await isSignupGiftGranted(db, USER)).toBe(false)
    // Asked by the key of the user and by nothing else: one indexed read.
    expect(findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { idempotencyKey: `user:${USER}:signup-gift` },
      select: { id: true },
    })
  })

  it('is true once the key stands in the ledger, on whichever workspace', async () => {
    const { db, findUnique } = reader({ id: randomUUID() })
    expect(await isSignupGiftGranted(db, USER)).toBe(true)
    expect(findUnique).toHaveBeenCalledOnce()
  })
})

describe('promisedCredits', () => {
  it('promises the gift of the registration to a user it was not granted to', () => {
    expect(promisedCredits(false)).toEqual(PROMISED)
  })

  it('promises nothing to a user whose gift stands in the ledger', () => {
    expect(promisedCredits(true)).toEqual(NOTHING)
  })
})

const planRow = (data: Record<string, unknown>) => ({
  id: randomUUID(),
  slug: 'start',
  name: 'Старт',
  kind: 'quota',
  price: new Money('4900'),
  creditsPerMonth: 30,
  tasksPerDay: 5,
  maxSites: 1,
  packCredits: null,
  ...data,
})

describe('read models without a database', () => {
  it('answers «no subscription» for a user without a workspace and reads nothing', async () => {
    const findFirst = vi.fn()
    const db = { subscription: { findFirst } } as unknown as Parameters<typeof getPlanOverview>[0]
    expect(await getPlanOverview(db, null)).toEqual({ subscription: null })
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('waits for nothing for a user without a workspace and reads nothing', async () => {
    const findFirst = vi.fn()
    const findUnique = vi.fn()
    const db = {
      subscription: { findFirst },
      order: { findUnique },
    } as unknown as Parameters<typeof getSubscriptionWaits>[0]
    expect(await getSubscriptionWaits(db, null)).toEqual({
      bindingPending: false,
      renewalCharge: 'none',
    })
    expect(findFirst).not.toHaveBeenCalled()
    expect(findUnique).not.toHaveBeenCalled()
  })

  it('asks for active quota tariffs and packs in the order they are shown', async () => {
    const findMany = vi.fn().mockResolvedValue([])
    const db = { plan: { findMany } } as unknown as PlansReader
    expect(await listPlans(db)).toEqual({ plans: [], pack: null })
    expect(findMany).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: { isActive: true, kind: { in: ['quota', 'pack'] } },
        orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }],
      }),
    )
  })

  it('keeps the order of the tariffs and takes the first pack', async () => {
    const rows = [
      planRow({ slug: 'start' }),
      planRow({
        slug: 'pack',
        name: 'Пакет из 100 кредитов',
        kind: 'pack',
        price: new Money('1990'),
        creditsPerMonth: null,
        tasksPerDay: null,
        maxSites: null,
        packCredits: 100,
      }),
      planRow({
        slug: 'business',
        name: 'Бизнес',
        price: new Money('12900'),
        creditsPerMonth: 80,
        tasksPerDay: null,
        maxSites: 3,
      }),
      planRow({ slug: 'pack-50', kind: 'pack', packCredits: 50 }),
    ]
    const db = { plan: { findMany: vi.fn().mockResolvedValue(rows) } } as unknown as PlansReader
    expect(await listPlans(db)).toEqual({
      plans: [
        {
          id: rows[0]!.id,
          slug: 'start',
          name: 'Старт',
          price: '4900.00',
          creditsPerMonth: 30,
          tasksPerDay: 5,
          maxSites: 1,
        },
        {
          id: rows[2]!.id,
          slug: 'business',
          name: 'Бизнес',
          price: '12900.00',
          creditsPerMonth: 80,
          tasksPerDay: null,
          maxSites: 3,
        },
      ],
      pack: {
        id: rows[1]!.id,
        slug: 'pack',
        name: 'Пакет из 100 кредитов',
        price: '1990.00',
        credits: 100,
      },
    })
  })

  it('fails on a tariff row its DTO does not describe instead of showing it', async () => {
    const db = {
      plan: { findMany: vi.fn().mockResolvedValue([planRow({ maxSites: null })]) },
    } as unknown as PlansReader
    await expect(listPlans(db)).rejects.toThrow()
  })

  it('refuses a page size or a cursor outside the query schema before reading', async () => {
    const $queryRaw = vi.fn()
    const db = { $queryRaw } as unknown as Parameters<typeof listPayments>[0]
    await expect(listPayments(db, WORKSPACE, { limit: 0 })).rejects.toThrow()
    await expect(listPayments(db, WORKSPACE, { limit: 101 })).rejects.toThrow()
    await expect(listPayments(db, WORKSPACE, { cursor: 'last' })).rejects.toThrow()
    expect($queryRaw).not.toHaveBeenCalled()
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL read models', () => {
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

  const business = () =>
    fixtures.plan({
      name: 'Бизнес',
      price: '12900.00',
      creditsPerMonth: 80,
      tasksPerDay: 10,
      maxSites: 3,
    })

  describe('plan overview', () => {
    it('answers «no subscription» for a workspace that never had one', async () => {
      const { workspaceId } = await fixtures.workspace()
      expect(await getPlanOverview(db, workspaceId)).toEqual({ subscription: null })
    })

    it('shows the live subscription with its plan, period and payment method', async () => {
      const { workspaceId } = await fixtures.workspace()
      const plan = await business()
      const subscription = await fixtures.subscription({
        workspaceId,
        planId: plan.id,
        paymentMethodId: 'pm-1',
        paymentMethodTitle: 'Bank card *4444',
        paymentMethodType: 'bank_card',
        paymentMethodCardType: 'Mir',
        paymentMethodLast4: '4444',
      })
      expect(await getPlanOverview(db, workspaceId)).toEqual({
        subscription: {
          id: subscription.id,
          status: 'active',
          plan: {
            id: plan.id,
            slug: plan.slug,
            name: 'Бизнес',
            price: '12900.00',
            creditsPerMonth: 80,
            tasksPerDay: 10,
            maxSites: 3,
          },
          period: {
            start: new Date('2026-09-18T09:00:00Z'),
            end: new Date('2026-10-18T09:00:00Z'),
          },
          autoRenewal: true,
          nextPlan: null,
          paymentMethod: { label: 'Карта «Мир» ••\u00a04444' },
          pastDueSince: null,
        },
      })
    })

    it('shows auto-renewal as off without a saved method or after it was switched off', async () => {
      const { workspaceId } = await fixtures.workspace()
      const plan = await business()
      const subscription = await fixtures.subscription({ workspaceId, planId: plan.id })
      expect((await getPlanOverview(db, workspaceId)).subscription).toMatchObject({
        autoRenewal: false,
        paymentMethod: null,
      })

      await db.subscription.update({
        where: { id: subscription.id },
        data: {
          paymentMethodId: 'pm-1',
          paymentMethodType: 'sbp',
          cancelAtPeriodEnd: true,
          cancelledAt: new Date('2026-09-20T09:00:00Z'),
        },
      })
      // The method stays saved: switching auto-renewal back on needs no new binding.
      expect((await getPlanOverview(db, workspaceId)).subscription).toMatchObject({
        autoRenewal: false,
        paymentMethod: { label: 'СБП' },
      })
    })

    it('shows the plan of the next period when a change is scheduled', async () => {
      const { workspaceId } = await fixtures.workspace()
      const plan = await business()
      const agency = await fixtures.plan({
        name: 'Агентство',
        price: '39900.00',
        creditsPerMonth: 250,
        tasksPerDay: 30,
        maxSites: 15,
      })
      await fixtures.subscription({
        workspaceId,
        planId: plan.id,
        nextPlanId: agency.id,
        paymentMethodId: 'pm-1',
        paymentMethodType: 'bank_card',
      })
      expect((await getPlanOverview(db, workspaceId)).subscription).toMatchObject({
        plan: { id: plan.id, name: 'Бизнес', price: '12900.00' },
        nextPlan: {
          id: agency.id,
          slug: agency.slug,
          name: 'Агентство',
          price: '39900.00',
          creditsPerMonth: 250,
          tasksPerDay: 30,
          maxSites: 15,
        },
        autoRenewal: true,
        paymentMethod: { label: 'Банковская карта' },
      })
    })

    it('shows a subscription whose charge failed and since when', async () => {
      const { workspaceId } = await fixtures.workspace()
      const plan = await business()
      const pastDueSince = new Date('2026-10-18T09:00:00Z')
      await fixtures.subscription({
        workspaceId,
        planId: plan.id,
        status: 'past_due',
        pastDueSince,
        paymentMethodId: 'pm-1',
        paymentMethodType: 'bank_card',
        paymentMethodCardType: 'Visa',
        paymentMethodLast4: '4242',
      })
      expect((await getPlanOverview(db, workspaceId)).subscription).toMatchObject({
        status: 'past_due',
        pastDueSince,
        paymentMethod: { label: 'Карта Visa ••\u00a04242' },
      })
    })

    it('ignores ended subscriptions and those of another workspace', async () => {
      const { workspaceId } = await fixtures.workspace()
      const other = await fixtures.workspace()
      const plan = await business()
      await fixtures.subscription({ workspaceId, planId: plan.id, status: 'cancelled' })
      await fixtures.subscription({ workspaceId, planId: plan.id, status: 'expired' })
      await fixtures.subscription({ workspaceId: other.workspaceId, planId: plan.id })
      expect(await getPlanOverview(db, workspaceId)).toEqual({ subscription: null })

      // A later purchase is a new row next to the ended ones.
      const live = await fixtures.subscription({ workspaceId, planId: plan.id })
      expect((await getPlanOverview(db, workspaceId)).subscription).toMatchObject({ id: live.id })
    })
  })

  describe('what a subscription waits for', () => {
    const nothing = { bindingPending: false, renewalCharge: 'none' }
    const PERIOD_END = new Date('2026-10-18T09:00:00Z')

    async function subscribed(data: Partial<Prisma.SubscriptionUncheckedCreateInput> = {}) {
      const { workspaceId } = await fixtures.workspace()
      const plan = await business()
      const subscription = await fixtures.subscription({ workspaceId, planId: plan.id, ...data })
      /** The order of the charge that renews the period ending at `periodEnd`. */
      const charge = (
        order: Partial<Prisma.OrderUncheckedCreateInput>,
        periodEnd: Date = PERIOD_END,
      ) =>
        fixtures.order({
          workspaceId,
          planId: plan.id,
          subscriptionId: subscription.id,
          idempotenceKey: renewalKey(subscription.id, periodEnd),
          ...order,
        })
      return { workspaceId, planId: plan.id, subscriptionId: subscription.id, charge }
    }

    it('waits for nothing without a live subscription, whatever an ended one held', async () => {
      const { workspaceId } = await fixtures.workspace()
      expect(await getSubscriptionWaits(db, workspaceId)).toEqual(nothing)

      const plan = await business()
      await fixtures.subscription({
        workspaceId,
        planId: plan.id,
        status: 'cancelled',
        pendingPaymentMethodId: 'pm-waiting',
      })
      expect(await getSubscriptionWaits(db, workspaceId)).toEqual(nothing)
    })

    it('waits for nothing on a tariff with a saved method and no charge started', async () => {
      const { workspaceId } = await subscribed({ paymentMethodId: 'pm-1' })
      expect(await getSubscriptionWaits(db, workspaceId)).toEqual(nothing)
    })

    it('tells that a binding waits to be read back, and never which one', async () => {
      const { workspaceId } = await subscribed({ pendingPaymentMethodId: 'pm-waiting' })

      const waits = await getSubscriptionWaits(db, workspaceId)

      expect(waits).toEqual({ bindingPending: true, renewalCharge: 'none' })
      expect(JSON.stringify(waits)).not.toContain('pm-waiting')
    })

    it.each([
      ['at the bank', { status: 'pending', yookassaPaymentId: randomUUID() }, 'at_bank'],
      ['without an answer', { status: 'pending' }, 'unanswered'],
      ['paid', { status: 'paid', yookassaPaymentId: randomUUID() }, 'none'],
      ['declined', { status: 'failed', yookassaPaymentId: randomUUID() }, 'none'],
    ] as const)(
      'tells where the charge of the period stands when it is %s',
      async (_case, order, renewalCharge) => {
        const { workspaceId, charge } = await subscribed({ paymentMethodId: 'pm-1' })
        await charge(order)

        expect(await getSubscriptionWaits(db, workspaceId)).toEqual({
          bindingPending: false,
          renewalCharge,
        })
      },
    )

    it('looks at the charge of the current period and of this subscription only', async () => {
      const { workspaceId, planId, charge } = await subscribed({ paymentMethodId: 'pm-1' })
      // An order that never got its payment, of the period before this one.
      await charge({ status: 'pending' }, new Date('2026-09-18T09:00:00Z'))
      // A payment the customer makes by hand, and the charge of another customer.
      await fixtures.order({ workspaceId, planId, status: 'pending', kind: 'pack' })
      const other = await subscribed({ paymentMethodId: 'pm-2' })
      await other.charge({ status: 'pending', yookassaPaymentId: randomUUID() })

      expect(await getSubscriptionWaits(db, workspaceId)).toEqual(nothing)
      expect((await getSubscriptionWaits(db, other.workspaceId)).renewalCharge).toBe('at_bank')
    })
  })

  describe('plans on sale', () => {
    // The transaction is rolled back: the plans of the test are never on sale for anyone
    // else who reads a shared database.
    class Rollback extends Error {}

    it('lists active quota tariffs by sort order and the first active pack', async () => {
      // plans.slug holds 50 characters.
      const unique = randomUUID().slice(0, 13)
      const quota = (slug: string, sortOrder: number, data: object = {}) => ({
        slug: `${slug}-${unique}`,
        name: slug,
        kind: 'quota' as const,
        price: '4900.00',
        creditsPerMonth: 30,
        tasksPerDay: 5,
        maxSites: 1,
        sortOrder,
        ...data,
      })
      const packOf = (slug: string, sortOrder: number, data: object = {}) => ({
        slug: `${slug}-${unique}`,
        name: slug,
        kind: 'pack' as const,
        price: '1990.00',
        packCredits: 10,
        sortOrder,
        ...data,
      })
      const lowest = -1_000_000
      await expect(
        db.$transaction(async (tx) => {
          await tx.plan.createMany({
            data: [
              quota('second', lowest + 2, { price: '12900.00', tasksPerDay: null }),
              quota('first', lowest + 1),
              quota('withdrawn', lowest, { isActive: false }),
              { ...quota('payg', lowest), kind: 'payg', price: '0.00' },
              packOf('pack-later', lowest + 4),
              packOf('pack', lowest + 3),
              packOf('pack-withdrawn', lowest, { isActive: false }),
            ],
          })
          const { plans, pack } = await listPlans(tx)
          const own = plans.filter((plan) => plan.slug.endsWith(unique))
          expect(own.map((plan) => plan.name)).toEqual(['first', 'second'])
          // They sort before every plan a shared database may already have.
          expect(plans.slice(0, 2)).toEqual(own)
          expect(own[1]).toEqual({
            id: expect.any(String),
            slug: `second-${unique}`,
            name: 'second',
            price: '12900.00',
            creditsPerMonth: 30,
            tasksPerDay: null,
            maxSites: 1,
          })
          expect(pack).toEqual({
            id: expect.any(String),
            slug: `pack-${unique}`,
            name: 'pack',
            price: '1990.00',
            credits: 10,
          })
          // Whatever else is on sale in this database is a quota tariff too.
          const kinds = await tx.plan.findMany({
            where: { id: { in: plans.map((plan) => plan.id) } },
            select: { kind: true, isActive: true },
          })
          expect(kinds).toHaveLength(plans.length)
          expect(kinds.every((row) => row.kind === 'quota' && row.isActive)).toBe(true)
          throw new Rollback()
        }),
      ).rejects.toBeInstanceOf(Rollback)
      expect(
        await db.plan.count({
          where: { slug: { in: [`first-${unique}`, `second-${unique}`, `pack-${unique}`] } },
        }),
      ).toBe(0)
    })
  })

  describe('credit balances', () => {
    it('shows zeros while the workspace has no accounts', async () => {
      const { workspaceId } = await fixtures.workspace()
      const empty = { balance: 0, held: 0, available: 0 }
      expect(await getCreditBalances(db, workspaceId)).toEqual({
        tariff: empty,
        gift: NO_GIFT,
        pack: empty,
        totalAvailable: 0,
      })
      expect(await db.billingAccount.count({ where: { workspaceId } })).toBe(0)
    })

    it('shows balance, held and available credits of the tariff and of the pack', async () => {
      const { workspaceId } = await fixtures.workspace()
      const other = await fixtures.workspace()
      const plan = await business()
      const packPlan = await fixtures.plan({
        kind: 'pack',
        price: '1990.00',
        creditsPerMonth: null,
        tasksPerDay: null,
        maxSites: null,
        packCredits: 10,
      })
      // Each account is granted from an order of its own kind.
      const grant = async (target: string, credits: number, pack = false) => {
        const order = await fixtures.order(
          pack
            ? { workspaceId: target, planId: packPlan.id, kind: 'pack', amount: '1990.00' }
            : { workspaceId: target, planId: plan.id },
        )
        const input = { workspaceId: target, orderId: order.id, credits }
        await db.$transaction((tx) =>
          pack ? grantPackCredits(tx, input) : grantTariffCredits(tx, input),
        )
      }
      await grant(workspaceId, 47)
      expect(await getCreditBalances(db, workspaceId)).toEqual({
        tariff: { balance: 47, held: 0, available: 47 },
        // The account exists by now, and nothing was granted to it.
        gift: NO_GIFT,
        pack: { balance: 0, held: 0, available: 0 },
        totalAvailable: 47,
      })

      await grant(workspaceId, 10, true)
      await grant(other.workspaceId, 5)
      await fixtures.hold(workspaceId, 'tariff', 2)
      await fixtures.hold(workspaceId, 'pack', 1)
      expect(await getCreditBalances(db, workspaceId)).toEqual({
        tariff: { balance: 47, held: 2, available: 45 },
        gift: NO_GIFT,
        pack: { balance: 10, held: 1, available: 9 },
        totalAvailable: 54,
      })
      expect((await getCreditBalances(db, other.workspaceId)).totalAvailable).toBe(5)
    })

    it('shows the gift once it is granted, counts it in what is left and keeps it granted', async () => {
      const { userId, workspaceId } = await fixtures.workspace()
      const other = await fixtures.workspace()
      await db.$transaction((tx) => grantSignupGift(tx, { userId, workspaceId }))
      const empty = { balance: 0, held: 0, available: 0 }
      expect(await getCreditBalances(db, workspaceId)).toEqual({
        tariff: empty,
        gift: { balance: 35, held: 0, available: 35, granted: true },
        pack: empty,
        totalAvailable: 35,
      })

      // Next to a tariff and with a part of it reserved.
      const order = await fixtures.order({ workspaceId, planId: (await business()).id })
      await db.$transaction((tx) =>
        grantTariffCredits(tx, { workspaceId, orderId: order.id, credits: 47 }),
      )
      await fixtures.hold(workspaceId, 'gift', 5)
      expect(await getCreditBalances(db, workspaceId)).toEqual({
        tariff: { balance: 47, held: 0, available: 47 },
        gift: { balance: 35, held: 5, available: 30, granted: true },
        pack: empty,
        totalAvailable: 77,
      })

      // Spent to the last credit, it is still the gift that was granted.
      await db.creditHold.deleteMany({ where: { account: { workspaceId } } })
      await db.billingAccount.update({
        where: { workspaceId_unit: { workspaceId, unit: 'credit_gift' } },
        data: { balance: 0, held: 0 },
      })
      expect((await getCreditBalances(db, workspaceId)).gift).toEqual({
        ...empty,
        granted: true,
      })
      // The gift of one user is not the gift of another.
      expect((await getCreditBalances(db, other.workspaceId)).gift).toEqual(NO_GIFT)
    })

    it('tells of the account, not of the user: another workspace of the user is not granted', async () => {
      const { userId, workspaceId } = await fixtures.workspace()
      const second = await db.workspace.create({
        data: {
          name: 'Второе пространство',
          createdById: userId,
          dataClass: 'synthetic',
          members: { create: { userId, role: 'owner' } },
        },
        select: { id: true },
      })
      await db.$transaction((tx) => grantSignupGift(tx, { userId, workspaceId }))

      // The user has had their gift, and the second workspace will never get one — yet it reads
      // `granted: false`, without its accounts and with them. Whether a gift is still to come
      // is told by the key of the user, never by this field.
      expect((await getCreditBalances(db, second.id)).gift).toEqual(NO_GIFT)
      const again = await db.$transaction((tx) =>
        grantSignupGift(tx, { userId, workspaceId: second.id }),
      )
      expect(again.applied).toBe(false)
      await db.$transaction((tx) => ensureAccounts(tx, second.id))
      expect((await getCreditBalances(db, second.id)).gift).toEqual(NO_GIFT)
      expect(
        await db.creditLedger.count({ where: { idempotencyKey: ledgerKeys.signupGift(userId) } }),
      ).toBe(1)
      expect((await getCreditBalances(db, workspaceId)).gift.granted).toBe(true)
    })

    it('does not take a grant of the tariff or of a pack for the gift', async () => {
      const { workspaceId } = await fixtures.workspace()
      const packPlan = await fixtures.plan({
        kind: 'pack',
        price: '1990.00',
        creditsPerMonth: null,
        tasksPerDay: null,
        maxSites: null,
        packCredits: 10,
      })
      const order = await fixtures.order({ workspaceId, planId: (await business()).id })
      const packOrder = await fixtures.order({
        workspaceId,
        planId: packPlan.id,
        kind: 'pack',
        amount: '1990.00',
      })
      await db.$transaction(async (tx) => {
        await grantTariffCredits(tx, { workspaceId, orderId: order.id, credits: 47 })
        await grantPackCredits(tx, { workspaceId, orderId: packOrder.id, credits: 10 })
      })
      expect((await getCreditBalances(db, workspaceId)).gift).toEqual(NO_GIFT)
    })

    it('does not count the rouble wallet as credits', async () => {
      const { workspaceId } = await fixtures.workspace()
      await db.billingAccount.create({ data: { workspaceId, unit: 'rub', balance: '1500.50' } })
      expect((await getCreditBalances(db, workspaceId)).totalAvailable).toBe(0)
    })
  })

  describe('the gift before the workspace', () => {
    const made = (userId: string) =>
      db.$transaction((tx) => ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }))

    /** What a user without a personal workspace reads, by one read of their key. */
    const promisedTo = async (userId: string) =>
      promisedCredits(await isSignupGiftGranted(db, userId))

    it('is promised to a user without a workspace, and nothing is written for the promise', async () => {
      const { userId } = await fixtures.user()

      expect(await isSignupGiftGranted(db, userId)).toBe(false)
      expect(await promisedTo(userId)).toEqual(PROMISED)

      expect(await db.workspace.count({ where: { createdById: userId } })).toBe(0)
      expect(
        await db.creditLedger.count({ where: { idempotencyKey: ledgerKeys.signupGift(userId) } }),
      ).toBe(0)
    })

    it('is what the workspace then holds: the promise is kept to the credit', async () => {
      const { userId } = await fixtures.user()
      const promised = await promisedTo(userId)

      const workspace = await made(userId)

      const stored = await getCreditBalances(db, workspace.id)
      expect(stored).toEqual(GIFT_ONLY)
      // The same numbers, now of the account: only `granted` tells the two apart.
      expect(stored).toEqual({ ...promised, gift: { ...promised.gift, granted: true } })
    })

    it('is not promised again to a user who has had it, whatever became of that workspace', async () => {
      const { userId } = await fixtures.user()
      const other = await fixtures.user()
      const workspace = await made(userId)
      // The workspace is shared now, so the user has no personal one — and no second gift.
      await db.member.create({
        data: { workspaceId: workspace.id, userId: other.userId, role: 'member' },
      })

      expect(await isSignupGiftGranted(db, userId)).toBe(true)
      expect(await promisedTo(userId)).toEqual(NOTHING)
      // The gift of one user says nothing about another.
      expect(await isSignupGiftGranted(db, other.userId)).toBe(false)
      expect(await promisedTo(other.userId)).toEqual(PROMISED)
    })
  })

  describe('payment history', () => {
    /** Sets the moment an order was created to the microsecond, as PostgreSQL keeps it. */
    const createdAt = (orderId: string, moment: string) =>
      db.$executeRaw`UPDATE orders SET created_at = ${moment}::timestamptz WHERE id = ${orderId}::uuid`

    it('shows what each order paid for, how much and how it ended', async () => {
      const { workspaceId, userId } = await fixtures.workspace()
      const plan = await business()
      const pack = await fixtures.plan({
        name: 'Пакет из 100 кредитов',
        kind: 'pack',
        price: '1990.00',
        creditsPerMonth: null,
        tasksPerDay: null,
        maxSites: null,
        packCredits: 100,
      })
      const period = {
        periodStart: new Date('2026-09-18T09:00:00Z'),
        periodEnd: new Date('2026-10-18T09:00:00Z'),
      }
      const paid = await fixtures.order({
        workspaceId,
        userId,
        planId: plan.id,
        amount: '12900.00',
        paidAt: new Date('2026-09-18T09:00:05Z'),
        createdAt: new Date('2026-09-18T09:00:00Z'),
        yookassaPaymentId: `pay-${randomUUID()}`,
        ...period,
      })
      const failed = await fixtures.order({
        workspaceId,
        planId: plan.id,
        amount: '12900.00',
        status: 'failed',
        failureReason: 'card_declined',
        createdAt: new Date('2026-09-18T08:00:00Z'),
      })
      const refunded = await fixtures.order({
        workspaceId,
        planId: pack.id,
        kind: 'pack',
        amount: '1990.00',
        status: 'refunded',
        paidAt: new Date('2026-08-02T10:00:00Z'),
        refundedAmount: '1990.00',
        refundedAt: new Date('2026-08-05T10:00:00Z'),
        yookassaRefundId: `refund-${randomUUID()}`,
        createdAt: new Date('2026-08-02T09:59:00Z'),
      })
      const topup = await fixtures.order({
        workspaceId,
        planId: null,
        kind: 'topup',
        amount: '500.50',
        status: 'pending',
        createdAt: new Date('2026-08-01T09:00:00Z'),
      })

      expect(await listPayments(db, workspaceId)).toEqual({
        items: [
          {
            id: paid.id,
            kind: 'subscription',
            planName: 'Бизнес',
            period: { start: period.periodStart, end: period.periodEnd },
            amount: '12900.00',
            status: 'paid',
            failureReason: null,
            failureText: null,
            refundedAmount: null,
            refundedAt: null,
            paidAt: new Date('2026-09-18T09:00:05Z'),
            createdAt: new Date('2026-09-18T09:00:00Z'),
          },
          {
            id: failed.id,
            kind: 'subscription',
            planName: 'Бизнес',
            period: null,
            amount: '12900.00',
            status: 'failed',
            failureReason: 'card_declined',
            // A reason without a sentence of its own gets the neutral one, never the code.
            failureText: 'Платёж не прошёл. Попробуйте ещё раз или выберите другой способ оплаты.',
            refundedAmount: null,
            refundedAt: null,
            paidAt: null,
            createdAt: new Date('2026-09-18T08:00:00Z'),
          },
          {
            id: refunded.id,
            kind: 'pack',
            planName: 'Пакет из 100 кредитов',
            period: null,
            amount: '1990.00',
            status: 'refunded',
            failureReason: null,
            failureText: null,
            refundedAmount: '1990.00',
            refundedAt: new Date('2026-08-05T10:00:00Z'),
            paidAt: new Date('2026-08-02T10:00:00Z'),
            createdAt: new Date('2026-08-02T09:59:00Z'),
          },
          {
            id: topup.id,
            kind: 'topup',
            planName: null,
            period: null,
            amount: '500.50',
            status: 'pending',
            failureReason: null,
            failureText: null,
            refundedAmount: null,
            refundedAt: null,
            paidAt: null,
            createdAt: new Date('2026-08-01T09:00:00Z'),
          },
        ],
        nextCursor: null,
      })
    })

    it('tells why an order failed in a sentence, and only for an order that failed', async () => {
      const { workspaceId } = await fixtures.workspace()
      const plan = await fixtures.plan()
      const order = (minute: number, data: Partial<Prisma.OrderUncheckedCreateInput>) =>
        fixtures.order({
          workspaceId,
          planId: plan.id,
          createdAt: new Date(Date.UTC(2026, 8, 18, 9, minute)),
          ...data,
        })
      await order(3, { status: 'failed', failureReason: 'insufficient_funds' })
      await order(2, { status: 'failed', failureReason: null })
      // Closed by us, with a reason left in the row: nothing failed for the customer.
      await order(1, { status: 'cancelled', failureReason: 'expired_on_confirmation' })
      await order(0, { status: 'pending' })

      const { items } = await listPayments(db, workspaceId)

      expect(items.map(({ status, failureText }) => [status, failureText])).toEqual([
        ['failed', 'Недостаточно средств. Пополните счёт или выберите другой способ оплаты.'],
        ['failed', 'Платёж не прошёл. Попробуйте ещё раз или выберите другой способ оплаты.'],
        ['cancelled', null],
        ['pending', null],
      ])
    })

    it('pages newest first without skipping or repeating an order', async () => {
      const { workspaceId } = await fixtures.workspace()
      const plan = await business()
      const orders = await Promise.all(
        Array.from({ length: 7 }, () => fixtures.order({ workspaceId, planId: plan.id })),
      )
      // Moments a Date cannot tell apart, and two orders of the very same moment.
      const moments = [
        '2026-09-01 10:00:00.123456+00',
        '2026-09-01 10:00:00.123457+00',
        '2026-09-01 10:00:00.123001+00',
        '2026-09-01 10:00:00.123999+00',
        '2026-09-01 10:00:00.123456+00',
        '2026-09-01 10:00:00.124000+00',
        '2026-08-31 23:59:59.999999+00',
      ]
      await Promise.all(orders.map((order, index) => createdAt(order.id, moments[index]!)))
      const expected = orders
        .map((order, index) => ({ id: order.id, moment: moments[index]! }))
        .sort((a, b) => {
          if (a.moment !== b.moment) return a.moment < b.moment ? 1 : -1
          return a.id < b.id ? 1 : -1
        })
        .map((order) => order.id)

      for (const limit of [1, 2, 3, 7, 100]) {
        const seen: string[] = []
        let cursor: string | undefined
        let pages = 0
        do {
          const page = await listPayments(db, workspaceId, { cursor, limit })
          expect(page.items.length).toBeLessThanOrEqual(limit)
          seen.push(...page.items.map((item) => item.id))
          cursor = page.nextCursor ?? undefined
          pages += 1
        } while (cursor !== undefined && pages < 20)
        expect(seen, `limit ${limit}`).toEqual(expected)
        // The row read ahead of each page spares the reader an empty last page.
        expect(pages, `limit ${limit}`).toBe(Math.max(1, Math.ceil(7 / limit)))
      }

      // The page after the last order is empty.
      expect(await listPayments(db, workspaceId, { cursor: expected.at(-1), limit: 3 })).toEqual({
        items: [],
        nextCursor: null,
      })
    })

    it('shows only the orders of the workspace and takes no cursor from another', async () => {
      const { workspaceId } = await fixtures.workspace()
      const other = await fixtures.workspace()
      const plan = await business()
      const own = await fixtures.order({ workspaceId, planId: plan.id })
      const foreign = await fixtures.order({ workspaceId: other.workspaceId, planId: plan.id })
      await createdAt(foreign.id, '2030-01-01 00:00:00+00')

      expect((await listPayments(db, workspaceId)).items.map((item) => item.id)).toEqual([own.id])
      const empty = { items: [], nextCursor: null }
      // An order of another workspace, newer than everything here, opens nothing.
      expect(await listPayments(db, workspaceId, { cursor: foreign.id })).toEqual(empty)
      expect(await listPayments(db, workspaceId, { cursor: randomUUID() })).toEqual(empty)
      expect(await listPayments(db, randomUUID())).toEqual(empty)
    })
  })
})
