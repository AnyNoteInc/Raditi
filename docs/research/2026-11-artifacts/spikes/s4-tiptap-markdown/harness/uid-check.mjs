// UniqueID gives nodes ids inside one editor; Markdown does not carry them, so the next load gives
// new ones. What survives storage is the block (section_key) and the quote, not a node id.
import { editorOf, loadMarkdown, saveMarkdown } from './lib/tiptap.mjs'
const md = '### Цены\n\n**Цена:** 1 990 ₽\n\nВторой абзац.\n'
const editor = editorOf('tuned')
const ids = () => {
  const out = []
  editor.state.doc.descendants((n) => {
    if (n.attrs?.id) out.push(n.attrs.id)
  })
  return out
}
loadMarkdown(editor, md)
const first = ids()
const saved = saveMarkdown(editor)
loadMarkdown(editor, saved)
const second = ids()
console.log('ids after load 1:', first.length, 'after load 2:', second.length, 'same:', first.every((id, i) => id === second[i]))
console.log('markdown carries an id:', /[0-9a-f]{8}-[0-9a-f]{4}/.test(saved), JSON.stringify(saved))
editor.destroy()
