// What the reader sees. @repo/doc-render draws Markdown with remark-gfm and `skipHtml`
// (packages/doc-render/src/document-markdown.ts); remark-rehype without `allowDangerousHtml`
// drops raw HTML the same way. «Visible text» is hast-util-to-text (the innerText algorithm) of
// that tree; «rendered» is its HTML.
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import { toText } from 'hast-util-to-text'
import { toHtml } from 'hast-util-to-html'
import { visit } from 'unist-util-visit'
import { diffWordsWithSpace, diffLines } from 'diff'

const pipeline = unified().use(remarkParse).use(remarkGfm).use(remarkRehype)

function hastOf(markdown) {
  const tree = pipeline.runSync(pipeline.parse(markdown))
  visit(tree, (node) => {
    delete node.position
  })
  return tree
}

export function visibleText(markdown) {
  return toText(hastOf(markdown))
    .replace(/[ \t\n\r\f]+/g, ' ')
    .trim()
}

/**
 * The words a quote of the agent is matched by: the visible text without footnote calls, and a
 * footnote's text in place of its definition — what a person reads as the text of the block.
 */
export function quoteText(markdown) {
  const tree = pipeline.parse(markdown)
  visit(tree, (node, index, parent) => {
    if (!parent || index === undefined) return
    if (node.type === 'footnoteReference') {
      parent.children.splice(index, 1)
      return index
    }
    if (node.type === 'footnoteDefinition') {
      parent.children.splice(index, 1, ...node.children)
      return index
    }
  })
  return toText(pipeline.runSync(tree))
    .replace(/[ \t\n\r\f]+/g, ' ')
    .trim()
}

/** Rendered HTML, with the newlines remark-rehype puts between blocks taken out. */
export function rendered(markdown) {
  const tree = hastOf(markdown)
  visit(tree, 'text', (node, index, parent) => {
    if (parent && parent.type !== 'element') return
    if (parent && ['pre', 'code'].includes(parent.tagName)) return
    if (/^\n+$/.test(node.value) && parent) node.value = ''
  })
  return toHtml(tree)
}

/**
 * The class of a difference between two canonical texts:
 * same — byte for byte;
 * cosmetic — the reader sees the same HTML;
 * format — the same visible words, but other HTML (a heading became a paragraph, a list lost its
 *          spacing, a link lost its address…);
 * words — the visible words changed (something lost, added or altered).
 */
export function classify(a, c) {
  if (a === c) return 'same'
  if (rendered(a) === rendered(c)) return 'cosmetic'
  if (visibleText(a) === visibleText(c)) return 'format'
  return 'words'
}

export const severity = { same: 0, cosmetic: 1, format: 2, words: 3, crash: 4 }

/** A short line diff for the report: only changed lines, each side up to `limit` lines. */
export function lineDiff(a, c, limit = 12) {
  const out = []
  for (const part of diffLines(a, c)) {
    if (!part.added && !part.removed) continue
    const sign = part.added ? '+' : '-'
    for (const line of part.value.replace(/\n$/, '').split('\n')) out.push(`${sign} ${line}`)
  }
  return out.slice(0, limit * 2)
}

/** The words that differ between two visible texts. */
export function wordDiff(a, b, limit = 10) {
  const out = []
  for (const part of diffWordsWithSpace(a, b)) {
    if (part.added) out.push(`+«${part.value}»`)
    else if (part.removed) out.push(`-«${part.value}»`)
  }
  return out.slice(0, limit)
}

export function show(text) {
  return text
    .replace(/ /g, '⍽')
    .replace(/ /g, '⎵')
    .replace(/ /g, '·')
}
