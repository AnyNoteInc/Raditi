'use client'

import Box from '@mui/material/Box'
import MuiLink from '@mui/material/Link'
import { isValidElement, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// The agent's words as the chat of ChatGPT or Claude draws them (owner's request of 26.10.2026):
// its Markdown — paragraphs, emphasis, lists, code, tables, links — as React elements. Raw HTML of
// the text is dropped, never parsed (`skipHtml`); an image is not loaded — its address is the
// agent's, and a picture of another site would be fetched by the client's browser. A link stays a
// link only with an absolute http(s) or mailto address (`linkUrl`), opens apart from the cabinet,
// and names the host it leads to when its words do not: the agent reads the open internet, and a
// page it read may hand it words that hide where a link goes.

/** The address a link keeps; anything else — relative, `//host`, other schemes — is no link. */
export function linkUrl(url: string): string {
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : ''
}

/** The words of a link, as text. */
function wordsOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(wordsOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return wordsOf(node.props.children)
  return ''
}

/** The host a link leads to when its words do not say it; null — they do, or it is mail. */
export function hiddenHost(href: string, words: string): string | null {
  if (!/^https?:/i.test(href)) return null
  let host: string
  try {
    host = new URL(href).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
  return words.toLowerCase().includes(host.toLowerCase()) ? null : host
}

/** A heading of the agent is a line of its answer, not a heading of the page. */
const Heading = ({ children }: { children?: ReactNode }) => (
  <Box component="p" sx={{ fontWeight: 600 }}>
    {children}
  </Box>
)

const components: Components = {
  a: ({ href, children }) => {
    if (!href) return <span>{children}</span>
    const host = hiddenHost(href, wordsOf(children))
    return (
      <MuiLink href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
        {host ? (
          <Box component="span" sx={{ color: 'text.secondary', fontSize: '0.9em' }}>
            {` (${host})`}
          </Box>
        ) : null}
      </MuiLink>
    )
  },
  h1: Heading,
  h2: Heading,
  h3: Heading,
  h4: Heading,
  h5: Heading,
  h6: Heading,
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
  table: ({ children }) => (
    <Box sx={{ overflowX: 'auto', maxWidth: '100%' }}>
      <table>{children}</table>
    </Box>
  ),
}

interface MarkdownNode {
  type: string
  value?: string
  children?: MarkdownNode[]
}

/**
 * A line break of the agent stays one, as in a chat (06.11.2026): Markdown joins the lines of a
 * paragraph, so the break inside a text becomes a `break` node — the `<br>` of the page. Code and
 * the white space between the blocks of a list item are left as they are.
 */
function remarkSoftBreaks() {
  const walk = (node: MarkdownNode): void => {
    if (!node.children || node.type === 'code') return
    node.children = node.children.flatMap((child): MarkdownNode[] => {
      if (child.type !== 'text' || !child.value?.includes('\n')) {
        walk(child)
        return [child]
      }
      return child.value
        .split('\n')
        .flatMap((part, index): MarkdownNode[] => [
          ...(index > 0 ? [{ type: 'break' }] : []),
          ...(part === '' ? [] : [{ type: 'text', value: part }]),
        ])
    })
  }
  return (tree: MarkdownNode) => walk(tree)
}

const TREE_LINE = /[├└│]/
const FENCE = /^\s*(`{3,}|~{3,})/

/**
 * A tree of folders drawn with lines (`├──`, `└──`, `│`) is code: in a paragraph Markdown joins
 * its lines and drops their indent (06.11.2026: a tree of the project came as one paragraph). A run
 * of lines with two branches or more is fenced — with the line right before it, the root, when it
 * is a name and not a sentence. Text in a fence stays.
 */
export function fenceTextTrees(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let fenced = false
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!
    if (FENCE.test(line)) fenced = !fenced
    if (fenced || !TREE_LINE.test(line)) {
      out.push(line)
      i++
      continue
    }
    let end = i
    while (end < lines.length && TREE_LINE.test(lines[end]!) && !FENCE.test(lines[end]!)) end++
    const run = lines.slice(i, end)
    if (run.filter((entry) => /[├└]/.test(entry)).length < 2) {
      out.push(...run)
      i = end
      continue
    }
    const root = out.at(-1)
    // The root is a name, not the sentence that says what follows («Вот структура:»).
    const withRoot =
      root !== undefined &&
      root.trim() !== '' &&
      root.length <= 120 &&
      !/^\s*[-*+>#|]/.test(root) &&
      !/[:.!?]\s*$/.test(root)
    if (withRoot) out.pop()
    out.push('```', ...(withRoot ? [root] : []), ...run, '```')
    i = end
  }
  return out.join('\n')
}

export function AgentMarkdown({ text }: { text: string }) {
  return (
    <Box
      sx={{
        fontSize: 16,
        lineHeight: 1.65,
        overflowWrap: 'anywhere',
        minWidth: 0,
        '& > :first-of-type': { mt: 0 },
        '& > :last-child': { mb: 0 },
        '& p, & ul, & ol, & pre, & blockquote, & table': { my: 1.5 },
        '& ul, & ol': { pl: 3 },
        '& li + li': { mt: 0.5 },
        '& li > p': { my: 0.5 },
        '& strong': { fontWeight: 600 },
        '& code': {
          px: 0.5,
          py: '1px',
          borderRadius: '6px',
          bgcolor: 'var(--mui-palette-action-hover)',
          fontFamily: 'var(--raditi-font-mono, ui-monospace, monospace)',
          fontSize: '0.9em',
        },
        '& pre': {
          p: 1.5,
          borderRadius: '12px',
          overflowX: 'auto',
          bgcolor: 'var(--mui-palette-action-hover)',
          fontSize: 14,
          lineHeight: 1.55,
        },
        '& pre code': { p: 0, bgcolor: 'transparent', fontSize: 'inherit' },
        '& blockquote': {
          mx: 0,
          pl: 2,
          borderLeft: 3,
          borderColor: 'divider',
          color: 'text.secondary',
        },
        '& table': { borderCollapse: 'collapse', fontSize: 14 },
        '& th, & td': { border: 1, borderColor: 'divider', px: 1.25, py: 0.75, textAlign: 'left' },
        '& hr': { border: 0, borderTop: 1, borderColor: 'divider', my: 2 },
      }}
    >
      <Markdown
        remarkPlugins={[remarkGfm, remarkSoftBreaks]}
        components={components}
        urlTransform={linkUrl}
        skipHtml
      >
        {fenceTextTrees(text)}
      </Markdown>
    </Box>
  )
}
