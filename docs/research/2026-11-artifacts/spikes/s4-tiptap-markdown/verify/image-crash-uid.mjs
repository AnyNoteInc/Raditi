// The same inline picture with UniqueID in the set (plan §7.7): where the "crash" comes from.
import './dom.mjs'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import Image from '@tiptap/extension-image'
import { UniqueID } from '@tiptap/extension-unique-id'
const md = 'Смотрите ![значок](icon.png) рядом.\n'
const ext = () => [StarterKit, Image, UniqueID.configure({ types: ['heading', 'paragraph'] }), Markdown]
const mk = (opts = {}) => { const el = document.createElement('div'); document.body.append(el); return new Editor({ element: el, extensions: ext(), ...opts }) }
try { const a = mk({ content: md, contentType: 'markdown' }); console.log('constructor + UniqueID: ok', JSON.stringify(a.getMarkdown())) } catch (e) { console.log('constructor + UniqueID: THROWS', e.message) }
const b = mk()
try { b.commands.setContent(md, { contentType: 'markdown' }); console.log('setContent + UniqueID: ok', JSON.stringify(b.getMarkdown())) } catch (e) { console.log('setContent + UniqueID: THROWS', e.message) }
const c = mk({ content: md, contentType: 'markdown' })
try { c.commands.insertContent(' ещё'); console.log('typing: ok') } catch (e) { console.log('typing + UniqueID: THROWS', e.message) }
