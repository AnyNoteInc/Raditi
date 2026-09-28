import { existsSync } from 'node:fs'

import { defineConfig } from 'prisma/config'

// The repo .env; already exported variables (CI, containers) win: loadEnvFile never overrides.
const envFile = new URL('../../.env', import.meta.url)
if (existsSync(envFile)) process.loadEnvFile(envFile)

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
