import { defineConfig } from '@playwright/test'

import { baseURL, webServer } from './landing-web-server.ts'

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
// eslint-disable-next-line turbo/no-undeclared-env-vars -- Switch of a local tool, outside Turbo tasks.
const server = process.env.LANDING_STYLE_SNAPSHOT_SERVER === 'start' ? 'start' : 'dev'
// eslint-disable-next-line turbo/no-undeclared-env-vars -- Switch of a local tool, outside Turbo tasks.
const record = process.env.LANDING_STYLE_SNAPSHOT === 'record'

export default defineConfig({
  testDir: './tests',
  testMatch: 'landing-style-snapshot.spec.ts',
  timeout: 120_000,
  // A record goes one page at a time: its sections are written to one file in turn. A comparison
  // only reads that file and every shot has a file of its own, so those run side by side.
  fullyParallel: !record,
  workers: record ? 1 : undefined,
  reporter: 'list',
  use: { baseURL },
  webServer: webServer(server),
})
