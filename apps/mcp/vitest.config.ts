import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// SWC instead of the default transform: Nest DI needs legacy decorators and their metadata,
// both read from tsconfig.json.
export default defineConfig({
  plugins: [swc.vite()],
  // @repo/service-runtime has Nest decorators, so Node gets its built dist; the tests read its
  // sources like those of the packages that ship none. The condition belongs to the ssr
  // environment Vitest runs the tests in: the top-level `resolve` reaches only the client's.
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // A TCP connection or a dns.lookup outside this machine fails the test that tried it; what
    // the guard does not cover is listed in @repo/app-bootstrap/testing/network-guard.
    setupFiles: ['@repo/app-bootstrap/testing/network-guard-setup'],
    // Disposable DB collectors scan shared tables; concurrent files would steal one another's fixtures.
    fileParallelism: process.env.RADITI_GATEWAY_DB_TESTS !== '1',
  },
})
