// The windows of 5 hours and of the week in the database (docs/plan/71-usage-limits.md, §2.2):
// the migration usage_windows gives the three tariffs their windows and their turns at once, the
// checks of the new columns and tables hold, the seed agrees with the migration, and two first
// calls of a workspace at once open one window of each kind. The sums of a window over the calls
// of a workspace are checked where calls are written (`@repo/billing`, `apps/llm`).
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { PrismaClient } from '../src/generated/prisma/client.ts'
import { lockUsageWindows, openUsageWindows, workspaceUsageTerms } from '../src/usage-windows.ts'
import { createMigratedSchema, schemaClient, type MigratedSchema } from './migrated-schema.ts'
import { seedReferenceData } from './seed/apply.ts'

const databaseUrl = process.env.DATABASE_URL
const CHECK_VIOLATION = '23514'
const UNIQUE_VIOLATION = '23505'

describe.skipIf(!databaseUrl)('the usage windows of 13.11.2026', () => {
  let schema: MigratedSchema
  let prisma: PrismaClient

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl!, 'usage_windows')
    await schema.migrate()
    prisma = schemaClient(databaseUrl!, schema)
    await seedReferenceData(prisma)
  })
  afterAll(async () => {
    await prisma?.$disconnect()
    await schema?.drop()
  })

  const workspace = async (): Promise<string> => {
    const id = randomUUID()
    await schema.db.query(`INSERT INTO workspaces (id, name, updated_at) VALUES ($1, 'W', now())`, [
      id,
    ])
    return id
  }
  const failsWith = async (sql: string, values: unknown[], code: string) =>
    expect(schema.db.query(sql, values)).rejects.toMatchObject({ code })

  it('gives the tariffs their windows, and the seed agrees (Л4)', async () => {
    const { rows } = await schema.db.query<{
      slug: string
      credits_per_5h: number | null
      credits_per_week: number | null
    }>(`SELECT slug, credits_per_5h, credits_per_week FROM plans ORDER BY sort_order`)
    expect(rows).toEqual([
      // «Старт» and «Бизнес» since 13.11.2026 (billing_pricing_api_margin, plan 72, ЦА4).
      { slug: 'start', credits_per_5h: null, credits_per_week: 73 },
      { slug: 'business', credits_per_5h: null, credits_per_week: 350 },
      { slug: 'agency', credits_per_5h: null, credits_per_week: 700 },
      { slug: 'pack', credits_per_5h: null, credits_per_week: null },
      { slug: 'payg', credits_per_5h: null, credits_per_week: null },
    ])
    // A second run of the seed finds the terms it carries.
    const report = await seedReferenceData(prisma)
    expect(report.updated.plans).toBe(0)
  })

  it('refuses windows of a plan that are not positive or a week below its 5 hours', async () => {
    const plan = `UPDATE plans SET credits_per_5h = $1, credits_per_week = $2 WHERE slug = 'start'`
    await failsWith(plan, [0, 55], CHECK_VIOLATION)
    await failsWith(plan, [60, 55], CHECK_VIOLATION)
  })

  it('keeps a window as long as its kind', async () => {
    const id = await workspace()
    const insert = `INSERT INTO workspace_usage_windows (id, workspace_id, kind, started_at, ends_at)
      VALUES ($1, $2, $3, $4, $5)`
    const start = new Date('2026-11-13T10:00:00Z')
    await failsWith(
      insert,
      [randomUUID(), id, '5h', start, new Date('2026-11-13T16:00:00Z')],
      CHECK_VIOLATION,
    )
    await failsWith(
      insert,
      [randomUUID(), id, 'month', start, new Date('2026-12-13T10:00:00Z')],
      CHECK_VIOLATION,
    )
    await schema.db.query(insert, [randomUUID(), id, '5h', start, new Date('2026-11-13T15:00:00Z')])
    await failsWith(
      insert,
      [randomUUID(), id, '5h', start, new Date('2026-11-13T15:00:00Z')],
      UNIQUE_VIOLATION,
    )
  })

  it('opens one window of each kind for two first calls at once, and a new one after the end', async () => {
    const id = await workspace()
    const now = new Date('2026-11-13T12:00:00Z')
    const open = () =>
      prisma.$transaction(async (tx) => {
        await lockUsageWindows(tx, id)
        return openUsageWindows(tx, { workspaceId: id, now })
      })
    const opened = await Promise.all([open(), open()])
    expect(opened.map((kinds) => kinds.length).sort()).toEqual([0, 2])
    const later = new Date('2026-11-13T17:00:00Z')
    const again = await prisma.$transaction(async (tx) => {
      await lockUsageWindows(tx, id)
      return openUsageWindows(tx, { workspaceId: id, now: later })
    })
    expect(again).toEqual(['5h'])
    const { rows } = await schema.db.query(
      `SELECT kind, started_at FROM workspace_usage_windows WHERE workspace_id = $1 ORDER BY started_at, kind`,
      [id],
    )
    expect(rows).toEqual([
      { kind: '5h', started_at: now },
      { kind: 'week', started_at: now },
      { kind: '5h', started_at: later },
    ])
  })

  it('reads no windows without a tariff (owner, 14.11.2026)', async () => {
    const id = await workspace()
    await expect(workspaceUsageTerms(prisma, id)).resolves.toEqual({
      tier: 'none',
      limits: { '5h': null, week: null },
    })
  })

  it('keeps plan credits of a call not negative', async () => {
    const { rows } = await schema.db.query<{ def: string }>(
      // Of this schema only: suites that run beside it drop schemas of their own meanwhile.
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE c.conname = 'token_usage_plan_credits_check' AND n.nspname = $1`,
      [schema.name],
    )
    expect(rows[0]?.def).toContain('plan_credits >=')
  })
})
