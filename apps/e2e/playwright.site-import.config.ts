import { defineConfig } from '@playwright/test'

import { stand } from './tests/site-import/stand.ts'

// The browser half of `pnpm verify:site-import` (infra/dev/site-import-verify): the wizard of a
// new project, the setup screen and «Изменить доступ» on real servers. The stand starts
// everything — next dev of apps/web with its own environment on 127.0.0.1, core, the hostings,
// the databases — and runs this config with SITE_IMPORT_STAND_FILE naming a 0600 file of its run
// directory; nothing here reads .env or starts a server. Run alone, every test is skipped.
//
// Two projects: `held` is b1 alone, while core is still stopped (its project waits in the queue
// for as long as the test looks at the setup screen); `wizard` is everything else, in parallel,
// once b1 is done — every test signs in its own user, so their imports never wait for each other.
// No trace: a trace would keep the passwords the tests type. A failure keeps a screenshot in the
// run directory, which the stand keeps aside (redacted logs and the screenshots).
export default defineConfig({
  testDir: './tests/site-import',
  outputDir: stand?.outputDir ?? './test-results/site-import',
  timeout: 300_000,
  expect: { timeout: 30_000 },
  workers: 4,
  fullyParallel: true,
  reporter: stand ? [['list'], ['json', { outputFile: stand.reportFile }]] : [['list']],
  use: {
    ...(stand ? { baseURL: stand.origin } : {}),
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 30_000,
    navigationTimeout: 120_000,
  },
  projects: [
    { name: 'held', testMatch: /held\.spec\.ts$/ },
    // A dependency runs whole whatever --grep says: b1 is one only when the run has b1.
    {
      name: 'wizard',
      testMatch: /(?:wizard|setup)\.spec\.ts$/,
      dependencies: !stand || stand.browser.includes('b1') ? ['held'] : [],
    },
  ],
})
