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
