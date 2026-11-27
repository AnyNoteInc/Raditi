import { ArtifactSectionMarkdown } from '@repo/doc-render/markdown'

import { documentTexts } from './artifact-texts'
import type { CabinetArtifact } from './use-artifact'

// The text of a document as it reads and as it downloads, without the editor of its sections: the
// history of versions and «Скачать» need no code of the editor (docs/plan/96-review-fixes.md, P33.1).

/** How the text of a document is dressed: the colours of the cabinet, in the light and the dark. */
export const documentSx = {
  fontSize: 16,
  lineHeight: 1.7,
  overflowWrap: 'anywhere',
  '& h3': { fontSize: 18, fontWeight: 600, mt: 2.5, mb: 1 },
  '& h4, & h5, & h6': { fontSize: 16, fontWeight: 600, mt: 2, mb: 1 },
  '& p, & ul, & ol, & pre, & blockquote, & table': { my: 1.25 },
  '& ul, & ol': { pl: 3 },
  '& a': { color: 'primary.main' },
  '& code': { px: 0.5, borderRadius: '6px', bgcolor: 'action.hover', fontSize: '0.9em' },
  '& pre': { p: 1.5, borderRadius: '12px', overflowX: 'auto', bgcolor: 'action.hover' },
  '& pre code': { p: 0, bgcolor: 'transparent' },
  '& blockquote': { mx: 0, pl: 2, borderLeft: 3, borderColor: 'divider', color: 'text.secondary' },
  '& table': { display: 'block', overflowX: 'auto', borderCollapse: 'collapse', fontSize: 14 },
  '& th, & td': { border: 1, borderColor: 'divider', px: 1.25, py: 0.75, textAlign: 'left' },
  '& img': { maxWidth: '100%', height: 'auto', borderRadius: '8px' },
} as const

export function SectionText({ text }: { text: string }) {
  return <ArtifactSectionMarkdown text={text} />
}

/**
 * The Markdown of a document as it reads now (docs/plan/93-artifacts-trim.md, АТ9: «Скачать →
 * Markdown»): `# title`, each written section as `## heading` and its text — the form of the
 * Markdown kept with a version; a section an agent still writes is left out.
 */
export function documentMarkdown(artifact: Pick<CabinetArtifact, 'title' | 'blocks'>): string {
  const parts = [`# ${artifact.title}`]
  for (const block of artifact.blocks) {
    if (block.kind !== 'section' || block.content === null) continue
    const heading = block.heading ?? documentTexts.untitled
    const body = block.content.replace(/\r\n?/g, '\n').trim()
    parts.push(body === '' ? `## ${heading}` : `## ${heading}\n\n${body}`)
  }
  return `${parts.join('\n\n')}\n`
}

/** A name of a file from the title of an artifact: what a file system takes, never empty. */
export function documentFileName(title: string): string {
  const name = Array.from(title, (char) => (char < ' ' ? ' ' : char))
    .join('')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
  return `${name || documentTexts.untitled}.md`
}

/** «Скачать → Markdown»: the file is made in the browser, nothing goes to the server. */
export function downloadDocumentMarkdown(artifact: Pick<CabinetArtifact, 'title' | 'blocks'>) {
  const blob = new Blob([documentMarkdown(artifact)], { type: 'text/markdown;charset=utf-8' })
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = documentFileName(artifact.title)
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(href), 0)
}
