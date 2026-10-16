// The switch of the product to OpenCode, run over a database of the earlier shells in disposable
// private schemas. DATABASE_URL is optional, as in constraints.test.ts; `public` is never touched.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { PrismaClient } from '../src/generated/prisma/client.ts'
import { createMigratedSchema, schemaClient, type MigratedSchema } from './migrated-schema.ts'
import { seedReferenceData, seededTables } from './seed/apply.ts'

const databaseUrl = process.env.DATABASE_URL
const migrationName = '20261011090000_switch_to_opencode'
const migrations = new URL('./migrations/', import.meta.url)
const migrationSql = () => readFile(new URL(`${migrationName}/migration.sql`, migrations), 'utf8')
/**
 * Sends the file of the switch as one query, the way `prisma migrate deploy` does. The schemas
 * of this file are migrated in full before a row is written, the switch among the migrations:
 * it changes no table and finds no row then, so the tests send it again over what they wrote.
 */
const switchOver = async (schema: MigratedSchema) => schema.db.query(await migrationSql())

describe('switch to OpenCode: the migration file', () => {
  const statements = async () =>
    (await migrationSql())
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('--'))

  it('raises its stops before BEGIN and switches every flag inside one transaction', async () => {
    // Prisma sends the file as one query and records a failure on the same connection: a stop
    // raised inside an explicit transaction block would leave Prisma nothing to write with.
    const lines = await statements()
    const begin = lines.indexOf('BEGIN;')
    const commit = lines.indexOf('COMMIT;')
    expect(lines[0]).toBe('DO $$')
    expect(lines[begin - 1]).toBe('END $$;')
    expect(commit).toBe(lines.length - 1)
    expect(lines.filter((line) => /^(BEGIN|COMMIT);$/.test(line))).toHaveLength(2)
    const raised = lines.flatMap((line, index) => (/\bRAISE\b/.test(line) ? [index] : []))
    const updated = lines.flatMap((line, index) => (/^UPDATE\b/.test(line) ? [index] : []))
    expect(raised).toHaveLength(2)
    expect(raised.every((index) => index < begin)).toBe(true)
    expect(updated.every((index) => index > begin && index < commit)).toBe(true)
  })

  it('only switches flags: it deletes no row and changes no table', async () => {
    const sql = (await statements()).join('\n')
    expect(sql).not.toMatch(/\b(DELETE|TRUNCATE|INSERT|DROP|ALTER|CREATE)\b/i)
    // Every UPDATE of the file writes one column, `enabled`.
    expect([...sql.matchAll(/^UPDATE "(\w+)" SET "(\w+)" =/gm)].map(([, t, c]) => [t, c])).toEqual([
      ['agent_drivers', 'enabled'],
      ['agent_drivers', 'enabled'],
      ['llm_providers', 'enabled'],
      ['llm_models', 'enabled'],
      ['subscription_accounts', 'enabled'],
    ])
    expect(sql.match(/^UPDATE\b/gm)).toHaveLength(5)
  })
})

/** Every row of every table of the schema as PostgreSQL prints it, and every constraint. */
async function contents(db: Client, schema: string, withoutEnabled: readonly string[] = []) {
  const tables = (
    await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
      [schema],
    )
  ).rows.map((row) => row.table_name)
  const rows: Record<string, string[]> = {}
  for (const table of tables) {
    const row = withoutEnabled.includes(table) ? `to_jsonb(t) - 'enabled'` : 'to_jsonb(t)'
    rows[table] = (
      await db.query<{ row: string }>(`SELECT (${row})::text AS row FROM "${table}" t ORDER BY 1`)
    ).rows.map((line) => line.row)
  }
  const constraints = (
    await db.query(
      `SELECT c.conname, c.contype, c.conrelid::regclass::text AS source,
              c.confrelid::regclass::text AS target, pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = $1 ORDER BY c.conrelid::regclass::text, c.conname`,
      [schema],
    )
  ).rows
  return { rows, constraints }
}

/** The four flags the migration may write, by a natural key of each row. */
async function flags(db: Client) {
  const { rows } = await db.query<{ row: string; enabled: boolean }>(
    `SELECT 'agent_drivers/' || id AS row, enabled FROM agent_drivers
     UNION ALL SELECT 'llm_providers/' || slug, enabled FROM llm_providers
     UNION ALL SELECT 'llm_models/' || p.slug || '/' || m.slug, m.enabled
       FROM llm_models m JOIN llm_providers p ON p.id = m.provider_id
     UNION ALL SELECT 'subscription_accounts/' || label, enabled FROM subscription_accounts
     ORDER BY 1`,
  )
  return Object.fromEntries(rows.map(({ row, enabled }) => [row, enabled]))
}

const finishedStatuses = ['done', 'failed', 'rolled_back', 'cancelled'] as const
const unfinishedStatuses = [
  'queued',
  'preparing',
  'running',
  'awaiting_user',
  'awaiting_approval',
  'deploying',
  'verifying',
] as const
type TaskStatus = (typeof finishedStatuses)[number] | (typeof unfinishedStatuses)[number]

interface AccountInput {
  provider: string
  driver: string
  label: string
  credentialVersion: number
  status?: 'active' | 'banned' | 'retired'
  enabled?: boolean
  retireRequested?: boolean
}

interface WorkInput {
  driver: string
  status: TaskStatus
  /** What of the task names the driver; every form by default. */
  forms?: readonly ('turn' | 'assignment' | 'binding' | 'key')[]
  /** The turn assignment is still open: recovery reads its plan. */
  openAssignment?: boolean
  /** The account the binding, the key, its call and its usage belong to. */
  account?: { id: string; provider: string }
}

/**
 * The rows of a database as it stood before the switch: the reference rows of the earlier shells
 * present and switched on the way the earlier seeds and an operator left them, the Z.ai
 * catalogue present and switched off. The schema itself is today's, every migration applied:
 * the rows are written through the Prisma client, which names every column of schema.prisma, so
 * a schema stopped at an earlier migration would refuse them once a later one adds a column.
 */
async function earlierDatabase(prefix: string) {
  const schema = await createMigratedSchema(databaseUrl ?? '', prefix)
  await schema.migrate()
  const db = schemaClient(databaseUrl ?? '', schema)

  // Today's catalogue first, then the rows of the earlier shells by their literal ids: this file
  // keeps them when the seeds no longer do.
  await seedReferenceData(db)
  // qwen was seeded switched off; here an operator has switched it on, so that the migration is
  // seen to write the flag of each of the three shells.
  const drivers = { codex: true, kimi: true, qwen: true, opencode: false, 'other-shell': true }
  for (const [id, enabled] of Object.entries(drivers))
    await db.agentDriver.upsert({
      where: { id },
      update: { enabled },
      create: { id, image: `raditi/agent-${id}`, capabilities: {}, enabled },
    })
  const models: Record<string, { id: string; priceId: string }> = {}
  for (const slug of ['openai-chatgpt', 'kimi-code', 'zai-coding', 'other-subscription']) {
    const earlier = slug !== 'zai-coding'
    const provider = await db.llmProvider.upsert({
      where: { slug },
      update: { enabled: earlier },
      create: { slug, name: slug, kind: 'subscription', enabled: earlier },
    })
    // One profile in use with a rate history and one an operator had switched off.
    for (const enabled of [true, false]) {
      const model = await db.llmModel.create({
        data: {
          providerId: provider.id,
          slug: `history-${enabled ? 'on' : 'off'}`,
          name: 'History',
          providerModelId: 'history',
          modelClass: 'standard',
          enabled: enabled && earlier,
        },
      })
      if (!enabled || !earlier) continue
      await db.llmModelPrice.create({
        data: {
          modelId: model.id,
          effectiveFrom: new Date('2026-07-01T00:00:00Z'),
          inputPer1m: '123.456789',
          cacheReadPer1m: '4.56789',
          outputPer1m: '234.56789',
          vatRate: '0.22',
          sourceUrl: 'https://rates.example.test/earlier',
        },
      })
      const price = await db.llmModelPrice.create({
        data: {
          modelId: model.id,
          effectiveFrom: new Date('2026-10-01T00:00:00Z'),
          inputPer1m: '456.789012',
          cacheWritePer1m: '12.345678',
          outputPer1m: '567.890123',
          vatRate: '0.22',
          sourceUrl: 'https://rates.example.test/later',
        },
      })
      models[slug] = { id: model.id, priceId: price.id }
    }
  }
  // A model of Z.ai for the keys of the new shell: switched off and without a rate, as seeded.
  const glm = await db.llmModel.findFirstOrThrow({
    where: { provider: { slug: 'zai-coding' }, slug: 'glm-5.3-standard' },
  })

  async function account(input: AccountInput) {
    const provider = await db.llmProvider.findUniqueOrThrow({ where: { slug: input.provider } })
    const id = randomUUID()
    const credential = await db.credentialRef.create({
      data: {
        kind: 'subscription',
        vaultPath: `subs/${input.provider}/${id}`,
        keyVersion: input.credentialVersion,
      },
    })
    const retired = input.status === 'retired'
    await db.subscriptionAccount.create({
      data: {
        id,
        providerId: provider.id,
        driverId: input.driver,
        label: input.label,
        credentialRefId: credential.id,
        plan: 'synthetic',
        status: input.status ?? 'active',
        enabled: input.enabled ?? !retired,
        credentialVersion: input.credentialVersion,
        maxConcurrentTurns: 1,
        maxConcurrentRequests: 2,
        retireRequestedAt: retired || input.retireRequested ? new Date() : null,
        credentialsRevokedAt: retired ? new Date() : null,
        limitWindows: [{ name: '5h', usedPct: 12.5, resetsAt: '2026-10-11T12:00:00.000Z' }],
      },
    })
    return { id, provider: input.provider, credentialId: credential.id }
  }

  /** A task with what a turn leaves behind; returns what a test removes to undo it. */
  async function work(input: WorkInput) {
    const forms = input.forms ?? ['turn', 'assignment', 'binding', 'key']
    const workspace = await db.workspace.create({ data: { name: 'Synthetic history' } })
    const site = await db.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Synthetic',
        url: `https://${randomUUID()}.example.test`,
        stack: 'wordpress',
      },
    })
    const finished = (finishedStatuses as readonly string[]).includes(input.status)
    const task = await db.task.create({
      data: {
        workspaceId: workspace.id,
        siteId: site.id,
        status: input.status,
        turnNo: 1,
        costRub: '0.012814',
        finishedAt: finished ? new Date() : null,
      },
    })
    const sessionId = randomUUID()
    let turnId: string | undefined
    if (forms.includes('turn'))
      turnId = (
        await db.taskTurn.create({
          data: {
            taskId: task.id,
            turnNo: 1,
            status: finished ? 'completed' : 'running',
            driverId: input.driver,
            driverVersion: '1.0.0',
            image: `registry.invalid/raditi/${input.driver}@sha256:${'a'.repeat(64)}`,
          },
        })
      ).id
    if (forms.includes('assignment'))
      await db.turnAssignment.create({
        data: {
          taskId: task.id,
          siteId: site.id,
          sessionId,
          turnNo: 1,
          executor: 'local',
          // Only the field the plan schema reads the driver from; the rest is not this test's.
          plan: { driverId: input.driver, driverVersion: '1.0.0' },
          firstEpoch: 1,
          leaseEpoch: 1,
          deadlineAt: new Date('2026-10-01T00:20:00Z'),
          ...(input.openAssignment
            ? {}
            : { outcome: 'completed', finishedAt: new Date('2026-10-01T00:10:00Z') }),
        },
      })
    const owner = input.account
    if (owner && forms.includes('binding'))
      await db.taskAccountBinding.create({
        data: { taskId: task.id, driverId: input.driver, subscriptionAccountId: owner.id },
      })
    if (owner && forms.includes('key')) {
      const model = models[owner.provider]
      const key = await db.llmKey.create({
        data: {
          keyHash: randomUUID().replaceAll('-', '').repeat(2),
          taskId: task.id,
          taskAttempt: 1,
          sessionId,
          turnNo: 1,
          firstEpoch: 1,
          driverId: input.driver,
          modelId: model?.id ?? glm.id,
          subscriptionAccountId: owner.id,
          budgetRub: '135',
          issuedAt: new Date('2026-10-01T00:00:00Z'),
          expiresAt: new Date('2026-10-01T00:20:00Z'),
          validUntil: new Date('2026-10-01T00:30:00Z'),
          revokeRequestedAt: new Date('2026-10-01T00:10:00Z'),
          revokedAt: new Date('2026-10-01T00:10:01Z'),
        },
      })
      // Usage needs a rate; the profiles of Z.ai have none before the operator approves one.
      if (model) {
        const call = await db.llmCall.create({
          data: {
            keyId: key.id,
            subscriptionAccountId: owner.id,
            modelId: model.id,
            route: '/history',
            state: 'completed',
            reservedRub: '21.5',
            requestBytes: 2048,
            responseBytes: 4096n,
            upstreamStatus: 200,
            startedAt: new Date('2026-10-01T00:01:00Z'),
            finishedAt: new Date('2026-10-01T00:01:30Z'),
          },
        })
        await db.tokenUsage.create({
          data: {
            gatewayCallId: call.id,
            keyId: key.id,
            subscriptionAccountId: owner.id,
            taskId: task.id,
            taskAttempt: 1,
            turnId: turnId ?? null,
            driverId: input.driver,
            modelId: model.id,
            priceId: model.priceId,
            inputUncachedTokens: 1200,
            cacheReadTokens: 800,
            outputTokens: 340,
            reasoningTokens: 120,
            costRub: '0.012814',
            occurredAt: new Date('2026-10-01T00:01:30Z'),
          },
        })
      }
    }
    return { taskId: task.id, siteId: site.id, workspaceId: workspace.id }
  }

  async function removeWork(ids: Awaited<ReturnType<typeof work>>) {
    await db.tokenUsage.deleteMany({ where: { taskId: ids.taskId } })
    await db.llmCall.deleteMany({ where: { key: { taskId: ids.taskId } } })
    await db.llmKey.deleteMany({ where: { taskId: ids.taskId } })
    await db.taskAccountBinding.deleteMany({ where: { taskId: ids.taskId } })
    await db.task.delete({ where: { id: ids.taskId } })
    await db.site.delete({ where: { id: ids.siteId } })
    await db.workspace.delete({ where: { id: ids.workspaceId } })
  }

  async function removeAccount(ids: Awaited<ReturnType<typeof account>>) {
    await db.subscriptionAccount.delete({ where: { id: ids.id } })
    await db.credentialRef.delete({ where: { id: ids.credentialId } })
  }

  /** What the removal can leave behind: nothing here stops the migration. */
  async function history() {
    const retired = await account({
      provider: 'openai-chatgpt',
      driver: 'codex',
      label: 'retired after use',
      credentialVersion: 3,
      status: 'retired',
    })
    // An import that never stored a credential: nothing to revoke, the row is only switched off.
    const neverImported = await account({
      provider: 'kimi-code',
      driver: 'kimi',
      label: 'never imported',
      credentialVersion: 0,
    })
    // The same of the other provider: each of the two has an account that is still switched on.
    await account({
      provider: 'openai-chatgpt',
      driver: 'codex',
      label: 'never signed in',
      credentialVersion: 0,
    })
    const plan = await account({
      provider: 'zai-coding',
      driver: 'opencode',
      label: 'plan key',
      credentialVersion: 1,
    })
    const other = await account({
      provider: 'other-subscription',
      driver: 'other-shell',
      label: 'other shell',
      credentialVersion: 1,
    })
    await work({ driver: 'codex', status: 'done', account: retired })
    await work({ driver: 'codex', status: 'cancelled', account: retired })
    await work({ driver: 'kimi', status: 'failed', account: neverImported })
    await work({ driver: 'qwen', status: 'rolled_back' })
    // Unfinished work of the shell that stays, an open assignment included.
    await work({ driver: 'opencode', status: 'running', account: plan, openAssignment: true })
    await work({ driver: 'other-shell', status: 'awaiting_user', account: other })
  }

  return {
    schema,
    db,
    account,
    work,
    removeWork,
    removeAccount,
    history,
    async close() {
      await db.$disconnect()
      await schema.drop()
    },
  }
}

type EarlierDatabase = Awaited<ReturnType<typeof earlierDatabase>>

describe.skipIf(!databaseUrl)('switch to OpenCode: the two stops', () => {
  let earlier: EarlierDatabase
  beforeAll(async () => {
    earlier = await earlierDatabase('switch_stops')
    await earlier.history()
  }, 60_000)
  afterAll(async () => {
    await earlier?.close()
  })

  /** The migration is refused with the message of the stop and leaves every row as it was. */
  async function stopped(message: RegExp[]) {
    const { schema } = earlier
    const before = await contents(schema.db, schema.name)
    const refusal = await switchOver(schema).then(
      () => null,
      (error: unknown) => error as { code?: string; message?: string },
    )
    // Prisma records the failure on the connection it migrated with. A stop that left that
    // connection inside a failed transaction would make Prisma print the error of its own
    // write instead of the message: the next statement must simply work.
    expect((await schema.db.query('SELECT 1 AS usable')).rows).toEqual([{ usable: 1 }])
    expect(refusal).toMatchObject({ code: 'P0001' })
    for (const part of message) expect(refusal?.message).toMatch(part)
    // What the operator does next, in the message itself: Prisma prints it and nothing else.
    expect(refusal?.message).toMatch(/docs\/plan\/48-removal\.md/)
    expect(refusal?.message).toMatch(
      new RegExp(`prisma migrate resolve --rolled-back ${migrationName}`),
    )
    expect(await contents(schema.db, schema.name)).toEqual(before)
    expect(before.rows.token_usage?.length).toBeGreaterThan(0)
  }

  it.each([
    { provider: 'openai-chatgpt', driver: 'codex', credentialVersion: 1 },
    { provider: 'kimi-code', driver: 'kimi', credentialVersion: 7 },
    // Out of the pool, yet its credential is still valid at the provider.
    { provider: 'kimi-code', driver: 'kimi', credentialVersion: 1, status: 'banned' as const },
    { provider: 'openai-chatgpt', driver: 'codex', credentialVersion: 2, enabled: false },
    // Retirement asked for and not finished.
    { provider: 'openai-chatgpt', driver: 'codex', credentialVersion: 1, retireRequested: true },
  ])('stops on an account that still holds a credential: %j', async (input) => {
    const live = await earlier.account({ ...input, label: 'live account' })
    try {
      await stopped([
        /1 subscription account\(s\) of openai-chatgpt or kimi-code/,
        new RegExp(live.id),
        /Retire/,
      ])
    } finally {
      await earlier.removeAccount(live)
    }
  })

  it('names every such account', async () => {
    const live = [
      await earlier.account({
        provider: 'openai-chatgpt',
        driver: 'codex',
        label: 'first live',
        credentialVersion: 1,
      }),
      await earlier.account({
        provider: 'kimi-code',
        driver: 'kimi',
        label: 'second live',
        credentialVersion: 1,
      }),
    ]
    try {
      await stopped([
        /2 subscription account\(s\)/,
        new RegExp(live[0]!.id),
        new RegExp(live[1]!.id),
      ])
    } finally {
      for (const row of live) await earlier.removeAccount(row)
    }
  })

  it.each([
    ...unfinishedStatuses.map((status) => ({ status, driver: 'codex' })),
    { status: 'running' as const, driver: 'kimi' },
    { status: 'awaiting_user' as const, driver: 'qwen' },
  ])('stops on a task in $status with a turn of $driver', async ({ status, driver }) => {
    const open = await earlier.work({ driver, status, forms: ['turn'] })
    try {
      await stopped([/1 unfinished task\(s\)/, new RegExp(open.taskId), /codex, kimi or qwen/])
    } finally {
      await earlier.removeWork(open)
    }
  })

  it.each(['assignment', 'binding', 'key'] as const)(
    'stops on an unfinished task whose %s names a removed shell',
    async (form) => {
      const retired = await earlier.account({
        provider: 'openai-chatgpt',
        driver: 'codex',
        label: 'retired owner',
        credentialVersion: 1,
        status: 'retired',
      })
      const open = await earlier.work({
        driver: 'codex',
        status: 'queued',
        forms: [form],
        account: retired,
      })
      try {
        await stopped([/1 unfinished task\(s\)/, new RegExp(open.taskId)])
      } finally {
        await earlier.removeWork(open)
        await earlier.removeAccount(retired)
      }
    },
  )

  it('stops on an open turn assignment of a removed shell, whatever the status of its task', async () => {
    // Recovery reads the plan of every open assignment, and the removal makes this one unreadable.
    const open = await earlier.work({
      driver: 'kimi',
      status: 'failed',
      forms: ['assignment'],
      openAssignment: true,
    })
    try {
      await stopped([/1 unfinished task\(s\)/, new RegExp(open.taskId)])
    } finally {
      await earlier.removeWork(open)
    }
  })

  it('reports the accounts first when both stops apply', async () => {
    const live = await earlier.account({
      provider: 'kimi-code',
      driver: 'kimi',
      label: 'live account',
      credentialVersion: 1,
    })
    const open = await earlier.work({ driver: 'kimi', status: 'running', forms: ['turn'] })
    try {
      await stopped([/1 subscription account\(s\)/])
    } finally {
      await earlier.removeWork(open)
      await earlier.removeAccount(live)
    }
  })

  it('goes through once nothing stops it', async () => {
    // The same schema, after every case above removed what it added.
    await switchOver(earlier.schema)
    expect((await flags(earlier.schema.db))['agent_drivers/opencode']).toBe(true)
  })
})

describe.skipIf(!databaseUrl)('switch to OpenCode: a database of the earlier shells', () => {
  let earlier: EarlierDatabase
  let before: Awaited<ReturnType<typeof contents>>
  let beforeFlags: Awaited<ReturnType<typeof flags>>
  const flagged = ['agent_drivers', 'llm_providers', 'llm_models', 'subscription_accounts']

  beforeAll(async () => {
    earlier = await earlierDatabase('switch_history')
    await earlier.history()
    const { schema } = earlier
    before = await contents(schema.db, schema.name, flagged)
    beforeFlags = await flags(schema.db)
    await switchOver(schema)
  }, 60_000)
  afterAll(async () => {
    await earlier?.close()
  })

  it('starts from the earlier shells switched on and the new one switched off', () => {
    expect(beforeFlags).toMatchObject({
      'agent_drivers/codex': true,
      'agent_drivers/kimi': true,
      'agent_drivers/qwen': true,
      'agent_drivers/opencode': false,
      'llm_providers/openai-chatgpt': true,
      'llm_providers/kimi-code': true,
      'llm_models/openai-chatgpt/history-on': true,
      'llm_models/kimi-code/history-on': true,
      'subscription_accounts/never imported': true,
      'subscription_accounts/never signed in': true,
    })
  })

  it('switches off the earlier drivers, providers, models and accounts and switches OpenCode on', async () => {
    const after = await flags(earlier.schema.db)
    const expected = Object.fromEntries(
      Object.entries(beforeFlags).map(([row, enabled]) => [
        row,
        row === 'agent_drivers/opencode'
          ? true
          : /^agent_drivers\/(codex|kimi|qwen)$/.test(row) ||
              /^llm_(providers|models)\/(openai-chatgpt|kimi-code)(\/|$)/.test(row) ||
              [
                'subscription_accounts/retired after use',
                'subscription_accounts/never imported',
                'subscription_accounts/never signed in',
              ].includes(row)
            ? false
            : enabled,
      ]),
    )
    expect(after).toEqual(expected)
    // Spelled out, so that a rule above that matches nothing cannot pass unnoticed.
    expect(after).toMatchObject({
      'agent_drivers/codex': false,
      'agent_drivers/kimi': false,
      'agent_drivers/qwen': false,
      'agent_drivers/opencode': true,
      'agent_drivers/other-shell': true,
      'llm_providers/openai-chatgpt': false,
      'llm_providers/kimi-code': false,
      'llm_providers/other-subscription': true,
      'llm_models/openai-chatgpt/history-on': false,
      'llm_models/kimi-code/history-on': false,
      'llm_models/other-subscription/history-on': true,
      'subscription_accounts/never imported': false,
      'subscription_accounts/never signed in': false,
      'subscription_accounts/plan key': true,
      'subscription_accounts/other shell': true,
    })
  })

  it('leaves the provider of the new shell, its profiles and its rates to the operator', async () => {
    const after = await flags(earlier.schema.db)
    expect(
      Object.entries(after).filter(([row]) =>
        /^llm_(providers|models)\/zai-coding(\/|$)/.test(row),
      ),
    ).toEqual([
      ['llm_models/zai-coding/glm-5.3-heavy', false],
      ['llm_models/zai-coding/glm-5.3-light', false],
      ['llm_models/zai-coding/glm-5.3-standard', false],
      ['llm_models/zai-coding/history-off', false],
      ['llm_models/zai-coding/history-on', false],
      ['llm_providers/zai-coding', false],
    ])
    expect(
      await earlier.db.llmModelPrice.count({
        where: { model: { provider: { slug: 'zai-coding' } } },
      }),
    ).toBe(0)
  })

  it('keeps every row, rate, call, key and constraint: nothing but the four flags differs', async () => {
    const { schema } = earlier
    const after = await contents(schema.db, schema.name, flagged)
    expect(after).toEqual(before)
    // The history the comparison stands on is there, in each table the removal must not lose.
    const counts = Object.fromEntries(
      Object.entries(after.rows).map(([table, rows]) => [table, rows.length]),
    )
    expect(counts).toMatchObject({
      llm_model_prices: 6,
      llm_keys: 5,
      llm_calls: 4,
      token_usage: 4,
      task_turns: 6,
      turn_assignments: 6,
      task_account_bindings: 5,
      subscription_accounts: 5,
    })
    expect(counts.llm_providers).toBeGreaterThanOrEqual(4)
    expect(counts.llm_models).toBeGreaterThanOrEqual(8)
    expect(after.constraints.filter((row) => row.contype === 'f').length).toBeGreaterThan(50)
  })

  it('is not undone by the seeds: a run and a rerun create and update nothing', async () => {
    const { schema, db } = earlier
    const switched = await contents(schema.db, schema.name)
    const zero = Object.fromEntries(seededTables.map((table) => [table, 0]))
    for (const run of ['run', 'rerun']) {
      expect(await seedReferenceData(db), run).toEqual({ created: zero, updated: zero })
      expect(await contents(schema.db, schema.name), run).toEqual(switched)
    }
  })
})

describe.skipIf(!databaseUrl)(
  'switch to OpenCode: a database seeded only by the earlier seeds',
  () => {
    let schema: MigratedSchema
    let db: PrismaClient
    beforeAll(async () => {
      schema = await createMigratedSchema(databaseUrl ?? '', 'switch_upgrade')
      await schema.migrate()
      db = schemaClient(databaseUrl ?? '', schema)
      // What the seeds before the new shell left: one earlier shell in use, its provider with a
      // profile, nothing of OpenCode or Z.ai. Today's seeds know none of these rows.
      await db.agentDriver.create({
        data: { id: 'codex', image: 'raditi/agent-codex', capabilities: {}, enabled: true },
      })
      await db.llmProvider.create({
        data: {
          slug: 'openai-chatgpt',
          name: 'ChatGPT',
          kind: 'subscription',
          enabled: true,
          models: {
            create: {
              slug: 'gpt-6-sol-standard',
              name: 'GPT-6 Sol · standard',
              providerModelId: null,
              modelClass: 'standard',
              enabled: true,
            },
          },
        },
      })
      await switchOver(schema)
    }, 60_000)
    afterAll(async () => {
      await db?.$disconnect()
      await schema?.drop()
    })

    it('ends with the history switched off beside the catalogue of a new database', async () => {
      // Nothing of the new shell to switch on yet: the migration only switched the history off.
      expect(await flags(schema.db)).toEqual({
        'agent_drivers/codex': false,
        'llm_providers/openai-chatgpt': false,
        'llm_models/openai-chatgpt/gpt-6-sol-standard': false,
      })
      const zero = Object.fromEntries(seededTables.map((table) => [table, 0]))
      const report = await seedReferenceData(db)
      expect(report.updated).toEqual(zero)
      expect(report.created).toMatchObject({ agent_drivers: 1, llm_providers: 1, llm_models: 3 })
      // The rows of a new database and the three history rows, which no seed run recreates,
      // completes or switches back on.
      const seeded = await flags(schema.db)
      expect(seeded).toEqual({
        'agent_drivers/codex': false,
        'agent_drivers/opencode': true,
        'llm_providers/openai-chatgpt': false,
        'llm_providers/zai-coding': false,
        'llm_models/openai-chatgpt/gpt-6-sol-standard': false,
        'llm_models/zai-coding/glm-5.3-heavy': false,
        'llm_models/zai-coding/glm-5.3-light': false,
        'llm_models/zai-coding/glm-5.3-standard': false,
      })
      const stored = await contents(schema.db, schema.name)
      expect(await seedReferenceData(db)).toEqual({ created: zero, updated: zero })
      expect(await contents(schema.db, schema.name)).toEqual(stored)
    })
  },
)

describe.skipIf(!databaseUrl)('switch to OpenCode: a new database', () => {
  let schema: MigratedSchema
  let db: PrismaClient
  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'switch_new')
    await schema.migrate()
    db = schemaClient(databaseUrl ?? '', schema)
  }, 60_000)
  afterAll(async () => {
    await db?.$disconnect()
    await schema?.drop()
  })

  it('gets one shell switched on by the seeds and no provider, profile or rate', async () => {
    // The migration found no row to switch; the same flags come from the seeds.
    expect(await flags(schema.db)).toEqual({})
    await seedReferenceData(db)
    const seeded = await flags(schema.db)
    // Every row, not only the ones switched on: a new database holds no row of an earlier
    // shell or of its provider, and the catalogue of the new one waits for the operator.
    expect(seeded).toEqual({
      'agent_drivers/opencode': true,
      'llm_providers/zai-coding': false,
      'llm_models/zai-coding/glm-5.3-heavy': false,
      'llm_models/zai-coding/glm-5.3-light': false,
      'llm_models/zai-coding/glm-5.3-standard': false,
    })
    expect(await db.llmModelPrice.count()).toBe(0)
    expect(await db.subscriptionAccount.count()).toBe(0)

    const zero = Object.fromEntries(seededTables.map((table) => [table, 0]))
    expect(await seedReferenceData(db)).toEqual({ created: zero, updated: zero })
    expect(await flags(schema.db)).toEqual(seeded)
  })
})
