import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Refuses a connection or a name lookup outside this machine (see the guard's header).
    setupFiles: ['src/testing/network-guard.setup.ts'],
  },
})
