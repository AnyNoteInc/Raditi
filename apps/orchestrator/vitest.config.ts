import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// SWC instead of the default transform: Nest DI needs legacy decorators and their metadata,
// both read from tsconfig.json.
export default defineConfig({
  plugins: [swc.vite()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // A TCP connection or a dns.lookup outside this machine fails the test that tried it; what
    // the guard does not cover is listed in src/testing/network-guard.ts.
    setupFiles: ['src/testing/network-guard.setup.ts'],
    // Disposable DB collectors scan shared tables; concurrent files would steal one another's fixtures.
    fileParallelism: process.env.RADITI_GATEWAY_DB_TESTS !== '1',
  },
})
