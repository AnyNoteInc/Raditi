// Sizes of a synthetic table in the shapes of plan 88 §7.1–7.2: rows as blocks, a version as a
// list of {key, rev}, a paste as `cells` operations. Prints a Markdown table.
import { gzipSync } from 'node:zlib'
import { makeRows } from './src/data.ts'

const enc = new TextEncoder()
const kb = (n) => (n / 1024).toFixed(1).replace('.', ',')
console.log('| Строк | JSON строк, КиБ | gzip, КиБ | Средняя строка, байт | Версия {key, rev}, КиБ | Вставка всех строк: операций / пакетов по 50 |')
console.log('| ---: | ---: | ---: | ---: | ---: | ---: |')
for (const n of [300, 5000, 20000]) {
  const rows = makeRows(n, 1)
  const blocks = rows.map(({ id, ...cells }) => ({ key: id, kind: 'row', rev: 1, props: { cells } }))
  const json = JSON.stringify(blocks)
  const version = JSON.stringify(rows.map((r) => ({ key: r.id, rev: 12 })))
  const bytes = enc.encode(json).length
  console.log(`| ${n} | ${kb(bytes)} | ${kb(gzipSync(json).length)} | ${Math.round(bytes / n)} | ${kb(enc.encode(version).length)} | ${n} / ${Math.ceil(n / 50)} |`)
}

// One batch with a paste of 300 rows × 6 columns, if `cells` were not limited to 50 operations.
const paste = makeRows(300, 7).map(({ id, ...cells }) => ({ op: 'cells', block: id, cells }))
const batch = { artifactId: 'a-price-list', opId: 'op-1', ops: paste }
const nodes = (v) => (v && typeof v === 'object' ? 1 + Object.values(v).reduce((s, x) => s + nodes(x), 0) : 1)
console.log(`\nВставка 300 строк × 6 столбцов одним пакетом: ${kb(enc.encode(JSON.stringify(batch)).length)} КиБ JSON, ${nodes(batch)} узлов (значений JSON)`)
