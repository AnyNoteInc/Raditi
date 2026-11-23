import { createElement, type MouseEvent, type ReactElement } from 'react'
import type { ElementContent, Root, RootContent } from 'hast'
import Markdown, { type Components, type Options } from 'react-markdown'
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

const plain = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

function markdownOptions(text: string, rules: DocumentRules): Options {
  return {
    remarkPlugins: [remarkGfm],
    rehypePlugins: [[rehypeDocumentRules, rules]],
    // The rules read every address themselves: nothing is rewritten before them.
    urlTransform: (url) => url,
    skipHtml: true,
    children: text,
  }
}

const sectionRules = {
  documents: new Set<string>(),
  imageSrc: () => null,
  documentLinks: false,
} satisfies DocumentRules

/** Text in a standalone artifact section is the same for its reader and its quote anchors. */
export function ArtifactSectionMarkdown({ text }: { text: string }): ReactElement {
  return createElement(DocumentMarkdown, { text, ...sectionRules })
}

export function DocumentMarkdown({
  text,
  documents,
  imageSrc,
  documentLinks = true,
  treeLinks = false,
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
    ...markdownOptions(text, { documents, imageSrc, documentLinks, treeLinks }),
    components,
  })
}

const textSeparators = new Set([
  'p',
  'br',
  'hr',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'table',
  'tr',
  'th',
  'td',
  'section',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
])

/** Used by both the checked Markdown tree and the selection from its rendered DOM. */
export const separatesSectionText = (tag: string): boolean => textSeparators.has(tag)

export function artifactSectionText(markdown: string): string {
  const options = markdownOptions(markdown, sectionRules)
  const pieces: string[] = []
  // Use react-markdown's synchronous pipeline without mounting elements. The last plugin sees
  // the sanitized tree, including visible link hosts and image labels.
  Markdown({
    ...options,
    rehypePlugins: [
      ...(options.rehypePlugins ?? []),
      () => (tree: Root) => {
        const collect = (node: RootContent | ElementContent) => {
          if (node.type === 'text') pieces.push(node.value)
          if (node.type !== 'element') return
          const separates = separatesSectionText(node.tagName)
          if (separates) pieces.push(' ')
          node.children.forEach(collect)
          if (separates) pieces.push(' ')
        }
        tree.children.forEach(collect)
      },
    ],
  })
  return pieces.join('')
}
