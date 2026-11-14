// The documents of a chat (docs/plan/67-agent-documents.md, Д1, Д2, Д6, Д7): a web page (`.html`)
// or a text document (`.md`) the agent left in its outbox, among the `feed.file` rows of the chat.
// A document is every row of one name; its versions are those rows in their order. Pure and
// without zod: the cabinet, the server of the pages and core read the same rules.

/** What a document is: a web page shown in a frame, or Markdown drawn by the cabinet. */
export type DocumentKind = 'page' | 'markdown'

/** The kind of a file of the chat by its name; null — a file that is downloaded only. */
export function documentKindOf(name: string): DocumentKind | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'page'
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'
  return null
}

/** A picture a text document may show, by its name: never SVG (it may carry scripts). */
export function documentImageNameOf(name: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(name)
}

export const documentViewLimits = Object.freeze({
  /** The text of a document the cabinet draws; a longer one is shown as text up to this. */
  markdownBytes: 2 * 1024 * 1024,
  /** Pictures a shared text document embeds, and their bytes in all. */
  sharedImages: 30,
  sharedImageBytes: 8 * 1024 * 1024,
})

/** A `feed.file` row as the readers of the feed give it. */
export interface ChatFileRow {
  id: string
  type: string
  fileId?: string
  name?: string
  sizeBytes?: number
}

export interface ChatDocumentVersion {
  /** The id of the row: versions and pictures are ordered by it. */
  rowId: string
  fileId: string
  sizeBytes: number
}

export interface ChatDocument {
  name: string
  kind: DocumentKind
  /** The name without its extension: the title until a text document says its own. */
  title: string
  /** Oldest first: version N is `versions[N - 1]`. */
  versions: ChatDocumentVersion[]
  /** The latest version came after the client's last message: «новое». */
  fresh: boolean
}

const fileRowOf = (row: ChatFileRow) =>
  row.type === 'feed.file' &&
  typeof row.fileId === 'string' &&
  typeof row.name === 'string' &&
  typeof row.sizeBytes === 'number'
    ? { rowId: row.id, fileId: row.fileId, name: row.name, sizeBytes: row.sizeBytes }
    : null

/** Ids of rows are bigints as strings of digits: a longer one is larger. */
export function compareFeedIds(first: string, second: string): number {
  if (first.length !== second.length) return first.length - second.length
  return first < second ? -1 : first > second ? 1 : 0
}

const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' })

/** Names in the order a reader expects: `01-…`, `02-…`, `10-…`. */
export const compareDocumentNames = (first: string, second: string): number =>
  collator.compare(first, second) || (first < second ? -1 : first > second ? 1 : 0)

/** The title of a document from its name: the name without its extension. */
export const documentTitleOf = (name: string): string => name.replace(/\.[^.]+$/, '') || name

/**
 * The documents of a chat from its rows, in the order of their names. `rows` may be any rows of
 * the feed: only `feed.file` rows of a document count; a `feed.request` row marks where the client
 * last wrote, and what came after it is fresh.
 */
export function chatDocumentsOf(rows: readonly ChatFileRow[]): ChatDocument[] {
  const sorted = [...rows].sort((a, b) => compareFeedIds(a.id, b.id))
  const lastRequest = sorted.findLast((row) => row.type === 'feed.request')?.id ?? null
  const byName = new Map<string, ChatDocument>()
  for (const row of sorted) {
    const file = fileRowOf(row)
    if (file === null) continue
    const kind = documentKindOf(file.name)
    if (kind === null) continue
    const known = byName.get(file.name)
    const version = { rowId: file.rowId, fileId: file.fileId, sizeBytes: file.sizeBytes }
    if (known) known.versions.push(version)
    else
      byName.set(file.name, {
        name: file.name,
        kind,
        title: documentTitleOf(file.name),
        versions: [version],
        fresh: false,
      })
  }
  const documents = [...byName.values()]
  for (const document of documents) {
    const latest = document.versions.at(-1)!
    document.fresh = lastRequest === null || compareFeedIds(latest.rowId, lastRequest) > 0
  }
  return documents.sort((a, b) => compareDocumentNames(a.name, b.name))
}

/** The version of a document that a row id names, with its number from 1; null — none. */
export function documentVersionOf(
  document: ChatDocument,
  fileId: string,
): { version: ChatDocumentVersion; number: number } | null {
  const index = document.versions.findIndex((version) => version.fileId === fileId)
  return index < 0 ? null : { version: document.versions[index]!, number: index + 1 }
}

/** The document a file id belongs to, among `documents`. */
export const documentOfFile = (
  documents: readonly ChatDocument[],
  fileId: string,
): ChatDocument | null =>
  documents.find((document) => document.versions.some((version) => version.fileId === fileId)) ??
  null

/**
 * The document to open when several came at once (Д4): the table of contents — `00-…`,
 * `README.md`, a name with «оглавление» — else the first by name.
 */
export function openingDocumentOf(names: readonly string[]): string | null {
  const sorted = [...names].sort(compareDocumentNames)
  return (
    sorted.find((name) => /^00(?:\D|$)/.test(name)) ??
    sorted.find((name) => /^readme\.(md|markdown)$/i.test(name)) ??
    sorted.find((name) => /оглавлен|содержани/i.test(name)) ??
    sorted[0] ??
    null
  )
}

/**
 * The picture of the chat a text document names (`![…](scheme.png)`), as it was when that version
 * of the document came: the latest row of this name not after the document's row, so an old
 * version never «floats» to a newer picture. null — no such picture of the chat.
 */
export function chatImageAt(
  rows: readonly ChatFileRow[],
  name: string,
  atRowId: string,
): { fileId: string; sizeBytes: number } | null {
  if (!documentImageNameOf(name)) return null
  let found: { rowId: string; fileId: string; sizeBytes: number } | null = null
  for (const row of rows) {
    const file = fileRowOf(row)
    if (file === null || file.name !== name) continue
    if (compareFeedIds(file.rowId, atRowId) > 0) continue
    if (found === null || compareFeedIds(file.rowId, found.rowId) > 0) found = file
  }
  return found === null ? null : { fileId: found.fileId, sizeBytes: found.sizeBytes }
}

// ---------------------------------------------------------------------------------------------
// Links of a text document (Д6)
// ---------------------------------------------------------------------------------------------

/** Where a link of a text document leads, once the rules have read it. */
export type DocumentLink =
  /** Out of the cabinet: an absolute http(s) or mailto address. */
  | { kind: 'external'; href: string }
  /** A heading of this document. */
  | { kind: 'anchor'; anchor: string }
  /** Another document of the chat by its name, maybe at a heading of it. */
  | { kind: 'document'; name: string; anchor: string | null }
  /** Anything else: the words stay, without a link. */
  | { kind: 'none' }

const decodePart = (part: string): string | null => {
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}

/**
 * How the rules read the address of a link (Д6): absolute `https?:` and `mailto:` lead out, `#x` to
 * a heading of this document, `name.md` or `name.html` (with `#x`, `./` allowed) to a document of
 * this chat. `javascript:`, `data:`, `//host`, folders and names of no document — no link.
 */
export function documentLinkOf(href: string, documents: ReadonlySet<string>): DocumentLink {
  const url = href.trim()
  if (/^(https?:\/\/|mailto:)/i.test(url)) return { kind: 'external', href: url }
  if (url.startsWith('#')) {
    const anchor = decodePart(url.slice(1))
    return anchor ? { kind: 'anchor', anchor } : { kind: 'none' }
  }
  const [path = '', ...rest] = url.replace(/^\.\//, '').split('#')
  if (path === '' || path.includes('/') || path.includes('\\') || path.includes(':'))
    return { kind: 'none' }
  const name = decodePart(path)
  if (name === null || !documents.has(name)) return { kind: 'none' }
  const anchor = rest.length > 0 ? decodePart(rest.join('#')) : null
  return { kind: 'document', name, anchor: anchor || null }
}

/**
 * The picture a text document names: a picture of the chat by its plain name, or a `data:` image
 * of the four kinds; null — not shown (an address of another site, a folder, SVG).
 */
export function documentImageOf(
  src: string,
): { kind: 'chat'; name: string } | { kind: 'data'; src: string } | null {
  const url = src.trim()
  if (/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(url))
    return { kind: 'data', src: url.replace(/\s+/g, '') }
  const path = url.replace(/^\.\//, '')
  if (path === '' || /[/\\:?#]/.test(path)) return null
  const name = decodePart(path)
  return name !== null && documentImageNameOf(name) ? { kind: 'chat', name } : null
}

/** The prefix of the ids of headings: a document never sets an id the cabinet itself uses. */
export const DOCUMENT_ANCHOR_PREFIX = 'doc-'

/**
 * The anchor of a heading, as GitHub makes it, Cyrillic kept: lower case, letters, digits, `-` and
 * `_`, spaces as `-`. `seen` counts anchors already given in the document: a repeated heading
 * gets `-1`, `-2`.
 */
export function documentSlug(text: string, seen: Map<string, number>): string {
  const base =
    text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .replace(/\s/g, '-') || 'section'
  const count = seen.get(base) ?? 0
  seen.set(base, count + 1)
  return count === 0 ? base : `${base}-${count}`
}

// ---------------------------------------------------------------------------------------------
// The format the client asked for (Д1)
// ---------------------------------------------------------------------------------------------

export interface RequestedFileFormats {
  word: boolean
  excel: boolean
  markdown: boolean
}

const WORD = String.raw`word|ворд\p{L}*|docx|\.doc`
const EXCEL = String.raw`excel|экс[еэ]л\p{L}*|ексел\p{L}*|xlsx|xls`
const MARKDOWN = String.raw`markdown|маркдаун\p{L}*|md|\.md`
const NOT_BEFORE = String.raw`(?<![\p{L}\p{N}])`
const NOT_AFTER = String.raw`(?![\p{L}\p{N}])`

const formatPattern = (words: string) => new RegExp(`${NOT_BEFORE}(?:${words})${NOT_AFTER}`, 'giu')

/** «не в ворде», «без ворда», «не нужен Excel» say what the client does not want. */
const NEGATED = /(?<![\p{L}\p{N}])(?:не|без|никакого|никаких)(?:\s+\p{L}+){0,2}\s*$/iu

function mentions(text: string, words: string): boolean {
  for (const match of text.matchAll(formatPattern(words))) {
    const before = text.slice(Math.max(0, match.index - 30), match.index)
    if (!NEGATED.test(before)) return true
  }
  return false
}

/**
 * Whether the client's words of this turn ask for Word, Excel or Markdown in so many words: the
 * planner then tells the agent so (Д1). Without such words none is asked for and the agent
 * chooses by its rules.
 */
export function requestedFileFormats(text: string): RequestedFileFormats {
  return {
    word: mentions(text, WORD),
    excel: mentions(text, EXCEL),
    markdown: mentions(text, MARKDOWN),
  }
}

// ---------------------------------------------------------------------------------------------
// The pictures of a text document (Д5)
// ---------------------------------------------------------------------------------------------

export type DocumentImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/**
 * The type of a picture by its bytes, never by its name: PNG, JPEG, WebP or GIF. SVG and anything
 * else — null: a browser told an SVG is an image may still run what it holds elsewhere.
 */
export function documentImageTypeOf(bytes: Uint8Array): DocumentImageType | null {
  const startsWith = (prefix: readonly number[], offset = 0) =>
    bytes.length >= offset + prefix.length && prefix.every((byte, i) => bytes[offset + i] === byte)
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8))
    return 'image/webp'
  if (
    startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  )
    return 'image/gif'
  return null
}

/**
 * The text of a document as the cabinet shows it (Д5): strict UTF-8, a BOM dropped; null — the
 * bytes are not UTF-8. A text above `documentViewLimits.markdownBytes` is cut there, at the
 * last whole character, and said to be cut.
 */
export function documentTextOf(bytes: Uint8Array): { text: string; truncated: boolean } | null {
  const limit = documentViewLimits.markdownBytes
  let body = bytes
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf)
    body = body.subarray(3)
  const truncated = body.length > limit
  if (truncated) {
    let end = limit
    // Back to the first byte of a character: never cut one in two.
    while (end > 0 && (body[end]! & 0xc0) === 0x80) end--
    body = body.subarray(0, end)
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), truncated }
  } catch {
    return null
  }
}
