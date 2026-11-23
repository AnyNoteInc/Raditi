import {
  documentToMarkdown,
  markdownToDocument,
  type EditorDocument,
  type EditorNode,
} from './bridge.ts'

// A section of a document (docs/plan/88-artifacts.md, §7.7): its heading lives beside it, so its
// own headings start from the third level — in the editor too (`heading: { levels: [3, 4, 5, 6] }`).

/** The lowest level of a heading inside a section: the first two are the document's and its sections'. */
export const SECTION_HEADING_MIN = 3

function lifted(node: EditorNode): EditorNode {
  const content = node.content?.map(lifted)
  if (node.type === 'heading') {
    const level = (node.attrs?.level as number | undefined) ?? 1
    if (level < SECTION_HEADING_MIN)
      return {
        ...node,
        attrs: { ...node.attrs, level: SECTION_HEADING_MIN },
        ...(content ? { content } : {}),
      }
  }
  return content ? { ...node, content } : node
}

/** The Markdown of a section into its editor: headings of the first two levels become the third. */
export function sectionToDocument(markdown: string): EditorDocument {
  return lifted(markdownToDocument(markdown)) as EditorDocument
}

/**
 * The canonical form of a section (§7.7): the bridge's form, headings from the third level. Every
 * write of a person is kept in it, and a section an agent wrote is brought to it before a person's
 * first save, so that the save changes only what the person changed.
 */
export function canonicalSection(markdown: string): string {
  return documentToMarkdown(sectionToDocument(markdown))
}

/**
 * A whole Markdown file as the sections of a document (docs/plan/88-artifacts.md, §7.5,
 * `artifact_import` and «Открыть как артефакт»): cut at its headings of the second level outside
 * code fences; what stands before the first of them is a section named by the first heading of the
 * first level, or «Начало». The title is that heading of the first level, if any. Each section is
 * kept in the canonical form.
 */
export function markdownImportSections(markdown: string): {
  title: string | null
  sections: { heading: string; content: string }[]
} {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  let fence: string | null = null
  let title: string | null = null
  const sections: { heading: string; lines: string[] }[] = [{ heading: '', lines: [] }]
  for (const line of lines) {
    const opens = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (opens) {
      if (fence === null) fence = opens[1]![0]!
      else if (opens[1]![0] === fence) fence = null
    }
    const heading = fence === null ? /^ {0,3}(#{1,2})[ \t]+(.+?)[ \t#]*$/.exec(line) : null
    if (heading && heading[1] === '#' && title === null && sections.length === 1) {
      title = heading[2]!.trim()
      continue
    }
    if (heading && heading[1] === '##') {
      sections.push({ heading: heading[2]!.trim(), lines: [] })
      continue
    }
    sections.at(-1)!.lines.push(line)
  }
  const first = sections[0]!
  if (first.lines.join('').trim() === '') sections.shift()
  else first.heading = title ?? 'Начало'
  return {
    title,
    sections: sections.map((section) => ({
      heading: section.heading.slice(0, 200),
      content: canonicalSection(section.lines.join('\n').trim()),
    })),
  }
}
