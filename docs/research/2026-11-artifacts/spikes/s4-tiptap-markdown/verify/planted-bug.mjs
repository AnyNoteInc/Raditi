// A positive control for the bridge's own row: plant in a copy of the bridge the defect Tiptap has
// (white space in a table cell collapsed to one space, \s+ → ' ') and see which comparison notices.
// Row «bridge» (A = the bridge's own output), row «fixed» (A = canonFixed), and the check
// «raw text → canon» by the real doc-render text.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { editorOf, loadJson } from '../lib/tiptap.mjs'
import { canonFixed } from '../lib/canon.mjs'
import { seen } from './canon.mjs'
const lib = new URL('../lib/', import.meta.url)
const source = readFileSync(new URL('remark-bridge.mjs', lib), 'utf8')
const old = "const inner = block.type === 'paragraph' || block.type === 'heading' ? phrasing(block.content ?? []) : [{ type: 'text', value: cellText(block) }]"
if (!source.includes(old)) throw new Error('the bridge changed: the planted line is not found')
const planted = source
  .replace(old, `const inner = (${old.slice('const inner = '.length)}).map((n) => (n.type === 'text' ? { ...n, value: n.value.replace(/\\s+/g, ' ') } : n))`)
  .replace("from './canon.mjs'", "from '../lib/canon.mjs'")
const file = new URL('./planted-remark-bridge.mjs', import.meta.url)
writeFileSync(file, planted)
const { mdToPm, pmToMd, canonBridge } = await import(file.href)
const decode = (s) => s.replace(/⍽/g, ' ').replace(/⎵/g, ' ')
const dir = new URL('../corpus/', import.meta.url).pathname
const ed = editorOf('bridge')
const t = { bridgeRowSame: 0, fixedRowSame: 0, canonChangesReaderText: 0, docs: 0 }
for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
  const raw = decode(readFileSync(dir + f, 'utf8'))
  t.docs += 1
  const a = canonBridge(raw)
  loadJson(ed, mdToPm(a))
  if (canonBridge(pmToMd(ed.getJSON())) === a) t.bridgeRowSame += 1
  const af = canonFixed(raw)
  loadJson(ed, mdToPm(af))
  if (canonFixed(pmToMd(ed.getJSON())) === af) t.fixedRowSame += 1
  if (seen(raw) !== seen(a)) t.canonChangesReaderText += 1
}
console.log('planted defect:', t)
