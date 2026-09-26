import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { config as loadEnv } from 'dotenv'
import { defineConfig } from 'prisma/config'

/** The nearest .env walking up from packages/db (normally the repo root). */
function findEnvFile(startDir: string): string | undefined {
  for (let dir = startDir; ; dir = dirname(dir)) {
    const candidate = join(dir, '.env')
    if (existsSync(candidate)) return candidate
    if (dirname(dir) === dir) return undefined
  }
}

const envFile = findEnvFile(dirname(fileURLToPath(import.meta.url)))
// Already exported variables (CI, containers) win over the file.
if (envFile) loadEnv({ path: envFile, quiet: true })

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
