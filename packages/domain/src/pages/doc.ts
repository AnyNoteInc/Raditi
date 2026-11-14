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

/**
 * Where a line opens a heading of the first or the second level outside a code fence: those
 * levels belong to the title and the sections, a section's own headings start at the third.
 */
export function sectionMarkdownProblem(markdown: string): 'too_large' | 'heading_level' | null {
  if (new TextEncoder().encode(markdown).byteLength > pageLimits.sectionBytes) return 'too_large'
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (opening) {
      const mark = opening[1]!
      if (fence === null) fence = mark[0]!.repeat(mark.length)
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null
      continue
    }
    if (fence === null && /^ {0,3}#{1,2}(?:[ \t]|$)/.test(line)) return 'heading_level'
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
