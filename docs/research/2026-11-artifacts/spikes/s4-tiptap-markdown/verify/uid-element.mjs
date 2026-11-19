// UniqueID without an element: the default element, and element: null explicitly.
import './dom.mjs'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { UniqueID } from '@tiptap/extension-unique-id'
const ids = (ed) => { const o = []; ed.state.doc.descendants((n) => { if ('id' in (n.attrs ?? {})) o.push(n.attrs.id) }); return o }
const ext = () => [StarterKit, UniqueID.configure({ types: ['paragraph'] })]
const d = new Editor({ extensions: ext(), content: '<p>а</p><p>б</p>' })
const n = new Editor({ element: null, extensions: ext(), content: '<p>а</p><p>б</p>' })
await new Promise((r) => setTimeout(r, 30))
console.log('no element option: ids', ids(d), '| options.element', d.options.element === null ? 'null' : typeof d.options.element, '| dom connected', d.view?.dom?.isConnected)
let nv
try { nv = n.view?.dom?.isConnected } catch (e) { nv = 'view: ' + e.message.slice(0, 60) }
console.log('element: null: ids', ids(n), '| isInitialized', n.isInitialized, '|', nv)
n.mount(document.body.appendChild(document.createElement('div')))
await new Promise((r) => setTimeout(r, 30))
console.log('element: null, after mount: ids', ids(n))
