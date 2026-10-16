import { defineConfig } from '@playwright/test'

import billing from './playwright.billing.config.ts'

// Browser checks of the page of one site (docs/plan/38-site-page-plan.md, M12.3): the shell on
// a phone, a tablet and a desktop, and every section a slice adds. The stand is the one of the
// billing run — a signed-in user from fixtures/signed-in.ts, web on :3110 and an exported
// DATABASE_URL of a disposable PostgreSQL with migrations and seeds:
//   pnpm --filter e2e test:site
export default defineConfig({
  ...billing,
  testDir: './tests/site',
  outputDir: './test-results/site',
})
