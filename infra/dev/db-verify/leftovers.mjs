// What a test suite left in the database it was given: tables of `public` that hold rows and
// schemas besides `public`. Tests seed and migrate in schemas of their own and remove the rows
// they write, so a migrated database that was empty before a suite is empty after it.

const identifier = (value) => `"${value.replaceAll('"', '""')}"`

/** `client` is a connected pg client. Prisma's migration history is not a leftover. */
export async function leftovers(client) {
  const { rows: tables } = await client.query(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> '_prisma_migrations'
     ORDER BY c.relname`,
  )
  const used = []
  for (const { name } of tables) {
    const { rows } = await client.query(
      `SELECT EXISTS (SELECT FROM public.${identifier(name)}) AS used`,
    )
    if (rows[0].used) used.push(name)
  }
  const { rows: schemas } = await client.query(
    `SELECT nspname AS name FROM pg_namespace
     WHERE nspname NOT IN ('public', 'information_schema') AND nspname !~ '^pg_'
     ORDER BY nspname`,
  )
  return { tables: used, schemas: schemas.map((schema) => schema.name) }
}
