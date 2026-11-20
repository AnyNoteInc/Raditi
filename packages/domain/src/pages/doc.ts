import { z } from 'zod'

import { DomainError } from '../errors.ts'
import { pageLimits } from './limits.ts'

/**
 * A document the agent writes section by section (docs/plan/69-pages.md, Ст7, Ст12, Ст21): a
 * title (the one first-level heading), sections of the second level by their ids, Markdown of
 * the third level and below inside each. One function assembles it — for «Скачать .md», for a
 * version and for the reading page — so the three never differ.
 */

const oneLine = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (text) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(text) && text.trim() === text,
      'one line of text',
    )

/** A title of a page or a document. */
export const pageTitleSchema = oneLine(pageLimits.titleChars)
/** A heading of a section. */
export const docHeadingSchema = oneLine(pageLimits.titleChars)
/** What a section is to say, in one line: the placeholder shows it while it is pending. */
export const docIntentSchema = oneLine(pageLimits.titleChars)

/** The id the agent gives a section: short, lower case, stable across the document's versions. */
export const docSectionKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'a section id is 1–40 lower-case letters, digits and hyphens')

/** The `>` marks a line opens with: a quote is a block of its own, its headings are headings. */
const QUOTE_MARKS = /^(?: {0,3}>[ \t]?)*/
/** A line that opens an item of a list: its text goes on at the width of the mark. */
const LIST_ITEM = /^( {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+)\S/
/** A line of `=` or `-` alone: under a line of text it makes the text a heading (setext). */
const UNDERLINE = /^( *)(?:=+|-+)[ \t]*$/
/** A line that closes a paragraph and is no text of its own: a heading, a rule, a quote alone. */
const NOT_TEXT = /^(?: {0,3}#{1,6}(?:[ \t]|$)| {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$|\s*$)/
/** The row under the head of a table: cells of hyphens between pipes. */
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$|^\s*\|\s*:?-+:?\s*\|\s*$/

/**
 * Where a line opens a heading of the first or the second level outside a code fence: those
 * levels belong to the title and the sections, a section's own headings start at the third. A
 * heading is `#` or `##` at the start of a line, or a line of text with a line of `=` or `-` right
 * under it (setext): doc-render draws that as `<h1>` or `<h2>` too. Only the text of a paragraph
 * takes an underline: under a rule, a heading, code by indent, a row of a table, a blank line, or
 * narrower than the item of a list its paragraph opens (lazy text), it is a rule or text.
 */
export function sectionMarkdownProblem(markdown: string): 'too_large' | 'heading_level' | null {
  if (new TextEncoder().encode(markdown).byteLength > pageLimits.sectionBytes) return 'too_large'
  let fence: string | null = null
  // The paragraph the line before is text of: the width of the item of a list it opens, 0 — none
  // opened; null — the line before is no text of a paragraph.
  let paragraph: number | null = null
  // How deep in quotes that paragraph opened: an underline of a lesser depth is lazy text or a rule.
  let quoted = 0
  let previous = ''
  let table = false
  for (const raw of markdown.split('\n')) {
    const marks = QUOTE_MARKS.exec(raw)![0]
    const depth = marks.split('>').length - 1
    const line = raw.slice(marks.length)
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (opening) {
      const mark = opening[1]!
      if (fence === null) fence = mark[0]!.repeat(mark.length)
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null
      paragraph = null
      continue
    }
    if (fence !== null) continue
    if (/^ {0,3}#{1,2}(?:[ \t]|$)/.test(line)) return 'heading_level'
    const underline = UNDERLINE.exec(line)
    if (underline && paragraph !== null && depth >= quoted) {
      const indent = underline[1]!.length
      if (paragraph > 0 ? indent >= paragraph : indent <= 3) return 'heading_level'
    }
    if (line.trim() === '') {
      table = false
      paragraph = null
    } else if (paragraph !== null && previous.includes('|') && TABLE_DELIMITER.test(line)) {
      table = true
      paragraph = null
    } else if (NOT_TEXT.test(line)) paragraph = null
    else if (paragraph === null && !table && !/^(?: {4}|\t)/.test(line)) {
      paragraph = LIST_ITEM.exec(line)?.[1]!.length ?? 0
      quoted = depth
    }
    previous = line
  }
  return null
}

export const docSectionMarkdownSchema = z.string().superRefine((markdown, context) => {
  const problem = sectionMarkdownProblem(markdown)
  if (problem === 'too_large')
    context.addIssue({
      code: 'custom',
      message: `a section is at most ${pageLimits.sectionBytes} bytes`,
    })
  if (problem === 'heading_level')
    context.addIssue({
      code: 'custom',
      message: 'headings inside a section start at the third level (###)',
    })
})

/**
 * How the client sees a document once it is finished, the agent's choice (docs/plan/74, Д1):
 * `page` — a page to read, drawn by `@repo/doc-render` and downloaded as `.html`; `text` — plain
 * text drawn by the cabinet and downloaded as `.md`. The sections are Markdown either way.
 */
export const docViews = ['page', 'text'] as const
export type DocView = (typeof docViews)[number]
export const docViewSchema = z.enum(docViews)

export const docSectionStates = ['pending', 'written'] as const
export type DocSectionState = (typeof docSectionStates)[number]

export interface DocSection {
  key: string
  heading: string | null
  markdown: string | null
  intent: string
  state: DocSectionState
}

export interface DocForAssembly {
  title: string
  sections: readonly DocSection[]
}

export const docPendingSections = (count: number): DomainError =>
  new DomainError('DOC_PENDING_SECTIONS', `The document has ${count} unwritten section(s)`, 409, {
    pending: count,
  })

/**
 * The Markdown of a document: `# title`, then each section as `## heading` and its text, one
 * blank line between, one newline at the end. Every section must be written.
 */
export function assembleDocMarkdown(doc: DocForAssembly): string {
  const pending = doc.sections.filter((section) => section.state !== 'written').length
  if (pending > 0) throw docPendingSections(pending)
  if (doc.sections.length > pageLimits.docSections)
    throw new DomainError(
      'DOC_LIMIT',
      `A document has at most ${pageLimits.docSections} sections`,
      409,
      {
        limit: 'docSections',
      },
    )
  const parts = [`# ${pageTitleSchema.parse(doc.title)}`]
  for (const section of doc.sections) {
    const heading = docHeadingSchema.parse(section.heading)
    const body = (section.markdown ?? '').replace(/\r\n?/g, '\n').trim()
    // The rows are checked when written; whoever wrote them, the assembly checks again.
    if (sectionMarkdownProblem(body) !== null)
      throw new DomainError(
        'DOC_SECTION_INVALID',
        'A section breaks the form of the document',
        409,
        {
          id: section.key,
        },
      )
    parts.push(body === '' ? `## ${heading}` : `## ${heading}\n\n${body}`)
  }
  const markdown = `${parts.join('\n\n')}\n`
  if (new TextEncoder().encode(markdown).byteLength > pageLimits.docBytes)
    throw new DomainError('DOC_LIMIT', `A document is at most ${pageLimits.docBytes} bytes`, 409, {
      limit: 'docBytes',
    })
  return markdown
}

/** «Разделы: N из M» of the card. */
export function docProgressOf(sections: readonly Pick<DocSection, 'state'>[]): {
  written: number
  total: number
} {
  return {
    written: sections.filter((section) => section.state === 'written').length,
    total: sections.length,
  }
}
