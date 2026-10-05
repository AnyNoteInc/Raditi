// Idempotent seed: `pnpm db:seed` (Node runs this file natively, no tsx). Reference data only —
// tariffs, pricing rules, agent drivers and disabled subscription defaults (seed/data.ts).
// Existing LLM catalogue settings and all accounting rates stay operator-owned.
import { createPrismaClient, dbConfigFromEnv } from '../src/client.ts'
import { seedReferenceData, seededTables } from './seed/apply.ts'

const db = createPrismaClient(dbConfigFromEnv(process.env))
try {
  const { created, updated } = await seedReferenceData(db)
  for (const table of seededTables) {
    console.info(`[seed] ${table}: +${created[table]} created, ${updated[table]} updated`)
  }
  console.info('[seed] done')
} finally {
  await db.$disconnect()
}
