// Test helper: the real migrations in a schema created for one test file and dropped after it.
// A DATABASE_URL that points at a developer's database never has its own tables written.
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'

import { PrismaPg } from '@prisma/adapter-pg'
import { Client } from 'pg'

import { PrismaClient } from '../src/generated/prisma/client.ts'

const migrations = new URL('./migrations/', import.meta.url)

export interface MigratedSchema {
  /** Random and lowercase: safe to interpolate into SQL. */
  readonly name: string
  /** A connection whose search_path is this schema alone; `public` is never visible. */
  readonly db: Client
  /** Applies the next migrations in order, up to and including `through`; all of them without it. */
  migrate(through?: string): Promise<void>
  /** Drops the schema with everything in it and closes the connection. */
  drop(): Promise<void>
}

export async function createMigratedSchema(
  databaseUrl: string,
  prefix: string,
): Promise<MigratedSchema> {
  const name = `${prefix}_${randomUUID().replaceAll('-', '')}`
  const db = new Client({ connectionString: databaseUrl })
  await db.connect()
  let created = false
  let applied = ''
  const drop = async () => {
    try {
      // A migration with its own BEGIN leaves the session inside it when a statement fails.
      await db.query('ROLLBACK')
      if (created) await db.query(`DROP SCHEMA "${name}" CASCADE`)
    } finally {
      await db.end()
    }
  }
  try {
    await db.query(`CREATE SCHEMA "${name}"`)
    created = true
    // Session scope survives the BEGIN/COMMIT wrappers of the migration files.
    await db.query(`SET search_path TO "${name}"`)
  } catch (error) {
    await drop()
    throw error
  }
  return {
    name,
    db,
    async migrate(through) {
      const names = (await readdir(migrations, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
      if (through !== undefined && !names.includes(through))
        throw new Error(`Unknown migration ${through}`)
      for (const migration of names) {
        if (migration <= applied || (through !== undefined && migration > through)) continue
        await db.query(await readFile(new URL(`${migration}/migration.sql`, migrations), 'utf8'))
        applied = migration
      }
    },
    drop,
  }
}

/** A Prisma client of the schema: model queries are qualified with it, raw ones resolve in it. */
export function schemaClient(databaseUrl: string, schema: MigratedSchema): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: databaseUrl, options: `-c search_path=${schema.name}` },
      { schema: schema.name },
    ),
    log: [],
  })
}
