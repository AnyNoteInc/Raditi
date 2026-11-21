// Is the document the remark bridge hands the editor valid in the editor's own schema? For every
// construct and corpus document: node.check() after setContent, and one typed character at the end
// of every text block (a transaction ProseMirror validates).
import { editorOf, loadJson } from '../lib/tiptap.mjs'
import { mdToPm, canonBridge } from '../lib/remark-bridge.mjs'
import { constructs } from '../constructs.mjs'
import { readFileSync, readdirSync } from 'node:fs'
const decode = (s) => s.replace(/⍽/g, ' ').replace(/⎵/g, ' ')
const dir = new URL('../corpus/', import.meta.url).pathname
const docs = readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => [f, decode(readFileSync(dir + f, 'utf8'))])
const editor = editorOf('bridge')
const report = { checked: 0, invalid: [], typedFail: [] }
for (const [id, raw] of [...constructs.map(([id, , md]) => [id, md]), ...docs]) {
  const a = canonBridge(raw)
  loadJson(editor, mdToPm(a))
  report.checked += 1
  try { editor.state.doc.check() } catch (e) { report.invalid.push(`${id}: ${e.message.slice(0, 100)}`) }
  const ends = []
  editor.state.doc.descendants((n, pos) => { if (n.isTextblock && n.type.name !== 'codeBlock') ends.push(pos + 1 + n.content.size) })
  for (const end of ends.reverse()) {
    try { editor.view.dispatch(editor.state.tr.insertText('ж', end)) } catch (e) { report.typedFail.push(`${id}@${end}: ${e.message.slice(0, 80)}`); break }
  }
}
console.log('documents and constructs:', report.checked)
console.log('invalid by check():', report.invalid.length, report.invalid)
console.log('typing failed:', report.typedFail.length, report.typedFail)
