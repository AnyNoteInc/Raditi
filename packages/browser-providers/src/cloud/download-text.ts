import { inflateRawSync } from 'node:zlib'

import { browserDownloadLimits, type BrowserDownloadKind } from '@repo/domain'

/**
 * How a download of the task's browser reads for the agent (the owner's decision of 09.11.2026):
 * a text file (CSV, TSV, JSON, XML, plain text) as its text; an Excel workbook (.xlsx) as the
 * rows of each sheet, tab-separated; anything else not at all. Pure: no I/O, the bytes are the
 * session's memory. Playwright names no type of a download, so its name and bytes decide.
 */
export function readDownload(input: { name: string; bytes: Uint8Array }): {
  kind: BrowserDownloadKind
  text: string | null
} {
  const name = input.name.toLowerCase()
  try {
    if (isZip(input.bytes)) {
      const text = workbookText(input.bytes)
      return text === null ? { kind: 'binary', text: null } : { kind: 'workbook', text: cap(text) }
    }
    if (TEXT_EXTENSIONS.test(name)) {
      const text = decodeText(input.bytes)
      return text === null ? { kind: 'binary', text: null } : { kind: 'text', text: cap(text) }
    }
  } catch {
    return { kind: 'failed', text: null }
  }
  return { kind: 'binary', text: null }
}

/** What a download is, by its name and first bytes alone — nothing is parsed yet. */
export function downloadKindOf(input: { name: string; bytes: Uint8Array }): BrowserDownloadKind {
  if (isZip(input.bytes)) return 'workbook'
  return TEXT_EXTENSIONS.test(input.name.toLowerCase()) ? 'text' : 'binary'
}

const TEXT_EXTENSIONS = /\.(csv|tsv|txt|json|xml|html?|md|log)$/
const ZIP_LOCAL = 0x04034b50

/** A workbook (.xlsx) is a zip; a zip that holds no workbook reads as nothing. */
const isZip = (bytes: Uint8Array) =>
  bytes.byteLength >= 4 && view(bytes).getUint32(0, true) === ZIP_LOCAL

const cap = (text: string) =>
  text.length <= browserDownloadLimits.textChars
    ? text
    : `${text.slice(0, browserDownloadLimits.textChars)}\n[…the rest of the file is cut]`

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** UTF-8 (with or without a BOM), UTF-16 with a BOM, else Windows-1251 — what Russian sites send. */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start))
  } catch {
    text = new TextDecoder('windows-1251').decode(bytes)
  }
  // A NUL in what claims to be text: it is not.
  return text.includes('\u0000') ? null : text
}

// ---------------------------------------------------------------------------------------------
// The workbook
// ---------------------------------------------------------------------------------------------

/** All a workbook may unpack into; a larger one is not read (a zip bomb is not a list). */
const WORKBOOK_MAX_BYTES = 32 * 1024 * 1024
/** Excel's own last column, XFD: a reference past it is not a workbook's. */
const MAX_COLUMNS = 16_384

/** The entries of a zip by name, read from its central directory. */
function zipEntries(bytes: Uint8Array): Map<string, () => Uint8Array> {
  const data = view(bytes)
  let end = -1
  for (let at = bytes.byteLength - 22; at >= Math.max(0, bytes.byteLength - 22 - 0xffff); at--)
    if (data.getUint32(at, true) === 0x06054b50) {
      end = at
      break
    }
  if (end < 0) throw new Error('zip')
  const count = data.getUint16(end + 10, true)
  let at = data.getUint32(end + 16, true)
  const entries = new Map<string, () => Uint8Array>()
  let unpacked = 0
  for (let index = 0; index < count; index++) {
    if (data.getUint32(at, true) !== 0x02014b50) throw new Error('zip')
    const method = data.getUint16(at + 10, true)
    const packed = data.getUint32(at + 20, true)
    const size = data.getUint32(at + 24, true)
    const nameLength = data.getUint16(at + 28, true)
    const extra = data.getUint16(at + 30, true)
    const comment = data.getUint16(at + 32, true)
    const local = data.getUint32(at + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extra + comment
    unpacked += size
    if (unpacked > WORKBOOK_MAX_BYTES) throw new Error('zip')
    entries.set(name, () => {
      if (data.getUint32(local, true) !== ZIP_LOCAL) throw new Error('zip')
      const start = local + 30 + data.getUint16(local + 26, true) + data.getUint16(local + 28, true)
      const body = bytes.subarray(start, start + packed)
      if (method === 0) return body
      if (method !== 8) throw new Error('zip')
      return inflateRawSync(body, { maxOutputLength: Math.max(size, 1) })
    })
  }
  return entries
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const point =
        code[1] === 'x' || code[1] === 'X'
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10)
      // `String.fromCodePoint` throws past U+10FFFF, and one such reference would turn the whole
      // workbook into `failed`: what is no character of Unicode (zero, a surrogate, past the
      // last plane) stays as it was written, as in the readers of the other HTML text here.
      return point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff)
        ? String.fromCodePoint(point)
        : whole
    }
    return ENTITIES[code] ?? whole
  })
}

/** Whether a character may follow the name of a tag: `<c` is a cell, `<col` and `<cfRule` are not. */
const endsTagName = (code: number) =>
  code === 0x3e || code === 0x2f || code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d

/**
 * The elements `<name …>…</name>` of a text, in order, with their attributes (as written, a space
 * first) and inner text — a self-closing one has none. An element whose end is missing ends the
 * scan: what follows it is no element's. No regular expression runs over the contents: a lazy
 * `[\s\S]*?` looks for its end to the end of the text for every start that has none, and a file of
 * a kilobyte holds a hundred thousand starts — minutes of the only thread of the worker, for every
 * session. Each search here begins where the last one ended, so the work is linear in the text.
 */
function* elementsOf(
  xml: string,
  name: string,
): Generator<{ attributes: string; inner: string }, undefined, undefined> {
  const open = `<${name}`
  const close = `</${name}>`
  let from = 0
  for (;;) {
    const start = xml.indexOf(open, from)
    if (start < 0) return
    const nameEnd = start + open.length
    if (!endsTagName(xml.charCodeAt(nameEnd))) {
      from = nameEnd
      continue
    }
    const tagEnd = xml.indexOf('>', nameEnd)
    if (tagEnd < 0) return
    const attributes = xml.slice(nameEnd, tagEnd)
    if (attributes.endsWith('/')) {
      yield { attributes: attributes.slice(0, -1), inner: '' }
      from = tagEnd + 1
      continue
    }
    const end = xml.indexOf(close, tagEnd + 1)
    if (end < 0) return
    yield { attributes, inner: xml.slice(tagEnd + 1, end) }
    from = end + close.length
  }
}

/** The attributes of each start tag `<name …>` of a text, whether it is closed or not; linear. */
function* startTagsOf(xml: string, name: string): Generator<string, undefined, undefined> {
  const open = `<${name}`
  let from = 0
  for (;;) {
    const start = xml.indexOf(open, from)
    if (start < 0) return
    const nameEnd = start + open.length
    if (!endsTagName(xml.charCodeAt(nameEnd))) {
      from = nameEnd
      continue
    }
    const tagEnd = xml.indexOf('>', nameEnd)
    if (tagEnd < 0) return
    yield xml.slice(nameEnd, tagEnd)
    from = tagEnd + 1
  }
}

/** The text of the `<t>` runs inside an element (a shared string, an inline string). */
const runs = (xml: string) => {
  let text = ''
  for (const run of elementsOf(xml, 't')) text += unescapeXml(run.inner)
  return text
}

const attribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null

/** `B7` → column 1 (from 0); past XFD — not a cell of a workbook. */
function columnOf(reference: string): number {
  const letters = /^[A-Z]{1,3}/.exec(reference)?.[0] ?? 'A'
  let column = 0
  for (const char of letters) column = column * 26 + char.charCodeAt(0) - 64
  if (column > MAX_COLUMNS || /^[A-Z]{4}/.test(reference)) throw new Error('workbook')
  return column - 1
}

/** A cell for a tab-separated line: no tab and no line break inside it. */
const flat = (value: string) => value.replace(/[\t\r\n]+/g, ' ').trim()

/** Each sheet as `## <name>` and its rows, tab-separated; null — not a workbook after all. */
export function workbookText(bytes: Uint8Array): string | null {
  const entries = zipEntries(bytes)
  const read = (name: string) => {
    const entry = entries.get(name)
    return entry ? new TextDecoder().decode(entry()) : null
  }
  const workbook = read('xl/workbook.xml')
  if (workbook === null) return null
  const relations = new Map<string, string>()
  for (const tag of startTagsOf(read('xl/_rels/workbook.xml.rels') ?? '', 'Relationship'))
    relations.set(attribute(tag, 'Id') ?? '', attribute(tag, 'Target') ?? '')
  const shared: string[] = []
  for (const item of elementsOf(read('xl/sharedStrings.xml') ?? '', 'si'))
    shared.push(runs(item.inner))
  const out: string[] = []
  // What the agent may read of one file at all: the rest of the rows is not even built.
  let length = 0
  const push = (line: string) => {
    out.push(line)
    length += line.length + 1
    return length < browserDownloadLimits.textChars
  }
  for (const sheet of startTagsOf(workbook, 'sheet')) {
    const title = unescapeXml(attribute(sheet, 'name') ?? 'Лист')
    const target = relations.get(attribute(sheet, 'r:id') ?? '') ?? ''
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
    const xml = read(path)
    if (xml === null) continue
    if (!push(`## ${title}`)) break
    let full = false
    for (const row of elementsOf(xml, 'row')) {
      const cells: string[] = []
      for (const cell of elementsOf(row.inner, 'c')) {
        const head = cell.attributes
        const body = cell.inner
        const reference = attribute(head, 'r')
        const at = reference ? columnOf(reference) : cells.length
        const type = attribute(head, 't')
        const value = elementsOf(body, 'v').next().value?.inner
        let text = ''
        if (type === 's') text = shared[Number(value)] ?? ''
        else if (type === 'inlineStr') text = runs(body)
        else if (value !== undefined) text = unescapeXml(value)
        const cellText = flat(text)
        // An empty cell that names its place adds nothing, and the row is not padded up to it: a
        // sheet of rows whose only cell is XFD1 would make every row 16 383 pushes, and rows with
        // nothing in them never reach `textChars` — the shared worker would stand still. (A cell
        // without a reference takes the next place, so it is kept.)
        if (cellText === '' && reference) continue
        while (cells.length < at) cells.push('')
        cells[at] = cellText
      }
      if (cells.some((cell) => cell !== '') && !push(cells.join('\t'))) {
        full = true
        break
      }
    }
    if (full) break
  }
  return out.join('\n')
}
