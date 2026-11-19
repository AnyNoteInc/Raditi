// Tiptap 3 headless in Node, mounted on a jsdom element as the cabinet would mount it. The
// extension set of §7.7 / §7.13 of plan 88: StarterKit, tables, task list, link (in StarterKit),
// image, UniqueID, and @tiptap/markdown for the Markdown in and out.
import { installDom } from '../dom.mjs'
installDom()

const { Editor } = await import('@tiptap/core')
const { default: StarterKit } = await import('@tiptap/starter-kit')
const { Markdown } = await import('@tiptap/markdown')
const { Table, TableRow, TableHeader, TableCell } = await import('@tiptap/extension-table')
const { TaskList, TaskItem, BulletList, OrderedList, ListItem } = await import('@tiptap/extension-list')
const { default: Image } = await import('@tiptap/extension-image')
const { UniqueID } = await import('@tiptap/extension-unique-id')
const { spreadOf, FootnoteReference, FootnoteDefinition } = await import('./bridge-extensions.mjs')

/**
 * The extension sets the spike compares.
 * - stock: what §7.7 names, every option at its default (StarterKit keeps underline).
 * - tuned: the same, but underline off (Markdown has no underline: Tiptap writes `<u>`), images
 *   inline (an image in a sentence stays in its paragraph) and nested task items allowed.
 */
export function extensionSet(name, extra = []) {
  const common = [
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
    UniqueID.configure({ types: ['heading', 'paragraph'] }),
  ]
  if (name === 'stock') return [StarterKit, ...common, Image, Markdown, ...extra]
  if (name === 'tuned')
    return [
      StarterKit.configure({ underline: false, link: { openOnClick: false } }),
      ...common,
      Image.configure({ inline: true }),
      Markdown,
      ...extra,
    ]
  // The schema of the remark bridge: the tuned set without @tiptap/markdown, with `spread` on
  // lists and items and two footnote nodes. Markdown goes in and out by remark (remark-bridge.mjs).
  if (name === 'bridge')
    return [
      StarterKit.configure({
        underline: false,
        link: { openOnClick: false },
        bulletList: false,
        orderedList: false,
        listItem: false,
      }),
      spreadOf(BulletList),
      spreadOf(OrderedList),
      spreadOf(ListItem),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      spreadOf(TaskList),
      spreadOf(TaskItem.configure({ nested: true })),
      UniqueID.configure({ types: ['heading', 'paragraph'] }),
      Image.configure({ inline: true }),
      FootnoteReference,
      FootnoteDefinition,
      ...extra,
    ]
  throw new Error(`unknown extension set ${name}`)
}

const editors = new Map()

/** One mounted editor per extension set, reused: setContent replaces the document. */
export function editorOf(name, extra) {
  const key = name + (extra ? ':' + extra.map((e) => e.name).join(',') : '')
  if (!editors.has(key)) {
    const element = document.createElement('div')
    document.body.append(element)
    editors.set(key, new Editor({ element, extensions: extensionSet(name, extra ?? []) }))
  }
  return editors.get(key)
}

/** Markdown → the editor's document, through @tiptap/markdown (marked). */
export function loadMarkdown(editor, markdown) {
  editor.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: true })
  return editor.getJSON()
}

/** HTML → the editor's document (what a paste or a typed edit leaves). */
export function loadHtml(editor, html) {
  editor.commands.setContent(html, { emitUpdate: true })
  return editor.getJSON()
}

export function loadJson(editor, json) {
  editor.commands.setContent(json, { emitUpdate: true })
  return editor.getJSON()
}

/** The editor's document → Markdown, through @tiptap/markdown. */
export function saveMarkdown(editor) {
  return editor.getMarkdown()
}

/** The document without the ids UniqueID gives: they never reach Markdown. */
export function withoutIds(json) {
  return JSON.parse(
    JSON.stringify(json, (key, value) => {
      if (key === 'attrs' && value && typeof value === 'object') {
        const { id, ...rest } = value
        return Object.keys(rest).length ? rest : undefined
      }
      return value
    }),
  )
}

export function destroyAll() {
  for (const editor of editors.values()) editor.destroy()
  editors.clear()
}
