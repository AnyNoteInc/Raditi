import { fileURLToPath } from 'node:url'

import { defineConfig } from '@playwright/test'

// The smoke suite needs the local infrastructure (pnpm infra:up), applied migrations and seeds
// (pnpm db:deploy && pnpm db:seed): the landing shows the plans of the database. Connections
// come from the repo .env; exported variables win, so DATABASE_URL may name another database.
// Stop `pnpm dev` first: Next allows one dev server per app directory (.next/dev/lock), so a
// second one exits at once. Its own port keeps APP_URL and auth origins on this server.
const PORT = 3100
const baseURL = `http://localhost:${PORT}`
const CORE_PORT = 8181
const MCP_PORT = 8182
const metricsToken = process.env.METRICS_TOKEN ?? 'raditi-dev-metrics'

export default defineConfig({
  testDir: './tests',
  // A local tool with its own config (playwright.style-snapshot.config.ts), not a smoke test;
  // the billing tests run on their own web server and database (playwright.billing.config.ts).
  testIgnore: [
    'landing-style-snapshot.spec.ts',
    'tests/billing/**',
    'tests/site/**',
    'tests/site-import/**',
  ],
  timeout: 60_000,
  reporter: 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  webServer: [
    {
      name: 'Web',
      // Next's own bin, not `pnpm exec`: pnpm starts next in a separate process group that
      // Playwright's shutdown does not reach, so next kept running and the run never ended.
      command: `node_modules/.bin/next dev --port ${PORT}`,
      cwd: fileURLToPath(new URL('../web/', import.meta.url)),
      // Not /api/health: it answers 503 while a dependency is down, and the webServer would never be ready.
      url: baseURL,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: {
        APP_URL: baseURL,
        BETTER_AUTH_URL: baseURL,
        METRICS_TOKEN: metricsToken,
      },
    },
    {
      name: 'core',
      // Build the current sources (the shared runtime package first, which `nest build` does not
      // chain), then replace the shell with the Node of core: no watcher or detached pnpm
      // children survive Playwright's process-group shutdown. The mcp app (apps/mcp) is started
      // beside core in the same group, from its own build.
      command:
        "sh -c 'pnpm --filter @repo/service-runtime build && (cd ../mcp && node node_modules/@nestjs/cli/bin/nest.js build) && node node_modules/@nestjs/cli/bin/nest.js build && (cd ../mcp && node dist/main.js &) && exec node dist/main.js'",
      cwd: fileURLToPath(new URL('../core/', import.meta.url)),
      // core starts after mcp. Port readiness lets the tests report failed health checks, while
      // waiting on /health would turn a dependency outage into a startup timeout.
      port: CORE_PORT,
      timeout: 180_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGINT', timeout: 35_000 },
      // Everything but the connections is set here, so a developer's .env cannot turn the smoke
      // into another setup: turns stay with core (no runner API to bind or tokens to check),
      // and core reads no stack image outside production (SANDBOX_IMAGE may be unset). Both
      // processes read the variables they need and none of the other's.
      env: {
        APP_ENV: 'test',
        CORE_PORT: String(CORE_PORT),
        MCP_PORT: String(MCP_PORT),
        TURN_EXECUTOR: 'local',
        // The release API of a developer's .env would take the port of `pnpm dev`.
        RELEASE_API_HOST: '',
        METRICS_TOKEN: metricsToken,
      },
    },
  ],
})
