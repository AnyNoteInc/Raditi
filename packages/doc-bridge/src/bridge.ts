import type {
  Definition,
  FootnoteDefinition,
  List,
  ListItem,
  Nodes,
  PhrasingContent,
  Root,
  RootContent,
  Table,
} from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { unified } from 'unified'

// The bridge between the Markdown of a section and the document of its editor (docs/plan/88-
// artifacts.md, §7.7; spike 4 of Э0а): remark — the same micromark and GFM that draw the section in
// @repo/doc-render — reads Markdown into mdast, and mdast becomes the JSON of the Tiptap editor;
// back, that JSON becomes mdast and one serializer with fixed options writes it. No `marked`, no
// `@tiptap/markdown`: on the spike's corpus that one changed the words of 15 documents of 30.
//
// The canonical form of a text is what the bridge gives back: `toMarkdown(toDocument(md))`. It is a
// fixed point — a second round changes nothing — and an edit in the editor changes only its line.

/** A node of the editor's document, as `editor.getJSON()` gives it and `setContent` takes it. */
export interface EditorNode {
  type: string
  attrs?: Record<string, unknown>
  content?: EditorNode[]
  marks?: EditorMark[]
  text?: string
}

export interface EditorMark {
  type: string
  attrs?: Record<string, unknown>
}

/** The document of the editor: its root. */
export interface EditorDocument extends EditorNode {
  type: 'doc'
  content: EditorNode[]
}

/** Options of mdast-util-to-markdown: everything not named here is the library default (§7.7). */
export const canonicalStringify = Object.freeze({
  bullet: '-',
  bulletOther: '*',
  bulletOrdered: '.',
  emphasis: '*',
  strong: '*',
  fence: '`',
  fences: true,
  rule: '-',
  ruleRepetition: 3,
  listItemIndent: 'one',
  incrementListMarker: true,
  setext: false,
  closeAtx: false,
  resourceLink: false,
  quote: '"',
} as const)

/** Options of remark-gfm (mdast-util-gfm-table): no padding of cells to align the pipes. */
export const canonicalGfm = Object.freeze({ tablePipeAlign: false, tableCellPadding: true })

const parser = unified().use(remarkParse).use(remarkGfm, canonicalGfm)
const writer = unified().use(remarkGfm, canonicalGfm).use(remarkStringify, canonicalStringify)

function parse(markdown: string): Root {
  return parser.runSync(parser.parse(markdown)) as Root
}

function stringify(tree: Root): string {
  return writer.stringify(tree)
}

type Definitions = Map<string, Definition>

// ———————————————————————————————————————— mdast → the editor

/** Markdown into the document of the editor. */
export function markdownToDocument(markdown: string): EditorDocument {
  const tree = parse(markdown)
  const definitions: Definitions = new Map()
  const walk = (node: Nodes) => {
    if (node.type === 'definition') {
      const id = node.identifier.toLowerCase()
      if (!definitions.has(id)) definitions.set(id, node)
    }
    if ('children' in node) for (const child of node.children) walk(child)
  }
  walk(tree)
  const content = blocks(tree.children, definitions)
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }
}

function blocks(nodes: readonly RootContent[], defs: Definitions): EditorNode[] {
  return nodes.flatMap((node) => block(node, defs))
}

const nonEmpty = (content: EditorNode[]): EditorNode[] =>
  content.length ? content : [{ type: 'paragraph' }]

function block(node: RootContent, defs: Definitions): EditorNode[] {
  switch (node.type) {
    case 'paragraph': {
      const content = inlines(node.children, [], defs)
      return content.length ? [{ type: 'paragraph', content }] : []
    }
    case 'heading':
      return [
        {
          type: 'heading',
          attrs: { level: node.depth },
          content: inlines(node.children, [], defs),
        },
      ]
    case 'thematicBreak':
      return [{ type: 'horizontalRule' }]
    case 'blockquote':
      return [{ type: 'blockquote', content: nonEmpty(blocks(node.children, defs)) }]
    case 'code':
      return [
        {
          type: 'codeBlock',
          attrs: { language: node.lang ?? null },
          content: node.value ? [{ type: 'text', text: node.value }] : [],
        },
      ]
    case 'list':
      return list(node, defs)
    case 'table':
      return [table(node, defs)]
    case 'footnoteDefinition':
      return [footnote(node, defs)]
    case 'html':
    case 'definition':
      return []
    default:
      // Anything else (frontmatter, math) the reader does not draw either: it is left out.
      return []
  }
}

function footnote(node: FootnoteDefinition, defs: Definitions): EditorNode {
  return {
    type: 'footnoteDefinition',
    attrs: { identifier: node.identifier, label: node.label ?? null },
    content: nonEmpty(blocks(node.children, defs)),
  }
}

function list(node: List, defs: Definitions): EditorNode[] {
  const task = node.children.map((item) => item.checked !== null && item.checked !== undefined)
  // A list of both kinds is split into runs of one kind.
  const runs: { task: boolean; items: ListItem[] }[] = []
  node.children.forEach((item, index) => {
    const last = runs.at(-1)
    if (last && last.task === task[index]) last.items.push(item)
    else runs.push({ task: task[index] ?? false, items: [item] })
  })
  let start = node.start ?? 1
  return runs.map((run) => {
    const items: EditorNode[] = run.items.map((item) => ({
      type: run.task ? 'taskItem' : 'listItem',
      attrs: run.task
        ? { checked: item.checked === true, spread: item.spread ?? false }
        : { spread: item.spread ?? false },
      content: itemContent(item, defs),
    }))
    const attrs = { spread: node.spread ?? false }
    let out: EditorNode
    if (run.task) out = { type: 'taskList', attrs, content: items }
    else if (node.ordered) out = { type: 'orderedList', attrs: { ...attrs, start }, content: items }
    else out = { type: 'bulletList', attrs, content: items }
    start += run.items.length
    return out
  })
}

/** An item of the editor is `paragraph block*`: one that starts otherwise gets an empty paragraph. */
function itemContent(item: ListItem, defs: Definitions): EditorNode[] {
  const content = blocks(item.children, defs)
  if (content[0]?.type !== 'paragraph') content.unshift({ type: 'paragraph' })
  return content
}

function table(node: Table, defs: Definitions): EditorNode {
  const align = node.align ?? []
  const width = node.children[0]?.children.length ?? 0
  return {
    type: 'table',
    content: node.children.map((row, r) => ({
      type: 'tableRow',
      content: Array.from({ length: width }, (_, c) => {
        const cell = row.children[c]
        // A line break inside a cell: Markdown holds one paragraph there, so it is a space.
        const content = inlines(cell?.children ?? [], [], defs).map((each) =>
          each.type === 'hardBreak'
            ? { type: 'text', text: ' ', ...(each.marks ? { marks: each.marks } : {}) }
            : each,
        )
        return {
          type: r === 0 ? 'tableHeader' : 'tableCell',
          attrs: { align: align[c] ?? null },
          content: [content.length ? { type: 'paragraph', content } : { type: 'paragraph' }],
        }
      }),
    })),
  }
}

const MARK: Record<string, string> = { emphasis: 'italic', strong: 'bold', delete: 'strike' }

function inlines(
  nodes: readonly PhrasingContent[],
  marks: EditorMark[],
  defs: Definitions,
): EditorNode[] {
  return nodes.flatMap((node) => inline(node, marks, defs))
}

const withMarks = (node: EditorNode, marks: EditorMark[]): EditorNode =>
  marks.length ? { ...node, marks } : node

const BREAK = /^<br\s*\/?>$/i

function inline(node: PhrasingContent, marks: EditorMark[], defs: Definitions): EditorNode[] {
  switch (node.type) {
    case 'text':
      return node.value ? [withMarks({ type: 'text', text: node.value }, marks)] : []
    case 'emphasis':
    case 'strong':
    case 'delete':
      return inlines(node.children, [...marks, { type: MARK[node.type]! }], defs)
    case 'inlineCode':
      // Code keeps the marks around it (a link, bold); it is the innermost leaf on the way out.
      return node.value
        ? [withMarks({ type: 'text', text: node.value }, [...marks, { type: 'code' }])]
        : []
    case 'link':
      return inlines(
        node.children,
        [...marks, { type: 'link', attrs: { href: node.url, title: node.title ?? null } }],
        defs,
      )
    case 'linkReference': {
      const def = defs.get(node.identifier.toLowerCase())
      if (!def) return [{ type: 'text', text: `[${node.label ?? node.identifier}]` }]
      return inlines(
        node.children,
        [...marks, { type: 'link', attrs: { href: def.url, title: def.title ?? null } }],
        defs,
      )
    }
    case 'image':
      return [
        withMarks(
          {
            type: 'image',
            attrs: { src: node.url, alt: node.alt ?? null, title: node.title ?? null },
          },
          marks,
        ),
      ]
    case 'imageReference': {
      const def = defs.get(node.identifier.toLowerCase())
      return def
        ? [
            withMarks(
              {
                type: 'image',
                attrs: { src: def.url, alt: node.alt ?? null, title: def.title ?? null },
              },
              marks,
            ),
          ]
        : [{ type: 'text', text: `![${node.alt ?? ''}]` }]
    }
    case 'break':
      return [withMarks({ type: 'hardBreak' }, marks)]
    case 'footnoteReference':
      return [
        {
          type: 'footnoteReference',
          attrs: { identifier: node.identifier, label: node.label ?? null },
        },
      ]
    case 'html':
      // The reader skips raw HTML; a line break the agent wrote as <br> stays a line break.
      return BREAK.test(node.value.trim()) ? [withMarks({ type: 'hardBreak' }, marks)] : []
    default:
      return []
  }
}

// ———————————————————————————————————————— the editor → mdast → Markdown

/** The document of the editor as Markdown in the canonical form. */
export function documentToMarkdown(doc: EditorNode): string {
  return stringify({ type: 'root', children: toBlocks(doc.content ?? []) } as Root)
}

/**
 * The canonical form of a text (§7.7): Markdown → the editor's document → Markdown, without an
 * editor. Whatever the editor saves comes back to it unchanged.
 */
export function canonicalMarkdown(markdown: string): string {
  return documentToMarkdown(markdownToDocument(markdown))
}

type Block = Record<string, unknown> & { type: string }
type Inline = Record<string, unknown> & { type: string; children?: Inline[]; value?: string }

function toBlocks(nodes: readonly EditorNode[]): Block[] {
  return nodes.flatMap(toBlock)
}

function toBlock(node: EditorNode): Block[] {
  const attrs = node.attrs ?? {}
  switch (node.type) {
    case 'paragraph': {
      const children = trimBreaks(phrasing(node.content ?? []))
      return children.length ? [{ type: 'paragraph', children }] : []
    }
    case 'heading':
      return [
        {
          type: 'heading',
          depth: (attrs.level as number | undefined) ?? 1,
          children: trimBreaks(phrasing(node.content ?? [])),
        },
      ]
    case 'horizontalRule':
      return [{ type: 'thematicBreak' }]
    case 'blockquote':
      return [{ type: 'blockquote', children: toBlocks(node.content ?? []) }]
    case 'codeBlock':
      return [
        {
          type: 'code',
          lang: (attrs.language as string | null | undefined) || null,
          meta: null,
          value: textOf(node),
        },
      ]
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      const ordered = node.type === 'orderedList'
      return [
        {
          type: 'list',
          ordered,
          start: ordered ? ((attrs.start as number | undefined) ?? 1) : null,
          spread: (attrs.spread as boolean | undefined) ?? false,
          children: (node.content ?? []).map(toItem),
        },
      ]
    }
    case 'table':
      return [toTable(node)]
    case 'image':
      return [{ type: 'paragraph', children: phrasing([node]) }]
    case 'footnoteDefinition':
      return [
        {
          type: 'footnoteDefinition',
          identifier: attrs.identifier,
          label: (attrs.label as string | null | undefined) ?? undefined,
          children: toBlocks(node.content ?? []),
        },
      ]
    default:
      return []
  }
}

/** A break at the end of a paragraph is no line break in Markdown: the reader would see a backslash. */
function trimBreaks(children: Inline[]): Inline[] {
  const out = [...children]
  while (out.length) {
    const last = out.at(-1)!
    if (last.type === 'break') out.pop()
    else if (
      last.type === 'text' &&
      /^\s*$/.test(last.value ?? '') &&
      out.length > 1 &&
      out.at(-2)!.type === 'break'
    )
      out.splice(-2, 2)
    else if (last.children) {
      last.children = trimBreaks(last.children)
      if (!last.children.length) out.pop()
      else break
    } else break
  }
  return out
}

function toItem(item: EditorNode): Block {
  const attrs = item.attrs ?? {}
  const children = toBlocks(item.content ?? [])
  const paragraphs = children.some(
    (child, index) =>
      index > 0 && child.type === 'paragraph' && children[index - 1]!.type === 'paragraph',
  )
  return {
    type: 'listItem',
    spread: ((attrs.spread as boolean | undefined) ?? false) || paragraphs,
    checked: item.type === 'taskItem' ? attrs.checked === true : null,
    children,
  }
}

function toTable(node: EditorNode): Block {
  const rows = node.content ?? []
  const align = (rows[0]?.content ?? []).map((cell) => cell.attrs?.align ?? null)
  return {
    type: 'table',
    align,
    children: rows.map((row) => ({
      type: 'tableRow',
      children: (row.content ?? []).map((cell) => ({
        type: 'tableCell',
        // A cell holds one paragraph in Markdown; several blocks are joined by a space.
        children: (cell.content ?? []).flatMap((each, index) => {
          const inner: Inline[] =
            each.type === 'paragraph' || each.type === 'heading'
              ? phrasing(each.content ?? [])
              : [{ type: 'text', value: textOf(each).replace(/\n/g, ' ') }]
          return index === 0 ? inner : [{ type: 'text', value: ' ' }, ...inner]
        }),
      })),
    })),
  }
}

function textOf(node: EditorNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  const content = node.content ?? []
  const inline = content.every((child) => child.type === 'text' || child.type === 'hardBreak')
  return content.map(textOf).join(inline ? '' : ' ')
}

// Marks from the outside in: CommonMark reads ***x*** as emphasis around strong, and agents write
// **[x](u)** more often than [**x**](u). Code is a leaf (inlineCode), so it is the innermost.
const ORDER = ['italic', 'bold', 'strike', 'link'] as const
const WRAP: Record<string, string> = { bold: 'strong', italic: 'emphasis', strike: 'delete' }

const sameMark = (a: EditorMark, b: EditorMark) =>
  a.type === b.type &&
  (a.type !== 'link' ||
    (a.attrs?.href === b.attrs?.href && (a.attrs?.title ?? null) === (b.attrs?.title ?? null)))

interface Item {
  type: string
  text?: string
  attrs?: Record<string, unknown>
  marks: EditorMark[]
}

function phrasing(nodes: readonly EditorNode[]): Inline[] {
  // Neighbouring text with the same marks is one text first.
  const items: Item[] = []
  for (const node of nodes) {
    const last = items.at(-1)
    const marks = node.marks ?? []
    if (
      node.type === 'text' &&
      last?.type === 'text' &&
      last.marks.length === marks.length &&
      last.marks.every((mark, index) => sameMark(mark, marks[index]!))
    )
      last.text = (last.text ?? '') + (node.text ?? '')
    else
      items.push({
        type: node.type,
        ...(node.text !== undefined ? { text: node.text } : {}),
        ...(node.attrs ? { attrs: node.attrs } : {}),
        marks: [...marks],
      })
  }
  return group(items)
}

function group(items: Item[]): Inline[] {
  const out: Inline[] = []
  let i = 0
  while (i < items.length) {
    const item = items[i]!
    const type = ORDER.find((each) => item.marks.some((mark) => mark.type === each))
    if (!type) {
      out.push(...leaf(item))
      i += 1
      continue
    }
    const mark = item.marks.find((each) => each.type === type)!
    let j = i
    while (j < items.length && items[j]!.marks.some((each) => sameMark(each, mark))) j += 1
    const inner = items
      .slice(i, j)
      .map((each) => ({ ...each, marks: each.marks.filter((other) => !sameMark(other, mark)) }))
    out.push(...wrap(type, mark, group(inner)))
    i = j
  }
  return out
}

function leaf(item: Item): Inline[] {
  if (item.type === 'text') {
    if (item.marks.some((mark) => mark.type === 'code'))
      return [{ type: 'inlineCode', value: item.text ?? '' }]
    return item.text ? [{ type: 'text', value: item.text }] : []
  }
  if (item.type === 'hardBreak') return [{ type: 'break' }]
  if (item.type === 'image')
    return [
      {
        type: 'image',
        url: (item.attrs?.src as string | undefined) ?? '',
        alt: (item.attrs?.alt as string | null | undefined) ?? null,
        title: (item.attrs?.title as string | null | undefined) ?? null,
      },
    ]
  if (item.type === 'footnoteReference')
    return [
      {
        type: 'footnoteReference',
        identifier: item.attrs?.identifier,
        label: (item.attrs?.label as string | null | undefined) ?? undefined,
      },
    ]
  return []
}

/** Whitespace at the edges of emphasis goes outside it: «**Цена: **1» would not close. */
function wrap(type: (typeof ORDER)[number], mark: EditorMark, children: Inline[]): Inline[] {
  if (type === 'link')
    return [
      {
        type: 'link',
        url: (mark.attrs?.href as string | undefined) ?? '',
        title: (mark.attrs?.title as string | null | undefined) ?? null,
        children,
      },
    ]
  const before: Inline[] = []
  const after: Inline[] = []
  const first = children[0]
  if (first?.type === 'text') {
    const match = /^\s+/.exec(first.value ?? '')
    if (match) {
      before.push({ type: 'text', value: match[0] })
      first.value = (first.value ?? '').slice(match[0].length)
    }
  }
  const last = children.at(-1)
  if (last?.type === 'text') {
    const match = /\s+$/.exec(last.value ?? '')
    if (match) {
      after.unshift({ type: 'text', value: match[0] })
      last.value = (last.value ?? '').slice(0, -match[0].length)
    }
  }
  const inner = children.filter((child) => child.type !== 'text' || child.value)
  if (!inner.length) return [...before, ...after]
  return [...before, { type: WRAP[type]!, children: inner }, ...after]
}
