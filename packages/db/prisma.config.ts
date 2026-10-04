import { existsSync } from 'node:fs'

import { defineConfig } from 'prisma/config'

// The repo .env; already exported variables (CI, containers) win: loadEnvFile never overrides.
const exported = process.env.DATABASE_URL !== undefined
const envFile = new URL('../../.env', import.meta.url)
if (existsSync(envFile)) process.loadEnvFile(envFile)

// Without an exported DATABASE_URL `db:deploy`, `db:migrate` and `db:seed` work on the database
// of the repo .env, which is easy to take for a disposable one. Every command that connects
// says where it goes and where that address came from, before Prisma does anything.
const offline = ['generate', 'validate', 'format', 'version']
const url = process.env.DATABASE_URL
if (url !== undefined && !offline.includes(process.argv[2] ?? '')) {
  const source = exported ? 'the environment' : 'the repository .env'
  process.stderr.write(`[db] target ${target(url)}: DATABASE_URL from ${source}\n`)
}

/** User, host and database; never the password or the query, which may carry one as well. */
function target(databaseUrl: string): string {
  try {
    const { username, host, pathname } = new URL(databaseUrl)
    return `${username ? `${username}@` : ''}${host}${pathname}`
  } catch {
    return 'an unparseable DATABASE_URL'
  }
}

export default defineConfig({
  schema: './prisma/schema.prisma',
  migrations: {
    path: './prisma/migrations',
    seed: 'node prisma/seed.ts',
  },
  datasource: {
    // Left undefined when DATABASE_URL is missing: `prisma generate` and `prisma validate`
    // do not need a database, while migrate and seed fail with Prisma's own message.
    url: process.env.DATABASE_URL,
  },
})
