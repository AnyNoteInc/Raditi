// A few things a person leaves in the editor, on my own path: HTML as the editor's initial content,
// @tiptap/markdown out, then what the real doc-render shows and what the editor reads back.
import './dom.mjs'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { TableKit } from '@tiptap/extension-table'
import { html } from './canon.mjs'
import { mdToPm, pmToMd } from '../lib/remark-bridge.mjs'
const mk = (content, contentType) => { const el = document.createElement('div'); document.body.append(el); return new Editor({ element: el, extensions: [StarterKit, TableKit, Markdown], content, ...(contentType ? { contentType } : {}) }) }
const cases = {
  'буквенная нумерация': '<ol type="a"><li><p>а</p></li><li><p>б</p></li></ol>',
  'жирное вплотную к цифре': '<p><strong>Цена:</strong>1990</p>',
  'пустые абзацы': '<p>а</p><p></p><p></p><p>б</p>',
  'подчёркивание': '<p>Это <u>подчёркнуто</u>.</p>',
  'перенос в ячейке': '<table><tbody><tr><th><p>День</p></th></tr><tr><td><p>10:00–22:00<br>без перерыва</p></td></tr></tbody></table>',
  'перенос в заголовке': '<h3>Первая<br>вторая</h3>',
}
for (const [name, input] of Object.entries(cases)) {
  const ed = mk(input)
  const md = ed.getMarkdown()
  const back = mk(md, 'markdown')
  const same = JSON.stringify(back.getJSON()) === JSON.stringify(ed.getJSON())
  console.log(`## ${name}\n  tiptap md: ${JSON.stringify(md)}\n  doc-render: ${html(md)}\n  tiptap reads it back the same: ${same}`)
  // the bridge: the same editor document out through mdast
  try { const b = pmToMd(ed.getJSON()); console.log(`  bridge md: ${JSON.stringify(b)} → doc-render: ${html(b)}`) } catch (e) { console.log('  bridge: ' + e.message) }
}
