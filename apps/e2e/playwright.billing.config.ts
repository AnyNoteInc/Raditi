import { fileURLToPath } from 'node:url'

import { defineConfig } from '@playwright/test'

import {
  authEnv,
  baseURL,
  databaseUrl,
  fakeYookassa,
  vault,
  webPort,
  yookassaShop,
} from './fixtures/billing-stand.ts'

// Browser checks of the cabinet pages that need a signed-in user: the settings and, slice by
// slice, the billing scenarios (docs/plan/37-billing-plan.md). Tests live in tests/billing and
// sign in through fixtures/signed-in.ts; the smoke run ignores that directory.
//
// The run needs two things from outside: DATABASE_URL in the environment, naming a PostgreSQL
// with migrations and seeds applied, and a local Docker (see OpenBao below). A disposable
// database is meant: every test creates a user and removes it afterwards. Nothing here reads
// .env, and without DATABASE_URL the run stops at once.
//   export DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:<port>/<database>
//   pnpm db:deploy && pnpm db:seed    # both print the database they work on: check the line
//   pnpm --filter e2e test:billing
// Web starts on :3110, the fake ЮKassa (infra/dev/billing-verify) on 127.0.0.1:4110 and a
// disposable OpenBao on 127.0.0.1:4210; E2E_BILLING_WEB_PORT, E2E_BILLING_YOOKASSA_PORT and
// E2E_BILLING_VAULT_PORT move them. OpenBao is there because a customer's first site — what
// makes the workspace and grants the gift — is added by the wizard «Добавить проект», which
// writes the access of the site to Vault: the run needs a local Docker with the image
// ghcr.io/openbao/openbao:2.7.0 loaded (infra/dev/billing-verify/README.md, «Что нужно»; nothing
// is pulled). The site itself is a synthetic WordPress on an SFTP server the test worker starts
// (fixtures/site-files.ts). Redis and S3 are not needed: the pages under test read PostgreSQL
// only. As for the other runs, stop `pnpm dev` first: Next allows one dev server per app
// directory.
export default defineConfig({
  testDir: './tests/billing',
  // Playwright empties the directory at start: the traces of the other runs stay where they are.
  outputDir: './test-results/billing',
  timeout: 60_000,
  // One test at a time: they all drive one fake ЮKassa, and a command to it (the outcome or
  // the card of the next payment) applies to whoever pays next.
  workers: 1,
  reporter: 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  webServer: [
    {
      name: 'Vault',
      // The AppRole of web comes from the environment, as the shop of the fake: never from the
      // arguments. The script removes its container when it is told to stop.
      command: `node infra/dev/billing-verify/openbao.mjs --port ${vault.port}`,
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      // Ready once web can log in: the mounts, the policies and the AppRole are in place.
      wait: { stdout: /"ready":true/ },
      timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 20_000 },
      env: { VAULT_ROLE_ID: vault.roleId, VAULT_SECRET_ID: vault.secretId },
    },
    {
      name: 'YooKassa',
      // The shop comes from the environment, as the fake wants it: never from the arguments.
      command: `node infra/dev/billing-verify/fake-yookassa.mjs --port ${fakeYookassa.port} --webhook-url ${fakeYookassa.webhookUrl}`,
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      url: `${fakeYookassa.controlUrl}/state`,
      timeout: 30_000,
      // Never another process on the port: the tests drive this fake and read its state.
      reuseExistingServer: false,
      env: yookassaShop,
    },
    {
      name: 'Web',
      // Next's own bin, not `pnpm exec`: see playwright.config.ts.
      command: `node_modules/.bin/next dev --port ${webPort}`,
      cwd: fileURLToPath(new URL('../web/', import.meta.url)),
      // Not the landing: the sign-in page compiles faster and the tests come to it anyway.
      url: `${baseURL}/sign-in`,
      timeout: 180_000,
      // A server someone else started has another secret, database and shop.
      reuseExistingServer: false,
      // Next loads the repository .env for every variable that is not exported. Everything that
      // decides whom web talks to is set here, so a developer's .env cannot turn the run into
      // another setup.
      env: {
        ...authEnv,
        ...yookassaShop,
        DATABASE_URL: databaseUrl(),
        YOOKASSA_API_URL: fakeYookassa.apiUrl,
        // Loopback only. The fake names 127.0.0.1 in X-Forwarded-For; for a sender without the
        // header Next puts the address of the connection there, 127.0.0.1 or ::1.
        YOOKASSA_WEBHOOK_ALLOWLIST: '127.0.0.1,::1',
        // The fake saves payment methods, and the scenarios pay with auto-renewal: the switch
        // is on whatever a developer's .env says.
        YOOKASSA_AUTOPAYMENTS: 'on',
        METRICS_TOKEN: 'raditi-dev-metrics',
        // The grace of an overdue tariff: «Тарифы» names its last day by it.
        BILLING_PAST_DUE_DAYS: '7',
        // The OpenBao of the run, by the AppRole `sites-writer`: «Добавить проект» writes there.
        VAULT_ADDR: vault.address,
        VAULT_ROLE_ID: vault.roleId,
        VAULT_SECRET_ID: vault.secretId,
        VAULT_DEV_ROOT_TOKEN: '',
        // Blank counts as unset and leaves Redis and S3 switched off: only /api/health and the
        // avatar routes read them.
        REDIS_URL: '',
        S3_ENDPOINT: '',
        S3_ACCESS_KEY_ID: '',
        S3_SECRET_ACCESS_KEY: '',
      },
    },
  ],
})
