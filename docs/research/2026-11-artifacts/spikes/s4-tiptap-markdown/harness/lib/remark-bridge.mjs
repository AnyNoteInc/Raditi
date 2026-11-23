// The alternative bridge: Markdown ↔ the editor's document through mdast, with the same remark
// that canonicalizes on the server and draws in @repo/doc-render. No marked, no second parser.
//   mdToPm: remark-parse + remark-gfm → mdast → Tiptap JSON (schema of the «bridge» set);
//   pmToMd: Tiptap JSON → mdast → remark-stringify with the canonical options.
import { parse, stringify } from './canon.mjs'

// ---------- mdast → Tiptap JSON ----------

export function mdToPm(markdown) {
  const tree = parse(markdown)
  const definitions = new Map()
  const walk = (node) => {
    if (node.type === 'definition') {
      const id = node.identifier.toLowerCase()
      if (!definitions.has(id)) definitions.set(id, node)
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  const content = blocks(tree.children, definitions)
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }
}

function blocks(nodes, defs) {
  return nodes.flatMap((node) => block(node, defs))
}

function nonEmpty(content) {
  return content.length ? content : [{ type: 'paragraph' }]
}

function block(node, defs) {
  switch (node.type) {
    case 'paragraph': {
      const content = inlines(node.children, [], defs)
      return content.length ? [{ type: 'paragraph', content }] : []
    }
    case 'heading':
      return [{ type: 'heading', attrs: { level: node.depth }, content: inlines(node.children, [], defs) }]
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
      return [
        {
          type: 'footnoteDefinition',
          attrs: { identifier: node.identifier, label: node.label ?? null },
          content: nonEmpty(blocks(node.children, defs)),
        },
      ]
    case 'html':
    case 'definition':
      return []
    default:
      throw new Error(`mdToPm: block ${node.type}`)
  }
}

function list(node, defs) {
  const task = node.children.map((item) => item.checked !== null && item.checked !== undefined)
  // A list of both kinds is split into runs of one kind (the «fixed» canonical form already did).
  const runs = []
  for (const [i, item] of node.children.entries()) {
    const last = runs.at(-1)
    if (last && last.task === task[i]) last.items.push(item)
    else runs.push({ task: task[i], items: [item] })
  }
  let start = node.start ?? 1
  return runs.map((run) => {
    const items = run.items.map((item) => ({
      type: run.task ? 'taskItem' : 'listItem',
      attrs: run.task ? { checked: item.checked === true, spread: item.spread ?? false } : { spread: item.spread ?? false },
      content: itemContent(item, defs),
    }))
    const attrs = { spread: node.spread ?? false }
    let out
    if (run.task) out = { type: 'taskList', attrs, content: items }
    else if (node.ordered) out = { type: 'orderedList', attrs: { ...attrs, start }, content: items }
    else out = { type: 'bulletList', attrs, content: items }
    start += run.items.length
    return out
  })
}

/** Tiptap's list item is `paragraph block*`: an item that starts otherwise gets an empty paragraph. */
function itemContent(item, defs) {
  const content = blocks(item.children, defs)
  if (content[0]?.type !== 'paragraph') content.unshift({ type: 'paragraph' })
  return content
}

function table(node, defs) {
  const align = node.align ?? []
  const width = node.children[0]?.children.length ?? 0
  return {
    type: 'table',
    content: node.children.map((row, r) => ({
      type: 'tableRow',
      content: Array.from({ length: width }, (_, c) => row.children[c] ?? { type: 'tableCell', children: [] }).map((cell, c) => {
        const content = inlines(cell.children, [], defs).map((n) => (n.type === 'hardBreak' ? { type: 'text', text: ' ', ...(n.marks ? { marks: n.marks } : {}) } : n))
        return {
          type: r === 0 ? 'tableHeader' : 'tableCell',
          attrs: { align: align[c] ?? null },
          content: [content.length ? { type: 'paragraph', content } : { type: 'paragraph' }],
        }
      }),
    })),
  }
}

const MARK = { emphasis: 'italic', strong: 'bold', delete: 'strike' }

function inlines(nodes, marks, defs) {
  return nodes.flatMap((node) => inline(node, marks, defs))
}

const withMarks = (node, marks) => (marks.length ? { ...node, marks } : node)

function inline(node, marks, defs) {
  switch (node.type) {
    case 'text':
      return node.value ? [withMarks({ type: 'text', text: node.value }, marks)] : []
    case 'emphasis':
    case 'strong':
    case 'delete':
      return inlines(node.children, [...marks, { type: MARK[node.type] }], defs)
    case 'inlineCode':
      // Code keeps the marks around it (a link, bold): Markdown holds them as `[`x`](u)`, and the
      // editor's document accepts them from JSON, as @tiptap/markdown's own path does (Tiptap's
      // code mark says `excludes: '_'` only for toggling). Code is the innermost leaf on the way out.
      return node.value ? [withMarks({ type: 'text', text: node.value }, [...marks, { type: 'code' }])] : []
    case 'link':
      return inlines(node.children, [...marks, { type: 'link', attrs: { href: node.url, title: node.title ?? null } }], defs)
    case 'linkReference': {
      const def = defs.get(node.identifier.toLowerCase())
      if (!def) return [{ type: 'text', text: `[${node.label ?? node.identifier}]` }]
      return inlines(node.children, [...marks, { type: 'link', attrs: { href: def.url, title: def.title ?? null } }], defs)
    }
    case 'image':
      return [withMarks({ type: 'image', attrs: { src: node.url, alt: node.alt ?? null, title: node.title ?? null } }, marks)]
    case 'imageReference': {
      const def = defs.get(node.identifier.toLowerCase())
      return def
        ? [withMarks({ type: 'image', attrs: { src: def.url, alt: node.alt ?? null, title: def.title ?? null } }, marks)]
        : [{ type: 'text', text: `![${node.alt ?? ''}]` }]
    }
    case 'break':
      return [withMarks({ type: 'hardBreak' }, marks)]
    case 'footnoteReference':
      return [{ type: 'footnoteReference', attrs: { identifier: node.identifier, label: node.label ?? null } }]
    case 'html':
      // doc-render skips raw HTML; a line break the agent wrote as <br> stays a line break.
      return /^<br\s*\/?>$/i.test(node.value.trim()) ? [withMarks({ type: 'hardBreak' }, marks)] : []
    default:
      throw new Error(`mdToPm: inline ${node.type}`)
  }
}

// ---------- Tiptap JSON → mdast → Markdown ----------

export function pmToMd(doc) {
  return stringify(pmToMdast(doc))
}

/**
 * The canonical form of the bridge: Markdown → the editor's document → Markdown, without an
 * editor. Whatever the editor saves comes back to it unchanged (the corpus checks it).
 */
export function canonBridge(markdown) {
  return pmToMd(mdToPm(markdown))
}

export function pmToMdast(doc) {
  return { type: 'root', children: toBlocks(doc.content ?? []) }
}

function toBlocks(nodes) {
  return nodes.flatMap(toBlock)
}

function toBlock(node) {
  const attrs = node.attrs ?? {}
  switch (node.type) {
    case 'paragraph': {
      const children = trimBreaks(phrasing(node.content ?? []))
      return children.length ? [{ type: 'paragraph', children }] : []
    }
    case 'heading':
      return [{ type: 'heading', depth: attrs.level ?? 1, children: trimBreaks(phrasing(node.content ?? [])) }]
    case 'horizontalRule':
      return [{ type: 'thematicBreak' }]
    case 'blockquote':
      return [{ type: 'blockquote', children: toBlocks(node.content ?? []) }]
    case 'codeBlock':
      return [{ type: 'code', lang: attrs.language || null, meta: null, value: textOf(node) }]
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      const ordered = node.type === 'orderedList'
      return [
        {
          type: 'list',
          ordered,
          start: ordered ? (attrs.start ?? 1) : null,
          spread: attrs.spread ?? false,
          children: (node.content ?? []).map((item) => toItem(item)),
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
          label: attrs.label ?? undefined,
          children: toBlocks(node.content ?? []),
        },
      ]
    default:
      throw new Error(`pmToMd: block ${node.type}`)
  }
}

/** A break at the end of a paragraph is no line break in Markdown: the reader would see a backslash. */
function trimBreaks(children) {
  const out = [...children]
  while (out.length) {
    const last = out.at(-1)
    if (last.type === 'break') out.pop()
    else if (last.type === 'text' && /^\s*$/.test(last.value) && out.length > 1 && out.at(-2).type === 'break') out.splice(-2, 2)
    else if (last.children) {
      last.children = trimBreaks(last.children)
      if (!last.children.length) out.pop()
      else break
    } else break
  }
  return out
}

function toItem(item) {
  const attrs = item.attrs ?? {}
  const children = toBlocks(item.content ?? [])
  const paragraphs = children.some((c, i) => i > 0 && c.type === 'paragraph' && children[i - 1].type === 'paragraph')
  return {
    type: 'listItem',
    spread: (attrs.spread ?? false) || paragraphs,
    checked: item.type === 'taskItem' ? attrs.checked === true : null,
    children,
  }
}

function toTable(node) {
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
        children: (cell.content ?? []).flatMap((block, i) => {
          const inner = block.type === 'paragraph' || block.type === 'heading' ? phrasing(block.content ?? []) : [{ type: 'text', value: cellText(block) }]
          return i === 0 ? inner : [{ type: 'text', value: ' ' }, ...inner]
        }),
      })),
    })),
  }
}

function textOf(node) {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  const inline = (node.content ?? []).every((child) => child.type === 'text' || child.type === 'hardBreak')
  return (node.content ?? []).map(textOf).join(inline ? '' : ' ')
}

function cellText(node) {
  return textOf(node).replace(/\n/g, ' ')
}

// Marks from the outside in: CommonMark reads ***x*** as emphasis around strong, and agents write
// **[x](u)** more often than [**x**](u). Code is a leaf (inlineCode), so it is the innermost.
const ORDER = ['italic', 'bold', 'strike', 'link']
const WRAP = { bold: 'strong', italic: 'emphasis', strike: 'delete' }

const sameMark = (a, b) =>
  a.type === b.type && (a.type !== 'link' || (a.attrs?.href === b.attrs?.href && (a.attrs?.title ?? null) === (b.attrs?.title ?? null)))

function phrasing(nodes) {
  // Merge neighbouring text nodes with the same marks first.
  const items = []
  for (const node of nodes) {
    const last = items.at(-1)
    const marks = node.marks ?? []
    if (
      node.type === 'text' &&
      last?.type === 'text' &&
      last.marks.length === marks.length &&
      last.marks.every((m, i) => sameMark(m, marks[i]))
    )
      last.text += node.text
    else items.push({ ...node, marks: [...marks] })
  }
  return group(items)
}

function group(items) {
  const out = []
  let i = 0
  while (i < items.length) {
    const item = items[i]
    const type = ORDER.find((t) => item.marks.some((m) => m.type === t))
    if (!type) {
      out.push(...leaf(item))
      i += 1
      continue
    }
    const mark = item.marks.find((m) => m.type === type)
    let j = i
    while (j < items.length && items[j].marks.some((m) => sameMark(m, mark))) j += 1
    const inner = items.slice(i, j).map((it) => ({ ...it, marks: it.marks.filter((m) => !sameMark(m, mark)) }))
    const children = group(inner)
    out.push(...wrap(type, mark, children))
    i = j
  }
  return out
}

function leaf(item) {
  if (item.type === 'text') {
    if (item.marks.some((m) => m.type === 'code')) return [{ type: 'inlineCode', value: item.text }]
    return item.text ? [{ type: 'text', value: item.text }] : []
  }
  if (item.type === 'hardBreak') return [{ type: 'break' }]
  if (item.type === 'image')
    return [{ type: 'image', url: item.attrs?.src ?? '', alt: item.attrs?.alt ?? null, title: item.attrs?.title ?? null }]
  if (item.type === 'footnoteReference')
    return [{ type: 'footnoteReference', identifier: item.attrs?.identifier, label: item.attrs?.label ?? undefined }]
  throw new Error(`pmToMd: inline ${item.type}`)
}

/** Whitespace at the edges of emphasis goes outside it: «**Цена: **1» would not close. */
function wrap(type, mark, children) {
  if (type === 'link') return [{ type: 'link', url: mark.attrs?.href ?? '', title: mark.attrs?.title ?? null, children }]
  const before = []
  const after = []
  const first = children[0]
  if (first?.type === 'text') {
    const m = /^\s+/.exec(first.value)
    if (m) {
      before.push({ type: 'text', value: m[0] })
      first.value = first.value.slice(m[0].length)
    }
  }
  const last = children.at(-1)
  if (last?.type === 'text') {
    const m = /\s+$/.exec(last.value)
    if (m) {
      after.unshift({ type: 'text', value: m[0] })
      last.value = last.value.slice(0, -m[0].length)
    }
  }
  const inner = children.filter((c) => c.type !== 'text' || c.value)
  if (!inner.length) return [...before, ...after]
  return [...before, { type: WRAP[type], children: inner }, ...after]
}
