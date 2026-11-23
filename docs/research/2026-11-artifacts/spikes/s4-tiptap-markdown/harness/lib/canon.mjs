// The canonical Markdown of a block: one remark (micromark + GFM, as @repo/doc-render draws it)
// and one serializer with fixed options. Profiles:
//   plan   — the options §7.7 of plan 88 names: bullet "-", tables without pipe padding;
//   fixed  — the same options and a few tree rules, so that the editor can hold everything the
//            canonical text says;
//   bridge — `canonBridge` in remark-bridge.mjs: Markdown → the editor's document → Markdown,
//            the fixed rules plus the order of marks the editor keeps (the recommended one).
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import { visit, SKIP } from 'unist-util-visit'

/** Options of mdast-util-to-markdown; everything not named here is the library default. */
export const STRINGIFY = Object.freeze({
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
})

/** Options of remark-gfm (mdast-util-gfm-table): no padding of cells to align the pipes. */
export const GFM = Object.freeze({ tablePipeAlign: false, tableCellPadding: true })

const parser = unified().use(remarkParse).use(remarkGfm, GFM)

export function parse(markdown) {
  return parser.runSync(parser.parse(markdown))
}

export function stringify(tree) {
  return unified().use(remarkGfm, GFM).use(remarkStringify, STRINGIFY).stringify(tree)
}

/** The plan's canonical form: parse and serialize, nothing else. */
export function canonPlan(markdown) {
  return stringify(parse(markdown))
}

/**
 * Tree rules of the «fixed» profile. Each one keeps what the reader of @repo/doc-render sees and
 * removes a form the editor cannot hold:
 * - raw HTML goes (doc-render skips it: `skipHtml`), the text between tags stays; a `<br>` is a
 *   hard break, inside a table cell a space (doc-render today glues the words around it);
 * - reference links and images become inline ones, definitions go (the reader sees the same link);
 * - a list that mixes task items and plain items is split into lists of one kind;
 * - the meta of a code fence goes (doc-render never shows it);
 * - an empty paragraph (only white space) goes.
 * Footnotes, loose lists and table alignment stay: the bridge that needs them must hold them.
 */
export function rulesFixed() {
  return (tree) => {
    const definitions = new Map()
    visit(tree, 'definition', (node) => {
      const id = node.identifier.toLowerCase()
      if (!definitions.has(id)) definitions.set(id, node)
    })
    // A line break the agent wrote as <br>: a space inside a table cell, a hard break elsewhere.
    visit(tree, 'tableCell', (cell) => {
      visit(cell, 'html', (node, index, parent) => {
        if (parent && index !== undefined && isBr(node)) parent.children[index] = { type: 'text', value: ' ' }
      })
    })
    visit(tree, (node, index, parent) => {
      if (!parent || index === undefined) return
      if (node.type === 'html' && isBr(node)) {
        parent.children[index] = { type: 'break' }
        return [SKIP, index + 1]
      }
      if (node.type === 'html') {
        parent.children.splice(index, 1)
        return [SKIP, index]
      }
      if (node.type === 'definition') {
        parent.children.splice(index, 1)
        return [SKIP, index]
      }
      if (node.type === 'linkReference') {
        const definition = definitions.get(node.identifier.toLowerCase())
        if (definition) {
          parent.children[index] = {
            type: 'link',
            url: definition.url,
            title: definition.title ?? null,
            children: node.children,
          }
        } else {
          // An unresolved reference is its own words, brackets and all.
          parent.children.splice(index, 1, ...referenceWords(node))
        }
        return [SKIP, index]
      }
      if (node.type === 'imageReference') {
        const definition = definitions.get(node.identifier.toLowerCase())
        if (definition)
          parent.children[index] = {
            type: 'image',
            url: definition.url,
            title: definition.title ?? null,
            alt: node.alt,
          }
        return [SKIP, index]
      }
      if (node.type === 'code' && node.meta) node.meta = null
      if (node.type === 'paragraph' && isBlank(node)) {
        parent.children.splice(index, 1)
        return [SKIP, index]
      }
      if (node.type === 'list') splitMixedList(node, index, parent)
    })
    // A break the <br> rule left at the end of a paragraph or heading means nothing: it goes.
    visit(tree, (node) => {
      if (node.type !== 'paragraph' && node.type !== 'heading') return
      while (node.children.at(-1)?.type === 'break') node.children.pop()
    })
  }
}

function referenceWords(node) {
  const label = node.label ?? node.identifier
  if (node.referenceType === 'shortcut') return [{ type: 'text', value: '[' }, ...node.children, { type: 'text', value: ']' }]
  if (node.referenceType === 'collapsed') return [{ type: 'text', value: '[' }, ...node.children, { type: 'text', value: '][]' }]
  return [{ type: 'text', value: '[' }, ...node.children, { type: 'text', value: `][${label}]` }]
}

function isBr(node) {
  return /^<br\s*\/?>$/i.test(node.value.trim())
}

function isBlank(paragraph) {
  // JavaScript's \s takes in U+00A0 and U+202F: a paragraph of no-break spaces is empty too.
  return paragraph.children.every((child) => child.type === 'text' && /^\s*$/.test(child.value))
}

function splitMixedList(list, index, parent) {
  const tasks = list.children.map((item) => item.checked !== null && item.checked !== undefined)
  if (tasks.every(Boolean) || !tasks.some(Boolean)) return
  const groups = []
  for (const [i, item] of list.children.entries()) {
    const last = groups.at(-1)
    if (last && last.task === tasks[i]) last.items.push(item)
    else groups.push({ task: tasks[i], items: [item] })
  }
  let start = list.start ?? 1
  const lists = groups.map((group) => {
    const piece = { ...list, children: group.items, start: list.ordered ? start : list.start }
    start += group.items.length
    return piece
  })
  parent.children.splice(index, 1, ...lists)
}

const fixer = unified().use(remarkParse).use(remarkGfm, GFM).use(rulesFixed)

export function canonFixed(markdown) {
  return stringify(fixer.runSync(fixer.parse(markdown)))
}

export const profiles = { plan: canonPlan, fixed: canonFixed }
