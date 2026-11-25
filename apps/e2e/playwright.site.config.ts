import { defineConfig } from '@playwright/test'

import billing from './playwright.billing.config.ts'

// Browser checks of the page of one site (docs/plan/38-site-page-plan.md, M12.3): the shell on
// a phone, a tablet and a desktop, and every section a slice adds. The stand is the one of the
// billing run — a signed-in user from fixtures/signed-in.ts, web on :3110 and an exported
// DATABASE_URL of a disposable PostgreSQL with migrations and seeds:
//   pnpm --filter e2e test:site

const servers = billing.webServer
const webServers = servers === undefined ? [] : Array.isArray(servers) ? servers : [servers]

export default defineConfig({
  ...billing,
  testDir: './tests/site',
  outputDir: './test-results/site',
  // The edit frame of a screen of a canvas runs in WebKit too (docs/plan/88-artifacts.md, §7.9):
  // WebKit calls no handler on the nodes of a frame without scripts, the cabinet's own layer must do.
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' }, testMatch: /(edit-frame|canvas)\.spec\.ts$/ },
  ],
  // No cloud browser in this run: no worker streams it, so the browser of a chat says it cannot
  // be shown. Next loads the repository .env for every variable that is not exported: blank
  // counts as unset here.
  webServer: webServers.map((server) =>
    server.name === 'Web'
      ? {
          ...server,
          env: {
            ...server.env,
            BROWSER_STREAM_PUBLIC_URL: '',
            // «Страницы» (docs/plan/73-pages-sites.md): pages are set up, nothing serves them.
            PAGES_BASE_DOMAIN: 'pages.localhost',
            // The frame of a screen is signed by it (docs/plan/88-artifacts.md, Ар28).
            PAGES_SIGNING_SECRET: 'synthetic-pages-secret-of-the-site-run-0001',
          },
        }
      : server,
  ),
})
