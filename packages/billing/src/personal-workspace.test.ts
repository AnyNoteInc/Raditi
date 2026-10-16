import { randomUUID } from 'node:crypto'

import {
  createPrismaClient,
  ensurePersonalWorkspace,
  findPersonalWorkspace,
  type PrismaClient,
} from '@repo/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { giftAuditActions, ledgerKeys } from './ledger.ts'
import { ensurePersonalWorkspaceWithGift } from './personal-workspace.ts'
import { getCreditBalances } from './read-models.ts'
import { billingFixtures, GIFT_ONLY, NO_GIFT } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL personal workspace with the gift', () => {
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

  /** One caller: a transaction of its own, as `project.create` and `startCheckout` open it. */
  const ensure = (userId: string) =>
    db.$transaction((tx) => ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }), {
      isolationLevel: 'ReadCommitted',
    })

  const giftRows = (userId: string) =>
    db.creditLedger.findMany({ where: { idempotencyKey: ledgerKeys.signupGift(userId) } })
  const workspacesOf = (userId: string) =>
    db.workspace.findMany({ where: { createdById: userId }, select: { id: true } })
  const giftEntries = (workspaceId: string) =>
    db.auditLog.findMany({ where: { workspaceId, action: giftAuditActions.grant } })

  /** One workspace with its three accounts, one gift on it and one audit entry of the grant. */
  async function oneWorkspaceOneGift(userId: string, workspaceId: string) {
    expect(await workspacesOf(userId)).toEqual([{ id: workspaceId }])
    expect(await getCreditBalances(db, workspaceId)).toEqual(GIFT_ONLY)
    const rows = await giftRows(userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'grant', unit: 'credit_gift', orderId: null })
    expect(rows[0]?.amount.toFixed(2)).toBe('35.00')
    expect(rows[0]?.balanceAfter.toFixed(2)).toBe('35.00')
    const accounts = await db.billingAccount.findMany({ where: { workspaceId } })
    expect(accounts.map(({ unit }) => unit).sort()).toEqual([
      'credit_gift',
      'credit_pack',
      'credit_tariff',
    ])
    expect(accounts.find(({ unit }) => unit === 'credit_gift')?.id).toBe(rows[0]?.accountId)
    const entries = await giftEntries(workspaceId)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.meta).toEqual({ userId, credits: 35 })
  }

  it('makes the workspace of a new user and grants the gift of the registration with it', async () => {
    const { userId } = await fixtures.user()

    const workspace = await ensure(userId)

    expect(await findPersonalWorkspace(db, { userId, appEnv: 'test' })).toEqual(workspace)
    await oneWorkspaceOneGift(userId, workspace.id)
  })

  it('changes nothing when it is called again: the same workspace and the same gift', async () => {
    const { userId } = await fixtures.user()
    const first = await ensure(userId)
    const [row] = await giftRows(userId)

    for (let call = 0; call < 3; call += 1) expect(await ensure(userId)).toEqual(first)

    await oneWorkspaceOneGift(userId, first.id)
    expect((await giftRows(userId))[0]?.id).toBe(row?.id)
  })

  it.each([2, 8])(
    'gives one workspace and one gift to %i creations of the workspace that race',
    async (callers) => {
      const { userId } = await fixtures.user()

      const workspaces = await Promise.all(Array.from({ length: callers }, () => ensure(userId)))

      const [first] = workspaces
      if (first === undefined) throw new Error('No caller returned')
      expect(new Set(workspaces.map(({ id }) => id)).size).toBe(1)
      await oneWorkspaceOneGift(userId, first.id)
    },
  )

  it('keeps the users apart: each of two that race gets a workspace and a gift of their own', async () => {
    const anna = await fixtures.user()
    const boris = await fixtures.user()

    const [first, second, third, fourth] = await Promise.all([
      ensure(anna.userId),
      ensure(boris.userId),
      ensure(anna.userId),
      ensure(boris.userId),
    ])

    expect(first).toEqual(third)
    expect(second).toEqual(fourth)
    expect(first?.id).not.toBe(second?.id)
    await oneWorkspaceOneGift(anna.userId, first?.id ?? '')
    await oneWorkspaceOneGift(boris.userId, second?.id ?? '')
  })

  it('grants the gift to a workspace that was made before it, at the next call', async () => {
    const { userId } = await fixtures.user()
    // As the product made a workspace before the gift existed.
    const legacy = await db.$transaction((tx) =>
      ensurePersonalWorkspace(tx, { userId, appEnv: 'test' }),
    )
    expect(await giftRows(userId)).toEqual([])
    expect((await getCreditBalances(db, legacy.id)).gift).toEqual(NO_GIFT)

    expect(await ensure(userId)).toEqual(legacy)

    await oneWorkspaceOneGift(userId, legacy.id)
  })

  it('grants no second gift to a user whose first workspace is no longer personal', async () => {
    const { userId } = await fixtures.user()
    const other = await fixtures.user()
    const first = await ensure(userId)
    // Shared with somebody: the next site or payment of the user makes a new personal one.
    await db.member.create({
      data: { workspaceId: first.id, userId: other.userId, role: 'member' },
    })

    const second = await ensure(userId)

    expect(second.id).not.toBe(first.id)
    expect(await workspacesOf(userId)).toHaveLength(2)
    // The gift stands where it was granted, once; the new workspace has none.
    const rows = await giftRows(userId)
    expect(rows).toHaveLength(1)
    expect((await getCreditBalances(db, first.id)).gift.granted).toBe(true)
    expect((await getCreditBalances(db, second.id)).gift).toEqual(NO_GIFT)
    expect(await giftEntries(second.id)).toEqual([])
    // Nothing is written for the second workspace, its accounts included.
    expect(await db.billingAccount.count({ where: { workspaceId: second.id } })).toBe(0)
  })

  it('takes the workspace and the gift back with a transaction that fails, and grants on the retry', async () => {
    const { userId } = await fixtures.user()
    class Refused extends Error {}

    await expect(
      db.$transaction(async (tx) => {
        const workspace = await ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' })
        // The caller sees its own gift before it decides.
        expect(await getCreditBalances(tx, workspace.id)).toEqual(GIFT_ONLY)
        throw new Refused()
      }),
    ).rejects.toBeInstanceOf(Refused)

    expect(await workspacesOf(userId)).toEqual([])
    expect(await giftRows(userId)).toEqual([])

    const workspace = await ensure(userId)
    await oneWorkspaceOneGift(userId, workspace.id)
  })

  it('refuses a user who no longer exists and writes nothing', async () => {
    const userId = randomUUID()

    await expect(ensure(userId)).rejects.toMatchObject({ code: 'UNAUTHORIZED', httpStatus: 401 })

    expect(await workspacesOf(userId)).toEqual([])
    expect(await giftRows(userId)).toEqual([])
  })
})
