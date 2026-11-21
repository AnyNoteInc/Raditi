import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const fromHere = (path: string) => fileURLToPath(new URL(path, import.meta.url))

// Node by default; a component test opts into jsdom with `// @vitest-environment jsdom`.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fromHere('./src'),
      // The marker throws outside the react-server condition; tests run server modules directly.
      'server-only': fromHere('./node_modules/server-only/empty.js'),
      // The ESM build of mui-tiptap, processed by Vite (below): its package names it only under
      // the `module` condition, so Node would take the CommonJS build.
      'mui-tiptap': fromHere('./node_modules/mui-tiptap/dist/esm/index.js'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    // mui-tiptap's ESM build imports without extensions, which Node cannot load, and its CommonJS
    // build brings a second @tiptap/core and ProseMirror beside the ESM ones — «different
    // instances of a keyed plugin» (docs/research/2026-11-artifacts/spikes/s4-tiptap-markdown).
    // Vite processes the ESM build instead, on the one copy of the editor.
    server: { deps: { inline: [/mui-tiptap/] } },
  },
})
