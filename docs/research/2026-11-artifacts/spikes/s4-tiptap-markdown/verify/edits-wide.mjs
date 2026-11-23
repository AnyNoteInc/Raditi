// Edits of a person, wider than the harness: in EVERY text block of every corpus document (not only
// the first one that fits), the LAST word of 4+ Cyrillic letters in an unmarked text node is
// replaced or made bold by a plain ProseMirror transaction (tr.insertText / tr.addMark), each on a
// fresh load. Passes when exactly one line of the canonical text changes. Both bridges.
import { editorOf, loadMarkdown, loadJson, saveMarkdown } from '../lib/tiptap.mjs'
import { mdToPm, pmToMd, canonBridge } from '../lib/remark-bridge.mjs'
import { canonPlan } from '../lib/canon.mjs'
import { readFileSync, readdirSync } from 'node:fs'
const decode = (s) => s.replace(/⍽/g, ' ').replace(/⎵/g, ' ')
const dir = new URL('../corpus/', import.meta.url).pathname
const docs = readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => [f, decode(readFileSync(dir + f, 'utf8'))])
const ways = {
  tiptap: { canon: canonPlan, load: (ed, a) => loadMarkdown(ed, a), save: (ed) => saveMarkdown(ed), set: 'stock' },
  bridge: { canon: canonBridge, load: (ed, a) => loadJson(ed, mdToPm(a)), save: (ed) => pmToMd(ed.getJSON()), set: 'bridge' },
}
function targets(doc) {
  const out = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock || node.type.name === 'codeBlock') return true
    let offset = 0, last = null
    node.forEach((child) => {
      if (child.isText && !child.marks.length) for (const m of child.text.matchAll(/[А-Яа-яЁё]{4,}/gu)) last = { from: pos + 1 + offset + m.index, to: pos + 1 + offset + m.index + m[0].length, word: m[0], block: node.type.name }
      offset += child.nodeSize
    })
    if (last) out.push(last)
    return false
  })
  return out
}
const changed = (a, c) => {
  const x = a.split('\n'), y = c.split('\n')
  if (x.length !== y.length) return { n: Math.abs(x.length - y.length) + 99, lines: [] }
  const lines = x.map((l, i) => [l, y[i]]).filter(([l, m]) => l !== m)
  return { n: lines.length, lines }
}
const result = {}
for (const [wayName, way] of Object.entries(ways)) {
  const r = (result[wayName] = { replace: [0, 0, 0], bold: [0, 0, 0], byBlock: {} })
  const ed = editorOf(way.set)
  for (const [, raw] of docs) {
    const a = way.canon(raw)
    way.load(ed, a)
    const ts = targets(ed.state.doc)
    for (const t of ts) {
      for (const kind of ['replace', 'bold']) {
        way.load(ed, a)
        const tr = kind === 'replace' ? ed.state.tr.insertText('ПРАВКА', t.from, t.to) : ed.state.tr.addMark(t.from, t.to, ed.schema.marks.bold.create())
        ed.view.dispatch(tr)
        const c = way.canon(way.save(ed))
        const d = changed(a, c)
        r[kind][1] += 1
        const one = d.n === 1
        const expected = one && (kind === 'replace' ? d.lines[0][1].replace('ПРАВКА', t.word) === d.lines[0][0] : d.lines[0][1].replace(`**${t.word}**`, t.word) === d.lines[0][0])
        if (one) r[kind][0] += 1
        if (expected) r[kind][2] += 1
        const b = (r.byBlock[t.block + ':' + kind] ??= [0, 0])
        b[1] += 1
        if (one) b[0] += 1
      }
    }
  }
}
for (const [w, r] of Object.entries(result)) console.log(w, 'replace one-line/all/expected-form:', r.replace.join(' / '), '| bold:', r.bold.join(' / '), '\n  by block (one-line/all):', JSON.stringify(r.byBlock))
