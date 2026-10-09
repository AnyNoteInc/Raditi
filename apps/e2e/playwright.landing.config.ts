import { fileURLToPath } from 'node:url'

import { defineConfig } from '@playwright/test'

// Browser checks of the landing alone: the web server and a database with seeds are enough
// (the plans come from the database), the orchestrator is not started. As for the smoke suite,
// stop `pnpm dev` first: Next allows one dev server per app directory.
const PORT = 3100
const baseURL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './tests',
  testMatch: 'landing.spec.ts',
  timeout: 60_000,
  reporter: 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  webServer: {
    name: 'Web',
    // Next's own bin, not `pnpm exec`: see playwright.config.ts.
    command: `node_modules/.bin/next dev --port ${PORT}`,
    cwd: fileURLToPath(new URL('../web/', import.meta.url)),
    url: baseURL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: { APP_URL: baseURL, BETTER_AUTH_URL: baseURL },
  },
})
