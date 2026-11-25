import { artifactHtmlParts, artifactSvgPart } from './html.ts'
import { markdownImportSections } from './section.ts'

// A whole file as a new artifact (docs/plan/88-artifacts.md, §7.5 `artifact_import`, «Открыть как
// артефакт» of a file of a chat; slice 88.12): `.md` — a document cut at its second-level headings,
// `.html` — a canvas of one screen of the styles, scripts and parts of the body, `.svg` — a canvas
// of one screen of one picture (docs/plan/93-artifacts-trim.md, АТ6). The blocks are written as the
// caller's writes, through the same checks as any other.

export interface ImportedBlock {
  kind: 'section' | 'frame' | 'html' | 'style' | 'script'
  content: string
  heading?: string
  /** Its own key: the screen of a canvas, which its parts name as their parent. */
  key?: string
  /** The frame it stands in; absent — the top. */
  parent?: string
  /** The properties of a frame: its name and the path of its page. */
  props?: Readonly<Record<string, string | number | boolean>>
}

/** The key of the one screen of an imported page. */
export const importedScreenKey = 'home'

export type ImportedArtifact =
  | {
      ok: true
      kind: 'document' | 'canvas'
      title: string | null
      blocks: ImportedBlock[]
    }
  | { ok: false; problem: 'type' | 'empty' | 'too_large' }

/** The bounds the import keeps by itself; the rest are those of the artifact. */
export interface ImportBounds {
  blockBytes: number
  blocks: number
}

const extensionOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase()

/** The extensions an import reads. */
export const artifactImportExtensions = ['md', 'html', 'htm', 'svg'] as const

const bytes = (text: string) => new TextEncoder().encode(text).byteLength

export function artifactImportOf(
  name: string,
  text: string,
  bounds: ImportBounds,
): ImportedArtifact {
  const extension = extensionOf(name)
  if (text.trim() === '') return { ok: false, problem: 'empty' }
  if (extension === 'md') {
    const { title, sections } = markdownImportSections(text)
    const blocks = sections.map((section) => ({
      kind: 'section' as const,
      heading: section.heading || 'Раздел',
      content: section.content,
    }))
    if (blocks.length === 0) return { ok: false, problem: 'empty' }
    if (
      blocks.length > bounds.blocks ||
      blocks.some((block) => bytes(block.content) > bounds.blockBytes)
    )
      return { ok: false, problem: 'too_large' }
    return { ok: true, kind: 'document', title, blocks }
  }
  if (extension === 'html' || extension === 'htm' || extension === 'svg') {
    const parts =
      extension === 'svg'
        ? { style: [], script: [], html: [artifactSvgPart(text)] }
        : artifactHtmlParts(text, bounds.blockBytes)
    const parent = importedScreenKey
    const blocks: ImportedBlock[] = [
      {
        kind: 'frame',
        key: parent,
        content: '',
        props: { name: 'Главная', path: '/', x: 0, y: 0 },
      },
      ...parts.style.map((content) => ({ kind: 'style' as const, parent, content })),
      ...parts.html.map((content) => ({ kind: 'html' as const, parent, content })),
      ...parts.script.map((content) => ({ kind: 'script' as const, parent, content })),
    ]
    if (parts.html.length === 0) return { ok: false, problem: 'empty' }
    if (
      blocks.length > bounds.blocks ||
      blocks.some((block) => bytes(block.content) > bounds.blockBytes)
    )
      return { ok: false, problem: 'too_large' }
    const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(text)?.[1]?.trim() ?? null
    return { ok: true, kind: 'canvas', title, blocks }
  }
  return { ok: false, problem: 'type' }
}
