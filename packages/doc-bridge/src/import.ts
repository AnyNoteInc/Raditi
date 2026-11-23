import { artifactHtmlParts, artifactSvgPart } from './html.ts'
import { markdownImportSections } from './section.ts'

// A whole file as a new artifact (docs/plan/88-artifacts.md, §7.5 `artifact_import`, «Открыть как
// артефакт» of a file of a chat; slice 88.12): `.md` — a document cut at its second-level headings,
// `.html` — a mockup of styles, scripts and parts of the body, `.svg` — a mockup of one picture,
// `.csv` — a table of text columns named by its first row. The blocks are written as the caller's
// writes, through the same checks as any other.

export interface ImportedBlock {
  kind: 'section' | 'html' | 'style' | 'script' | 'columns' | 'row'
  content: string
  heading?: string
}

export type ImportedArtifact =
  | {
      ok: true
      kind: 'document' | 'mockup' | 'table'
      title: string | null
      blocks: ImportedBlock[]
    }
  | { ok: false; problem: 'type' | 'empty' | 'too_large' }

/** The bounds the import keeps by itself; the rest are those of the artifact. */
export interface ImportBounds {
  blockBytes: number
  blocks: number
  tableRows: number
  columns: number
}

const extensionOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase()

/** The extensions an import reads. */
export const artifactImportExtensions = ['md', 'html', 'htm', 'svg', 'csv'] as const

const bytes = (text: string) => new TextEncoder().encode(text).byteLength

/** The rows of a CSV: by `;` when its first line has one, else by `,`; quotes as RFC 4180. */
export function csvRows(text: string): string[][] {
  const body = text.replace(/^\uFEFF/, '')
  const firstLine = body.slice(0, body.search(/\r?\n|$/))
  const separator = firstLine.includes(';') ? ';' : firstLine.includes('\t') ? '\t' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let at = 0; at < body.length; at += 1) {
    const char = body[at]!
    if (quoted) {
      if (char === '"' && body[at + 1] === '"') {
        cell += '"'
        at += 1
      } else if (char === '"') quoted = false
      else cell += char
    } else if (char === '"' && cell === '') quoted = true
    else if (char === separator) {
      row.push(cell)
      cell = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && body[at + 1] === '\n') at += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += char
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((each) => each.some((value) => value.trim() !== ''))
}

/** A cell of a table keeps the apostrophe a CSV put before «=», «+», «-», «@» only as text. */
const cellOf = (value: string) => value.replace(/^'(?=[=+\-@])/, '').slice(0, 4000)

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
    const blocks: ImportedBlock[] = [
      ...parts.style.map((content) => ({ kind: 'style' as const, content })),
      ...parts.html.map((content) => ({ kind: 'html' as const, content })),
      ...parts.script.map((content) => ({ kind: 'script' as const, content })),
    ]
    if (parts.html.length === 0) return { ok: false, problem: 'empty' }
    if (
      blocks.length > bounds.blocks ||
      blocks.some((block) => bytes(block.content) > bounds.blockBytes)
    )
      return { ok: false, problem: 'too_large' }
    const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(text)?.[1]?.trim() ?? null
    return { ok: true, kind: 'mockup', title, blocks }
  }
  if (extension === 'csv') {
    const rows = csvRows(text)
    const header = rows[0]
    if (!header) return { ok: false, problem: 'empty' }
    if (header.length > bounds.columns || rows.length - 1 > bounds.tableRows)
      return { ok: false, problem: 'too_large' }
    const columns = header.map((value, at) => ({
      key: `c${at + 1}`,
      name: value.trim().replace(/\s+/g, ' ').slice(0, 80) || `Столбец ${at + 1}`,
      type: 'text',
    }))
    const blocks: ImportedBlock[] = [{ kind: 'columns', content: JSON.stringify(columns) }]
    for (const row of rows.slice(1)) {
      const cells: Record<string, string> = {}
      row.slice(0, columns.length).forEach((value, at) => {
        if (value !== '') cells[`c${at + 1}`] = cellOf(value)
      })
      blocks.push({ kind: 'row', content: JSON.stringify(cells) })
    }
    if (blocks.some((block) => bytes(block.content) > bounds.blockBytes))
      return { ok: false, problem: 'too_large' }
    return { ok: true, kind: 'table', title: null, blocks }
  }
  return { ok: false, problem: 'type' }
}
