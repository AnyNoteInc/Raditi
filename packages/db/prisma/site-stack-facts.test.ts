// Three more stacks and the facts of a site in the database (docs/plan/62-site-stacks.md, §2.6,
// Т13): 20261101100000_site_stacks and 20261101100100_site_stack_facts over a site written before
// them. Runs the real migrations in a disposable schema; `public` is never touched.
import { randomUUID } from 'node:crypto'

import { siteStacks } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMigratedSchema, type MigratedSchema } from './migrated-schema.ts'

const databaseUrl = process.env.DATABASE_URL
const before = '20261026150000_task_deleted_at'
const at = new Date('2026-11-01T12:00:00Z')

describe.skipIf(!databaseUrl)('the stacks and the facts of a site', () => {
  let schema: MigratedSchema
  const workspace = randomUUID()
  const earlier = randomUUID()

  async function insertSite(id: string, stack: string) {
    await schema.db.query(
      `INSERT INTO sites (id, workspace_id, name, url, stack, updated_at)
       VALUES ($1, $2, 'Synthetic site', $3, $4, $5)`,
      [id, workspace, `https://${id}.invalid`, stack, at],
    )
  }

  async function refusal(statement: Promise<unknown>) {
    const error = await statement.then(
      () => null,
      (caught: unknown) => caught as { code?: string; constraint?: string },
    )
    return { code: error?.code, constraint: error?.constraint }
  }

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'site_stack_facts')
    await schema.migrate(before)
    await schema.db.query(
      `INSERT INTO workspaces (id, name, updated_at) VALUES ($1, 'Synthetic', $2)`,
      [workspace, at],
    )
    await insertSite(earlier, 'wordpress')
    await schema.migrate()
  })
  afterAll(async () => {
    await schema?.drop()
  })

  it('knows the stacks in the order of the domain', async () => {
    const { rows } = await schema.db.query(
      `SELECT unnest(enum_range(NULL::"SiteStack"))::text AS stack`,
    )
    expect(rows.map((row: { stack: string }) => row.stack)).toEqual([...siteStacks])
  })

  it('gives a site written before the empty record and changes nothing else', async () => {
    const { rows } = await schema.db.query(
      'SELECT stack, stack_facts, updated_at FROM sites WHERE id = $1',
      [earlier],
    )
    expect(rows).toEqual([{ stack: 'wordpress', stack_facts: {}, updated_at: at }])
  })

  it('takes a site on Joomla', async () => {
    const id = randomUUID()
    await insertSite(id, 'joomla')
    const { rows } = await schema.db.query('SELECT stack, stack_facts FROM sites WHERE id = $1', [
      id,
    ])
    expect(rows).toEqual([{ stack: 'joomla', stack_facts: {} }])
  })

  it('refuses an array and a record larger than 4096 bytes', async () => {
    const refused = { code: '23514', constraint: 'sites_stack_facts_check' }
    expect(
      await refusal(
        schema.db.query(`UPDATE sites SET stack_facts = '[]'::jsonb WHERE id = $1`, [earlier]),
      ),
    ).toEqual(refused)
    const large = JSON.stringify({ v: 1, extras: { prefix: 'x'.repeat(4096) } })
    expect(
      await refusal(
        schema.db.query(`UPDATE sites SET stack_facts = $2::jsonb WHERE id = $1`, [earlier, large]),
      ),
    ).toEqual(refused)
    // The limit is in bytes: 2100 Cyrillic letters are fewer than 4096 characters, about 4200 bytes.
    const cyrillic = JSON.stringify({ v: 1, extras: { prefix: 'я'.repeat(2100) } })
    expect(
      await refusal(
        schema.db.query(`UPDATE sites SET stack_facts = $2::jsonb WHERE id = $1`, [
          earlier,
          cyrillic,
        ]),
      ),
    ).toEqual(refused)
    // A record just within the limit passes.
    const within = JSON.stringify({ v: 1, extras: { prefix: 'x'.repeat(4000) } })
    await schema.db.query(`UPDATE sites SET stack_facts = $2::jsonb WHERE id = $1`, [
      earlier,
      within,
    ])
  })

  it('refuses NULL, so a write in parts never loses the record', async () => {
    expect(
      await refusal(
        schema.db.query(`UPDATE sites SET stack_facts = NULL WHERE id = $1`, [earlier]),
      ),
    ).toMatchObject({ code: '23502' })
  })
})
