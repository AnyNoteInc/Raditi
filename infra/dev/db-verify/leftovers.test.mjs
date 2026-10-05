import assert from 'node:assert/strict'
import { test } from 'node:test'

import { leftovers } from './leftovers.mjs'

// The catalog queries themselves run against the real PostgreSQL of `pnpm verify:db`; this pins
// what is asked and how the answer is put together.
function client({ tables, used = [], schemas = [] }) {
  const queries = []
  return {
    queries,
    async query(sql) {
      queries.push(sql)
      if (sql.includes('FROM pg_class')) return { rows: tables.map((name) => ({ name })) }
      if (sql.includes('FROM pg_namespace')) return { rows: schemas.map((name) => ({ name })) }
      const table = /^SELECT EXISTS \(SELECT FROM public\.(".+")\) AS used$/.exec(sql)?.[1]
      assert.ok(table, `Unexpected query: ${sql}`)
      return { rows: [{ used: used.includes(table) }] }
    },
  }
}

test('a database the suite left as it was given has nothing to report', async () => {
  const db = client({ tables: ['plans', 'tasks'] })
  assert.deepEqual(await leftovers(db), { tables: [], schemas: [] })
})

test('names the tables of public that hold rows and the schemas left behind', async () => {
  const db = client({
    tables: ['agent_drivers', 'odd"name', 'plans', 'tasks'],
    used: ['"plans"', '"odd""name"'],
    schemas: ['seed_test_0123'],
  })
  assert.deepEqual(await leftovers(db), {
    tables: ['odd"name', 'plans'],
    schemas: ['seed_test_0123'],
  })
})

test('leaves the migration history and the system schemas out', async () => {
  const db = client({ tables: [] })
  await leftovers(db)
  const [tables, schemas] = db.queries
  assert.match(tables, /n\.nspname = 'public'/)
  assert.match(tables, /c\.relname <> '_prisma_migrations'/)
  assert.match(schemas, /NOT IN \('public', 'information_schema'\)/)
  assert.match(schemas, /nspname !~ '\^pg_'/)
})
