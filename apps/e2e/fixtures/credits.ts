import { randomUUID } from 'node:crypto'

import { chargeTask, placeCreditHold, type ChargedTask } from '@repo/billing'
import {
  writeModelCall,
  writeModelPool,
  writeModelPrice,
  type TestModelPool,
} from '@repo/billing/testing'
import { createPrismaClient, type ModelClass, type PrismaClient } from '@repo/db'

import { databaseUrl } from './billing-stand.ts'
import { test as signedIn, type SignedInUser } from './signed-in.ts'

// The credits of a signed-in customer for the browser checks: what the database holds — the
// pages are compared with it, not with numbers typed into a test —, and the one part of the
// credits model nothing of the product runs yet: a task. The task queue (P12) will set credits
// aside when a task is queued and charge it when it is done; until then the fixture does what
// the queue will, with the functions the queue will call — `placeCreditHold` and `chargeTask`
// of @repo/billing — and nothing else: no reserve, no ledger row and no balance is written
// here by hand. What a task cost comes from its model calls, written the way the subscription
// gateway records them (`writeModelCall` of @repo/billing/testing), and `chargeTask` reads
// them itself.

/** The three credit accounts, in the order their credits are spent in. */
export type CreditAccount = 'tariff' | 'gift' | 'pack'

const UNIT = { tariff: 'credit_tariff', gift: 'credit_gift', pack: 'credit_pack' } as const
const ACCOUNTS = Object.keys(UNIT) as CreditAccount[]

/** An account as the database holds it; `left` is what is not set aside. */
export interface StoredAccount {
  balance: number
  held: number
  left: number
}

/** A row of the journal of a credit account. */
export interface JournalRow {
  account: CreditAccount
  kind: string
  amount: number
  key: string
  orderId: string | null
  taskId: string | null
}

/** A task in work: its reserve is placed. */
export interface TaskInWork {
  id: string
  /** What the reserve set aside, by account. */
  reserved: Record<CreditAccount, number>
  /**
   * The task is done. `costRub` is the accounting cost of its model calls ("22.09"): the
   * charge is what that comes to in credits, as `chargeTask` counts it — never a number of
   * the test.
   */
  done(costRub: string): Promise<ChargedTask>
}

export interface Credits {
  /** The personal workspace of the customer; null until a first site or a checkout makes it. */
  workspaceId(): Promise<string | null>
  /** The three accounts of the workspace; all empty while there is none. */
  stored(): Promise<Record<CreditAccount, StoredAccount>>
  /** The journal of the three accounts, oldest first. */
  journal(): Promise<JournalRow[]>
  /** The live subscription of the customer. */
  subscription(): Promise<{ id: string; currentPeriodEnd: Date; status: string }>
  /** A site of the workspace, added past the form: the workspace must exist. */
  site(name: string): Promise<{ id: string; name: string }>
  /**
   * A task of the customer is queued and taken into work on a site of the workspace: its
   * reserve is placed by `placeCreditHold`, with every check of a placement. `modelClass` is
   * the mode it runs in: `standard` unless told otherwise, `heavy` for a large one.
   */
  task(input: { title: string; modelClass?: ModelClass }): Promise<TaskInWork>
  /**
   * The tariff of the customer ended with its period, a day ago — by its row alone: the
   * subscription is rewritten, and what the scheduler does besides is not done. Nothing on the
   * tariff account is expired, no audit entry and no letter is written. So it ends only a
   * tariff with nothing left on its account and refuses any other: tariff credits without a
   * tariff are a state the product never leaves.
   */
  tariffEnded(): Promise<void>
}

interface Queue {
  prisma: PrismaClient
  pool: TestModelPool
  priceId: string
}

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

export const test = signedIn.extend<{ credits: Credits }, { taskQueue: Queue }>({
  taskQueue: [
    // eslint-disable-next-line no-empty-pattern -- Playwright wants a destructuring pattern here.
    async ({}, use) => {
      const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
      // A model of the run's own, with a price a credit rate of any age covers. Not enabled:
      // it takes no part in what the pages say of rates, and the catalogue stays as seeded.
      const pool = await prisma.$transaction((tx) => writeModelPool(tx))
      const price = await writeModelPrice(prisma, pool, {
        effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
      })
      await use({ prisma, pool, priceId: price.id })
      await prisma.subscriptionAccount.deleteMany({ where: { id: pool.accountId } })
      await prisma.credentialRef.deleteMany({ where: { id: pool.credentialRefId } })
      await prisma.llmModelPrice.deleteMany({ where: { modelId: pool.modelId } })
      await prisma.llmModel.deleteMany({ where: { id: pool.modelId } })
      await prisma.llmProvider.deleteMany({ where: { id: pool.providerId } })
      await prisma.agentDriver.deleteMany({ where: { id: pool.driverId } })
      await prisma.$disconnect()
    },
    { scope: 'worker' },
  ],

  credits: async ({ taskQueue, signedInUser }, use) => {
    await use(creditsOf(taskQueue, signedInUser))
    // The rows of the tasks go with the user: `accounts.remove` of signed-in.ts.
  },
})

function creditsOf({ prisma, pool, priceId }: Queue, user: SignedInUser): Credits {
  const workspaceId = async () =>
    (await prisma.workspace.findFirst({ where: { createdById: user.id }, select: { id: true } }))
      ?.id ?? null

  const workspace = async () => {
    const id = await workspaceId()
    if (id === null) throw new Error('The customer has no workspace yet')
    return id
  }

  const stored = async () => {
    const id = await workspaceId()
    const rows =
      id === null
        ? []
        : await prisma.billingAccount.findMany({
            where: { workspaceId: id },
            select: { unit: true, balance: true, held: true },
          })
    const of = (account: CreditAccount): StoredAccount => {
      const row = rows.find(({ unit }) => unit === UNIT[account])
      const balance = row?.balance.toNumber() ?? 0
      const held = row?.held.toNumber() ?? 0
      return { balance, held, left: balance - held }
    }
    return { tariff: of('tariff'), gift: of('gift'), pack: of('pack') }
  }

  const journal = async () => {
    const id = await workspaceId()
    if (id === null) return []
    const rows = await prisma.creditLedger.findMany({
      where: { account: { workspaceId: id } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        unit: true,
        kind: true,
        amount: true,
        idempotencyKey: true,
        orderId: true,
        taskId: true,
      },
    })
    return rows.map((row): JournalRow => {
      const account = ACCOUNTS.find((name) => UNIT[name] === row.unit)
      if (account === undefined) throw new Error(`A journal row of the unit ${row.unit}`)
      return {
        account,
        kind: row.kind,
        amount: row.amount.toNumber(),
        key: row.idempotencyKey,
        orderId: row.orderId,
        taskId: row.taskId,
      }
    })
  }

  const subscription = async () => {
    const row = await prisma.subscription.findFirst({
      where: { workspaceId: await workspace(), status: { in: ['active', 'past_due'] } },
      select: { id: true, currentPeriodEnd: true, status: true },
    })
    if (row === null) throw new Error('The customer has no live subscription')
    return row
  }

  const site = async (name: string) =>
    prisma.site.create({
      data: {
        workspaceId: await workspace(),
        name,
        // An address of its own: a site spends gift credits in one workspace only.
        url: `https://credits-${randomUUID()}.example.ru`,
        stack: 'wordpress',
      },
      select: { id: true, name: true },
    })

  const task: Credits['task'] = async ({ title, modelClass = 'standard' }) => {
    const id = await workspace()
    const on = await prisma.site.findFirst({
      where: { workspaceId: id },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    if (on === null) throw new Error('The workspace has no site to work on')
    const { id: taskId } = await prisma.task.create({
      data: {
        workspaceId: id,
        siteId: on.id,
        createdById: user.id,
        modelClass,
        summary: title,
        status: 'running',
      },
      select: { id: true },
    })
    const now = new Date()
    const placed = await prisma.$transaction(
      (tx) =>
        placeCreditHold(tx, {
          workspaceId: id,
          taskId,
          attempt: 1,
          now,
          expiresAt: new Date(now.getTime() + HOUR_MS),
        }),
      { timeout: 30_000 },
    )
    const reserved = { tariff: 0, gift: 0, pack: 0 }
    for (const hold of placed.holds) {
      const account = ACCOUNTS.find((name) => UNIT[name] === hold.unit)
      if (account !== undefined) reserved[account] += hold.amount.toNumber()
    }
    return {
      id: taskId,
      reserved,
      async done(costRub) {
        const finished = new Date()
        // One finished model call of the task, its turn key closed: what the gateway leaves.
        await prisma.$transaction((tx) =>
          writeModelCall(tx, { taskId, pool, priceId, costRub, occurredAt: finished }),
        )
        // The task is moved to `done` and charged in one transaction, as the queue will do it.
        return prisma.$transaction(
          async (tx) => {
            await tx.task.update({
              where: { id: taskId },
              data: { status: 'done', finishedAt: finished },
            })
            return chargeTask(tx, { taskId, now: finished })
          },
          { timeout: 30_000 },
        )
      },
    }
  }

  const tariffEnded = async () => {
    const { id } = await subscription()
    if ((await stored()).tariff.balance > 0)
      throw new Error(
        'tariffEnded() does not expire a remainder: end a tariff with nothing left on its account',
      )
    const ended = new Date(Date.now() - DAY_MS)
    await prisma.subscription.update({
      where: { id },
      data: {
        status: 'cancelled',
        currentPeriodStart: new Date(ended.getTime() - 30 * DAY_MS),
        currentPeriodEnd: ended,
      },
    })
  }

  return { workspaceId, stored, journal, subscription, site, task, tariffEnded }
}

export { expect } from '@playwright/test'
