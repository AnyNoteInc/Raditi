'use client'

import Box from '@mui/material/Box'
import MuiLink from '@mui/material/Link'
import type { ChatDiagramJob } from '@repo/domain'
import { diagramEngineOf, messageDiagrams, type MessageDiagram } from '@repo/domain/artifacts'
import { createContext, isValidElement, useContext, useMemo, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

import { ChatDiagram } from './chat-diagram'
import { CodeBlock } from './code-block'
import { highlightLanguages } from './code-languages'

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

/** Where the answer stands in the chat: its diagrams are drawn by the server (plan 91, Д4). */
export type AnswerPlace = Omit<ChatDiagramJob, 'index'>

const DiagramsContext = createContext<{ place: AnswerPlace; diagrams: MessageDiagram[] } | null>(
  null,
)

/** The props of the `<code>` inside a `<pre>`, as Markdown made it. */
function codeOf(children: ReactNode): { language: string; content: ReactNode } {
  const code = Array.isArray(children) ? children[0] : children
  if (!isValidElement<{ className?: string; children?: ReactNode }>(code))
    return { language: '', content: children }
  const language = /(?:^|\s)language-(\S+)/.exec(code.props.className ?? '')?.[1] ?? ''
  return { language, content: code }
}

/**
 * A block of code (plan 91, Д1, Д6): a diagram of Mermaid or PlantUML is a picture the server draws
 * when the answer has its place in the chat; other code has a head with its language and «Скопировать
 * код».
 */
function Pre({ children }: { children?: ReactNode }) {
  const answer = useContext(DiagramsContext)
  const { language, content } = codeOf(children)
  const text = wordsOf(children)
  const engine = diagramEngineOf(language)
  if (engine && answer) {
    const body = text.trimEnd()
    const index = answer.diagrams.findIndex(
      (diagram) => diagram.engine === engine && diagram.source.trimEnd() === body,
    )
    if (index >= 0)
      return <ChatDiagram place={{ ...answer.place, index }} language={language} text={text} />
  }
  return (
    <CodeBlock language={language} text={text}>
      {content}
    </CodeBlock>
  )
}

const components: Components = {
  pre: Pre,
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

const highlight: [typeof rehypeHighlight, Parameters<typeof rehypeHighlight>[0]] = [
  rehypeHighlight,
  { languages: highlightLanguages, detect: false, plainText: ['text', 'txt', 'plain'] },
]

export function AgentMarkdown({ text, place }: { text: string; place?: AnswerPlace }) {
  const taskId = place?.taskId
  const row = place?.row
  const answer = useMemo(
    () => (taskId && row ? { place: { taskId, row }, diagrams: messageDiagrams(text) } : null),
    [taskId, row, text],
  )
  return (
    <DiagramsContext.Provider value={answer}>
      <Box
        sx={{
          fontSize: 16,
          lineHeight: 1.65,
          overflowWrap: 'anywhere',
          minWidth: 0,
          '& > :first-of-type': { mt: 0 },
          '& > :last-child': { mb: 0 },
          '& p, & ul, & ol, & blockquote, & table': { my: 1.5 },
          '& ul, & ol': { pl: 3 },
          '& li + li': { mt: 0.5 },
          '& li > p': { my: 0.5 },
          '& strong': { fontWeight: 600 },
          // Code inside a sentence; a block of code is `CodeBlock`'s.
          '& :not(pre) > code': {
            px: 0.5,
            py: '1px',
            borderRadius: '6px',
            bgcolor: 'var(--mui-palette-action-hover)',
            fontFamily: 'var(--raditi-font-mono, ui-monospace, monospace)',
            fontSize: '0.9em',
          },

          '& blockquote': {
            mx: 0,
            pl: 2,
            borderLeft: 3,
            borderColor: 'divider',
            color: 'text.secondary',
          },
          '& table': { borderCollapse: 'collapse', fontSize: 14 },
          '& th, & td': {
            border: 1,
            borderColor: 'divider',
            px: 1.25,
            py: 0.75,
            textAlign: 'left',
            verticalAlign: 'top',
          },
          '& th': { bgcolor: 'var(--mui-palette-action-hover)', fontWeight: 600 },
          // GFM alignment comes as an inline `text-align`: a right column is numbers.
          '& td[style*="right"], & th[style*="right"]': {
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
          },
          '& hr': { border: 0, borderTop: 1, borderColor: 'divider', my: 2 },
        }}
      >
        <Markdown
          remarkPlugins={[remarkGfm, remarkSoftBreaks]}
          rehypePlugins={[highlight]}
          components={components}
          urlTransform={linkUrl}
          skipHtml
        >
          {fenceTextTrees(text)}
        </Markdown>
      </Box>
    </DiagramsContext.Provider>
  )
}
