// What the remark bridge adds to the editor's schema so that the canonical Markdown fits in it:
// the spacing of a list («loose» or «tight»), footnotes, and table cells of one paragraph.
import { Node, mergeAttributes } from '@tiptap/core'

const SPREAD = {
  spread: {
    default: false,
    rendered: false,
    keepOnSplit: true,
  },
}

/** `spread` on lists and items, kept from Markdown to Markdown; the editor does not draw it. */
export function spreadOf(extension) {
  return extension.extend({
    addAttributes() {
      return { ...(this.parent?.() ?? {}), ...SPREAD }
    },
  })
}

/** A footnote call: an inline atom with its label, drawn as a superscript. */
export const FootnoteReference = Node.create({
  name: 'footnoteReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      identifier: { default: '' },
      label: { default: null },
    }
  },
  parseHTML() {
    return [
      {
        tag: 'sup[data-footnote-ref]',
        getAttrs: (element) => ({
          identifier: element.getAttribute('data-footnote-ref') ?? '',
          label: element.textContent || null,
        }),
      },
    ]
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'sup',
      mergeAttributes(HTMLAttributes, { 'data-footnote-ref': node.attrs.identifier }),
      node.attrs.label ?? node.attrs.identifier,
    ]
  },
  renderText({ node }) {
    return `[${node.attrs.label ?? node.attrs.identifier}]`
  },
})

/** A footnote's text: a block of blocks with its label. */
export const FootnoteDefinition = Node.create({
  name: 'footnoteDefinition',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      identifier: { default: '' },
      label: { default: null },
    }
  },
  parseHTML() {
    return [
      {
        tag: 'section[data-footnote-definition]',
        getAttrs: (element) => ({ identifier: element.getAttribute('data-footnote-definition') ?? '' }),
      },
    ]
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'section',
      mergeAttributes(HTMLAttributes, { 'data-footnote-definition': node.attrs.identifier }),
      0,
    ]
  },
})
