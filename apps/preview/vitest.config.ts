import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// SWC instead of the default transform: Nest DI needs legacy decorators and their metadata,
// both read from tsconfig.json.
export default defineConfig({
  plugins: [swc.vite()],
  // @repo/service-runtime has Nest decorators, so Node gets its built dist; the tests read its
  // sources. The condition belongs to the ssr environment.
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // A TCP connection or a dns.lookup outside this machine fails the test that tried it.
    setupFiles: ['@repo/app-bootstrap/testing/network-guard-setup'],
    // The PostgreSQL suites run one file at a time, as those of core, llm and mcp do on the same
    // disposable database.
    fileParallelism: process.env.RADITI_GATEWAY_DB_TESTS !== '1',
  },
})
