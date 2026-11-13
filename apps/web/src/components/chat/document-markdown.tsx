import type { MouseEvent } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { rehypeDocumentRules, type DocumentRules } from './document-rules'

// A text document of the chat in the tab «Документы» (docs/plan/67-agent-documents.md, Д6): the
// Markdown of the agent as React elements, bound by `rehypeDocumentRules` — the same rules the
// server draws a shared link by. No hook and no style here: the tab dresses it (`documentSx`), so
// the very elements are what the tests read. Raw HTML is skipped, never parsed.

export interface DocumentMarkdownProps extends Omit<DocumentRules, 'documentLinks'> {
  text: string
  /** A link to another document of the chat was followed: opened in the tab. */
  onDocument?: (name: string, anchor: string | null) => void
  /** A link to a heading of this document: scrolled to it in the tab, not by the page's address. */
  onAnchor?: (id: string) => void
}

const plain = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

export function DocumentMarkdown({
  text,
  documents,
  imageSrc,
  onDocument,
  onAnchor,
}: DocumentMarkdownProps) {
  const components: Components = {
    a: ({ node, href, children, ...rest }) => {
      const name = node?.properties.dataDocument
      const anchor = node?.properties.dataAnchor
      if (typeof name === 'string')
        return (
          <a
            {...rest}
            href="#"
            data-document={name}
            onClick={(event) => {
              event.preventDefault()
              onDocument?.(name, typeof anchor === 'string' ? anchor : null)
            }}
          >
            {children}
          </a>
        )
      if (href?.startsWith('#') && onAnchor)
        return (
          <a
            href={href}
            {...rest}
            onClick={(event) => {
              if (!plain(event)) return
              event.preventDefault()
              onAnchor(href.slice(1))
            }}
          >
            {children}
          </a>
        )
      return (
        <a href={href} {...rest}>
          {children}
        </a>
      )
    },
  }
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeDocumentRules, { documents, imageSrc, documentLinks: true }]]}
      // The rules read every address themselves: nothing is rewritten before them.
      urlTransform={(url) => url}
      components={components}
      skipHtml
    >
      {text}
    </Markdown>
  )
}
