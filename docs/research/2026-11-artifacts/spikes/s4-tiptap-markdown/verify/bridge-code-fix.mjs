// The bridge's schema with Code that excludes no marks (Code.extend({ excludes: '' })): are the two
// documents that fail node.check() valid now, and does a paste of <a><code> keep the link?
import '../dom.mjs'
import { installDom } from '../dom.mjs'
installDom()
const { Editor } = await import('@tiptap/core')
const { default: StarterKit } = await import('@tiptap/starter-kit')
const { default: Code } = await import('@tiptap/extension-code')
const { Table, TableRow, TableHeader, TableCell } = await import('@tiptap/extension-table')
const { TaskList, TaskItem, BulletList, OrderedList, ListItem } = await import('@tiptap/extension-list')
const { default: Image } = await import('@tiptap/extension-image')
const { spreadOf, FootnoteReference, FootnoteDefinition } = await import('../lib/bridge-extensions.mjs')
const { mdToPm, pmToMd, canonBridge } = await import('../lib/remark-bridge.mjs')
const set = (fix) => [
  StarterKit.configure({ underline: false, link: { openOnClick: false }, bulletList: false, orderedList: false, listItem: false, ...(fix ? { code: false } : {}) }),
  ...(fix ? [Code.extend({ excludes: '' })] : []),
  spreadOf(BulletList), spreadOf(OrderedList), spreadOf(ListItem), Table, TableRow, TableHeader, TableCell,
  spreadOf(TaskList), spreadOf(TaskItem.configure({ nested: true })), Image.configure({ inline: true }), FootnoteReference, FootnoteDefinition,
]
for (const fix of [false, true]) {
  const el = document.createElement('div'); document.body.append(el)
  const ed = new Editor({ element: el, extensions: set(fix) })
  for (const md of ['Откройте [`README.md`](https://example.ru/readme)', '**`npm install`** и *`код`*']) {
    const a = canonBridge(md)
    ed.commands.setContent(mdToPm(a))
    let v = 'valid'; try { ed.state.doc.check() } catch (e) { v = 'INVALID' }
    console.log(fix ? 'fixed  ' : 'harness', v, JSON.stringify(pmToMd(ed.getJSON())) === JSON.stringify(a) ? 'round trip =' : 'round trip ≠')
  }
  ed.commands.setContent('<p><a href="https://example.ru"><code>README.md</code></a> и <strong><code>npm</code></strong></p>')
  console.log(fix ? 'fixed  ' : 'harness', 'paste of <a><code>, <strong><code> →', JSON.stringify(pmToMd(ed.getJSON())))
}
