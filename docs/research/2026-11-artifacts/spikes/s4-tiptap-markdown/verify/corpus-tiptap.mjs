// The corpus through @tiptap/markdown on my own path: a new editor per document with the Markdown as
// its initial content (plan §7.7 set: StarterKit, TableKit, task list, Image, UniqueID, Markdown),
// my canon, the real doc-render text. Counts documents whose reader text changes, and where the
// no-break spaces of table rows go.
import './dom.mjs'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { TableKit } from '@tiptap/extension-table'
import { TaskList, TaskItem } from '@tiptap/extension-list'
import Image from '@tiptap/extension-image'
import { UniqueID } from '@tiptap/extension-unique-id'
import { canon, seen } from './canon.mjs'
import { readFileSync, readdirSync } from 'node:fs'
const decode = (s) => s.replace(/⍽/g, ' ').replace(/⎵/g, ' ')
const dir = new URL('../corpus/', import.meta.url).pathname
const rowsNb = (md) => md.split('\n').filter((l) => l.startsWith('|')).join('\n').match(/[  ]/g)?.length ?? 0
const restNb = (md) => md.split('\n').filter((l) => !l.startsWith('|')).join('\n').match(/[  ]/g)?.length ?? 0
let wordsChanged = 0, nbsplost = 0, same = 0, crashed = 0
const lostDocs = []
for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
  const a = canon(decode(readFileSync(dir + f, 'utf8')))
  try {
    const el = document.createElement('div')
    document.body.append(el)
    const ed = new Editor({ element: el, extensions: [StarterKit, TableKit, TaskList, TaskItem.configure({ nested: true }), Image, UniqueID.configure({ types: ['heading', 'paragraph'] }), Markdown], content: a, contentType: 'markdown' })
    const c = canon(ed.getMarkdown())
    ed.destroy()
    if (c === a) same += 1
    if (seen(a) !== seen(c)) wordsChanged += 1
    if (rowsNb(c) < rowsNb(a)) { nbsplost += 1; lostDocs.push(`${f} ${rowsNb(a)}→${rowsNb(c)} (вне таблиц ${restNb(a)}→${restNb(c)})`) }
  } catch (e) { crashed += 1 }
}
console.log({ same, wordsChanged, nbspLostInTables: nbsplost, crashed })
console.log(lostDocs.join('\n'))
