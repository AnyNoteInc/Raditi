import { mergeAttributes, Node, type AnyExtension } from '@tiptap/core'
import Code from '@tiptap/extension-code'
import Image from '@tiptap/extension-image'
import { BulletList, ListItem, OrderedList, TaskItem, TaskList } from '@tiptap/extension-list'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import UniqueID from '@tiptap/extension-unique-id'
import StarterKit from '@tiptap/starter-kit'

// The schema of the editor of a section (docs/plan/88-artifacts.md, §7.7; spike 4 of Э0а): every
// form the canonical Markdown of @repo/doc-bridge holds fits it, and nothing more — no underline,
// which Markdown has not; headings from the third level; `spread` of lists and items kept but not
// drawn; footnotes; the mark of code without `excludes`, so code inside a link or bold is valid.

const SPREAD = {
  spread: { default: false, rendered: false, keepOnSplit: true },
} as const

/** `spread` on a list or an item: kept from Markdown to Markdown, not drawn. */
function spreadOf<T extends AnyExtension>(extension: T): T {
  return (extension as unknown as { extend: (config: object) => T }).extend({
    addAttributes(this: { parent?: () => Record<string, unknown> }) {
      return { ...(this.parent?.() ?? {}), ...SPREAD }
    },
  })
}

/** A call of a footnote: an inline atom with its label, drawn as a superscript. */
export const FootnoteReference = Node.create({
  name: 'footnoteReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { identifier: { default: '' }, label: { default: null } }
  },
  parseHTML() {
    return [
      {
        tag: 'sup[data-footnote-ref]',
        getAttrs: (element: HTMLElement) => ({
          identifier: element.getAttribute('data-footnote-ref') ?? '',
          label: element.textContent || null,
        }),
      },
    ]
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'sup',
      mergeAttributes(HTMLAttributes, { 'data-footnote-ref': node.attrs.identifier as string }),
      (node.attrs.label as string | null) ?? (node.attrs.identifier as string),
    ]
  },
  renderText({ node }) {
    return `[${(node.attrs.label as string | null) ?? (node.attrs.identifier as string)}]`
  },
})

/** The text of a footnote: a block of blocks with its label. */
export const FootnoteDefinition = Node.create({
  name: 'footnoteDefinition',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return { identifier: { default: '' }, label: { default: null } }
  },
  parseHTML() {
    return [
      {
        tag: 'section[data-footnote-definition]',
        getAttrs: (element: HTMLElement) => ({
          identifier: element.getAttribute('data-footnote-definition') ?? '',
        }),
      },
    ]
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'section',
      mergeAttributes(HTMLAttributes, {
        'data-footnote-definition': node.attrs.identifier as string,
      }),
      0,
    ]
  },
})

/** The extensions of the editor of a section, its toolbar's commands among them. */
export function sectionExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      underline: false,
      code: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      heading: { levels: [3, 4, 5, 6] },
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
    }),
    Code.extend({ excludes: '' }),
    spreadOf(BulletList),
    spreadOf(OrderedList),
    spreadOf(ListItem),
    spreadOf(TaskList),
    spreadOf(TaskItem.configure({ nested: true })),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Image.configure({ inline: true }),
    FootnoteReference,
    FootnoteDefinition,
    UniqueID.configure({ types: ['heading', 'paragraph'] }),
  ]
}
