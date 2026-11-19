// When does an inline picture "crash" with the block Image of the plan's set? Two ways to load the
// same Markdown: the editor's initial content, and setContent into a mounted editor. And is the
// document the constructor builds valid (node.check())?
import './dom.mjs'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import Image from '@tiptap/extension-image'
const md = 'Смотрите ![значок](icon.png) рядом.\n'
const mk = (opts = {}) => { const el = document.createElement('div'); document.body.append(el); return new Editor({ element: el, extensions: [StarterKit, Image, Markdown], ...opts }) }
const a = mk({ content: md, contentType: 'markdown' })
let valid
try { a.state.doc.check(); valid = 'valid' } catch (e) { valid = 'INVALID: ' + e.message }
console.log('constructor:', JSON.stringify(a.getJSON().content.map((n) => [n.type, (n.content ?? []).map((c) => c.type)])), '| check():', valid, '| md:', JSON.stringify(a.getMarkdown()))
try {
  a.commands.insertContent(' ещё')
  console.log('typing after it: ok')
} catch (e) { console.log('typing after it: THROWS', e.message) }
const b = mk()
try { b.commands.setContent(md, { contentType: 'markdown' }); console.log('setContent: ok', JSON.stringify(b.getMarkdown())) } catch (e) { console.log('setContent: THROWS', e.message) }
const c = mk({ content: md, contentType: 'markdown', enableContentCheck: true, onContentError: ({ error }) => console.log('onContentError:', error.message) })
console.log('with enableContentCheck:', JSON.stringify(c.getMarkdown()))
