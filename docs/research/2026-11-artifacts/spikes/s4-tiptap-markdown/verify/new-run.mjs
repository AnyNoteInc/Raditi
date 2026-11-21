// Runs the new constructs through both bridges, the way the cabinet would: canonical A on the
// server, A into the editor, the editor's document out, canonical C. Classes by the real doc-render.
import { editorOf, loadMarkdown, loadJson, saveMarkdown } from '../lib/tiptap.mjs'
import { mdToPm, pmToMd, canonBridge } from '../lib/remark-bridge.mjs'
import { canonPlan } from '../lib/canon.mjs'
import { html, seen } from './canon.mjs'
import { newConstructs } from './new-constructs.mjs'
const cls = (a, c) => (a === c ? '=' : html(a) === html(c) ? '~' : seen(a) === seen(c) ? 'F' : 'W')
const NB = ' ', NN = ' '
const show = (s) => JSON.stringify(s).replaceAll(NB, '⍽').replaceAll(NN, '⎵')
const tally = { bridge: {}, tiptap: {}, canonLoss: [] }
const rows = []
for (const [id, raw] of newConstructs) {
  const row = { id }
  // the bridge
  try {
    const a = canonBridge(raw)
    const ed = editorOf('bridge')
    loadJson(ed, mdToPm(a))
    let valid = 'ok'
    try { ed.state.doc.check() } catch (e) { valid = 'invalid' }
    const c = canonBridge(pmToMd(ed.getJSON()))
    row.bridge = cls(a, c) + (canonBridge(a) === a ? '' : '²') + (valid === 'ok' ? '' : 'ᶜ')
    // what the canon itself does to the reader's text
    if (seen(raw) !== seen(a)) tally.canonLoss.push(`${id}: raw ${show(seen(raw))} → canon ${show(seen(a))}`)
  } catch (e) { row.bridge = 'X ' + e.message.slice(0, 60) }
  // @tiptap/markdown, the plan's set and canon
  try {
    const a = canonPlan(raw)
    const ed = editorOf('stock')
    loadMarkdown(ed, a)
    const c = canonPlan(saveMarkdown(ed))
    row.tiptap = cls(a, c)
    if (row.tiptap === 'W') row.tiptapWhy = `${show(seen(a)).slice(0, 70)} → ${show(seen(c)).slice(0, 70)}`
  } catch (e) { row.tiptap = 'X'; row.tiptapWhy = e.message.slice(0, 60) }
  rows.push(row)
  for (const k of ['bridge', 'tiptap']) tally[k][row[k][0]] = (tally[k][row[k][0]] ?? 0) + 1
}
for (const r of rows) console.log(`${r.id.padEnd(24)} bridge ${r.bridge.padEnd(4)} tiptap ${r.tiptap}${r.tiptapWhy ? '  ' + r.tiptapWhy : ''}`)
console.log('\nbridge:', tally.bridge, '\ntiptap:', tally.tiptap)
console.log('\nreader text changed by the bridge canon (raw → A):', tally.canonLoss.length)
for (const l of tally.canonLoss) console.log('  ' + l)
