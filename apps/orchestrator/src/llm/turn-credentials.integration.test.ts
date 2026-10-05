import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import type { SecretStore, TurnCredentialGrant, TurnCredentialRef } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { GatewayTurnCredentials } from './turn-credentials.ts'
import { turnCredentialPath } from './turn-key.ts'
import { PostgresGatewayStore } from '../llm-gateway/store.ts'

const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function memoryVault() {
  const entries = new Map<
    string,
    { data: Record<string, string>; custom: Record<string, string>; deleted: boolean }
  >()
  const secrets = {
    kvRead: vi.fn(async (path: string) => {
      const entry = entries.get(path)
      return entry && !entry.deleted ? { version: 1, data: { ...entry.data } } : null
    }),
    kvMetadata: vi.fn(async (path: string) => {
      const entry = entries.get(path)
      return entry
        ? {
            currentVersion: 1,
            custom: { ...entry.custom },
            createdTime: new Date(),
            deleted: entry.deleted,
            destroyed: false,
          }
        : null
    }),
    kvCreateOnce: vi.fn(
      async (path: string, data: Record<string, string>, custom: Record<string, string>) => {
        const existing = entries.get(path)
        if (existing) {
          existing.custom = custom
          return 'exists' as const
        }
        entries.set(path, { data: { ...data }, custom: { ...custom }, deleted: false })
        return 'created' as const
      },
    ),
    kvDelete: vi.fn(async (path: string) => {
      const entry = entries.get(path)
      if (entry) entry.deleted = true
    }),
    kvDestroyAll: vi.fn(async (path: string) => {
      entries.delete(path)
    }),
  }
  return { entries, ...secrets, port: secrets as unknown as SecretStore }
}

describe.skipIf(!enabled)('fenced turn keys, write-once recovery and admission closure', () => {
  let db: PrismaClient
  let providerId: string
  const tracked: {
    workspaceId: string
    modelId: string
    accountIds: string[]
    credentialIds: string[]
    clearanceIds: string[]
  }[] = []

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    const provider = await db.llmProvider.findUniqueOrThrow({ where: { slug: 'kimi-code' } })
    providerId = provider.id
    // Other suites use synthetic drivers. These fixtures exclusively use the seeded kimi driver.
    await db.llmProvider.update({ where: { id: providerId }, data: { enabled: true } })
  })

  afterEach(async () => {
    for (const row of tracked.splice(0)) {
      const tasks = { task: { workspaceId: row.workspaceId } }
      await db.creditHold.deleteMany({ where: tasks })
      await db.billingAccount.deleteMany({ where: { workspaceId: row.workspaceId } })
      await db.tokenUsage.deleteMany({ where: tasks })
      await db.llmCall.deleteMany({ where: { key: tasks } })
      await db.llmKey.deleteMany({ where: tasks })
      await db.taskAccountBinding.deleteMany({ where: tasks })
      await db.turnAssignment.deleteMany({ where: { task: { workspaceId: row.workspaceId } } })
      await db.taskEvent.deleteMany({ where: tasks })
      await db.siteLease.deleteMany({ where: { site: { workspaceId: row.workspaceId } } })
      await db.task.deleteMany({ where: { workspaceId: row.workspaceId } })
      await db.site.deleteMany({ where: { workspaceId: row.workspaceId } })
      await db.workspace.delete({ where: { id: row.workspaceId } })
      await db.llmModelPrice.deleteMany({ where: { modelId: row.modelId } })
      await db.llmModel.delete({ where: { id: row.modelId } })
      await db.subscriptionAccount.deleteMany({ where: { id: { in: row.accountIds } } })
      await db.credentialRef.deleteMany({ where: { id: { in: row.credentialIds } } })
      await db.crossBorderClearance.deleteMany({ where: { id: { in: row.clearanceIds } } })
    }
  })

  afterAll(async () => {
    // This database is discarded by verify:db. The store suite owns provider flags and may
    // still be running; this suite must never disable its provider from another worker.
    await db.$disconnect()
  })

  async function fixture(
    options: { client?: boolean; price?: boolean; windows?: boolean; slots?: number } = {},
  ) {
    const suffix = randomUUID().replaceAll('-', '')
    const workspace = await db.workspace.create({
      data: {
        name: 'Synthetic turn key verification',
        dataClass: options.client ? 'client' : 'synthetic',
      },
    })
    const model = await db.llmModel.create({
      data: {
        providerId,
        slug: `turn-${suffix}`,
        name: 'Synthetic',
        providerModelId: 'synthetic',
        modelClass: 'standard',
        reserveOutputTokens: 32_768,
        enabled: true,
      },
    })
    const row = {
      workspaceId: workspace.id,
      modelId: model.id,
      accountIds: [] as string[],
      credentialIds: [] as string[],
      clearanceIds: [] as string[],
    }
    tracked.push(row)
    const vault = memoryVault()
    const credentials = new GatewayTurnCredentials({ prisma: db, secrets: vault.port })
    const price =
      options.price === false
        ? null
        : await db.llmModelPrice.create({
            data: {
              modelId: model.id,
              effectiveFrom: new Date(Date.now() - 86_400_000),
              inputPer1m: '1000',
              outputPer1m: '2000',
              vatRate: '0.2200',
              sourceUrl: 'https://synthetic.invalid/rates',
            },
          })
    async function task() {
      const site = await db.site.create({
        data: {
          workspaceId: workspace.id,
          name: 'Synthetic',
          url: `https://${randomUUID()}.invalid`,
          stack: 'wordpress',
        },
      })
      const task = await db.task.create({
        data: {
          workspaceId: workspace.id,
          siteId: site.id,
          status: 'running',
          modelClass: 'standard',
        },
      })
      await db.siteLease.create({
        data: {
          siteId: site.id,
          holderTaskId: task.id,
          epoch: 1,
          operation: 'turn',
          expiresAt: new Date(Date.now() + 1_200_000),
        },
      })
      const ref: TurnCredentialRef = { taskId: task.id, sessionId: randomUUID(), turn: 1, epoch: 1 }
      return { task, site, ref }
    }
    async function account(
      options: { usedPct?: number; maxTurns?: number; suspended?: boolean } = {},
    ) {
      const id = randomUUID()
      const credential = await db.credentialRef.create({
        data: { kind: 'subscription', vaultPath: `subs/kimi-code/${id}` },
      })
      row.credentialIds.push(credential.id)
      row.accountIds.push(id)
      return db.subscriptionAccount.create({
        data: {
          id,
          providerId,
          driverId: 'kimi',
          label: `turn-${id}`,
          credentialRefId: credential.id,
          plan: 'synthetic',
          enabled: true,
          credentialVersion: 1,
          health: options.suspended ? 'suspended' : 'ok',
          healthChangedAt: options.suspended ? new Date() : null,
          maxConcurrentTurns: options.maxTurns ?? 1,
          maxConcurrentRequests: 3,
          limitWindows: [
            {
              name: '5h',
              usedPct: options.usedPct ?? 10,
              resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
            },
          ],
        },
      })
    }
    const mainAccount = await account({ maxTurns: options.slots ?? 1 })
    if (options.windows === false)
      await db.subscriptionAccount.update({
        where: { id: mainAccount.id },
        data: { limitWindows: [] },
      })
    const initial = await task()
    const grant: TurnCredentialGrant = {
      driverId: 'kimi',
      backend: 'kimi-code',
      modelSlug: model.slug,
      modelClass: 'standard',
      reasoningEffort: null,
      ttlMs: 600_000,
      deadlineAt: new Date(Date.now() + 1_200_000),
      // At 1000/2000 ₽ per 1M and 32 768 output tokens the first call reserves 105.536 ₽.
      budgetRub: '200.00',
      boundSource: null,
    }
    /** Moves the task to pay-as-you-go with an active wallet reserve of this attempt. */
    async function payAsYouGo(taskId: string, holdRub: string | null) {
      const rule = await db.pricingRule.findFirstOrThrow({
        where: { modelClass: 'standard' },
        orderBy: { effectiveFrom: 'desc' },
      })
      await db.task.update({ where: { id: taskId }, data: { pricingRuleId: rule.id } })
      if (holdRub === null) return rule
      const wallet = await db.billingAccount.create({
        data: { workspaceId: workspace.id, unit: 'rub', balance: holdRub, held: holdRub },
      })
      await db.creditHold.create({
        data: {
          accountId: wallet.id,
          unit: 'rub',
          taskId,
          amount: holdRub,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      })
      return rule
    }
    return {
      ...initial,
      workspace,
      model,
      mainAccount,
      price,
      vault,
      credentials,
      grant,
      taskFixture: task,
      account,
      payAsYouGo,
      row,
    }
  }

  it('persists the selected binding and secret hash, and retry preserves the first budget and expiry', async () => {
    const f = await fixture()
    const issued = await f.credentials.issue(f.ref, f.grant)
    const key = await db.llmKey.findFirstOrThrow({ where: { taskId: f.task.id } })
    expect(key).toMatchObject({
      keyHash: sha256(issued.llmApiKey),
      subscriptionAccountId: f.mainAccount.id,
      taskAttempt: 1,
    })
    expect(key.budgetRub.toFixed(2)).toBe('200.00')
    expect(
      await db.taskAccountBinding.findUniqueOrThrow({ where: { taskId: f.task.id } }),
    ).toMatchObject({ subscriptionAccountId: f.mainAccount.id, rebinds: 0 })
    expect(f.vault.entries.get(turnCredentialPath(f.ref))!.data.accountId).toBe(f.mainAccount.id)
    expect(
      await f.credentials.issue(f.ref, { ...f.grant, budgetRub: '750.00', ttlMs: 1_200_000 }),
    ).toEqual(issued)
    const retried = await db.llmKey.findUniqueOrThrow({ where: { id: key.id } })
    expect(retried.budgetRub.toFixed(2)).toBe('200.00')
    expect(retried.expiresAt).toEqual(key.expiresAt)
    expect(await f.credentials.recover(f.ref)).toEqual(issued)
    expect(
      await new PostgresGatewayStore(db).lookup(sha256(issued.llmApiKey), '127.0.0.1'),
    ).toMatchObject({
      keyId: key.id,
      accountId: f.mainAccount.id,
      modelId: f.model.id,
      budgetRub: '200.0000000000',
    })
  })

  it.each([
    ['above the standard quota ceiling', '285.01', 'above_ceiling'],
    ['at the cap of any key, but above the class ceiling', '750.00', 'above_ceiling'],
    ['below the first call reserve', '105.53', 'below_first_call'],
  ])('issues no key for a budget %s', async (_name, budgetRub, budget) => {
    const f = await fixture()
    await expect(f.credentials.issue(f.ref, { ...f.grant, budgetRub })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      details: { budget },
    })
    expect(f.vault.entries.size).toBe(0)
    expect(await db.llmKey.count({ where: { taskId: f.task.id } })).toBe(0)
    expect(await db.taskAccountBinding.count({ where: { taskId: f.task.id } })).toBe(0)
  })

  it('accepts the whole quota ceiling and the first call reserve exactly', async () => {
    const f = await fixture()
    await f.credentials.issue(f.ref, { ...f.grant, budgetRub: '285.00' })
    const second = await f.taskFixture()
    await f.account()
    await f.credentials.issue(second.ref, { ...f.grant, budgetRub: '105.54' })
    expect(await db.llmKey.count({ where: { taskId: { in: [f.task.id, second.task.id] } } })).toBe(
      2,
    )
  })

  it('checks the latest effective rate, not any earlier one', async () => {
    const f = await fixture()
    await db.llmModelPrice.create({
      data: {
        modelId: f.model.id,
        effectiveFrom: new Date(Date.now() - 3_600_000),
        inputPer1m: '1000',
        outputPer1m: '5000',
        vatRate: '0.2200',
        sourceUrl: 'https://synthetic.invalid/rates-next-quarter',
      },
    })
    // 40 000 × 1000 + 32 768 × 5000 per million: a 203.84 ₽ first call no longer fits 200 ₽.
    await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      details: { budget: 'below_first_call' },
    })
  })

  it('bounds a pay-as-you-go key by its active reserve, not by the quota ceiling', async () => {
    const f = await fixture()
    // The seeded rule: (hold − 30 ₽ fee) / markup 2.
    await f.payAsYouGo(f.task.id, '1200.00')
    await f.credentials.issue(f.ref, { ...f.grant, budgetRub: '585.00' })
    expect(
      (await db.llmKey.findFirstOrThrow({ where: { taskId: f.task.id } })).budgetRub.toFixed(2),
    ).toBe('585.00')
    const second = await f.taskFixture()
    await f.account()
    await f.payAsYouGo(second.task.id, null)
    await expect(f.credentials.issue(second.ref, f.grant)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(await db.llmKey.count({ where: { taskId: second.task.id } })).toBe(0)
  })

  it('refuses a pay-as-you-go key above what its reserve pays for', async () => {
    const f = await fixture()
    await f.payAsYouGo(f.task.id, '600.00')
    await expect(
      f.credentials.issue(f.ref, { ...f.grant, budgetRub: '285.01' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', details: { budget: 'above_ceiling' } })
    await f.credentials.issue(f.ref, { ...f.grant, budgetRub: '285.00' })
  })

  it('bounds a non-billable task with a pinned pricing rule by its class ceiling: it has no reserve', async () => {
    const f = await fixture()
    // «Отменить» and operator retries keep the rule pinned at queueing but reserve nothing.
    await f.payAsYouGo(f.task.id, null)
    await db.task.update({ where: { id: f.task.id }, data: { billable: false } })
    await expect(
      f.credentials.issue(f.ref, { ...f.grant, budgetRub: '285.01' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', details: { budget: 'above_ceiling' } })
    expect(f.vault.entries.size).toBe(0)
    await f.credentials.issue(f.ref, { ...f.grant, budgetRub: '285.00' })
    expect(
      (await db.llmKey.findFirstOrThrow({ where: { taskId: f.task.id } })).budgetRub.toFixed(2),
    ).toBe('285.00')
    // A billable task of the same plan still pays from its reserve and needs one.
    const second = await f.taskFixture()
    await f.account()
    await f.payAsYouGo(second.task.id, null)
    await expect(f.credentials.issue(second.ref, f.grant)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      details: { budget: 'no_reserve' },
    })
    expect(await db.llmKey.count({ where: { taskId: second.task.id } })).toBe(0)
  })

  it('refuses a task whose workspace is not the workspace of its site, before any secret exists', async () => {
    // The data sent to the provider belongs to the site: a synthetic workspace on the task row
    // must not open the 152-FZ gate of a client site (rule 1). MCP admission refuses it too.
    const f = await fixture()
    const client = await db.workspace.create({
      data: { name: 'Synthetic client workspace', dataClass: 'client' },
    })
    const site = await db.site.create({
      data: {
        workspaceId: client.id,
        name: 'Synthetic client site',
        url: `https://${randomUUID()}.invalid`,
        stack: 'wordpress',
      },
    })
    const task = await db.task.create({
      data: {
        workspaceId: f.workspace.id,
        siteId: site.id,
        status: 'running',
        modelClass: 'standard',
      },
    })
    try {
      await db.siteLease.create({
        data: {
          siteId: site.id,
          holderTaskId: task.id,
          epoch: 1,
          operation: 'turn',
          expiresAt: new Date(Date.now() + 1_200_000),
        },
      })
      const ref: TurnCredentialRef = { taskId: task.id, sessionId: randomUUID(), turn: 1, epoch: 1 }
      await expect(f.credentials.issue(ref, f.grant)).rejects.toMatchObject({ code: 'LEASE_LOST' })
      expect(await db.llmKey.count({ where: { taskId: task.id } })).toBe(0)
      expect(await db.taskAccountBinding.count({ where: { taskId: task.id } })).toBe(0)
      expect(f.vault.kvCreateOnce).not.toHaveBeenCalled()
      expect(f.vault.entries.size).toBe(0)
      // The same site under its own workspace reaches the gate and is refused by it.
      await db.task.update({ where: { id: task.id }, data: { workspaceId: client.id } })
      await expect(f.credentials.issue(ref, f.grant)).rejects.toMatchObject({
        code: 'CROSS_BORDER_NOT_CLEARED',
      })
      expect(f.vault.kvCreateOnce).not.toHaveBeenCalled()
    } finally {
      await db.llmKey.deleteMany({ where: { taskId: task.id } })
      await db.taskAccountBinding.deleteMany({ where: { taskId: task.id } })
      await db.taskEvent.deleteMany({ where: { taskId: task.id } })
      await db.siteLease.deleteMany({ where: { siteId: site.id } })
      await db.task.delete({ where: { id: task.id } })
      await db.site.delete({ where: { id: site.id } })
      await db.workspace.delete({ where: { id: client.id } })
    }
  })

  it('stops returning a key once the task row leaves the workspace of its site, and still revokes it', async () => {
    const f = await fixture()
    const issued = await f.credentials.issue(f.ref, f.grant)
    const other = await db.workspace.create({
      data: { name: 'Synthetic foreign workspace', dataClass: 'synthetic' },
    })
    try {
      await db.task.update({ where: { id: f.task.id }, data: { workspaceId: other.id } })
      // The retry of the same turn has the key in SQL and in Vault, and gets neither.
      await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({
        code: 'LEASE_LOST',
      })
      // Closing is never fenced by the task row: the key must not outlive such a turn.
      await f.credentials.revoke(f.ref)
      const key = await db.llmKey.findFirstOrThrow({ where: { taskId: f.task.id } })
      expect(key.revokedAt).not.toBeNull()
      expect(f.vault.entries.has(turnCredentialPath(f.ref))).toBe(false)
      expect(await f.credentials.recover(f.ref)).toBeNull()
      expect(
        await new PostgresGatewayStore(db).lookup(sha256(issued.llmApiKey), '127.0.0.1'),
      ).toBeNull()
    } finally {
      // afterEach removes the rows of the fixture's workspace: the task goes back to it first.
      await db.task.update({ where: { id: f.task.id }, data: { workspaceId: f.workspace.id } })
      await db.workspace.delete({ where: { id: other.id } })
    }
  })

  it('writes no secret for a task that leaves the workspace of its site after its lease was read', async () => {
    const f = await fixture()
    const other = await db.workspace.create({
      data: { name: 'Synthetic foreign workspace', dataClass: 'synthetic' },
    })
    let moves = 0
    // The row changes inside the issuing transaction, after ownedTask has read it: only the
    // fence that closes account selection can still refuse before the Vault write.
    const moving = {
      $transaction: (work: (tx: unknown) => Promise<unknown>, options?: object) =>
        db.$transaction(
          (tx) =>
            work(
              new Proxy(tx, {
                get(target, property) {
                  if (property !== 'llmModelPrice') return Reflect.get(target, property, target)
                  return {
                    findFirst: async (args: Parameters<typeof tx.llmModelPrice.findFirst>[0]) => {
                      if (moves++ === 0)
                        await db.task.update({
                          where: { id: f.task.id },
                          data: { workspaceId: other.id },
                        })
                      return tx.llmModelPrice.findFirst(args)
                    },
                  }
                },
              }),
            ),
          options,
        ),
    } as unknown as PrismaClient
    const credentials = new GatewayTurnCredentials({ prisma: moving, secrets: f.vault.port })
    try {
      await expect(credentials.issue(f.ref, f.grant)).rejects.toMatchObject({ code: 'LEASE_LOST' })
      expect(moves).toBe(1)
      expect(f.vault.kvCreateOnce).not.toHaveBeenCalled()
      expect(f.vault.entries.size).toBe(0)
      expect(await db.llmKey.count({ where: { taskId: f.task.id } })).toBe(0)
      expect(await db.taskAccountBinding.count({ where: { taskId: f.task.id } })).toBe(0)
    } finally {
      // afterEach removes the rows of the fixture's workspace: the task goes back to it first.
      await db.task.update({ where: { id: f.task.id }, data: { workspaceId: f.workspace.id } })
      await db.workspace.delete({ where: { id: other.id } })
    }
  })

  it('two different site owners share one account slot under the provider advisory lock', async () => {
    const f = await fixture()
    const second = await f.taskFixture()
    const results = await Promise.allSettled([
      f.credentials.issue(f.ref, f.grant),
      f.credentials.issue(second.ref, f.grant),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await db.llmKey.count({ where: { subscriptionAccountId: f.mainAccount.id } })).toBe(1)
    expect(
      await db.taskAccountBinding.count({ where: { subscriptionAccountId: f.mainAccount.id } }),
    ).toBe(1)
  })

  it('answers at once when a racing task took the account pinned in Vault and another is free', async () => {
    const f = await fixture()
    const spare = await f.account({ usedPct: 50 })
    const second = await f.taskFixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const write = f.vault.kvCreateOnce.getMockImplementation()!
    f.vault.kvCreateOnce.mockImplementationOnce(async (...args) => {
      entered.resolve()
      await release.promise
      return write(...args)
    })
    const late = f.credentials.issue(second.ref, f.grant).catch((caught: unknown) => caught)
    await entered.promise
    // Both selected the account with the most headroom; this one is admitted first.
    await f.credentials.issue(f.ref, f.grant)
    release.resolve()
    const error = (await late) as { code: string; details: { retryAt: string } }
    expect(error).toMatchObject({ code: 'SUBSCRIPTION_BUSY' })
    expect(Date.parse(error.details.retryAt) - Date.now()).toBeLessThan(5_000)
    expect(await db.llmKey.count({ where: { taskId: second.task.id } })).toBe(0)
    // The next attempt of that task, under a new lease epoch, takes the free account.
    await db.siteLease.update({ where: { siteId: second.site.id }, data: { epoch: 2 } })
    await f.credentials.issue({ ...second.ref, epoch: 2 }, f.grant)
    expect(
      (await db.llmKey.findFirstOrThrow({ where: { taskId: second.task.id } }))
        .subscriptionAccountId,
    ).toBe(spare.id)
  })

  it('keeps the pool wait when the pinned account was taken and no other account is free', async () => {
    const f = await fixture()
    const second = await f.taskFixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const write = f.vault.kvCreateOnce.getMockImplementation()!
    f.vault.kvCreateOnce.mockImplementationOnce(async (...args) => {
      entered.resolve()
      await release.promise
      return write(...args)
    })
    const late = f.credentials.issue(second.ref, f.grant).catch((caught: unknown) => caught)
    await entered.promise
    await f.credentials.issue(f.ref, f.grant)
    release.resolve()
    const error = (await late) as { code: string; details: { retryAt: string } }
    expect(error).toMatchObject({ code: 'SUBSCRIPTION_BUSY' })
    expect(Date.parse(error.details.retryAt) - Date.now()).toBeGreaterThan(50_000)
  })

  it('concurrent repeated issuance of one turn creates one binding/key and returns one pair', async () => {
    const f = await fixture()
    const results = await Promise.all(
      Array.from({ length: 4 }, () => f.credentials.issue(f.ref, f.grant)),
    )
    expect(new Set(results.map((result) => result.llmApiKey)).size).toBe(1)
    expect(await db.llmKey.count({ where: { taskId: f.task.id } })).toBe(1)
    expect(await db.taskAccountBinding.count({ where: { taskId: f.task.id } })).toBe(1)
  })

  it.each(['expired', 'epoch', 'holder', 'held', 'operation'])(
    'rejects the %s lease before creating secrets',
    async (reason) => {
      const f = await fixture()
      const changes = {
        expired: { expiresAt: new Date(Date.now() - 1_000) },
        epoch: { epoch: 2 },
        holder: { holderTaskId: null, operation: null, expiresAt: null },
        held: { heldForOperator: true },
        operation: { operation: 'deploy' as const },
      }
      await db.siteLease.update({
        where: { siteId: f.site.id },
        data: changes[reason as keyof typeof changes],
      })
      await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({
        code: 'LEASE_LOST',
      })
      expect(f.vault.entries.size).toBe(0)
      expect(await db.llmKey.count({ where: { taskId: f.task.id } })).toBe(0)
    },
  )

  it('requires approval for client data and a currently effective accounting rate', async () => {
    const f = await fixture({ client: true })
    await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({
      code: 'CROSS_BORDER_NOT_CLEARED',
    })
    const clearance = await db.crossBorderClearance.create({
      data: {
        providerId,
        countries: 'KZ',
        notice22Ref: 'synthetic',
        notice22Date: new Date('2020-01-01'),
        recipientsAssessedOn: new Date('2020-01-01'),
        notice12Ref: 'synthetic',
        notice12ReceivedOn: new Date('2020-01-01'),
        transferAllowedFrom: new Date('2020-01-01'),
        documents: 'synthetic',
        recordedBy: 'synthetic-test',
      },
    })
    f.row.clearanceIds.push(clearance.id)
    await db.llmModelPrice.update({
      where: { id: f.price!.id },
      data: { effectiveFrom: new Date(Date.now() + 86_400_000) },
    })
    await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({
      code: 'LLM_PRICE_MISSING',
    })
    expect(f.vault.entries.size).toBe(0)
    await db.llmModelPrice.update({
      where: { id: f.price!.id },
      data: { effectiveFrom: new Date('2020-01-01') },
    })
    await f.credentials.issue(f.ref, f.grant)
  })

  it('releases SQL locks for a control probe, then selects from a fresh snapshot', async () => {
    const f = await fixture({ windows: false })
    const probeAccounts = vi.fn(async (ids: readonly string[]) => {
      expect(ids).toEqual([f.mainAccount.id])
      // Reacquiring the same pool lock in a different connection proves it was released.
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('lock_timeout', '250ms', true)`
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('pool:kimi-code', 0))::text`
        await tx.subscriptionAccount.update({
          where: { id: f.mainAccount.id },
          data: { limitWindows: [{ name: 'week', usedPct: 10, resetsAt: null }] },
        })
      })
    })
    const credentials = new GatewayTurnCredentials({
      prisma: db,
      secrets: f.vault.port,
      probeAccounts,
    })
    await credentials.issue(f.ref, f.grant)
    expect(probeAccounts).toHaveBeenCalledTimes(1)
  })

  it('keeps the original Vault policy when the process crashed before SQL admission', async () => {
    const f = await fixture()
    const write = f.vault.kvCreateOnce.getMockImplementation()!
    f.vault.kvCreateOnce.mockImplementationOnce(async (...args) => {
      await write(...args)
      throw new Error('Synthetic lost write response')
    })
    await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({
      code: 'LLM_GATEWAY_UNAVAILABLE',
    })
    expect(await db.llmKey.count({ where: { taskId: f.task.id } })).toBe(0)
    const stored = JSON.parse(f.vault.entries.get(turnCredentialPath(f.ref))!.data.grant!) as {
      expiresAt: string
    }
    await f.credentials.issue(f.ref, { ...f.grant, budgetRub: '250.00', ttlMs: 1_200_000 })
    const key = await db.llmKey.findFirstOrThrow({ where: { taskId: f.task.id } })
    expect(key.budgetRub.toFixed(2)).toBe('200.00')
    expect(key.expiresAt.toISOString()).toBe(stored.expiresAt)
  })

  it('checks the stored budget again when admitting a key written before a crash', async () => {
    const f = await fixture()
    const write = f.vault.kvCreateOnce.getMockImplementation()!
    f.vault.kvCreateOnce.mockImplementationOnce(async (...args) => {
      await write(...args)
      throw new Error('Synthetic lost write response')
    })
    await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({
      code: 'LLM_GATEWAY_UNAVAILABLE',
    })
    // A new quarter's rate makes the stored 200 ₽ smaller than the first call reserve.
    await db.llmModelPrice.create({
      data: {
        modelId: f.model.id,
        effectiveFrom: new Date(Date.now() - 1_000),
        inputPer1m: '1000',
        outputPer1m: '5000',
        vatRate: '0.2200',
        sourceUrl: 'https://synthetic.invalid/rates-next-quarter',
      },
    })
    await expect(
      f.credentials.issue(f.ref, { ...f.grant, budgetRub: '250.00' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', details: { budget: 'below_first_call' } })
    expect(await db.llmKey.count({ where: { taskId: f.task.id } })).toBe(0)
  })

  it('recovery matches account/hash/session but permits an existing retired account', async () => {
    const f = await fixture()
    const issued = await f.credentials.issue(f.ref, f.grant)
    await db.subscriptionAccount.update({
      where: { id: f.mainAccount.id },
      data: { enabled: false, retireRequestedAt: new Date(), status: 'retired' },
    })
    expect(await f.credentials.recover(f.ref)).toEqual(issued)
    const entry = f.vault.entries.get(turnCredentialPath(f.ref))!
    entry.data.accountId = randomUUID()
    expect(await f.credentials.recover(f.ref)).toBeNull()
    entry.data.accountId = f.mainAccount.id
    await db.llmKey.updateMany({
      where: { taskId: f.task.id },
      data: { revokeRequestedAt: new Date() },
    })
    expect(await f.credentials.recover(f.ref)).toBeNull()
  })

  it('expires gateway admission before finalization retention and recovers only within validUntil', async () => {
    const f = await fixture()
    const issued = await f.credentials.issue(f.ref, f.grant)
    const key = await db.llmKey.findFirstOrThrow({ where: { taskId: f.task.id } })
    expect(key.validUntil.getTime()).toBeGreaterThan(key.expiresAt.getTime())
    expect(key.validUntil.getTime()).toBeLessThanOrEqual(Date.now() + 25 * 60_000)
    await db.$executeRaw`UPDATE llm_keys SET issued_at = clock_timestamp() - interval '1 hour',
      expires_at = clock_timestamp() - interval '1 second' WHERE id = ${key.id}::uuid`
    expect(await f.credentials.recover(f.ref)).toEqual(issued)
    await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({ code: 'CONFLICT' })
    await db.$executeRaw`UPDATE llm_keys SET valid_until = clock_timestamp() - interval '0.5 second'
      WHERE id = ${key.id}::uuid`
    expect(await f.credentials.recover(f.ref)).toBeNull()
  })

  it('revocation blocks admission first and keeps usage open until the last call closes', async () => {
    const f = await fixture()
    const issued = await f.credentials.issue(f.ref, f.grant)
    const key = await db.llmKey.findFirstOrThrow({ where: { taskId: f.task.id } })
    const call = await db.llmCall.create({
      data: {
        keyId: key.id,
        subscriptionAccountId: f.mainAccount.id,
        modelId: f.model.id,
        route: '/kimi/v1/chat/completions',
        reservedRub: '1',
        requestBytes: 1,
      },
    })
    f.vault.kvDelete.mockImplementationOnce(async () => {
      const closed = await db.llmKey.findUniqueOrThrow({ where: { id: key.id } })
      expect(closed.revokeRequestedAt).not.toBeNull()
      expect(
        await new PostgresGatewayStore(db).lookup(sha256(issued.llmApiKey), '127.0.0.1'),
      ).toBeNull()
      throw new Error('Synthetic Vault outage')
    })
    await expect(f.credentials.revoke(f.ref)).rejects.toMatchObject({
      code: 'LLM_GATEWAY_UNAVAILABLE',
    })
    await f.credentials.revoke(f.ref)
    expect(await db.llmKey.findUniqueOrThrow({ where: { id: key.id } })).toMatchObject({
      usageClosedAt: null,
    })
    expect(await f.credentials.recover(f.ref)).toBeNull()
    await db.llmCall.update({
      where: { id: call.id },
      data: { state: 'lost', finishedAt: new Date() },
    })
    await f.credentials.revoke(f.ref)
    expect(
      (await db.llmKey.findUniqueOrThrow({ where: { id: key.id } })).usageClosedAt,
    ).not.toBeNull()
    expect(
      await db.taskEvent.count({ where: { taskId: f.task.id, type: 'llm.revoke_requested' } }),
    ).toBe(1)
  })

  it.each([false, true])(
    'late write-once completion cannot admit after revoke (Vault already written: %s)',
    async (writeBeforeRevoke) => {
      const f = await fixture()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const write = f.vault.kvCreateOnce.getMockImplementation()!
      f.vault.kvCreateOnce.mockImplementationOnce(async (...args) => {
        if (writeBeforeRevoke) await write(...args)
        entered.resolve()
        await release.promise
        if (!writeBeforeRevoke) return write(...args)
        return 'created'
      })
      const issuing = f.credentials.issue(f.ref, f.grant).then(
        () => null,
        (error: unknown) => error,
      )
      await entered.promise
      await f.credentials.revoke(f.ref)
      // Keep the same live lease: the durable marker, rather than lease expiration, fences this.
      release.resolve()
      expect(await issuing).toMatchObject({ code: 'CONFLICT' })
      expect(await db.llmKey.count({ where: { taskId: f.task.id } })).toBe(0)
      expect(await db.taskAccountBinding.count({ where: { taskId: f.task.id } })).toBe(0)
      // A write that landed after the revocation's destroy must not stay in Vault.
      expect(f.vault.entries.has(turnCredentialPath(f.ref))).toBe(false)
      await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(f.vault.entries.has(turnCredentialPath(f.ref))).toBe(false)
    },
  )

  it('a retry that repairs Vault metadata during a revocation leaves no secret behind', async () => {
    const f = await fixture()
    await f.credentials.issue(f.ref, f.grant)
    const path = turnCredentialPath(f.ref)
    const write = f.vault.kvCreateOnce.getMockImplementation()!
    f.vault.kvCreateOnce.mockImplementationOnce(async (...args) => {
      // The retry read the secret; the turn is revoked completely before its repair lands.
      await f.credentials.revoke(f.ref)
      expect(f.vault.entries.has(path)).toBe(false)
      return write(...args)
    })
    await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.vault.entries.has(path)).toBe(false)
    expect(await f.credentials.recover(f.ref)).toBeNull()
  })

  it('bounds waiting for a held site lease and leaves no durable secret behind', async () => {
    const f = await fixture()
    const held = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const locking = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT site_id FROM site_leases WHERE site_id = ${f.site.id}::uuid FOR UPDATE`
        held.resolve()
        await release.promise
      },
      { timeout: 10_000 },
    )
    await held.promise
    const started = Date.now()
    try {
      await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({
        code: 'LLM_GATEWAY_UNAVAILABLE',
      })
      expect(Date.now() - started).toBeLessThan(4_000)
      expect(f.vault.entries.size).toBe(0)
    } finally {
      release.resolve()
      await locking
    }
  })

  it('does not return an existing key when its lease expires while the SQL fence is waiting', async () => {
    const f = await fixture()
    await f.credentials.issue(f.ref, f.grant)
    await db.$executeRaw`UPDATE site_leases SET expires_at = clock_timestamp() + interval '400 milliseconds'
      WHERE site_id = ${f.site.id}::uuid`
    const held = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const locking = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT site_id FROM site_leases WHERE site_id = ${f.site.id}::uuid FOR UPDATE`
        held.resolve()
        await release.promise
      },
      { timeout: 5_000 },
    )
    await held.promise
    let settled = false
    const retried = f.credentials.issue(f.ref, f.grant).then(
      (value) => {
        settled = true
        return value
      },
      (error: unknown) => {
        settled = true
        return error
      },
    )
    try {
      await sleep(150)
      expect(settled).toBe(false)
      await sleep(450)
    } finally {
      release.resolve()
      await locking
    }
    expect(await retried).toMatchObject({ code: 'LEASE_LOST' })
    expect(await db.llmKey.count({ where: { taskId: f.task.id } })).toBe(1)
  })

  it('hands a task refused for content to an operator even after later refusals of its key', async () => {
    const f = await fixture()
    await f.credentials.issue(f.ref, f.grant)
    const key = await db.llmKey.findFirstOrThrow({ where: { taskId: f.task.id } })
    const store = new PostgresGatewayStore(db)
    await store.refuse(key.id, 'policy_flagged')
    // A parallel request of the same turn is refused later for a short-lived reason.
    await store.refuse(key.id, 'transient')
    await f.credentials.revoke(f.ref)
    // The bound account is gone: without the flag the next turn would move to the replacement.
    await db.subscriptionAccount.update({
      where: { id: f.mainAccount.id },
      data: { enabled: false },
    })
    await f.account()
    await expect(f.credentials.issue({ ...f.ref, turn: 2 }, f.grant)).rejects.toMatchObject({
      code: 'SUBSCRIPTION_OPERATOR_REQUIRED',
      details: { reason: 'policy_flagged' },
    })
    expect(await db.llmKey.count({ where: { taskId: f.task.id } })).toBe(1)
    expect(
      await db.taskAccountBinding.findUniqueOrThrow({ where: { taskId: f.task.id } }),
    ).toMatchObject({ subscriptionAccountId: f.mainAccount.id, rebinds: 0 })
  })

  it('waits one refresher cycle for a bound account whose access token has just expired', async () => {
    const f = await fixture()
    await db.taskAccountBinding.create({
      data: { taskId: f.task.id, driverId: 'kimi', subscriptionAccountId: f.mainAccount.id },
    })
    await db.subscriptionAccount.update({
      where: { id: f.mainAccount.id },
      data: { credentialExpiresAt: new Date(Date.now() - 1_000) },
    })
    await f.account()
    const error = (await f.credentials
      .issue(f.ref, f.grant)
      .catch((caught: unknown) => caught)) as {
      code: string
      details: { retryAt: string }
    }
    expect(error.code).toBe('SUBSCRIPTION_WAIT')
    const wait = Date.parse(error.details.retryAt) - Date.now()
    expect(wait).toBeGreaterThan(4 * 60_000)
    expect(wait).toBeLessThanOrEqual(5 * 60_000)
    expect(
      await db.taskAccountBinding.findUniqueOrThrow({ where: { taskId: f.task.id } }),
    ).toMatchObject({ subscriptionAccountId: f.mainAccount.id, rebinds: 0 })
    expect(f.vault.entries.size).toBe(0)
    // A task that is not bound yet takes the other account at once.
    const other = await f.taskFixture()
    await f.credentials.issue(other.ref, f.grant)
  })

  it('with assignments required, issues only for the open assignment of the turn', async () => {
    const f = await fixture()
    const credentials = new GatewayTurnCredentials({
      prisma: db,
      secrets: f.vault.port,
      requireAssignment: true,
    })
    await expect(credentials.issue(f.ref, f.grant)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.vault.entries.size).toBe(0)
    const opened = await db.turnAssignment.create({
      data: {
        taskId: f.task.id,
        siteId: f.site.id,
        sessionId: f.ref.sessionId,
        turnNo: f.ref.turn,
        executor: 'runner',
        plan: {},
        firstEpoch: f.ref.epoch,
        leaseEpoch: f.ref.epoch,
        deadlineAt: f.grant.deadlineAt,
      },
    })
    await expect(credentials.issue(f.ref, f.grant)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await credentials.issue(f.ref, { ...f.grant, boundSource: '10.0.0.7' })
    await db.turnAssignment.update({
      where: { id: opened.id },
      data: { finishedAt: new Date(), outcome: 'completed' },
    })
    // A finished assignment no longer covers even a retry of the same key.
    await expect(
      credentials.issue(f.ref, { ...f.grant, boundSource: '10.0.0.7' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('a permitted rebind commits once, while an unavailable replacement consumes no rebind', async () => {
    const f = await fixture()
    await db.taskAccountBinding.create({
      data: { taskId: f.task.id, driverId: 'kimi', subscriptionAccountId: f.mainAccount.id },
    })
    await db.subscriptionAccount.update({
      where: { id: f.mainAccount.id },
      data: { enabled: false },
    })
    await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({
      code: 'SUBSCRIPTION_WAIT',
    })
    expect(
      (await db.taskAccountBinding.findUniqueOrThrow({ where: { taskId: f.task.id } })).rebinds,
    ).toBe(0)
    const replacement = await f.account()
    await f.credentials.issue(f.ref, f.grant)
    expect(
      await db.taskAccountBinding.findUniqueOrThrow({ where: { taskId: f.task.id } }),
    ).toMatchObject({ subscriptionAccountId: replacement.id, rebinds: 1 })
  })
})
