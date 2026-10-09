import { fileURLToPath } from 'node:url'

import { defineConfig } from '@playwright/test'

// A local tool for reworking the landing CSS: records the computed styles of the page and
// compares them after a change (tests/landing-style-snapshot.spec.ts). Not a part of the smoke
// or landing suites. The same web server as in playwright.landing.config.ts: a database with
// seeds is enough, and `pnpm dev` has to be stopped first.
//   LANDING_STYLE_SNAPSHOT=record|compare LANDING_STYLE_SNAPSHOT_FILE=<path> \
//     node_modules/.bin/playwright test -c playwright.style-snapshot.config.ts
//   LANDING_STYLE_SNAPSHOT=shots LANDING_STYLE_SNAPSHOT_DIR=<directory> \
//     node_modules/.bin/playwright test -c playwright.style-snapshot.config.ts
// The shots mode writes PNGs of the sections and states to look at; the header of the spec lists
// them and LANDING_STYLE_SNAPSHOT_WIDTHS.
// LANDING_STYLE_SNAPSHOT_SERVER=start serves the production build instead (run
// `pnpm --filter web build` first): the order of CSS chunks there may differ from development,
// so a production snapshot is compared only with a production one.
const PORT = 3100
const baseURL = `http://localhost:${PORT}`
// eslint-disable-next-line turbo/no-undeclared-env-vars -- Switch of a local tool, outside Turbo tasks.
const server = process.env.LANDING_STYLE_SNAPSHOT_SERVER === 'start' ? 'start' : 'dev'

export default defineConfig({
  testDir: './tests',
  testMatch: 'landing-style-snapshot.spec.ts',
  timeout: 120_000,
  // One page at a time: the sections of a record are written to one file in turn.
  workers: 1,
  reporter: 'list',
  use: { baseURL },
  webServer: {
    name: 'Web',
    // Next's own bin, not `pnpm exec`: see playwright.config.ts.
    command: `node_modules/.bin/next ${server} --port ${PORT}`,
    cwd: fileURLToPath(new URL('../web/', import.meta.url)),
    url: baseURL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: { APP_URL: baseURL, BETTER_AUTH_URL: baseURL },
  },
})
