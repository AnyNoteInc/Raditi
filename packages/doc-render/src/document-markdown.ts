import { createElement, type MouseEvent, type ReactElement } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { rehypeDocumentRules, type DocumentRules } from './rules.ts'

// A text document (docs/plan/67-agent-documents.md, Д6; docs/plan/69-pages.md, Ст11): the Markdown
// of the agent as React elements, bound by `rehypeDocumentRules`. The cabinet's tab dresses it
// (`documentSx`), the page for reading wraps it in the style of `readingPage`; the very elements
// are what the tests read. Raw HTML is skipped, never parsed. Plain `createElement`, no JSX: core
// runs this package from its TypeScript sources by type stripping.

export interface DocumentMarkdownProps extends Omit<DocumentRules, 'documentLinks'> {
  text: string
  /**
   * Whether a link to another document of the chat stays one (the tab; the default) or becomes its
   * words (a document shown alone, apart from its chat).
   */
  documentLinks?: boolean
  /** Links from the root of a site of pages stay links (Дер20); off in the cabinet's tab. */
  treeLinks?: boolean
  /** A link to another document of the chat was followed: opened in the tab. */
  onDocument?: (name: string, anchor: string | null) => void
  /** A link to a heading of this document: scrolled to it in the tab, not by the page's address. */
  onAnchor?: (id: string) => void
}

/** A node of the Markdown tree, as far as the break below reads it. */
interface MarkdownNode {
  type: string
  value?: string
  children?: MarkdownNode[]
}

/** The nodes whose children are words: a `<br>` among them is a break of the line. */
const PHRASING_PARENTS = new Set([
  'paragraph',
  'heading',
  'tableCell',
  'emphasis',
  'strong',
  'delete',
  'link',
  'linkReference',
  'footnoteDefinition',
])

/**
 * `<br>` in the text — agents write it in paragraphs and cells of tables though the instructions
 * ask for no HTML — is a break of the line. Raw HTML is skipped, and with it the `<br>` would glue
 * the words on both sides («окно.Вторая»).
 */
function remarkHtmlBreaks() {
  const walk = (node: MarkdownNode) => {
    if (!node.children) return
    if (PHRASING_PARENTS.has(node.type))
      node.children = node.children.map((child) =>
        child.type === 'html' && /^<br\s*\/?>$/i.test(child.value?.trim() ?? '')
          ? { type: 'break' }
          : child,
      )
    node.children.forEach(walk)
  }
  return walk
}

/**
 * The heading of the footnotes. remark-rehype names it «Footnotes» and hides it by a class, which
 * the rules drop: it is shown, and in Russian (rule 10). The link back is a «↩» without words.
 */
const REMARK_REHYPE = Object.freeze({
  footnoteLabel: 'Примечания',
  footnoteBackLabel: 'Назад к тексту',
})

const plain = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

export function DocumentMarkdown({
  text,
  documents,
  imageSrc,
  documentLinks = true,
  treeLinks = false,
  anchorBase,
  onDocument,
  onAnchor,
}: DocumentMarkdownProps): ReactElement {
  const components: Components = {
    a: ({ node, href, children, ...rest }) => {
      const name = node?.properties.dataDocument
      const anchor = node?.properties.dataAnchor
      if (typeof name === 'string')
        return createElement(
          'a',
          {
            ...rest,
            href: '#',
            'data-document': name,
            onClick: (event: MouseEvent) => {
              event.preventDefault()
              onDocument?.(name, typeof anchor === 'string' ? anchor : null)
            },
          },
          children,
        )
      if (href?.startsWith('#') && onAnchor)
        return createElement(
          'a',
          {
            href,
            ...rest,
            onClick: (event: MouseEvent) => {
              if (!plain(event)) return
              event.preventDefault()
              onAnchor(href.slice(1))
            },
          },
          children,
        )
      return createElement('a', { href, ...rest }, children)
    },
  }
  return createElement(Markdown, {
    remarkPlugins: [remarkGfm, remarkHtmlBreaks],
    remarkRehypeOptions: REMARK_REHYPE,
    rehypePlugins: [
      [rehypeDocumentRules, { documents, imageSrc, documentLinks, treeLinks, anchorBase }],
    ],
    // The rules read every address themselves: nothing is rewritten before them.
    urlTransform: (url: string) => url,
    components,
    skipHtml: true,
    children: text,
  })
}
