// The skeptic's own arithmetic of plan 88 §7.2 limits for a table, without the spike's code:
// a paste of the check's 300 × 6 text as `cells` operations, counted two ways (values only, as
// packages/domain json-policy and apps/mcp canonical-json count, and values plus keys), and the
// worst case of long notes. Also rows as blocks and a version as {key, rev} (§7.1).
import { gzipSync } from 'node:zlib'
import { makeRows } from '../rebuild/src/data.ts'

const enc = new TextEncoder()
const bytes = (v) => enc.encode(JSON.stringify(v)).length
const values = (v) => (v && typeof v === 'object' ? 1 + Object.values(v).reduce((s, x) => s + values(x), 0) : 1)
const withKeys = (v) => (v && typeof v === 'object' ? 1 + Object.entries(v).reduce((s, [k, x]) => s + (Array.isArray(v) ? 0 : 1) + withKeys(x), 0) : 1)

const rows = makeRows(300, 7)
const op = ({ id, ...cells }) => ({ op: 'cells', block: id, cells })
const batch = { artifactId: 'a-price-list', opId: 'op-1', ops: rows.map(op) }
console.log(`300 × 6 as one batch: ${(bytes(batch) / 1024).toFixed(1)} KiB, ${values(batch)} value nodes, ${withKeys(batch)} nodes with keys`)

// Batches by the plan's three limits: 50 operations, 90 KiB, 4 000 value nodes.
function split(ops, { maxOps = Infinity, maxBytes = 90 * 1024, maxNodes = 4000 }) {
  const out = []
  let cur = []
  const fits = (list) => list.length <= maxOps && bytes({ artifactId: 'a-price-list', opId: 'op-99999', ops: list }) <= maxBytes && values({ artifactId: 'a', opId: 'o', ops: list }) <= maxNodes
  for (const o of ops) {
    if (!fits([...cur, o])) {
      out.push(cur)
      cur = []
    }
    cur.push(o)
  }
  if (cur.length) out.push(cur)
  return out.map((b) => b.length)
}
console.log('batches with the 50-operation limit:', split(batch.ops, { maxOps: 50 }).join('+'))
console.log('batches without it (90 KiB, 4 000 nodes):', split(batch.ops, {}).join('+'))

// The worst case of the spike's columns: names of 200 and notes of 1 000 characters (its maxLength).
const long = rows.map((r) => ({ ...r, name: 'Н'.repeat(200), note: 'П'.repeat(1000) }))
console.log('300 rows with 200-char names and 1 000-char notes, without the 50 limit:', split(long.map(op), {}).join('+'), `(${(bytes({ ops: long.map(op) }) / 1024).toFixed(0)} KiB)`)

for (const n of [300, 5000]) {
  const r = makeRows(n, 1)
  const blocks = r.map(({ id, ...cells }) => ({ key: id, kind: 'row', rev: 1, props: { cells } }))
  const json = JSON.stringify(blocks)
  const version = JSON.stringify(r.map((x) => ({ key: x.id, rev: 12 })))
  console.log(`${n} rows: ${(enc.encode(json).length / 1024).toFixed(1)} KiB JSON (${Math.round(enc.encode(json).length / n)} B a row), gzip ${(gzipSync(json).length / 1024).toFixed(1)} KiB; version {key,rev} ${(enc.encode(version).length / 1024).toFixed(1)} KiB`)
}
console.log(`2 MiB / 5 000 rows = ${Math.floor((2 * 1024 * 1024) / 5000)} B a row; 150 versions × version of 5 000 = ${((150 * enc.encode(JSON.stringify(makeRows(5000, 1).map((x) => ({ key: x.id, rev: 12 })))).length) / 1048576).toFixed(1)} MiB`)
