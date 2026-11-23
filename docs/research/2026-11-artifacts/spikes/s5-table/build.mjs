// Builds the spike with Vite and writes dist/bundle.json: the size of every chunk, raw, gzip
// (level 9) and brotli (quality 11). The «table» chunk is the code of src/table; React, MUI and
// decimal.js are already in the cabinet, TanStack and write-excel-file are new to it.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { build } from 'vite'

const root = import.meta.dirname

export async function buildSpike({ quiet = false } = {}) {
  await build({ root, logLevel: quiet ? 'warn' : 'info', configFile: join(root, 'vite.config.mjs') })
  const assets = join(root, 'dist', 'assets')
  const chunks = readdirSync(assets)
    .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
    .map((file) => {
      const body = readFileSync(join(assets, file))
      const name = file.replace(/-[A-Za-z0-9_-]{8}\.(js|css)$/, '.$1')
      return {
        file,
        name,
        raw: body.length,
        gzip: gzipSync(body, { level: 9 }).length,
        brotli: brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
      }
    })
    .sort((a, b) => b.gzip - a.gzip)
  const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8')
  const initial = chunks.filter((c) => html.includes(c.file) || !c.name.startsWith('xlsx'))
  const sum = (list, key) => list.reduce((s, c) => s + c[key], 0)
  const pick = (prefix) => chunks.filter((c) => c.name.startsWith(prefix))
  const report = {
    chunks,
    groups: Object.fromEntries(
      ['react', 'mui', 'tanstack', 'decimal', 'table', 'server-stub', 'xlsx', 'index'].map((g) => [
        g,
        { raw: sum(pick(g), 'raw'), gzip: sum(pick(g), 'gzip'), brotli: sum(pick(g), 'brotli') },
      ]),
    ),
    newToCabinet: {
      note: 'TanStack Table and Virtual plus the code of src/table; write-excel-file loads only on «Скачать → Excel»',
      gzip: sum([...pick('tanstack'), ...pick('table')], 'gzip'),
      brotli: sum([...pick('tanstack'), ...pick('table')], 'brotli'),
      lazyXlsxGzip: sum(pick('xlsx'), 'gzip'),
    },
    initialGzip: sum(initial, 'gzip'),
  }
  writeFileSync(join(root, 'dist', 'bundle.json'), `${JSON.stringify(report, null, 2)}\n`)
  return report
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await buildSpike()
  console.log('\n| Chunk | raw, KiB | gzip, KiB | brotli, KiB |\n| --- | ---: | ---: | ---: |')
  for (const c of report.chunks) {
    console.log(`| ${c.name} | ${(c.raw / 1024).toFixed(1)} | ${(c.gzip / 1024).toFixed(1)} | ${(c.brotli / 1024).toFixed(1)} |`)
  }
  console.log(`\nNew to the cabinet (tanstack + table), gzip: ${(report.newToCabinet.gzip / 1024).toFixed(1)} KiB; Excel on demand: ${(report.newToCabinet.lazyXlsxGzip / 1024).toFixed(1)} KiB`)
}
