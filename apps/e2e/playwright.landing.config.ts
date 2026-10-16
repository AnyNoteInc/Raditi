import { defineConfig } from '@playwright/test'

import { baseURL, webServer } from './landing-web-server.ts'

// Browser checks of the landing alone. What they need to run is told in landing-web-server.ts.

export default defineConfig({
  testDir: './tests',
  testMatch: 'landing.spec.ts',
  // One file with a few hundred independent checks: each opens its own page and changes nothing
  // on the server, so they run side by side. Three at a time: the checks of motion read a value
  // two frames into a transition, and more browsers at once starve those frames.
  fullyParallel: true,
  workers: 3,
  timeout: 60_000,
  reporter: 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  webServer: webServer(),
})
