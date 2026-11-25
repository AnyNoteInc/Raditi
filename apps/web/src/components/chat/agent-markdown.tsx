'use client'

import Box from '@mui/material/Box'
import MuiLink from '@mui/material/Link'
import { diagramEngineOf, messageDiagrams, type MessageDiagram } from '@repo/domain/artifacts'
import { createContext, isValidElement, useContext, useMemo, type ReactNode } from 'react'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import graphql from 'highlight.js/lib/languages/graphql'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import less from 'highlight.js/lib/languages/less'
import markdown from 'highlight.js/lib/languages/markdown'
import nginx from 'highlight.js/lib/languages/nginx'
import php from 'highlight.js/lib/languages/php'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scss from 'highlight.js/lib/languages/scss'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import Markdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

import { ChatDiagram } from './chat-diagram'
import { CodeBlock } from './code-block'

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
export interface AnswerPlace {
  taskId: string
  /** `task_events.id` of the answer. */
  row: string
}

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
    const body = text.replace(/\n$/, '').trimEnd()
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

/**
 * The languages a block of code is coloured in (docs/plan/76-agent-instructions.md, И5; plan 91,
 * Д6): what a site of a small business is made of, the shell, and the languages of a repository of
 * a developer. A block names its language (```php); a block of no name or of another language stays
 * plain — nothing is guessed.
 */
const LANGUAGES = {
  bash,
  shell: bash,
  sh: bash,
  zsh: bash,
  powershell,
  ps1: powershell,
  css,
  scss,
  less,
  javascript,
  js: javascript,
  jsx: javascript,
  json,
  php,
  python,
  py: python,
  sql,
  typescript,
  ts: typescript,
  tsx: typescript,
  html: xml,
  xml,
  svg: xml,
  yaml,
  yml: yaml,
  ini,
  toml: ini,
  go,
  java,
  kotlin,
  kt: kotlin,
  c,
  cpp,
  csharp,
  cs: csharp,
  rust,
  rs: rust,
  ruby,
  rb: ruby,
  swift,
  diff,
  patch: diff,
  dockerfile,
  docker: dockerfile,
  nginx,
  markdown,
  md: markdown,
  graphql,
}
const highlight: [typeof rehypeHighlight, Parameters<typeof rehypeHighlight>[0]] = [
  rehypeHighlight,
  { languages: LANGUAGES, detect: false, plainText: ['text', 'txt', 'plain'] },
]

/** The colours of the tokens: of the palette of the scheme, so both schemes keep their contrast. */
const TOKENS = {
  '& .hljs-keyword, & .hljs-selector-tag, & .hljs-built_in, & .hljs-meta': {
    color: 'var(--mui-palette-primary-main)',
  },
  '& .hljs-string, & .hljs-attr, & .hljs-template-variable': {
    color: 'var(--mui-palette-success-main)',
  },
  '& .hljs-number, & .hljs-literal, & .hljs-variable, & .hljs-symbol': {
    color: 'var(--mui-palette-warning-main)',
  },
  '& .hljs-title, & .hljs-name, & .hljs-selector-class, & .hljs-selector-id': {
    color: 'var(--mui-palette-secondary-main)',
  },
  '& .hljs-comment, & .hljs-quote': {
    color: 'var(--mui-palette-text-secondary)',
    fontStyle: 'italic',
  },
  '& .hljs-deletion': { color: 'var(--mui-palette-error-main)' },
} as const

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
            ...TOKENS,
          },
          // The head of a block (plan 91, Д6) carries its frame: the code under it has none.
          '& [data-code-block] > pre': { m: 0, borderRadius: 0, bgcolor: 'transparent' },
          '& pre code': { p: 0, bgcolor: 'transparent', fontSize: 'inherit' },
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
