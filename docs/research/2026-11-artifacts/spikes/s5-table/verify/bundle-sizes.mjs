// Independent sizes: each library alone as an IIFE library build (Vite 8; whitespace is minified only
// outside the ES lib format), production NODE_ENV, React external,
// gzip level 9 — not the spike's chunk groups.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { build } from 'vite'

const dir = join(import.meta.dirname, 'sizes')
for (const name of ['table', 'table-columns', 'table-all', 'virtual', 'xlsx']) {
  const out = join(dir, `out-${name}`)
  await build({
    logLevel: 'silent',
    configFile: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: out,
      emptyOutDir: true,
      minify: true,
      target: 'es2023',
      lib: { entry: join(dir, `${name}.js`), formats: ['iife'], name: 'X', fileName: name },
      rolldownOptions: { external: ['react', 'react-dom', 'react/jsx-runtime'], output: { globals: { react: 'React', 'react-dom': 'ReactDOM', 'react/jsx-runtime': 'JSX' } } },
    },
  })
  const files = readdirSync(out).filter((f) => f.endsWith('.js'))
  const body = Buffer.concat(files.map((f) => readFileSync(join(out, f))))
  console.log(`${name}: ${(body.length / 1024).toFixed(1)} KiB raw, ${(gzipSync(body, { level: 9 }).length / 1024).toFixed(1)} KiB gzip`)
}
