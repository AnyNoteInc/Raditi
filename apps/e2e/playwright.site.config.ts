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
  // No previews and no cloud browser in this run: no core builds the one, no worker streams the
  // other. The menu «+» of a dialog offers no preview then, the browser of a task says it cannot
  // be shown, and a site that is not connected offers neither mode (chat.spec.ts). Next loads the
  // repository .env for every variable that is not exported, and .env.example sets
  // PREVIEW_BASE_DOMAIN: blank counts as unset here.
  webServer: webServers.map((server) =>
    server.name === 'Web'
      ? {
          ...server,
          env: {
            ...server.env,
            PREVIEW_BASE_DOMAIN: '',
            PREVIEW_PUBLIC_PORT: '',
            BROWSER_STREAM_PUBLIC_URL: '',
          },
        }
      : server,
  ),
})
