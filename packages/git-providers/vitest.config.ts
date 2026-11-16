import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Refuses a connection or a name lookup outside this machine (see the guard's header).
    setupFiles: ['@repo/app-bootstrap/testing/network-guard-setup'],
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
})
